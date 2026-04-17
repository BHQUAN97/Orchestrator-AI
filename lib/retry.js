#!/usr/bin/env node
/**
 * Retry — Exponential backoff cho LLM fetch
 *
 * Handle:
 * - 429 Too Many Requests (respect Retry-After)
 * - 503 Service Unavailable
 * - 502/504 gateway errors
 * - Network errors (ECONNRESET, ETIMEDOUT)
 *
 * Khong retry:
 * - 4xx (client errors) tru 429
 * - Abort (user ctrl+c)
 */

const DEFAULT_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);

// Singleton state — the nao cung chi 1 CLI chay
const rateLimitState = {
  remaining: null,
  limit: null,
  resetAt: null,        // timestamp ms
  lastError: null,      // { ts, status, retryAfter }
  retryCount: 0         // total retries in session
};

/**
 * Parse rate limit headers from response
 * Supports: OpenAI-style (x-ratelimit-*) + Anthropic-style + LiteLLM
 */
function captureRateLimit(resp) {
  if (!resp?.headers) return;
  const h = resp.headers;
  const remaining = h.get('x-ratelimit-remaining-requests') || h.get('x-ratelimit-remaining');
  const limit = h.get('x-ratelimit-limit-requests') || h.get('x-ratelimit-limit');
  const reset = h.get('x-ratelimit-reset-requests') || h.get('x-ratelimit-reset');

  if (remaining != null) rateLimitState.remaining = parseInt(remaining, 10);
  if (limit != null) rateLimitState.limit = parseInt(limit, 10);
  if (reset != null) {
    const r = parseInt(reset, 10);
    if (!isNaN(r)) {
      // Neu < 1e10 → epoch seconds, else ms. Neu < 3600 → seconds delta
      if (r < 3600) rateLimitState.resetAt = Date.now() + r * 1000;
      else if (r < 1e10) rateLimitState.resetAt = r * 1000;
      else rateLimitState.resetAt = r;
    }
  }
}

function getRateLimitState() {
  return { ...rateLimitState };
}

function resetRateLimitState() {
  rateLimitState.remaining = null;
  rateLimitState.limit = null;
  rateLimitState.resetAt = null;
  rateLimitState.lastError = null;
  rateLimitState.retryCount = 0;
}

/**
 * Wrap fetch call voi retry
 * @param {Function} fetchFn - async function returning Response
 * @param {Object} opts - { retries, onRetry }
 * @returns {Response}
 */
async function fetchWithRetry(fetchFn, opts = {}) {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const onRetry = opts.onRetry; // (attempt, delay, reason) => void

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchFn();
      captureRateLimit(resp);

      // Check retryable status code
      if (RETRYABLE_STATUS.has(resp.status) && attempt < retries) {
        let delay = _computeBackoff(attempt);
        // Respect Retry-After header
        const retryAfter = resp.headers.get('retry-after');
        if (retryAfter) {
          const secs = parseInt(retryAfter, 10);
          if (!isNaN(secs) && secs > 0) delay = Math.max(delay, secs * 1000);
        }
        const reason = `HTTP ${resp.status}`;
        rateLimitState.lastError = { ts: Date.now(), status: resp.status, retryAfter: delay };
        rateLimitState.retryCount++;
        if (onRetry) onRetry(attempt + 1, delay, reason);
        await _sleep(delay);
        continue;
      }

      return resp;
    } catch (e) {
      lastErr = e;
      const code = e.cause?.code || e.code || '';
      const retryable = RETRYABLE_CODES.has(code) || /ECONNRESET|ETIMEDOUT|fetch failed/.test(e.message || '');

      if (!retryable || attempt >= retries) throw e;

      const delay = _computeBackoff(attempt);
      if (onRetry) onRetry(attempt + 1, delay, code || e.message?.slice(0, 60));
      await _sleep(delay);
    }
  }

  throw lastErr || new Error('fetchWithRetry exhausted without response');
}

function _computeBackoff(attempt) {
  // Exponential: 1s, 2s, 4s, 8s, ... with jitter
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { fetchWithRetry, getRateLimitState, resetRateLimitState, captureRateLimit };
