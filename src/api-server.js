#!/usr/bin/env node
/**
 * Orchestrator REST API — Hermes goi day de thuc thi tasks
 *
 * KIEN TRUC:
 *   Hermes (Brain) → REST API → Orchestrator (Hands)
 *   Hermes quyet dinh LAM GI (memory, learning, self-improve)
 *   Orchestrator quyet dinh LAM NHU THE NAO (routing, planning, execution)
 *
 * ENDPOINTS:
 *   POST /api/run          — Full flow: scan → plan → review → execute
 *   POST /api/scan         — Chi quet project, tra ve context
 *   POST /api/plan         — Xay dung plan tu scan results
 *   POST /api/execute      — Execute plan da review
 *   GET  /api/budget       — Trang thai budget hien tai
 *   GET  /api/stats        — Thong ke tong hop
 *   GET  /api/models       — Danh sach models + pricing
 *   GET  /health           — Health check
 *
 * PORT: 5003 (dai 5000 — ai-orchestrator)
 */

const http = require('http');
const { OrchestratorAgent, AGENT_ROLE_MAP } = require('../router/orchestrator-agent');
const { OrchestratorV3 } = require('../lib/orchestrator-v3');
const { SmartRouter, MODEL_PROFILES } = require('../router/smart-router');

const PORT = process.env.PORT || 5003;
const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:5002';
const LITELLM_KEY = process.env.LITELLM_KEY || 'sk-master-change-me';
const DAILY_BUDGET = parseFloat(process.env.DAILY_BUDGET || '2.00');

// Orchestrator instance (singleton — giu state budget, history)
const orchestrator = new OrchestratorV3({
  litellmUrl: LITELLM_URL,
  litellmKey: LITELLM_KEY,
  dailyBudget: DAILY_BUDGET,
  useTools: true
});

const server = http.createServer(async (req, res) => {
  // CORS — cho phep Hermes va WebUI goi
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // === Health check ===
  if (url.pathname === '/health') {
    return json(res, {
      status: 'ok',
      version: '2.1',
      budget: orchestrator.getBudgetStatus(),
      uptime: process.uptime()
    });
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
  }

  // === POST endpoints ===
  if (req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return error(res, 400, 'Invalid JSON body');
    }

    // POST /api/run — Full flow: scan → plan → review → execute
    if (url.pathname === '/api/run') {
      if (!body.prompt) return error(res, 400, 'Missing "prompt" field');

      try {
        const result = await orchestrator.run(body.prompt, {
          files: body.files || [],
          project: body.project || '',
          task: body.task || 'build',
          feature: body.feature || null,
          contextData: body.context || ''
        });
        return json(res, {
          success: result.status !== 'rejected',
          summary: result.summary || result.reason,
          plan: result.plan?.analysis,
          subtasks: result.plan?.subtasks?.length || 0,
          escalations: result.escalations?.length || 0,
          models_used: result.models_used || [],
          elapsed_ms: result.elapsed_ms,
          budget: orchestrator.getBudgetStatus()
        });
      } catch (err) {
        return error(res, 500, err.message);
      }
    }

    // POST /api/scan — Chi quet project
    if (url.pathname === '/api/scan') {
      if (!body.prompt) return error(res, 400, 'Missing "prompt" field');

      try {
        const scanResults = await orchestrator.scan(body.prompt, {
          files: body.files || [],
          project: body.project || '',
          contextData: body.context || ''
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
      if (!body.prompt) return error(res, 400, 'Missing "prompt" field');

      try {
        const plan = await orchestrator.plan(body.prompt, {
          files: body.files || [],
          project: body.project || '',
          task: body.task || 'build',
          scanResults: body.scanResults || null,
          contextData: body.context || ''
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
          project: body.project || '',
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
    if (url.pathname === '/api/route') {
      const router = new SmartRouter({ costOptimize: true });
      const result = router.route({
        task: body.task || '',
        files: body.files || [],
        prompt: body.prompt || '',
        project: body.project || '',
        contextSize: body.contextSize || 0
      });
      return json(res, result);
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
      'POST /api/route': 'Smart router: chon model',
      'GET /api/budget': 'Trang thai budget',
      'GET /api/stats': 'Thong ke',
      'GET /api/models': 'Danh sach models',
      'GET /health': 'Health check'
    }
  }));
});

// === Helpers ===
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function error(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

server.listen(PORT, () => {
  console.log(`\n  Orchestrator API v2.1`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  LiteLLM: ${LITELLM_URL}`);
  console.log(`  Budget: $${DAILY_BUDGET}/day`);
  console.log(`  Models: ${Object.keys(MODEL_PROFILES).join(', ')}`);
  console.log('');
});
