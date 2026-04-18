#!/usr/bin/env node
/**
 * Spawn Team — Chay nhieu subagent song song voi role khac nhau
 *
 * Dung khi task co nhieu phan doc lap co the lam parallel:
 * - Explore FE + BE + docs cung luc
 * - Review security + performance + logic cung luc
 * - Multi-file refactor voi rieng cho moi file
 *
 * Parent nhan summary tong hop tu tat ca → quyet dinh buoc tiep theo.
 *
 * Lu y chi phi: chay N agent cung luc thi cost x N. Kiem tra budget cap.
 */

const { spawnSubagent } = require('./subagent');
const { getSharedPool } = require('../lib/cost-tracker');

/**
 * @param {{ agents: Array<{description, prompt, subagent_type?}> }} args
 * @param {Object} ctx - same as spawnSubagent context
 */
async function spawnTeam(args, ctx) {
  const { agents } = args;

  if (!Array.isArray(agents) || agents.length === 0) {
    return { success: false, error: 'agents must be non-empty array' };
  }
  if (agents.length > 5) {
    return { success: false, error: `Too many team members (${agents.length}); max 5 parallel` };
  }

  // Budget guard: neu budget da gan cap → khong cho spawn
  if (ctx.budget && ctx.budget.isExceeded()) {
    return { success: false, error: 'Budget exceeded; cannot spawn team' };
  }
  if (ctx.budget && ctx.budget.capUsd !== Infinity) {
    const remaining = ctx.budget.remaining();
    // Rough estimate: each subagent ~$0.05 avg
    if (remaining < agents.length * 0.02) {
      return {
        success: false,
        error: `Budget remaining ($${remaining.toFixed(4)}) too low for ${agents.length} team members. Consider single spawn_subagent or increase --budget.`
      };
    }
  }

  const startTime = Date.now();

  // Shared pool truyen thang vao ctx → tat ca subagent dung CUNG 1 pool
  // Tranh moi subagent tu goi getSharedPool rieng (tuy van cho cung instance)
  const sharedPool = ctx.sharedPool || (ctx.skipSharedPool ? null : getSharedPool(ctx.projectDir));
  const teamCtx = { ...ctx, sharedPool };

  // Chay song song voi Promise.all
  const results = await Promise.allSettled(
    agents.map((a, idx) => spawnSubagent({
      description: a.description || `Agent ${idx + 1}`,
      prompt: a.prompt,
      subagent_type: a.subagent_type || 'general-purpose'
    }, teamCtx))
  );

  const elapsed = Date.now() - startTime;

  const summaries = [];
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const agent = agents[i];
    if (r.status === 'fulfilled' && r.value.success) {
      summaries.push({
        agent: agent.description,
        subagent_type: agent.subagent_type || 'general-purpose',
        summary: r.value.summary,
        iterations: r.value.iterations,
        files_changed: r.value.files_changed
      });
    } else {
      const err = r.status === 'rejected' ? r.reason?.message : r.value?.error;
      failures.push({
        agent: agent.description,
        error: String(err || 'unknown'),
        subagent_type: agent.subagent_type
      });
    }
  }

  return {
    success: failures.length === 0,
    team_size: agents.length,
    completed: summaries.length,
    failed: failures.length,
    summaries,
    failures,
    elapsed_ms: elapsed,
    ...(sharedPool ? { pool_status: sharedPool.getPoolStatus() } : {})
  };
}

module.exports = { spawnTeam };
