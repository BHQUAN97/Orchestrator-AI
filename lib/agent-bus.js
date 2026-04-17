#!/usr/bin/env node
/**
 * Agent Bus — Inter-agent messaging (parent ↔ subagent)
 *
 * Tuong tu Claude Code: subagent push progress len parent real-time thay vi
 * chi tra ve summary cuoi cung. Giai quyet van de "long-running subagent im lang".
 *
 * Events:
 *   - progress: { agentId, message, iteration }
 *   - tool_call: { agentId, tool, args_preview }
 *   - task_complete: { agentId, success, summary }
 *   - error: { agentId, error }
 *
 * Usage:
 *   const bus = new AgentBus();
 *   bus.on('progress', (e) => console.log(`[${e.agentId}] ${e.message}`));
 *   // Parent spawn subagent voi bus → subagent emit events qua bus
 */

const EventEmitter = require('events');

class AgentBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.history = []; // { ts, event, data }
    this.maxHistory = 200;
  }

  emit(event, data) {
    const entry = { ts: Date.now(), event, data };
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.shift();
    return super.emit(event, data);
  }

  /**
   * Get events cua 1 subagent (for debug/replay)
   */
  getAgentHistory(agentId) {
    return this.history.filter(e => e.data?.agentId === agentId);
  }

  /**
   * Clear event history
   */
  clearHistory() {
    this.history = [];
  }
}

/**
 * Wrapper cho subagent de push events
 */
class AgentReporter {
  constructor(bus, agentId) {
    this.bus = bus;
    this.agentId = agentId;
  }

  progress(message, iteration) {
    if (!this.bus) return;
    this.bus.emit('progress', { agentId: this.agentId, message, iteration });
  }

  toolCall(tool, args) {
    if (!this.bus) return;
    const argsPreview = _preview(args);
    this.bus.emit('tool_call', { agentId: this.agentId, tool, args_preview: argsPreview });
  }

  taskComplete(success, summary) {
    if (!this.bus) return;
    this.bus.emit('task_complete', { agentId: this.agentId, success, summary });
  }

  error(err) {
    if (!this.bus) return;
    this.bus.emit('error', { agentId: this.agentId, error: String(err?.message || err) });
  }
}

function _preview(args) {
  if (!args) return '';
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 120) + '...' : s;
  } catch { return '[unserializable]'; }
}

module.exports = { AgentBus, AgentReporter };
