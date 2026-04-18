#!/usr/bin/env node
/**
 * Test bench-rag — CLI parse, delta calc, missing counterpart handling, mock mode
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mod = require('./coding-quality-bench-rag');
const { parseArgs, loadProblemSet, computeDelta, writeDeltaReport, GENERIC_PROBLEMS } = mod;

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { console.log(`  OK  ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); failed++; }
}

// Silence warnings from loadProblemSet fallback
const origWarn = console.warn;
console.warn = () => {};

console.log('=== bench-rag tests ===\n');

// === 1. CLI parse: --no-rag disables RAG ===
console.log('Test 1: CLI parse flags');
{
  const a1 = parseArgs(['node', 'bench.js']);
  assert('default rag=true', a1.rag === true);
  assert('default compare=false', a1.compare === false);
  assert('default mock=false', a1.mock === false);
  assert('default problemSet=generic', a1.problemSet === 'generic');

  const a2 = parseArgs(['node', 'bench.js', '--no-rag']);
  assert('--no-rag sets rag=false', a2.rag === false);

  const a3 = parseArgs(['node', 'bench.js', '--compare', '--mock']);
  assert('--compare sets compare=true', a3.compare === true);
  assert('--mock sets mock=true', a3.mock === true);

  const a4 = parseArgs(['node', 'bench.js', '--problem-set', 'realistic']);
  assert('--problem-set value captured', a4.problemSet === 'realistic');

  const a5 = parseArgs(['node', 'bench.js', '--models', 'smart,fast']);
  assert('--models parses csv', Array.isArray(a5.models) && a5.models.length === 2 && a5.models[0] === 'smart');

  const a6 = parseArgs(['node', 'bench.js', '--problems', '1-3,5']);
  assert('--problems range expanded', Array.isArray(a6.problems) && a6.problems.includes(1) && a6.problems.includes(2) && a6.problems.includes(3) && a6.problems.includes(5));
}

// === 2. loadProblemSet fallback ===
console.log('\nTest 2: loadProblemSet fallback');
{
  const generic = loadProblemSet('generic');
  assert('generic returns built-in', generic === GENERIC_PROBLEMS);

  const missing = loadProblemSet('__does_not_exist__');
  assert('missing set falls back to generic', missing === GENERIC_PROBLEMS);
}

// === 3. computeDelta correctness ===
console.log('\nTest 3: computeDelta');
{
  const rag = {
    perModel: {
      'local-heavy': {
        tier: 'local', score: 32,
        problems: {
          1: { finalScore: 5 }, 2: { finalScore: 4 }, 3: { finalScore: 5 },
          4: { finalScore: 3 }, 5: { finalScore: 5 }, 6: { finalScore: 5 },
          7: { finalScore: 2 }, 8: { finalScore: 3 }
        }
      },
      'smart': {
        tier: 'smart', score: 35,
        problems: {
          1: { finalScore: 5 }, 2: { finalScore: 5 }, 3: { finalScore: 5 },
          4: { finalScore: 4 }, 5: { finalScore: 4 }, 6: { finalScore: 5 },
          7: { finalScore: 4 }, 8: { finalScore: 3 }
        }
      }
    }
  };
  const nonRag = {
    perModel: {
      'local-heavy': {
        tier: 'local', score: 22,
        problems: {
          1: { finalScore: 3 }, 2: { finalScore: 2 }, 3: { finalScore: 4 },
          4: { finalScore: 1 }, 5: { finalScore: 4 }, 6: { finalScore: 4 },
          7: { finalScore: 1 }, 8: { finalScore: 3 }
        }
      },
      'smart': {
        tier: 'smart', score: 35,
        problems: {
          1: { finalScore: 5 }, 2: { finalScore: 5 }, 3: { finalScore: 5 },
          4: { finalScore: 4 }, 5: { finalScore: 4 }, 6: { finalScore: 5 },
          7: { finalScore: 4 }, 8: { finalScore: 3 }
        }
      }
    }
  };
  const d = computeDelta(rag, nonRag);

  assert('local-heavy delta = 10', d.perModel['local-heavy'].delta === 10);
  assert('smart delta = 0', d.perModel['smart'].delta === 0);
  assert('local-heavy pct ~ 45.5%', Math.abs(d.perModel['local-heavy'].pct - 45.5) < 0.2,
    JSON.stringify(d.perModel['local-heavy']));

  // Top improved: local-heavy p4 (1→3, delta+2) and p7 (1→2, delta+1) should appear
  const improvedKeys = d.topImproved.map(x => `${x.model}:${x.problemId}`);
  assert('topImproved includes local-heavy:4',
    improvedKeys.includes('local-heavy:4'), JSON.stringify(improvedKeys));
  assert('topImproved deltas all > 0',
    d.topImproved.every(x => x.delta > 0));
  assert('topImproved sorted desc',
    d.topImproved.every((x, i) => i === 0 || d.topImproved[i-1].delta >= x.delta));

  // topNotHelped: problems where delta <= 0 AND rag < 5 (candidates for fine-tune)
  assert('topNotHelped all have delta <= 0',
    d.topNotHelped.every(x => x.delta <= 0));
  assert('topNotHelped all have ragScore < 5',
    d.topNotHelped.every(x => x.ragScore < 5));
}

// === 4. Missing counterpart handled gracefully ===
console.log('\nTest 4: missing counterpart');
{
  // Chi co rag, khong co nonRag: perModel khac nhau → skip model
  const ragOnly = { perModel: { 'local-heavy': { tier: 'local', score: 10, problems: {} } } };
  const empty = { perModel: {} };
  const d = computeDelta(ragOnly, empty);
  assert('empty non-rag → perModel empty', Object.keys(d.perModel).length === 0);
  assert('empty non-rag → topImproved empty', d.topImproved.length === 0);
  assert('empty non-rag → topNotHelped empty', d.topNotHelped.length === 0);
}

// === 5. writeDeltaReport produces valid markdown ===
console.log('\nTest 5: writeDeltaReport');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rag-test-'));
  const rag = {
    perModel: {
      'local-heavy': { tier: 'local', score: 10,
        problems: { 1: { finalScore: 5 }, 2: { finalScore: 5 } } }
    }
  };
  const nonRag = {
    perModel: {
      'local-heavy': { tier: 'local', score: 4,
        problems: { 1: { finalScore: 2 }, 2: { finalScore: 2 } } }
    }
  };
  const d = computeDelta(rag, nonRag);
  const problems = [
    { id: 1, key: 'debounce' },
    { id: 2, key: 'deep-partial' }
  ];
  const outPath = writeDeltaReport(d, tmpDir, problems);
  assert('file created', fs.existsSync(outPath));
  const content = fs.readFileSync(outPath, 'utf8');
  assert('report has header', content.includes('# RAG vs Non-RAG Delta Report'));
  assert('report has per-model table', content.includes('## Per-model'));
  assert('report has top improved', content.includes('Top 5 problems most improved'));
  assert('report has not helped', content.includes('Top 5 problems NOT helped'));
  assert('report mentions debounce problem', content.includes('debounce'));

  // Cleanup
  try { fs.unlinkSync(outPath); } catch {}
  try { fs.rmdirSync(tmpDir); } catch {}
}

// === 6. Mock mode stub integration (no network) ===
console.log('\nTest 6: mock builder produces non-empty augmented prompt for local model');
(async () => {
  const { makeRagBuilder, BASE_SYSTEM_PROMPT } = mod;
  const builder = makeRagBuilder(os.tmpdir(), /*mock*/ true);

  const localOut = await builder.build({
    basePrompt: BASE_SYSTEM_PROMPT,
    userMessage: 'write a debounce function',
    modelId: 'local-heavy'
  });
  assert('local: augmented prompt longer than base',
    localOut.length > BASE_SYSTEM_PROMPT.length, `len=${localOut.length} vs base=${BASE_SYSTEM_PROMPT.length}`);
  assert('local: contains STACK PROFILE', localOut.includes('USER STACK PROFILE'));

  const cloudOut = await builder.build({
    basePrompt: BASE_SYSTEM_PROMPT,
    userMessage: 'write a debounce function',
    modelId: 'smart'
  });
  assert('cloud: basePrompt byte-exact', cloudOut === BASE_SYSTEM_PROMPT);

  const m = builder.getMetrics();
  assert('metrics: rag_applied >= 1', m.rag_applied >= 1, JSON.stringify(m));
  assert('metrics: rag_skipped_cloud >= 1', m.rag_skipped_cloud >= 1, JSON.stringify(m));

  console.warn = origWarn;
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.warn = origWarn;
  console.error('Test crashed:', e);
  process.exit(1);
});
