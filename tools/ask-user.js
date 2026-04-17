#!/usr/bin/env node
/**
 * Ask User Question — Tool cho agent hoi user khi ambiguous
 *
 * Giong Claude Code's AskUserQuestion.
 *
 * Dung khi:
 * - 2+ file cung ten — can user xac dinh file nao
 * - Cach tiep can da nghia — option A vs B
 * - Thieu thong tin — user need to provide
 *
 * Trong interactive mode: inquirer prompt user.
 * Trong non-interactive: return {success:false, error:"need clarification"} — agent tu giai thich roi take best guess.
 */

const chalk = require('chalk');
let inquirer;
try { inquirer = require('inquirer'); } catch { inquirer = null; }

/**
 * @param {{ question: string, options?: string[], allow_free_text?: boolean }} args
 * @param {{ interactive?: boolean }} ctx
 */
async function askUserQuestion(args, ctx = {}) {
  const { question, options = [], allow_free_text = false } = args;
  const { interactive = !!(process.stdin.isTTY && process.stdout.isTTY && inquirer) } = ctx;

  if (!question) return { success: false, error: 'Missing question' };

  if (!interactive) {
    return {
      success: false,
      error: 'NOT_INTERACTIVE: Cannot ask user in non-interactive mode. Make best guess based on available context, or call task_complete asking for clarification.'
    };
  }

  console.log('');
  console.log(chalk.cyan.bold('  ❓ Agent needs input:'));
  console.log(chalk.white('  ' + question));

  try {
    let answer;
    if (options.length > 0) {
      const choices = options.map(o => ({ name: o, value: o }));
      if (allow_free_text) choices.push({ name: chalk.gray('[other — type custom answer]'), value: '__other__' });
      const res = await inquirer.prompt([{
        type: 'list',
        name: 'pick',
        message: 'Choose:',
        choices
      }]);
      if (res.pick === '__other__') {
        const free = await inquirer.prompt([{ type: 'input', name: 'text', message: 'Your answer:' }]);
        answer = free.text?.trim() || '';
      } else {
        answer = res.pick;
      }
    } else {
      const res = await inquirer.prompt([{ type: 'input', name: 'text', message: '>' }]);
      answer = res.text?.trim() || '';
    }

    if (!answer) {
      return { success: false, error: 'USER_SKIPPED: User provided empty response.' };
    }
    return { success: true, answer };
  } catch {
    return { success: false, error: 'USER_CANCELLED: User cancelled the question (Ctrl+C).' };
  }
}

module.exports = { askUserQuestion };
