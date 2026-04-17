#!/usr/bin/env node
/**
 * git_advanced — Structured wrapper cho cac lenh git hay dung khi debug/review
 *
 * Thay vi LLM goi execute_command "git blame" roi parse text thu cong,
 * tool nay chay git commands va tra ve JSON co cau truc.
 *
 * Actions: blame, log, diff, stash, branch, status, show, cherry_pick
 *
 * Cach dung:
 *   const { gitAdvanced } = require('./tools/git-advanced');
 *   const r = await gitAdvanced({ action: 'status', cwd: '/path/to/repo' });
 *   const blame = await gitAdvanced({ action: 'blame', path: 'src/app.js', line_start: 10, line_end: 20 });
 *
 * Safety:
 *   - stash drop, branch delete, cherry-pick → log warning nhung van chay
 *   - push, reset --hard, rebase -i → tu choi (dung execute_command)
 *   - Refuse neu cwd khong phai git repo
 *
 * Design decisions:
 *   - spawn (khong exec) vi output co the lon (git log full repo, git diff lon)
 *   - Timeout 15s moi command — git thuong nhanh, neu lau la treo
 *   - Patch truncate o 100KB de tranh flood LLM context
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_TIMEOUT = 15000;
const MAX_PATCH_SIZE = 100 * 1024; // 100KB

// ---------- Helpers ----------

/**
 * Chay git command qua spawn, return {code, stdout, stderr}
 * Timeout 15s — git lau hon vay la bat thuong.
 */
function runGit(args, cwd, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, timeout);

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || err.message, error: err.message });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code == null ? -1 : code,
        stdout,
        stderr,
        timedOut: killed,
      });
    });
  });
}

/**
 * Check cwd co phai git repo khong (.git folder hoac file worktree).
 */
function isGitRepo(cwd) {
  try {
    const gitPath = path.join(cwd, '.git');
    if (!fs.existsSync(gitPath)) {
      // Co the la worktree/submodule — check bang git rev-parse
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureGitRepo(cwd) {
  if (isGitRepo(cwd)) return true;
  // Fallback: git rev-parse --is-inside-work-tree
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, 3000);
  return r.code === 0 && r.stdout.trim() === 'true';
}

function truncatePatch(patch) {
  if (!patch) return patch;
  if (patch.length <= MAX_PATCH_SIZE) return patch;
  return patch.slice(0, MAX_PATCH_SIZE) + `\n... [truncated ${patch.length - MAX_PATCH_SIZE} bytes]`;
}

// ---------- Action: blame ----------

/**
 * Parse output cua `git blame --porcelain <path>`
 * Format: moi line co header block roi '\t' + content.
 */
function parseBlamePorcelain(stdout) {
  const lines = stdout.split('\n');
  const commits = {}; // sha → {author, date, summary}
  const result = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('\t')) {
      // content line → flush cur
      if (cur) {
        result.push({
          line: cur.finalLine,
          commit_sha: cur.sha.slice(0, 8),
          author: commits[cur.sha]?.author || 'unknown',
          date: commits[cur.sha]?.date || '',
          summary: commits[cur.sha]?.summary || '',
          content: line.slice(1),
        });
      }
      cur = null;
      continue;
    }

    // Header line
    const headerMatch = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
    if (headerMatch) {
      cur = {
        sha: headerMatch[1],
        origLine: parseInt(headerMatch[2], 10),
        finalLine: parseInt(headerMatch[3], 10),
      };
      if (!commits[cur.sha]) commits[cur.sha] = {};
      continue;
    }

    if (!cur) continue;
    const sha = cur.sha;
    if (line.startsWith('author ')) {
      commits[sha].author = line.slice(7);
    } else if (line.startsWith('author-time ')) {
      const ts = parseInt(line.slice(12), 10);
      commits[sha].date = new Date(ts * 1000).toISOString();
    } else if (line.startsWith('summary ')) {
      commits[sha].summary = line.slice(8);
    }
  }

  return result;
}

async function actionBlame({ path: filePath, line_start, line_end, cwd }) {
  if (!filePath) return { success: false, error: 'blame requires: path' };

  const args = ['blame', '--porcelain'];
  if (line_start && line_end) {
    args.push('-L', `${line_start},${line_end}`);
  } else if (line_start) {
    args.push('-L', `${line_start},+50`);
  }
  args.push('--', filePath);

  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    return { success: false, error: r.stderr.trim() || 'git blame failed', code: r.code };
  }

  const parsed = parseBlamePorcelain(r.stdout);
  let lines = parsed;
  if (line_start && line_end && !args.includes('-L')) {
    lines = parsed.filter(l => l.line >= line_start && l.line <= line_end);
  }
  return { success: true, path: filePath, lines };
}

// ---------- Action: log ----------

async function actionLog({ path: filePath, limit = 20, since, author, grep, cwd }) {
  const SEP = '\x1f'; // unit separator — tranh conflict voi subject messages
  const args = ['log', `--pretty=format:%H${SEP}%an${SEP}%ai${SEP}%s`, '-n', String(limit)];
  if (since) args.push(`--since=${since}`);
  if (author) args.push(`--author=${author}`);
  if (grep) args.push(`--grep=${grep}`);
  if (filePath) { args.push('--', filePath); }

  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    return { success: false, error: r.stderr.trim() || 'git log failed', code: r.code };
  }

  const commits = r.stdout.split('\n').filter(Boolean).map(line => {
    const [sha, auth, date, subject] = line.split(SEP);
    return { sha, author: auth, date, subject };
  });

  return { success: true, commits };
}

// ---------- Action: diff ----------

async function actionDiff({ from, to = 'HEAD', path: filePath, staged = false, cwd, include_patch = true }) {
  const baseArgs = [];
  if (staged) baseArgs.push('--cached');
  if (from && to) baseArgs.push(`${from}..${to}`);
  else if (from) baseArgs.push(from);
  if (filePath) { baseArgs.push('--', filePath); }

  // numstat de lay additions/deletions
  const numArgs = ['diff', '--numstat', ...baseArgs];
  const numR = await runGit(numArgs, cwd);
  if (numR.code !== 0) {
    return { success: false, error: numR.stderr.trim() || 'git diff failed', code: numR.code };
  }

  const files = [];
  for (const line of numR.stdout.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [add, del, p] = parts;
    files.push({
      path: p,
      additions: add === '-' ? null : parseInt(add, 10),
      deletions: del === '-' ? null : parseInt(del, 10),
    });
  }

  if (include_patch) {
    const patchArgs = ['diff', ...baseArgs];
    const patchR = await runGit(patchArgs, cwd);
    if (patchR.code === 0) {
      const fullPatch = truncatePatch(patchR.stdout);
      return { success: true, files, patch: fullPatch };
    }
  }

  return { success: true, files };
}

// ---------- Action: stash ----------

async function actionStash({ subaction, message, index, cwd }) {
  if (!subaction) return { success: false, error: 'stash requires: subaction (list|save|pop|apply|drop)' };

  if (subaction === 'list') {
    const r = await runGit(['stash', 'list', '--pretty=format:%gd\x1f%gs\x1f%ai'], cwd);
    if (r.code !== 0) return { success: false, error: r.stderr.trim(), code: r.code };

    const stashes = r.stdout.split('\n').filter(Boolean).map(line => {
      const [ref, subject, date] = line.split('\x1f');
      // ref = stash@{0}, subject = "WIP on branch: ..." or "On branch: msg"
      const indexMatch = ref.match(/stash@\{(\d+)\}/);
      const branchMatch = subject.match(/(?:WIP on|On)\s+([^:]+):\s*(.*)/);
      return {
        index: indexMatch ? parseInt(indexMatch[1], 10) : null,
        branch: branchMatch ? branchMatch[1] : null,
        message: branchMatch ? branchMatch[2] : subject,
        date,
      };
    });
    return { success: true, stashes };
  }

  if (subaction === 'save') {
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    const r = await runGit(args, cwd);
    return r.code === 0
      ? { success: true, output: r.stdout.trim() }
      : { success: false, error: r.stderr.trim() || r.stdout.trim(), code: r.code };
  }

  if (subaction === 'pop' || subaction === 'apply') {
    const args = ['stash', subaction];
    if (index != null) args.push(`stash@{${index}}`);
    const r = await runGit(args, cwd);
    return r.code === 0
      ? { success: true, output: r.stdout.trim() }
      : { success: false, error: r.stderr.trim() || r.stdout.trim(), code: r.code };
  }

  if (subaction === 'drop') {
    console.warn(`[git_advanced] WARN: stash drop is destructive (index=${index})`);
    const args = ['stash', 'drop'];
    if (index != null) args.push(`stash@{${index}}`);
    const r = await runGit(args, cwd);
    return r.code === 0
      ? { success: true, output: r.stdout.trim() }
      : { success: false, error: r.stderr.trim() || r.stdout.trim(), code: r.code };
  }

  return { success: false, error: `Unknown stash subaction: ${subaction}` };
}

// ---------- Action: branch ----------

async function actionBranch({ subaction, name, from, cwd }) {
  if (!subaction) return { success: false, error: 'branch requires: subaction' };

  if (subaction === 'list') {
    const r = await runGit(['branch', '-a', '--format=%(refname:short)\x1f%(HEAD)\x1f%(objectname:short)'], cwd);
    if (r.code !== 0) return { success: false, error: r.stderr.trim(), code: r.code };
    const branches = r.stdout.split('\n').filter(Boolean).map(line => {
      const [ref, head, sha] = line.split('\x1f');
      return { name: ref, current: head === '*', sha };
    });
    return { success: true, branches };
  }

  if (subaction === 'current') {
    const r = await runGit(['branch', '--show-current'], cwd);
    return r.code === 0
      ? { success: true, branch: r.stdout.trim() }
      : { success: false, error: r.stderr.trim(), code: r.code };
  }

  if (subaction === 'create') {
    if (!name) return { success: false, error: 'branch create requires: name' };
    const args = ['branch', name];
    if (from) args.push(from);
    const r = await runGit(args, cwd);
    return r.code === 0
      ? { success: true, branch: name, from: from || 'HEAD' }
      : { success: false, error: r.stderr.trim() || r.stdout.trim(), code: r.code };
  }

  if (subaction === 'delete') {
    if (!name) return { success: false, error: 'branch delete requires: name' };
    console.warn(`[git_advanced] WARN: deleting branch ${name}`);
    // Chi dung -d (safe), KHONG -D (force)
    const r = await runGit(['branch', '-d', name], cwd);
    return r.code === 0
      ? { success: true, deleted: name }
      : { success: false, error: r.stderr.trim() || r.stdout.trim(), code: r.code, hint: 'Use execute_command for force delete (-D)' };
  }

  return { success: false, error: `Unknown branch subaction: ${subaction}` };
}

// ---------- Action: status ----------

/**
 * Parse output cua `git status --porcelain=v2 --branch`
 * Format ref: https://git-scm.com/docs/git-status#_porcelain_format_version_2
 */
function parseStatusV2(stdout) {
  const result = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    modified: [],
    staged: [],
    untracked: [],
    unmerged: [],
    renamed: [],
  };

  for (const line of stdout.split('\n')) {
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      result.branch = line.slice(14);
    } else if (line.startsWith('# branch.upstream ')) {
      result.upstream = line.slice(18);
    } else if (line.startsWith('# branch.ab ')) {
      // # branch.ab +3 -1
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { result.ahead = parseInt(m[1], 10); result.behind = parseInt(m[2], 10); }
    } else if (line.startsWith('1 ')) {
      // Changed tracked entry: "1 XY sub mH mI mW hH hI path"
      const parts = line.split(' ');
      const xy = parts[1]; // staged + worktree status
      const filePath = parts.slice(8).join(' ');
      const stagedStatus = xy[0];
      const worktreeStatus = xy[1];
      if (stagedStatus !== '.') result.staged.push({ path: filePath, status: stagedStatus });
      if (worktreeStatus !== '.') result.modified.push({ path: filePath, status: worktreeStatus });
    } else if (line.startsWith('2 ')) {
      // Renamed/copied: "2 XY sub mH mI mW hH hI Xscore path\toldpath"
      const parts = line.split(' ');
      const xy = parts[1];
      const rest = parts.slice(9).join(' ');
      const [newPath, oldPath] = rest.split('\t');
      result.renamed.push({ from: oldPath, to: newPath, status: xy });
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      const filePath = parts.slice(10).join(' ');
      result.unmerged.push({ path: filePath });
    } else if (line.startsWith('? ')) {
      result.untracked.push(line.slice(2));
    }
  }

  return result;
}

async function actionStatus({ cwd }) {
  const r = await runGit(['status', '--porcelain=v2', '--branch'], cwd);
  if (r.code !== 0) {
    return { success: false, error: r.stderr.trim() || 'git status failed', code: r.code };
  }
  const parsed = parseStatusV2(r.stdout);
  return { success: true, ...parsed };
}

// ---------- Action: show ----------

async function actionShow({ sha, path: filePath, cwd }) {
  if (!sha) return { success: false, error: 'show requires: sha' };

  // Neu co path → tra ve content cua file tai commit do
  if (filePath) {
    const r = await runGit(['show', `${sha}:${filePath}`], cwd);
    if (r.code !== 0) {
      return { success: false, error: r.stderr.trim() || 'git show failed', code: r.code };
    }
    return { success: true, sha, path: filePath, content: r.stdout };
  }

  // Khong co path → tra ve commit metadata + files changed
  const SEP = '\x1f';
  const r = await runGit(
    ['show', '--name-status', `--pretty=format:%H${SEP}%an${SEP}%ai${SEP}%s${SEP}%b`, sha],
    cwd
  );
  if (r.code !== 0) {
    return { success: false, error: r.stderr.trim() || 'git show failed', code: r.code };
  }

  const lines = r.stdout.split('\n');
  const headerLine = lines[0] || '';
  const [commitSha, author, date, subject, body] = headerLine.split(SEP);

  const files = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length >= 2) {
      files.push({ status: parts[0], path: parts.slice(1).join('\t') });
    }
  }

  return {
    success: true,
    sha: commitSha,
    author,
    date,
    message: subject,
    body: body || '',
    files,
  };
}

// ---------- Action: cherry_pick ----------

async function actionCherryPick({ sha, no_commit = false, cwd }) {
  if (!sha) return { success: false, error: 'cherry_pick requires: sha' };
  console.warn(`[git_advanced] WARN: cherry-picking ${sha} onto current branch`);

  const args = ['cherry-pick'];
  if (no_commit) args.push('-n');
  args.push(sha);

  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    return {
      success: false,
      error: r.stderr.trim() || r.stdout.trim(),
      code: r.code,
      hint: 'Conflict? Use execute_command "git cherry-pick --abort" to abort',
    };
  }
  return { success: true, sha, output: r.stdout.trim() };
}

// ---------- Main entry ----------

const REFUSED_PATTERNS = [
  { pattern: 'push', reason: 'push is destructive — use execute_command' },
  { pattern: 'reset_hard', reason: 'reset --hard is destructive — use execute_command' },
  { pattern: 'rebase', reason: 'rebase is destructive — use execute_command' },
  { pattern: 'force_delete', reason: 'force delete is destructive — use execute_command' },
];

async function gitAdvanced(args = {}) {
  const { action, cwd: argCwd } = args;
  const cwd = argCwd || process.cwd();

  if (!action) {
    return { success: false, error: 'Missing required arg: action' };
  }

  // Refuse destructive ops
  const refused = REFUSED_PATTERNS.find(r => action === r.pattern);
  if (refused) return { success: false, error: refused.reason };

  // Check git repo
  const okRepo = await ensureGitRepo(cwd);
  if (!okRepo) {
    return { success: false, error: `Not a git repository: ${cwd}` };
  }

  try {
    switch (action) {
      case 'blame':       return await actionBlame({ ...args, cwd });
      case 'log':         return await actionLog({ ...args, cwd });
      case 'diff':        return await actionDiff({ ...args, cwd });
      case 'stash':       return await actionStash({ ...args, cwd });
      case 'branch':      return await actionBranch({ ...args, cwd });
      case 'status':      return await actionStatus({ ...args, cwd });
      case 'show':        return await actionShow({ ...args, cwd });
      case 'cherry_pick': return await actionCherryPick({ ...args, cwd });
      default:
        return {
          success: false,
          error: `Unknown action: ${action}`,
          supported: ['blame', 'log', 'diff', 'stash', 'branch', 'status', 'show', 'cherry_pick'],
        };
    }
  } catch (err) {
    return { success: false, error: err.message, stack: err.stack };
  }
}

// ---------- Schema cho definitions.js (integration) ----------

const GIT_ADVANCED_SCHEMA = {
  name: 'git_advanced',
  description:
    'Structured git operations. Returns parsed JSON instead of raw text. ' +
    'Supports: blame (who wrote line X), log (commit history), diff (file changes), ' +
    'stash (save/restore WIP), branch (create/list/delete), status (porcelain v2), ' +
    'show (commit details), cherry_pick (apply commit). ' +
    'For destructive ops (push, reset --hard, rebase), use execute_command.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['blame', 'log', 'diff', 'stash', 'branch', 'status', 'show', 'cherry_pick'],
        description: 'Which git operation to run',
      },
      cwd: { type: 'string', description: 'Git repo directory (default: cwd)' },
      // blame
      path: { type: 'string', description: 'File path (for blame/log/diff/show)' },
      line_start: { type: 'number', description: 'Start line (blame)' },
      line_end: { type: 'number', description: 'End line (blame)' },
      // log
      limit: { type: 'number', description: 'Max commits (log), default 20' },
      since: { type: 'string', description: 'Since date e.g. "2 weeks ago"' },
      author: { type: 'string', description: 'Filter by author' },
      grep: { type: 'string', description: 'Filter commit messages' },
      // diff
      from: { type: 'string', description: 'Base ref (diff)' },
      to: { type: 'string', description: 'Target ref (diff), default HEAD' },
      staged: { type: 'boolean', description: 'Diff staged changes (--cached)' },
      include_patch: { type: 'boolean', description: 'Include patch text, default true' },
      // stash/branch
      subaction: { type: 'string', description: 'Sub-operation (list/save/pop/apply/drop for stash; list/current/create/delete for branch)' },
      message: { type: 'string', description: 'Stash message' },
      index: { type: 'number', description: 'Stash index' },
      name: { type: 'string', description: 'Branch name' },
      from: { type: 'string', description: 'Branch starting ref' },
      // show/cherry_pick
      sha: { type: 'string', description: 'Commit SHA' },
      no_commit: { type: 'boolean', description: 'Cherry-pick without committing (-n)' },
    },
    required: ['action'],
  },
};

module.exports = { gitAdvanced, GIT_ADVANCED_SCHEMA };
