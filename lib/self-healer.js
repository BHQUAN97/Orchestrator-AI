#!/usr/bin/env node
/**
 * Self-Healer — Tu dong ghi nhan va hoc tu loi runtime
 *
 * Quan sat tool results:
 * - Neu 1 tool loi cung 1 error N lan → tu save gotcha vao memory
 * - Neu tool loi nhung lan sau thanh cong → ghi lesson "how to avoid"
 * - De xuat fix/workaround trong system reminder cho agent
 *
 * KHONG block agent, KHONG sua args/tool call. Chi observe + suggest + persist.
 * Agent quyet dinh co dung suggestion hay khong.
 *
 * Chay trong cung process nhung isolated state:
 * - errorStreak: map<toolSig, { count, lastError, firstAt }>
 * - resolved: map<toolSig, workaround> (khi sau loi ma thanh cong → ghi recovery)
 */

const REPEAT_THRESHOLD = 3;    // Lap >= 3 lan 1 loi → auto-save gotcha
const RESOLUTION_WINDOW_MS = 120000;  // Thanh cong trong 2 phut sau loi → ghi recovery

class SelfHealer {
  constructor({ memoryStore = null, enabled = true } = {}) {
    this.enabled = enabled;
    this.memoryStore = memoryStore;
    this.errorStreak = new Map();   // toolSig → { count, lastError, firstAt, toolName }
    this.lastErrors = [];           // gan day cho resolution tracking
    this.suggestions = [];          // stack de agent consume qua getSuggestion()
    this.stats = { observed: 0, gotchas_saved: 0, recoveries_saved: 0, suggestions: 0 };
  }

  /**
   * Observe mot tool call result.
   * @param {string} toolName
   * @param {object} args
   * @param {object} result - { content: string JSON }
   */
  observe(toolName, args, result) {
    if (!this.enabled) return null;
    this.stats.observed++;
    const sig = this._signature(toolName, args);

    const parsed = this._parseResult(result);
    const now = Date.now();

    if (parsed.success === false || parsed.error) {
      // Loi — tich luy streak
      const errorKey = this._errorKey(parsed.error);
      const entry = this.errorStreak.get(sig) || { count: 0, lastError: null, firstAt: now, toolName };
      if (entry.lastError === errorKey) {
        entry.count++;
      } else {
        entry.count = 1;
        entry.firstAt = now;
      }
      entry.lastError = errorKey;
      entry.errorText = String(parsed.error || '').slice(0, 300);
      this.errorStreak.set(sig, entry);
      this.lastErrors.push({ sig, toolName, errorKey, ts: now, errorText: entry.errorText });
      if (this.lastErrors.length > 20) this.lastErrors.shift();

      // Auto-save gotcha sau N lan loi lien tiep
      if (entry.count === REPEAT_THRESHOLD) {
        return this._saveGotcha(toolName, args, entry);
      }
      return null;
    }

    // Success — check recovery
    const entry = this.errorStreak.get(sig);
    if (entry && entry.count >= 2) {
      // Thanh cong sau khi da loi nhieu lan → ghi recovery
      const suggestion = this._saveRecovery(toolName, args, entry);
      this.errorStreak.delete(sig);
      return suggestion;
    }

    // Clean streak on success
    this.errorStreak.delete(sig);
    return null;
  }

  /**
   * Luu gotcha vao memory khi loi lap lai
   */
  _saveGotcha(toolName, args, entry) {
    const summary = `Tool '${toolName}' repeatedly failed (${entry.count}x): ${entry.errorText}`;
    const suggestion = {
      type: 'gotcha',
      message: `[Self-healer] ${toolName} da loi ${entry.count} lan voi loi: "${entry.errorText.slice(0, 120)}". Doi cach tiep can: check args, use alternative tool, or ask_user_question for clarification.`,
      toolName,
      errorKey: entry.lastError
    };

    if (this.memoryStore) {
      try {
        this.memoryStore.append({
          type: 'gotcha',
          summary,
          prompt_summary: `${toolName} failure pattern`,
          tool: toolName,
          error: entry.errorText,
          count: entry.count,
          args_preview: this._previewArgs(args)
        });
        this.stats.gotchas_saved++;
      } catch { /* silent */ }
    }

    this.suggestions.push(suggestion);
    this.stats.suggestions++;
    return suggestion;
  }

  /**
   * Luu recovery khi thanh cong sau loi
   */
  _saveRecovery(toolName, args, entry) {
    const summary = `Tool '${toolName}' recovered after ${entry.count} failures — previous error: ${entry.errorText.slice(0, 120)}`;
    if (this.memoryStore) {
      try {
        this.memoryStore.append({
          type: 'lesson',
          summary,
          prompt_summary: `${toolName} recovery`,
          tool: toolName,
          previous_error: entry.errorText,
          recovered_args_preview: this._previewArgs(args)
        });
        this.stats.recoveries_saved++;
      } catch { /* silent */ }
    }
    return null; // No need to push suggestion — success path
  }

  /**
   * Lay suggestion keu tu gan nhat chua consume
   */
  consumeSuggestion() {
    return this.suggestions.shift() || null;
  }

  /**
   * Check co suggestion pending khong
   */
  hasPendingSuggestion() {
    return this.suggestions.length > 0;
  }

  /**
   * Stats cho debug/status
   */
  getStats() {
    return {
      ...this.stats,
      active_streaks: this.errorStreak.size,
      pending_suggestions: this.suggestions.length
    };
  }

  _signature(toolName, args) {
    try {
      const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
      return `${toolName}:${_hash(argsStr)}`;
    } catch {
      return `${toolName}:unhashable`;
    }
  }

  _errorKey(errorText) {
    if (!errorText) return 'unknown';
    // Normalize: remove numbers, paths, extract first meaningful phrase
    return String(errorText)
      .toLowerCase()
      .replace(/\d+/g, 'N')
      .replace(/[\/\\][\w.\-]+/g, '/X')
      .slice(0, 80);
  }

  _parseResult(result) {
    if (!result) return { success: false, error: 'no result' };
    if (result.success !== undefined) return result;
    if (typeof result.content === 'string') {
      try { return JSON.parse(result.content); } catch { return { success: true }; }
    }
    return result;
  }

  _previewArgs(args) {
    if (!args) return '';
    try {
      const s = typeof args === 'string' ? args : JSON.stringify(args);
      return s.length > 200 ? s.slice(0, 200) + '...' : s;
    } catch { return ''; }
  }

  reset() {
    this.errorStreak.clear();
    this.lastErrors = [];
    this.suggestions = [];
    this.stats = { observed: 0, gotchas_saved: 0, recoveries_saved: 0, suggestions: 0 };
  }
}

function _hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

module.exports = { SelfHealer };
