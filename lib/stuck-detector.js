#!/usr/bin/env node
/**
 * Stuck Detector — Phat hien agent lap tool call
 *
 * Agent co the bi stuck:
 * - Goi cung tool voi cung args 3+ lan
 * - Lap pattern [A, B, A, B, A] (toggle)
 * - Read cung 1 file nhieu lan
 *
 * Khi detect → tra ve warning. Agent-loop inject system reminder yeu cau
 * doi cach tiep can.
 *
 * Khong auto-abort — chi warn. Agent co 2-3 co hoi nua truoc khi max
 * iterations trigger.
 */

const WINDOW_SIZE = 8;  // So tool call gan nhat de kiem tra
const REPEAT_THRESHOLD = 3;  // Lap >= 3 lan la stuck
const TOGGLE_MIN = 5;  // Pattern toggle [A,B,A,B,A...] min length

class StuckDetector {
  constructor() {
    this.history = []; // array of "tool:argsHash"
  }

  /**
   * Record 1 tool call + return stuck warning if any
   */
  record(toolName, args) {
    const sig = this._signature(toolName, args);
    this.history.push(sig);
    if (this.history.length > WINDOW_SIZE) {
      this.history.shift();
    }
    return this._checkStuck();
  }

  /**
   * Kiem tra stuck patterns
   * @returns {null | { type, message }}
   */
  _checkStuck() {
    if (this.history.length < REPEAT_THRESHOLD) return null;

    // Pattern 1: toggle [A,B,A,B,A] — check TRUOC repeat vi toggle specific hon
    if (this.history.length >= TOGGLE_MIN) {
      const recent = this.history.slice(-TOGGLE_MIN);
      const a = recent[0], b = recent[1];
      if (a !== b) {
        let isToggle = true;
        for (let i = 0; i < recent.length; i++) {
          const expected = i % 2 === 0 ? a : b;
          if (recent[i] !== expected) { isToggle = false; break; }
        }
        if (isToggle) {
          return {
            type: 'toggle',
            patterns: [a.slice(0, 60), b.slice(0, 60)],
            message: `You are toggling between two tool calls (A↔B pattern, ${TOGGLE_MIN}+ iterations). This suggests circular reasoning. Step back, synthesize what you've learned, and take a different path — or call task_complete with what you know.`
          };
        }
      }
    }

    // Pattern 2: same signature appears >= REPEAT_THRESHOLD times
    const counts = {};
    for (const sig of this.history) {
      counts[sig] = (counts[sig] || 0) + 1;
    }
    for (const [sig, count] of Object.entries(counts)) {
      if (count >= REPEAT_THRESHOLD) {
        return {
          type: 'repeat',
          signature: sig,
          count,
          message: `You have called the same tool with the same args ${count} times (signature: ${sig.slice(0, 100)}). You may be stuck. Try a different approach: examine the previous tool results carefully, or ask_user_question for clarification.`
        };
      }
    }

    return null;
  }

  /**
   * Signature for comparison — tool name + args hash
   */
  _signature(toolName, args) {
    let argsStr = '';
    try {
      argsStr = typeof args === 'string' ? args : JSON.stringify(args);
    } catch { argsStr = '[unhashable]'; }
    // Hash to keep short
    return `${toolName}:${_hash(argsStr)}`;
  }

  reset() { this.history = []; }
}

// Simple stable hash (FNV-like)
function _hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

module.exports = { StuckDetector };
