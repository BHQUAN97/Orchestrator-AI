#!/usr/bin/env node
/**
 * Status Line — compact 1-dong hien thi truoc moi prompt interactive
 *
 * Format:
 *   [model] session-id | ctx 12%/128k | cost $0.003 | 3f/2c | cache 68%
 *
 * Moi phan:
 *   model       → viet tat model alias
 *   ctx X/Y     → tokens dang dung / window size
 *   cost        → budget.spent_usd
 *   Nf/Nc       → N files changed, N commands run
 *   cache X%    → cache hit rate
 */

const chalk = require('chalk');

/**
 * Format status line tu agent state
 * @param {Object} agent - AgentLoop instance
 * @param {Object} opts - { sessionId, projectName }
 * @returns {string}
 */
function renderStatusLine(agent, opts = {}) {
  const { sessionId = '', projectName = '' } = opts;

  const parts = [];

  // Model
  parts.push(chalk.cyan(agent.model || 'default'));

  // Project / session
  if (projectName) parts.push(chalk.gray(projectName));

  // Context usage
  try {
    const usage = agent.tokenManager.getUsage(agent.messages);
    const pct = usage.usage_percent;
    const color = pct >= 80 ? chalk.red : pct >= 60 ? chalk.yellow : chalk.gray;
    parts.push(color(`ctx ${pct}%`));
  } catch {}

  // Cost
  try {
    const stats = agent.getCacheStats();
    if (stats.cost?.spent_usd > 0) {
      const cap = stats.cost.cap_usd;
      const costStr = cap ? `$${stats.cost.spent_usd.toFixed(3)}/$${cap.toFixed(2)}` : `$${stats.cost.spent_usd.toFixed(3)}`;
      const color = stats.cost.exceeded ? chalk.red : chalk.green;
      parts.push(color(costStr));
    }
  } catch {}

  // Files / commands
  try {
    const fc = agent.executor.filesChanged.size;
    const cc = agent.executor.commandsRun.length;
    if (fc > 0 || cc > 0) parts.push(chalk.blue(`${fc}f/${cc}c`));
  } catch {}

  // Cache hit
  try {
    const stats = agent.getCacheStats();
    if (stats.total_input_tokens > 0) {
      parts.push(chalk.magenta(`cache ${stats.cache_hit_rate_pct}%`));
    }
  } catch {}

  if (parts.length === 0) return '';
  return chalk.gray('[') + parts.join(chalk.gray(' | ')) + chalk.gray(']');
}

module.exports = { renderStatusLine };
