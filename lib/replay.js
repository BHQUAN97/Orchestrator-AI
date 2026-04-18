#!/usr/bin/env node
/**
 * Replay — Phat lai transcript JSONL tu session cu
 *
 * Usage:
 *   orcai --replay <sessionId>
 *   orcai --replay latest
 *
 * Khong chay lai LLM — chi replay tool calls + messages tu .orcai/transcripts/
 * De debug / share session / audit.
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { TraceStore } = require('./trace-store');

function findTranscript(projectDir, sessionId) {
  const dir = path.join(projectDir, '.orcai', 'transcripts');
  if (!fs.existsSync(dir)) return null;

  if (sessionId === 'latest') {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return path.join(dir, files[0].f);
  }

  const direct = path.join(dir, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;

  // Prefix match
  const files = fs.readdirSync(dir).filter(f => f.startsWith(sessionId) && f.endsWith('.jsonl'));
  if (files.length === 1) return path.join(dir, files[0]);
  return null;
}

function parseEvents(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return events;
}

/**
 * Pretty print transcript events
 */
async function replayTranscript(projectDir, sessionId, opts = {}) {
  const { speed = 0, filter = null, verbose = false } = opts;
  const file = findTranscript(projectDir, sessionId);
  if (!file) {
    return { success: false, error: `Transcript not found for session: ${sessionId}` };
  }

  const events = parseEvents(file);
  if (!events.length) {
    return { success: false, error: 'Transcript empty or malformed' };
  }

  console.log(chalk.gray(`=== Replay: ${path.basename(file)} (${events.length} events) ===\n`));

  let toolCount = 0;
  let msgCount = 0;
  let errCount = 0;

  for (const ev of events) {
    if (filter && ev.type !== filter) continue;
    const ts = chalk.gray((ev.ts || '').slice(11, 19));

    switch (ev.type) {
      case 'meta':
        console.log(ts, chalk.cyan('META'), JSON.stringify(_stripTs(ev)));
        break;
      case 'message': {
        msgCount++;
        const role = ev.role || 'assistant';
        const preview = (ev.content_preview || '').slice(0, 200).replace(/\n/g, ' ');
        console.log(ts, chalk.blue(role.toUpperCase()), preview);
        if (ev.tool_calls?.length) {
          for (const tc of ev.tool_calls) {
            console.log(ts, chalk.yellow('  → tool'), chalk.bold(tc.name));
          }
        }
        break;
      }
      case 'tool_call': {
        toolCount++;
        const argsStr = verbose ? JSON.stringify(ev.args) : _shortArgs(ev.args);
        console.log(ts, chalk.yellow('CALL'), chalk.bold(ev.name), chalk.gray(argsStr));
        break;
      }
      case 'tool_result': {
        const icon = ev.success ? chalk.green('✓') : chalk.red('✗');
        const preview = ev.error || (ev.preview || '').slice(0, 120).replace(/\n/g, ' ');
        console.log(ts, icon, chalk.bold(ev.name), chalk.gray(preview));
        break;
      }
      case 'error':
        errCount++;
        console.log(ts, chalk.red('ERROR'), ev.error);
        break;
      default:
        if (verbose) console.log(ts, chalk.gray(ev.type), JSON.stringify(_stripTs(ev)));
    }

    if (speed > 0) await _sleep(speed);
  }

  console.log(chalk.gray(`\n=== End replay — ${msgCount} msgs, ${toolCount} tools, ${errCount} errors ===`));
  return { success: true, file, events: events.length, tool_calls: toolCount, messages: msgCount, errors: errCount };
}

function _shortArgs(args) {
  if (!args) return '';
  if (typeof args === 'string') return args.slice(0, 80);
  const keys = Object.keys(args);
  if (!keys.length) return '';
  const first = keys[0];
  const v = args[first];
  const vStr = typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60);
  const extra = keys.length > 1 ? ` +${keys.length - 1} more` : '';
  return `${first}=${vStr}${extra}`;
}

function _stripTs(ev) {
  const { ts, type, ...rest } = ev;
  return rest;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * List available transcripts
 */
function listTranscripts(projectDir) {
  const dir = path.join(projectDir, '.orcai', 'transcripts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return {
        sessionId: f.replace(/\.jsonl$/, ''),
        mtime: st.mtimeMs,
        size: st.size,
        path: full
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Replay pipeline trace tu trace-store — dry-run in tung step, khong goi LLM thuc.
 * @param {string} traceId
 * @param {Object} opts - { projectDir, fromStep, dryRun, store }
 * @returns {Promise<{success, trace, steps, skipped, dryRun}>}
 */
async function replayFromTrace(traceId, opts = {}) {
  const { projectDir, fromStep = 0, dryRun = true, store } = opts;
  const traceStore = store || (projectDir ? new TraceStore({ projectDir }) : null);
  if (!traceStore) {
    return { success: false, error: 'replayFromTrace requires projectDir or store' };
  }
  const trace = traceStore.get(traceId);
  if (!trace) return { success: false, error: `Trace not found: ${traceId}` };

  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const startIdx = Math.max(0, Math.min(fromStep, steps.length));
  const replayable = steps.slice(startIdx);

  // Dry-run: khong goi LLM, chi build plan tu trace da luu
  const replayedSteps = replayable.map((s, i) => ({
    index: startIdx + i,
    agent: s.agent,
    model: s.model,
    tool: s.tool,
    durationMs: s.durationMs,
    status: s.status,
    // Reuse cached output khi dryRun — giup debug deterministic
    output: dryRun ? s.output : null,
    error: s.error || null
  }));

  return {
    success: true,
    traceId,
    task: trace.task,
    status: trace.status,
    dryRun: !!dryRun,
    skipped: startIdx,
    steps: replayedSteps,
    totalCost: trace.totalCost,
    totalTokens: trace.totalTokens
  };
}

/**
 * Diff 2 traces step-by-step — return structured data, KHONG print.
 */
function compareTraces(traceIdA, traceIdB, opts = {}) {
  const { projectDir, store } = opts;
  const traceStore = store || (projectDir ? new TraceStore({ projectDir }) : null);
  if (!traceStore) {
    return { success: false, error: 'compareTraces requires projectDir or store' };
  }
  const a = traceStore.get(traceIdA);
  const b = traceStore.get(traceIdB);
  if (!a) return { success: false, error: `Trace A not found: ${traceIdA}` };
  if (!b) return { success: false, error: `Trace B not found: ${traceIdB}` };

  const sa = a.steps || [];
  const sb = b.steps || [];
  const maxLen = Math.max(sa.length, sb.length);
  const stepDiffs = [];

  for (let i = 0; i < maxLen; i++) {
    const x = sa[i] || null;
    const y = sb[i] || null;
    const diff = {
      index: i,
      a: x ? _stepSummary(x) : null,
      b: y ? _stepSummary(y) : null,
      changed: []
    };
    if (x && y) {
      for (const key of ['agent', 'model', 'tool', 'status']) {
        if (x[key] !== y[key]) diff.changed.push(key);
      }
      // Duration: flag if differ > 25%
      if (x.durationMs && y.durationMs) {
        const pct = Math.abs(x.durationMs - y.durationMs) / Math.max(x.durationMs, y.durationMs);
        if (pct > 0.25) diff.changed.push('durationMs');
      }
      if (JSON.stringify(x.error) !== JSON.stringify(y.error)) diff.changed.push('error');
    } else {
      diff.changed.push('presence');
    }
    stepDiffs.push(diff);
  }

  return {
    success: true,
    a: { id: a.id, status: a.status, totalCost: a.totalCost, totalTokens: a.totalTokens, stepCount: sa.length },
    b: { id: b.id, status: b.status, totalCost: b.totalCost, totalTokens: b.totalTokens, stepCount: sb.length },
    summary: {
      costDelta: (b.totalCost || 0) - (a.totalCost || 0),
      tokensDelta: (b.totalTokens || 0) - (a.totalTokens || 0),
      stepCountDelta: sb.length - sa.length,
      statusChanged: a.status !== b.status,
      changedStepCount: stepDiffs.filter(d => d.changed.length > 0).length
    },
    steps: stepDiffs
  };
}

function _stepSummary(s) {
  return {
    agent: s.agent,
    model: s.model,
    tool: s.tool,
    status: s.status,
    durationMs: s.durationMs,
    error: s.error?.message || s.error || null
  };
}

module.exports = {
  replayTranscript,
  findTranscript,
  listTranscripts,
  parseEvents,
  replayFromTrace,
  compareTraces
};
