#!/usr/bin/env node
/**
 * Hermes Bridge — Connect orcai agent loop voi he sinh thai Hermes/Orchestrator
 *
 * Wrapper truy cap:
 * - SmartRouter: score-based model selection
 * - SLMClassifier: LLM-based intent/complexity classification
 * - DecisionLock: check locked decisions truoc khi sua
 *
 * Muc dich: orcai khong reinvent — reuse component da co.
 */

const path = require('path');
const { SmartRouter } = require('../router/smart-router');
const { SLMClassifier, INTENT_MODEL_MAP } = require('../router/slm-classifier');
const { DecisionLock } = require('../router/decision-lock');
const { MemoryStore, getCurrentProjectName } = require('./memory');

// Threshold mac dinh de filter cross-project hits
const DEFAULT_CROSS_THRESHOLD = 0.65;
const DEFAULT_CROSS_TOPK = 3;

// Multi-factor ranking thresholds
const RANK_INJECT_THRESHOLD = 0.5;        // chi inject entries vuot nguong nay
const RANK_MAX_ESTABLISHED = 3;           // toi da established_pattern entries
const RANK_MAX_REGULAR = 2;               // toi da regular entries
const RANK_SEARCH_PREFETCH = 10;          // lay nhieu hon, roi filter

// Cache trang thai local model — ping 1 lan / 30s, khong block moi request
let _localAvailable = null;  // null=unknown, true/false
let _localLastCheck = 0;
const LOCAL_CHECK_TTL_MS = 30000;

async function _isLocalAvailable(lmUrl) {
  const now = Date.now();
  if (_localAvailable !== null && (now - _localLastCheck) < LOCAL_CHECK_TTL_MS) {
    return _localAvailable;
  }
  _localLastCheck = now;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(
      (lmUrl || process.env.LMSTUDIO_URL || 'http://localhost:1234') + '/v1/models',
      { signal: ctrl.signal }
    );
    _localAvailable = res.ok;
  } catch {
    _localAvailable = false;
  }
  return _localAvailable;
}

/**
 * Multi-factor confidence ranking cho 1 memory entry.
 *
 * @param {object} entry   - memory entry tu MemoryStore
 * @param {number} queryScore  - TF-IDF / semantic similarity score (0-1)
 * @param {string|null} currentModel - model ID dang chay (de check tags)
 * @returns {number} weighted rank in [0, 1]
 */
function _rankMemory(entry, queryScore, currentModel) {
  // Factor 1: semantic/TF-IDF similarity score (0-1)
  const semanticScore = typeof queryScore === 'number' ? Math.min(1, Math.max(0, queryScore)) : 0;

  // Factor 2: helpfulness ratio (how often this lesson actually helped)
  const usedCount = entry.used_count || 0;
  const helpedCount = entry.helped_count || 0;
  const helpedRatio = usedCount > 0 ? helpedCount / usedCount : 0.5; // default 0.5 (neutral)

  // Factor 3: recency decay — entries trong 7 ngay gan nhat duoc full score,
  // sau do decay tuyen tinh den 0.1 trong 90 ngay.
  const ageMs = Date.now() - new Date(entry.ts || 0).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyScore = ageDays <= 7
    ? 1.0
    : Math.max(0.1, 1.0 - (ageDays - 7) / 83); // decay over remaining 83 days → 90 days total

  // Factor 4: model match bonus — co tag modelId-success/fail hay khong
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const modelMatchScore =
    currentModel && tags.includes(`#${currentModel}-success`) ? 1.0 :
    currentModel && tags.includes(`#${currentModel}-fail`)    ? 0.2 : 0.5;

  // Weighted final score
  return (semanticScore * 0.4) + (helpedRatio * 0.3) + (recencyScore * 0.2) + (modelMatchScore * 0.1);
}

class HermesBridge {
  constructor({ projectDir, litellmUrl, litellmKey, useClassifier = false } = {}) {
    this.projectDir = projectDir || process.cwd();
    this.litellmUrl = litellmUrl;
    this.litellmKey = litellmKey;
    this.useClassifier = useClassifier;

    this.smartRouter = new SmartRouter();
    this.classifier = (litellmUrl && litellmKey)
      ? new SLMClassifier({ litellmUrl, litellmKey })
      : null;

    // Decision lock chi enable neu co .sdd/decisions.lock.json
    this.decisionLock = new DecisionLock({ projectDir: this.projectDir });

    // Lich su routing decisions (debug)
    this.history = [];

    // IDs cua cac memory entries da inject trong task hien tai — dung cho recordMemoryOutcome
    this._recalledMemoryIds = [];
  }

  /**
   * Chon model toi uu theo task
   * @param {{ task?, prompt?, files?, contextSize? }} args
   * @returns {{ model, method, reasons, classification? }}
   */
  async selectModel(args = {}) {
    const { task = '', prompt = '', files = [], contextSize = 0 } = args;

    // Thu SLM classifier neu co
    if (this.useClassifier && this.classifier && prompt) {
      try {
        const cls = await this.classifier.classify({ task, files, prompt });
        if (cls && cls.intent && cls.complexity) {
          const key = `${cls.intent}:${cls.complexity}`;
          const model = INTENT_MODEL_MAP[key];
          if (model) {
            const decision = {
              model, method: 'classifier', classification: cls,
              reasons: [cls.reasoning].filter(Boolean)
            };
            this.history.push({ ts: Date.now(), args, decision });
            return decision;
          }
        }
      } catch (e) {
        // Fall through to heuristic
      }
    }

    // Fallback: heuristic scoring
    const result = this.smartRouter.route({ task, files, prompt, contextSize });
    let selectedModel = result.litellm_name || 'default';

    // Neu router chon local model, kiem tra LM Studio co online khong.
    // Neu offline → fallback sang 'smart' ngay, khong doi LiteLLM retry.
    if (selectedModel.startsWith('local')) {
      const lmUrl = this.litellmUrl?.replace(':5002', ':1234') ||
        process.env.LMSTUDIO_URL || 'http://localhost:1234';
      const localOk = await _isLocalAvailable(lmUrl);
      if (!localOk) {
        selectedModel = 'smart';
      }
    }

    const decision = {
      model: selectedModel,
      method: 'heuristic',
      score: result.score || 0,
      reasons: result.reasons || [],
      alternatives: result.alternatives || []
    };
    this.history.push({ ts: Date.now(), args, decision });
    return decision;
  }

  /**
   * Kiem tra cac scope co bi lock khong
   * @param {string[]|string} scopes
   * @returns {Array} cac lock active block
   */
  checkLocks(scopes) {
    const arr = Array.isArray(scopes) ? scopes : [scopes];
    const active = this.decisionLock.getActive();
    const blocks = [];
    for (const scope of arr) {
      if (!scope) continue;
      for (const d of active) {
        if (d.scope === scope || _scopeMatches(d.scope, scope)) {
          blocks.push(d);
        }
      }
    }
    return blocks;
  }

  /**
   * Check nhanh xem 1 file path co trong scope lock nao khong
   * Lock scope co the la: 'api', 'database', 'auth', hoac file path cu the
   */
  checkFilePath(filePath) {
    if (!filePath) return [];
    const rel = path.isAbsolute(filePath) ? path.relative(this.projectDir, filePath) : filePath;
    const normalized = rel.replace(/\\/g, '/');

    const active = this.decisionLock.getActive();
    const blocks = [];
    for (const d of active) {
      // Match if lock scope is exact file path OR directory prefix
      if (d.scope === normalized) {
        blocks.push(d);
        continue;
      }
      // Check relatedFiles list
      if (Array.isArray(d.relatedFiles) && d.relatedFiles.some(f => _pathMatches(f, normalized))) {
        blocks.push(d);
        continue;
      }
      // Detect well-known scopes by path heuristic
      const scopeHint = _detectScope(normalized);
      if (scopeHint && scopeHint === d.scope) {
        blocks.push(d);
      }
    }
    return blocks;
  }

  getActiveLocks() {
    return this.decisionLock.getActive();
  }

  /**
   * Unlock 1 decision lock theo id hoặc scope.
   * id: exact id từ getActiveLocks().id
   * scope: 'api' | 'auth' | 'database' | ... → unlock tất cả locks có scope này
   * @returns {{ unlocked: number, skipped: string[] }}
   */
  unlockDecision(idOrScope, reason = 'manual unlock by user') {
    const active = this.decisionLock.getActive();
    let unlocked = 0;
    const skipped = [];

    for (const d of active) {
      const match = d.id === idOrScope || d.scope === idOrScope;
      if (!match) continue;
      try {
        this.decisionLock.unlock(d.id, { reason, unlockedBy: 'user' });
        unlocked++;
      } catch (e) {
        skipped.push(`${d.id}: ${e.message}`);
      }
    }
    return { unlocked, skipped };
  }

  getRoutingHistory(limit = 10) {
    return this.history.slice(-limit);
  }

  /**
   * Lay cac memory lien quan cho prompt.
   * Su dung multi-factor ranking: semantic score, helpfulness ratio, recency decay, model match.
   * Bao gom cross-project hits neu HERMES_CROSS_PROJECT=1 va score >= threshold.
   *
   * @param {string} query
   * @param {{
   *   topK?: number,
   *   crossTopK?: number,
   *   crossThreshold?: number,
   *   memoryStore?: MemoryStore,
   *   crossEnabled?: boolean,
   *   modelId?: string
   * }} opts
   * @returns {Promise<{ local: Array, cross: Array }>}
   */
  async getRelevantMemories(query, opts = {}) {
    const {
      topK = 5,
      crossTopK = DEFAULT_CROSS_TOPK,
      crossThreshold = DEFAULT_CROSS_THRESHOLD,
      memoryStore,
      crossEnabled,
      modelId
    } = opts;
    const out = { local: [], cross: [] };
    if (!query) return out;

    // Reset recalled IDs cho task moi
    this._recalledMemoryIds = [];

    const store = memoryStore || new MemoryStore(this.projectDir);
    const currentModel = modelId || this.currentModel || null;

    // Lay nhieu entries hon de filter sau bang multi-factor ranking.
    // search() tra ve entries voi _score (TF-IDF). Pass RANK_SEARCH_PREFETCH de co nhieu ung vien.
    let candidates = [];
    try {
      candidates = store.search(query, RANK_SEARCH_PREFETCH) || [];
    } catch {
      candidates = [];
    }

    // Apply multi-factor ranking va filtering
    const established = [];
    const regular = [];

    for (const entry of candidates) {
      const grade = entry.grade || '';

      // Loai bo luon entries bi danh dau deprecated hoac suspect
      if (grade === 'deprecated' || grade === 'suspect') continue;

      const queryScore = typeof entry._score === 'number' ? entry._score : 0;
      const rank = _rankMemory(entry, queryScore, currentModel);

      // established_pattern: luon inject (bo qua threshold), toi da RANK_MAX_ESTABLISHED
      if (grade === 'established_pattern') {
        established.push({ ...entry, _rank: Number(rank.toFixed(4)) });
      } else if (rank > RANK_INJECT_THRESHOLD) {
        // Regular entries chi inject neu vuot nguong
        regular.push({ ...entry, _rank: Number(rank.toFixed(4)) });
      }
    }

    // Sort theo rank giam dan, gioi han so luong
    established.sort((a, b) => b._rank - a._rank);
    regular.sort((a, b) => b._rank - a._rank);

    const injected = [
      ...established.slice(0, RANK_MAX_ESTABLISHED),
      ...regular.slice(0, RANK_MAX_REGULAR)
    ];

    // Gioi han tong so neu topK nho hon tong limit
    out.local = injected.slice(0, Math.max(topK, RANK_MAX_ESTABLISHED + RANK_MAX_REGULAR));

    // Ghi nho IDs da inject de recordMemoryOutcome() sau nay
    this._recalledMemoryIds = out.local.map(e => e.id).filter(Boolean);

    // Cross-project chi bat khi env = '1' (opt-in) hoac override explicit
    const envOn = String(process.env.HERMES_CROSS_PROJECT || '').trim() === '1';
    const useCross = crossEnabled === true || (crossEnabled !== false && envOn);
    if (!useCross) return out;

    try {
      const hits = await store.crossProjectSearch(query, {
        topK: crossTopK,
        excludeCurrent: true,
        minScore: crossThreshold
      });
      out.cross = (hits || []).filter(h => (h.score || 0) >= crossThreshold);
    } catch (err) {
      if (process.env.ORCAI_DEBUG) {
        console.warn('[hermes-bridge] cross-project search failed:', err.message);
      }
      out.cross = [];
    }
    return out;
  }

  /**
   * Format memories (local + cross) de inject vao system prompt.
   * Local entries hien thi voi grade va score de agent hieu do tin cay.
   * Cross hits co attribution explicit: [project=X].
   */
  formatMemoriesForPrompt({ local = [], cross = [] } = {}) {
    const lines = [];
    if (local.length > 0) {
      lines.push('=== Relevant past experience (current project) ===');
      for (const e of local) {
        const grade = e.grade || e.type || 'manual';
        // Hien thi rank neu co, fallback ve _score neu khong
        const scoreVal = typeof e._rank === 'number' ? e._rank
          : typeof e._score === 'number' ? e._score : null;
        const scoreStr = scoreVal !== null ? ` score=${scoreVal.toFixed(2)}` : '';
        // Tag model neu co
        const tags = Array.isArray(e.tags) ? e.tags : [];
        const modelTag = tags.find(t => /^#\w+-success$/.test(t) || /^#\w+-fail$/.test(t));
        const modelStr = modelTag ? ` model=${modelTag.replace(/^#/, '').replace(/-success$|-fail$/, '')}` : '';
        const summary = (e.summary || e.prompt_summary || '').slice(0, 200).replace(/\n/g, ' ');
        lines.push(`[memory grade=${grade}${scoreStr}${modelStr}] ${summary}`);
      }
    }
    if (cross.length > 0) {
      lines.push('=== Cross-project knowledge (other projects) ===');
      for (const h of cross) {
        const snip = String(h.text || '').slice(0, 220).replace(/\n/g, ' ');
        const score = typeof h.score === 'number' ? h.score.toFixed(2) : '?';
        lines.push(`• [project=${h.project}] (${h.file || 'unknown'}, score=${score}) ${snip}`);
      }
    }
    if (lines.length === 0) return '';
    lines.push('=== End memories ===');
    return lines.join('\n');
  }

  /**
   * Ghi nhan ket qua su dung memory sau khi task hoan thanh.
   * Goi sau moi task — cap nhat helped_count / used_count neu MemoryStore ho tro.
   *
   * @param {string[]} recalledIds - IDs cua entries da inject (default: this._recalledMemoryIds)
   * @param {boolean} taskSucceeded - task co thanh cong khong
   */
  async recordMemoryOutcome(recalledIds, taskSucceeded) {
    if (!this.memory?.recordUsage) return;
    const ids = recalledIds ?? this._recalledMemoryIds ?? [];
    for (const id of ids) {
      try {
        await this.memory.recordUsage(id, taskSucceeded);
      } catch (err) {
        if (process.env.ORCAI_DEBUG) {
          console.warn(`[hermes-bridge] recordUsage failed for id=${id}:`, err.message);
        }
      }
    }
  }

  /**
   * Format active locks de inject vao system prompt
   */
  formatLocksForPrompt() {
    const locks = this.getActiveLocks();
    if (locks.length === 0) return '';
    const lines = ['=== Locked decisions (DO NOT override) ==='];
    for (const d of locks) {
      lines.push(`  🔒 [${d.scope}] ${d.decision}${d.reason ? ` — ${d.reason}` : ''}`);
      if (d.relatedFiles?.length > 0) {
        lines.push(`     files: ${d.relatedFiles.slice(0, 3).join(', ')}${d.relatedFiles.length > 3 ? '...' : ''}`);
      }
    }
    lines.push('=== Escalate to user if you need to change these ===');
    return lines.join('\n');
  }
}

function _scopeMatches(lockScope, target) {
  if (!lockScope || !target) return false;
  // Exact match
  if (lockScope === target) return true;
  // Prefix match (lock scope 'api' matches target 'api/users')
  return target.startsWith(lockScope + '/') || target.startsWith(lockScope + '.');
}

function _pathMatches(lockPath, target) {
  if (!lockPath || !target) return false;
  const a = lockPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const b = target.replace(/\\/g, '/').replace(/^\.\//, '');
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

function _detectScope(normalizedPath) {
  if (/\/api\//i.test(normalizedPath) || /controller/i.test(normalizedPath) || /routes\//i.test(normalizedPath)) return 'api';
  if (/\/db\/|\/database\/|migration|repositor/i.test(normalizedPath)) return 'database';
  if (/\/auth\/|middleware\/auth|session/i.test(normalizedPath)) return 'auth';
  if (/\.schema\.|models\/|entities\//i.test(normalizedPath)) return 'schema';
  if (/\.test\.js$|\.spec\.js$|tests\//i.test(normalizedPath)) return 'testing';
  return null;
}

module.exports = { HermesBridge };
