#!/usr/bin/env node
/**
 * Auto Verify — Tự động phát hiện và chạy test/build/lint sau khi agent sửa code
 *
 * Sau khi agent edit file, module này:
 * 1. Detect test/build/lint commands từ package.json hoặc pyproject.toml
 * 2. Phân loại file đã thay đổi (test / source / config / lint-config)
 * 3. Suggest command phù hợp nhất để verify
 * 4. Generate prompt injection để agent tự chạy verify + self-correct
 *
 * USAGE:
 *   const { AutoVerify } = require('./auto-verify');
 *   const verifier = new AutoVerify({ projectDir: '/path/to/project' });
 *   const detected = await verifier.detect();
 *   const cmd = verifier.getVerifyCommand(['src/index.ts']);
 */

const fs = require('fs');
const path = require('path');

// --- File classification patterns ---

/** Test file patterns */
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /test_.*\.py$/,
  /.*_test\.py$/,
  /tests?\//,
];

/** Source file extensions */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.py',
  '.mjs', '.cjs',
]);

/** Config file patterns — build/project config */
const CONFIG_PATTERNS = [
  /tsconfig.*\.json$/,
  /vite\.config\.[jt]s$/,
  /next\.config\.[jm]?[jt]s$/,
  /package\.json$/,
  /webpack\.config\.[jt]s$/,
  /rollup\.config\.[jt]s$/,
  /pyproject\.toml$/,
  /setup\.cfg$/,
  /setup\.py$/,
];

/** Lint config patterns */
const LINT_CONFIG_PATTERNS = [
  /\.eslintrc/,
  /eslint\.config\.[jt]s$/,
  /\.prettierrc/,
  /prettier\.config\.[jt]s$/,
  /\.flake8$/,
  /ruff\.toml$/,
  /\.ruff\.toml$/,
  /pyproject\.toml$/,   // ruff/black config co the nam trong pyproject
];

/** Tool names that indicate code was changed */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'create_file',
  'str_replace_editor',
  'insert',
  'replace',
]);

/**
 * Phan loai 1 file path vao nhom: test | source | config | lint-config | unknown
 * @param {string} filePath
 * @returns {'test'|'source'|'config'|'lint-config'|'unknown'}
 */
function classifyFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/');

  // Check test patterns truoc (vi test file cung co extension source)
  for (const pattern of TEST_PATTERNS) {
    if (pattern.test(normalized)) return 'test';
  }

  // Lint config
  for (const pattern of LINT_CONFIG_PATTERNS) {
    if (pattern.test(normalized)) return 'lint-config';
  }

  // Config (check sau lint-config vi pyproject.toml match ca 2)
  for (const pattern of CONFIG_PATTERNS) {
    if (pattern.test(normalized)) return 'config';
  }

  // Source files
  const ext = path.extname(filePath).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) return 'source';

  return 'unknown';
}

class AutoVerify {
  /**
   * @param {Object} options
   * @param {string} options.projectDir — duong dan project root
   */
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    /** @type {{testCommand: string|null, buildCommand: string|null, lintCommand: string|null, framework: string|null}|null} */
    this._detected = null;
  }

  /**
   * Auto-detect test/build/lint commands tu project config
   * @returns {Promise<{testCommand: string|null, buildCommand: string|null, lintCommand: string|null, framework: string|null}>}
   */
  async detect() {
    // Thu detect Node.js project truoc
    const pkgResult = await this._detectFromPackageJson();
    if (pkgResult) {
      this._detected = pkgResult;
      return pkgResult;
    }

    // Thu Python project
    const pyResult = await this._detectFromPython();
    if (pyResult) {
      this._detected = pyResult;
      return pyResult;
    }

    // Khong detect duoc gi
    const empty = { testCommand: null, buildCommand: null, lintCommand: null, framework: null };
    this._detected = empty;
    return empty;
  }

  /**
   * Detect tu package.json scripts
   * @returns {Promise<{testCommand: string|null, buildCommand: string|null, lintCommand: string|null, framework: string|null}|null>}
   * @private
   */
  async _detectFromPackageJson() {
    const pkgPath = path.join(this.projectDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;

    let pkg;
    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      pkg = JSON.parse(raw);
    } catch {
      return null;
    }

    const scripts = pkg.scripts || {};
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    // Detect framework
    let framework = null;
    if (deps['next']) framework = 'next';
    else if (deps['vite']) framework = 'vite';
    else if (deps['react']) framework = 'react';
    else if (deps['express']) framework = 'express';
    else if (deps['nestjs'] || deps['@nestjs/core']) framework = 'nestjs';

    // Detect test command
    let testCommand = null;
    if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
      testCommand = 'npm test';
    }

    // Detect build command
    let buildCommand = null;
    if (scripts.build) {
      buildCommand = 'npm run build';
    }

    // Detect lint command
    let lintCommand = null;
    if (scripts.lint) {
      lintCommand = 'npm run lint';
    }

    return { testCommand, buildCommand, lintCommand, framework };
  }

  /**
   * Detect tu Python project (pyproject.toml, requirements.txt, setup.py)
   * @returns {Promise<{testCommand: string|null, buildCommand: string|null, lintCommand: string|null, framework: string|null}|null>}
   * @private
   */
  async _detectFromPython() {
    const markers = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg'];
    const isPython = markers.some(f => fs.existsSync(path.join(this.projectDir, f)));
    if (!isPython) return null;

    let framework = 'python';
    let testCommand = null;
    let buildCommand = null;
    let lintCommand = null;

    // Doc pyproject.toml de xac dinh tools
    const pyprojectPath = path.join(this.projectDir, 'pyproject.toml');
    let pyprojectContent = '';
    if (fs.existsSync(pyprojectPath)) {
      try {
        pyprojectContent = fs.readFileSync(pyprojectPath, 'utf-8');
      } catch {
        // ignore
      }
    }

    // Detect framework tu pyproject hoac requirements
    if (pyprojectContent.includes('django') || this._depsContain('django')) {
      framework = 'django';
    } else if (pyprojectContent.includes('fastapi') || this._depsContain('fastapi')) {
      framework = 'fastapi';
    } else if (pyprojectContent.includes('flask') || this._depsContain('flask')) {
      framework = 'flask';
    }

    // Test: pytest uu tien, fallback unittest
    if (pyprojectContent.includes('pytest') || this._depsContain('pytest')) {
      testCommand = 'pytest';
    } else if (fs.existsSync(path.join(this.projectDir, 'tests'))) {
      testCommand = 'python -m pytest';
    }

    // Lint: ruff uu tien, fallback flake8
    if (pyprojectContent.includes('ruff') || this._depsContain('ruff')) {
      lintCommand = 'ruff check .';
    } else if (this._depsContain('flake8')) {
      lintCommand = 'flake8 .';
    }

    // Build: check black --check cho formatting verification
    if (pyprojectContent.includes('black') || this._depsContain('black')) {
      buildCommand = 'black --check .';
    }

    return { testCommand, buildCommand, lintCommand, framework };
  }

  /**
   * Check xem 1 dependency co trong requirements.txt khong
   * @param {string} name
   * @returns {boolean}
   * @private
   */
  _depsContain(name) {
    const reqPath = path.join(this.projectDir, 'requirements.txt');
    if (!fs.existsSync(reqPath)) return false;
    try {
      const content = fs.readFileSync(reqPath, 'utf-8').toLowerCase();
      return content.includes(name.toLowerCase());
    } catch {
      return false;
    }
  }

  /**
   * Generate prompt injection de agent tu verify sau khi sua code
   * @param {string[]} filesChanged — danh sach file da thay doi
   * @returns {string}
   */
  getVerifyPrompt(filesChanged = []) {
    const fileList = filesChanged.length > 0
      ? filesChanged.map(f => `  - ${f}`).join('\n')
      : '  (unknown files)';

    const cmd = this.getVerifyCommand(filesChanged);

    if (!cmd) {
      return [
        `You just edited ${filesChanged.length || 'some'} file(s):`,
        fileList,
        '',
        'No test/build/lint command detected for this project.',
        'Manually review the changes to ensure correctness.',
      ].join('\n');
    }

    return [
      `You just edited ${filesChanged.length} file(s):`,
      fileList,
      '',
      `Run this to verify: \`${cmd}\``,
      'If the command fails, analyze the error and fix the code.',
      'Do NOT move on until verification passes.',
    ].join('\n');
  }

  /**
   * Kiem tra xem tool call vua roi co phai la edit/write file khong
   * @param {string} toolName — ten tool vua goi
   * @param {Object} [toolArgs] — arguments (khong dung hien tai, de mo rong)
   * @returns {boolean}
   */
  shouldVerify(toolName, toolArgs) {
    if (!toolName || typeof toolName !== 'string') return false;
    return WRITE_TOOLS.has(toolName);
  }

  /**
   * Tra ve command phu hop nhat de verify dua tren file da thay doi
   *
   * Logic:
   * - Test files changed → run test
   * - Source files changed → run build + test
   * - Config files changed → run build
   * - Lint config changed → run lint
   * - Mixed → chay tat ca co the
   *
   * @param {string[]} filesChanged
   * @returns {string|null}
   */
  getVerifyCommand(filesChanged = []) {
    if (!this._detected) return null;

    const { testCommand, buildCommand, lintCommand } = this._detected;

    // Khong co command nao → null
    if (!testCommand && !buildCommand && !lintCommand) return null;

    // Khong co file info → chay test (uu tien nhat)
    if (!filesChanged || filesChanged.length === 0) {
      return testCommand || buildCommand || lintCommand;
    }

    // Phan loai cac file da thay doi
    const categories = new Set();
    for (const file of filesChanged) {
      categories.add(classifyFile(file));
    }

    const commands = [];

    // Lint config changed → chay lint
    if (categories.has('lint-config') && lintCommand) {
      commands.push(lintCommand);
    }

    // Config changed → chay build
    if (categories.has('config') && buildCommand) {
      commands.push(buildCommand);
    }

    // Source changed → chay build + test
    if (categories.has('source')) {
      if (buildCommand && !commands.includes(buildCommand)) commands.push(buildCommand);
      if (testCommand) commands.push(testCommand);
    }

    // Test files changed → chay test
    if (categories.has('test') && testCommand && !commands.includes(testCommand)) {
      commands.push(testCommand);
    }

    // Khong match category nao cu the → fallback
    if (commands.length === 0) {
      return testCommand || buildCommand || lintCommand;
    }

    // Ghep nhieu command bang &&
    return commands.join(' && ');
  }
}

module.exports = { AutoVerify, classifyFile };
