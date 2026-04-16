#!/usr/bin/env node
/**
 * Smart Model Router — Tu dong chon model phu hop theo task
 *
 * Phan tich: file type, task type, keywords, project stack
 * → Chon model toi uu cho tung cong viec
 *
 * Cach dung:
 *   const router = new SmartRouter(config);
 *   const model = router.route({ task, files, prompt, project });
 */

// === Model Profiles ===
// Moi model co strengths rieng — router match task voi strengths

const { SLMClassifier } = require('./slm-classifier');

const MODEL_PROFILES = {
  // === v2 lineup (2026-04-16) ===

  'opus-4.6': {
    litellm_name: 'architect',
    strengths: ['architecture', 'spec', 'planning', 'debug_complex', 'refactor_large', 'security', 'multi_file', 'reasoning', 'frontend', 'backend', 'database', 'system_design', 'trade_off', 'mentoring'],
    weaknesses: [],
    max_context: 1000000,  // 1M tokens
    cost_per_1m_input: 15.00,
    speed: 'medium',
    hallucination: 'very-low',
    description: 'Opus 4.6 — SA tier, kien truc he thong, task cuc kho, huong dan smart tier'
  },

  'gemini-3-flash': {
    litellm_name: 'fast',
    strengths: ['context_analysis', 'multimodal', 'review', 'summarize', 'explain', 'translate', 'search'],
    weaknesses: ['complex_logic'],
    max_context: 1000000,  // 1M tokens
    cost_per_1m_input: 0.15,
    speed: 'fast',
    hallucination: 'medium',
    description: 'Gemini 3 Flash — context lon, scan nhanh, multimodal'
  },

  'deepseek-v3.2': {
    litellm_name: 'default',
    strengths: ['backend', 'frontend', 'nestjs', 'express', 'react', 'nextjs', 'api', 'database', 'sql', 'typeorm', 'drizzle', 'auth', 'middleware', 'migration', 'algorithm', 'logic', 'component'],
    weaknesses: ['multimodal'],
    max_context: 128000,
    cost_per_1m_input: 0.30,
    speed: 'medium',
    hallucination: 'low-medium',
    description: 'DeepSeek V3.2 — full-stack code gen, gia re, it drift'
  },

  'sonnet-4.6': {
    litellm_name: 'smart',
    strengths: ['architecture', 'spec', 'planning', 'debug_complex', 'refactor_large', 'security', 'multi_file', 'reasoning', 'frontend', 'backend'],
    weaknesses: [],
    max_context: 200000,
    cost_per_1m_input: 3.00,
    speed: 'medium',
    hallucination: 'very-low',
    description: 'Sonnet 4.6 — it ao giac nhat, reasoning sau, code manh'
  },

  'gpt-5.4-mini': {
    litellm_name: 'cheap',
    strengths: ['docs', 'comment', 'simple_fix', 'format', 'rename', 'summarize', 'explain'],
    weaknesses: ['complex_logic', 'architecture'],
    max_context: 128000,
    cost_per_1m_input: 0.20,
    speed: 'fast',
    hallucination: 'medium',
    description: 'GPT-5.4 Mini — re, nhanh, it bua hon model re khac'
  },

  // Legacy — giu lai de fallback
  'kimi-k2.5': {
    litellm_name: 'kimi',
    strengths: ['frontend', 'react', 'nextjs', 'vue', 'css', 'tailwind', 'ui', 'component', 'responsive', 'animation'],
    weaknesses: ['database', 'devops'],
    max_context: 128000,
    cost_per_1m_input: 1.00,
    speed: 'medium',
    hallucination: 'medium-high',
    description: 'Kimi K2.5 — legacy fallback, hay bua API'
  },

  'local': {
    litellm_name: 'local',
    strengths: ['docs', 'comment', 'simple_fix', 'format', 'rename'],
    weaknesses: ['complex_logic', 'architecture'],
    max_context: 32000,
    cost_per_1m_input: 0,  // Free — chay local
    speed: 'slow',
    hallucination: 'high',
    description: 'Local model (LM Studio) — free, offline'
  }
};

// === File Type → Domain Mapping ===
const FILE_DOMAIN = {
  // Frontend
  '.tsx': 'frontend', '.jsx': 'frontend', '.vue': 'frontend',
  '.css': 'frontend', '.scss': 'frontend', '.less': 'frontend',
  '.html': 'frontend',

  // Backend
  '.service.ts': 'backend', '.controller.ts': 'backend',
  '.module.ts': 'backend', '.guard.ts': 'backend',
  '.middleware.ts': 'backend', '.interceptor.ts': 'backend',
  '.pipe.ts': 'backend', '.filter.ts': 'backend',
  '.gateway.ts': 'backend',

  // Database
  '.entity.ts': 'database', '.migration.ts': 'database',
  '.schema.ts': 'database', '.seed.ts': 'database',
  '.sql': 'database',

  // Config
  '.config.ts': 'config', '.config.js': 'config',
  '.env': 'config', '.yaml': 'config', '.yml': 'config',

  // Test
  '.spec.ts': 'test', '.test.ts': 'test',
  '.spec.js': 'test', '.test.js': 'test',
  '.e2e-spec.ts': 'test',

  // Docs
  '.md': 'docs',

  // General TS/JS (detect by path later)
  '.ts': 'general', '.js': 'general',
};

// === Task Type → Required Strengths ===
const TASK_STRENGTHS = {
  // Pre-execution: scan + plan
  'scan':         ['context_analysis', 'summarize', 'search', 'explain'],
  'plan':         ['planning', 'architecture', 'context_analysis'],

  // Architect-level commands
  'architect':    ['system_design', 'architecture', 'trade_off', 'reasoning', 'planning', 'mentoring'],
  'design':       ['system_design', 'architecture', 'trade_off', 'reasoning'],
  'escalation':   ['debug_complex', 'reasoning', 'multi_file', 'system_design', 'mentoring'],

  // Agent commands
  'spec':         ['architecture', 'spec', 'planning', 'reasoning'],
  'build_fe':     ['frontend', 'react', 'nextjs', 'vue', 'component'],
  'build_be':     ['backend', 'nestjs', 'api', 'database'],
  'build':        ['frontend', 'backend'],  // generic — will refine by files
  'task':         [],  // detect by files
  'fix':          ['debug_complex', 'logic'],
  'debug':        ['debug_complex', 'reasoning', 'multi_file'],
  'review':       ['review', 'context_analysis'],
  'check':        ['review', 'security', 'context_analysis'],
  'security':     ['security', 'review'],
  'cleanup':      ['refactor_large', 'rename'],
  'docs':         ['docs', 'comment', 'summarize'],
  'wire_memory':  ['summarize', 'docs'],
  'perf':         ['backend', 'algorithm', 'logic'],
  'ui_test':      ['multimodal', 'frontend'],
  'plan':         ['planning', 'architecture'],

  // Generic
  'analyze':      ['context_analysis', 'reasoning'],
  'explain':      ['explain', 'summarize'],
  'translate':    ['translate'],
};

// === Path-based Domain Detection ===
function detectDomainFromPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();

  // Check specific suffixes first
  for (const [suffix, domain] of Object.entries(FILE_DOMAIN)) {
    if (suffix.includes('.') && suffix.length > 4 && normalized.endsWith(suffix)) {
      return domain;
    }
  }

  // Check by directory
  if (normalized.includes('/frontend/') || normalized.includes('/app/') ||
      normalized.includes('/pages/') || normalized.includes('/components/') ||
      normalized.includes('/layouts/') || normalized.includes('/hooks/') ||
      normalized.includes('/styles/')) {
    return 'frontend';
  }

  if (normalized.includes('/backend/') || normalized.includes('/server/') ||
      normalized.includes('/api/') || normalized.includes('/modules/') ||
      normalized.includes('/services/') || normalized.includes('/controllers/')) {
    return 'backend';
  }

  if (normalized.includes('/entities/') || normalized.includes('/migrations/') ||
      normalized.includes('/schemas/') || normalized.includes('/seeds/')) {
    return 'database';
  }

  // Check by extension
  const ext = '.' + normalized.split('.').pop();
  return FILE_DOMAIN[ext] || 'general';
}

// === Keyword Analysis ===
function detectKeywordsFromPrompt(prompt) {
  const lower = prompt.toLowerCase();
  const keywords = new Set();

  // Frontend keywords
  if (/\b(component|jsx|tsx|react|vue|css|style|layout|responsive|animation|ui|ux|tailwind|shadcn|button|form|modal|page)\b/.test(lower)) {
    keywords.add('frontend');
  }

  // Backend keywords
  if (/\b(api|endpoint|controller|service|guard|middleware|nestjs|express|route|auth|jwt|token|session|websocket|socket)\b/.test(lower)) {
    keywords.add('backend');
  }

  // Database keywords
  if (/\b(database|db|sql|query|migration|entity|table|column|index|relation|typeorm|drizzle|mysql|postgres|redis)\b/.test(lower)) {
    keywords.add('database');
  }

  // Architecture keywords
  if (/\b(architect|design|spec|plan|structure|refactor|pattern|module|system)\b/.test(lower)) {
    keywords.add('architecture');
  }

  // Review/Analysis
  if (/\b(review|check|audit|scan|analyze|explain|understand)\b/.test(lower)) {
    keywords.add('review');
  }

  // Docs
  if (/\b(doc|readme|comment|jsdoc|explain|documentation)\b/.test(lower)) {
    keywords.add('docs');
  }

  return Array.from(keywords);
}

// === Smart Router Class ===
class SmartRouter {
  constructor(config = {}) {
    this.models = { ...MODEL_PROFILES };
    this.availableModels = config.availableModels || Object.keys(MODEL_PROFILES);
    this.costOptimize = config.costOptimize !== false; // mac dinh toi uu cost
    this.preferLocal = config.preferLocal || false;
    this.history = []; // Luu lich su routing
  }

  /**
   * Route task → model toi uu
   *
   * @param {Object} params
   * @param {string} params.task - Task type (build, fix, review...)
   * @param {string[]} params.files - Files lien quan
   * @param {string} params.prompt - User prompt
   * @param {string} params.project - Project name
   * @param {number} params.contextSize - Kich thuoc context (tokens)
   * @returns {Object} { model, litellm_name, reason, score, alternatives }
   */
  route({ task = '', files = [], prompt = '', project = '', contextSize = 0 }) {
    const scores = {};

    // 1. Score theo task type
    const taskStrengths = TASK_STRENGTHS[task] || [];
    for (const [modelName, profile] of Object.entries(this.models)) {
      if (!this.availableModels.includes(modelName)) continue;

      let score = 0;
      const reasons = [];

      // Task match
      const taskMatch = taskStrengths.filter(s => profile.strengths.includes(s)).length;
      if (taskStrengths.length > 0) {
        score += (taskMatch / taskStrengths.length) * 40;
        if (taskMatch > 0) reasons.push(`task match: ${taskMatch}/${taskStrengths.length}`);
      }

      scores[modelName] = { score, reasons };
    }

    // 2. Score theo file domain
    const domains = new Set();
    for (const file of files) {
      domains.add(detectDomainFromPath(file));
    }

    for (const [modelName, profile] of Object.entries(this.models)) {
      if (!scores[modelName]) continue;

      if (domains.has('frontend') && profile.strengths.some(s =>
        ['frontend', 'react', 'nextjs', 'vue', 'css', 'component'].includes(s))) {
        scores[modelName].score += 25;
        scores[modelName].reasons.push('FE files detected');
      }

      if (domains.has('backend') && profile.strengths.some(s =>
        ['backend', 'nestjs', 'api', 'database'].includes(s))) {
        scores[modelName].score += 25;
        scores[modelName].reasons.push('BE files detected');
      }

      if (domains.has('database') && profile.strengths.some(s =>
        ['database', 'sql', 'typeorm'].includes(s))) {
        scores[modelName].score += 20;
        scores[modelName].reasons.push('DB files detected');
      }
    }

    // 3. Score theo prompt keywords
    const keywords = detectKeywordsFromPrompt(prompt);
    for (const [modelName, profile] of Object.entries(this.models)) {
      if (!scores[modelName]) continue;

      const keywordMatch = keywords.filter(k => profile.strengths.includes(k)).length;
      if (keywords.length > 0) {
        scores[modelName].score += (keywordMatch / keywords.length) * 20;
        if (keywordMatch > 0) scores[modelName].reasons.push(`keywords: ${keywords.join(', ')}`);
      }
    }

    // 4. Context size constraint
    for (const [modelName, profile] of Object.entries(this.models)) {
      if (!scores[modelName]) continue;

      if (contextSize > 0 && contextSize > profile.max_context * 0.8) {
        scores[modelName].score -= 50; // Penalize nếu context quá lớn
        scores[modelName].reasons.push('context too large');
      }

      // Bonus cho context lớn nếu model hỗ trợ
      if (contextSize > 100000 && profile.max_context >= 1000000) {
        scores[modelName].score += 15;
        scores[modelName].reasons.push('large context support');
      }
    }

    // 5. Cost optimization
    if (this.costOptimize) {
      for (const [modelName, profile] of Object.entries(this.models)) {
        if (!scores[modelName]) continue;

        // Bonus cho model re hon (normalize: max 10 points)
        const costBonus = Math.max(0, 10 - profile.cost_per_1m_input * 3);
        scores[modelName].score += costBonus;
      }
    }

    // 6. Local preference
    if (this.preferLocal && scores['local']) {
      scores['local'].score += 15;
      scores['local'].reasons.push('prefer local');
    }

    // Sort va chon
    const sorted = Object.entries(scores)
      .sort((a, b) => b[1].score - a[1].score);

    const winner = sorted[0];
    const alternatives = sorted.slice(1, 3);

    const result = {
      model: winner[0],
      litellm_name: this.models[winner[0]].litellm_name,
      score: Math.round(winner[1].score),
      reasons: winner[1].reasons,
      description: this.models[winner[0]].description,
      cost: this.models[winner[0]].cost_per_1m_input,
      alternatives: alternatives.map(([name, data]) => ({
        model: name,
        litellm_name: this.models[name].litellm_name,
        score: Math.round(data.score),
        reasons: data.reasons
      })),
      // Input analysis
      analysis: {
        task,
        domains: Array.from(domains),
        keywords,
        files_count: files.length,
        context_size: contextSize
      }
    };

    // Log
    this.history.push({
      timestamp: new Date().toISOString(),
      ...result
    });

    return result;
  }

  /**
   * SLM-powered routing — dung AI phan loai intent thay vi heuristic
   * Goi model nho/re de classify → chon model phu hop
   * Fallback ve heuristic route() neu SLM fail
   *
   * @param {Object} params - { task, files, prompt, project, contextSize }
   * @returns {Object} - Same format as route() + slm_classification
   */
  async slmRoute({ task = '', files = [], prompt = '', project = '', contextSize = 0 }) {
    // Lazy init SLM classifier
    if (!this.slmClassifier) {
      this.slmClassifier = new SLMClassifier({
        litellmUrl: this.litellmUrl || process.env.LITELLM_URL,
        litellmKey: this.litellmKey || process.env.LITELLM_KEY
      });
    }

    // Goi SLM classify — wrap trong try-catch de dam bao fallback
    let classification;
    try {
      classification = await this.slmClassifier.classify({ task, files, prompt, project });
    } catch {
      classification = null;
    }

    // SLM fail hoac thieu fields → fallback ve heuristic
    if (!classification || !classification.model_tier || !classification.intent) {
      const result = this.route({ task, files, prompt, project, contextSize });
      result.routing_method = 'heuristic_fallback';
      if (classification) result.slm_classification = classification;
      return result;
    }

    // SLM thanh cong → dung classification de chon model
    const modelTier = classification.model_tier;

    // Tim model trong profiles theo litellm_name (tier)
    let selectedModel = null;
    for (const [modelName, profile] of Object.entries(this.models)) {
      if (!this.availableModels.includes(modelName)) continue;
      if (profile.litellm_name === modelTier) {
        selectedModel = modelName;
        break;
      }
    }

    // Neu khong tim thay model cho tier → fallback
    if (!selectedModel) {
      const result = this.route({ task, files, prompt, project, contextSize });
      result.routing_method = 'heuristic_fallback';
      result.slm_classification = classification;
      return result;
    }

    const profile = this.models[selectedModel];

    // Context size check — neu model khong du context, escalate
    if (contextSize > 0 && contextSize > profile.max_context * 0.8) {
      // Tim model co context lon hon
      const largerModel = Object.entries(this.models)
        .filter(([name]) => this.availableModels.includes(name))
        .filter(([, p]) => p.max_context >= contextSize * 1.2)
        .sort((a, b) => a[1].cost_per_1m_input - b[1].cost_per_1m_input)[0];

      if (largerModel) {
        selectedModel = largerModel[0];
      }
    }

    // Chay heuristic song song de so sanh (cho analytics)
    const heuristicResult = this.route({ task, files, prompt, project, contextSize });

    const result = {
      model: selectedModel,
      litellm_name: this.models[selectedModel].litellm_name,
      score: Math.round(classification.confidence * 100),
      reasons: [
        `SLM: ${classification.intent}/${classification.complexity}/${classification.domain}`,
        classification.reasoning
      ],
      description: this.models[selectedModel].description,
      cost: this.models[selectedModel].cost_per_1m_input,
      alternatives: [{
        model: heuristicResult.model,
        litellm_name: heuristicResult.litellm_name,
        score: heuristicResult.score,
        reasons: ['heuristic alternative', ...heuristicResult.reasons]
      }],
      analysis: {
        task,
        domains: [classification.domain],
        keywords: [],
        files_count: files.length,
        context_size: contextSize
      },
      // Extra info
      routing_method: 'slm',
      slm_classification: classification,
      heuristic_would_choose: heuristicResult.model,
      agreement: selectedModel === heuristicResult.model
    };

    // Log
    this.history.push({
      timestamp: new Date().toISOString(),
      ...result
    });

    return result;
  }

  // Lay lich su routing
  getHistory(limit = 20) {
    return this.history.slice(-limit);
  }

  // Thong ke model usage
  getStats() {
    const stats = {};
    for (const entry of this.history) {
      if (!stats[entry.model]) stats[entry.model] = { count: 0, avg_score: 0 };
      stats[entry.model].count++;
      stats[entry.model].avg_score += entry.score;
    }
    for (const model in stats) {
      stats[model].avg_score = Math.round(stats[model].avg_score / stats[model].count);
    }
    return stats;
  }
}

module.exports = { SmartRouter, MODEL_PROFILES, detectDomainFromPath, detectKeywordsFromPrompt, SLMClassifier };
