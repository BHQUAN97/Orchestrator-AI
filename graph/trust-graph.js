/**
 * Trust Graph — File dependency graph + relevance scoring
 * Parse imports tu source code → build dependency tree
 * Chi gui files lien quan vao LLM context → giam tokens
 *
 * Cach dung:
 *   const graph = new TrustGraph('/projects/FashionEcom');
 *   await graph.index();
 *   const relevant = graph.getRelevantFiles('src/services/upload.service.ts', 20);
 */

const fs = require('fs');
const path = require('path');

class TrustGraph {
  constructor(projectDir, options = {}) {
    this.projectDir = projectDir;
    this.maxDepth = options.maxDepth || 3;
    this.maxFiles = options.maxFiles || 20;
    this.threshold = options.threshold || 0.3;

    // Adjacency list: file → [imported files]
    this.imports = new Map();
    // Reverse: file → [files that import it]
    this.importedBy = new Map();
    // File metadata
    this.files = new Map();
    // Git proximity cache
    this.gitProximity = new Map();

    // === Env/Global Variable Tracking (v2.2) ===
    // envUsage: env_var_name → Set<file_paths> — files dung process.env.X
    this.envUsage = new Map();
    // globalExports: var_name → { source: file, value_hint: string }
    this.globalExports = new Map();
    // globalUsage: var_name → Set<file_paths> — files dung global/exported var
    this.globalUsage = new Map();
    // Semantic edges: file → [files] — linked by shared env/global vars (khong phai import)
    this.semanticEdges = new Map();
  }

  // Index toan bo project — bao gom import edges + env/global semantic edges
  async index() {
    const sourceFiles = this._findSourceFiles(this.projectDir);

    for (const file of sourceFiles) {
      const relPath = path.relative(this.projectDir, file).replace(/[/\\]/g, '/');
      const content = fs.readFileSync(file, 'utf-8');
      const imports = this._parseImports(content, file);

      this.files.set(relPath, {
        path: file,
        size: content.length,
        lines: content.split('\n').length,
        lastModified: fs.statSync(file).mtime
      });

      this.imports.set(relPath, imports);

      // Build reverse index
      for (const imp of imports) {
        if (!this.importedBy.has(imp)) {
          this.importedBy.set(imp, []);
        }
        this.importedBy.get(imp).push(relPath);
      }

      // Parse env vars va global exports/usage
      this._parseEnvUsage(content, relPath);
      this._parseGlobalVars(content, relPath);
    }

    // Build semantic edges tu shared env/global vars
    this._buildSemanticEdges();

    const semanticCount = Array.from(this.semanticEdges.values())
      .reduce((sum, edges) => sum + edges.length, 0);
    console.log(`Indexed ${this.files.size} files, ${this._totalEdges()} import edges, ${semanticCount} semantic edges`);
    console.log(`  Env vars tracked: ${this.envUsage.size}, Global vars tracked: ${this.globalExports.size}`);
    return this;
  }

  // Tim files lien quan den 1 file (entry point)
  getRelevantFiles(entryFile, maxFiles = null) {
    const max = maxFiles || this.maxFiles;
    const scores = new Map();
    // Normalize to forward slash (consistent with stored keys)
    entryFile = entryFile.replace(/[/\\]/g, '/');

    // BFS tu entry file
    const queue = [{ file: entryFile, depth: 0, direction: 'both' }];
    const visited = new Set();

    while (queue.length > 0) {
      const { file, depth, direction } = queue.shift();
      if (visited.has(file) || depth > this.maxDepth) continue;
      visited.add(file);

      // Score giam theo depth
      const score = 1.0 / (1 + depth * 0.3);
      scores.set(file, Math.max(scores.get(file) || 0, score));

      // Forward: files ma entry import
      if (direction === 'both' || direction === 'forward') {
        const deps = this.imports.get(file) || [];
        for (const dep of deps) {
          queue.push({ file: dep, depth: depth + 1, direction: 'forward' });
        }
      }

      // Backward: files import entry
      if (direction === 'both' || direction === 'backward') {
        const users = this.importedBy.get(file) || [];
        for (const user of users) {
          queue.push({ file: user, depth: depth + 1, direction: 'backward' });
        }
      }
    }

    // Semantic edges: files share env/global vars voi entry file
    const semanticLinks = this.semanticEdges.get(entryFile) || [];
    for (const link of semanticLinks) {
      const currentScore = scores.get(link.file) || 0;
      // Env/global dependency co score 0.6 — cao hon directory locality (0.4)
      // nhung thap hon direct import (depth 0 = 1.0, depth 1 = 0.77)
      const semanticScore = 0.6;
      scores.set(link.file, Math.max(currentScore, semanticScore));
    }

    // Boost: files cung directory
    const entryDir = path.dirname(entryFile);
    for (const [file] of this.files) {
      if (path.dirname(file) === entryDir && !scores.has(file)) {
        scores.set(file, 0.4); // directory locality bonus
      }
    }

    // Sort va filter
    return Array.from(scores.entries())
      .filter(([, score]) => score >= this.threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([file, score]) => ({
        file,
        score: Math.round(score * 100) / 100,
        ...this.files.get(file)
      }));
  }

  // Build context string tu relevant files
  buildContext(entryFile, maxFiles = null) {
    const relevant = this.getRelevantFiles(entryFile, maxFiles);
    let context = '';
    let totalSize = 0;

    for (const item of relevant) {
      try {
        const content = fs.readFileSync(item.path, 'utf-8');
        context += `\n--- ${item.file} (relevance: ${item.score}) ---\n`;
        context += content;
        context += '\n';
        totalSize += content.length;
      } catch {
        // File khong doc duoc → skip
      }
    }

    return {
      context,
      files: relevant.length,
      totalFiles: this.files.size,
      totalSizeKB: Math.round(totalSize / 1024),
      reduction: Math.round((1 - relevant.length / this.files.size) * 100)
    };
  }

  /**
   * Check dong co phai comment khong — bo qua comment lines de tranh false positive
   */
  _isCommentLine(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
  }

  /**
   * Parse process.env.X usage — track files nao dung env var nao
   * Khi file A thay doi env var X, tat ca files dung X deu bi anh huong
   * Skip comment lines de tranh false positive
   */
  _parseEnvUsage(content, relPath) {
    const lines = content.split('\n');
    for (const line of lines) {
      // Bo qua comment lines
      if (this._isCommentLine(line)) continue;

      // Match: process.env.VAR_NAME (ho tro ca uppercase va camelCase)
      const dotMatches = line.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g);
      for (const m of dotMatches) {
        const varName = m[1];
        if (!this.envUsage.has(varName)) this.envUsage.set(varName, new Set());
        this.envUsage.get(varName).add(relPath);
      }

      // Match: process.env['VAR'] hoac process.env["VAR"]
      const bracketMatches = line.matchAll(/process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g);
      for (const m of bracketMatches) {
        const varName = m[1];
        if (!this.envUsage.has(varName)) this.envUsage.set(varName, new Set());
        this.envUsage.get(varName).add(relPath);
      }

      // Match: destructured env — const { API_KEY, SECRET } = process.env
      const destructureMatch = line.match(/\{\s*([^}]+)\}\s*=\s*process\.env/);
      if (destructureMatch) {
        const vars = destructureMatch[1].split(',').map(v => v.trim().split(/\s/)[0]);
        for (const varName of vars) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
            if (!this.envUsage.has(varName)) this.envUsage.set(varName, new Set());
            this.envUsage.get(varName).add(relPath);
          }
        }
      }
    }
  }

  /**
   * Parse global/exported constants — track module.exports, const exports
   * Detect: module.exports = { CONFIG }, exports.X = Y, global.X = Y
   * Skip comment lines, phan biet assignment vs comparison
   */
  _parseGlobalVars(content, relPath) {
    const lines = content.split('\n');
    for (const line of lines) {
      // Bo qua comment lines
      if (this._isCommentLine(line)) continue;

      // module.exports.VAR = ... hoac exports.VAR = ...
      // Dung [^=] sau = de loai == va === (comparison)
      let match = line.match(/(?:module\.)?exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/);
      if (match) {
        const varName = match[1];
        this.globalExports.set(varName, { source: relPath, line: line.trim().slice(0, 100) });
      }

      // global.VAR = ... (assignment, khong phai comparison)
      match = line.match(/global\.([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/);
      if (match) {
        const varName = `global.${match[1]}`;
        this.globalExports.set(varName, { source: relPath, line: line.trim().slice(0, 100) });
      }

      // Detect usage: global.X (read, not assignment — negative lookahead cho = nhung cho phep ==)
      const globalReads = line.matchAll(/global\.([A-Za-z_][A-Za-z0-9_]*)(?!\s*=[^=])/g);
      for (const m of globalReads) {
        const varName = `global.${m[1]}`;
        if (!this.globalUsage.has(varName)) this.globalUsage.set(varName, new Set());
        this.globalUsage.get(varName).add(relPath);
      }
    }
  }

  /**
   * Build semantic edges — connect files that share env vars hoac global vars
   * Khac voi import edges: khong phai code dependency, ma la "data dependency"
   *
   * ARCHITECTURE: Hub-spoke pattern thay vi all-pairs
   * - Moi env var co 1 "hub file" (file dung nhieu nhat hoac file config)
   * - Cac file khac chi co edge toi hub → O(n) thay vi O(n²)
   * - Khi query affected files: traverse qua hub de tim tat ca
   */
  _buildSemanticEdges() {
    // Env var edges: hub-spoke pattern
    for (const [varName, files] of this.envUsage) {
      if (files.size < 2) continue;
      const fileArray = Array.from(files);

      // Chon hub: uu tien file config/env, neu khong co → file dau tien
      const hub = fileArray.find(f =>
        f.includes('config') || f.includes('.env') || f.includes('constants')
      ) || fileArray[0];

      // Tao spoke edges: hub ↔ moi file khac
      for (const file of fileArray) {
        if (file === hub) continue;
        this._addSemanticEdge(hub, file, `env:${varName}`);
        this._addSemanticEdge(file, hub, `env:${varName}`);
      }
    }

    // Global var edges: source file → all files that use the global (da la hub-spoke tu nhien)
    for (const [varName, info] of this.globalExports) {
      const users = this.globalUsage.get(varName);
      if (!users) continue;
      for (const userFile of users) {
        if (userFile !== info.source) {
          this._addSemanticEdge(info.source, userFile, `global:${varName}`);
          this._addSemanticEdge(userFile, info.source, `global:${varName}`);
        }
      }
    }
  }

  _addSemanticEdge(from, to, reason) {
    if (!this.semanticEdges.has(from)) {
      this.semanticEdges.set(from, []);
    }
    // Tranh duplicate
    const edges = this.semanticEdges.get(from);
    if (!edges.some(e => e.file === to && e.reason === reason)) {
      edges.push({ file: to, reason });
    }
  }

  /**
   * Lay tat ca files bi anh huong khi file X thay doi
   * Bao gom: import dependencies + env/global semantic dependencies
   * Hub-spoke: traverse qua hub de tim tat ca spokes
   */
  getAffectedFiles(changedFile) {
    changedFile = changedFile.replace(/[/\\]/g, '/');
    const affected = new Map(); // file → { importDep, semanticDep, reasons[] }

    // 1. Import-based: files import changedFile
    const importers = this.importedBy.get(changedFile) || [];
    const importerSet = new Set(importers);
    for (const imp of importers) {
      affected.set(imp, { importDep: true, semanticDep: false, reasons: [] });
    }

    // 2. Direct semantic edges (changedFile la hub hoac spoke)
    const directLinks = this.semanticEdges.get(changedFile) || [];
    for (const link of directLinks) {
      const existing = affected.get(link.file);
      if (existing) {
        existing.semanticDep = true;
        existing.reasons.push(link.reason);
      } else {
        affected.set(link.file, {
          importDep: importerSet.has(link.file),
          semanticDep: true,
          reasons: [link.reason]
        });
      }

      // 3. Hub traversal: neu changedFile la spoke, traverse qua hub de tim cac spokes khac
      const hubLinks = this.semanticEdges.get(link.file) || [];
      for (const hubLink of hubLinks) {
        if (hubLink.file === changedFile) continue; // Skip self
        if (hubLink.reason === link.reason) { // Cung env var
          const ex = affected.get(hubLink.file);
          if (ex) {
            ex.semanticDep = true;
            if (!ex.reasons.includes(hubLink.reason)) ex.reasons.push(hubLink.reason);
          } else {
            affected.set(hubLink.file, {
              importDep: importerSet.has(hubLink.file),
              semanticDep: true,
              reasons: [hubLink.reason]
            });
          }
        }
      }
    }

    return Array.from(affected.entries()).map(([file, info]) => ({
      file,
      ...info
    }));
  }

  /**
   * Lay tat ca env vars duoc dung trong project
   */
  getEnvVarMap() {
    const result = {};
    for (const [varName, files] of this.envUsage) {
      result[varName] = Array.from(files);
    }
    return result;
  }

  // Parse import/require statements
  _parseImports(content, filePath) {
    const imports = [];
    const dir = path.dirname(filePath);
    const lines = content.split('\n');

    for (const line of lines) {
      let match;

      // ES import: import X from './path'
      match = line.match(/import\s+.*?from\s+['"]([^'"]+)['"]/);
      if (!match) {
        // require: const X = require('./path')
        match = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      }
      if (!match) {
        // Dynamic import: import('./path')
        match = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      }

      if (match) {
        const importPath = match[1];
        let resolved = null;

        if (importPath.startsWith('.')) {
          // Relative import
          resolved = this._resolveImport(importPath, dir);
        } else if (importPath.startsWith('@/') || importPath.startsWith('~/') || importPath.startsWith('src/')) {
          // Path alias: @/ → src/, ~/ → src/
          const aliasPath = importPath
            .replace(/^@\//, 'src/')
            .replace(/^~\//, 'src/');
          // Thu resolve tu project root
          resolved = this._resolveImport('./' + aliasPath, this.projectDir);
          // Thu tu backend/src va frontend/src
          if (!resolved) {
            resolved = this._resolveImport('./backend/' + aliasPath, this.projectDir);
          }
          if (!resolved) {
            resolved = this._resolveImport('./frontend/' + aliasPath, this.projectDir);
          }
        } else if (!importPath.includes('/') || importPath.startsWith('@')) {
          // Node module (lodash, @nestjs/common) → skip
        } else {
          // Non-relative, non-alias → try from project root
          resolved = this._resolveImport('./' + importPath, this.projectDir);
        }

        if (resolved) {
          imports.push(path.relative(this.projectDir, resolved).replace(/[/\\]/g, '/'));
        }
      }
    }

    return imports;
  }

  // Resolve import path → actual file
  _resolveImport(importPath, fromDir) {
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs'];
    const basePath = path.resolve(fromDir, importPath);

    // Exact match
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
      return basePath;
    }

    // Try extensions
    for (const ext of extensions) {
      const withExt = basePath + ext;
      if (fs.existsSync(withExt)) return withExt;
    }

    // Try index file
    for (const ext of extensions) {
      const indexPath = path.join(basePath, 'index' + ext);
      if (fs.existsSync(indexPath)) return indexPath;
    }

    return null;
  }

  // Tim tat ca source files (khong node_modules, dist, .next)
  _findSourceFiles(dir, files = []) {
    const IGNORE = ['node_modules', 'dist', '.next', '.git', '__pycache__', 'coverage', '.sdd'];
    const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs', '.py'];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE.includes(entry.name)) {
            this._findSourceFiles(fullPath, files);
          }
        } else if (EXTENSIONS.includes(path.extname(entry.name))) {
          files.push(fullPath);
        }
      }
    } catch {
      // Permission denied → skip
    }

    return files;
  }

  _totalEdges() {
    let count = 0;
    for (const [, deps] of this.imports) {
      count += deps.length;
    }
    return count;
  }

  // Export graph as JSON (cho GitNexus hoac visualization)
  toJSON() {
    return {
      projectDir: this.projectDir,
      files: this.files.size,
      edges: this._totalEdges(),
      nodes: Array.from(this.files.entries()).map(([file, meta]) => ({
        id: file,
        ...meta,
        imports: this.imports.get(file) || [],
        importedBy: this.importedBy.get(file) || []
      }))
    };
  }

  // Thong ke
  getStats() {
    const sizes = Array.from(this.files.values()).map(f => f.size);
    const semanticEdgeCount = Array.from(this.semanticEdges.values())
      .reduce((sum, edges) => sum + edges.length, 0);

    return {
      totalFiles: this.files.size,
      totalEdges: this._totalEdges(),
      semanticEdges: semanticEdgeCount,
      envVarsTracked: this.envUsage.size,
      globalVarsTracked: this.globalExports.size,
      totalSizeKB: Math.round(sizes.reduce((s, v) => s + v, 0) / 1024),
      avgImports: this.files.size > 0
        ? Math.round(this._totalEdges() / this.files.size * 10) / 10
        : 0
    };
  }
}

module.exports = { TrustGraph };
