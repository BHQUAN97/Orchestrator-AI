#!/usr/bin/env node
/**
 * Conversation Manager — Quản lý session cho AI Coding Agent
 *
 * Mỗi phiên làm việc (session) được lưu trong `.orcai/sessions/`:
 * - {id}.json         → messages, filesChanged, commandsRun, toolStats
 * - {id}.changes.json → danh sách file changes (hỗ trợ undo)
 *
 * FEATURES:
 * - Tạo/load/list sessions với auto-cleanup (>7 ngày tự xóa)
 * - Record file changes + undo lần thay đổi cuối
 * - Auto-compress messages khi vượt 100 entries
 * - Session summary từ messages và changes
 */

const fs = require('fs');
const path = require('path');

// Thời gian giữ session (7 ngày)
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Ngưỡng nén messages
const MESSAGE_COMPRESS_THRESHOLD = 100;

class ConversationManager {
  /**
   * @param {Object} options
   * @param {string} options.projectDir - Thư mục gốc của project
   * @param {string} [options.sessionDir] - Thư mục lưu session (default: projectDir/.orcai)
   */
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.sessionDir = options.sessionDir || path.join(this.projectDir, '.orcai');
    this.sessionsPath = path.join(this.sessionDir, 'sessions');

    // Tạo thư mục nếu chưa có
    this._ensureDir(this.sessionsPath);
  }

  /**
   * Tạo session mới
   * @returns {{ id: string, createdAt: string, projectDir: string }}
   */
  createSession() {
    const id = this._generateId();
    const createdAt = new Date().toISOString();
    const session = { id, createdAt, projectDir: this.projectDir };

    // Lưu file session với data rỗng
    const data = {
      ...session,
      messages: [],
      filesChanged: [],
      commandsRun: [],
      toolStats: {},
    };
    this._writeJson(this._sessionFile(id), data);

    // Tạo file changes rỗng
    this._writeJson(this._changesFile(id), []);

    return session;
  }

  /**
   * Lưu trạng thái session
   * @param {string} sessionId
   * @param {Object} data - { messages, filesChanged, commandsRun, toolStats }
   */
  saveSession(sessionId, data) {
    const filePath = this._sessionFile(sessionId);
    const existing = this._readJson(filePath);
    if (!existing) return;

    // Merge data vào session hiện tại
    const updated = { ...existing, ...data };

    // Luu git HEAD de warm-context invalidation
    if (!updated.gitHead) {
      try {
        const { execSync } = require('child_process');
        updated.gitHead = execSync('git rev-parse HEAD', { cwd: this.projectDir, stdio: ['pipe','pipe','pipe'] }).toString().trim();
      } catch { /* no git */ }
    }

    // Auto-compress messages nếu vượt ngưỡng
    if (updated.messages && updated.messages.length > MESSAGE_COMPRESS_THRESHOLD) {
      updated.messages = this._compressMessages(updated.messages);
    }

    this._writeJson(filePath, updated);
  }

  /**
   * Load session theo ID
   * @param {string} sessionId
   * @returns {Object|null} Session data hoặc null nếu không tìm thấy
   */
  loadSession(sessionId) {
    return this._readJson(this._sessionFile(sessionId));
  }

  /**
   * Liệt kê sessions gần đây, tự động xóa sessions cũ hơn 7 ngày
   * @param {number} [limit=10] - Số lượng sessions tối đa trả về
   * @returns {Array<{ id: string, createdAt: string, summary: string }>}
   */
  listSessions(limit = 10) {
    this._cleanupOldSessions();

    const files = this._listSessionFiles();
    // Sắp xếp mới nhất trước
    const sessions = files
      .map((file) => {
        const data = this._readJson(path.join(this.sessionsPath, file));
        if (!data) return null;
        return {
          id: data.id,
          createdAt: data.createdAt,
          summary: this._buildSummary(data),
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return sessions.slice(0, limit);
  }

  /**
   * Lấy session gần nhất
   * @returns {Object|null} Session data hoặc null
   */
  getLastSession() {
    const files = this._listSessionFiles();
    if (files.length === 0) return null;

    // Đọc tất cả, tìm session mới nhất
    let latest = null;
    let latestTime = 0;

    for (const file of files) {
      const data = this._readJson(path.join(this.sessionsPath, file));
      if (!data || !data.createdAt) continue;
      const time = new Date(data.createdAt).getTime();
      if (time > latestTime) {
        latestTime = time;
        latest = data;
      }
    }

    return latest;
  }

  /**
   * Lay noi dung cac file da doc tu session truoc de inject vao system prompt.
   * KHONG inject raw messages (tranh malformed history).
   * Chi extract text content tu tool results co name = read_file.
   *
   * @param {Object} opts
   * @param {number} [opts.maxAgeMs=1800000] - 30 phut
   * @param {string} [opts.currentGitHead]
   * @param {number} [opts.maxFiles=10] - gioi han so file inject
   * @returns {{ path: string, content: string }[]} danh sach file da doc
   */
  getWarmContext({ maxAgeMs = 30 * 60 * 1000, currentGitHead, maxFiles = 10 } = {}) {
    const last = this.getLastSession();
    if (!last || !last.messages || last.messages.length === 0) return [];

    // Phai cung projectDir — KHONG lan context giua cac project khac nhau
    if (last.projectDir && last.projectDir !== this.projectDir) return [];

    const age = Date.now() - new Date(last.createdAt).getTime();
    if (age > maxAgeMs) return [];

    // Neu git HEAD da doi → code thay doi → file content cu co the stale → bo qua
    if (currentGitHead && last.gitHead && last.gitHead !== currentGitHead) return [];

    // Extract file content tu tool results (role=tool, name=read_file)
    const files = [];
    const seen = new Set();
    for (const msg of last.messages) {
      if (msg.role !== 'tool') continue;
      try {
        // OpenAI format: msg.content la JSON string chua tool result
        const result = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        // read_file result co dang: { success, path, content, total_lines, showing }
        if (result && result.success && result.path && typeof result.content === 'string') {
          if (!seen.has(result.path)) {
            seen.add(result.path);
            files.push({ path: result.path, content: result.content });
            if (files.length >= maxFiles) break;
          }
        }
      } catch { /* ignore parse errors */ }
    }
    return files;
  }

  /**
   * Ghi nhận thay đổi file (dùng cho undo)
   * @param {string} sessionId
   * @param {{ type: 'write'|'edit', path: string, before: string, after: string, timestamp?: string }} change
   */
  recordChange(sessionId, change) {
    const filePath = this._changesFile(sessionId);
    const changes = this._readJson(filePath) || [];

    changes.push({
      ...change,
      timestamp: change.timestamp || new Date().toISOString(),
    });

    this._writeJson(filePath, changes);
  }

  /**
   * Undo thay đổi file cuối cùng trong session
   * @param {string} sessionId
   * @returns {Object|null} Change đã undo, hoặc null nếu không có gì để undo
   */
  undo(sessionId) {
    const filePath = this._changesFile(sessionId);
    const changes = this._readJson(filePath);
    if (!changes || changes.length === 0) return null;

    // Lấy change cuối cùng
    const lastChange = changes.pop();

    // Khôi phục file về trạng thái trước
    try {
      if (lastChange.before === null || lastChange.before === undefined) {
        // File không tồn tại trước đó → xóa
        if (fs.existsSync(lastChange.path)) {
          fs.unlinkSync(lastChange.path);
        }
      } else {
        // Ghi lại nội dung cũ
        const dir = path.dirname(lastChange.path);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(lastChange.path, lastChange.before, 'utf-8');
      }
    } catch (err) {
      // Nếu revert thất bại, đẩy lại change và return null
      changes.push(lastChange);
      this._writeJson(filePath, changes);
      return null;
    }

    // Cập nhật file changes
    this._writeJson(filePath, changes);
    return lastChange;
  }

  /**
   * Tạo tóm tắt 1 dòng cho session
   * @param {string} sessionId
   * @returns {string} Tóm tắt ngắn gọn
   */
  getSessionSummary(sessionId) {
    const data = this._readJson(this._sessionFile(sessionId));
    if (!data) return 'Session not found';
    return this._buildSummary(data);
  }

  // ─── Private helpers ─────────────────────────────────────

  /**
   * Tạo ID duy nhất cho session (timestamp + random hex)
   */
  _generateId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
  }

  /**
   * Đường dẫn file session chính
   */
  _sessionFile(id) {
    return path.join(this.sessionsPath, `${id}.json`);
  }

  /**
   * Đường dẫn file changes của session
   */
  _changesFile(id) {
    return path.join(this.sessionsPath, `${id}.changes.json`);
  }

  /**
   * Tạo thư mục nếu chưa tồn tại
   */
  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Đọc JSON file, trả về null nếu lỗi
   */
  _readJson(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Ghi JSON file
   */
  _writeJson(filePath, data) {
    this._ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Liệt kê tất cả file session (không bao gồm .changes.json)
   */
  _listSessionFiles() {
    try {
      return fs.readdirSync(this.sessionsPath)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.changes.json'));
    } catch {
      return [];
    }
  }

  /**
   * Xóa sessions cũ hơn 7 ngày
   */
  _cleanupOldSessions() {
    const now = Date.now();
    const files = this._listSessionFiles();

    for (const file of files) {
      const data = this._readJson(path.join(this.sessionsPath, file));
      if (!data || !data.createdAt) continue;

      const age = now - new Date(data.createdAt).getTime();
      if (age > SESSION_MAX_AGE_MS) {
        const id = data.id || file.replace('.json', '');
        // Xóa cả session file và changes file
        try { fs.unlinkSync(this._sessionFile(id)); } catch { /* ignore */ }
        try { fs.unlinkSync(this._changesFile(id)); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Nén messages: giữ 20 đầu + 30 cuối, phần giữa gộp thành summary
   * @param {Array} messages
   * @returns {Array} Messages đã nén
   */
  _compressMessages(messages) {
    const keepHead = 20;
    const keepTail = 30;

    if (messages.length <= keepHead + keepTail) return messages;

    const head = messages.slice(0, keepHead);
    const tail = messages.slice(-keepTail);
    const skipped = messages.length - keepHead - keepTail;

    // Chèn marker giữa head và tail
    const marker = {
      role: 'system',
      content: `[Compressed: ${skipped} messages omitted]`,
      _compressed: true,
      _skippedCount: skipped,
    };

    return [...head, marker, ...tail];
  }

  /**
   * Tạo tóm tắt 1 dòng từ session data
   */
  _buildSummary(data) {
    const parts = [];

    // Số messages
    const msgCount = (data.messages || []).length;
    if (msgCount > 0) parts.push(`${msgCount} msgs`);

    // Số files thay đổi
    const fileCount = (data.filesChanged || []).length;
    if (fileCount > 0) parts.push(`${fileCount} files`);

    // Số commands đã chạy
    const cmdCount = (data.commandsRun || []).length;
    if (cmdCount > 0) parts.push(`${cmdCount} cmds`);

    // Tool usage
    const toolKeys = Object.keys(data.toolStats || {});
    if (toolKeys.length > 0) parts.push(`tools: ${toolKeys.join(',')}`);

    return parts.length > 0 ? parts.join(' | ') : 'Empty session';
  }
}

module.exports = { ConversationManager };
