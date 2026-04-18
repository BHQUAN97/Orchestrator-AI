#!/usr/bin/env node
'use strict';
/**
 * Test extended-thinking.js multi-provider support
 */

const {
  supportsThinking, shouldEnableThinking, applyThinking,
  extractThinking, getMessageText, budgetToEffort,
  isClaude, isGemini25, isDeepSeekR1, isOpenAIReasoning
} = require('../lib/extended-thinking');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  OK  ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function truthy(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function falsy(v, msg) { if (v) throw new Error(msg || 'expected falsy'); }

console.log('=== Extended Thinking Tests ===\n');

// --- Model detection ---
t('isClaude — matches claude variants', () => {
  truthy(isClaude('claude-sonnet-4-6'));
  truthy(isClaude('smart'));
  truthy(isClaude('opus'));
  truthy(isClaude('anthropic/claude-3-opus'));
  falsy(isClaude('gemini-flash'));
  falsy(isClaude('deepseek-chat'));
});

t('isGemini25 — matches Gemini 2.5 variants', () => {
  truthy(isGemini25('gemini-2.5-pro'));
  truthy(isGemini25('gemini-2.5-flash'));
  truthy(isGemini25('fast'));
  truthy(isGemini25('gemini'));
  falsy(isGemini25('claude-sonnet'));
  falsy(isGemini25('deepseek'));
});

t('isDeepSeekR1 — matches R1 variants', () => {
  truthy(isDeepSeekR1('deepseek-r1'));
  truthy(isDeepSeekR1('deepseek_r1'));
  truthy(isDeepSeekR1('r1-deepseek'));
  falsy(isDeepSeekR1('deepseek-chat'));
  falsy(isDeepSeekR1('claude'));
});

t('isOpenAIReasoning — matches o1/o3', () => {
  truthy(isOpenAIReasoning('o1'));
  truthy(isOpenAIReasoning('o1-mini'));
  truthy(isOpenAIReasoning('o3'));
  truthy(isOpenAIReasoning('o3-mini'));
  falsy(isOpenAIReasoning('gpt-4'));
});

// --- supportsThinking ---
t('supportsThinking covers 4 families', () => {
  truthy(supportsThinking('claude-sonnet-4'));
  truthy(supportsThinking('gemini-2.5-flash'));
  truthy(supportsThinking('deepseek-r1'));
  truthy(supportsThinking('o1'));
  falsy(supportsThinking('gpt-4'));
  falsy(supportsThinking('kimi-k2'));
  falsy(supportsThinking('deepseek-chat'));
});

// --- shouldEnableThinking ---
t('forceEnable=true enables when supported', () => {
  truthy(shouldEnableThinking('claude-sonnet', '', { forceEnable: true }));
  truthy(shouldEnableThinking('gemini-2.5-pro', '', { forceEnable: true }));
  falsy(shouldEnableThinking('gpt-4', '', { forceEnable: true }), 'cannot force on unsupported model');
});

t('forceEnable=false disables even on complex prompt', () => {
  falsy(shouldEnableThinking('claude', 'refactor everything', { forceEnable: false, autoDetect: true }));
});

t('autoDetect triggers on keywords', () => {
  truthy(shouldEnableThinking('claude', 'please refactor this module', { autoDetect: true }));
  truthy(shouldEnableThinking('gemini-2.5', 'toi uu performance', { autoDetect: true }));
  falsy(shouldEnableThinking('claude', 'fix this typo', { autoDetect: true }));
});

// --- applyThinking per provider ---
t('Claude: thinking param with budget_tokens', () => {
  const body = applyThinking({ model: 'claude', messages: [] }, {
    model: 'claude-sonnet', forceEnable: true, budget: 5000
  });
  eq(body.thinking, { type: 'enabled', budget_tokens: 5000 });
});

t('Gemini 2.5: thinking_config with thinking_budget', () => {
  const body = applyThinking({ model: 'fast', messages: [] }, {
    model: 'gemini-2.5-flash', forceEnable: true, budget: 6000
  });
  eq(body.thinking_config, { thinking_budget: 6000, include_thoughts: true });
});

t('OpenAI o1: reasoning_effort string', () => {
  const bHigh = applyThinking({}, { model: 'o1', forceEnable: true, budget: 20000 });
  eq(bHigh.reasoning_effort, 'high');
  const bMed = applyThinking({}, { model: 'o3-mini', forceEnable: true, budget: 5000 });
  eq(bMed.reasoning_effort, 'medium');
  const bLow = applyThinking({}, { model: 'o1-mini', forceEnable: true, budget: 2000 });
  eq(bLow.reasoning_effort, 'low');
});

t('DeepSeek-R1: no body change (native reasoning)', () => {
  const body = applyThinking({ messages: [], temperature: 0.2 }, {
    model: 'deepseek-r1', forceEnable: true, budget: 8000
  });
  falsy(body.thinking);
  falsy(body.thinking_config);
  falsy(body.reasoning_effort);
  eq(body.temperature, 0.2);
});

t('Unsupported model: body unchanged', () => {
  const body = applyThinking({ messages: [] }, {
    model: 'gpt-4', forceEnable: true, budget: 8000
  });
  falsy(body.thinking);
  falsy(body.thinking_config);
});

// --- Budget clamping ---
t('budget clamped to [1024, 32000]', () => {
  const b1 = applyThinking({}, { model: 'claude', forceEnable: true, budget: 500 });
  eq(b1.thinking.budget_tokens, 1024);
  const b2 = applyThinking({}, { model: 'claude', forceEnable: true, budget: 99999 });
  eq(b2.thinking.budget_tokens, 32000);
});

// --- budgetToEffort ---
t('budgetToEffort thresholds', () => {
  eq(budgetToEffort(1500), 'low');
  eq(budgetToEffort(8000), 'medium');
  eq(budgetToEffort(20000), 'high');
});

// --- extractThinking ---
t('extractThinking from DeepSeek-R1 style <think> block', () => {
  const msg = { content: '<think>let me reason here</think>\n\nFinal answer: 42' };
  eq(extractThinking(msg), 'let me reason here');
});

t('extractThinking from Anthropic content blocks', () => {
  const msg = {
    content: [
      { type: 'thinking', thinking: 'analyzing...' },
      { type: 'text', text: 'Result' }
    ]
  };
  eq(extractThinking(msg), 'analyzing...');
});

t('extractThinking from reasoning content blocks (Gemini)', () => {
  const msg = {
    content: [
      { type: 'reasoning', text: 'step 1, step 2' },
      { type: 'text', text: 'Answer' }
    ]
  };
  eq(extractThinking(msg), 'step 1, step 2');
});

// --- getMessageText strips <think> ---
t('getMessageText removes <think>…</think>', () => {
  const msg = { content: '<think>internal</think>Visible answer' };
  eq(getMessageText(msg), 'Visible answer');
});

t('getMessageText concatenates text blocks only', () => {
  const msg = {
    content: [
      { type: 'thinking', text: 'ignored' },
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  };
  eq(getMessageText(msg), 'hello world');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
