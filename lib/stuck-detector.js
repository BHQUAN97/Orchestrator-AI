#!/usr/bin/env node
/**
 * Stuck Detector — Phat hien agent lap tool call + redundant read
 *
 * Agent co the bi stuck hoac ton token vi:
 * - Goi cung tool voi cung args 3+ lan (signature repeat)
 * - Lap pattern [A, B, A, B, A] (toggle)
 * - Read cung 1 file nhieu lan (path repeat — khac args hash vi offset khac)
 * - Read_file sau khi search_files/glob da tra ve ket qua cho cung path (redundant verify)
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
    this.searchedPaths = new Set(); // normalized path → da co search_files/glob tra ket qua
    this.warnedPaths = new Set(); // path da warn 1 lan, khong spam
  }

  /**
   * Record 1 tool call TRUOC khi execute — tra ve warning neu detect stuck/redundant.
   * Chi track args (khong can result). Caller goi recordResult() sau khi co result
   * de update path-level state.
   */
  record(toolName, args) {
    const sig = this._signature(toolName, args);
    this.history.push(sig);
    if (this.history.length > WINDOW_SIZE) {
      this.history.shift();
    }

    // Check cross-tool redundant read (read_file on path already searched) — highest priority
    const redundant = this._checkRedundantRead(toolName, args);
    if (redundant) return redundant;

    return this._checkStuck();
  }

  /**
   * Record tool result SAU khi execute — update searchedPaths set.
   * Chi lam gi cho search_files / glob co matches (de agent-loop detect redundant re-read).
   */
  recordResult(toolName, args, toolResult) {
    if (!args) return;
    if (toolName !== 'search_files' && toolName !== 'glob') return;
    if (!this._hasMatches(toolResult)) return;
    const p = args.path ? _normalizePath(args.path) : '';
    if (p) this.searchedPaths.add(p);
  }

  /**
   * Check redundant read: read_file tren path da co search_files/glob tra matches
   * → Agent dang "double-check" khong can thiet, ton token.
   */
  _checkRedundantRead(toolName, args) {
    if (toolName !== 'read_file' || !args?.path) return null;
    const p = _normalizePath(args.path);
    if (this.warnedPaths.has(p)) return null; // Khong spam cung path

    for (const searchedPath of this.searchedPaths) {
      if (p === searchedPath || p.startsWith(searchedPath + '/') || p.endsWith('/' + searchedPath) || searchedPath.endsWith('/' + p)) {
        this.warnedPaths.add(p);
        return {
          type: 'redundant_read_after_search',
          path: p,
          message: `You called read_file("${args.path}") after search_files/glob already returned results for this path. Trust the search output — re-reading wastes tokens (typically 2-10K per read_file call). If you need specific context, use a more targeted search instead.`
        };
      }
    }
    return null;
  }

  /**
   * Tool result co matches khong? (handle nhieu dang result)
   */
  _hasMatches(result) {
    if (!result) return false;
    // Result wrapped: { role: 'tool', content: '...' }
    let parsed = result;
    if (typeof result?.content === 'string') {
      try { parsed = JSON.parse(result.content); } catch { return false; }
    }
    if (!parsed || parsed.success === false) return false;
    // Common shapes: { matches: [...] }, { files: [...] }, { count: N }
    if (Array.isArray(parsed.matches)) return parsed.matches.length > 0;
    if (Array.isArray(parsed.files)) return parsed.files.length > 0;
    if (Array.isArray(parsed.results)) return parsed.results.length > 0;
    if (typeof parsed.count === 'number') return parsed.count > 0;
    if (typeof parsed.total === 'number') return parsed.total > 0;
    return false;
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

  reset() {
    this.history = [];
    this.searchedPaths.clear();
    this.warnedPaths.clear();
  }
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

function _normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

module.exports = { StuckDetector };
