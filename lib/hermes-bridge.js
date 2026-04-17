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
    const decision = {
      model: result.litellm_name || 'default',
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

  getRoutingHistory(limit = 10) {
    return this.history.slice(-limit);
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
  if (/\/api\//i.test(normalizedPath) || /controller/i.test(normalizedPath)) return 'api';
  if (/\/db\/|\/database\/|migration/i.test(normalizedPath)) return 'database';
  if (/\/auth\/|middleware\/auth/i.test(normalizedPath)) return 'auth';
  if (/\.schema\.|models\//i.test(normalizedPath)) return 'schema';
  return null;
}

module.exports = { HermesBridge };
