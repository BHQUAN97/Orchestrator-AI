#!/usr/bin/env node
/**
 * Extended Thinking — Anthropic thinking parameter support
 *
 * Khi enable, Claude se dung thinking tokens de "suy nghi" truoc khi output.
 * Chat luong cao hon cho task phuc tap. Gia thinking token = output token.
 *
 * LiteLLM forward `thinking: { type: "enabled", budget_tokens: N }` qua Anthropic.
 *
 * Tu dong enable cho task phuc tap neu:
 * - Model la claude/smart/opus
 * - Prompt co tu khoa phuc tap (refactor, architecture, debug complex, design)
 * - User khong disable explicitly (--no-thinking)
 *
 * Manual enable: --thinking hoac ORCAI_THINKING=1
 * Budget mac dinh 8000 tokens; --thinking-budget=N de chinh.
 */

const { supportsCaching } = require('./prompt-cache');

const COMPLEX_KEYWORDS = [
  'refactor', 'architecture', 'architect', 'design pattern',
  'debug complex', 'fix all', 'migrate', 'port to', 'rewrite',
  'optimize performance', 'security audit', 'analyze deeply',
  'phuc tap', 'thiet ke', 'kien truc', 'toi uu', 'audit'
];

/**
 * Quyet dinh co nen enable thinking cho call nay khong
 */
function shouldEnableThinking(model, userPromptSample, options = {}) {
  // Model must support thinking (Anthropic Claude only); forceEnable can't bypass this
  if (!supportsCaching(model)) return false;

  // Explicit user override (after model compat check)
  if (options.forceEnable === true) return true;
  if (options.forceEnable === false) return false;

  // Auto-enable cho complex tasks
  if (options.autoDetect && userPromptSample) {
    const lower = userPromptSample.toLowerCase();
    for (const kw of COMPLEX_KEYWORDS) {
      if (lower.includes(kw)) return true;
    }
  }

  return false;
}

/**
 * Apply thinking parameter to LiteLLM request body
 * @param {Object} body - request body
 * @param {Object} opts - { model, budget, forceEnable, autoDetect, userPromptSample }
 * @returns {Object} body voi thinking block neu applicable
 */
function applyThinking(body, opts = {}) {
  const enable = shouldEnableThinking(opts.model, opts.userPromptSample, opts);
  if (!enable) return body;

  const budget = Math.max(1024, Math.min(opts.budget || 8000, 32000));
  return {
    ...body,
    thinking: { type: 'enabled', budget_tokens: budget }
  };
}

/**
 * Extract thinking text tu message content blocks (neu Anthropic tra ve)
 */
function extractThinking(message) {
  if (!message?.content) return null;
  if (Array.isArray(message.content)) {
    const thinkingBlocks = message.content
      .filter(b => b.type === 'thinking')
      .map(b => b.thinking || b.text || '')
      .filter(Boolean);
    return thinkingBlocks.length > 0 ? thinkingBlocks.join('\n---\n') : null;
  }
  return null;
}

/**
 * Get plain text from message, handling content arrays with thinking
 */
function getMessageText(message) {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('');
  }
  return '';
}

module.exports = {
  shouldEnableThinking,
  applyThinking,
  extractThinking,
  getMessageText,
  COMPLEX_KEYWORDS
};
