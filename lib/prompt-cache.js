#!/usr/bin/env node
/**
 * Prompt Cache — Anthropic cache_control injection
 *
 * Anthropic prompt caching giam chi phi 90% cho cached tokens, TTL 5 phut.
 *
 * Strategy:
 * - Mark system prompt as cached (stable across calls)
 * - Mark tools list as cached (stable)
 * - Mark stable history prefix as cached (messages dau)
 * - Max 4 cache_control breakpoints per request (Anthropic limit)
 *
 * LiteLLM proxy Anthropic: cache_control dat tren content blocks, LiteLLM forward.
 * Neu model khong phai Anthropic, LiteLLM se ignore silently.
 *
 * Chi dung khi:
 * - Model la Anthropic (claude-*)
 * - Provider la anthropic/bedrock/vertex
 */

/**
 * Kiem tra model co ho tro caching khong
 */
function supportsCaching(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  // Anthropic native + aliases ma user hay set
  return /claude|sonnet|opus|haiku|anthropic|smart/.test(m);
}

/**
 * Apply cache_control to a message — chuyen content string → content blocks
 * @param {Object} message - OpenAI message
 * @returns {Object} new message with cache_control
 */
function withCacheControl(message) {
  const clone = { ...message };
  if (typeof clone.content === 'string') {
    clone.content = [{
      type: 'text',
      text: clone.content,
      cache_control: { type: 'ephemeral' }
    }];
  } else if (Array.isArray(clone.content) && clone.content.length > 0) {
    // Attach to last text block
    const blocks = [...clone.content];
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'text') {
        blocks[i] = { ...blocks[i], cache_control: { type: 'ephemeral' } };
        break;
      }
    }
    clone.content = blocks;
  }
  return clone;
}

/**
 * Main: apply cache breakpoints to message array
 *
 * Layout (max 4 breakpoints):
 *   [system]     ← breakpoint 1 (stable always)
 *   [original user prompt]  ← breakpoint 2 (stable per session)
 *   ... messages ...
 *   [last user message / tool result]  ← breakpoint 3 (recent prefix)
 *
 * @param {Array} messages
 * @param {Object} opts - { model, enabled }
 * @returns {Array} new messages array (non-mutating)
 */
function applyCacheControl(messages, opts = {}) {
  if (!messages || messages.length === 0) return messages;
  if (opts.enabled === false) return messages;
  if (!supportsCaching(opts.model)) return messages;

  const out = messages.map(m => ({ ...m }));
  let breakpoints = 0;
  const MAX_BREAKPOINTS = 4;

  // Breakpoint 1: system message
  if (out[0]?.role === 'system') {
    out[0] = withCacheControl(out[0]);
    breakpoints++;
  }

  // Breakpoint 2: original user message
  if (breakpoints < MAX_BREAKPOINTS && out[1]?.role === 'user') {
    out[1] = withCacheControl(out[1]);
    breakpoints++;
  }

  // Breakpoint 3-4: slide over older messages — dat breakpoint cach deu
  // de tang cache hit rate khi history tang
  if (out.length > 6 && breakpoints < MAX_BREAKPOINTS) {
    // Breakpoint giua: ~50% history
    const midIdx = Math.floor(out.length / 2);
    if (out[midIdx] && out[midIdx].role !== 'system' && !hasCacheControl(out[midIdx])) {
      out[midIdx] = withCacheControl(out[midIdx]);
      breakpoints++;
    }
  }

  // Breakpoint cuoi: message gan ket thuc (truoc message cuoi)
  if (out.length > 2 && breakpoints < MAX_BREAKPOINTS) {
    const lastStableIdx = out.length - 2;
    if (lastStableIdx > 1 && out[lastStableIdx] && !hasCacheControl(out[lastStableIdx])) {
      out[lastStableIdx] = withCacheControl(out[lastStableIdx]);
      breakpoints++;
    }
  }

  return out;
}

function hasCacheControl(msg) {
  if (!msg.content) return false;
  if (Array.isArray(msg.content)) {
    return msg.content.some(b => b.cache_control);
  }
  return false;
}

/**
 * Apply cache_control to tools — Anthropic caches tool definitions
 * LiteLLM extension: cache_control at top level of last tool
 */
function applyToolsCaching(tools, opts = {}) {
  if (!tools || tools.length === 0) return tools;
  if (opts.enabled === false) return tools;
  if (!supportsCaching(opts.model)) return tools;

  // Mark last tool with cache_control — Anthropic caches entire tools array
  const out = tools.map(t => ({ ...t }));
  const last = out[out.length - 1];
  out[out.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
  return out;
}

/**
 * Extract cache hit/miss stats tu response (neu co usage)
 */
function extractCacheStats(response) {
  const usage = response?.usage || response?.choices?.[0]?.usage;
  if (!usage) return null;
  return {
    prompt_tokens: usage.prompt_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    completion_tokens: usage.completion_tokens
  };
}

module.exports = {
  applyCacheControl,
  applyToolsCaching,
  supportsCaching,
  extractCacheStats
};
