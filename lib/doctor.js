#!/usr/bin/env node
/**
 * Doctor — Health check cho orcai environment
 *
 * Kiem tra: Node, Git, LiteLLM, MCP, hooks, CLAUDE.md, optional deps,
 * sensitive files, shadow git.
 *
 * Output: list check voi icon pass/fail + hint sua.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');

async function runDoctor({ projectDir, litellmUrl, litellmKey, mcpRegistry, hookRunner }) {
  const results = [];
  const add = (name, ok, info) => results.push({ name, ok, info: info || null });

  // Node version
  add('Node.js', true, process.version);

  // Git
  try {
    const v = execSync('git --version', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', timeout: 3000 }).trim();
    add('Git', true, v);
  } catch {
    add('Git', false, 'not found in PATH');
  }

  // Git repo
  const isGitRepo = fs.existsSync(path.join(projectDir, '.git'));
  add('Git repo', isGitRepo, isGitRepo ? null : 'project not in git — shadow-git + worktree unavailable');

  // LiteLLM connectivity
  if (litellmUrl) {
    try {
      const resp = await fetch(`${litellmUrl}/health`, {
        headers: litellmKey ? { 'Authorization': `Bearer ${litellmKey}` } : {},
        signal: AbortSignal.timeout(5000)
      });
      add('LiteLLM', resp.ok, `${litellmUrl} (HTTP ${resp.status})`);
    } catch (e) {
      add('LiteLLM', false, `${litellmUrl} — ${e.message}`);
    }
  }

  // package.json
  const pkgPath = path.join(projectDir, 'package.json');
  add('package.json', fs.existsSync(pkgPath));

  // CLAUDE.md
  const claudePath = path.join(projectDir, 'CLAUDE.md');
  add('CLAUDE.md', fs.existsSync(claudePath), fs.existsSync(claudePath) ? null : 'run /init to generate');

  // .orcai/
  const orcaiDir = path.join(projectDir, '.orcai');
  add('.orcai/ state dir', fs.existsSync(orcaiDir), fs.existsSync(orcaiDir) ? null : 'will be created on first run');

  // MCP servers
  if (mcpRegistry) {
    const stats = mcpRegistry.getStats();
    if (stats.errors?.length > 0) {
      add('MCP servers', false, `${stats.errors.length} errors: ${stats.errors.map(e => e.server || e.path).join(', ')}`);
    } else if (stats.servers > 0) {
      add('MCP servers', true, `${stats.servers} connected, ${stats.tools} tools — ${stats.serverList.join(', ')}`);
    } else {
      add('MCP servers', true, 'none configured (add .mcp.json if desired)');
    }
  }

  // Hooks
  if (hookRunner) {
    const stats = hookRunner.getStats();
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    const breakdown = Object.entries(stats).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(', ');
    add('Hooks', true, total > 0 ? `${total} configured (${breakdown})` : 'none configured');
  }

  // Optional deps
  try {
    require('gpt-tokenizer');
    add('tiktoken (gpt-tokenizer)', true, 'accurate token counting');
  } catch {
    add('tiktoken', false, 'optional — `npm install gpt-tokenizer` for accurate counts');
  }

  try {
    require('diff');
    add('diff (colored diff)', true);
  } catch {
    add('diff', false, 'optional — `npm install diff` for better diff UI');
  }

  // Sensitive files in project root
  try {
    const rootEntries = fs.readdirSync(projectDir);
    const sensitive = rootEntries.filter(f =>
      /^\.env(\.|$)/i.test(f) || /\.(key|pem|pfx|p12)$/i.test(f)
    );
    if (sensitive.length > 0) {
      // Check gitignore
      let gitignored = 0;
      try {
        const gi = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
        for (const f of sensitive) {
          if (gi.includes(f) || gi.includes('.env')) gitignored++;
        }
      } catch {}
      if (gitignored < sensitive.length) {
        add('Sensitive files in .gitignore', false, `${sensitive.length - gitignored} not ignored: ${sensitive.join(', ')}`);
      } else {
        add('Sensitive files', true, `${sensitive.length} found, all .gitignore'd`);
      }
    }
  } catch {}

  // Shadow git log
  const shadowLog = path.join(orcaiDir, 'shadow-git.log');
  if (fs.existsSync(shadowLog)) {
    try {
      const stats = fs.statSync(shadowLog);
      add('Shadow-git log', true, `${Math.round(stats.size / 1024)}KB`);
    } catch {}
  }

  // Disk space (rough)
  try {
    const { statfsSync } = require('fs');
    if (statfsSync) {
      const s = statfsSync(projectDir);
      const freeGb = (s.bfree * s.bsize) / 1e9;
      add('Disk free', freeGb > 1, `${freeGb.toFixed(1)} GB`);
    }
  } catch { /* Windows or older Node */ }

  return results;
}

function formatDoctor(results) {
  const lines = [chalk.bold.cyan('\n  🩺 orcai doctor')];
  lines.push('');
  for (const r of results) {
    const icon = r.ok ? chalk.green('✓') : chalk.yellow('✗');
    const name = chalk.white(r.name.padEnd(30));
    const info = r.info ? chalk.gray(r.info) : '';
    lines.push(`  ${icon} ${name} ${info}`);
  }
  const failed = results.filter(r => !r.ok).length;
  lines.push('');
  if (failed === 0) {
    lines.push(chalk.green('  ✓ All checks passed'));
  } else {
    lines.push(chalk.yellow(`  ${failed} issue(s) — see hints above`));
  }
  return lines.join('\n');
}

module.exports = { runDoctor, formatDoctor };
