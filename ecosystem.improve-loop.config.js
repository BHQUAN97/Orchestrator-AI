// PM2 ecosystem cho improve-loop — chạy unattended qua đêm, clean exit khi đạt target.
'use strict';
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'orcai-improve-loop',
      script: './bin/orcai-improve-loop.js',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: false,
      max_restarts: 3,
      restart_delay: 30_000,
      kill_timeout: 30_000,
      out_file: path.join(__dirname, '.orcai', 'improve-loop', 'pm2.out.log'),
      error_file: path.join(__dirname, '.orcai', 'improve-loop', 'pm2.err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: (() => {
        // Tự load .env nếu có để lấy LITELLM key
        try {
          const envFile = path.join(__dirname, '.env');
          if (require('fs').existsSync(envFile)) {
            const raw = require('fs').readFileSync(envFile, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
              const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
              if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
            }
          }
        } catch {}
        return {
          NODE_ENV: 'production',
          LITELLM_URL: process.env.LITELLM_URL || 'http://localhost:5002',
          LITELLM_KEY: process.env.LITELLM_KEY || process.env.LITELLM_MASTER_KEY || process.env.LITELLM_API_KEY || 'sk-master-change-me',
          ORCAI_EMBED_MODEL: process.env.ORCAI_EMBED_MODEL || 'local-embed',
          ORCAI_LOOP_TARGET: process.env.ORCAI_LOOP_TARGET || '98',
          ORCAI_LOOP_MAX_ITER: process.env.ORCAI_LOOP_MAX_ITER || '20',
          ORCAI_LOOP_MAX_HOURS: process.env.ORCAI_LOOP_MAX_HOURS || '8',
          ORCAI_LOOP_COOLDOWN_MS: process.env.ORCAI_LOOP_COOLDOWN_MS || '90000'
        };
      })()
    }
  ]
};
