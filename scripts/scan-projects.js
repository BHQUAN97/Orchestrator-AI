#!/usr/bin/env node
// Scan projects at E:\DEVELOP\* de tim patterns thuc te — output .orcai/project-scan-cache.json
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.SCAN_ROOT || 'E:/DEVELOP';
const OUT = path.resolve(__dirname, '..', '.orcai', 'project-scan-cache.json');
const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.turbo', 'playwright-report', 'test-results']);
const MAX_BYTES_PER_PROJECT = 50 * 1024 * 1024;
const MAX_FILES_PER_PROJECT = 1500;
const SAMPLE_EXT = new Set(['.js', '.ts', '.tsx', '.jsx', '.py', '.yml', '.yaml', '.json', '.sh', '.env.example']);

function listProjects() {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, name);
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) continue;
      if (name.startsWith('.')) continue;
      if (name === 'Git' || name === 'Nginx' || name === 'mcp-data-seed') continue;
      out.push({ name, path: p });
    } catch {}
  }
  return out;
}

function walk(dir, acc, budget) {
  if (budget.files >= MAX_FILES_PER_PROJECT || budget.bytes >= MAX_BYTES_PER_PROJECT) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.files >= MAX_FILES_PER_PROJECT || budget.bytes >= MAX_BYTES_PER_PROJECT) return;
    if (EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, acc, budget);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      const base = e.name;
      if (!SAMPLE_EXT.has(ext) && !base.match(/^(Dockerfile|Dockerfile\..+|ecosystem\..+|\.env\..+)$/)) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > 500 * 1024) continue;
        budget.bytes += st.size;
        budget.files += 1;
        acc.push({ rel: path.relative(budget.root, full), size: st.size, base, ext });
      } catch {}
    }
  }
}

function grepSummary(projectPath, files) {
  const counts = {
    express: 0, nestRoute: 0, jwt: 0, zod: 0, prisma: 0, typeorm: 0,
    nextAction: 0, serverAction: 0, tailwind: 0, pm2: 0, docker: 0,
    dockerCompose: 0, healthcheck: 0, multiStage: 0, nonRoot: 0,
    python: 0, shell: 0, dto: 0, middleware: 0, guard: 0,
    cloudinary: 0, sharp: 0, multer: 0, bcrypt: 0, mysql: 0, postgres: 0, redis: 0,
    viCommentCount: 0,
  };
  const sampleNames = new Set();
  const naming = { kebab: 0, camel: 0, pascal: 0, vi: 0 };

  const read = (rel) => {
    try { return fs.readFileSync(path.join(projectPath, rel), 'utf8'); } catch { return ''; }
  };

  for (const f of files) {
    sampleNames.add(f.base);
    if (/^[a-z]+(-[a-z0-9]+)+/.test(f.base)) naming.kebab++;
    else if (/^[a-z]+([A-Z][a-z0-9]+)+/.test(f.base)) naming.camel++;
    else if (/^[A-Z][a-zA-Z0-9]+/.test(f.base)) naming.pascal++;
    if (/[\u00C0-\u1EF9]/.test(f.base)) naming.vi++;

    // Only scan small key files for grep
    if (f.size > 40 * 1024) continue;
    const name = f.base;
    const isKey =
      /dockerfile|compose|ecosystem/i.test(name) ||
      /\.(controller|service|middleware|guard|strategy|dto|entity|module)\.(ts|js)$/.test(name) ||
      /(actions|action|route|middleware|auth|api|client|utils|format|slug|validate)\.(ts|tsx|js|jsx|py)$/.test(name) ||
      /\.sh$/.test(name);
    if (!isKey) continue;

    const body = read(f.rel);
    if (!body) continue;

    if (/from\s+['"]express['"]|require\(['"]express['"]\)/.test(body)) counts.express++;
    if (/@(Get|Post|Put|Delete|Patch)\(/.test(body)) counts.nestRoute++;
    if (/jsonwebtoken|passport-jwt|JwtStrategy|verifyJwt|jwt\.verify/i.test(body)) counts.jwt++;
    if (/from\s+['"]zod['"]|z\.object\(|z\.string\(|safeParse/.test(body)) counts.zod++;
    if (/@prisma\/client|prisma\./i.test(body)) counts.prisma++;
    if (/typeorm|@Entity\(|@Column\(|Repository</.test(body)) counts.typeorm++;
    if (/['"]use server['"]/.test(body)) counts.serverAction++;
    if (/async\s+function\s+\w+.*FormData|export\s+async\s+function/.test(body)) counts.nextAction++;
    if (/tailwind|@tailwind|className=/.test(body)) counts.tailwind++;
    if (/pm2|ecosystem\.config/i.test(body)) counts.pm2++;
    if (/^FROM\s+/m.test(body) || /dockerfile/i.test(name)) counts.docker++;
    if (/docker-compose|version\s*:\s*['"]?3|services\s*:/.test(body) && /compose/i.test(name)) counts.dockerCompose++;
    if (/HEALTHCHECK|healthcheck\s*:/i.test(body)) counts.healthcheck++;
    if (/FROM\s+\S+\s+AS\s+\w+/i.test(body)) counts.multiStage++;
    if (/USER\s+\w+|adduser|addgroup/i.test(body)) counts.nonRoot++;
    if (/^\s*(def|import|from)\s+/m.test(body) && /\.py$/.test(name)) counts.python++;
    if (/^#!\/bin\/(ba)?sh|^#!\/usr\/bin\/env\s+bash/m.test(body)) counts.shell++;
    if (/@IsString|@IsEmail|@IsNumber|class\s+\w+Dto/i.test(body)) counts.dto++;
    if (/Middleware|middleware\s*\(/i.test(body)) counts.middleware++;
    if (/CanActivate|AuthGuard|@Injectable.*Guard/i.test(body)) counts.guard++;
    if (/cloudinary/i.test(body)) counts.cloudinary++;
    if (/sharp\(|require\(['"]sharp['"]\)/i.test(body)) counts.sharp++;
    if (/multer/i.test(body)) counts.multer++;
    if (/bcrypt/i.test(body)) counts.bcrypt++;
    if (/mysql2|mysql:/.test(body)) counts.mysql++;
    if (/pg_isready|postgres:/.test(body)) counts.postgres++;
    if (/redis:|redis-cli|ioredis/.test(body)) counts.redis++;
    counts.viCommentCount += (body.match(/\/\/ [^\n]*[\u00C0-\u1EF9]/g) || []).length;
  }

  return { counts, naming, sampleFiles: [...sampleNames].slice(0, 25) };
}

function scanProject(proj) {
  const budget = { root: proj.path, files: 0, bytes: 0 };
  const files = [];
  walk(proj.path, files, budget);
  const summary = grepSummary(proj.path, files);
  return {
    name: proj.name,
    path: proj.path,
    fileCount: files.length,
    bytes: budget.bytes,
    ...summary,
  };
}

function main() {
  const started = Date.now();
  const projects = listProjects();
  console.log(`[scan] ${projects.length} projects at ${ROOT}`);
  const out = { scannedAt: new Date().toISOString(), durationMs: 0, projects: {} };
  for (const p of projects) {
    const t0 = Date.now();
    try {
      out.projects[p.name] = scanProject(p);
      console.log(`  ${p.name.padEnd(18)} ${out.projects[p.name].fileCount} files in ${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`  ${p.name.padEnd(18)} ERROR ${String(e.message).slice(0, 80)}`);
    }
  }
  out.durationMs = Date.now() - started;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[scan] wrote ${OUT} in ${out.durationMs}ms`);
}

if (require.main === module) main();
module.exports = { scanProject, listProjects };
