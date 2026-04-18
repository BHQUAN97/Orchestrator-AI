#!/usr/bin/env node
/**
 * Launcher: khởi động improve-loop qua PM2.
 *
 * Usage:
 *   node bin/orcai-loop-start.js          # start
 *   node bin/orcai-loop-start.js --stop   # stop + cleanup
 *   node bin/orcai-loop-start.js --status # show status
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const ECOSYSTEM = path.join(PROJECT_DIR, 'ecosystem.improve-loop.config.js');
const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:5002';
const LMSTUDIO_URL = process.env.LMSTUDIO_URL || 'http://localhost:1234';
const APP_NAME = 'orcai-improve-loop';

function findPm2() {
  const candidates = [
    'pm2',
    'pm2.cmd',
    path.join(process.env.APPDATA || '', 'npm', 'pm2.cmd'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm', 'pm2.cmd')
  ];
  for (const c of candidates) {
    try {
      // On Windows, .cmd needs shell:true
      const useShell = process.platform === 'win32';
      const r = spawnSync(c, ['-V'], { encoding: 'utf8', shell: useShell });
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

function pm2Run(pm2, args, opts = {}) {
  const useShell = process.platform === 'win32';
  return spawnSync(pm2, args, { shell: useShell, ...opts });
}

async function checkUrl(url, timeoutMs = 3000) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    return r.ok || r.status === 401 || r.status === 404; // service up
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const pm2 = findPm2();
  if (!pm2) {
    console.error('[loop-start] pm2 not found. Install: npm install -g pm2');
    process.exit(2);
  }

  if (args.includes('--stop')) {
    console.log('[loop-start] stopping…');
    pm2Run(pm2, ['stop', APP_NAME], { stdio: 'inherit' });
    pm2Run(pm2, ['delete', APP_NAME], { stdio: 'inherit' });
    console.log('[loop-start] stopped.');
    return;
  }

  if (args.includes('--status')) {
    pm2Run(pm2, ['show', APP_NAME], { stdio: 'inherit' });
    return;
  }

  // Preflight
  console.log('[loop-start] preflight checks…');
  const lmOk = await checkUrl(LMSTUDIO_URL + '/v1/models');
  const liteOk = await checkUrl(LITELLM_URL + '/v1/models');
  console.log(`[loop-start]   LM Studio (${LMSTUDIO_URL}): ${lmOk ? 'OK' : 'DOWN'}`);
  console.log(`[loop-start]   LiteLLM   (${LITELLM_URL}): ${liteOk ? 'OK' : 'DOWN'}`);
  if (!lmOk && !liteOk) {
    console.warn('[loop-start] WARNING: neither LM Studio nor LiteLLM reachable — loop will mark bench skipped');
    // Don't block — the loop is resilient to skipped iterations
  }

  // Ensure output dir
  const logDir = path.join(PROJECT_DIR, '.orcai', 'improve-loop');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  // Start via pm2
  const r = pm2Run(pm2, ['start', ECOSYSTEM, '--only', APP_NAME], {
    stdio: 'inherit',
    cwd: PROJECT_DIR
  });
  if (r.status !== 0) {
    console.error('[loop-start] pm2 start failed with status', r.status);
    process.exit(r.status || 1);
  }

  // Save so pm2 resurrects after reboot (best effort)
  pm2Run(pm2, ['save'], { stdio: 'ignore' });

  // Show list
  console.log('\n[loop-start] PM2 process list:\n');
  pm2Run(pm2, ['list'], { stdio: 'inherit' });

  console.log('\n[loop-start] ✓ improve-loop running');
  console.log('[loop-start] Dashboard: http://localhost:8080 → Observability tab');
  console.log('[loop-start] State:     .orcai/improve-loop/state.json');
  console.log('[loop-start] Logs:      pm2 logs ' + APP_NAME);
  console.log('[loop-start] Stop:      node bin/orcai-loop-start.js --stop');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[loop-start] error:', err && (err.stack || err.message));
    process.exit(1);
  });
}

module.exports = { main };
