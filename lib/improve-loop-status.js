#!/usr/bin/env node
/**
 * Improve-loop status reader — expose state.json cho API/dashboard.
 * Trả về null nếu chưa có state file (loop chưa chạy).
 */

'use strict';

const fs = require('fs');
const path = require('path');

function getStatus({ projectDir } = {}) {
  const dir = projectDir || process.cwd();
  const stateFile = path.join(dir, '.orcai', 'improve-loop', 'state.json');
  if (!fs.existsSync(stateFile)) return null;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    return { error: `state parse: ${e.message}` };
  }
  const startedAt = state.startedAt ? new Date(state.startedAt).getTime() : null;
  const lastIterationAt = state.lastIterationAt ? new Date(state.lastIterationAt).getTime() : null;
  const elapsedMs = startedAt ? Date.now() - startedAt : 0;

  // ETA: nếu đã có >=2 iter + còn xa target → ước lượng
  let etaMs = null;
  if (state.history && state.history.length >= 2 && state.status === 'running' && state.bestScore < state.target) {
    const recent = state.history.slice(-3);
    const gains = [];
    for (let i = 1; i < recent.length; i++) {
      gains.push(Math.max(0, (recent[i].score || 0) - (recent[i-1].score || 0)));
    }
    const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;
    const avgIterMs = recent.length
      ? recent.reduce((a, r) => a + (r.wallTimeMs || 0), 0) / recent.length
      : 0;
    const gap = state.target - state.bestScore;
    if (avgGain > 0.01) {
      const itersNeeded = Math.ceil(gap / avgGain);
      etaMs = itersNeeded * (avgIterMs + 90_000);
    }
  }

  const last = state.history && state.history.length ? state.history[state.history.length - 1] : null;

  return {
    iteration: state.iteration,
    status: state.status,
    target: state.target,
    bestScore: state.bestScore,
    bestConfig: state.bestConfig,
    lastConfig: last ? last.config : null,
    lastScore: last ? last.score : null,
    startedAt: state.startedAt,
    lastIterationAt: state.lastIterationAt,
    elapsedMs,
    etaMs,
    plateauCount: state.plateauCount,
    exitReason: state.exitReason,
    historyLen: state.history ? state.history.length : 0,
    indexSize: state.indexSize || (last && last.config && last.config.indexSize) || 0
  };
}

module.exports = { getStatus };
