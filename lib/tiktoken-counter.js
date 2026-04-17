#!/usr/bin/env node
/**
 * Tiktoken Counter — Dem token chinh xac thay vi heuristic chars/4
 *
 * Uu tien: gpt-tokenizer (pure JS, khong native binding, chay duoc tren Windows)
 * Fallback: heuristic dieu chinh theo loai noi dung (code: 3.5, text: 4.2)
 *
 * Model encoding map:
 * - Claude: dung cl100k_base (xap xi) — Claude khong public tokenizer nhung close enough
 * - GPT-4/4o: o200k_base
 * - GPT-3.5/4-turbo: cl100k_base
 */

let encoder = null;
let encoderName = 'heuristic';

try {
  // gpt-tokenizer exports encode/decode for cl100k_base by default
  const gt = require('gpt-tokenizer');
  encoder = gt.encode;
  encoderName = 'cl100k_base';
} catch {
  // Package not installed — gracefully fall back
  encoder = null;
}

/**
 * Dem token cua 1 chuoi
 * @param {string} text
 * @returns {number}
 */
function countTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') text = String(text);

  if (encoder) {
    try {
      return encoder(text).length;
    } catch {
      // Malformed input — fall through to heuristic
    }
  }

  // Heuristic dieu chinh: code ~3.5 chars/tok, plain text ~4.2 chars/tok
  // Detect code-heavy content: nhieu dau { } ; ( ) va newline
  const codeMarkers = (text.match(/[{}();\[\]<>\/\\]/g) || []).length;
  const density = codeMarkers / Math.max(text.length, 1);
  const ratio = density > 0.05 ? 3.5 : 4.0;
  return Math.ceil(text.length / ratio);
}

/**
 * Dem token cua messages array — bao gom role overhead
 */
function countMessagesTokens(messages) {
  if (!messages || !messages.length) return 0;
  let total = 0;
  for (const msg of messages) {
    total += 4; // role + structural overhead
    if (typeof msg.content === 'string') {
      total += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') total += countTokens(block.text || '');
        else if (block.type === 'tool_result') total += countTokens(block.content || '');
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += countTokens(tc.function?.name || '');
        total += countTokens(tc.function?.arguments || '');
      }
    }
    if (msg.name) total += countTokens(msg.name);
    if (msg.tool_call_id) total += countTokens(msg.tool_call_id);
  }
  return total;
}

module.exports = {
  countTokens,
  countMessagesTokens,
  encoderName,
  hasAccurateTokenizer: !!encoder
};
