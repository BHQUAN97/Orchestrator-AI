#!/usr/bin/env node
/**
 * Trace API — handler functions for observability panel.
 * Pure functions: no route registration, no server. Parent wires these into
 * api-server.js. Each returns { ok: true, data } or { ok: false, error }.
 */

const { TraceStore } = require('./trace-store');
const { replayFromTrace } = require('./replay');

function _store(projectDir) {
  if (!projectDir) throw new Error('projectDir required');
  return new TraceStore({ projectDir });
}

function _ok(data) { return { ok: true, data }; }
function _err(error) { return { ok: false, error: String(error?.message || error) }; }

/**
 * List traces — query: { since, until, status, limit, projectDir }
 */
function listTraces(query = {}) {
  try {
    const { projectDir, since, until, status, limit = 50 } = query;
    const store = _store(projectDir);
    const traces = store.list({ since, until, status, limit });
    return _ok({ traces, count: traces.length });
  } catch (e) { return _err(e); }
}

function getTrace(traceId, opts = {}) {
  try {
    if (!traceId) return _err('traceId required');
    const store = _store(opts.projectDir);
    const trace = store.get(traceId);
    if (!trace) return _err(`Trace not found: ${traceId}`);
    return _ok(trace);
  } catch (e) { return _err(e); }
}

async function replayTrace(traceId, opts = {}) {
  try {
    if (!traceId) return _err('traceId required');
    if (!opts.projectDir) return _err('projectDir required');
    const res = await replayFromTrace(traceId, {
      projectDir: opts.projectDir,
      fromStep: opts.fromStep ?? 0,
      dryRun: opts.dryRun !== false // default true — safe for UI
    });
    if (!res.success) return _err(res.error);
    return _ok(res);
  } catch (e) { return _err(e); }
}

function deleteTrace(traceId, opts = {}) {
  try {
    if (!traceId) return _err('traceId required');
    const store = _store(opts.projectDir);
    const res = store.delete(traceId);
    return _ok({ deleted: true, ...res });
  } catch (e) { return _err(e); }
}

function pruneTraces(maxCount, opts = {}) {
  try {
    if (!Number.isInteger(maxCount) || maxCount < 0) {
      return _err('maxCount must be a non-negative integer');
    }
    const store = _store(opts.projectDir);
    const res = store.prune(maxCount);
    return _ok(res);
  } catch (e) { return _err(e); }
}

module.exports = {
  listTraces,
  getTrace,
  replayTrace,
  deleteTrace,
  pruneTraces
};
