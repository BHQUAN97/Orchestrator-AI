#!/usr/bin/env node
/**
 * Cost Estimate — heuristic uoc tinh chi phi truoc khi run agent
 *
 * Math: dua tren prompt tokens va kinh nghiem average iteration count.
 * Uoc tinh conservative (hi side) de khong suprise user.
 *
 * Assumption:
 * - Agent chay 3-8 iterations trung binh
 * - Moi iteration them ~500-2000 input tokens (tool results)
 * - Output ~800-2000 tokens
 * - Cache hit ~40% trung binh (co warm cache)
 */

const { countTokens } = require('./tiktoken-counter');
const { computeCost, lookupPrices } = require('./budget');

/**
 * Estimate cost cho 1 task
 * @param {Object} args - { systemPrompt, userPrompt, model, expectedIterations? }
 * @returns {{ input_tokens_est, output_tokens_est, cost_est_usd, cost_range_usd }}
 */
function estimatePromptCost({ systemPrompt = '', userPrompt = '', model = 'default', expectedIterations }) {
  const baseInput = countTokens(systemPrompt + '\n' + userPrompt);

  // Heuristic iterations based on prompt complexity
  const promptLower = userPrompt.toLowerCase();
  let iter;
  if (expectedIterations) {
    iter = expectedIterations;
  } else if (/\b(refactor|migrate|build feature|implement|design|architecture)\b/.test(promptLower)) {
    iter = 10; // complex
  } else if (/\b(fix|debug|review|test)\b/.test(promptLower)) {
    iter = 6; // medium
  } else if (/\b(rename|typo|comment|format)\b/.test(promptLower)) {
    iter = 2; // simple
  } else {
    iter = 5; // default
  }

  // Per-iteration avg: tool result ~800 input, llm response ~500 output
  const avgIterInputGrowth = 800;
  const avgIterOutput = 500;

  const cumulativeInput = baseInput * iter + avgIterInputGrowth * iter * (iter - 1) / 2;
  const totalOutput = avgIterOutput * iter;

  // Cache hit assumption: 40% of input tokens hit cache (warm cache)
  const cachedInput = Math.floor(cumulativeInput * 0.4);
  const freshInput = cumulativeInput - cachedInput;

  const cost = computeCost(model, {
    prompt_tokens: freshInput,
    cache_read_input_tokens: cachedInput,
    cache_creation_input_tokens: Math.floor(baseInput), // system cached once
    completion_tokens: totalOutput
  });

  // Range: low (cache hit 60%) → high (no cache)
  const priceLow = computeCost(model, {
    prompt_tokens: Math.floor(cumulativeInput * 0.4),
    cache_read_input_tokens: Math.floor(cumulativeInput * 0.6),
    completion_tokens: totalOutput
  });
  const priceHigh = computeCost(model, {
    prompt_tokens: cumulativeInput,
    completion_tokens: totalOutput
  });

  return {
    iterations_est: iter,
    input_tokens_est: cumulativeInput,
    output_tokens_est: totalOutput,
    cost_est_usd: cost,
    cost_range_usd: [priceLow, priceHigh],
    model,
    price_per_1m: lookupPrices(model)
  };
}

module.exports = { estimatePromptCost };
