#!/usr/bin/env node
/**
 * Web Tools — WebFetch + WebSearch cho AI Agent
 *
 * WebFetch: GET URL, strip HTML → plain text, truncate. Dung doc docs, blog, API refs.
 * WebSearch: query → results. Uu tien Brave API (neu co BRAVE_API_KEY), fallback DuckDuckGo HTML.
 *
 * An toan:
 * - Chi cho http/https (chan file://, javascript:, data:)
 * - Timeout 15s
 * - Body truncate 50KB
 * - User-Agent ro rang
 */

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_CONTENT_LEN = 50000;

/**
 * Fetch URL + extract text
 * @param {{ url: string, prompt?: string, max_length?: number }} args
 */
async function webFetch(args = {}) {
  const { url, max_length = MAX_CONTENT_LEN } = args;

  if (!url) return { success: false, error: 'Missing url' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { success: false, error: `Invalid URL: ${url}` };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { success: false, error: `Only http/https allowed, got: ${parsed.protocol}` };
  }

  // Chan localhost/private IP ra ngoai — tranh SSRF trong moi truong chay tren server
  if (process.env.WEBFETCH_BLOCK_PRIVATE !== 'false') {
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.startsWith('127.') || host.startsWith('192.168.') ||
        host.startsWith('10.') || host === '::1' || host.startsWith('169.254.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return { success: false, error: `Blocked private/local host: ${host}. Set WEBFETCH_BLOCK_PRIVATE=false to allow.` };
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'orcai/2.2 (+https://github.com/BHQUAN97/Orchestrator-AI)',
        'Accept': 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status} ${resp.statusText}`, status: resp.status };
    }

    const contentType = resp.headers.get('content-type') || '';
    let body = await resp.text();

    // Convert HTML → plain text
    if (contentType.includes('html')) {
      body = htmlToText(body);
    } else if (contentType.includes('json')) {
      // Pretty-print JSON de de doc
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Keep raw
      }
    }

    const truncated = body.length > max_length;
    if (truncated) body = body.slice(0, max_length) + '\n\n... [truncated]';

    return {
      success: true,
      url: resp.url, // final URL after redirects
      content_type: contentType,
      status: resp.status,
      content: body,
      truncated,
      length: body.length
    };
  } catch (e) {
    if (e.name === 'AbortError') return { success: false, error: `Timeout after ${DEFAULT_TIMEOUT_MS}ms` };
    return { success: false, error: `Fetch failed: ${e.message}` };
  }
}

/**
 * Convert HTML thanh plain text (strip tags, decode entities, collapse whitespace)
 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Preserve some structure by replacing block tags with newlines
    .replace(/<\/(p|div|section|article|h[1-6]|li|br|tr)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Web search
 * @param {{ query: string, max_results?: number }} args
 */
async function webSearch(args = {}) {
  const { query, max_results = 5 } = args;
  if (!query) return { success: false, error: 'Missing query' };

  // Try Brave Search API first (best quality, needs key)
  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(max_results, 20)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        headers: {
          'X-Subscription-Token': braveKey,
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json();
        const results = (data.web?.results || []).slice(0, max_results).map(r => ({
          title: r.title,
          url: r.url,
          description: stripHtml(r.description || '')
        }));
        return { success: true, engine: 'brave', query, results, total: results.length };
      }
    } catch (e) {
      // Fall through to DuckDuckGo
    }
  }

  // Fallback: DuckDuckGo HTML endpoint (no API key, rate-limited)
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; orcai/2.2)',
        'Accept': 'text/html'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    const html = await resp.text();
    const results = parseDuckDuckGoHtml(html).slice(0, max_results);
    return {
      success: results.length > 0,
      engine: 'duckduckgo',
      query,
      results,
      total: results.length,
      ...(results.length === 0 ? { error: 'No results (DuckDuckGo may have rate-limited or changed layout)' } : {})
    };
  } catch (e) {
    return { success: false, error: `Search failed: ${e.message}` };
  }
}

function parseDuckDuckGoHtml(html) {
  const results = [];
  // Pattern: result__a for title+link, result__snippet for description
  const resultBlockRegex = /<div class="result__body"[\s\S]*?(?=<div class="result__body"|<\/div>\s*<\/div>\s*<\/div>\s*$)/g;
  const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

  let block;
  while ((block = resultBlockRegex.exec(html))) {
    const linkMatch = block[0].match(linkRegex);
    const snippetMatch = block[0].match(snippetRegex);
    if (!linkMatch) continue;

    let url = linkMatch[1];
    // DuckDuckGo wraps: //duckduckgo.com/l/?uddg=<encoded>&rut=...
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      try { url = decodeURIComponent(uddgMatch[1]); } catch { /* keep as-is */ }
    }
    // Normalize protocol-relative
    if (url.startsWith('//')) url = 'https:' + url;

    results.push({
      title: stripHtml(linkMatch[2]).trim(),
      url,
      description: snippetMatch ? stripHtml(snippetMatch[1]).trim() : ''
    });
  }
  return results;
}

function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

module.exports = { webFetch, webSearch, htmlToText };
