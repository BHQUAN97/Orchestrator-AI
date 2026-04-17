#!/usr/bin/env node
/**
 * Budget Tracker — Theo doi chi phi + dat ceiling moi session
 *
 * Tinh cost dua tren token usage + gia model.
 * Khi vuot budget → block LLM call, force agent ket thuc.
 *
 * Model prices (USD per 1M tokens, updated Apr 2026):
 * - smart (Claude Sonnet 4.x): $3 in, $15 out, $0.30 cached in
 * - default (Kimi K2.5): $1 in, $3 out
 * - cheap (DeepSeek): $0.27 in, $1.10 out
 * - fast (Gemini Flash 2.5): $0.15 in, $0.60 out
 * - opus (Claude Opus 4.x): $15 in, $75 out, $1.50 cached in
 *
 * Cache read = 10% gia input, cache creation = 125% gia input (Anthropic).
 */

const MODEL_PRICES = {
  // alias → prices per 1M tokens
  'smart':    { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'sonnet':   { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'opus':     { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75 },
  'haiku':    { input: 0.80, output: 4.00, cache_read: 0.08, cache_write: 1.00 },
  'default':  { input: 1.00, output: 3.00 },
  'kimi':     { input: 1.00, output: 3.00 },
  'cheap':    { input: 0.27, output: 1.10 },
  'deepseek': { input: 0.27, output: 1.10 },
  'fast':     { input: 0.15, output: 0.60 },
  'gemini':   { input: 0.15, output: 0.60 },
  'flash':    { input: 0.15, output: 0.60 },
  // Fallback
  '_default': { input: 1.00, output: 3.00 }
};

function lookupPrices(model) {
  if (!model) return MODEL_PRICES._default;
  const key = model.toLowerCase();
  if (MODEL_PRICES[key]) return MODEL_PRICES[key];
  // Pattern match
  if (/opus/.test(key)) return MODEL_PRICES.opus;
  if (/sonnet|smart/.test(key)) return MODEL_PRICES.smart;
  if (/haiku/.test(key)) return MODEL_PRICES.haiku;
  if (/kimi/.test(key)) return MODEL_PRICES.kimi;
  if (/deepseek/.test(key)) return MODEL_PRICES.cheap;
  if (/gemini|flash/.test(key)) return MODEL_PRICES.fast;
  if (/claude/.test(key)) return MODEL_PRICES.smart; // safe default
  return MODEL_PRICES._default;
}

/**
 * Tinh cost tu usage object
 * @param {string} model
 * @param {{ prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens }} usage
 * @returns {number} Cost USD
 */
function computeCost(model, usage) {
  if (!usage) return 0;
  const p = lookupPrices(model);

  const promptTokens = (usage.prompt_tokens || 0);
  const cacheCreation = (usage.cache_creation_input_tokens || 0);
  const cacheRead = (usage.cache_read_input_tokens || 0);
  const completion = (usage.completion_tokens || 0);

  const inputCost = promptTokens * p.input / 1_000_000;
  const cacheCreationCost = cacheCreation * (p.cache_write ?? p.input * 1.25) / 1_000_000;
  const cacheReadCost = cacheRead * (p.cache_read ?? p.input * 0.10) / 1_000_000;
  const outputCost = completion * p.output / 1_000_000;

  return inputCost + cacheCreationCost + cacheReadCost + outputCost;
}

/**
 * Budget tracker per session
 */
class BudgetTracker {
  constructor({ capUsd = Infinity, model = 'default' } = {}) {
    this.capUsd = capUsd;
    this.model = model;
    this.spentUsd = 0;
    this.calls = 0;
    this.exceededAt = null;
  }

  /**
   * Goi sau moi LLM call → cap nhat spent
   * Return true neu da vuot cap (caller nen dung)
   */
  record(model, usage) {
    const cost = computeCost(model || this.model, usage);
    this.spentUsd += cost;
    this.calls++;
    if (this.spentUsd >= this.capUsd && !this.exceededAt) {
      this.exceededAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  isExceeded() {
    return this.capUsd !== Infinity && this.spentUsd >= this.capUsd;
  }

  remaining() {
    if (this.capUsd === Infinity) return Infinity;
    return Math.max(0, this.capUsd - this.spentUsd);
  }

  getStats() {
    return {
      spent_usd: Number(this.spentUsd.toFixed(4)),
      cap_usd: this.capUsd === Infinity ? null : this.capUsd,
      remaining_usd: this.capUsd === Infinity ? null : Number(this.remaining().toFixed(4)),
      calls: this.calls,
      exceeded: this.isExceeded(),
      exceeded_at: this.exceededAt
    };
  }
}

module.exports = { BudgetTracker, computeCost, lookupPrices, MODEL_PRICES };
