#!/usr/bin/env node
/**
 * RequestAnalyzer — Phân tích yêu cầu trước khi route sang model thực thi
 *
 * Chạy đầu tiên trên MỌI prompt. Dùng local-classifier (Qwen 1.5B, miễn phí)
 * với fallback sang cheap (GPT-5.4 Mini) nếu LM Studio offline.
 *
 * Output: { goal, needs[], changes[], complexity, routing, searchTerms[], reasoning }
 *
 * Routing:
 *   local     → local-heavy (Qwen 7B, free, offline) — read-only, Q&A đơn giản
 *   fast      → fast (Gemini Flash) — 1 file rõ ràng, spec cụ thể
 *   smart     → smart (DeepSeek/Gemini) — multi-file, design, debug
 *   architect → architect (Opus) — system-wide, major refactor, complex debug
 *
 * Chi phí: $0 khi local online, ~$0.0001 khi fallback cloud
 */

const ANALYZE_SYSTEM = `You are a software engineering task intake agent.
Analyze the developer's coding request and produce a structured JSON plan.

Reply ONLY with valid JSON, no markdown:
{
  "goal": "one sentence: what the developer wants to achieve",
  "needs": ["file or symbol or concept to look up"],
  "changes": ["file or component likely to be modified"],
  "complexity": "trivial|simple|medium|complex",
  "routing": "local|fast|smart|architect",
  "searchTerms": ["specific identifier or filename for code search"],
  "reasoning": "one sentence why this routing"
}

Routing rules:
- local: read-only (explain, lookup, what-is), no code edits, simple Q&A about codebase
- fast: single clear file edit with explicit requirement, no design needed
- smart: multi-file changes, debugging, security, logic design, vague requirements
- architect: system-wide architecture, major refactor, complex root-cause analysis

Keep needs/changes/searchTerms concise: 2-5 items max each.`;

const DEFAULT_RESULT = {
  goal: '',
  needs: [],
  changes: [],
  complexity: 'medium',
  routing: 'smart',
  searchTerms: [],
  reasoning: 'fallback default'
};

const TIMEOUT_LOCAL_MS = 3000;
const TIMEOUT_CLOUD_MS = 5000;
const MAX_PROMPT_LEN = 500;
const MAX_CACHE_SIZE = 50;

class RequestAnalyzer {
  constructor({ litellmUrl, litellmKey, projectStack = '' } = {}) {
    this.litellmUrl = litellmUrl || process.env.LITELLM_URL || 'http://localhost:5002';
    this.litellmKey = litellmKey || process.env.LITELLM_KEY || 'sk-master-change-me';
    this.projectStack = projectStack;
    this._cache = new Map();
    this.stats = { calls: 0, cacheHits: 0, localHits: 0, cloudHits: 0, errors: 0, avgMs: 0 };
  }

  /**
   * Phân tích prompt → routing decision
   * @param {string} prompt
   * @param {{ recentFiles?: string[], conversationTurn?: number }} [ctx]
   * @returns {Promise<AnalysisResult>}
   */
  async analyze(prompt, ctx = {}) {
    if (!prompt || prompt.trim().length === 0) return { ...DEFAULT_RESULT };

    // Slash commands → không phân tích
    if (prompt.startsWith('/')) return { ...DEFAULT_RESULT, routing: 'fast', goal: 'slash command' };

    const cacheKey = this._cacheKey(prompt);
    if (this._cache.has(cacheKey)) {
      this.stats.cacheHits++;
      return this._cache.get(cacheKey);
    }

    const userMsg = this._buildUserMsg(prompt, ctx);
    const t0 = Date.now();
    let result = null;

    // Thử local-classifier trước (Qwen 1.5B, miễn phí, ~200ms)
    try {
      result = await this._call('local-classifier', userMsg, TIMEOUT_LOCAL_MS);
      if (result) this.stats.localHits++;
    } catch {
      // offline → fallback cloud
    }

    // Fallback: cheap cloud model
    if (!result) {
      try {
        result = await this._call('cheap', userMsg, TIMEOUT_CLOUD_MS);
        if (result) this.stats.cloudHits++;
      } catch {
        this.stats.errors++;
      }
    }

    const elapsed = Date.now() - t0;
    this.stats.calls++;
    this.stats.avgMs = Math.round((this.stats.avgMs * (this.stats.calls - 1) + elapsed) / this.stats.calls);

    const final = result ? this._validate(result) : { ...DEFAULT_RESULT };
    this._cacheSet(cacheKey, final);
    return final;
  }

  async _call(model, userMsg, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(`${this.litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.litellmKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: ANALYZE_SYSTEM },
            { role: 'user', content: userMsg }
          ],
          max_tokens: 200,
          temperature: 0.1
        }),
        signal: controller.signal
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message || 'LLM error');
      const text = data.choices?.[0]?.message?.content || '';
      return this._parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  _parse(text) {
    if (!text?.trim()) return null;
    try {
      const cleaned = text.trim()
        .replace(/^```json?\s*/i, '')
        .replace(/\s*```$/i, '');
      return JSON.parse(cleaned);
    } catch {
      return this._extractFallback(text);
    }
  }

  _extractFallback(text) {
    const lower = text.toLowerCase();
    let routing = 'smart';
    if (lower.includes('"local"')) routing = 'local';
    else if (lower.includes('"fast"')) routing = 'fast';
    else if (lower.includes('"architect"')) routing = 'architect';

    let complexity = 'medium';
    if (lower.includes('"trivial"')) complexity = 'trivial';
    else if (lower.includes('"simple"')) complexity = 'simple';
    else if (lower.includes('"complex"')) complexity = 'complex';

    return { ...DEFAULT_RESULT, routing, complexity, reasoning: 'text-extract fallback' };
  }

  _validate(raw) {
    const VALID_ROUTING = ['local', 'fast', 'smart', 'architect'];
    const VALID_COMPLEXITY = ['trivial', 'simple', 'medium', 'complex'];

    return {
      goal: String(raw.goal || '').slice(0, 150),
      needs: Array.isArray(raw.needs) ? raw.needs.slice(0, 5).map(String) : [],
      changes: Array.isArray(raw.changes) ? raw.changes.slice(0, 5).map(String) : [],
      complexity: VALID_COMPLEXITY.includes(raw.complexity) ? raw.complexity : 'medium',
      routing: VALID_ROUTING.includes(raw.routing) ? raw.routing : 'smart',
      searchTerms: Array.isArray(raw.searchTerms) ? raw.searchTerms.slice(0, 5).map(String) : [],
      reasoning: String(raw.reasoning || '').slice(0, 150)
    };
  }

  _buildUserMsg(prompt, ctx) {
    const parts = [];
    if (this.projectStack) parts.push(`Stack: ${this.projectStack}`);
    if (ctx.recentFiles?.length > 0) {
      parts.push(`Recent files: ${ctx.recentFiles.slice(0, 5).join(', ')}`);
    }
    const truncated = prompt.length > MAX_PROMPT_LEN
      ? prompt.slice(0, MAX_PROMPT_LEN) + '...'
      : prompt;
    parts.push(`Request: ${truncated}`);
    return parts.join('\n');
  }

  _cacheKey(prompt) {
    return prompt.slice(0, 200).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  _cacheSet(key, val) {
    this._cache.set(key, val);
    if (this._cache.size > MAX_CACHE_SIZE) {
      this._cache.delete(this._cache.keys().next().value);
    }
  }

  getStats() {
    return { ...this.stats, cacheSize: this._cache.size };
  }
}

/**
 * Map routing decision → model alias trong litellm_config.yaml
 */
function routingToModel(routing, currentModel) {
  const MAP = {
    local: 'local-heavy',
    fast: 'fast',
    smart: 'smart',
    architect: 'architect'
  };
  return MAP[routing] || currentModel;
}

/**
 * Format 1-line summary để hiển thị cho user
 */
function formatAnalysisSummary(analysis) {
  const icon = {
    local: '💻', fast: '⚡', smart: '🧠', architect: '🏗'
  }[analysis.routing] || '→';
  const terms = analysis.searchTerms.length > 0
    ? ` [${analysis.searchTerms.slice(0, 3).join(', ')}]`
    : '';
  return `${icon} ${analysis.routing}:${analysis.complexity}${terms}`;
}

module.exports = { RequestAnalyzer, routingToModel, formatAnalysisSummary };
