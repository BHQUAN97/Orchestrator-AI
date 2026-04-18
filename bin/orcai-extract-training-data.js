#!/usr/bin/env node
/**
 * CLI: extract training data (prompt/completion pairs) tu cac project user
 * cho SFT fine-tune qua Unsloth / HuggingFace.
 *
 * Sources (uu tien):
 *  A. Git history  — commit subject -> label (classifier) va diff (style)
 *  B. Conversation transcripts — User/Assistant pairs trong .claude-shared
 *  C. Function docs — JSDoc / Python docstring -> function body
 *
 * Output (duoi --out):
 *  - classifier.jsonl  {messages:[{user},{assistant:label}]}
 *  - style.jsonl       {messages:[{user},{assistant:code}]}
 *  - metadata.json     { totalPairs, byCategory, bySource, bySize, generatedAt }
 *
 * Usage:
 *   node bin/orcai-extract-training-data.js \
 *     --root E:\DEVELOP --out E:\DEVELOP\ai-orchestrator\.orcai\training\ \
 *     --kind both --limit 5000
 *
 *   node bin/orcai-extract-training-data.js validate --file classifier.jsonl
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------- args ----------
function parseArgs(argv) {
  const out = {
    cmd: 'extract',
    root: null, outDir: null,
    kind: 'both', limit: 5000,
    file: null,
  };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith('-')) {
    out.cmd = rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root' && rest[i + 1]) out.root = rest[++i];
    else if (a === '--out' && rest[i + 1]) out.outDir = rest[++i];
    else if (a === '--kind' && rest[i + 1]) out.kind = rest[++i];
    else if (a === '--limit' && rest[i + 1]) out.limit = parseInt(rest[++i], 10);
    else if (a === '--file' && rest[i + 1]) out.file = rest[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

// ---------- utils ----------
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function safePathUnder(base, candidate) {
  const rb = path.resolve(base);
  const rc = path.resolve(candidate);
  return rc === rb || rc.startsWith(rb + path.sep);
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function listProjects(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const skip = new Set(['.git', 'node_modules', '.claude-shared', 'Nginx']);
  return entries
    .filter(e => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.'))
    .map(e => path.join(root, e.name));
}

function hasGit(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function git(dir, args, opts = {}) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...opts,
    });
  } catch { return ''; }
}

// ---------- classifier heuristic ----------
const LABELS = ['fix', 'build', 'review', 'refactor', 'explain', 'debug'];

function labelFromSubject(subject) {
  const s = subject.toLowerCase().trim();
  if (/^(fix|hotfix|bugfix|patch)\b/.test(s) || /\bfix(es|ed)?\b/.test(s)) return 'fix';
  if (/^(debug|trace|investigate)\b/.test(s) || /\bdebug(ging)?\b/.test(s)) return 'debug';
  if (/^refactor\b/.test(s) || /\brefactor(ing)?\b/.test(s) || /\brename\b/.test(s)) return 'refactor';
  if (/^(review|audit|check)\b/.test(s) || /\breview(ed)?\b/.test(s)) return 'review';
  if (/^(docs?|document|explain|comment)\b/.test(s) || /\bdocument(ation)?\b/.test(s)) return 'explain';
  if (/^(feat|feature|add|build|implement|new|init|create|introduce|support)\b/.test(s)) return 'build';
  if (/^(chore|test|perf|style|wip)\b/.test(s)) return null; // skip noise
  return null;
}

// ---------- filters ----------
function isLockOrDist(files) {
  if (!files.length) return false;
  const bad = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|\/dist\/|\/build\/|\.min\.(js|css)$)/i;
  return files.every(f => bad.test(f));
}

function isTypoCommit(subject) {
  return /\b(typo|rename only|reword|format only|whitespace)\b/i.test(subject) && subject.length < 60;
}

function isMergeCommit(subject) {
  return /^merge (branch|pull|remote)/i.test(subject.trim());
}

// rough language/code detect — completion phai "trong co ve la code"
function looksLikeCode(s) {
  if (!s || s.length < 20) return false;
  const hints = [
    /[{};]/.test(s),
    /\b(function|const|let|var|class|def|return|import|require|=>)\b/.test(s),
    /^[+\-@]/m.test(s), // diff markers
    /\n\s{2,}\S/.test(s), // indented
  ];
  return hints.filter(Boolean).length >= 2;
}

// ---------- source A: git history ----------
function extractFromGit(projectDir, cap) {
  const out = { classifier: [], style: [] };
  if (!hasGit(projectDir)) return out;

  const sep = '<<<ORCAI_SEP>>>';
  const recSep = '<<<ORCAI_REC>>>';
  const fmt = `${recSep}%H|%P|%s|%b${sep}`;
  const raw = git(projectDir, ['log', `--pretty=format:${fmt}`, '--name-only', '-n', '500']);
  if (!raw) return out;

  const records = raw.split(recSep).slice(1);
  for (const rec of records) {
    const [header, filesBlock = ''] = rec.split(sep);
    if (!header) continue;
    const [hash, parents, subject, ...bodyParts] = header.split('|');
    if (!hash || !subject) continue;

    const files = filesBlock.split('\n').map(f => f.trim()).filter(Boolean);

    if (isMergeCommit(subject)) continue;
    if (isTypoCommit(subject)) continue;
    if (isLockOrDist(files)) continue;

    const label = labelFromSubject(subject);
    const prompt = subject.trim();
    if (prompt.length > 2000) continue;

    // classifier
    if (label) {
      out.classifier.push({
        prompt,
        completion: label,
        source: 'git',
        project: path.basename(projectDir),
      });
    }

    // style — dung diff cua commit voi parent dau tien
    if (out.style.length < cap) {
      const parent = (parents || '').split(' ').filter(Boolean)[0];
      if (parent) {
        const diff = git(projectDir, ['diff', '--unified=2', `${parent}..${hash}`, '--', '.']);
        if (diff) {
          const capped = diff.length > 2000 ? diff.slice(0, 2000) : diff;
          if (looksLikeCode(capped)) {
            out.style.push({
              prompt,
              completion: capped,
              source: 'git-diff',
              project: path.basename(projectDir),
            });
          }
        }
      }
    }

    if (out.classifier.length >= cap && out.style.length >= cap) break;
  }

  return out;
}

// ---------- source B: conversation transcripts ----------
function findTranscripts(dir) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      results.push(...findTranscripts(full));
    } else if (/\.(md|log)$/i.test(e.name)) {
      results.push(full);
    }
  }
  return results;
}

function extractFromTranscripts(shareDir, cap) {
  const out = { classifier: [], style: [] };
  if (!fs.existsSync(shareDir)) return out;
  const files = findTranscripts(shareDir).slice(0, 200);

  // patterns: "User:" / "Assistant:" hoac "## User" / "## Assistant"
  const rx = /(^|\n)\s*(#{1,3}\s*)?(User|Human|Q)\s*[:\n]([\s\S]*?)(?=\n\s*(#{1,3}\s*)?(Assistant|AI|A)\s*[:\n])\s*(#{1,3}\s*)?(Assistant|AI|A)\s*[:\n]([\s\S]*?)(?=\n\s*(#{1,3}\s*)?(User|Human|Q)\s*[:\n]|$)/gi;

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (text.length > 500_000) text = text.slice(0, 500_000);
    let m;
    while ((m = rx.exec(text)) !== null) {
      const prompt = (m[4] || '').trim();
      const completion = (m[9] || '').trim();
      if (!prompt || !completion) continue;
      if (prompt.length > 2000) continue;
      if (completion.length < 20) continue;

      const label = labelFromSubject(prompt);
      if (label) {
        out.classifier.push({
          prompt, completion: label,
          source: 'transcript',
          project: path.basename(path.dirname(f)),
        });
      }
      if (looksLikeCode(completion)) {
        out.style.push({
          prompt,
          completion: completion.slice(0, 2000),
          source: 'transcript',
          project: path.basename(path.dirname(f)),
        });
      }
      if (out.classifier.length >= cap && out.style.length >= cap) return out;
    }
  }
  return out;
}

// ---------- source C: function docs ----------
const CODE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.py']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.orcai', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'out', '.turbo', '.cache',
]);

function walkCode(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude-shared') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkCode(full, out, depth + 1);
    else if (CODE_EXTS.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

function extractJsFunctionBody(src, fromIdx) {
  // find first '{' after fromIdx, then match braces
  const open = src.indexOf('{', fromIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length && i < fromIdx + 8000; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

function extractFromFunctionDocs(files, cap) {
  const out = { classifier: [], style: [] };

  const jsDocRx = /\/\*\*([\s\S]*?)\*\/\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)\s*\(([^)]*)\)|(\w+)\s*[:=]\s*(?:async\s*)?\(([^)]*)\)\s*=>)/g;
  const pyDefRx = /def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?:\s*\n\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/g;

  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (src.length > 300_000) continue;

    const ext = path.extname(f);
    const project = detectProject(f);

    if (ext === '.py') {
      let m;
      while ((m = pyDefRx.exec(src)) !== null) {
        const name = m[1];
        const params = m[2] || '';
        const doc = (m[3] || m[4] || '').trim();
        if (!doc || doc.length < 15) continue;
        // body = lines indented after def until dedent
        const bodyStart = m.index + m[0].length;
        const bodyEnd = findPyBodyEnd(src, bodyStart);
        const body = src.slice(bodyStart, bodyEnd).replace(/^\n+/, '');
        if (!body || body.length < 20) continue;
        const prompt = `Viet function ${name}(${params}) that ${doc.split('\n')[0]}`;
        if (prompt.length > 2000) continue;
        out.style.push({
          prompt, completion: body.slice(0, 2000),
          source: 'docstring', project,
        });
        if (out.style.length >= cap) return out;
      }
    } else {
      let m;
      while ((m = jsDocRx.exec(src)) !== null) {
        const doc = (m[1] || '')
          .split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim())
          .filter(l => l && !l.startsWith('@')).join(' ').trim();
        if (!doc || doc.length < 15) continue;
        const name = m[2] || m[4];
        const params = m[3] || m[5] || '';
        if (!name) continue;
        const bodyStart = m.index + m[0].length;
        const body = extractJsFunctionBody(src, bodyStart);
        if (!body || body.length < 20) continue;
        const prompt = `Viet function ${name}(${params}) that ${doc}`;
        if (prompt.length > 2000) continue;
        out.style.push({
          prompt, completion: body.slice(0, 2000),
          source: 'jsdoc', project,
        });
        if (out.style.length >= cap) return out;
      }
    }
  }
  return out;
}

function findPyBodyEnd(src, start) {
  // naive: detect first blank-separated dedent to col 0
  const lines = src.slice(start).split('\n');
  let end = start;
  let acc = 0;
  for (const line of lines) {
    if (/^\S/.test(line) && line.trim()) break;
    acc += line.length + 1;
    if (acc > 4000) break;
  }
  return start + acc;
}

function detectProject(filePath) {
  const parts = filePath.split(/[\\/]/);
  const idx = parts.findIndex(p => p === 'DEVELOP');
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  return path.basename(path.dirname(filePath));
}

// ---------- dedupe + write ----------
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = sha1(it.prompt + '|' + (it.completion || '').slice(0, 100));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function filterPair(it) {
  if (!it || !it.prompt || !it.completion) return false;
  if (it.prompt.length > 2000) return false;
  if (it.completion.length < 1) return false;
  return true;
}

function toJsonl(items) {
  return items.map(it => JSON.stringify({
    messages: [
      { role: 'user', content: it.prompt },
      { role: 'assistant', content: it.completion },
    ],
  })).join('\n') + (items.length ? '\n' : '');
}

// ---------- extract orchestrator ----------
function runExtract(opts) {
  const started = Date.now();
  if (!opts.root) throw new Error('--root required');
  if (!opts.outDir) throw new Error('--out required');

  const outAbs = path.resolve(opts.outDir);
  ensureDir(outAbs);

  const projects = listProjects(opts.root);
  const byProject = {};
  const bySource = {};
  const bySize = { small: 0, medium: 0, large: 0 };

  const classAll = [];
  const styleAll = [];

  // A + C per project
  for (const proj of projects) {
    const projName = path.basename(proj);
    byProject[projName] = { classifier: 0, style: 0 };

    const g = extractFromGit(proj, opts.limit);
    classAll.push(...g.classifier);
    styleAll.push(...g.style);
    byProject[projName].classifier += g.classifier.length;
    byProject[projName].style += g.style.length;

    const codeFiles = walkCode(proj).slice(0, 400);
    const d = extractFromFunctionDocs(codeFiles, opts.limit);
    classAll.push(...d.classifier);
    styleAll.push(...d.style);
    byProject[projName].classifier += d.classifier.length;
    byProject[projName].style += d.style.length;
  }

  // B — transcripts tu .claude-shared
  const shared = path.join(opts.root, '.claude-shared', 'projects');
  const t = extractFromTranscripts(shared, opts.limit);
  classAll.push(...t.classifier);
  styleAll.push(...t.style);
  byProject['_transcripts'] = { classifier: t.classifier.length, style: t.style.length };

  // filter + dedupe
  let classifier = dedupe(classAll.filter(filterPair));
  let style = dedupe(styleAll.filter(it => filterPair(it) && it.completion.length >= 20));

  // cap --limit
  classifier = classifier.slice(0, opts.limit);
  style = style.slice(0, opts.limit);

  // bySource / bySize
  for (const it of [...classifier, ...style]) {
    bySource[it.source] = (bySource[it.source] || 0) + 1;
    const len = it.completion.length;
    if (len < 200) bySize.small++;
    else if (len < 1000) bySize.medium++;
    else bySize.large++;
  }

  // safety: only write inside outDir
  const classPath = path.join(outAbs, 'classifier.jsonl');
  const stylePath = path.join(outAbs, 'style.jsonl');
  const metaPath = path.join(outAbs, 'metadata.json');
  for (const p of [classPath, stylePath, metaPath]) {
    if (!safePathUnder(outAbs, p)) throw new Error('refused to write outside --out: ' + p);
  }

  if (opts.kind === 'classifier' || opts.kind === 'both') {
    fs.writeFileSync(classPath, toJsonl(classifier), 'utf8');
  }
  if (opts.kind === 'style' || opts.kind === 'both') {
    fs.writeFileSync(stylePath, toJsonl(style), 'utf8');
  }

  const metadata = {
    totalPairs: classifier.length + style.length,
    byCategory: { classifier: classifier.length, style: style.length },
    bySource,
    bySize,
    byProject,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  };
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');

  return { metadata, classPath, stylePath, metaPath };
}

// ---------- validate ----------
function runValidate(opts) {
  if (!opts.file) throw new Error('--file required');
  let filePath = opts.file;
  if (!path.isAbsolute(filePath) && opts.outDir) filePath = path.join(opts.outDir, filePath);
  if (!fs.existsSync(filePath)) {
    // try default location
    const guess = path.resolve(process.cwd(), '.orcai', 'training', opts.file);
    if (fs.existsSync(guess)) filePath = guess;
    else throw new Error('file not found: ' + filePath);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const errors = [];
  const valid = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (!obj.messages || !Array.isArray(obj.messages) || obj.messages.length < 2) {
        errors.push({ line: i + 1, err: 'missing messages[]' });
      } else {
        valid.push(obj);
      }
    } catch (e) {
      errors.push({ line: i + 1, err: e.message });
    }
  }

  console.log(`File:    ${filePath}`);
  console.log(`Lines:   ${lines.length}`);
  console.log(`Valid:   ${valid.length}`);
  console.log(`Errors:  ${errors.length}`);
  if (errors.length) {
    console.log('First errors:', errors.slice(0, 5));
  }
  // sample 5 random
  const n = Math.min(5, valid.length);
  console.log(`\nRandom ${n} samples:`);
  const picks = new Set();
  while (picks.size < n) picks.add(Math.floor(Math.random() * valid.length));
  for (const idx of picks) {
    const o = valid[idx];
    const u = o.messages[0].content.slice(0, 120).replace(/\n/g, ' ');
    const a = o.messages[1].content.slice(0, 120).replace(/\n/g, ' ');
    console.log(`  [${idx}] user: ${u}`);
    console.log(`        asst: ${a}`);
  }
  return { lines: lines.length, valid: valid.length, errors: errors.length };
}

// ---------- main ----------
function printHelp() {
  console.log(`orcai-extract-training-data

Usage:
  node bin/orcai-extract-training-data.js \\
    --root <dir> --out <dir> [--kind classifier|style|both] [--limit N]

  node bin/orcai-extract-training-data.js validate --file <path.jsonl>
`);
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); process.exit(0); }
  try {
    if (opts.cmd === 'validate') {
      runValidate(opts);
    } else {
      const r = runExtract(opts);
      console.log('OK extract — totalPairs=%d classifier=%d style=%d elapsed=%dms',
        r.metadata.totalPairs,
        r.metadata.byCategory.classifier,
        r.metadata.byCategory.style,
        r.metadata.elapsedMs);
      console.log('out:', r.classPath);
      console.log('out:', r.stylePath);
      console.log('out:', r.metaPath);
    }
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
}

module.exports = {
  parseArgs, runExtract, runValidate,
  labelFromSubject, looksLikeCode, dedupe,
  isMergeCommit, isTypoCommit, isLockOrDist,
};
