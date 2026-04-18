#!/usr/bin/env node
/**
 * Transcript Logger — Ghi JSONL tat ca event cua agent run
 *
 * File: .orcai/transcripts/{sessionId}.jsonl
 * Format: moi dong la 1 event JSON { ts, type, ... }
 *
 * Event types:
 * - message: LLM response message (role + content preview + tool_calls names)
 * - tool_call: before tool execute (name + args truncated)
 * - tool_result: after tool execute (success, error, preview)
 * - error: agent error
 * - meta: session start/end, iteration counts
 *
 * Debug: user co the cat file de review flow cua agent.
 */

const fs = require('fs');
const path = require('path');

class TranscriptLogger {
  constructor({ projectDir, sessionId, enabled = true }) {
    this.enabled = enabled;
    this.dir = path.join(projectDir, '.orcai', 'transcripts');
    this.file = path.join(this.dir, `${sessionId || 'unknown'}.jsonl`);

    if (!enabled) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      this.enabled = false;
    }
  }

  log(event) {
    if (!this.enabled) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
      fs.appendFileSync(this.file, line + '\n');
    } catch { /* silent */ }
  }

  logMeta(info) { this.log({ type: 'meta', ...info }); }
  logError(error) { this.log({ type: 'error', error: String(error) }); }

  logMessage(message) {
    this.log({
      type: 'message',
      role: message.role,
      content_preview: _previewContent(message.content),
      tool_calls: message.tool_calls?.map(tc => ({
        name: tc.function?.name,
        args_preview: (tc.function?.arguments || '').slice(0, 200)
      }))
    });
  }

  logToolCall(name, args) {
    this.log({
      type: 'tool_call',
      name,
      args: _truncateArgs(args)
    });
  }

  logToolResult(name, result) {
    let parsed = null;
    if (result?.content && typeof result.content === 'string') {
      try { parsed = JSON.parse(result.content); } catch {}
    }
    // Full content length (truoc khi preview truncate) — dung de debug token inflation
    const contentLen = typeof result?.content === 'string' ? result.content.length : 0;
    // Estimate tokens: ~4 chars/token (heuristic — tot de phan biet tool calls dat/re, khong can chinh xac tuyet doi)
    const tokensEstimate = Math.ceil(contentLen / 4);
    this.log({
      type: 'tool_result',
      name,
      success: parsed?.success !== false,
      error: parsed?.error || null,
      content_bytes: contentLen,
      tokens_estimate: tokensEstimate,
      cached: typeof result?.content === 'string' && result.content.startsWith('[cached'),
      preview: _previewContent(result?.content, 300)
    });
  }

  /**
   * Get file path for user reference
   */
  getPath() {
    return this.enabled ? this.file : null;
  }
}

function _previewContent(content, max = 500) {
  if (!content) return null;
  const s = typeof content === 'string' ? content : JSON.stringify(content);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function _truncateArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 300) {
      out[k] = v.slice(0, 300) + '...';
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { TranscriptLogger };
