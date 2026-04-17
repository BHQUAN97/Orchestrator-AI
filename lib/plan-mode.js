#!/usr/bin/env node
/**
 * Plan Mode — Agent tao plan → user duyet → execute
 *
 * Flow:
 * 1. Parent AgentLoop chay voi role='planner' (read-only)
 * 2. Planner output implementation plan (goi task_complete voi plan chi tiet)
 * 3. Hien plan cho user → inquirer: approve / modify / reject
 * 4. Neu approve → parent AgentLoop tao moi voi role='builder' + plan lam user prompt
 *
 * Uu diem:
 * - User thay plan TRUOC khi agent sua code → tin tuong hon
 * - Planner role read-only → khong the vo tinh sua code
 * - Tach rieng plan ↔ execute phase → de debug
 */

const chalk = require('chalk');
const inquirer = require('inquirer');
const { renderMarkdown } = require('./markdown-render');

/**
 * Chay plan + approval flow
 * @param {AgentLoop} agent - agent instance (se duoc re-configure)
 * @param {Object} opts - { projectDir, systemPromptBuilder, originalPrompt, onExecute }
 * @returns {Promise<{ approved: boolean, plan?: string, modified?: string }>}
 */
async function runPlanFlow(originalPrompt, {
  systemPromptPlanner,
  systemPromptBuilder,
  createPlannerAgent,
  createBuilderAgent,
  autoApprove = false
} = {}) {
  // Phase 1: Planner role
  console.log(chalk.cyan.bold('\n  📋 PLAN MODE — agent will analyze first, no changes yet.\n'));

  const planPrompt = `Please analyze the following task and produce a concise implementation plan.

DO NOT modify any file. DO NOT run commands beyond read-only analysis (search/grep/read).

Output format (via task_complete summary):
1. Understanding: what the task requires (1-2 sentences)
2. Steps: 3-7 numbered action items
3. Files to change: list with 1-line reason each
4. Risks/tradeoffs: 1-2 bullet points
5. Verification: how we'll know it works

Task:
${originalPrompt}`;

  const planner = createPlannerAgent();
  const planResult = await planner.run(systemPromptPlanner, planPrompt);

  const plan = planResult.summary || planner._getLastAssistantText?.() || '(planner returned no plan)';

  console.log(chalk.cyan('\n  ── Plan ──\n'));
  console.log(renderMarkdown(plan));
  console.log(chalk.cyan('\n  ─────────\n'));

  // Phase 2: Approval
  let decision;
  if (autoApprove) {
    decision = 'approve';
  } else {
    try {
      const answer = await inquirer.prompt([{
        type: 'list',
        name: 'choice',
        message: 'Proceed with this plan?',
        choices: [
          { name: chalk.green('✓') + ' Approve — execute this plan', value: 'approve' },
          { name: chalk.yellow('✎') + ' Modify — refine the plan', value: 'modify' },
          { name: chalk.red('✗') + ' Reject — abort', value: 'reject' }
        ],
        default: 'approve'
      }]);
      decision = answer.choice;
    } catch {
      decision = 'reject'; // Ctrl+C
    }
  }

  if (decision === 'reject') {
    return { approved: false, plan };
  }

  let finalPrompt = originalPrompt;
  if (decision === 'modify') {
    try {
      const { feedback } = await inquirer.prompt([{
        type: 'input',
        name: 'feedback',
        message: 'What should the plan change?'
      }]);
      if (feedback?.trim()) {
        finalPrompt = `Original task: ${originalPrompt}\n\nPlan we agreed on (refined via feedback):\n${plan}\n\nUser refinement: ${feedback}`;
      }
    } catch {
      return { approved: false, plan };
    }
  } else {
    finalPrompt = `Task: ${originalPrompt}\n\nAgreed plan:\n${plan}\n\nImplement the plan step by step. Verify via tests after changes.`;
  }

  // Phase 3: Builder execution
  console.log(chalk.green.bold('\n  🔨 EXECUTING PLAN...\n'));
  const builder = createBuilderAgent();
  const execResult = await builder.run(systemPromptBuilder, finalPrompt);

  return {
    approved: true,
    plan,
    executed: true,
    result: execResult,
    plannerStats: {
      iterations: planResult.iterations,
      tool_calls: planResult.tool_calls
    }
  };
}

module.exports = { runPlanFlow };
