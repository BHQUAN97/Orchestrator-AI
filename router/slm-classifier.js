#!/usr/bin/env node
/**
 * SLM Classifier — Dung Small Language Model phan loai intent thay vi regex
 *
 * Van de: SmartRouter dung heuristic (file extension, keyword regex) de chon model.
 * File .tsx chua toan logic phuc tap → van bi route toi frontend model.
 *
 * Giai phap: Goi 1 model nho/re (GPT Mini hoac Gemini Flash) de classify:
 *   - intent: build, fix, review, architect, debug, docs, test, refactor
 *   - complexity: simple, medium, complex, expert
 *   - domain: frontend, backend, database, fullstack, devops, docs
 *   - reasoning: 1 dong giai thich
 *
 * Chi phi: ~200 tokens input + ~50 tokens output = ~$0.00005/call (GPT Mini)
 * Latency: ~200-500ms (acceptable — chi chay 1 lan dau pipeline)
 *
 * Cach dung:
 *   const classifier = new SLMClassifier({ litellmUrl, litellmKey });
 *   const result = await classifier.classify({ task, files, prompt });
 *   // { intent: 'build', complexity: 'complex', domain: 'fullstack', ... }
 */

// === Intent → Model tier mapping ===
// SLM classify intent + complexity → chon model tier phu hop
const INTENT_MODEL_MAP = {
  // Expert-level → architect (Opus)
  'architect:expert':   'architect',
  'architect:complex':  'architect',
  'debug:expert':       'architect',
  'refactor:expert':    'architect',

  // Complex tasks → smart (Sonnet)
  'architect:medium':   'smart',
  'debug:complex':      'smart',
  'fix:complex':        'smart',
  'review:complex':     'smart',
  'refactor:complex':   'smart',
  'build:expert':       'smart',

  // Standard tasks → default (DeepSeek)
  'build:complex':      'default',
  'build:medium':       'default',
  'fix:medium':         'default',
  'refactor:medium':    'default',
  'debug:medium':       'default',
  'test:complex':       'default',
  'test:medium':        'default',

  // Simple tasks → fast (Gemini)
  'review:medium':      'fast',
  'review:simple':      'fast',
  'build:simple':       'fast',
  'fix:simple':         'fast',
  'test:simple':        'fast',

  // Docs/simple → cheap (GPT Mini)
  'docs:simple':        'cheap',
  'docs:medium':        'cheap',
  'docs:complex':       'default',  // Docs phuc tap → default
  'refactor:simple':    'cheap',
};

// Domain-based adjustments — khi domain ro rang, boost model co strengths tuong ung
const DOMAIN_BOOST = {
  'frontend': { prefer: ['default', 'smart'], avoid: [] },
  'backend':  { prefer: ['default', 'smart'], avoid: [] },
  'database': { prefer: ['default', 'smart'], avoid: ['cheap', 'fast'] },
  'fullstack': { prefer: ['default', 'smart'], avoid: ['cheap'] },
  'devops':   { prefer: ['smart', 'architect'], avoid: ['cheap'] },
  'docs':     { prefer: ['cheap', 'fast'], avoid: [] },
};

// Classification prompt — toi uu cho it token nhat
const CLASSIFY_SYSTEM_PROMPT = `You are a task classifier for an AI coding system. Classify the user's coding task.

Reply ONLY with valid JSON, no markdown:
{"intent":"build|fix|review|architect|debug|docs|test|refactor","complexity":"simple|medium|complex|expert","domain":"frontend|backend|database|fullstack|devops|docs","reasoning":"one short sentence"}

Rules:
- intent: what the user wants to DO
- complexity: simple=1 file trivial change, medium=few files standard logic, complex=multi-file intricate logic, expert=system-wide architecture
- domain: primary code domain. "fullstack" if both FE+BE involved
- If files contain mixed domains (e.g. .tsx with heavy data logic), classify by the DOMINANT logic, not file extension`;

class SLMClassifier {
  constructor(options = {}) {
    this.litellmUrl = options.litellmUrl || process.env.LITELLM_URL || 'http://localhost:5002';
    this.litellmKey = options.litellmKey || process.env.LITELLM_KEY || 'sk-master-change-me';
    // Model de classify — dung re nhat co the
    this.classifyModel = options.classifyModel || 'cheap';  // GPT-5.4 Mini
    this.fallbackModel = options.fallbackModel || 'fast';   // Gemini Flash neu Mini fail
    this.timeout = options.timeout || 5000;  // 5s timeout — khong cho lau
    // Cache classification results (same prompt → same result)
    this.cache = new Map();
    this.maxCacheSize = 100;
    // Stats
    this.stats = { calls: 0, cache_hits: 0, fallbacks: 0, errors: 0, avg_latency_ms: 0 };
  }

  /**
   * Classify task intent bang SLM
   * @param {Object} params - { task, files, prompt, project }
   * @returns {Object} { intent, complexity, domain, reasoning, model_tier, confidence }
   */
  async classify({ task = '', files = [], prompt = '', project = '' }) {
    // Build cache key tu input
    const cacheKey = this._cacheKey(task, files, prompt);
    if (this.cache.has(cacheKey)) {
      this.stats.cache_hits++;
      return this.cache.get(cacheKey);
    }

    // Build user message — giu ngan de tiet kiem token
    const userMessage = this._buildUserMessage(task, files, prompt, project);

    const startTime = Date.now();
    let classification = null;

    try {
      // Goi SLM de classify
      const response = await this._callSLM(this.classifyModel, userMessage);
      classification = this._parseClassification(response);
      this.stats.calls++;
    } catch (err) {
      // Fallback: thu model khac
      try {
        const response = await this._callSLM(this.fallbackModel, userMessage);
        classification = this._parseClassification(response);
        this.stats.fallbacks++;
      } catch {
        // Ca 2 model fail → return null, de SmartRouter dung heuristic
        this.stats.errors++;
        return null;
      }
    }

    if (!classification) return null;

    // Map classification → model tier
    const modelTier = this._mapToModelTier(classification);
    const elapsed = Date.now() - startTime;

    // Update latency stats
    this.stats.avg_latency_ms = Math.round(
      (this.stats.avg_latency_ms * (this.stats.calls - 1) + elapsed) / this.stats.calls
    );

    const result = {
      ...classification,
      model_tier: modelTier,
      confidence: this._estimateConfidence(classification),
      latency_ms: elapsed
    };

    // Cache result
    this._cacheResult(cacheKey, result);

    return result;
  }

  /**
   * Build user message cho SLM — giu duoi 200 tokens
   */
  _buildUserMessage(task, files, prompt, project) {
    const parts = [];

    if (task) parts.push(`Task type: ${task}`);
    if (project) parts.push(`Project: ${project}`);

    // Chi lay 10 files dau, cat ten ngan
    if (files.length > 0) {
      const fileList = files.slice(0, 10).map(f => {
        // Chi lay filename + parent dir
        const parts = f.replace(/\\/g, '/').split('/');
        return parts.slice(-2).join('/');
      }).join(', ');
      parts.push(`Files: ${fileList}`);
      if (files.length > 10) parts.push(`(+${files.length - 10} more files)`);
    }

    // Prompt: cat con 500 chars
    if (prompt) {
      const truncated = prompt.length > 500 ? prompt.slice(0, 500) + '...' : prompt;
      parts.push(`User request: ${truncated}`);
    }

    return parts.join('\n');
  }

  /**
   * Goi LLM de classify — timeout ngan, max_tokens thap
   */
  async _callSLM(model, userMessage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.litellmKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 100,     // Classification chi can ~50 tokens
          temperature: 0.1     // Deterministic — consistent classification
        }),
        signal: controller.signal
      });

      // Check HTTP status truoc khi parse JSON — tranh crash tren 500/502/503
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('Invalid JSON response from LLM');
      }

      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }

      return data.choices?.[0]?.message?.content || '';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse SLM response thanh structured classification
   */
  _parseClassification(response) {
    if (!response || !response.trim()) return null;

    try {
      // Strip markdown code blocks neu co
      let cleaned = response.trim();
      cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

      const parsed = JSON.parse(cleaned);

      // Validate required fields
      const validIntents = ['build', 'fix', 'review', 'architect', 'debug', 'docs', 'test', 'refactor'];
      const validComplexity = ['simple', 'medium', 'complex', 'expert'];
      const validDomains = ['frontend', 'backend', 'database', 'fullstack', 'devops', 'docs'];

      const intent = validIntents.includes(parsed.intent) ? parsed.intent : 'build';
      const complexity = validComplexity.includes(parsed.complexity) ? parsed.complexity : 'medium';
      const domain = validDomains.includes(parsed.domain) ? parsed.domain : 'fullstack';

      return {
        intent,
        complexity,
        domain,
        reasoning: String(parsed.reasoning || '').slice(0, 200)
      };
    } catch {
      // JSON parse fail → try regex extraction
      return this._extractFromText(response);
    }
  }

  /**
   * Fallback parser: extract fields tu text khi JSON parse fail
   */
  _extractFromText(text) {
    const lower = text.toLowerCase();

    let intent = 'build';
    if (lower.includes('fix') || lower.includes('bug')) intent = 'fix';
    else if (lower.includes('review') || lower.includes('check')) intent = 'review';
    else if (lower.includes('architect') || lower.includes('design')) intent = 'architect';
    else if (lower.includes('debug') || lower.includes('trace')) intent = 'debug';
    else if (lower.includes('doc') || lower.includes('comment')) intent = 'docs';
    else if (lower.includes('test')) intent = 'test';
    else if (lower.includes('refactor') || lower.includes('clean')) intent = 'refactor';

    let complexity = 'medium';
    if (lower.includes('simple') || lower.includes('trivial')) complexity = 'simple';
    else if (lower.includes('complex') || lower.includes('intricate')) complexity = 'complex';
    else if (lower.includes('expert') || lower.includes('system-wide')) complexity = 'expert';

    let domain = 'fullstack';
    if (lower.includes('frontend') || lower.includes('ui') || lower.includes('react')) domain = 'frontend';
    else if (lower.includes('backend') || lower.includes('api') || lower.includes('server')) domain = 'backend';
    else if (lower.includes('database') || lower.includes('sql') || lower.includes('migration')) domain = 'database';
    else if (lower.includes('docs') || lower.includes('documentation')) domain = 'docs';
    else if (lower.includes('devops') || lower.includes('docker') || lower.includes('ci')) domain = 'devops';

    return { intent, complexity, domain, reasoning: 'Extracted from text (JSON parse failed)' };
  }

  /**
   * Map classification → model tier
   * Intent:Complexity → model tier, voi domain boost
   */
  _mapToModelTier(classification) {
    const { intent, complexity, domain } = classification;
    const key = `${intent}:${complexity}`;

    // Lookup exact match
    let tier = INTENT_MODEL_MAP[key];

    // Fallback: lookup by intent only (default to medium complexity mapping)
    if (!tier) {
      tier = INTENT_MODEL_MAP[`${intent}:medium`] || 'default';
    }

    // Domain boost: neu domain suggest model manh hon, upgrade
    const boost = DOMAIN_BOOST[domain];
    if (boost) {
      // Neu tier hien tai bi "avoid" → upgrade len preferred tier
      if (boost.avoid.includes(tier) && boost.prefer.length > 0) {
        tier = boost.prefer[0];
      }
    }

    return tier;
  }

  /**
   * Uoc luong confidence dua tren classification coherence
   */
  _estimateConfidence(classification) {
    let score = 0.7; // Baseline

    // Co reasoning → +0.1
    if (classification.reasoning && classification.reasoning.length > 10) {
      score += 0.1;
    }

    // Intent + domain coherent → +0.1
    const coherent = {
      'frontend': ['build', 'fix', 'review', 'refactor', 'test'],
      'backend': ['build', 'fix', 'review', 'debug', 'refactor', 'test'],
      'database': ['build', 'fix', 'debug'],
      'docs': ['docs'],
    };
    if (coherent[classification.domain]?.includes(classification.intent)) {
      score += 0.1;
    }

    // Expert complexity + non-architect intent → lower confidence
    if (classification.complexity === 'expert' && classification.intent !== 'architect') {
      score -= 0.1;
    }

    return Math.round(Math.min(1.0, Math.max(0.1, score)) * 100) / 100;
  }

  /**
   * Cache key tu input — hash de giu nho
   */
  _cacheKey(task, files, prompt) {
    // Dung first 200 chars cua prompt + task + file count
    const key = `${task}|${files.length}|${files.slice(0, 5).join(',')}|${prompt.slice(0, 200)}`;
    return key;
  }

  _cacheResult(key, result) {
    this.cache.set(key, result);
    // Evict oldest khi qua max
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  /**
   * Lay thong ke
   */
  getStats() {
    return { ...this.stats, cache_size: this.cache.size };
  }

  /**
   * Xoa cache
   */
  clearCache() {
    this.cache.clear();
  }
}

module.exports = { SLMClassifier, INTENT_MODEL_MAP, DOMAIN_BOOST };
