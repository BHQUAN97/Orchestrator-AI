/**
 * Cost Tracker — Ghi nhan chi phi theo model, project, session, command
 * Luu vao SQLite de query nhanh, khong mat khi restart
 *
 * Cach dung:
 *   const tracker = new CostTracker();
 *   tracker.log({ model, project, session, command, tokens_in, tokens_out, cost, latency });
 *   tracker.getStats('today');
 *   tracker.getByProject('FashionEcom', '7d');
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'analytics.json');

class CostTracker {
  constructor() {
    this.entries = [];
    this._load();
  }

  // Ghi 1 request
  log(entry) {
    const record = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      date: new Date().toISOString().split('T')[0],
      model: entry.model || 'unknown',
      model_group: entry.model_group || this._getModelGroup(entry.model),
      project: entry.project || 'unknown',
      session: entry.session || 'default',
      command: entry.command || '',
      tokens_in: entry.tokens_in || 0,
      tokens_out: entry.tokens_out || 0,
      tokens_total: (entry.tokens_in || 0) + (entry.tokens_out || 0),
      cost: entry.cost || 0,
      cost_in: entry.cost_in || 0,
      cost_out: entry.cost_out || 0,
      latency_ms: entry.latency_ms || 0,
      cached: entry.cached || false,
      cached_tokens: entry.cached_tokens || 0,
      reasoning_tokens: entry.reasoning_tokens || 0,
      success: entry.success !== false,
    };
    this.entries.push(record);
    this._save();
    return record;
  }

  // --- Queries ---

  // Tong quan theo khoang thoi gian
  getSummary(period = 'today') {
    const filtered = this._filterByPeriod(period);
    const tokens_in = filtered.reduce((s, e) => s + e.tokens_in, 0);
    const tokens_out = filtered.reduce((s, e) => s + e.tokens_out, 0);
    const cost_in = filtered.reduce((s, e) => s + (e.cost_in || 0), 0);
    const cost_out = filtered.reduce((s, e) => s + (e.cost_out || 0), 0);
    return {
      period,
      total_requests: filtered.length,
      tokens_in,
      tokens_out,
      tokens_total: tokens_in + tokens_out,
      tokens_cached: filtered.reduce((s, e) => s + (e.cached_tokens || 0), 0),
      tokens_reasoning: filtered.reduce((s, e) => s + (e.reasoning_tokens || 0), 0),
      cost_in: this._round(cost_in),
      cost_out: this._round(cost_out),
      total_cost: this._round(filtered.reduce((s, e) => s + e.cost, 0)),
      cache_hits: filtered.filter(e => e.cached).length,
      avg_latency: filtered.length > 0
        ? Math.round(filtered.reduce((s, e) => s + e.latency_ms, 0) / filtered.length)
        : 0,
    };
  }

  // Chi phi theo MODEL
  getByModel(period = 'today') {
    const filtered = this._filterByPeriod(period);
    const groups = {};
    for (const e of filtered) {
      const key = e.model_group || e.model;
      if (!groups[key]) groups[key] = { model: key, requests: 0, tokens_in: 0, tokens_out: 0, tokens_total: 0, cost: 0, cost_in: 0, cost_out: 0, avg_latency: 0, _latency_sum: 0 };
      groups[key].requests++;
      groups[key].tokens_in += e.tokens_in;
      groups[key].tokens_out += e.tokens_out;
      groups[key].tokens_total += e.tokens_total;
      groups[key].cost = this._round(groups[key].cost + e.cost);
      groups[key].cost_in = this._round(groups[key].cost_in + (e.cost_in || 0));
      groups[key].cost_out = this._round(groups[key].cost_out + (e.cost_out || 0));
      groups[key]._latency_sum += e.latency_ms;
    }
    return Object.values(groups).map(g => {
      g.avg_latency = g.requests > 0 ? Math.round(g._latency_sum / g.requests) : 0;
      delete g._latency_sum;
      return g;
    }).sort((a, b) => b.cost - a.cost);
  }

  // Chi phi theo PROJECT
  getByProject(period = 'today') {
    const filtered = this._filterByPeriod(period);
    const groups = {};
    for (const e of filtered) {
      const key = e.project;
      if (!groups[key]) groups[key] = { project: key, requests: 0, tokens_in: 0, tokens_out: 0, tokens_total: 0, cost: 0, cost_in: 0, cost_out: 0, models_used: new Set() };
      groups[key].requests++;
      groups[key].tokens_in += e.tokens_in;
      groups[key].tokens_out += e.tokens_out;
      groups[key].tokens_total += e.tokens_total;
      groups[key].cost = this._round(groups[key].cost + e.cost);
      groups[key].cost_in = this._round(groups[key].cost_in + (e.cost_in || 0));
      groups[key].cost_out = this._round(groups[key].cost_out + (e.cost_out || 0));
      groups[key].models_used.add(e.model_group || e.model);
    }
    return Object.values(groups).map(g => {
      g.models_used = Array.from(g.models_used);
      return g;
    }).sort((a, b) => b.cost - a.cost);
  }

  // Chi phi theo SESSION
  getBySession(period = 'today') {
    const filtered = this._filterByPeriod(period);
    const groups = {};
    for (const e of filtered) {
      const key = e.session;
      if (!groups[key]) groups[key] = {
        session: key,
        project: e.project,
        start: e.timestamp,
        end: e.timestamp,
        requests: 0,
        tokens: 0,
        cost: 0,
        commands: new Set(),
        models: new Set()
      };
      groups[key].requests++;
      groups[key].tokens += e.tokens_total;
      groups[key].cost = this._round(groups[key].cost + e.cost);
      groups[key].end = e.timestamp;
      if (e.command) groups[key].commands.add(e.command);
      groups[key].models.add(e.model_group || e.model);
    }
    return Object.values(groups).map(g => {
      g.commands = Array.from(g.commands);
      g.models = Array.from(g.models);
      g.duration_min = Math.round((new Date(g.end) - new Date(g.start)) / 60000);
      return g;
    }).sort((a, b) => new Date(b.start) - new Date(a.start));
  }

  // Chi phi theo COMMAND (/build, /fix, /review...)
  getByCommand(period = 'today') {
    const filtered = this._filterByPeriod(period).filter(e => e.command);
    const groups = {};
    for (const e of filtered) {
      const key = e.command;
      if (!groups[key]) groups[key] = { command: key, requests: 0, tokens: 0, cost: 0, projects: new Set() };
      groups[key].requests++;
      groups[key].tokens += e.tokens_total;
      groups[key].cost = this._round(groups[key].cost + e.cost);
      groups[key].projects.add(e.project);
    }
    return Object.values(groups).map(g => {
      g.projects = Array.from(g.projects);
      g.avg_cost = g.requests > 0 ? this._round(g.cost / g.requests) : 0;
      return g;
    }).sort((a, b) => b.cost - a.cost);
  }

  // Chi phi theo NGAY (chart data)
  getDailyTrend(days = 30) {
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayEntries = this.entries.filter(e => e.date === dateStr);
      result.push({
        date: dateStr,
        requests: dayEntries.length,
        tokens: dayEntries.reduce((s, e) => s + e.tokens_total, 0),
        cost: this._round(dayEntries.reduce((s, e) => s + e.cost, 0)),
        models: [...new Set(dayEntries.map(e => e.model_group || e.model))],
      });
    }
    return result;
  }

  // Chi phi theo THANG
  getMonthlyTrend(months = 6) {
    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const monthStr = d.toISOString().slice(0, 7); // YYYY-MM
      const monthEntries = this.entries.filter(e => e.date.startsWith(monthStr));
      result.push({
        month: monthStr,
        requests: monthEntries.length,
        tokens: monthEntries.reduce((s, e) => s + e.tokens_total, 0),
        cost: this._round(monthEntries.reduce((s, e) => s + e.cost, 0)),
      });
    }
    return result;
  }

  // So sanh chi phi: neu dung Opus cho tat ca vs multi-model
  getCostComparison(period = '30d') {
    const filtered = this._filterByPeriod(period);
    const actualCost = filtered.reduce((s, e) => s + e.cost, 0);
    // Uoc tinh neu dung Opus: $15/1M input, $75/1M output
    const opusCost = filtered.reduce((s, e) => s + (e.tokens_in * 15 + e.tokens_out * 75) / 1000000, 0);
    return {
      period,
      actual_cost: this._round(actualCost),
      opus_equivalent: this._round(opusCost),
      saved: this._round(opusCost - actualCost),
      saved_percent: opusCost > 0 ? Math.round((1 - actualCost / opusCost) * 100) : 0,
    };
  }

  // Export JSON cho dashboard
  toJSON() {
    return {
      summary: {
        today: this.getSummary('today'),
        week: this.getSummary('7d'),
        month: this.getSummary('30d'),
        all: this.getSummary('all'),
      },
      by_model: this.getByModel('30d'),
      by_project: this.getByProject('30d'),
      by_command: this.getByCommand('30d'),
      daily_trend: this.getDailyTrend(30),
      monthly_trend: this.getMonthlyTrend(6),
      cost_comparison: this.getCostComparison('30d'),
      recent_sessions: this.getBySession('7d').slice(0, 20),
    };
  }

  // --- Internal ---

  _getModelGroup(model) {
    if (!model) return 'unknown';
    const m = model.toLowerCase();
    if (m.includes('kimi')) return 'Kimi K2.5';
    if (m.includes('sonnet')) return 'Sonnet 4';
    if (m.includes('gemini')) return 'Gemini Flash';
    if (m.includes('deepseek')) return 'DeepSeek';
    if (m.includes('opus')) return 'Opus';
    if (m.includes('haiku')) return 'Haiku';
    return model;
  }

  _filterByPeriod(period) {
    if (period === 'all') return this.entries;
    const now = new Date();
    let since;
    if (period === 'today') {
      since = new Date(now.toISOString().split('T')[0]);
    } else if (period.endsWith('d')) {
      since = new Date(now - parseInt(period) * 86400000);
    } else if (period.endsWith('m')) {
      since = new Date(now);
      since.setMonth(since.getMonth() - parseInt(period));
    } else {
      since = new Date(0);
    }
    return this.entries.filter(e => new Date(e.timestamp) >= since);
  }

  _round(n) { return Math.round(n * 10000) / 10000; }

  _load() {
    try {
      if (fs.existsSync(DB_PATH)) {
        this.entries = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      }
    } catch { this.entries = []; }
  }

  _save() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(this.entries, null, 2));
  }
}

module.exports = { CostTracker };
