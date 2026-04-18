#!/usr/bin/env node
/**
 * File Manager — Đọc/ghi/sửa file an toàn cho AI Agent
 *
 * Tất cả operations:
 * - Validate path (không cho thoát khỏi project root)
 * - UTF-8 encoding
 * - Line numbers trong output (AI dễ reference)
 * - Search & replace (edit_file) thay vì ghi đè toàn bộ → tiết kiệm token
 */

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');
const { ShadowGit } = require('./shadow-git');

// Patterns bỏ qua khi list/search
const IGNORE_PATTERNS = [
  '**/node_modules/**', '**/.git/**', '**/__pycache__/**',
  '**/dist/**', '**/build/**', '**/.next/**', '**/.nuxt/**',
  '**/coverage/**', '**/.turbo/**', '**/vendor/**'
];

// File nhạy cảm — chặn đọc/ghi ngay cả trong project dir
// (mo rong: ssh keys, cloud creds, package manager tokens)
const SENSITIVE_FILE_PATTERNS = [
  '.env', '.env.local', '.env.production', '.env.staging', '.env.development', '.env.test',
  'id_rsa', 'id_dsa', 'id_ed25519', 'id_ecdsa',
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.htpasswd',
  'master.key', 'secret_key_base.key'
];
const SENSITIVE_EXT = ['.key', '.pem', '.pfx', '.p12', '.pkcs12', '.jks', '.asc'];
// Path patterns — match full resolved path (Windows + Unix)
const SENSITIVE_PATH_PATTERNS = [
  /[\/\\]\.ssh[\/\\][^\/\\]/,                    // .ssh/<any>
  /[\/\\]\.aws[\/\\](credentials|config)$/i,      // .aws/credentials
  /[\/\\]\.gcp[\/\\]/i,                           // .gcp/*
  /[\/\\]\.azure[\/\\]/i,                         // .azure/*
  /[\/\\]\.docker[\/\\]config\.json$/i,           // .docker/config.json
  /[\/\\]\.kube[\/\\]config$/i,                   // .kube/config
  /[\/\\]gcloud[\/\\](legacy_)?credentials/i,     // gcloud creds
  /[\/\\]secrets?[\/\\].+\.(json|ya?ml|txt|env)$/i // secrets/*.{json,yaml,yml,txt,env}
];

function isSensitivePath(resolved) {
  const basename = path.basename(resolved);
  const ext = path.extname(resolved).toLowerCase();
  if (SENSITIVE_FILE_PATTERNS.includes(basename)) return `Sensitive filename: ${basename}`;
  if (SENSITIVE_EXT.includes(ext)) return `Sensitive extension: ${ext}`;
  for (const pat of SENSITIVE_PATH_PATTERNS) {
    if (pat.test(resolved)) return `Sensitive path pattern: ${pat.source}`;
  }
  return null;
}

class FileManager {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    // Danh sách thư mục ngoài project được phép đọc (cross-project references)
    this.readableRoots = (options.readableRoots || []).map(r => path.normalize(r));
    // Shadow Git — auto snapshot truoc khi AI ghi file
    this.shadowGit = new ShadowGit(this.projectDir, {
      enabled: options.shadowGit !== false  // Mac dinh bat
    });
  }

  /**
   * Validate & resolve path — chống path traversal
   * Chặn CẢ đọc lẫn ghi ra ngoài project dir (trừ readableRoots)
   */
  _resolvePath(filePath) {
    const resolved = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(this.projectDir, filePath);

    return resolved;
  }

  /**
   * Validate đường dẫn đọc — chặn path traversal + file nhạy cảm
   * - Chỉ cho đọc trong project dir hoặc readableRoots
   * - Luôn chặn file .env, .key, .pem dù ở đâu
   */
  _validateReadPath(filePath) {
    const resolved = this._resolvePath(filePath);
    const projectNorm = path.normalize(this.projectDir);

    // Kiểm tra path nằm trong project dir hoặc readableRoots
    const isInProject = resolved.startsWith(projectNorm + path.sep) || resolved === projectNorm;
    const isInReadableRoot = this.readableRoots.some(root =>
      resolved.startsWith(root + path.sep) || resolved === root
    );

    if (!isInProject && !isInReadableRoot) {
      throw new Error(
        `BLOCKED: Không được đọc file ngoài project directory.\n` +
        `Path: ${resolved}\nProject: ${projectNorm}`
      );
    }

    // Chặn file nhạy cảm — ngay cả trong project dir
    const reason = isSensitivePath(resolved);
    if (reason) {
      throw new Error(`BLOCKED: Không được đọc file nhạy cảm — ${reason}`);
    }

    return resolved;
  }

  _validateWritePath(filePath) {
    const resolved = this._resolvePath(filePath);
    const projectNorm = path.normalize(this.projectDir);

    // Dung path.sep de tranh false positive: /app match /app-evil
    if (!resolved.startsWith(projectNorm + path.sep) && resolved !== projectNorm) {
      throw new Error(`BLOCKED: Không được ghi file ngoài project directory.\nPath: ${resolved}\nProject: ${projectNorm}`);
    }

    // Chặn ghi vào file nhạy cảm
    const reason = isSensitivePath(resolved);
    if (reason) {
      throw new Error(`BLOCKED: Không được ghi file nhạy cảm — ${reason}`);
    }

    return resolved;
  }

  // =============================================
  // READ FILE
  // =============================================

  async readFile({ path: filePath, offset = 0, limit = 200 }) {
    let resolved;
    try {
      resolved = this._validateReadPath(filePath);
    } catch (e) {
      return { success: false, error: e.message };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, error: `File không tồn tại: ${filePath}` };
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { success: false, error: `"${filePath}" là thư mục, dùng list_files thay vì read_file` };
    }

    // Kiểm tra file quá lớn (> 1MB)
    if (stat.size > 1024 * 1024) {
      return {
        success: false,
        error: `File quá lớn (${Math.round(stat.size / 1024)}KB). Dùng offset/limit để đọc từng phần.`
      };
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    // Apply offset + limit
    const sliced = lines.slice(offset, offset + limit);
    const numbered = sliced.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');

    return {
      success: true,
      content: numbered,
      total_lines: totalLines,
      showing: `${offset + 1}-${offset + sliced.length}`,
      truncated: totalLines > offset + limit
    };
  }

  // =============================================
  // WRITE FILE
  // =============================================

  async writeFile({ path: filePath, content }) {
    let resolved;
    try {
      resolved = this._validateWritePath(filePath);
    } catch (e) {
      return { success: false, error: e.message };
    }

    // Shadow snapshot SAU validation — tranh tao stash cho request bi reject
    await this.shadowGit.ensureSnapshot('pre-ai-write');

    // Tạo thư mục cha nếu chưa có
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const isNew = !fs.existsSync(resolved);
    fs.writeFileSync(resolved, content, 'utf-8');

    const lines = content.split('\n').length;
    return {
      success: true,
      action: isNew ? 'created' : 'overwritten',
      path: path.relative(this.projectDir, resolved),
      lines
    };
  }

  // =============================================
  // EDIT FILE (Search & Replace)
  // =============================================

  async editFile({ path: filePath, old_string, new_string, replace_all = false }) {
    let resolved;
    try {
      resolved = this._validateWritePath(filePath);
    } catch (e) {
      return { success: false, error: e.message };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, error: `File không tồn tại: ${filePath}` };
    }

    // Shadow snapshot SAU validation + existence check — tranh stash spam
    await this.shadowGit.ensureSnapshot('pre-ai-edit');

    let content = fs.readFileSync(resolved, 'utf-8');

    // Kiểm tra old_string có tồn tại
    if (!content.includes(old_string)) {
      // Gợi ý: có thể do whitespace/indentation khác
      const trimmedMatch = content.split('\n').find(line =>
        line.trim() === old_string.trim()
      );
      const hint = trimmedMatch
        ? `\nGợi ý: Tìm thấy dòng tương tự nhưng khác indentation: "${trimmedMatch}"`
        : '';
      return {
        success: false,
        error: `old_string không tìm thấy trong file.${hint}`
      };
    }

    // Đếm occurrences
    const occurrences = content.split(old_string).length - 1;

    if (occurrences > 1 && !replace_all) {
      return {
        success: false,
        error: `old_string xuất hiện ${occurrences} lần. Dùng replace_all: true để thay tất cả, hoặc cung cấp context dài hơn để match chính xác 1 chỗ.`
      };
    }

    // Replace
    if (replace_all) {
      content = content.split(old_string).join(new_string);
    } else {
      content = content.replace(old_string, new_string);
    }

    fs.writeFileSync(resolved, content, 'utf-8');

    return {
      success: true,
      path: path.relative(this.projectDir, resolved),
      replacements: replace_all ? occurrences : 1
    };
  }

  // =============================================
  // LIST FILES
  // =============================================

  async listFiles({ path: dirPath = '.', pattern = '*', max_depth = 3 }) {
    let resolved;
    try {
      resolved = this._validateReadPath(dirPath);
    } catch (e) {
      return { success: false, error: e.message };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, error: `Thư mục không tồn tại: ${dirPath}` };
    }

    const globPattern = pattern.includes('*')
      ? pattern
      : `**/${pattern}`;

    const entries = await fg(globPattern, {
      cwd: resolved,
      ignore: IGNORE_PATTERNS,
      deep: max_depth,
      onlyFiles: false,
      markDirectories: true,
      dot: false
    });

    // Giới hạn 100 entries
    const limited = entries.slice(0, 100);

    return {
      success: true,
      cwd: path.relative(this.projectDir, resolved) || '.',
      files: limited,
      total: entries.length,
      truncated: entries.length > 100
    };
  }

  // =============================================
  // SEARCH FILES (grep)
  // =============================================

  async searchFiles({ pattern, path: searchPath = '.', include, max_results = 20 }) {
    let resolved;
    try {
      resolved = this._validateReadPath(searchPath);
    } catch (e) {
      return { success: false, error: e.message };
    }
    const results = [];

    // Neu path la file → search 1 file, khong glob
    // Tra ve: { success, results: [{file, line, content}] }
    let files;
    let baseDir;
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        baseDir = path.dirname(resolved);
        files = [path.basename(resolved)];
      } else {
        baseDir = resolved;
        const globPattern = include || '**/*';
        files = await fg(globPattern, {
          cwd: resolved,
          ignore: IGNORE_PATTERNS,
          onlyFiles: true,
          deep: 10
        });
      }
    } catch (e) {
      return { success: false, error: `Path not found or inaccessible: ${searchPath}` };
    }

    const regex = new RegExp(pattern, 'gi');

    for (const file of files) {
      if (results.length >= max_results) break;

      const fullPath = path.join(baseDir, file);
      try {
        const stat = fs.statSync(fullPath);
        // Bỏ qua file lớn (> 500KB) hoặc binary
        if (stat.size > 500 * 1024) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        // Kiểm tra binary
        if (content.includes('\0')) continue;

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({
              file,
              line: i + 1,
              content: lines[i].trim().slice(0, 200)
            });
            regex.lastIndex = 0; // Reset regex
            if (results.length >= max_results) break;
          }
        }
      } catch {
        // Bỏ qua file không đọc được
      }
    }

    return {
      success: true,
      pattern,
      results,
      total: results.length
    };
  }
}

module.exports = { FileManager };
