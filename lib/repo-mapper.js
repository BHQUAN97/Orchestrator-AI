#!/usr/bin/env node
/**
 * Repo Mapper — Quét cấu trúc project và tạo bản đồ compact cho AI context
 *
 * Module này scan thư mục project và tạo text representation gọn nhẹ
 * để inject vào system prompt của LLM. Giúp AI hiểu cấu trúc code
 * trước khi bắt đầu coding.
 *
 * OUTPUT bao gồm:
 * - Tree: cây thư mục (max depth 4)
 * - Exports: tên function/class exported từ JS/TS files
 * - Project Type: Next.js / NestJS / React+Vite / Express / Python / etc.
 * - Summary: tóm tắt compact (<2000 chars) sẵn sàng inject vào prompt
 *
 * USAGE:
 *   const { RepoMapper } = require('./lib/repo-mapper');
 *   const mapper = new RepoMapper({ projectDir: '/path/to/project' });
 *   const summary = await mapper.getCompactSummary();
 */

const path = require('path');
const fs = require('fs');
const fg = require('fast-glob');

// Thư mục/file bỏ qua khi scan
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/vendor/**',
  '**/*.map',
  '**/*.lock'
];

// Max depth cho tree display
const MAX_DEPTH = 4;
// Giới hạn ký tự cho compact summary
const MAX_SUMMARY_CHARS = 2000;

class RepoMapper {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.maxDepth = options.maxDepth || MAX_DEPTH;
    this.maxSummaryChars = options.maxSummaryChars || MAX_SUMMARY_CHARS;
  }

  /**
   * Scan toàn bộ project directory
   * @param {string} [projectDir] - Override project dir nếu cần
   * @returns {{ tree: string, exports: object, projectType: string, summary: string }}
   */
  async scan(projectDir) {
    const dir = projectDir || this.projectDir;
    const normalizedDir = path.resolve(dir);

    // Lấy danh sách file
    const files = await fg('**/*', {
      cwd: normalizedDir,
      ignore: IGNORE_PATTERNS,
      onlyFiles: true,
      dot: false
    });

    const tree = this._buildTree(files);
    const exports = await this._extractExports(normalizedDir, files);
    const projectType = await this._detectProjectType(normalizedDir, files);
    const pkgInfo = await this._extractPackageInfo(normalizedDir);
    const summary = this._buildSummary({ tree, exports, projectType, pkgInfo, fileCount: files.length });

    return { tree, exports, projectType, summary };
  }

  /**
   * Tạo compact summary sẵn inject vào system prompt
   * @param {string} [projectDir] - Override project dir nếu cần
   * @returns {string} Text summary compact
   */
  async getCompactSummary(projectDir) {
    const { summary } = await this.scan(projectDir);
    return summary;
  }

  /**
   * Build tree-like text từ danh sách file paths
   * Giới hạn theo maxDepth, gom file cùng thư mục
   */
  _buildTree(files) {
    // Tạo cây thư mục dạng nested object
    const root = {};

    for (const file of files) {
      const parts = file.split('/');
      // Giới hạn depth — bỏ file quá sâu
      if (parts.length > this.maxDepth + 1) continue;

      let current = root;
      for (const part of parts) {
        if (!current[part]) current[part] = {};
        current = current[part];
      }
    }

    // Render tree thành text
    const lines = [];
    const projectName = path.basename(this.projectDir);
    lines.push(`${projectName}/`);
    this._renderTree(root, lines, '', true);
    return lines.join('\n');
  }

  /**
   * Render recursive tree node thành text lines
   * Gom nhiều file cùng extension để tiết kiệm dòng
   */
  _renderTree(node, lines, prefix, isRoot) {
    const entries = Object.keys(node).sort((a, b) => {
      // Thư mục trước, file sau
      const aIsDir = Object.keys(node[a]).length > 0;
      const bIsDir = Object.keys(node[b]).length > 0;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    // Gom file cùng loại nếu quá nhiều (>5 file cùng extension)
    const dirs = [];
    const filesByExt = {};
    const standaloneFiles = [];

    for (const entry of entries) {
      const isDir = Object.keys(node[entry]).length > 0;
      if (isDir) {
        dirs.push(entry);
      } else {
        const ext = path.extname(entry) || '(no ext)';
        if (!filesByExt[ext]) filesByExt[ext] = [];
        filesByExt[ext].push(entry);
      }
    }

    // File ít → liệt kê, file nhiều cùng ext → gom
    for (const [ext, fileList] of Object.entries(filesByExt)) {
      if (fileList.length > 5) {
        standaloneFiles.push(`[${fileList.length} ${ext} files]`);
      } else {
        standaloneFiles.push(...fileList);
      }
    }

    const allEntries = [...dirs, ...standaloneFiles];
    for (let i = 0; i < allEntries.length; i++) {
      const entry = allEntries[i];
      const isLast = i === allEntries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      const isDir = dirs.includes(entry);

      lines.push(`${prefix}${connector}${entry}${isDir ? '/' : ''}`);

      // Đệ quy cho thư mục con
      if (isDir) {
        this._renderTree(node[entry], lines, prefix + childPrefix, false);
      }
    }
  }

  /**
   * Extract exported function/class names từ JS/TS files
   * Dùng regex — lightweight, không cần parser
   */
  async _extractExports(dir, files) {
    const exports = {};
    const jsFiles = files.filter(f => /\.(js|ts|jsx|tsx)$/.test(f) && !f.includes('.test.') && !f.includes('.spec.'));

    // Chỉ scan tối đa 30 file để giữ performance
    const filesToScan = jsFiles.slice(0, 30);

    for (const file of filesToScan) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const names = this._extractExportNames(content);
        if (names.length > 0) {
          exports[file] = names;
        }
      } catch {
        // Skip file không đọc được
      }
    }

    return exports;
  }

  /**
   * Regex extract exported names từ nội dung file
   * Hỗ trợ: export function, export class, module.exports, exports.X
   */
  _extractExportNames(content) {
    const names = new Set();

    // ES module exports
    // export function funcName
    const exportFuncRe = /export\s+(?:async\s+)?function\s+(\w+)/g;
    let match;
    while ((match = exportFuncRe.exec(content)) !== null) {
      names.add(`fn:${match[1]}`);
    }

    // export class ClassName
    const exportClassRe = /export\s+class\s+(\w+)/g;
    while ((match = exportClassRe.exec(content)) !== null) {
      names.add(`class:${match[1]}`);
    }

    // export default class/function
    const exportDefaultRe = /export\s+default\s+(?:class|function)\s+(\w+)/g;
    while ((match = exportDefaultRe.exec(content)) !== null) {
      names.add(`default:${match[1]}`);
    }

    // export const/let/var name
    const exportVarRe = /export\s+(?:const|let|var)\s+(\w+)/g;
    while ((match = exportVarRe.exec(content)) !== null) {
      names.add(`const:${match[1]}`);
    }

    // CommonJS: module.exports = ClassName or { ... }
    const moduleExportsRe = /module\.exports\s*=\s*(?:\{\s*([\w\s,]+)\s*\}|(\w+))/g;
    while ((match = moduleExportsRe.exec(content)) !== null) {
      if (match[1]) {
        // Object destructuring: { A, B, C }
        match[1].split(',').map(s => s.trim()).filter(Boolean).forEach(n => names.add(n));
      } else if (match[2]) {
        names.add(match[2]);
      }
    }

    // CommonJS: exports.name = ...
    const exportsRe = /exports\.(\w+)\s*=/g;
    while ((match = exportsRe.exec(content)) !== null) {
      names.add(match[1]);
    }

    // class ClassName { ... } (rồi export ở cuối)
    // Chỉ detect nếu có module.exports đề cập tên class
    const classRe = /class\s+(\w+)\s*(?:extends\s+\w+\s*)?\{/g;
    const classNames = [];
    while ((match = classRe.exec(content)) !== null) {
      classNames.push(match[1]);
    }
    // Nếu class name xuất hiện trong module.exports → đã capture ở trên

    return Array.from(names).slice(0, 10); // Giới hạn 10 export mỗi file
  }

  /**
   * Phát hiện loại project dựa trên config files
   * @returns {string} Tên project type
   */
  async _detectProjectType(dir, files) {
    const hasFile = (name) => files.includes(name);
    const hasAny = (patterns) => patterns.some(p => files.some(f => f.includes(p)));

    // Next.js — có next.config.*
    if (hasAny(['next.config.'])) return 'Next.js';

    // NestJS — có nest-cli.json hoặc @nestjs trong package.json
    if (hasFile('nest-cli.json')) return 'NestJS';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['@nestjs/core']) return 'NestJS';
      if (allDeps['vite'] && allDeps['react']) return 'React + Vite';
      if (allDeps['express']) return 'Express';
      if (allDeps['fastify']) return 'Fastify';
      if (allDeps['koa']) return 'Koa';
    } catch {
      // Không có package.json hoặc parse lỗi
    }

    // Python projects
    if (hasFile('requirements.txt') || hasFile('pyproject.toml') || hasFile('setup.py')) {
      if (hasAny(['manage.py'])) return 'Django';
      if (hasAny(['app.py', 'wsgi.py']) && hasAny(['flask'])) return 'Flask';
      if (hasAny(['fastapi'])) return 'FastAPI';
      return 'Python';
    }

    // Go
    if (hasFile('go.mod')) return 'Go';

    // Rust
    if (hasFile('Cargo.toml')) return 'Rust';

    // Fallback: có package.json → Node.js
    if (hasFile('package.json')) return 'Node.js';

    return 'Unknown';
  }

  /**
   * Trích xuất thông tin từ package.json
   * Lấy name, scripts keys, dependencies keys
   */
  async _extractPackageInfo(dir) {
    try {
      const pkgPath = path.join(dir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

      return {
        name: pkg.name || null,
        scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
        dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
        devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : []
      };
    } catch {
      return null;
    }
  }

  /**
   * Ghép tất cả thành summary compact
   * Mục tiêu: dưới 2000 chars cho medium project
   */
  _buildSummary({ tree, exports, projectType, pkgInfo, fileCount }) {
    const parts = [];

    // Header
    parts.push(`## Project: ${pkgInfo?.name || path.basename(this.projectDir)} (${projectType})`);
    parts.push(`Files: ${fileCount}`);

    // Package info
    if (pkgInfo) {
      if (pkgInfo.scripts.length > 0) {
        parts.push(`Scripts: ${pkgInfo.scripts.join(', ')}`);
      }
      if (pkgInfo.dependencies.length > 0) {
        // Chỉ show tối đa 10 deps
        const deps = pkgInfo.dependencies.slice(0, 10);
        const suffix = pkgInfo.dependencies.length > 10
          ? ` +${pkgInfo.dependencies.length - 10} more`
          : '';
        parts.push(`Deps: ${deps.join(', ')}${suffix}`);
      }
    }

    parts.push('');

    // Tree — cắt nếu quá dài
    const treeLines = tree.split('\n');
    const maxTreeLines = 30;
    if (treeLines.length > maxTreeLines) {
      parts.push(treeLines.slice(0, maxTreeLines).join('\n'));
      parts.push(`  ... +${treeLines.length - maxTreeLines} more`);
    } else {
      parts.push(tree);
    }

    // Exports — chỉ show nếu còn chỗ
    const exportEntries = Object.entries(exports);
    if (exportEntries.length > 0) {
      parts.push('');
      parts.push('Key exports:');
      // Chỉ show tối đa 15 file
      for (const [file, names] of exportEntries.slice(0, 15)) {
        parts.push(`  ${file}: ${names.join(', ')}`);
      }
      if (exportEntries.length > 15) {
        parts.push(`  ... +${exportEntries.length - 15} more files`);
      }
    }

    // Cắt nếu vượt giới hạn ký tự
    let result = parts.join('\n');
    if (result.length > this.maxSummaryChars) {
      result = result.substring(0, this.maxSummaryChars - 20) + '\n... [truncated]';
    }

    return result;
  }
}

module.exports = { RepoMapper };
