#!/usr/bin/env node
/**
 * Orchestrator REST API — Hermes goi day de thuc thi tasks
 *
 * KIEN TRUC:
 *   Hermes (Brain) → REST API → Orchestrator (Hands)
 *   Hermes quyet dinh LAM GI (memory, learning, self-improve)
 *   Orchestrator quyet dinh LAM NHU THE NAO (routing, planning, execution)
 *
 * SECURITY (v2.2):
 *   - Bearer token authentication (API_SECRET env var)
 *   - Request body size limit (1MB)
 *   - Rate limiting (60 req/min per IP)
 *   - CORS restricted to allowed origins
 *   - Graceful shutdown (SIGTERM/SIGINT)
 *
 * ENDPOINTS:
 *   POST /api/run          — Full flow: scan → plan → review → execute
 *   POST /api/scan         — Chi quet project, tra ve context
 *   POST /api/plan         — Xay dung plan tu scan results
 *   POST /api/execute      — Execute plan da review
 *   GET  /api/budget       — Trang thai budget hien tai
 *   GET  /api/stats        — Thong ke tong hop
 *   GET  /api/models       — Danh sach models + pricing
 *   GET  /health           — Health check (khong can auth)
 *
 * PORT: 5003 (dai 5000 — ai-orchestrator)
 */

const http = require('http');
const crypto = require('crypto');
const { OrchestratorAgent, AGENT_ROLE_MAP } = require('../router/orchestrator-agent');
const { OrchestratorV3 } = require('../lib/orchestrator-v3');
const { SmartRouter, MODEL_PROFILES } = require('../router/smart-router');

// === Environment validation ===
const PORT = process.env.PORT || 5003;
const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:5002';
const LITELLM_KEY = process.env.LITELLM_KEY;
const DAILY_BUDGET = parseFloat(process.env.DAILY_BUDGET || '2.00');

// Auth: API_SECRET bat buoc trong production, auto-generate trong dev
const API_SECRET = process.env.API_SECRET || null;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!LITELLM_KEY || LITELLM_KEY === 'sk-master-change-me') {
  console.warn('⚠️  LITELLM_KEY not set or using default. Set a real key in .env');
  if (IS_PRODUCTION) {
    console.error('❌ LITELLM_KEY is required in production. Exiting.');
    process.exit(1);
  }
}

if (!API_SECRET) {
  if (IS_PRODUCTION) {
    console.error('❌ API_SECRET is required in production. Exiting.');
    process.exit(1);
  }
  console.warn('⚠️  API_SECRET not set. API is UNPROTECTED — dev mode only.');
}

// CORS: chi cho phep origins cu the, khong dung wildcard
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5001,http://localhost:5000')
  .split(',').map(s => s.trim());

// === Rate Limiter — sliding window per IP ===
const MAX_REQUESTS_PER_MINUTE = parseInt(process.env.RATE_LIMIT || '60');
const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const rateLimitMap = new Map(); // IP → { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;
  return {
    allowed: entry.count <= MAX_REQUESTS_PER_MINUTE,
    remaining: Math.max(0, MAX_REQUESTS_PER_MINUTE - entry.count),
    resetAt: entry.resetAt
  };
}

// Cleanup rate limit map moi 5 phut — tranh memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// === Auth middleware ===
function authenticate(req) {
  // Khong bat auth neu khong co API_SECRET (dev mode)
  if (!API_SECRET) return true;

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return false;

  const token = authHeader.slice(7);
  // Timing-safe compare de chong timing attack
  // Hash ca 2 truoc khi so sanh — dam bao cung do dai va tranh leak length
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const secretHash = crypto.createHash('sha256').update(API_SECRET).digest();
  return crypto.timingSafeEqual(tokenHash, secretHash);
}

// === Orchestrator instance ===
const orchestrator = new OrchestratorV3({
  litellmUrl: LITELLM_URL,
  litellmKey: LITELLM_KEY || 'sk-master-change-me',
  dailyBudget: DAILY_BUDGET,
  useTools: true
});

// === Request handler ===
const server = http.createServer(async (req, res) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress || 'unknown';

  // CORS — chi cho phep origins trong whitelist
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // === Health check — khong can auth ===
  if (url.pathname === '/health') {
    return json(res, {
      status: 'ok',
      version: '2.2',
      budget: orchestrator.getBudgetStatus(),
      uptime: process.uptime()
    });
  }

  // === Rate limiting ===
  const rateResult = checkRateLimit(clientIp);
  res.setHeader('X-RateLimit-Remaining', rateResult.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(rateResult.resetAt / 1000));

  if (!rateResult.allowed) {
    return error(res, 429, `Rate limit exceeded. Max ${MAX_REQUESTS_PER_MINUTE} requests/minute.`);
  }

  // === Authentication ===
  if (!authenticate(req)) {
    return error(res, 401, 'Unauthorized. Provide valid Bearer token in Authorization header.');
  }

  // === GET endpoints ===
  if (req.method === 'GET') {
    if (url.pathname === '/api/budget') {
      return json(res, orchestrator.getBudgetStatus());
    }

    if (url.pathname === '/api/stats') {
      return json(res, orchestrator.getStats());
    }

    if (url.pathname === '/api/models') {
      return json(res, {
        profiles: MODEL_PROFILES,
        role_map: AGENT_ROLE_MAP,
        daily_budget: DAILY_BUDGET
      });
    }

    if (url.pathname === '/api/roles') {
      return json(res, AGENT_ROLE_MAP);
    }

    // GET /api/traces — danh sach traces gan nhat
    if (url.pathname === '/api/traces') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      return json(res, {
        traces: orchestrator.tracer.getRecent(Math.min(limit, 50)),
        stats: orchestrator.tracer.getStats()
      });
    }

    // GET /api/trace/:id — chi tiet 1 trace
    if (url.pathname.startsWith('/api/trace/')) {
      const traceId = url.pathname.split('/api/trace/')[1];
      if (!traceId) return error(res, 400, 'Missing trace ID');
      const trace = orchestrator.tracer.get(traceId);
      if (!trace) return error(res, 404, `Trace "${traceId}" not found`);
      return json(res, trace);
    }
  }

  // === POST endpoints ===
  if (req.method === 'POST') {
    let body;
    try {
      body = await readBody(req, MAX_BODY_SIZE);
    } catch (err) {
      const code = err.message.includes('too large') ? 413 : 400;
      return error(res, code, err.message);
    }

    // POST /api/run — Full flow: scan → plan → review → execute
    if (url.pathname === '/api/run') {
      if (!body.prompt || typeof body.prompt !== 'string') {
        return error(res, 400, 'Missing or invalid "prompt" field (must be string)');
      }
      // Gioi han do dai prompt
      if (body.prompt.length > 50000) {
        return error(res, 400, 'Prompt too long (max 50000 chars)');
      }

      try {
        const result = await orchestrator.run(body.prompt, {
          files: sanitizeFileList(body.files),
          project: String(body.project || '').slice(0, 500),
          task: body.task || 'build',
          feature: body.feature || null,
          contextData: String(body.context || '').slice(0, 20000)
        });

        // Check neu pipeline fail — tra error co trace
        if (result.status === 'error') {
          return json(res, {
            success: false,
            error: result.user_message || result.message || 'Pipeline failed',
            failed_at: result.failed_at,
            step: result.step,
            model: result.model,
            suggestion: result.suggestion,
            trace: result.trace,
            budget: orchestrator.getBudgetStatus()
          });
        }

        return json(res, {
          success: result.status !== 'rejected',
          summary: result.summary || result.reason,
          plan: result.plan?.analysis,
          subtasks: result.plan?.subtasks?.length || 0,
          escalations: result.escalations?.length || 0,
          models_used: result.models_used || [],
          elapsed_ms: result.elapsed_ms,
          trace: result.trace ? {
            traceId: result.trace.traceId,
            timeline: result.trace.timeline,
            elapsed_human: result.trace.elapsed_human,
            warnings: result.trace.warnings
          } : null,
          budget: orchestrator.getBudgetStatus()
        });
      } catch (err) {
        return error(res, 500, err.message);
      }
    }

    // POST /api/scan — Chi quet project
    if (url.pathname === '/api/scan') {
      if (!body.prompt || typeof body.prompt !== 'string') {
        return error(res, 400, 'Missing or invalid "prompt" field');
      }

      try {
        const scanResults = await orchestrator.scan(body.prompt, {
          files: sanitizeFileList(body.files),
          project: String(body.project || '').slice(0, 500),
          contextData: String(body.context || '').slice(0, 20000)
        });
        return json(res, {
          success: true,
          scan: scanResults,
          budget: orchestrator.getBudgetStatus()
        });
      } catch (err) {
        return error(res, 500, err.message);
      }
    }

    // POST /api/plan — Xay dung plan (co the truyen san scanResults)
    if (url.pathname === '/api/plan') {
      if (!body.prompt || typeof body.prompt !== 'string') {
        return error(res, 400, 'Missing or invalid "prompt" field');
      }

      try {
        const plan = await orchestrator.plan(body.prompt, {
          files: sanitizeFileList(body.files),
          project: String(body.project || '').slice(0, 500),
          task: body.task || 'build',
          scanResults: body.scanResults || null,
          contextData: String(body.context || '').slice(0, 20000)
        });
        return json(res, {
          success: true,
          plan,
          budget: orchestrator.getBudgetStatus()
        });
      } catch (err) {
        return error(res, 500, err.message);
      }
    }

    // POST /api/execute — Execute plan da co
    if (url.pathname === '/api/execute') {
      if (!body.plan) return error(res, 400, 'Missing "plan" field');

      try {
        // Optional: review truoc
        let plan = body.plan;
        if (body.review !== false) {
          const reviewResult = await orchestrator.review(plan, {
            task: body.task || 'build'
          });
          if (reviewResult.action === 'reject') {
            return json(res, {
              success: false,
              rejected: true,
              reason: reviewResult.guidance,
              budget: orchestrator.getBudgetStatus()
            });
          }
          plan = reviewResult.plan || plan;
        }

        const result = await orchestrator.execute(plan, {
          project: String(body.project || '').slice(0, 500),
          feature: body.feature || null
        });
        return json(res, {
          success: true,
          summary: result.summary,
          results: Object.values(result.results).map(r => ({
            id: r.id,
            role: r.agentRole,
            model: r.model,
            success: r.success,
            escalated: r.escalated || false
          })),
          escalations: result.escalations?.length || 0,
          elapsed_ms: result.elapsed_ms,
          budget: orchestrator.getBudgetStatus()
        });
      } catch (err) {
        return error(res, 500, err.message);
      }
    }

    // POST /api/route — Smart router: chon model phu hop
    // Dung SLM classifier neu co, fallback ve heuristic
    if (url.pathname === '/api/route') {
      const router = new SmartRouter({ costOptimize: true });
      const routeParams = {
        task: body.task || '',
        files: sanitizeFileList(body.files),
        prompt: String(body.prompt || '').slice(0, 10000),
        project: String(body.project || '').slice(0, 500),
        contextSize: body.contextSize || 0
      };

      try {
        // Thu SLM routing truoc (AI-based classification)
        const result = await router.slmRoute(routeParams);
        return json(res, result);
      } catch {
        // Fallback ve heuristic neu SLM fail
        const result = router.route(routeParams);
        result.routing_method = 'heuristic_fallback';
        return json(res, result);
      }
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Not found',
    endpoints: {
      'POST /api/run': 'Full flow: scan → plan → review → execute',
      'POST /api/scan': 'Quet project, tra ve context',
      'POST /api/plan': 'Xay dung plan tu scan/prompt',
      'POST /api/execute': 'Execute plan da review',
      'POST /api/route': 'Smart router: chon model (SLM + heuristic)',
      'GET /api/budget': 'Trang thai budget',
      'GET /api/stats': 'Thong ke',
      'GET /api/models': 'Danh sach models',
      'GET /api/traces': 'Danh sach traces gan nhat',
      'GET /api/trace/:id': 'Chi tiet 1 trace (debug pipeline)',
      'GET /health': 'Health check'
    }
  }));
});

// === Helpers ===

/**
 * Doc request body voi gioi han kich thuoc — chong OOM
 */
function readBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large (max ${Math.round(maxSize / 1024)}KB)`));
        return;
      }
      data += chunk;
    });

    req.on('end', () => {
      if (!data.trim()) {
        reject(new Error('Empty request body'));
        return;
      }
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON body')); }
    });

    req.on('error', reject);
  });
}

/**
 * Sanitize file list — chi cho phep relative paths, chan path traversal
 */
function sanitizeFileList(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter(f => typeof f === 'string' && f.length < 500)
    .map(f => f.replace(/\.\.\//g, '').replace(/\.\.\\/g, ''))  // Chan ../
    .slice(0, 50);  // Toi da 50 files
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function error(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

// === Graceful shutdown ===
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Luu budget truoc khi thoat
  try {
    const budget = orchestrator.getBudgetStatus();
    console.log(`💰 Final budget: ${budget.spent} / ${budget.budget}`);
  } catch { /* ignore */ }

  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });

  // Force exit sau 10s neu khong dong duoc
  setTimeout(() => {
    console.error('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// === Start server ===
server.listen(PORT, () => {
  console.log(`\n  Orchestrator API v2.2`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  LiteLLM: ${LITELLM_URL}`);
  console.log(`  Budget: $${DAILY_BUDGET}/day`);
  console.log(`  Auth: ${API_SECRET ? 'ENABLED (Bearer token)' : 'DISABLED (dev mode)'}`);
  console.log(`  Rate limit: ${MAX_REQUESTS_PER_MINUTE} req/min`);
  console.log(`  CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`  Models: ${Object.keys(MODEL_PROFILES).join(', ')}`);
  console.log('');
});
