#!/usr/bin/env node
/**
 * Session Continuity Manager — Giu trang thai in-flight giua cac phien lam viec
 *
 * Storage: {projectDir}/.orcai/sessions/
 *   ├── {sessionId}.json       — full snapshot (atomic write tmp → rename)
 *   └── index.jsonl            — append-only session registry
 *
 * Snapshot state: { turn, activeDecisions, openTasks, inFlightFiles,
 *                   lastTraceId, nextStep, gitHead, errorsSeen, modelsUsed }
 *
 * VAN DE: New session next day → Claude khong biet prior state (decisions,
 * open tasks, mid-edit files, recent errors). Reconstruct tu context-cache
 * + MEMORY + git log → 2-5K tokens moi lan, khong day du.
 *
 * GIAI PHAP: Snapshot sau moi N turn; load previous session voi git-divergence
 * check de biet code da di xa chua.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MAX_AGE_HOURS = 48;
const DEFAULT_SNAPSHOT_EVERY_TURNS = 5;
const DEFAULT_BRIDGE_EVERY_TURNS = 10;

class SessionContinuity {
  constructor({ projectDir, hermesBridge } = {}) {
    this.projectDir = projectDir || process.cwd();
    this.baseDir = path.join(this.projectDir, '.orcai', 'sessions');
    this.indexPath = path.join(this.baseDir, 'index.jsonl');
    this.hermesBridge = hermesBridge || null;
    this._ensureDir();
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
    } catch (e) {
      this._error = e.message;
    }
  }

  // === Public API ===

  /**
   * Tao session moi + ghi registry entry
   */
  startSession({ prompt = '', parentSessionId = null } = {}) {
    const sessionId = this._generateId();
    const startedAt = Date.now();
    const head = gitHead(this.projectDir);

    const snapshot = {
      id: sessionId,
      parentSessionId,
      prompt: String(prompt || '').slice(0, 500),
      startedAt,
      endedAt: null,
      status: 'active',
      turn: 0,
      activeDecisions: [],
      openTasks: [],
      inFlightFiles: [],
      lastTraceId: null,
      nextStep: null,
      gitHead: head,
      errorsSeen: [],
      modelsUsed: [],
      updatedAt: startedAt
    };

    this._atomicWrite(this._sessionFile(sessionId), snapshot);
    this._appendIndex({
      id: sessionId,
      startedAt,
      endedAt: null,
      turns: 0,
      status: 'active',
      prompt: snapshot.prompt,
      parentSessionId
    });

    return sessionId;
  }

  /**
   * Luu snapshot — atomic (tmp + rename)
   */
  saveSnapshot({ sessionId, state = {} } = {}) {
    if (!sessionId) throw new Error('saveSnapshot requires sessionId');
    const filePath = this._sessionFile(sessionId);
    const existing = this._readJson(filePath);
    if (!existing) throw new Error(`Session ${sessionId} not found`);

    const merged = {
      ...existing,
      turn: typeof state.turn === 'number' ? state.turn : existing.turn,
      activeDecisions: state.activeDecisions ?? existing.activeDecisions,
      openTasks: state.openTasks ?? existing.openTasks,
      inFlightFiles: state.inFlightFiles ?? existing.inFlightFiles,
      lastTraceId: state.lastTraceId ?? existing.lastTraceId,
      nextStep: state.nextStep ?? existing.nextStep,
      gitHead: state.gitHead ?? gitHead(this.projectDir) ?? existing.gitHead,
      errorsSeen: state.errorsSeen ?? existing.errorsSeen,
      modelsUsed: state.modelsUsed ?? existing.modelsUsed,
      updatedAt: Date.now()
    };

    this._atomicWrite(filePath, merged);
    return merged;
  }

  /**
   * Load session gan nhat con trong cua so maxAgeHours
   * Return { session, isFresh, gitDivergence }
   */
  loadPreviousSession({ maxAgeHours = DEFAULT_MAX_AGE_HOURS, excludeId = null } = {}) {
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    const files = this._listSessionFiles();
    let latest = null;

    for (const f of files) {
      const data = this._readJson(path.join(this.baseDir, f));
      if (!data || !data.id) continue;
      if (excludeId && data.id === excludeId) continue;
      const ts = data.updatedAt || data.startedAt || 0;
      if (ts < cutoff) continue;
      if (!latest || ts > (latest.updatedAt || latest.startedAt || 0)) {
        latest = data;
      }
    }

    if (!latest) return null;

    const currentHead = gitHead(this.projectDir);
    const isFresh = !!(currentHead && latest.gitHead && currentHead === latest.gitHead);
    const divergence = (currentHead && latest.gitHead && currentHead !== latest.gitHead)
      ? gitDivergence(latest.gitHead, this.projectDir)
      : { commitsAhead: 0, commitsBehind: 0, filesChanged: [] };

    return { session: latest, isFresh, gitDivergence: divergence };
  }

  /**
   * Moi N turns → compress + push vao Hermes long-term memory
   * Return null neu bridge disabled hoac fail
   */
  async bridgeSummary({ sessionId, everyTurns = DEFAULT_BRIDGE_EVERY_TURNS } = {}) {
    if (!this.hermesBridge || typeof this.hermesBridge.push !== 'function') {
      return null;
    }
    const session = this._readJson(this._sessionFile(sessionId));
    if (!session) return null;
    if (!session.turn || session.turn % everyTurns !== 0) return null;

    const payload = {
      sessionId,
      projectDir: this.projectDir,
      turn: session.turn,
      prompt: session.prompt,
      activeDecisions: session.activeDecisions,
      openTasks: session.openTasks,
      nextStep: session.nextStep,
      modelsUsed: session.modelsUsed,
      errorsSeen: (session.errorsSeen || []).slice(-5),
      gitHead: session.gitHead,
      summary: this._summaryText(session)
    };

    try {
      const res = await this.hermesBridge.push(payload);
      return res || true;
    } catch {
      return null;
    }
  }

  /**
   * Tom tat cac session gan day cho menu morning
   */
  listRecentSessions({ limit = 10 } = {}) {
    const files = this._listSessionFiles();
    const items = [];
    for (const f of files) {
      const data = this._readJson(path.join(this.baseDir, f));
      if (!data || !data.id) continue;
      items.push({
        id: data.id,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        turns: data.turn || 0,
        status: data.status || 'unknown',
        prompt: data.prompt || ''
      });
    }
    items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return items.slice(0, limit);
  }

  /**
   * Dong session — final write + append registry
   */
  closeSession(sessionId, { status = 'completed', summary = null } = {}) {
    const filePath = this._sessionFile(sessionId);
    const existing = this._readJson(filePath);
    if (!existing) throw new Error(`Session ${sessionId} not found`);

    const endedAt = Date.now();
    const finalState = {
      ...existing,
      status,
      endedAt,
      updatedAt: endedAt,
      finalSummary: summary
    };
    this._atomicWrite(filePath, finalState);

    this._appendIndex({
      id: sessionId,
      startedAt: existing.startedAt,
      endedAt,
      turns: existing.turn || 0,
      status,
      prompt: existing.prompt || '',
      event: 'close'
    });

    return finalState;
  }

  /**
   * Attach vao ConversationManager — wrapper auto-snapshot moi N turn
   * Return handle { onTurn, onEnd, sessionId }
   */
  attachToConversation(conversationManager, {
    sessionId,
    snapshotEveryTurns = DEFAULT_SNAPSHOT_EVERY_TURNS,
    bridgeEveryTurns = DEFAULT_BRIDGE_EVERY_TURNS,
    collector = null
  } = {}) {
    if (!sessionId) {
      throw new Error('attachToConversation requires sessionId');
    }

    const self = this;
    let turnCount = 0;

    // Named handler de co the off() sau nay — tranh listener accumulation khi
    // attachToConversation goi nhieu lan trong 1 process (multi-session CLI loop)
    const turnHandler = (payload) => {
      turnCount++;
      self._autoSnapshotTurn(sessionId, turnCount, payload, collector, snapshotEveryTurns, bridgeEveryTurns);
    };
    const endHandler = (payload) => {
      self.closeSession(sessionId, { status: payload?.status || 'completed', summary: payload?.summary });
    };

    // Neu conversationManager emit events → hook
    const hasEmitter = conversationManager && typeof conversationManager.on === 'function';
    if (hasEmitter) {
      conversationManager.on('turn', turnHandler);
      conversationManager.on('session-end', endHandler);
    }

    // Wrapper API — caller goi thu cong sau moi turn
    return {
      sessionId,
      onTurn: (payload = {}) => {
        turnCount++;
        return self._autoSnapshotTurn(sessionId, turnCount, payload, collector, snapshotEveryTurns, bridgeEveryTurns);
      },
      onEnd: ({ status = 'completed', summary = null } = {}) =>
        self.closeSession(sessionId, { status, summary }),
      // Detach: removeListener cac handler da register de tranh memory leak
      detach: () => {
        if (hasEmitter && typeof conversationManager.off === 'function') {
          conversationManager.off('turn', turnHandler);
          conversationManager.off('session-end', endHandler);
        } else if (hasEmitter && typeof conversationManager.removeListener === 'function') {
          conversationManager.removeListener('turn', turnHandler);
          conversationManager.removeListener('session-end', endHandler);
        }
      }
    };
  }

  // === Private helpers ===

  async _autoSnapshotTurn(sessionId, turn, payload, collector, snapEvery, bridgeEvery) {
    const state = collector ? (collector(payload) || {}) : (payload || {});
    state.turn = turn;

    if (turn % snapEvery === 0) {
      try { this.saveSnapshot({ sessionId, state }); } catch { /* ignore */ }
    } else {
      // Light update — chi cap nhat turn counter
      try {
        const existing = this._readJson(this._sessionFile(sessionId));
        if (existing) {
          existing.turn = turn;
          existing.updatedAt = Date.now();
          this._atomicWrite(this._sessionFile(sessionId), existing);
        }
      } catch { /* ignore */ }
    }

    if (turn % bridgeEvery === 0) {
      try { await this.bridgeSummary({ sessionId, everyTurns: bridgeEvery }); } catch { /* ignore */ }
    }
  }

  _generateId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `sess-${ts}-${rand}`;
  }

  _sessionFile(id) {
    return path.join(this.baseDir, `${id}.json`);
  }

  _listSessionFiles() {
    try {
      return fs.readdirSync(this.baseDir)
        .filter(f => f.endsWith('.json') && f !== 'index.jsonl');
    } catch {
      return [];
    }
  }

  _readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Atomic write: tmp + rename → khong bi torn file khi crash
   */
  _atomicWrite(filePath, data) {
    this._ensureDir();
    const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  _appendIndex(entry) {
    try {
      this._ensureDir();
      fs.appendFileSync(this.indexPath, JSON.stringify({ ...entry, ts: Date.now() }) + '\n', 'utf-8');
    } catch { /* ignore */ }
  }

  _summaryText(session) {
    const parts = [];
    if (session.prompt) parts.push(`Goal: ${session.prompt.slice(0, 120)}`);
    if (session.nextStep) parts.push(`Next: ${session.nextStep}`);
    if (session.openTasks?.length) parts.push(`Open: ${session.openTasks.length} tasks`);
    if (session.activeDecisions?.length) parts.push(`Decisions: ${session.activeDecisions.length}`);
    if (session.inFlightFiles?.length) parts.push(`Editing: ${session.inFlightFiles.length} files`);
    if (session.errorsSeen?.length) parts.push(`Errors: ${session.errorsSeen.length}`);
    return parts.join(' | ');
  }
}

// === Helpers ===

/**
 * Lay HEAD commit sha — return null neu khong phai git dir
 */
function gitHead(projectDir) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 3000
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * So sanh HEAD hien tai voi fromSha
 * Return { commitsAhead, commitsBehind, filesChanged }
 */
function gitDivergence(fromSha, projectDir) {
  const result = { commitsAhead: 0, commitsBehind: 0, filesChanged: [] };
  if (!fromSha) return result;

  try {
    const ahead = execFileSync('git', ['rev-list', '--count', `${fromSha}..HEAD`], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 3000
    });
    result.commitsAhead = parseInt(ahead.trim(), 10) || 0;
  } catch { /* ignore */ }

  try {
    const behind = execFileSync('git', ['rev-list', '--count', `HEAD..${fromSha}`], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 3000
    });
    result.commitsBehind = parseInt(behind.trim(), 10) || 0;
  } catch { /* ignore */ }

  try {
    const diff = execFileSync('git', ['diff', '--name-only', fromSha], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 5000
    });
    result.filesChanged = diff.split('\n').map(s => s.trim()).filter(Boolean);
  } catch { /* ignore */ }

  return result;
}

module.exports = { SessionContinuity, gitHead, gitDivergence };
