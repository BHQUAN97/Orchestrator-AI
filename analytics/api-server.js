#!/usr/bin/env node
/**
 * Analytics API Server — Proxy LiteLLM + track chi phi
 * Chay: node analytics/api-server.js
 *
 * Endpoints:
 *   POST /v1/chat/completions  — Proxy to LiteLLM + log analytics
 *   GET  /analytics             — Dashboard data JSON
 *   GET  /analytics/models      — Per-model stats
 *   GET  /analytics/projects    — Per-project stats
 *   GET  /analytics/sessions    — Per-session stats
 *   GET  /analytics/daily       — Daily trend
 *   GET  /analytics/comparison  — Opus vs multi-model savings
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { CostTracker } = require('./tracker');

const PORT = process.env.ANALYTICS_PORT || 9081;
const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:4001';
const LITELLM_KEY = process.env.LITELLM_KEY || 'sk-master-change-me';

const tracker = new CostTracker();

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const period = url.searchParams.get('period') || '30d';

  // --- Dashboard HTML ---
  if (url.pathname === '/' || url.pathname === '/dashboard') {
    const htmlPath = path.join(__dirname, 'dashboard.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Dashboard HTML not found</h1>');
    }
    return;
  }

  // --- Analytics endpoints ---
  if (url.pathname === '/analytics') {
    json(res, tracker.toJSON());
    return;
  }
  if (url.pathname === '/analytics/models') {
    json(res, tracker.getByModel(period));
    return;
  }
  if (url.pathname === '/analytics/projects') {
    json(res, tracker.getByProject(period));
    return;
  }
  if (url.pathname === '/analytics/sessions') {
    json(res, tracker.getBySession(period));
    return;
  }
  if (url.pathname === '/analytics/commands') {
    json(res, tracker.getByCommand(period));
    return;
  }
  if (url.pathname === '/analytics/daily') {
    const days = parseInt(url.searchParams.get('days') || '30');
    json(res, tracker.getDailyTrend(days));
    return;
  }
  if (url.pathname === '/analytics/monthly') {
    json(res, tracker.getMonthlyTrend(6));
    return;
  }
  if (url.pathname === '/analytics/comparison') {
    json(res, tracker.getCostComparison(period));
    return;
  }
  if (url.pathname === '/analytics/summary') {
    json(res, {
      today: tracker.getSummary('today'),
      week: tracker.getSummary('7d'),
      month: tracker.getSummary('30d'),
    });
    return;
  }

  // --- Proxy to LiteLLM + track ---
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const start = Date.now();
      try {
        const parsed = JSON.parse(body);

        // Extract metadata tu request (project, session, command)
        const metadata = parsed.metadata || {};
        const project = metadata.project || parsed.project || 'unknown';
        const session = metadata.session || parsed.session || 'default';
        const command = metadata.command || parsed.command || '';

        // Forward to LiteLLM
        const response = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${LITELLM_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(parsed),
        });

        const data = await response.json();
        const latency = Date.now() - start;

        // Log analytics — chi tiet input/output/cache/reasoning
        if (data.usage) {
          const u = data.usage;
          const tokens_in = u.prompt_tokens || 0;
          const tokens_out = u.completion_tokens || 0;
          const cached_tokens = u.prompt_tokens_details?.cached_tokens || 0;
          const reasoning_tokens = u.completion_tokens_details?.reasoning_tokens || 0;
          const costs = estimateCostDetailed(parsed.model, u);

          tracker.log({
            model: data.model || parsed.model,
            project,
            session,
            command,
            tokens_in,
            tokens_out,
            cost: u.cost || costs.total,
            cost_in: costs.input,
            cost_out: costs.output,
            latency_ms: latency,
            cached: cached_tokens > 0,
            cached_tokens,
            reasoning_tokens,
            success: !data.error,
          });
        }

        // Return response
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found. Endpoints: /analytics, /v1/chat/completions');
});

// Uoc tinh cost chi tiet: input vs output
function estimateCostDetailed(model, usage) {
  // Gia per 1M tokens
  const prices = {
    'default': { in: 1.0, out: 4.0, cached: 0.10 },   // Kimi K2.5
    'smart':   { in: 3.0, out: 15.0, cached: 0.30 },   // Sonnet
    'fast':    { in: 0.15, out: 0.60, cached: 0.02 },   // Gemini Flash
    'cheap':   { in: 0.27, out: 1.10, cached: 0.03 },   // DeepSeek
    'kimi':    { in: 1.0, out: 4.0, cached: 0.10 },
    'deepseek':{ in: 0.27, out: 1.10, cached: 0.03 },
    'gemini':  { in: 0.15, out: 0.60, cached: 0.02 },
    'sonnet':  { in: 3.0, out: 15.0, cached: 0.30 },
  };
  const p = prices[model] || prices['default'];
  const tokens_in = usage.prompt_tokens || 0;
  const tokens_out = usage.completion_tokens || 0;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  // Input cost: cached tokens re hon, non-cached full price
  const input_cost = ((tokens_in - cached) * p.in + cached * p.cached) / 1000000;
  const output_cost = (tokens_out * p.out) / 1000000;
  return {
    input: Math.round(input_cost * 10000) / 10000,
    output: Math.round(output_cost * 10000) / 10000,
    total: Math.round((input_cost + output_cost) * 10000) / 10000,
  };
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

server.listen(PORT, () => {
  console.log(`Analytics API: http://localhost:${PORT}`);
  console.log(`Dashboard data: http://localhost:${PORT}/analytics`);
  console.log(`Proxy requests: POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  (add {project, session, command} to request body for tracking)`);
});
