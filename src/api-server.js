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
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB — cho phep image upload (4 anh × ~1.5MB base64)
const RATE_MAP_MAX_ENTRIES = parseInt(process.env.RATE_MAP_MAX || '10000');
const rateLimitMap = new Map(); // IP → { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    // Hard cap: neu map vuot nguong → evict 20% entry cu nhat (LRU-ish)
    // Tranh memory blowup khi attacker gui tu hang nghin IP gia
    if (rateLimitMap.size >= RATE_MAP_MAX_ENTRIES) {
      const sorted = [...rateLimitMap.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      const evictCount = Math.ceil(RATE_MAP_MAX_ENTRIES * 0.2);
      for (let i = 0; i < evictCount; i++) rateLimitMap.delete(sorted[i][0]);
    }
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

// === Active runs registry — track running task de cancel + list ===
const activeRuns = new Map();  // traceId → { signal, controller, prompt, startedAt, project }

// === Templates store — file-backed JSON ===
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');
function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8')); } catch { return {}; }
}
function saveTemplates(t) {
  const dir = path.dirname(TEMPLATES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(t, null, 2));
}

// === Slack/webhook notify (optional) ===
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK_URL || '';
async function notifyWebhook(payload) {
  if (!NOTIFY_WEBHOOK) return;
  try {
    await fetch(NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) { console.warn('[Notify] webhook fail:', err.message); }
}

// === Rollback helper — git stash list + apply ===
function listSnapshots(projectDir) {
  try {
    const out = execSync('git stash list --format="%H|%gd|%s|%ci"', { cwd: projectDir, encoding: 'utf8', timeout: 5000 });
    return out.trim().split('\n').filter(Boolean).slice(0, 20).map(line => {
      const [hash, ref, msg, date] = line.split('|');
      return { hash: (hash || '').slice(0, 12), ref, message: msg, date };
    });
  } catch { return []; }
}
function applySnapshot(projectDir, hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Invalid hash format');
  execSync(`git stash apply ${hash}`, { cwd: projectDir, encoding: 'utf8', timeout: 10000 });
  return true;
}

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

    // GET /api/history?limit=20&project=foo — danh sach run gan day
    if (url.pathname === '/api/history') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const project = url.searchParams.get('project') || null;
      return json(res, { runs: orchestrator.getHistory(Math.min(limit, 100), project) });
    }

    // GET /api/runs — danh sach run dang chay (cho cancel + SSE)
    if (url.pathname === '/api/runs') {
      const runs = [];
      for (const [traceId, info] of activeRuns) {
        runs.push({
          traceId,                  // dung cho cancel: DELETE /api/run/:traceId
          tracerId: info.tracerId,  // dung cho SSE: GET /api/stream/:tracerId
          prompt: info.prompt.slice(0, 100),
          project: info.project,
          startedAt: info.startedAt,
          elapsed_ms: Date.now() - info.startedAt
        });
      }
      return json(res, { active: runs, count: runs.length });
    }

    // GET /api/rollback/list — snapshot co the rollback (git stash list)
    if (url.pathname === '/api/rollback/list') {
      const project = url.searchParams.get('project') || '';
      const projectDir = project ? `/projects/${project.replace(/[^a-zA-Z0-9_-]/g, '')}` : '/app';
      return json(res, { project: projectDir, snapshots: listSnapshots(projectDir) });
    }

    // GET /api/templates — danh sach saved prompts
    if (url.pathname === '/api/templates') {
      return json(res, { templates: loadTemplates() });
    }

    // GET /api/stream/:id — Server-Sent Events: live pipeline progress.
    // Accept ca api id (run-...) hoac tracer id (trc-...) — auto resolve.
    // Mobile dung de tracking real-time thay vi cho 1-2 phut.
    // Listener cleanup khi client disconnect HOAC nhan event 'finish'.
    if (url.pathname.startsWith('/api/stream/')) {
      let traceId = url.pathname.split('/api/stream/')[1];
      if (!traceId) return error(res, 400, 'Missing traceId');

      // Resolve api id → tracer id (trc-...)
      const apiInfo = activeRuns.get(traceId);
      if (apiInfo?.tracerId) traceId = apiInfo.tracerId;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'  // Tat nginx buffering cho SSE
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', traceId })}\n\n`);

      const handler = (event) => {
        if (event.traceId !== traceId) return;
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
        if (event.type === 'finish') {
          orchestrator.tracer.off('trace:event', handler);
          try { res.end(); } catch {}
        }
      };
      orchestrator.tracer.on('trace:event', handler);

      // Heartbeat moi 15s — giu ket noi alive qua proxy/CF
      const ping = setInterval(() => {
        try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { clearInterval(ping); }
      }, 15000);

      req.on('close', () => {
        orchestrator.tracer.off('trace:event', handler);
        clearInterval(ping);
      });
      return; // KHONG kept request open — SSE handles itself
    }
  }

  // === DELETE endpoints ===
  if (req.method === 'DELETE') {
    // DELETE /api/run/:traceId — cancel running task
    if (url.pathname.startsWith('/api/run/')) {
      const traceId = url.pathname.split('/api/run/')[1];
      const info = activeRuns.get(traceId);
      if (!info) return error(res, 404, `Run "${traceId}" not active`);
      info.controller.abort();
      activeRuns.delete(traceId);
      return json(res, { cancelled: true, traceId });
    }
    // DELETE /api/templates/:name
    if (url.pathname.startsWith('/api/templates/')) {
      const name = decodeURIComponent(url.pathname.split('/api/templates/')[1] || '');
      const t = loadTemplates();
      if (!t[name]) return error(res, 404, `Template "${name}" not found`);
      delete t[name];
      saveTemplates(t);
      return json(res, { deleted: name });
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
    // Options moi:
    //   body.dry = true → dry-run: return plan + estimate, KHONG execute
    //   body.project = '<name>' → tag run de filter qua /api/history
    if (url.pathname === '/api/run') {
      if (!body.prompt || typeof body.prompt !== 'string') {
        return error(res, 400, 'Missing or invalid "prompt" field (must be string)');
      }
      // Gioi han do dai prompt
      if (body.prompt.length > 50000) {
        return error(res, 400, 'Prompt too long (max 50000 chars)');
      }

      // Tao AbortController de support cancel qua DELETE /api/run/:traceId
      const controller = new AbortController();
      const traceId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const project = String(body.project || '').slice(0, 500);
      const info = {
        controller, signal: controller.signal,
        prompt: body.prompt, project, startedAt: Date.now(),
        tracerId: null  // Capture qua listener khi tracer start
      };
      activeRuns.set(traceId, info);

      // Capture tracer's id (trc-...) khi run() khoi dong tracer.
      // Single-thread Node + listener attach truoc await → no race.
      // SSE endpoint accept both formats: api id (run-...) → resolve sang trc-...
      const startListener = (event) => {
        if (event.type === 'start' && !info.tracerId) {
          info.tracerId = event.traceId;
          orchestrator.tracer.off('trace:event', startListener);
        }
      };
      orchestrator.tracer.on('trace:event', startListener);

      try {
        const result = await orchestrator.run(body.prompt, {
          files: sanitizeFileList(body.files),
          project,
          task: body.task || 'build',
          feature: body.feature || null,
          contextData: String(body.context || '').slice(0, 20000),
          dryRun: body.dry === true,
          signal: controller.signal
        });
        activeRuns.delete(traceId);

        // Notify webhook khi xong (Slack/Discord/custom)
        notifyWebhook({
          event: 'run_complete',
          traceId,
          project,
          success: result.success !== false && result.status !== 'error',
          status: result.status || 'done',
          elapsed_ms: result.elapsed_ms,
          summary: (result.summary || '').slice(0, 200)
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

        // Dry-run response: tra plan + estimate, KHONG execute
        if (result.status === 'dry_run') {
          return json(res, {
            dry_run: true,
            plan: result.plan,
            estimate: result.estimate,
            message: result.message,
            trace: result.trace ? {
              traceId: result.trace.traceId,
              timeline: result.trace.timeline
            } : null
          });
        }

        return json(res, {
          success: result.status !== 'rejected',
          traceId,
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
        activeRuns.delete(traceId);
        if (err.code === 'ABORT') return error(res, 499, 'Run cancelled by user');
        return error(res, 500, err.message);
      }
    }

    // POST /api/estimate — uoc tinh re truoc khi run.
    // ?accurate=1 → goi plan() that (5-10s, ton smart model). Default heuristic
    // (200-500ms, chi SLM classify) — nhanh hon 18-20×.
    if (url.pathname === '/api/estimate') {
      if (!body.prompt) return error(res, 400, 'Missing "prompt"');
      const accurate = url.searchParams.get('accurate') === '1' || body.accurate === true;
      try {
        if (accurate) {
          const plan = await orchestrator.plan(body.prompt, {
            files: sanitizeFileList(body.files),
            project: String(body.project || '').slice(0, 500),
            task: body.task || 'build'
          });
          return json(res, {
            estimate: orchestrator._estimatePlanCost(plan),
            plan_summary: plan.analysis,
            subtasks: plan.subtasks?.length || 0,
            method: 'plan',
            budget_remaining: orchestrator.getBudgetStatus().remaining
          });
        }
        // Default: cheap heuristic
        const est = await orchestrator.cheapEstimate(body.prompt, {
          files: sanitizeFileList(body.files),
          project: String(body.project || '').slice(0, 500),
          task: body.task || 'build'
        });
        return json(res, {
          estimate: est,
          subtasks: est.subtasks,
          classification: est.classification,
          budget_remaining: orchestrator.getBudgetStatus().remaining
        });
      } catch (err) {
        return error(res, 500, err.message);
      }
    }

    // POST /api/rollback — apply git stash snapshot
    if (url.pathname === '/api/rollback') {
      const project = String(body.project || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const projectDir = project ? `/projects/${project}` : '/app';
      const snapshots = listSnapshots(projectDir);
      if (snapshots.length === 0) return error(res, 404, `No snapshots in ${projectDir}`);
      const hash = body.hash || snapshots[0].hash;
      try {
        applySnapshot(projectDir, hash);
        notifyWebhook({ event: 'rollback', project, hash });
        return json(res, { rolled_back: true, hash, project: projectDir });
      } catch (err) {
        return error(res, 500, `Rollback failed: ${err.message}`);
      }
    }

    // POST /api/vision — direct vision LLM call (KHONG pipeline scan/plan/execute)
    // Body: { prompt, images: ['data:image/...;base64,...' or URL], model? }
    // Validate: max 4 images, max 5MB per image (base64-decoded). Auto-route fast model.
    if (url.pathname === '/api/vision') {
      if (!body.prompt && !body.images?.length) {
        return error(res, 400, 'Need at least "prompt" or "images"');
      }
      const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
      const MAX_BYTES = 5 * 1024 * 1024; // 5MB per image
      for (const [i, img] of images.entries()) {
        if (typeof img !== 'string') return error(res, 400, `Image ${i}: must be string (data URL or http URL)`);
        // Validate data URL format
        if (img.startsWith('data:')) {
          const m = img.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/i);
          if (!m) return error(res, 400, `Image ${i}: invalid data URL format (need jpeg/png/webp/gif base64)`);
          // Approx decoded size = base64.length * 3/4
          const decodedSize = Math.floor(m[2].length * 3 / 4);
          if (decodedSize > MAX_BYTES) return error(res, 413, `Image ${i}: ${Math.round(decodedSize/1024)}KB exceeds 5MB limit`);
        } else if (!img.startsWith('http://') && !img.startsWith('https://')) {
          return error(res, 400, `Image ${i}: must be data URL or http(s) URL`);
        }
      }

      const visionPrompt = body.prompt || 'Phan tich anh nay chi tiet.';
      const visionModel = body.model || 'fast';
      const systemPrompt = `Ban la chuyen gia phan tich hinh anh. Tra loi ngan gon, chinh xac, tieng Viet.
Neu user dua screenshot UI/code: chi ra van de + de xuat fix cu the.
Neu diagram/architecture: giai thich + danh gia.
Neu loi/error: chan doan + cach sua.`;

      try {
        const start = Date.now();
        const result = await orchestrator.callVisionModel(visionModel, systemPrompt, visionPrompt, images);
        return json(res, {
          success: true,
          analysis: result.text,
          model: result.model,
          tokens: result.usage?.tokens || 0,
          images_count: images.length,
          elapsed_ms: Date.now() - start,
          budget: orchestrator.getBudgetStatus()
        });
      } catch (err) {
        return error(res, 500, `Vision call failed: ${err.message}`);
      }
    }

    // POST /api/vision-run — combo: vision analyze + full pipeline run.
    // Step 1: callVisionModel → text analysis. Step 2: orchestrator.run() voi
    // enriched prompt = user_prompt + "[Phan tich anh]: " + analysis.
    // Use case: "fix bug trong screenshot" → vision mota bug → pipeline tu sua.
    if (url.pathname === '/api/vision-run') {
      if (!body.prompt) return error(res, 400, 'Missing "prompt"');
      if (!Array.isArray(body.images) || !body.images.length) {
        return error(res, 400, 'Missing "images" array (use /api/run neu khong co anh)');
      }
      const images = body.images.slice(0, 4);
      const MAX_BYTES = 5 * 1024 * 1024;
      for (const [i, img] of images.entries()) {
        if (typeof img !== 'string') return error(res, 400, `Image ${i}: must be string`);
        if (img.startsWith('data:')) {
          const m = img.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/i);
          if (!m) return error(res, 400, `Image ${i}: invalid data URL format`);
          if (Math.floor(m[2].length * 3 / 4) > MAX_BYTES) return error(res, 413, `Image ${i}: exceeds 5MB`);
        } else if (!/^https?:\/\//.test(img)) {
          return error(res, 400, `Image ${i}: must be data URL or http(s) URL`);
        }
      }

      // Setup active run + cancel support (giong /api/run)
      const controller = new AbortController();
      const traceId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const project = String(body.project || '').slice(0, 500);
      const info = {
        controller, signal: controller.signal,
        prompt: body.prompt, project, startedAt: Date.now(), tracerId: null
      };
      activeRuns.set(traceId, info);
      const startListener = (event) => {
        if (event.type === 'start' && !info.tracerId) {
          info.tracerId = event.traceId;
          orchestrator.tracer.off('trace:event', startListener);
        }
      };
      orchestrator.tracer.on('trace:event', startListener);

      try {
        // Step 1: Vision analyze
        const visionStart = Date.now();
        const visionPrompt = `Mo ta CHI TIET noi dung anh nay (UI elements, code, error message, layout...). Tieng Viet, ngan gon nhung day du.`;
        const visionResult = await orchestrator.callVisionModel('fast', visionPrompt, body.prompt, images);
        const visionElapsed = Date.now() - visionStart;

        // Step 2: Build enriched prompt + run pipeline
        const enrichedPrompt = `${body.prompt}

[PHAN TICH ANH DINH KEM (${images.length} anh, model ${visionResult.model})]:
${visionResult.text}`;

        const runResult = await orchestrator.run(enrichedPrompt, {
          files: sanitizeFileList(body.files),
          project,
          task: body.task || 'fix',
          feature: body.feature || null,
          dryRun: body.dry === true,
          signal: controller.signal
        });
        activeRuns.delete(traceId);

        notifyWebhook({
          event: 'vision_run_complete', traceId, project,
          success: runResult.success !== false && runResult.status !== 'error',
          vision_tokens: visionResult.usage?.tokens || 0,
          status: runResult.status || 'done',
          elapsed_ms: runResult.elapsed_ms
        });

        return json(res, {
          success: runResult.success !== false && runResult.status !== 'error',
          traceId,
          dry_run: runResult.status === 'dry_run',
          vision: {
            analysis: visionResult.text,
            model: visionResult.model,
            tokens: visionResult.usage?.tokens || 0,
            elapsed_ms: visionElapsed
          },
          run: {
            summary: runResult.summary || runResult.reason,
            plan: runResult.plan?.analysis,
            subtasks: runResult.plan?.subtasks?.length || 0,
            models_used: runResult.models_used || [],
            elapsed_ms: runResult.elapsed_ms,
            estimate: runResult.estimate || null,
            trace: runResult.trace ? {
              traceId: runResult.trace.traceId,
              timeline: runResult.trace.timeline,
              elapsed_human: runResult.trace.elapsed_human
            } : null
          },
          budget: orchestrator.getBudgetStatus()
        });
      } catch (err) {
        activeRuns.delete(traceId);
        if (err.code === 'ABORT') return error(res, 499, 'Run cancelled');
        return error(res, 500, err.message);
      }
    }

    // POST /api/pr — auto-create GitHub PR from current branch (gh CLI required).
    // Body: { project, title?, body?, base? } — defaults: title from last commit,
    // body from commit messages on branch, base=main.
    if (url.pathname === '/api/pr') {
      const projectName = String(body.project || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!projectName) return error(res, 400, 'Missing "project"');
      const projectDir = `/projects/${projectName}`;
      if (!fs.existsSync(projectDir)) return error(res, 404, `Project not mounted: ${projectDir}`);
      if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
        return error(res, 400, 'GH_TOKEN env not set — cannot create PR. Set in docker-compose env.');
      }

      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, encoding: 'utf8', timeout: 5000 }).trim();
        if (branch === 'main' || branch === 'master') {
          return error(res, 400, `Refusing PR from "${branch}" — switch to feature branch first`);
        }
        const base = body.base || 'main';
        // Auto title from last commit subject neu khong dua
        const title = body.title || execSync('git log -1 --format=%s', { cwd: projectDir, encoding: 'utf8', timeout: 5000 }).trim();
        // Auto body from commit list neu khong dua
        const prBody = body.body || execSync(`git log ${base}..HEAD --format="- %s"`, { cwd: projectDir, encoding: 'utf8', timeout: 5000 }).trim() || 'Auto-PR from orchestrator';

        // Push branch len remote truoc khi PR (gh require remote tracking)
        execSync(`git push -u origin ${branch}`, { cwd: projectDir, encoding: 'utf8', timeout: 30000 });

        // Tao PR — escape title/body qua stdin de tranh shell injection
        const safeTitle = title.replace(/"/g, '\\"').slice(0, 200);
        const ghOut = execSync(`gh pr create --title "${safeTitle}" --body-file - --base ${base}`, {
          cwd: projectDir, encoding: 'utf8', timeout: 30000,
          input: prBody, env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN }
        }).trim();

        const prUrl = (ghOut.match(/https:\/\/github\.com\/[^\s]+/) || [])[0] || ghOut;
        notifyWebhook({ event: 'pr_created', project: projectName, branch, url: prUrl });
        return json(res, { success: true, pr_url: prUrl, branch, base, title });
      } catch (err) {
        const msg = err.stderr?.toString() || err.message;
        return error(res, 500, `gh pr create failed: ${msg.slice(0, 500)}`);
      }
    }

    // POST /api/templates — save a prompt template
    if (url.pathname === '/api/templates') {
      const name = String(body.name || '').trim().slice(0, 100);
      if (!name) return error(res, 400, 'Missing "name"');
      if (!body.prompt) return error(res, 400, 'Missing "prompt"');
      const t = loadTemplates();
      t[name] = {
        prompt: String(body.prompt).slice(0, 50000),
        files: sanitizeFileList(body.files),
        task: body.task || 'build',
        project: String(body.project || '').slice(0, 100),
        created: t[name]?.created || new Date().toISOString(),
        updated: new Date().toISOString()
      };
      saveTemplates(t);
      return json(res, { saved: name, template: t[name] });
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
      // Singleton: tranh tao SmartRouter moi cho moi request (waste GC + classifier cache)
      if (!global._sharedRouter) global._sharedRouter = new SmartRouter({ costOptimize: true });
      const router = global._sharedRouter;
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
