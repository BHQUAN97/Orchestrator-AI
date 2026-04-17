#!/usr/bin/env node
/**
 * Orchestrator Client — Delegate task cho full Hermes/Orchestrator pipeline
 *
 * Thay vi orcai tu xu ly qua AgentLoop, co the call Orchestrator API
 * (scan → plan → tech-lead review → route → execute → synthesize) voi
 * nhung task phuc tap.
 *
 * Endpoint: POST {ORCHESTRATOR_URL}/api/run
 * Body: { prompt, project, files?, dry?, task? }
 * Response: { success, trace_id, steps, result, cost_usd }
 *
 * Khi dung:
 * - Task lon multi-step ma muon pipeline kinh nghiem
 * - Muon dung tech-lead review + decision lock tu dong
 * - Muon co full transcript pipeline voi SSE
 *
 * Khi KHONG dung:
 * - Task nho, direct mode nhanh hon
 * - Orchestrator API khong chay → fallback AgentLoop
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 phut

async function delegateToOrchestrator({ prompt, projectDir, projectName, files = [], dry = false, task, orchestratorUrl, onProgress }) {
  const url = orchestratorUrl || process.env.ORCHESTRATOR_URL || 'http://localhost:5003';

  // Health check truoc khi goi
  try {
    const h = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (!h.ok) throw new Error(`Health check: HTTP ${h.status}`);
  } catch (e) {
    return {
      success: false,
      error: `Orchestrator unreachable at ${url}: ${e.message}. Start with "docker compose up -d orchestrator"`
    };
  }

  const body = {
    prompt,
    project: projectName || 'default',
    files,
    dry,
    ...(task ? { task } : {})
  };

  try {
    const resp = await fetch(`${url}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });

    if (!resp.ok) {
      let errText = '';
      try { errText = await resp.text(); } catch {}
      return { success: false, error: `Orchestrator HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const data = await resp.json();

    // Stream progress via SSE if orchestrator provides traceId
    if (data.traceId && onProgress) {
      try { await streamProgress(url, data.traceId, onProgress); } catch { /* non-fatal */ }
    }

    return {
      success: data.success !== false,
      trace_id: data.traceId || data.trace_id,
      steps: data.steps || [],
      result: data.result || data,
      cost_usd: data.cost_usd || null
    };
  } catch (e) {
    if (e.name === 'AbortError') return { success: false, error: `Timeout after ${DEFAULT_TIMEOUT_MS}ms` };
    return { success: false, error: `Orchestrator delegation failed: ${e.message}` };
  }
}

async function streamProgress(baseUrl, traceId, onProgress) {
  const resp = await fetch(`${baseUrl}/api/stream/${traceId}`, {
    headers: { 'Accept': 'text/event-stream' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  if (!resp.ok || !resp.body) return;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (onProgress) onProgress(evt);
        if (evt.type === 'end' || evt.done) return;
      } catch { /* skip */ }
    }
  }
}

async function checkOrchestratorHealth(url) {
  const target = url || process.env.ORCHESTRATOR_URL || 'http://localhost:5003';
  try {
    const resp = await fetch(`${target}/health`, { signal: AbortSignal.timeout(3000) });
    return { ok: resp.ok, status: resp.status, url: target };
  } catch (e) {
    return { ok: false, error: e.message, url: target };
  }
}

module.exports = { delegateToOrchestrator, checkOrchestratorHealth };
