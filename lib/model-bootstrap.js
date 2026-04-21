#!/usr/bin/env node
/**
 * ModelBootstrap — Auto-start local models, retry 3 lần, fallback cloud-only
 *
 * Flow:
 *   1. Ping LM Studio server (localhost:1234/health)
 *   2. Nếu offline → lms server start → wait → retry
 *   3. Kiểm tra model cần thiết có loaded chưa (lms ps)
 *   4. Nếu chưa → lms load <model> → wait → retry
 *   5. Sau 3 lần fail → { available: false } → caller dùng cloud-only flow
 *
 * Retry strategy: exponential backoff 1s → 2s → 4s
 * Total max wait: ~7s trước khi fallback (không block quá lâu)
 */

const { execFileSync, spawn } = require('child_process');

const LMSTUDIO_URL = process.env.LMSTUDIO_URL || 'http://localhost:1234';
const LMS_CLI = process.env.LMS_CLI || 'lms';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// Models cần cho LocalAssistant — theo thứ tự ưu tiên
const REQUIRED_MODELS = {
  embed: 'text-embedding-nomic-embed-text-v1.5@q4_k_m',
  llm:   'local-heavy'   // identifier trong LM Studio (maps to qwen2.5-coder-7b-ft)
};

class ModelBootstrap {
  constructor(options = {}) {
    this.lmUrl = options.lmUrl || LMSTUDIO_URL;
    this.lmsCli = options.lmsCli || LMS_CLI;
    this.maxRetries = options.maxRetries || MAX_RETRIES;
    this.baseDelay = options.baseDelay || BASE_DELAY_MS;
    this._log = options.log || (() => {}); // callback(msg, level)
  }

  /**
   * Đảm bảo LM Studio server + required models sẵn sàng.
   * @returns {Promise<{ available: boolean, reason?: string, models: string[] }>}
   */
  async ensure(modelsNeeded = ['embed', 'llm']) {
    // Bước 1: Đảm bảo server chạy
    const serverOk = await this._ensureServer();
    if (!serverOk) {
      return { available: false, reason: 'server_offline', models: [] };
    }

    // Bước 2: Đảm bảo từng model loaded
    const loaded = [];
    for (const key of modelsNeeded) {
      const modelId = REQUIRED_MODELS[key];
      if (!modelId) continue;

      // Skip LLM nếu VRAM không đủ — embed ~300MB, LLM ~4.5GB (7B Q4_K_M)
      // Chỉ check VRAM khi LLM CHƯA load — nếu đã load rồi thì VRAM đang bị dùng bởi nó rồi
      if (key === 'llm') {
        const alreadyLoaded = await this._isModelLoaded(modelId);
        if (!alreadyLoaded) {
          const vram = await this._checkVram(4000);
          if (!vram.ok) {
            this._log(`  ⚠ VRAM thấp (${vram.freeMb}MB free < 4000MB) — bỏ qua LLM, chỉ dùng embed`, 'warn');
            continue;
          }
        }
      }

      const ok = await this._ensureModel(modelId);
      if (ok) loaded.push(key);
      else this._log(`  ⚠ Model ${key} (${modelId}) unavailable — skipping`, 'warn');
    }

    // embed là bắt buộc — nếu không có thì không dùng được LocalAssistant
    if (modelsNeeded.includes('embed') && !loaded.includes('embed')) {
      return { available: false, reason: 'embed_unavailable', models: loaded };
    }

    return { available: true, models: loaded };
  }

  // ─── Server ────────────────────────────────────────────────────────────────

  async _ensureServer() {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (await this._pingServer()) return true;

      if (attempt === 1) {
        this._log('  🔄 LM Studio offline — thử khởi động server...', 'info');
        this._startServer();
      }

      await this._sleep(this.baseDelay * Math.pow(2, attempt - 1));
    }
    return false;
  }

  async _pingServer() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${this.lmUrl}/v1/models`, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  _startServer() {
    try {
      // lms server start — non-blocking, daemon mode
      spawn(this.lmsCli, ['server', 'start'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    } catch (e) {
      this._log(`  ⚠ lms server start failed: ${e.message}`, 'warn');
    }
  }

  // ─── Model ─────────────────────────────────────────────────────────────────

  async _ensureModel(modelId) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (await this._isModelLoaded(modelId)) return true;

      if (attempt === 1) {
        this._log(`  🔄 Loading model ${modelId}...`, 'info');
        this._loadModel(modelId);
      }

      await this._sleep(this.baseDelay * Math.pow(2, attempt - 1));
    }
    return false;
  }

  async _isModelLoaded(modelId) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${this.lmUrl}/v1/models`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const data = await res.json();
      return (data.data || []).some(m =>
        m.id === modelId ||
        m.id?.includes(modelId.split('/').pop()) ||
        (m.object === 'model' && m.id?.toLowerCase().includes(modelId.split('-').slice(0, 3).join('-').toLowerCase()))
      );
    } catch {
      return false;
    }
  }

  _loadModel(modelId) {
    try {
      // lms load <identifier> --context-length 4096 --gpu off (nếu GTX 1060 hết VRAM)
      spawn(this.lmsCli, ['load', modelId], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    } catch (e) {
      this._log(`  ⚠ lms load ${modelId} failed: ${e.message}`, 'warn');
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Kiểm tra VRAM còn trống qua nvidia-smi.
   * Trả về { ok: true } nếu không có GPU hoặc không check được.
   */
  async _checkVram(minFreeMb = 4000) {
    try {
      const { execSync } = require('child_process');
      const out = execSync(
        'nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits',
        { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString().trim().split('\n')[0];
      const freeMb = parseInt(out, 10);
      if (isNaN(freeMb)) return { ok: true, freeMb: null };
      return { ok: freeMb >= minFreeMb, freeMb };
    } catch {
      return { ok: true, freeMb: null }; // nvidia-smi không có → assume ok
    }
  }

  /**
   * Quick status check — không retry, chỉ ping một lần
   */
  async quickCheck() {
    const serverUp = await this._pingServer();
    if (!serverUp) return { up: false };
    const embedOk = await this._isModelLoaded(REQUIRED_MODELS.embed);
    const llmOk = await this._isModelLoaded(REQUIRED_MODELS.llm);
    return { up: true, embed: embedOk, llm: llmOk };
  }
}

module.exports = { ModelBootstrap, REQUIRED_MODELS };
