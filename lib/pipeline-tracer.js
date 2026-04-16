#!/usr/bin/env node
/**
 * Pipeline Tracer — Unified tracing cho multi-step orchestration pipeline
 *
 * VAN DE:
 *   Task fail → khong biet loi o dau trong 7 buoc pipeline.
 *   Console.log roi rac, khong co trace ID, khong co timeline.
 *   User chi thay "Error: fetch failed" — khong biet Scanner, Planner hay Executor loi.
 *
 * GIAI PHAP:
 *   - Moi request co 1 trace ID duy nhat
 *   - Moi step ghi nhan: start/end time, status, model, tokens, errors
 *   - Khi fail → tra ve error chinh xac: step nao, model nao, tai sao
 *   - User-friendly error messages + actionable suggestions
 *   - Luu trace history cho debugging
 *
 * CACH DUNG:
 *   const tracer = new PipelineTracer();
 *   const trace = tracer.start('run', { prompt: '...' });
 *
 *   trace.step('scan', { model: 'cheap' });
 *   // ... do scan ...
 *   trace.stepDone('scan', { result: scanData });
 *
 *   trace.step('plan', { model: 'default' });
 *   // ... do plan ...
 *   trace.stepFail('plan', error, { model: 'default' });
 *
 *   const summary = trace.finish();
 *   // { traceId, status, steps: [...], error: { step, message, suggestion }, elapsed_ms }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// === Step definitions — tat ca steps co the co trong pipeline ===
const PIPELINE_STEPS = {
  'classify':  { order: 0, label: 'Classifier',  description: 'SLM pre-classify task complexity' },
  'scan':      { order: 1, label: 'Scanner',     description: 'Quet project, doc file, thu thap context' },
  'plan':      { order: 2, label: 'Planner',     description: 'Xay dung execution plan tu scan data' },
  'review':    { order: 3, label: 'Tech Lead',   description: 'Review va approve/reject plan' },
  'execute':   { order: 4, label: 'Executor',    description: 'Chay subtasks song song' },
  'subtask':   { order: 4, label: 'Subtask',     description: 'Chay 1 subtask cu the' },
  'escalate':  { order: 5, label: 'Escalation',  description: 'Chuyen len model cao hon' },
  'synthesize':{ order: 6, label: 'Synthesizer', description: 'Tong hop ket qua cuoi cung' },
  'model_call':{ order: 0, label: 'LLM Call',    description: 'Goi model qua LiteLLM' },
  'tool_exec': { order: 0, label: 'Tool Exec',   description: 'Chay tool (read/write/command)' },
};

// === Error suggestions — giup user biet cach fix ===
const ERROR_SUGGESTIONS = {
  'fetch failed':        'LiteLLM proxy khong chay. Chay: docker-compose up -d litellm',
  'ECONNREFUSED':        'LiteLLM proxy khong chay tren port 5002. Check: docker ps | grep litellm',
  'Budget exhausted':    'Het budget ngay. Tang DAILY_BUDGET trong .env hoac doi sang ngay mai',
  'Rate limit':          'Model bi rate limit. Doi 30-60s roi thu lai',
  'timeout':             'Model response qua cham. Thu giam max_tokens hoac dung model nhanh hon',
  '401':                 'API key sai. Check LITELLM_KEY trong .env',
  '403':                 'Khong co quyen goi model nay. Check LiteLLM config',
  '404':                 'Model khong ton tai trong LiteLLM. Check litellm_config.yaml',
  '429':                 'Qua nhieu request. Doi 1 phut roi thu lai',
  '500':                 'LiteLLM internal error. Check logs: docker logs litellm',
  '502':                 'Model provider khong phan hoi. Check API status cua provider',
  'JSON parse':          'Model tra ve response khong hop le. Thu lai hoac dung model khac',
  'BLOCKED':             'Decision lock chan thao tac nay. Unlock hoac escalate len Tech Lead',
  'PERMISSION DENIED':   'Agent khong co quyen chay tool nay. Check role permissions',
};

/**
 * Trace — dai dien cho 1 pipeline execution
 */
class Trace {
  constructor(traceId, operation, metadata = {}, parent = null) {
    this.parent = parent; // PipelineTracer (EventEmitter) — emit events cho SSE
    this.traceId = traceId;
    this.operation = operation;
    this.metadata = metadata;
    this.steps = [];
    this.errors = [];
    this.warnings = [];
    this.status = 'running';
    this.startTime = Date.now();
    this.endTime = null;

    // Active steps (chua done)
    this._activeSteps = new Map();
  }

  /**
   * Bat dau 1 step trong pipeline
   * @param {string} stepName - Ten step (scan, plan, review, execute, subtask, model_call)
   * @param {Object} meta - { model, subtaskId, files, ... }
   */
  step(stepName, meta = {}) {
    const stepDef = PIPELINE_STEPS[stepName] || { order: 99, label: stepName, description: '' };
    const stepId = `${stepName}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;

    const stepEntry = {
      id: stepId,
      name: stepName,
      label: stepDef.label,
      status: 'running',
      model: meta.model || null,
      subtaskId: meta.subtaskId || null,
      meta: { ...meta },
      startTime: Date.now(),
      endTime: null,
      elapsed_ms: null,
      result: null,
      error: null
    };

    this.steps.push(stepEntry);
    this._activeSteps.set(stepName, stepEntry);

    // Log — keep console.log nhung structured
    const modelInfo = meta.model ? ` [${meta.model}]` : '';
    const subtaskInfo = meta.subtaskId ? ` (${meta.subtaskId})` : '';
    console.log(`[${this.traceId}] ▶ ${stepDef.label}${modelInfo}${subtaskInfo}`);

    this.parent?.emit('trace:event', {
      traceId: this.traceId, type: 'step_start', step: stepName,
      label: stepDef.label, model: meta.model, ts: Date.now()
    });

    return stepId;
  }

  /**
   * Step hoan thanh
   */
  stepDone(stepName, result = {}) {
    const entry = this._activeSteps.get(stepName);
    if (!entry) return;

    entry.status = 'done';
    entry.endTime = Date.now();
    entry.elapsed_ms = entry.endTime - entry.startTime;
    entry.result = {
      // Chi luu summary, khong luu full output (tiet kiem memory)
      outputSize: typeof result.output === 'string' ? result.output.length : 0,
      tokens: result.tokens || 0,
      success: result.success !== false,
      ...this._summarizeResult(result)
    };

    this._activeSteps.delete(stepName);

    const elapsed = entry.elapsed_ms > 1000
      ? `${(entry.elapsed_ms / 1000).toFixed(1)}s`
      : `${entry.elapsed_ms}ms`;
    console.log(`[${this.traceId}] ✓ ${entry.label} done (${elapsed})`);

    this.parent?.emit('trace:event', {
      traceId: this.traceId, type: 'step_done', step: stepName,
      label: entry.label, elapsed_ms: entry.elapsed_ms, ts: Date.now()
    });
  }

  /**
   * Step that bai — ghi nhan error chi tiet
   */
  stepFail(stepName, error, meta = {}) {
    const entry = this._activeSteps.get(stepName);
    if (!entry) {
      // Step chua duoc bat dau → tao entry cho error
      this.step(stepName, meta);
      return this.stepFail(stepName, error, meta);
    }

    entry.status = 'failed';
    entry.endTime = Date.now();
    entry.elapsed_ms = entry.endTime - entry.startTime;

    const errorMsg = error instanceof Error ? error.message : String(error);
    entry.error = {
      message: errorMsg,
      type: this._classifyError(errorMsg),
      model: meta.model || entry.model,
      suggestion: this._getSuggestion(errorMsg),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n') : null
    };

    this.errors.push({
      step: stepName,
      stepLabel: entry.label,
      ...entry.error,
      timestamp: new Date().toISOString()
    });

    this._activeSteps.delete(stepName);

    console.log(`[${this.traceId}] ✗ ${entry.label} FAILED: ${errorMsg}`);
    if (entry.error.suggestion) {
      console.log(`[${this.traceId}]   → ${entry.error.suggestion}`);
    }

    this.parent?.emit('trace:event', {
      traceId: this.traceId, type: 'step_fail', step: stepName,
      label: entry.label, error: errorMsg, suggestion: entry.error.suggestion, ts: Date.now()
    });
  }

  /**
   * Them warning (khong fail nhung can chu y)
   */
  warn(stepName, message) {
    this.warnings.push({
      step: stepName,
      message,
      timestamp: new Date().toISOString()
    });
    console.log(`[${this.traceId}] ⚠ ${message}`);
  }

  /**
   * Ket thuc trace — tao summary
   */
  finish(finalResult = {}) {
    this.endTime = Date.now();
    this.status = this.errors.length > 0 ? 'failed' : 'done';

    // Mark active steps as stale (khong bao gio done)
    for (const [stepName, entry] of this._activeSteps) {
      entry.status = 'stale';
      entry.endTime = Date.now();
      entry.elapsed_ms = entry.endTime - entry.startTime;
      this.warnings.push({ step: stepName, message: `Step "${stepName}" never completed` });
    }
    this._activeSteps.clear();

    return this.getSummary(finalResult);
  }

  /**
   * Lay summary cua trace — format cho API response
   */
  getSummary(finalResult = {}) {
    const elapsed = (this.endTime || Date.now()) - this.startTime;

    const summary = {
      traceId: this.traceId,
      operation: this.operation,
      status: this.status,
      elapsed_ms: elapsed,
      elapsed_human: elapsed > 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`,
      steps: this.steps.map(s => ({
        name: s.name,
        label: s.label,
        status: s.status,
        model: s.model,
        elapsed_ms: s.elapsed_ms,
        subtaskId: s.subtaskId,
        error: s.error ? { message: s.error.message, suggestion: s.error.suggestion } : null
      })),
      // Timeline ngan gon — 1 dong toan bo pipeline
      timeline: this._buildTimeline(),
      // Errors chi tiet
      errors: this.errors,
      warnings: this.warnings,
      // Model usage
      models_used: [...new Set(this.steps.filter(s => s.model).map(s => s.model))],
      total_steps: this.steps.length,
      failed_steps: this.steps.filter(s => s.status === 'failed').length,
    };

    // Error attribution — step nao loi, model nao, tai sao
    if (this.errors.length > 0) {
      const firstError = this.errors[0];
      summary.error_attribution = {
        failed_at: firstError.stepLabel,
        step: firstError.step,
        model: firstError.model,
        message: firstError.message,
        type: firstError.type,
        suggestion: firstError.suggestion,
        // User-friendly message
        user_message: this._buildUserMessage(firstError)
      };
    }

    return summary;
  }

  // === Private ===

  /**
   * Build timeline 1 dong — de doc nhanh
   * scan(200ms) → plan(1.2s) → review(50ms) → execute(3.5s) ✓
   * scan(200ms) → plan(1.2s) → ✗ review FAILED
   */
  _buildTimeline() {
    const parts = [];
    for (const step of this.steps) {
      // Skip model_call va tool_exec (chi hien top-level steps)
      if (['model_call', 'tool_exec'].includes(step.name)) continue;

      const elapsed = step.elapsed_ms
        ? (step.elapsed_ms > 1000 ? `${(step.elapsed_ms / 1000).toFixed(1)}s` : `${step.elapsed_ms}ms`)
        : '...';

      if (step.status === 'failed') {
        parts.push(`✗ ${step.label} FAILED`);
        break; // Stop timeline at failure
      } else if (step.status === 'done') {
        parts.push(`${step.label}(${elapsed})`);
      } else {
        parts.push(`${step.label}...`);
      }
    }
    return parts.join(' → ') + (this.status === 'done' ? ' ✓' : '');
  }

  /**
   * Phan loai error de suggest fix
   */
  _classifyError(message) {
    const lower = message.toLowerCase();
    if (lower.includes('fetch') || lower.includes('econnrefused') || lower.includes('network')) return 'network';
    if (lower.includes('budget')) return 'budget';
    if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit';
    if (lower.includes('timeout')) return 'timeout';
    if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized')) return 'auth';
    if (lower.includes('json') || lower.includes('parse')) return 'parse';
    if (lower.includes('blocked') || lower.includes('permission')) return 'permission';
    if (lower.includes('500') || lower.includes('502') || lower.includes('503')) return 'server';
    return 'unknown';
  }

  /**
   * Tim suggestion phu hop nhat cho error message
   */
  _getSuggestion(message) {
    for (const [pattern, suggestion] of Object.entries(ERROR_SUGGESTIONS)) {
      if (message.toLowerCase().includes(pattern.toLowerCase())) {
        return suggestion;
      }
    }
    return 'Check log chi tiet voi GET /api/trace/' + this.traceId;
  }

  /**
   * Build user-friendly error message
   */
  _buildUserMessage(error) {
    const stepInfo = error.stepLabel || error.step;
    const modelInfo = error.model ? ` (model: ${error.model})` : '';

    const messages = {
      'network': `Khong ket noi duoc LiteLLM proxy. ${error.suggestion}`,
      'budget':  `Da het budget ngay hom nay. ${error.suggestion}`,
      'rate_limit': `Model dang bi rate limit, vui long doi 1 phut.`,
      'timeout': `${stepInfo} mat qua nhieu thoi gian${modelInfo}. Thu giam do phuc tap cua task.`,
      'auth':    `Loi xac thuc API. Kiem tra LITELLM_KEY trong .env`,
      'parse':   `${stepInfo} tra ve ket qua khong hop le${modelInfo}. Dang thu lai...`,
      'permission': `Thao tac bi chan boi he thong phan quyen. Lien he Tech Lead.`,
      'server':  `LLM provider dang gap loi${modelInfo}. Thu lai sau.`,
    };

    return messages[error.type] || `Loi tai buoc ${stepInfo}${modelInfo}: ${error.message}`;
  }

  /**
   * Rut gon result de luu vao trace (khong luu full output)
   */
  _summarizeResult(result) {
    const summary = {};
    if (result.subtasks) summary.subtaskCount = result.subtasks.length;
    if (result.complexity) summary.complexity = result.complexity;
    if (result.action) summary.action = result.action;
    if (result.escalated) summary.escalated = true;
    if (result.models_used) summary.models_used = result.models_used;
    return summary;
  }
}

/**
 * PipelineTracer — quan ly tat ca traces
 */
class PipelineTracer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(50); // SSE clients co the subscribe nhieu
    this.maxTraces = options.maxTraces || 100;
    this.logDir = options.logDir || null;  // Neu set → ghi trace ra file
    // In-memory trace storage (LRU)
    this.traces = new Map();
    // Stats
    this.stats = {
      total: 0,
      succeeded: 0,
      failed: 0,
      by_error_type: {}
    };
  }

  /**
   * Bat dau trace moi
   * @param {string} operation - 'run', 'scan', 'plan', 'execute'
   * @param {Object} metadata - { prompt, files, project, ... }
   * @returns {Trace}
   */
  start(operation, metadata = {}) {
    const traceId = this._generateTraceId();
    const trace = new Trace(traceId, operation, metadata, this);
    this.emit('trace:event', { traceId, type: 'start', operation, metadata, ts: Date.now() });

    this.traces.set(traceId, trace);
    this.stats.total++;

    // Evict oldest trace khi qua max
    if (this.traces.size > this.maxTraces) {
      const oldestKey = this.traces.keys().next().value;
      this.traces.delete(oldestKey);
    }

    console.log(`\n[${traceId}] ═══ Pipeline Start: ${operation} ═══`);
    return trace;
  }

  /**
   * Ket thuc trace va luu stats
   */
  finish(trace, finalResult = {}) {
    const summary = trace.finish(finalResult);

    // Update stats
    if (summary.status === 'done') {
      this.stats.succeeded++;
    } else {
      this.stats.failed++;
      if (summary.error_attribution) {
        const errType = summary.error_attribution.type;
        this.stats.by_error_type[errType] = (this.stats.by_error_type[errType] || 0) + 1;
      }
    }

    // Log final timeline
    console.log(`[${trace.traceId}] ═══ ${summary.timeline} (${summary.elapsed_human}) ═══\n`);

    // Ghi trace ra file neu co logDir
    if (this.logDir) {
      this._writeTraceLog(trace.traceId, summary);
    }

    // Emit finish event de SSE clients close stream
    this.emit('trace:event', {
      traceId: trace.traceId, type: 'finish',
      status: summary.status, timeline: summary.timeline,
      elapsed_human: summary.elapsed_human, ts: Date.now()
    });

    return summary;
  }

  /**
   * Lay trace theo ID
   */
  get(traceId) {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    return trace.getSummary();
  }

  /**
   * Lay N traces gan nhat
   */
  getRecent(limit = 10) {
    const entries = Array.from(this.traces.entries()).slice(-limit);
    return entries.map(([id, trace]) => ({
      traceId: id,
      operation: trace.operation,
      status: trace.status,
      elapsed_ms: (trace.endTime || Date.now()) - trace.startTime,
      errors: trace.errors.length,
      steps: trace.steps.length
    }));
  }

  /**
   * Lay stats tong hop
   */
  getStats() {
    return {
      ...this.stats,
      success_rate: this.stats.total > 0
        ? Math.round(this.stats.succeeded / this.stats.total * 100)
        : 0,
      active_traces: Array.from(this.traces.values()).filter(t => t.status === 'running').length,
      stored_traces: this.traces.size
    };
  }

  // === Private ===

  _generateTraceId() {
    // Short, readable trace ID: trc-{timestamp}-{random}
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(3).toString('hex');
    return `trc-${ts}-${rand}`;
  }

  _writeTraceLog(traceId, summary) {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      const logPath = path.join(this.logDir, `${traceId}.json`);
      fs.writeFileSync(logPath, JSON.stringify(summary, null, 2), 'utf-8');

      // Cleanup throttled: chi readdir+sort+unlink moi 20 writes thay vi MOI write.
      // 100 req/min × readdir+sort = O(N log N) per call → CPU pin. Throttle giam 95% I/O.
      this._writeCount = (this._writeCount || 0) + 1;
      if (this._writeCount % 20 !== 0) return;

      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('trc-') && f.endsWith('.json'))
        .sort();
      if (files.length > 200) {
        for (const old of files.slice(0, files.length - 200)) {
          fs.unlinkSync(path.join(this.logDir, old));
        }
      }
    } catch {
      // Silent fail — logging khong duoc lam crash pipeline
    }
  }
}

module.exports = { PipelineTracer, Trace, PIPELINE_STEPS, ERROR_SUGGESTIONS };
