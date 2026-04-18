#!/usr/bin/env node
/**
 * orcai-trace — Analyze transcript cho 1 session de debug token inflation
 *
 * Usage:
 *   node bin/orcai-trace.js --session <id>          # specific session
 *   node bin/orcai-trace.js --session latest         # session gan nhat
 *   node bin/orcai-trace.js --list                   # liet ke session co san
 *   node bin/orcai-trace.js --session <id> --top 5  # top 5 offenders (default 5)
 *
 * Output: bang tool call + tokens/call + totals + top offenders
 */

const fs = require('fs');
const path = require('path');

const args = parseArgs(process.argv.slice(2));
const projectDir = path.resolve(args.project || process.cwd());
const transcriptsDir = path.join(projectDir, '.orcai', 'transcripts');

if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

if (args.list) {
  listSessions(transcriptsDir);
  process.exit(0);
}

let sessionId = args.session;
if (!sessionId) {
  console.error('Error: --session <id> required (or --list to browse)');
  process.exit(1);
}

if (sessionId === 'latest') {
  const latest = findLatest(transcriptsDir);
  if (!latest) {
    console.error(`Error: no transcripts found in ${transcriptsDir}`);
    process.exit(1);
  }
  sessionId = latest;
  console.log(`(latest session: ${sessionId})\n`);
}

const filePath = path.join(transcriptsDir, `${sessionId}.jsonl`);
if (!fs.existsSync(filePath)) {
  console.error(`Error: transcript not found at ${filePath}`);
  console.error(`Try: node ${path.basename(process.argv[1])} --list`);
  process.exit(1);
}

const events = parseTranscript(filePath);
analyzeTranscript(events, sessionId, { top: Number(args.top) || 5 });

// =============================================================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') && !a.startsWith('-')) continue;
    const key = a.replace(/^-+/, '');
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function printHelp() {
  console.log(`
orcai-trace — Debug token inflation trong 1 session

Usage:
  node bin/orcai-trace.js --session <id>    Phan tich transcript 1 session
  node bin/orcai-trace.js --session latest  Session gan nhat
  node bin/orcai-trace.js --list            Liet ke cac session co

Options:
  --project <dir>  Project dir (default: cwd)
  --top <n>        Top N offenders theo tokens (default 5)
  --help, -h       Hien help

Vi du:
  node bin/orcai-trace.js --list
  node bin/orcai-trace.js --session latest --top 10
  node bin/orcai-trace.js --session mo46xwgl --project /path/to/project
`);
}

function listSessions(dir) {
  if (!fs.existsSync(dir)) {
    console.log(`No transcripts dir at ${dir}`);
    return;
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.log('No transcripts found.');
    return;
  }
  const withStats = files.map(f => {
    const stat = fs.statSync(path.join(dir, f));
    return { id: f.replace(/\.jsonl$/, ''), mtime: stat.mtime, size: stat.size };
  });
  withStats.sort((a, b) => b.mtime - a.mtime);
  console.log(`Sessions in ${dir}:\n`);
  console.log('ID'.padEnd(30) + 'Modified'.padEnd(22) + 'Size');
  console.log('-'.repeat(65));
  for (const s of withStats.slice(0, 20)) {
    const ts = s.mtime.toISOString().slice(0, 19).replace('T', ' ');
    const kb = (s.size / 1024).toFixed(1) + ' KB';
    console.log(s.id.padEnd(30) + ts.padEnd(22) + kb);
  }
}

function findLatest(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  if (files.length === 0) return null;
  let latest = null;
  let latestMtime = 0;
  for (const f of files) {
    const stat = fs.statSync(path.join(dir, f));
    if (stat.mtimeMs > latestMtime) {
      latestMtime = stat.mtimeMs;
      latest = f.replace(/\.jsonl$/, '');
    }
  }
  return latest;
}

function parseTranscript(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return events;
}

function analyzeTranscript(events, sessionId, opts) {
  const metaStart = events.find(e => e.type === 'meta' && (e.event === 'session_start' || e.event === 'run_start'));
  const metaEnd = events.find(e => e.type === 'meta' && e.event === 'run_end');

  // Pair tool_call + tool_result theo thu tu (1:1 mapping tuan tu)
  const calls = [];
  const pendingCalls = [];
  for (const e of events) {
    if (e.type === 'tool_call') {
      pendingCalls.push({ ts: e.ts, name: e.name, args: e.args });
    } else if (e.type === 'tool_result') {
      const call = pendingCalls.shift();
      calls.push({
        n: calls.length + 1,
        ts: call?.ts || e.ts,
        name: e.name,
        args: call?.args || null,
        success: e.success !== false,
        error: e.error,
        contentBytes: e.content_bytes ?? null,
        tokens: e.tokens_estimate ?? null,
        cached: e.cached === true
      });
    }
  }

  // Header
  console.log('='.repeat(72));
  console.log(`SESSION: ${sessionId}`);
  if (metaStart?.model) console.log(`MODEL:   ${metaStart.model}`);
  if (metaStart?.role) console.log(`ROLE:    ${metaStart.role}`);
  if (events[0]?.ts) console.log(`STARTED: ${events[0].ts}`);
  if (events[events.length - 1]?.ts) {
    const start = new Date(events[0].ts).getTime();
    const end = new Date(events[events.length - 1].ts).getTime();
    const durSec = Math.round((end - start) / 1000);
    console.log(`ENDED:   ${events[events.length - 1].ts}  (${durSec}s)`);
  }
  if (metaEnd) console.log(`STATUS:  ${metaEnd.completed ? 'completed' : (metaEnd.aborted ? 'aborted: ' + (metaEnd.reason || '?') : 'ended')}  (iterations: ${metaEnd.iterations ?? '?'})`);
  console.log('='.repeat(72));

  if (calls.length === 0) {
    console.log('\nNo tool calls in this session.');
    return;
  }

  // Table: # | tool | args preview | ok | bytes | ~tokens | cache
  console.log('');
  const header = [
    pad('#', 3),
    pad('tool', 20),
    pad('args (truncated)', 38),
    pad('ok', 3),
    pad('bytes', 7),
    pad('~tokens', 8),
    pad('cache', 6)
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  let totalTokens = 0;
  let totalBytes = 0;
  for (const c of calls) {
    const argsStr = argsPreview(c.args, 38);
    const row = [
      pad(String(c.n), 3),
      pad(c.name || '?', 20),
      pad(argsStr, 38),
      pad(c.success ? '✓' : '✗', 3),
      pad(c.contentBytes != null ? String(c.contentBytes) : '-', 7),
      pad(c.tokens != null ? String(c.tokens) : '-', 8),
      pad(c.cached ? 'HIT' : '', 6)
    ].join(' ');
    console.log(row);
    totalTokens += c.tokens || 0;
    totalBytes += c.contentBytes || 0;
  }

  console.log('-'.repeat(header.length));
  console.log(`TOTAL: ${calls.length} tool calls, ${totalBytes} bytes, ~${totalTokens} tokens in tool results`);
  const cachedCount = calls.filter(c => c.cached).length;
  if (cachedCount > 0) {
    console.log(`Cache hits: ${cachedCount}/${calls.length}`);
  }

  // Top offenders aggregate by tool+path
  const buckets = new Map();
  for (const c of calls) {
    const pathArg = c.args?.path || c.args?.pattern || '(no-path)';
    const key = `${c.name} → ${pathArg}`;
    const b = buckets.get(key) || { count: 0, tokens: 0, bytes: 0 };
    b.count++;
    b.tokens += c.tokens || 0;
    b.bytes += c.contentBytes || 0;
    buckets.set(key, b);
  }
  const top = [...buckets.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, opts.top);

  if (top.length > 0) {
    console.log('');
    console.log(`Top ${top.length} offenders (by tokens):`);
    for (const [key, b] of top) {
      console.log(`  ${key}  —  ${b.count}x, ${b.tokens} tokens (${b.bytes} bytes)`);
    }
  }

  // Suggestions
  const suggestions = generateSuggestions(calls);
  if (suggestions.length > 0) {
    console.log('');
    console.log('Suggestions:');
    for (const s of suggestions) console.log(`  • ${s}`);
  }
}

function generateSuggestions(calls) {
  const out = [];
  // Detect "read_file after search_files same path"
  const searchedPaths = new Set();
  for (const c of calls) {
    if ((c.name === 'search_files' || c.name === 'glob') && c.args?.path && c.success) {
      searchedPaths.add(c.args.path);
    }
    if (c.name === 'read_file' && c.args?.path && searchedPaths.has(c.args.path) && !c.cached) {
      out.push(`Call #${c.n}: read_file(${c.args.path}) after search_files — could trust search output to save ~${c.tokens || '?'} tokens`);
      break; // chi 1 warning la du
    }
  }
  // Detect same path read multiple times
  const pathReads = new Map();
  for (const c of calls) {
    if (c.name === 'read_file' && c.args?.path) {
      pathReads.set(c.args.path, (pathReads.get(c.args.path) || 0) + 1);
    }
  }
  for (const [p, n] of pathReads) {
    if (n >= 2) {
      out.push(`${p} read ${n} times — content likely already in context history`);
    }
  }
  return out;
}

function argsPreview(args, max) {
  if (!args) return '-';
  if (typeof args === 'string') return args.slice(0, max);
  let s;
  try { s = JSON.stringify(args); } catch { s = '[unserializable]'; }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function pad(s, width) {
  s = String(s);
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}
