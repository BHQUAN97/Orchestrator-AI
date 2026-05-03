#!/usr/bin/env node
/**
 * LocalAssistant — Local Qwen 7B lam helper cho cloud models
 *
 * Vai tro: doc file, tom tat noi dung dai, pre-select context lien quan
 * Model: local-heavy (qwen2.5-coder-7b) qua LM Studio localhost:1234
 * Chi phi: $0 (local, offline)
 *
 * Workflow:
 *   1. User query → embed (nomic) → tim files lien quan
 *   2. Doc files do → neu dai → Qwen 7B tom tat → ~500 chars/file
 *   3. Inject context gon vao system prompt → cloud model tra loi it token hon
 *
 * Context isolation: moi query → embedding khac → files khac → khong lan context
 *
 * Auto-rebuild: index tu dong rebuild neu stale (>6h hoac truoc ngay hom nay).
 * Spawn non-blocking khi session start, await toi da 5s truoc query dau tien.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { ModelBootstrap } = require('./model-bootstrap');

const LMSTUDIO_URL = process.env.LMSTUDIO_URL || 'http://localhost:1234';
const LOCAL_MODEL = 'local-heavy'; // identifier trong LM Studio
const SUMMARIZE_THRESHOLD = 1500;
const MAX_FILES_INJECT = 6;
const MAX_CHARS_PER_FILE = 3000;
const SUMMARIZE_CONTEXT_CHARS = 12000; // 8K → 12K cho Qwen 7B
const REBUILD_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 giờ
const REBUILD_AWAIT_MS = 5000; // tối đa 5s chờ rebuild trước query đầu

const EXAMPLES_PATH_REL = path.join('.orcai', 'embeddings', 'examples.index.json');
const REBUILD_SCRIPT = path.join(__dirname, '../bin/orcai-index-examples.js');

class LocalAssistant {
  constructor(options = {}) {
    this.lmUrl = options.lmUrl || LMSTUDIO_URL;
    this.model = options.model || LOCAL_MODEL;
    this.projectDir = options.projectDir || process.cwd();
    this.embeddings = options.embeddings || null;
    this._available = null; // null=unknown, true/false=kết quả bootstrap
    this._rebuildPromise = null; // promise của lần rebuild đang chạy
    this._rebuildScheduled = false;
    // onStatus(msg, type) — callback để caller hiển thị spinner/log thay vì hardcode stderr
    this.onStatus = options.onStatus || ((msg) => process.stderr.write(msg + '\n'));
    this._bootstrap = new ModelBootstrap({
      lmUrl: this.lmUrl,
      log: (msg, level) => {
        if (level === 'warn') process.stderr.write(msg + '\n');
      }
    });
  }

  /**
   * Kiem tra + auto-start models neu can.
   * Retry 3 lan, fallback cloud-only neu fail.
   * Ket qua duoc cache — chi chay 1 lan/session.
   * Sau khi available: schedule rebuild neu index stale.
   */
  async isAvailable() {
    if (this._available !== null) return this._available;
    try {
      const quick = await this._bootstrap.quickCheck();
      if (quick.up && quick.embed) {
        this._available = true;
      } else {
        const result = await this._bootstrap.ensure(['embed', 'llm']);
        this._available = result.available;
        if (!result.available) {
          process.stderr.write(`  ℹ Local assist unavailable (${result.reason}) — dùng cloud-only\n`);
        }
      }
    } catch {
      this._available = false;
    }

    // Schedule index rebuild ngay sau khi local available
    if (this._available) {
      const examplesPath = path.join(this.projectDir, EXAMPLES_PATH_REL);
      this._scheduleRebuildIfStale(examplesPath);
    }

    return this._available;
  }

  /**
   * Kiem tra index co stale khong:
   * - Khong ton tai → rebuild
   * - mtime truoc nua dem hom nay (session dau ngay) → rebuild
   * - mtime > 6h truoc → rebuild
   */
  _isIndexStale(examplesPath) {
    try {
      const stat = fs.statSync(examplesPath);
      const now = Date.now();
      const startOfToday = new Date().setHours(0, 0, 0, 0);
      return stat.mtimeMs < startOfToday || (now - stat.mtimeMs) > REBUILD_MAX_AGE_MS;
    } catch {
      return true; // file khong ton tai → stale
    }
  }

  /**
   * Spawn orcai-index-examples.js trong background.
   * Luu promise → buildContextBlock co the await truoc query.
   */
  _scheduleRebuildIfStale(examplesPath) {
    if (this._rebuildScheduled) return;
    if (!this._isIndexStale(examplesPath)) return;

    this._rebuildScheduled = true;
    this.onStatus('Index stale — rebuilding in background...', 'rebuild-start');

    this._rebuildPromise = new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };

      // Timeout an toan 2 phut
      const timer = setTimeout(() => finish(false), 120000);

      try {
        const child = spawn(process.execPath, [REBUILD_SCRIPT, '--root', this.projectDir], {
          cwd: this.projectDir,
          stdio: ['ignore', 'ignore', 'ignore'], // ignore all — tránh deadlock khi stdout lớn
          env: {
            ...process.env,
            // Override endpoint → LM Studio trực tiếp (bỏ qua LiteLLM auth)
            LMSTUDIO_EMBED_ENDPOINT: this.lmUrl,
            EMBED_MODEL: 'text-embedding-nomic-embed-text-v1.5@q4_k_m'
          }
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const ok = code === 0;
          if (ok) this.onStatus('Index rebuilt', 'rebuild-done');
          else this.onStatus(`Rebuild exit ${code}`, 'rebuild-warn');
          finish(ok);
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          this.onStatus(`Rebuild spawn error: ${e.message}`, 'rebuild-warn');
          finish(false);
        });
      } catch (e) {
        clearTimeout(timer);
        this.onStatus(`Cannot spawn rebuild: ${e.message}`, 'rebuild-warn');
        finish(false);
      }
    });
  }

  /**
   * Pre-select va inject file context lien quan vao system prompt.
   * Dung embedding search tim files → doc → tom tat neu can → tra ve block inject.
   *
   * @param {string} userQuery - cau hoi cua user
   * @param {number} [topK=6] - so file toi da inject
   * @param {string[]} [searchTerms=[]] - targeted terms tu RequestAnalyzer (uu tien cao hon)
   * @returns {Promise<{ block: string, files: string[], source: string }>}
   */
  async buildContextBlock(userQuery, topK = MAX_FILES_INJECT, searchTerms = []) {
    if (!userQuery) return { block: '', files: [], source: 'skip' };

    // Neu co searchTerms tu RequestAnalyzer, ghep vao query de embedding search chinh xac hon
    const effectiveQuery = searchTerms.length > 0
      ? `${userQuery}\n${searchTerms.join(' ')}`
      : userQuery;

    const avail = await this.isAvailable();
    if (!avail) return { block: '', files: [], source: 'offline' };

    const examplesPath = path.join(this.projectDir, EXAMPLES_PATH_REL);

    // Neu rebuild dang chay, doi toi da REBUILD_AWAIT_MS truoc khi query
    // (rebuild thu qua co the xong roi, cho nhanh; lan sau chac chan dung index moi)
    if (this._rebuildPromise) {
      await Promise.race([
        this._rebuildPromise,
        new Promise(r => setTimeout(r, REBUILD_AWAIT_MS))
      ]);
    }

    // Buoc 1: Tim files lien quan qua embedding search
    let candidateFiles = [];
    if (this.embeddings) {
      try {
        const { EmbeddingStore } = require('./embeddings');
        const store = new EmbeddingStore({
          projectDir: this.projectDir,
          endpoint: this.lmUrl,
          model: 'text-embedding-nomic-embed-text-v1.5@q4_k_m'
        });
        store.storeFile = examplesPath;
        store._loaded = false;

        const hits = await store.query({ text: effectiveQuery, top_k: topK * 2 });
        // Dedup theo file path — lay top file theo max score
        const fileScores = new Map();
        for (const h of hits || []) {
          const fp = h.metadata?.file || h.metadata?.path;
          if (!fp) continue;
          const cur = fileScores.get(fp) || 0;
          if (h.score > cur) fileScores.set(fp, h.score);
        }
        candidateFiles = [...fileScores.entries()]
          .filter(([, score]) => score >= 0.40)
          .sort((a, b) => b[1] - a[1])
          .slice(0, topK)
          .map(([fp]) => fp);
      } catch (e) {
        process.stderr.write(`[local-assist] embed search failed: ${e.message}\n`);
      }
    }

    if (candidateFiles.length === 0) return { block: '', files: [], source: 'no-embed' };

    // Buoc 2: Doc file + summarize neu can
    const sections = [];
    const injectedPaths = [];
    const lmAvail = await this.isAvailable();

    for (const filePath of candidateFiles) {
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.projectDir, filePath);

      let content;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch { continue; }

      const relPath = path.relative(this.projectDir, absPath).replace(/\\/g, '/');
      let snippet;

      if (content.length <= SUMMARIZE_THRESHOLD) {
        snippet = content.slice(0, MAX_CHARS_PER_FILE);
      } else if (lmAvail) {
        snippet = await this._summarize(content, relPath, userQuery);
      } else {
        snippet = content.slice(0, MAX_CHARS_PER_FILE) + '\n... [truncated]';
      }

      sections.push(`--- ${relPath} ---\n${snippet}`);
      injectedPaths.push(relPath);
    }

    if (sections.length === 0) return { block: '', files: [], source: 'read-fail' };

    const source = lmAvail ? 'local-qwen7b+embed' : 'embed-only';
    const block = `\n\n=== PRE-LOADED CONTEXT (isolated to query — local assistant) ===\n${sections.join('\n\n')}\n=== END PRE-LOADED ===`;
    return { block, files: injectedPaths, source };
  }

  /**
   * Dung Qwen 7B tom tat 1 file dai thanh ~500 chars phan lien quan den query.
   * Neu LM Studio fail → tra ve phan dau file.
   */
  async _summarize(content, filePath, query) {
    const truncated = content.slice(0, SUMMARIZE_CONTEXT_CHARS);
    // Prompt ràng buộc chặt: chỉ tóm tắt FILE, không trả lời query
    const prompt = `You are OrcAI's code summarizer tool. Your ONLY job is to summarize the contents of the file below.
DO NOT answer the query. DO NOT provide solutions or suggestions. DO NOT identify yourself as Claude, Gemini, or GPT.
Only describe what this file contains (exports, classes, functions, key logic) in max 500 characters.

Query context (use only to decide WHICH parts of the file are relevant): "${query}"
File: ${filePath}

Code:
${truncated}

File summary (describe what the file contains, max 500 chars):`;


    try {
      const res = await fetch(`${this.lmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.1,
          stream: false
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || truncated.slice(0, MAX_CHARS_PER_FILE);
    } catch {
      return truncated.slice(0, MAX_CHARS_PER_FILE) + '\n... [truncated]';
    }
  }
}

module.exports = { LocalAssistant };
