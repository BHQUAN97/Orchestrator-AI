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
  }

  // Index toan bo project
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
    }

    console.log(`Indexed ${this.files.size} files, ${this._totalEdges()} import edges`);
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
    return {
      totalFiles: this.files.size,
      totalEdges: this._totalEdges(),
      totalSizeKB: Math.round(sizes.reduce((s, v) => s + v, 0) / 1024),
      avgImports: this.files.size > 0
        ? Math.round(this._totalEdges() / this.files.size * 10) / 10
        : 0
    };
  }
}

module.exports = { TrustGraph };
