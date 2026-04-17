#!/usr/bin/env node
/**
 * Subagent Tool — Spawn child AgentLoop voi context rieng
 *
 * Tuong tu Task tool cua Claude Code:
 * - Parent agent goi spawn_subagent({ description, prompt, subagent_type })
 * - Child chay AgentLoop moi voi context window rieng
 * - Child chi tra ve summary ngan → parent khong bloat context
 * - Model va role chon theo subagent_type (vd explore → scanner + fast model)
 *
 * Uu diem so voi inline: isolated context, parallel-safe, re hon vi dung model cheap cho explore
 */

const path = require('path');

const SUBAGENT_PROFILES = {
  'general-purpose': {
    role: 'builder',
    model: 'default',
    maxIter: 20,
    systemSuffix: 'Ban la subagent general-purpose, hoan thanh task roi goi task_complete voi summary.'
  },
  'explore': {
    role: 'scanner',
    model: 'fast', // re hon cho explore/read-only
    maxIter: 15,
    systemSuffix: 'Ban la subagent explore — CHI doc/tim file, KHONG ghi. Tra ve summary chi tiet va path cua cac file lien quan.'
  },
  'plan': {
    role: 'planner',
    model: 'smart', // plan can model tot
    maxIter: 10,
    systemSuffix: 'Ban la subagent plan — tao implementation plan chi tiet, KHONG code. Output: plan steps + critical files + tradeoffs.'
  },
  'review': {
    role: 'reviewer',
    model: 'fast',
    maxIter: 15,
    systemSuffix: 'Ban la subagent review — kiem tra code quality, security, logic. KHONG sua code, chi bao cao issues voi severity.'
  },
  'debug': {
    role: 'debugger',
    model: 'smart',
    maxIter: 25,
    systemSuffix: 'Ban la subagent debug — reproduce bug, tim root cause, de xuat fix.'
  }
};

/**
 * Chay subagent
 * @param {{ description: string, prompt: string, subagent_type?: string }} args
 * @param {{ projectDir, litellmUrl, litellmKey, parentDepth?, budget?, hookRunner?, mcpRegistry? }} ctx
 */
async function spawnSubagent(args, ctx) {
  const { description, prompt, subagent_type = 'general-purpose' } = args;
  const { projectDir, litellmUrl, litellmKey, parentDepth = 0, budget, hookRunner, mcpRegistry } = ctx;

  if (!prompt) return { success: false, error: 'Missing prompt' };

  // Chong subagent goi subagent vo han (depth limit)
  if (parentDepth >= 2) {
    return { success: false, error: 'Subagent depth limit reached (max 2 levels)' };
  }

  const profile = SUBAGENT_PROFILES[subagent_type] || SUBAGENT_PROFILES['general-purpose'];

  // Lazy require agent-loop de tranh circular dep
  const { AgentLoop } = require('../lib/agent-loop');

  const projectName = path.basename(projectDir);
  const systemPrompt = `You are a ${subagent_type} subagent spawned by the parent agent.

Task description: ${description || prompt.slice(0, 100)}
Project: ${projectName}
Working directory: ${projectDir}

${profile.systemSuffix}

Rules:
- Focus ONLY on the given task. Do not expand scope.
- Return a concise summary via task_complete (1-3 sentences + key findings).
- Your output is consumed by the parent agent, so be information-dense.
- If you cannot complete the task, still call task_complete with what you learned.`;

  const startTime = Date.now();

  try {
    const child = new AgentLoop({
      litellmUrl,
      litellmKey,
      model: profile.model,
      projectDir,
      agentRole: profile.role,
      maxIterations: profile.maxIter,
      streaming: false, // Subagent khong stream — chi tra ket qua cuoi
      // Inherit parent resources: budget cap, hooks, MCP
      budget: budget || undefined,       // undefined → AgentLoop creates unlimited new tracker
      hookRunner: hookRunner || undefined,
      mcpRegistry: mcpRegistry || null,
      subagentDepth: parentDepth + 1
    });

    // Child moi khi metadata de tracking
    child._subagentDepth = parentDepth + 1;

    const result = await child.run(systemPrompt, prompt);
    const elapsed = Date.now() - startTime;

    // Trich xuat summary ngan — parent agent chi thay nay
    const summary = result.summary || result.final_message || '(subagent returned no summary)';

    return {
      success: !!result.success,
      subagent_type,
      description: description || null,
      summary: typeof summary === 'string' ? summary.slice(0, 5000) : JSON.stringify(summary).slice(0, 5000),
      iterations: result.iterations,
      tool_calls: result.tool_calls,
      files_changed: result.files_changed || [],
      elapsed_ms: elapsed,
      ...(result.aborted ? { aborted: true, reason: result.reason } : {})
    };
  } catch (e) {
    return { success: false, error: `Subagent failed: ${e.message}` };
  }
}

module.exports = { spawnSubagent, SUBAGENT_PROFILES };
