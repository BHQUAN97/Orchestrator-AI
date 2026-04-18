#!/usr/bin/env node
/**
 * CostTracker — singleton theo doi chi phi real-time + hard cap enforcement
 *
 * - Emits 'spend' moi lan record → dashboard subscribe de hien live
 * - Emits 'cap-warning' khi vuot 80% cap, 'cap-exceeded' khi vuot 100%
 * - Persist daily totals vao {projectDir}/.orcai/cost.json (debounced 2s)
 * - Load config tu {projectDir}/.orcai/budget.json (tao default neu thieu)
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_BUDGET = {
  dailyCapUSD: 10,
  perTaskCapUSD: 2,
  warnPercent: 80,
  enforceCap: true
};

const PERSIST_DEBOUNCE_MS = 2000;

function todayKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  // YYYY-MM-DD theo local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

class CostTracker extends EventEmitter {
  constructor(projectDir) {
    super();
    this.setMaxListeners(100);
    this.projectDir = projectDir || process.cwd();
    this.orcaiDir = path.join(this.projectDir, '.orcai');
    this.costFile = path.join(this.orcaiDir, 'cost.json');
    this.budgetFile = path.join(this.orcaiDir, 'budget.json');

    this.since = Date.now();
    this.daily = {};            // { 'YYYY-MM-DD': usd }
    this.taskCurrent = {};      // { taskId: usd }
    this._warned = { daily: {}, task: {} }; // track da warn chua de khong spam
    this._exceeded = { daily: {}, task: {} };
    this._persistTimer = null;

    // Shared pool state — inter-agent budget coordination
    this._activeAgents = new Map();    // agentId → { registeredAt }
    this._reservations = new Map();    // reservationId → { agentId, amountUSD, createdAt }
    this._reservedTotal = 0;           // tong tien dang reserve (chua commit)

    this._ensureDir();
    this.config = this._loadBudget();
    this._loadPersisted();
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.orcaiDir)) fs.mkdirSync(this.orcaiDir, { recursive: true });
    } catch (_) { /* ignore */ }
  }

  _loadBudget() {
    try {
      if (fs.existsSync(this.budgetFile)) {
        const raw = JSON.parse(fs.readFileSync(this.budgetFile, 'utf8'));
        return { ...DEFAULT_BUDGET, ...raw };
      }
    } catch (_) { /* fallback to default */ }
    // Create default budget.json neu thieu
    try {
      fs.writeFileSync(this.budgetFile, JSON.stringify(DEFAULT_BUDGET, null, 2));
    } catch (_) { /* ignore */ }
    return { ...DEFAULT_BUDGET };
  }

  _loadPersisted() {
    try {
      if (fs.existsSync(this.costFile)) {
        const raw = JSON.parse(fs.readFileSync(this.costFile, 'utf8'));
        if (raw && typeof raw === 'object') {
          this.daily = raw.daily || {};
          this.since = raw.since || this.since;
        }
      }
    } catch (_) { /* start fresh */ }
  }

  _schedulePersist() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistNow();
    }, PERSIST_DEBOUNCE_MS);
    // Tranh giu process alive chi vi timer
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  _persistNow() {
    try {
      const payload = { daily: this.daily, since: this.since, updated: Date.now() };
      fs.writeFileSync(this.costFile, JSON.stringify(payload, null, 2));
    } catch (_) { /* ignore */ }
  }

  /**
   * Ghi nhan 1 lan spend va emit event
   * @param {{taskId, model, inputTokens, outputTokens, costUSD, timestamp?}} entry
   */
  record(entry) {
    const {
      taskId = 'unknown',
      model = 'default',
      inputTokens = 0,
      outputTokens = 0,
      costUSD = 0,
      timestamp = Date.now()
    } = entry || {};

    const day = todayKey(timestamp);
    this.daily[day] = (this.daily[day] || 0) + costUSD;
    this.taskCurrent[taskId] = (this.taskCurrent[taskId] || 0) + costUSD;

    const payload = {
      taskId,
      model,
      inputTokens,
      outputTokens,
      costUSD,
      timestamp,
      dailyTotalUSD: this.daily[day],
      taskTotalUSD: this.taskCurrent[taskId],
      day
    };
    this.emit('spend', payload);

    this._checkThresholds(day, taskId);
    this._schedulePersist();

    return payload;
  }

  _checkThresholds(day, taskId) {
    const { dailyCapUSD, perTaskCapUSD, warnPercent } = this.config;
    const warnRatio = (warnPercent || 80) / 100;

    const dailyUSD = this.daily[day] || 0;
    const taskUSD = this.taskCurrent[taskId] || 0;

    // Daily
    if (dailyCapUSD && dailyUSD >= dailyCapUSD && !this._exceeded.daily[day]) {
      this._exceeded.daily[day] = true;
      this.emit('cap-exceeded', { capType: 'daily', currentUSD: dailyUSD, capUSD: dailyCapUSD, day });
    } else if (dailyCapUSD && dailyUSD >= dailyCapUSD * warnRatio && !this._warned.daily[day]) {
      this._warned.daily[day] = true;
      this.emit('cap-warning', { capType: 'daily', currentUSD: dailyUSD, capUSD: dailyCapUSD, percent: (dailyUSD / dailyCapUSD) * 100, day });
    }

    // Per-task
    if (perTaskCapUSD && taskUSD >= perTaskCapUSD && !this._exceeded.task[taskId]) {
      this._exceeded.task[taskId] = true;
      this.emit('cap-exceeded', { capType: 'task', currentUSD: taskUSD, capUSD: perTaskCapUSD, taskId });
    } else if (perTaskCapUSD && taskUSD >= perTaskCapUSD * warnRatio && !this._warned.task[taskId]) {
      this._warned.task[taskId] = true;
      this.emit('cap-warning', { capType: 'task', currentUSD: taskUSD, capUSD: perTaskCapUSD, percent: (taskUSD / perTaskCapUSD) * 100, taskId });
    }
  }

  getDailyTotal(date) {
    const day = date || todayKey();
    return this.daily[day] || 0;
  }

  getTaskTotal(taskId) {
    return this.taskCurrent[taskId] || 0;
  }

  getTopTasks(limit = 10) {
    return Object.entries(this.taskCurrent)
      .map(([taskId, costUSD]) => ({ taskId, costUSD }))
      .sort((a, b) => b.costUSD - a.costUSD)
      .slice(0, limit);
  }

  /**
   * Kiem tra truoc khi chay task → block neu projected cost vuot cap
   */
  checkCap({ taskId, projectedCostUSD = 0 }) {
    if (!this.config.enforceCap) return { allowed: true };

    const day = todayKey();
    const { dailyCapUSD, perTaskCapUSD } = this.config;

    const projectedDaily = (this.daily[day] || 0) + projectedCostUSD;
    const projectedTask = (this.taskCurrent[taskId] || 0) + projectedCostUSD;

    if (dailyCapUSD && projectedDaily > dailyCapUSD) {
      return {
        allowed: false,
        reason: `Daily cap exceeded: projected $${projectedDaily.toFixed(4)} > cap $${dailyCapUSD}`,
        capType: 'daily',
        currentUSD: this.daily[day] || 0,
        projectedUSD: projectedDaily,
        capUSD: dailyCapUSD
      };
    }
    if (perTaskCapUSD && projectedTask > perTaskCapUSD) {
      return {
        allowed: false,
        reason: `Per-task cap exceeded: projected $${projectedTask.toFixed(4)} > cap $${perTaskCapUSD}`,
        capType: 'task',
        currentUSD: this.taskCurrent[taskId] || 0,
        projectedUSD: projectedTask,
        capUSD: perTaskCapUSD
      };
    }
    return { allowed: true };
  }

  reset() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    this.daily = {};
    this.taskCurrent = {};
    this._warned = { daily: {}, task: {} };
    this._exceeded = { daily: {}, task: {} };
    this.since = Date.now();
    try {
      if (fs.existsSync(this.costFile)) fs.unlinkSync(this.costFile);
    } catch (_) { /* ignore */ }
  }

  /**
   * Flush pending persist ngay lap tuc (dung cho test hoac shutdown)
   */
  flush() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    this._persistNow();
  }

  setProjectDir(dir) {
    // Cho phep re-target (test)
    this.projectDir = dir;
    this.orcaiDir = path.join(dir, '.orcai');
    this.costFile = path.join(this.orcaiDir, 'cost.json');
    this.budgetFile = path.join(this.orcaiDir, 'budget.json');
    this._ensureDir();
    this.config = this._loadBudget();
    this._loadPersisted();
  }

  // ============ Shared Pool API ============
  // Coordinate budget giua nhieu subagent song song → tranh double-spend
  // Moi subagent reserve truoc khi chay, commit actual cost khi xong.

  registerAgent(agentId) {
    if (!agentId) throw new Error('registerAgent: agentId required');
    this._activeAgents.set(agentId, { registeredAt: Date.now() });
    this.emit('agent-registered', { agentId, activeCount: this._activeAgents.size });
    return { agentId, activeCount: this._activeAgents.size };
  }

  unregisterAgent(agentId) {
    const existed = this._activeAgents.delete(agentId);
    // Don reservations mo coi (agent crash giua chung) → release tu dong
    for (const [rid, r] of this._reservations.entries()) {
      if (r.agentId === agentId) {
        this._reservedTotal = Math.max(0, this._reservedTotal - r.amountUSD);
        this._reservations.delete(rid);
      }
    }
    this.emit('agent-unregistered', { agentId, existed, activeCount: this._activeAgents.size });
    return { agentId, existed };
  }

  getActiveAgents() {
    return Array.from(this._activeAgents.keys());
  }

  /**
   * Reserve truoc cost de tranh race: N subagent cung kiem tra "con $X" → cung cho phep
   * Projected total = daily spent + reserved + amount → compare voi dailyCap
   */
  reserveBudget(agentId, amountUSD, { taskId = 'shared' } = {}) {
    if (!agentId) throw new Error('reserveBudget: agentId required');
    if (typeof amountUSD !== 'number' || amountUSD < 0) {
      throw new Error('reserveBudget: amountUSD must be non-negative number');
    }

    if (!this.config.enforceCap) {
      return this._grantReservation(agentId, amountUSD);
    }

    const day = todayKey();
    const { dailyCapUSD, perTaskCapUSD } = this.config;

    const projectedDaily = (this.daily[day] || 0) + this._reservedTotal + amountUSD;
    const projectedTask = (this.taskCurrent[taskId] || 0) + amountUSD;

    if (dailyCapUSD && projectedDaily > dailyCapUSD) {
      const payload = {
        agentId, amountUSD, capType: 'daily',
        currentUSD: this.daily[day] || 0,
        reservedUSD: this._reservedTotal,
        projectedUSD: projectedDaily,
        capUSD: dailyCapUSD,
        reason: `Daily cap would be exceeded: $${projectedDaily.toFixed(4)} > $${dailyCapUSD}`
      };
      this.emit('reservation-denied', payload);
      return { granted: false, ...payload };
    }
    if (perTaskCapUSD && projectedTask > perTaskCapUSD) {
      const payload = {
        agentId, amountUSD, capType: 'task', taskId,
        currentUSD: this.taskCurrent[taskId] || 0,
        projectedUSD: projectedTask,
        capUSD: perTaskCapUSD,
        reason: `Per-task cap would be exceeded: $${projectedTask.toFixed(4)} > $${perTaskCapUSD}`
      };
      this.emit('reservation-denied', payload);
      return { granted: false, ...payload };
    }

    return this._grantReservation(agentId, amountUSD);
  }

  _grantReservation(agentId, amountUSD) {
    const reservationId = `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._reservations.set(reservationId, { agentId, amountUSD, createdAt: Date.now() });
    this._reservedTotal += amountUSD;
    this.emit('reservation-granted', {
      reservationId, agentId, amountUSD,
      reservedTotal: this._reservedTotal,
      activeCount: this._activeAgents.size
    });
    return { granted: true, reservationId, amountUSD, reservedTotal: this._reservedTotal };
  }

  /**
   * Chuyen reservation thanh actual spend. actualCostUSD co the < hoac > amount da reserve.
   * Tra phan du ve pool (neu actual < reserved). Caller nen goi record() rieng neu muon track model/tokens.
   */
  commitReservation(reservationId, actualCostUSD, { taskId, model } = {}) {
    const r = this._reservations.get(reservationId);
    if (!r) return { committed: false, reason: 'reservation not found' };

    this._reservations.delete(reservationId);
    this._reservedTotal = Math.max(0, this._reservedTotal - r.amountUSD);

    const actual = Math.max(0, Number(actualCostUSD) || 0);

    // Ghi vao daily + task totals — emit spend nhu record()
    const finalTaskId = taskId || r.agentId;
    const recordPayload = this.record({
      taskId: finalTaskId,
      model: model || 'shared-pool',
      costUSD: actual
    });

    return {
      committed: true,
      reservationId,
      agentId: r.agentId,
      reservedUSD: r.amountUSD,
      actualUSD: actual,
      refundUSD: Math.max(0, r.amountUSD - actual),
      ...recordPayload
    };
  }

  releaseReservation(reservationId) {
    const r = this._reservations.get(reservationId);
    if (!r) return { released: false, reason: 'reservation not found' };
    this._reservations.delete(reservationId);
    this._reservedTotal = Math.max(0, this._reservedTotal - r.amountUSD);
    return { released: true, reservationId, agentId: r.agentId, amountUSD: r.amountUSD };
  }

  getReservedTotal() {
    return this._reservedTotal;
  }

  getPoolStatus() {
    const day = todayKey();
    return {
      activeAgents: this._activeAgents.size,
      reservations: this._reservations.size,
      reservedUSD: this._reservedTotal,
      dailySpentUSD: this.daily[day] || 0,
      dailyCapUSD: this.config.dailyCapUSD || null,
      availableUSD: this.config.dailyCapUSD
        ? Math.max(0, this.config.dailyCapUSD - (this.daily[day] || 0) - this._reservedTotal)
        : null
    };
  }
}

// Singleton — 1 tracker / process, project dir resolve lazy
let _instance = null;

function getCostTracker(projectDir) {
  if (!_instance) {
    _instance = new CostTracker(projectDir);
  } else if (projectDir && projectDir !== _instance.projectDir) {
    _instance.setProjectDir(projectDir);
  }
  return _instance;
}

// Shared pool: 1 instance per projectDir + process → N subagent cung 1 pool
const _poolByProjectDir = new Map();

function getSharedPool(projectDir) {
  const key = path.resolve(projectDir || process.cwd());
  if (!_poolByProjectDir.has(key)) {
    _poolByProjectDir.set(key, new CostTracker(key));
  }
  return _poolByProjectDir.get(key);
}

function _resetSharedPools() {
  // Dung cho test — clear tat ca pool
  _poolByProjectDir.clear();
}

module.exports = { CostTracker, getCostTracker, getSharedPool, _resetSharedPools, DEFAULT_BUDGET };
