#!/usr/bin/env node
/**
 * Stack Profile — Quet project dir, tong hop "typical stack" cua user
 *
 * Muc dich: Inject vao system prompt khi goi LOCAL model (Qwen 2.5 Coder, etc.)
 * de model hieu conventions cua user (training cutoff ~Sep 2024 thuong gen code cu).
 *
 * Output: structured profile + markdown <2000 tokens, nhe de inject.
 */

const fs = require('fs');
const path = require('path');

// === Helpers ===
function safeRead(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function safeReadJson(p) {
  const raw = safeRead(p);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function existsAny(projectDir, files) {
  return files.some(f => fs.existsSync(path.join(projectDir, f)));
}

function firstExisting(projectDir, files) {
  for (const f of files) {
    const full = path.join(projectDir, f);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// Dirs can skip khi scan
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '__pycache__', 'venv', '.venv', '.turbo', '.cache',
  'coverage', 'out', '.nuxt', '.svelte-kit'
]);

// === Detect 1 project ===
function scanProject(projectDir) {
  const profile = {
    projectDir,
    projectName: path.basename(projectDir),
    languages: [],
    frameworks: [],
    testing: null,
    packageManager: null,
    commitStyle: 'type(scope): desc', // default theo CLAUDE.md global
    nextRouter: null,       // 'app' | 'pages' | null
    tsJs: null,             // 'ts' | 'js' | 'mixed' | null
    ormOrDriver: [],
    lintFormatter: [],
    dockerUse: false,
    pm2Use: false,
    customRules: false,     // co CLAUDE.md/.sdd ko
    hasSdd: false,
    deps: []                // top-level deps (for aggregation)
  };

  const pkg = safeReadJson(path.join(projectDir, 'package.json'));
  const pyProject = safeRead(path.join(projectDir, 'pyproject.toml'));
  const reqTxt = safeRead(path.join(projectDir, 'requirements.txt'));

  // --- Languages ---
  if (pkg) profile.languages.push('javascript');
  if (pyProject || reqTxt || fs.existsSync(path.join(projectDir, 'manage.py'))) {
    profile.languages.push('python');
  }
  if (fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    profile.tsJs = 'ts';
    if (!profile.languages.includes('typescript')) profile.languages.push('typescript');
  } else if (pkg) {
    profile.tsJs = 'js';
  }

  // --- Package manager ---
  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) profile.packageManager = 'pnpm';
  else if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) profile.packageManager = 'yarn';
  else if (fs.existsSync(path.join(projectDir, 'package-lock.json'))) profile.packageManager = 'npm';
  else if (pkg) profile.packageManager = 'npm';

  // --- Frameworks (via deps + configs) ---
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  profile.deps = Object.keys(deps);

  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);

  // Next.js
  if (has('next') || existsAny(projectDir, ['next.config.js', 'next.config.ts', 'next.config.mjs'])) {
    profile.frameworks.push('nextjs');
    // App Router vs Pages Router
    if (fs.existsSync(path.join(projectDir, 'app')) ||
        fs.existsSync(path.join(projectDir, 'src', 'app'))) {
      profile.nextRouter = 'app';
    } else if (fs.existsSync(path.join(projectDir, 'pages')) ||
               fs.existsSync(path.join(projectDir, 'src', 'pages'))) {
      profile.nextRouter = 'pages';
    }
  }
  if (has('react') && !profile.frameworks.includes('nextjs')) profile.frameworks.push('react');
  if (has('vue') || fs.existsSync(path.join(projectDir, 'nuxt.config.ts'))) profile.frameworks.push('vue');
  if (existsAny(projectDir, ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'])) {
    profile.frameworks.push('vite');
  }
  if (has('@nestjs/core') || fs.existsSync(path.join(projectDir, 'nest-cli.json'))) {
    profile.frameworks.push('nestjs');
  }
  if (has('express')) profile.frameworks.push('express');
  if (has('fastify')) profile.frameworks.push('fastify');
  if (has('tailwindcss') || existsAny(projectDir, ['tailwind.config.js', 'tailwind.config.ts'])) {
    profile.frameworks.push('tailwind');
  }

  // Python frameworks
  const pySrc = (pyProject || '') + '\n' + (reqTxt || '');
  if (/django/i.test(pySrc) || fs.existsSync(path.join(projectDir, 'manage.py'))) {
    profile.frameworks.push('django');
  }
  if (/fastapi/i.test(pySrc)) profile.frameworks.push('fastapi');
  if (/flask/i.test(pySrc)) profile.frameworks.push('flask');

  // --- ORM / DB driver ---
  if (has('prisma') || has('@prisma/client') || fs.existsSync(path.join(projectDir, 'prisma', 'schema.prisma'))) {
    profile.ormOrDriver.push('prisma');
  }
  if (has('typeorm')) profile.ormOrDriver.push('typeorm');
  if (has('drizzle-orm')) profile.ormOrDriver.push('drizzle');
  if (has('mongoose')) profile.ormOrDriver.push('mongoose');
  if (has('mysql2') || has('mysql')) profile.ormOrDriver.push('mysql');
  if (has('pg')) profile.ormOrDriver.push('postgres');
  if (has('redis') || has('ioredis')) profile.ormOrDriver.push('redis');
  if (/sqlalchemy/i.test(pySrc)) profile.ormOrDriver.push('sqlalchemy');

  // --- Testing ---
  if (has('jest') || has('ts-jest')) profile.testing = 'jest';
  else if (has('vitest')) profile.testing = 'vitest';
  else if (has('mocha')) profile.testing = 'mocha';
  else if (has('@playwright/test') || has('playwright')) profile.testing = 'playwright';
  else if (/pytest/i.test(pySrc)) profile.testing = 'pytest';
  else if (pkg && pkg.scripts && /\btest\b/.test(pkg.scripts.test || '')) {
    // Fallback: neu ko match dep nhung co script test
    const t = pkg.scripts.test;
    if (/jest/.test(t)) profile.testing = 'jest';
    else if (/vitest/.test(t)) profile.testing = 'vitest';
    else if (/mocha/.test(t)) profile.testing = 'mocha';
    else profile.testing = 'node'; // node --test or custom
  }

  // --- Lint / Formatter ---
  if (existsAny(projectDir, ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs']) || has('eslint')) {
    profile.lintFormatter.push('eslint');
  }
  if (existsAny(projectDir, ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js']) || has('prettier')) {
    profile.lintFormatter.push('prettier');
  }
  if (/\bruff\b/i.test(pySrc)) profile.lintFormatter.push('ruff');
  if (/\bblack\b/i.test(pySrc)) profile.lintFormatter.push('black');

  // --- Docker ---
  if (existsAny(projectDir, ['Dockerfile', 'docker-compose.yaml', 'docker-compose.yml'])) {
    profile.dockerUse = true;
  } else {
    // Check cac variant docker-compose.*.yaml
    try {
      const entries = fs.readdirSync(projectDir);
      if (entries.some(n => /^docker-compose\..*\.(yaml|yml)$/i.test(n) || /^Dockerfile\./i.test(n))) {
        profile.dockerUse = true;
      }
    } catch { /* ignore */ }
  }

  // --- PM2 ---
  if (existsAny(projectDir, ['ecosystem.config.js', 'ecosystem.config.cjs', 'ecosystem.config.json', 'pm2.config.js'])) {
    profile.pm2Use = true;
  } else {
    try {
      const entries = fs.readdirSync(projectDir);
      if (entries.some(n => /^ecosystem\..*\.(js|cjs|json)$/i.test(n))) profile.pm2Use = true;
    } catch { /* ignore */ }
  }

  // --- Custom rules ---
  if (fs.existsSync(path.join(projectDir, 'CLAUDE.md'))) profile.customRules = true;
  if (fs.existsSync(path.join(projectDir, '.sdd'))) profile.hasSdd = true;

  // Dedup
  profile.frameworks = [...new Set(profile.frameworks)];
  profile.languages = [...new Set(profile.languages)];
  profile.ormOrDriver = [...new Set(profile.ormOrDriver)];
  profile.lintFormatter = [...new Set(profile.lintFormatter)];

  return profile;
}

// === Scan root, tra mang profiles ===
function scanProjectsRoot(rootDir) {
  const profiles = [];
  let entries = [];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch { return profiles; }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    if (ent.name.startsWith('.')) continue;

    const full = path.join(rootDir, ent.name);
    const isProject =
      fs.existsSync(path.join(full, '.git')) ||
      fs.existsSync(path.join(full, 'package.json')) ||
      fs.existsSync(path.join(full, 'CLAUDE.md'));

    if (!isProject) continue;
    try {
      profiles.push(scanProject(full));
    } catch (e) {
      // skip loi tren 1 project, khong chet ca batch
    }
  }
  return profiles;
}

// === Aggregate: frequency-based ===
function aggregateProfiles(profiles) {
  const agg = {
    totalProjects: profiles.length,
    languages: {},       // name -> count
    frameworks: {},
    testing: {},
    packageManager: {},
    tsJs: {},
    nextRouter: {},
    ormOrDriver: {},
    lintFormatter: {},
    dockerUse: 0,
    pm2Use: 0,
    customRules: 0,
    commitStyle: 'type(scope): desc',
    majority: {}         // key -> top choice
  };

  const bump = (bucket, key) => {
    if (!key) return;
    bucket[key] = (bucket[key] || 0) + 1;
  };

  for (const p of profiles) {
    p.languages.forEach(l => bump(agg.languages, l));
    p.frameworks.forEach(f => bump(agg.frameworks, f));
    p.ormOrDriver.forEach(o => bump(agg.ormOrDriver, o));
    p.lintFormatter.forEach(l => bump(agg.lintFormatter, l));
    bump(agg.testing, p.testing);
    bump(agg.packageManager, p.packageManager);
    bump(agg.tsJs, p.tsJs);
    bump(agg.nextRouter, p.nextRouter);
    if (p.dockerUse) agg.dockerUse++;
    if (p.pm2Use) agg.pm2Use++;
    if (p.customRules) agg.customRules++;
  }

  // Majority winner helper
  const pickTop = (bucket) => {
    let best = null, bestN = 0;
    for (const [k, v] of Object.entries(bucket)) {
      if (v > bestN) { best = k; bestN = v; }
    }
    return best;
  };

  agg.majority = {
    language: pickTop(agg.languages),
    framework: pickTop(agg.frameworks),
    testing: pickTop(agg.testing),
    packageManager: pickTop(agg.packageManager),
    tsJs: pickTop(agg.tsJs),
    nextRouter: pickTop(agg.nextRouter),
    orm: pickTop(agg.ormOrDriver),
    lintFormatter: pickTop(agg.lintFormatter)
  };

  return agg;
}

// === Markdown formatter, target <2000 tokens (~8000 chars) ===
function formatAsMarkdown(agg) {
  const total = agg.totalProjects || 0;
  const pct = (n) => total ? Math.round((n / total) * 100) : 0;

  const topList = (bucket, limit = 5) => {
    const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]).slice(0, limit);
    if (entries.length === 0) return '(none)';
    return entries.map(([k, v]) => `${k} (${v}/${total})`).join(', ');
  };

  const m = agg.majority || {};
  const lines = [];
  lines.push('# User Stack Profile');
  lines.push('');
  lines.push(`Derived from ${total} project(s). Use these conventions when generating code.`);
  lines.push('');
  lines.push('## Typical Stack (majority)');
  if (m.language) lines.push(`- Primary language: **${m.language}**`);
  if (m.tsJs) lines.push(`- TS vs JS: prefer **${m.tsJs === 'ts' ? 'TypeScript' : 'JavaScript'}** when applicable`);
  if (m.framework) lines.push(`- Main framework: **${m.framework}**`);
  if (m.nextRouter) lines.push(`- Next.js router: **${m.nextRouter === 'app' ? 'App Router' : 'Pages Router'}**`);
  if (m.packageManager) lines.push(`- Package manager: **${m.packageManager}**`);
  if (m.testing) lines.push(`- Test runner: **${m.testing}**`);
  if (m.orm) lines.push(`- ORM/DB: **${m.orm}**`);
  if (m.lintFormatter) lines.push(`- Lint/format: **${m.lintFormatter}**`);
  lines.push('');

  lines.push('## Frequency');
  lines.push(`- Languages: ${topList(agg.languages)}`);
  lines.push(`- Frameworks: ${topList(agg.frameworks, 8)}`);
  lines.push(`- Testing: ${topList(agg.testing)}`);
  lines.push(`- Package mgr: ${topList(agg.packageManager)}`);
  lines.push(`- ORM/drivers: ${topList(agg.ormOrDriver, 6)}`);
  lines.push(`- Lint/format: ${topList(agg.lintFormatter)}`);
  lines.push(`- Docker: ${agg.dockerUse}/${total} (${pct(agg.dockerUse)}%)`);
  lines.push(`- PM2: ${agg.pm2Use}/${total} (${pct(agg.pm2Use)}%)`);
  lines.push(`- Custom CLAUDE.md: ${agg.customRules}/${total}`);
  lines.push('');

  lines.push('## Conventions (inferred + user profile)');
  lines.push('- Commit: `type(scope): desc` (feat/fix/refactor/chore/docs)');
  lines.push('- Comment: business logic in Vietnamese, technical/API in English');
  lines.push('- React: functional components + hooks, no class components');
  if (m.framework === 'nextjs' && m.nextRouter === 'app') {
    lines.push('- Next.js: prefer **App Router** (app/ dir), Server Components by default, `"use client"` when needed');
  } else if (m.framework === 'nextjs' && m.nextRouter === 'pages') {
    lines.push('- Next.js: prefer **Pages Router** (pages/ dir), getServerSideProps/getStaticProps');
  }
  if (m.tsJs === 'ts') lines.push('- TypeScript: strict mode, explicit types on exported APIs');
  if (m.packageManager === 'pnpm') lines.push('- Install: use `pnpm add`, not `npm install`');
  else if (m.packageManager === 'yarn') lines.push('- Install: use `yarn add`');
  if (m.orm === 'prisma') lines.push('- DB: use Prisma client, never raw SQL in business logic');
  else if (m.orm === 'typeorm') lines.push('- DB: TypeORM entities with decorators');
  else if (m.orm === 'drizzle') lines.push('- DB: Drizzle ORM with schema files');
  if (m.testing === 'jest') lines.push('- Test files: `*.test.js` or `*.test.ts`, Jest runner');
  else if (m.testing === 'vitest') lines.push('- Test files: `*.test.ts`, Vitest runner');
  else if (m.testing === 'pytest') lines.push('- Test files: `test_*.py`, pytest runner');
  if (agg.dockerUse > 0) lines.push('- Deploy: Docker + docker-compose for multi-service setups');
  if (agg.pm2Use > 0) lines.push('- Process: PM2 for long-running Node processes');
  lines.push('');

  lines.push('## Rules (from global CLAUDE.md)');
  lines.push('- Do not commit `.env`, `node_modules`, `__pycache__`, `.DS_Store`');
  lines.push('- Function > 20 lines: add purpose comment');
  lines.push('- Error handling: self-recover first; escalate only after 3 attempts');
  lines.push('- Reports: concise, mobile-friendly (1-2 short paragraphs)');
  lines.push('- State: useState/useReducer for local, Context for shared (React)');
  lines.push('');

  lines.push('## Knowledge cutoff note');
  lines.push('Local models may have older training data. Prefer the conventions above over any "modern best practice" from training.');

  const out = lines.join('\n');
  // Cap output to ~8000 chars (~2000 tokens) just in case
  if (out.length > 8000) return out.slice(0, 7980) + '\n...[truncated]';
  return out;
}

module.exports = {
  scanProject,
  scanProjectsRoot,
  aggregateProfiles,
  formatAsMarkdown,
  SKIP_DIRS
};
