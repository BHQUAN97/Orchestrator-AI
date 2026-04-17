#!/usr/bin/env node
/**
 * Diff Approval — Hien thi diff + hoi user truoc khi apply
 *
 * Dung trong interactive mode: agent propose write/edit → show diff → user y/n/all/abort
 *
 * Strategies:
 * - "yes": apply 1 lan
 * - "all": apply + tu dong approve ca session
 * - "no": skip write, agent nhan error, tu quyet tiep
 * - "abort": dung agent
 *
 * Non-TTY hoac autoYes → bypass (return 'yes')
 */

const chalk = require('chalk');
const inquirer = require('inquirer');

let diffLib = null;
try { diffLib = require('diff'); } catch { /* optional */ }

/**
 * Compute line diff
 */
function computeDiff(before, after) {
  if (diffLib) {
    return diffLib.diffLines(before || '', after || '', { newlineIsToken: false });
  }
  // Fallback: naive — show entire before as removed, after as added
  return [
    ...(before ? [{ removed: true, value: before }] : []),
    ...(after ? [{ added: true, value: after }] : [])
  ];
}

/**
 * Render diff with colors, truncate if too long
 */
function renderDiff(before, after, { maxLines = 60, contextLines = 2 } = {}) {
  const parts = computeDiff(before, after);
  const out = [];

  for (const part of parts) {
    let lines = part.value.split('\n');
    // Drop trailing empty from final newline
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    if (part.added) {
      for (const l of lines) out.push(chalk.green('+ ' + l));
    } else if (part.removed) {
      for (const l of lines) out.push(chalk.red('- ' + l));
    } else {
      // Context: show only first/last N lines of long unchanged blocks
      if (lines.length > contextLines * 2 + 2) {
        lines.slice(0, contextLines).forEach(l => out.push(chalk.gray('  ' + l)));
        out.push(chalk.gray(`  ... ${lines.length - contextLines * 2} unchanged lines ...`));
        lines.slice(-contextLines).forEach(l => out.push(chalk.gray('  ' + l)));
      } else {
        lines.forEach(l => out.push(chalk.gray('  ' + l)));
      }
    }
  }

  if (out.length > maxLines) {
    return out.slice(0, maxLines).join('\n') + '\n' + chalk.gray(`  ... +${out.length - maxLines} more diff lines (truncated)`);
  }
  return out.join('\n');
}

/**
 * Count changes cho summary
 */
function countChanges(before, after) {
  const parts = computeDiff(before, after);
  let added = 0, removed = 0;
  for (const p of parts) {
    const count = p.value.split('\n').filter(l => l).length;
    if (p.added) added += count;
    else if (p.removed) removed += count;
  }
  return { added, removed };
}

/**
 * State dung chung giua cac lan goi approval
 */
class ApprovalState {
  constructor(opts = {}) {
    this.autoYes = !!opts.autoYes;
    this.abortRequested = false;
  }
  setAutoYes(v = true) { this.autoYes = v; }
  isAborted() { return this.abortRequested; }
}

/**
 * Hoi user y/n/all/abort
 * @returns {'yes' | 'no' | 'abort'}
 */
async function askApproval(filePath, before, after, state = new ApprovalState()) {
  // Auto-approve paths
  if (state.autoYes) return 'yes';
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'yes'; // non-interactive

  const { added, removed } = countChanges(before, after);
  const isNew = !before;

  console.log('');
  console.log(chalk.bold.cyan(`📝 ${isNew ? 'CREATE' : 'MODIFY'}: ${filePath}`));
  console.log(chalk.gray(`   +${added} / -${removed} lines`));
  console.log('');
  console.log(renderDiff(before, after));
  console.log('');

  let answer;
  try {
    answer = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'Apply change?',
      choices: [
        { name: chalk.green('✓') + ' Yes — apply this change', value: 'yes' },
        { name: chalk.green('✓✓') + ' Auto-approve rest of session', value: 'all' },
        { name: chalk.yellow('✗') + ' No — skip (agent handles)', value: 'no' },
        { name: chalk.red('⛔') + ' Abort — stop the agent', value: 'abort' }
      ],
      default: 'yes'
    }]);
  } catch {
    // Ctrl+C
    state.abortRequested = true;
    return 'abort';
  }

  if (answer.choice === 'all') {
    state.autoYes = true;
    return 'yes';
  }
  if (answer.choice === 'abort') {
    state.abortRequested = true;
    return 'abort';
  }
  return answer.choice; // 'yes' | 'no'
}

module.exports = { renderDiff, computeDiff, countChanges, askApproval, ApprovalState };
