#!/usr/bin/env node
/**
 * Cross-project memory tests
 *
 * Bao gom:
 * - indexCrossProject tren 2 fake project dirs
 * - searchCrossProject tra ve metadata dung (project, file, chunkIndex)
 * - excludeProject filter
 * - hermes-bridge: env off → khong co cross hits; env on → co cross hits
 * - TF-IDF fallback khi embeddings khong kha dung
 *
 * Chay: node test/cross-project-memory.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { EmbeddingStore } = require('../lib/embeddings');
const { MemoryStore, getCurrentProjectName } = require('../lib/memory');
const { HermesBridge } = require('../lib/hermes-bridge');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  const result = (async () => {
    try {
      await fn();
      passed++;
      console.log(`✓ ${name}`);
    } catch (e) {
      failed++;
      failures.push({ name, error: e.message });
      console.log(`✗ ${name}: ${e.message}`);
    }
  })();
  return result;
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== Fake embedder =====
// Deterministic 32-dim embedding based on keyword hashing.
// Muc dich: test khong can goi LiteLLM that.
function fakeEmbed(texts) {
  const DIM = 32;
  return texts.map(text => {
    const vec = new Array(DIM).fill(0);
    const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    for (const tok of tokens) {
      const h = crypto.createHash('md5').update(tok).digest();
      for (let i = 0; i < DIM; i++) {
        vec[i] += (h[i % h.length] - 128) / 128;
      }
    }
    // Bao dam vector khac zero de cosine hop le
    if (vec.every(v => v === 0)) vec[0] = 1;
    return vec;
  });
}

function patchEmbed(store) {
  store.embed = async (texts) => fakeEmbed(texts);
  return store;
}

// ===== Temp setup =====
function mkTmpShared() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orcai-xproj-'));
  const projects = path.join(base, 'projects');
  const embeddings = path.join(base, 'embeddings');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(embeddings, { recursive: true });

  // Project A: Alpha — noi ve deployment + nginx
  const pA = path.join(projects, 'Alpha');
  fs.mkdirSync(pA, { recursive: true });
  fs.writeFileSync(path.join(pA, 'MEMORY.md'),
    '# Alpha Memory\n\nNginx reverse proxy tren port 8080 cho Next.js app.\n' +
    'Deploy bang PM2 ecosystem file. Cau hinh SSL bang certbot cho domain alpha.example.com.\n' +
    'Gotcha: nho mo firewall port 443 va 80 truoc khi chay certbot.\n');
  fs.writeFileSync(path.join(pA, 'deploy.md'),
    '# Deploy Notes\n\nPM2 start index.js --name alpha. Certbot renewal tu dong qua cron.\n');

  // Project B: Beta — noi ve React Native + Firebase
  const pB = path.join(projects, 'Beta');
  fs.mkdirSync(pB, { recursive: true });
  fs.writeFileSync(path.join(pB, 'MEMORY.md'),
    '# Beta Memory\n\nReact Native app dung Firebase Auth va Firestore.\n' +
    'Lesson: khi build iOS release phai clean DerivedData truoc.\n' +
    'Push notification qua FCM, can APNs cert de upload len Firebase.\n');

  return { base, projects, embeddings, pA, pB };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// ===== Tests =====
(async () => {
  console.log('=== Cross-Project Memory Test ===\n');

  const tmp = mkTmpShared();

  try {
    // ---- indexCrossProject ----
    await test('indexCrossProject chunks 2 fake projects', async () => {
      const store = patchEmbed(new EmbeddingStore({ projectDir: tmp.base }));
      const res = await store.indexCrossProject({ sharedRoot: tmp.base });
      assert(res.indexed > 0, `expected indexed > 0, got ${res.indexed}`);
      assert(res.files >= 3, `expected >=3 files, got ${res.files}`);
      assert(res.projects.includes('Alpha'), 'should include Alpha');
      assert(res.projects.includes('Beta'), 'should include Beta');
      assert(fs.existsSync(res.storeFile), 'shared.index.json should exist');
      const data = JSON.parse(fs.readFileSync(res.storeFile, 'utf8'));
      assert(data.items.length === res.indexed, 'items count mismatch');
      const sample = data.items[0];
      assert(sample.metadata && sample.metadata.project, 'item must have metadata.project');
      assert(typeof sample.metadata.chunkIndex === 'number', 'chunkIndex must be number');
      assert(sample.metadata.file && typeof sample.metadata.file === 'string', 'metadata.file must be string');
    });

    // ---- searchCrossProject returns project metadata ----
    await test('searchCrossProject returns project metadata', async () => {
      const store = patchEmbed(new EmbeddingStore({ projectDir: tmp.base }));
      await store.indexCrossProject({ sharedRoot: tmp.base });
      const hits = await store.searchCrossProject({
        query: 'nginx reverse proxy deploy',
        topK: 5,
        sharedRoot: tmp.base
      });
      assert(hits.length > 0, 'expected >=1 hit');
      for (const h of hits) {
        assert(h.project, 'hit.project required');
        assert(h.file, 'hit.file required');
        assert(typeof h.chunkIndex === 'number', 'hit.chunkIndex required');
        assert(typeof h.score === 'number', 'hit.score required');
      }
      // Top hit should be Alpha project (noi ve nginx/deploy)
      assert(hits[0].project === 'Alpha', `top hit should be Alpha, got ${hits[0].project}`);
    });

    // ---- excludeProject filters correctly ----
    await test('excludeProject filters out that project', async () => {
      const store = patchEmbed(new EmbeddingStore({ projectDir: tmp.base }));
      await store.indexCrossProject({ sharedRoot: tmp.base });
      const hits = await store.searchCrossProject({
        query: 'nginx deploy pm2',
        topK: 10,
        excludeProject: 'Alpha',
        sharedRoot: tmp.base
      });
      for (const h of hits) {
        assert(h.project !== 'Alpha', `excluded Alpha but got hit from Alpha: ${h.file}`);
      }
    });

    // ---- projectFilter whitelist ----
    await test('projectFilter whitelist only returns listed projects', async () => {
      const store = patchEmbed(new EmbeddingStore({ projectDir: tmp.base }));
      await store.indexCrossProject({ sharedRoot: tmp.base });
      const hits = await store.searchCrossProject({
        query: 'firebase react native',
        topK: 10,
        projectFilter: ['Beta'],
        sharedRoot: tmp.base
      });
      assert(hits.length > 0, 'expected beta hits');
      for (const h of hits) assert(h.project === 'Beta', `filter violated: ${h.project}`);
    });

    // ---- getCurrentProjectName ----
    await test('getCurrentProjectName derives basename', () => {
      const name = getCurrentProjectName('/foo/bar/MyProj');
      assert(name === 'MyProj', `got ${name}`);
      process.env.ORCAI_PROJECT_NAME = 'Explicit';
      assert(getCurrentProjectName('/whatever') === 'Explicit', 'env override failed');
      delete process.env.ORCAI_PROJECT_NAME;
    });

    // ---- MemoryStore.crossProjectSearch (embeddings path) ----
    await test('MemoryStore.crossProjectSearch via embeddings', async () => {
      // Setup: patch EmbeddingStore.prototype.embed globally for this test
      const origEmbed = EmbeddingStore.prototype.embed;
      EmbeddingStore.prototype.embed = async function (texts) { return fakeEmbed(texts); };
      try {
        // Need to index first
        const store = new EmbeddingStore({ projectDir: tmp.base });
        await store.indexCrossProject({ sharedRoot: tmp.base });

        process.env.CLAUDE_SHARED_ROOT = tmp.base;
        const mem = new MemoryStore(path.join(tmp.base, 'fakecurrent'));
        const hits = await mem.crossProjectSearch('nginx deployment', { topK: 3 });
        assert(hits.length > 0, 'expected hits via embeddings');
        assert(hits[0].source === 'embeddings', `expected embeddings source, got ${hits[0].source}`);
        assert(hits[0].project && hits[0].file, 'hit missing metadata');
      } finally {
        EmbeddingStore.prototype.embed = origEmbed;
        delete process.env.CLAUDE_SHARED_ROOT;
      }
    });

    // ---- TF-IDF fallback when embeddings unavailable ----
    await test('crossProjectSearch falls back to TF-IDF when no shared index', async () => {
      // Dung tmp2 KHONG co shared index — embedding query se fail/empty
      const tmp2 = mkTmpShared();
      try {
        process.env.CLAUDE_SHARED_ROOT = tmp2.base;
        // Force embedding fail by NOT indexing + making embed throw
        const origEmbed = EmbeddingStore.prototype.embed;
        EmbeddingStore.prototype.embed = async function () { throw new Error('no endpoint'); };
        try {
          const mem = new MemoryStore(path.join(tmp2.base, 'fakecurrent'));
          const hits = await mem.crossProjectSearch('firebase react native', { topK: 3 });
          assert(hits.length > 0, 'expected TF-IDF fallback hits');
          assert(hits[0].source === 'tfidf', `expected tfidf source, got ${hits[0].source}`);
          const projects = new Set(hits.map(h => h.project));
          assert(projects.has('Beta'), 'should find Beta via tfidf');
        } finally {
          EmbeddingStore.prototype.embed = origEmbed;
        }
      } finally {
        delete process.env.CLAUDE_SHARED_ROOT;
        rmrf(tmp2.base);
      }
    });

    // ---- excludeCurrent filters CWD project name ----
    await test('crossProjectSearch excludeCurrent filters current project', async () => {
      const tmp3 = mkTmpShared();
      try {
        process.env.CLAUDE_SHARED_ROOT = tmp3.base;
        // Force TF-IDF path (no endpoint)
        const origEmbed = EmbeddingStore.prototype.embed;
        EmbeddingStore.prototype.embed = async function () { throw new Error('no endpoint'); };
        try {
          // Pretend current project IS "Alpha" — expect Alpha excluded
          process.env.ORCAI_PROJECT_NAME = 'Alpha';
          const mem = new MemoryStore(tmp3.base);
          const hits = await mem.crossProjectSearch('nginx deploy firebase', { topK: 10, excludeCurrent: true });
          for (const h of hits) {
            assert(h.project !== 'Alpha', `Alpha should be excluded, got ${h.file}`);
          }
        } finally {
          EmbeddingStore.prototype.embed = origEmbed;
          delete process.env.ORCAI_PROJECT_NAME;
        }
      } finally {
        delete process.env.CLAUDE_SHARED_ROOT;
        rmrf(tmp3.base);
      }
    });

    // ---- Hermes bridge: env OFF ----
    await test('HermesBridge: HERMES_CROSS_PROJECT off → no cross hits', async () => {
      const tmp4 = mkTmpShared();
      try {
        process.env.CLAUDE_SHARED_ROOT = tmp4.base;
        delete process.env.HERMES_CROSS_PROJECT;

        const origEmbed = EmbeddingStore.prototype.embed;
        EmbeddingStore.prototype.embed = async function (texts) { return fakeEmbed(texts); };
        try {
          const store = new EmbeddingStore({ projectDir: tmp4.base });
          await store.indexCrossProject({ sharedRoot: tmp4.base });

          const bridge = new HermesBridge({ projectDir: path.join(tmp4.base, 'fakecurrent') });
          const result = await bridge.getRelevantMemories('nginx deploy');
          assert(Array.isArray(result.cross), 'cross must be array');
          assert(result.cross.length === 0, `expected 0 cross hits when env off, got ${result.cross.length}`);
        } finally {
          EmbeddingStore.prototype.embed = origEmbed;
        }
      } finally {
        delete process.env.CLAUDE_SHARED_ROOT;
        rmrf(tmp4.base);
      }
    });

    // ---- Hermes bridge: env ON ----
    await test('HermesBridge: HERMES_CROSS_PROJECT=1 → cross hits included', async () => {
      const tmp5 = mkTmpShared();
      try {
        process.env.CLAUDE_SHARED_ROOT = tmp5.base;
        process.env.HERMES_CROSS_PROJECT = '1';

        const origEmbed = EmbeddingStore.prototype.embed;
        EmbeddingStore.prototype.embed = async function (texts) { return fakeEmbed(texts); };
        try {
          const store = new EmbeddingStore({ projectDir: tmp5.base });
          await store.indexCrossProject({ sharedRoot: tmp5.base });

          const bridge = new HermesBridge({ projectDir: path.join(tmp5.base, 'fakecurrent') });
          // Ha threshold cho fake embeddings (score khong cao bang real)
          const result = await bridge.getRelevantMemories('nginx deploy pm2', { crossThreshold: 0 });
          assert(Array.isArray(result.cross), 'cross must be array');
          assert(result.cross.length > 0, `expected >0 cross hits when env on, got ${result.cross.length}`);
          const h = result.cross[0];
          assert(h.project && h.file, 'cross hit must have project + file');
          const formatted = bridge.formatMemoriesForPrompt(result);
          assert(formatted.includes('[project='), 'formatted output must contain [project=X] attribution');
        } finally {
          EmbeddingStore.prototype.embed = origEmbed;
          delete process.env.HERMES_CROSS_PROJECT;
        }
      } finally {
        delete process.env.CLAUDE_SHARED_ROOT;
        rmrf(tmp5.base);
      }
    });

  } finally {
    rmrf(tmp.base);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
