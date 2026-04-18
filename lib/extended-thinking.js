#!/usr/bin/env node
/**
 * Extended Thinking — Multi-provider reasoning/thinking support
 *
 * Provider coverage:
 * - Anthropic Claude (sonnet/opus/smart): `thinking: { type: enabled, budget_tokens: N }`
 * - Google Gemini 2.5 (fast/gemini/flash): `thinking_config: { thinking_budget: N }` via LiteLLM
 * - DeepSeek-R1 (cheap/deepseek-r1): model emits <think>…</think> natively, no param needed
 * - OpenAI o1/o3 (if ever routed): `reasoning_effort: low|medium|high`
 *
 * LiteLLM proxy forwards these params to native provider APIs.
 *
 * Auto-enable cho task phuc tap neu prompt match COMPLEX_KEYWORDS.
 * Manual: --thinking flag or ORCAI_THINKING=1.
 * Budget default 8000, range [1024, 32000].
 */

const { supportsCaching } = require('./prompt-cache');

const COMPLEX_KEYWORDS = [
  'refactor', 'architecture', 'architect', 'design pattern',
  'debug complex', 'fix all', 'migrate', 'port to', 'rewrite',
  'optimize performance', 'security audit', 'analyze deeply',
  'phuc tap', 'thiet ke', 'kien truc', 'toi uu', 'audit'
];

function isClaude(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  return /claude|sonnet|opus|haiku|anthropic|^smart$/.test(m);
}

function isGemini25(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  return /gemini[\-_]?2\.?5|gemini[\-_]?pro|^fast$|^gemini$|flash[\-_]?2\.?5/.test(m);
}

function isDeepSeekR1(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  // DeepSeek-R1 emits reasoning tokens natively — no param needed, but we mark it
  return /deepseek[\-_]?r1|r1[\-_]?deepseek/.test(m);
}

function isOpenAIReasoning(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  return /^o1|^o3|o1-mini|o3-mini/.test(m);
}

function supportsThinking(model) {
  return isClaude(model) || isGemini25(model) || isDeepSeekR1(model) || isOpenAIReasoning(model);
}

function shouldEnableThinking(model, userPromptSample, options = {}) {
  if (!supportsThinking(model)) return false;
  if (options.forceEnable === true) return true;
  if (options.forceEnable === false) return false;
  if (options.autoDetect && userPromptSample) {
    const lower = userPromptSample.toLowerCase();
    for (const kw of COMPLEX_KEYWORDS) {
      if (lower.includes(kw)) return true;
    }
  }
  return false;
}

function budgetToEffort(budget) {
  if (budget >= 16000) return 'high';
  if (budget >= 4000) return 'medium';
  return 'low';
}

function applyThinking(body, opts = {}) {
  const enable = shouldEnableThinking(opts.model, opts.userPromptSample, opts);
  if (!enable) return body;

  const budget = Math.max(1024, Math.min(opts.budget || 8000, 32000));
  const model = opts.model;

  if (isClaude(model)) {
    return { ...body, thinking: { type: 'enabled', budget_tokens: budget } };
  }

  if (isGemini25(model)) {
    return { ...body, thinking_config: { thinking_budget: budget, include_thoughts: true } };
  }

  if (isOpenAIReasoning(model)) {
    return { ...body, reasoning_effort: budgetToEffort(budget) };
  }

  if (isDeepSeekR1(model)) {
    return body;
  }

  return body;
}

function extractThinking(message) {
  if (!message?.content) return null;
  if (Array.isArray(message.content)) {
    const thinkingBlocks = message.content
      .filter(b => b.type === 'thinking' || b.type === 'reasoning')
      .map(b => b.thinking || b.reasoning || b.text || '')
      .filter(Boolean);
    if (thinkingBlocks.length > 0) return thinkingBlocks.join('\n---\n');
  }
  if (typeof message.content === 'string') {
    const m = message.content.match(/<think>([\s\S]*?)<\/think>/);
    if (m) return m[1].trim();
  }
  if (message.reasoning) return message.reasoning;
  return null;
}

function getMessageText(message) {
  if (!message?.content) return '';
  if (typeof message.content === 'string') {
    return message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
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
  supportsThinking,
  applyThinking,
  extractThinking,
  getMessageText,
  budgetToEffort,
  isClaude,
  isGemini25,
  isDeepSeekR1,
  isOpenAIReasoning,
  COMPLEX_KEYWORDS
};
