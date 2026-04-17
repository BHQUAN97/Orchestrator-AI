#!/usr/bin/env node
/**
 * Context Guard — Chong ao giac (hallucination) trong agent summary
 *
 * Track ground truth tu tool calls thuc te:
 * - write_file/edit_file/edit_files results → tap hop file da thay doi
 * - execute_command results → commands da chay + exit codes
 * - read_file results → file da doc (de biet agent dua vao du lieu thuc)
 *
 * Khi agent goi task_complete voi summary:
 * 1. Parse summary de tim file references (*.ts, *.js...)
 * 2. Parse summary de tim claim action (modified, updated, fixed, added)
 * 3. Cross-check voi ground truth
 * 4. Tao list issues — agent claim thay doi file nhung khong co trong ground truth
 *
 * Khong block agent — chi warn trong result, user thay de judge.
 */

const path = require('path');

// File path pattern: path-like text ending voi extension
const FILE_PATH_RE = /(?:`|"|'|\s|^)([a-zA-Z0-9_][\w\-./\\]*\.(ts|js|jsx|tsx|py|md|json|yaml|yml|go|rs|java|c|cpp|h|hpp|rb|php|sh|html|css|scss|toml|ini|conf))(?=`|"|'|\s|,|\.|:|$)/g;

// Action verbs (EN + VI) that claim changes
const ACTION_VERBS_RE = /\b(modified|updated|changed|edited|wrote|rewrote|fixed|added|removed|deleted|refactored|created|sua|da sua|cap nhat|them|xoa|tao|ghi)\b/i;

// Command-like claims
const COMMAND_CLAIM_RE = /\b(ran|executed|ran tests|npm\s+\w+|pytest|yarn\s+\w+|git\s+\w+|docker\s+\w+)\b/i;

class ContextGuard {
  constructor(options = {}) {
    this.actualChanges = new Set();         // Set<normalized path>
    this.actualReads = new Set();           // Set<normalized path>
    this.commandsExecuted = [];             // [{ cmd, exit_code }]
    this.enabled = options.enabled !== false;
  }

  /**
   * Ghi nhan ground truth tu tool result
   */
  record(toolName, args, result) {
    if (!this.enabled) return;
    if (!result) return;

    // Parse result content if string
    let parsed = result;
    if (typeof result?.content === 'string') {
      try { parsed = JSON.parse(result.content); } catch { parsed = null; }
    }
    if (!parsed || parsed.success === false) return;

    switch (toolName) {
      case 'write_file':
      case 'edit_file':
        if (args.path) this.actualChanges.add(_normalize(args.path));
        if (parsed.path) this.actualChanges.add(_normalize(parsed.path));
        break;
      case 'edit_files':
        if (Array.isArray(parsed.applied)) {
          for (const a of parsed.applied) this.actualChanges.add(_normalize(a.path));
        }
        break;
      case 'read_file':
        if (args.path) this.actualReads.add(_normalize(args.path));
        break;
      case 'execute_command':
        if (args.command) {
          this.commandsExecuted.push({
            cmd: args.command.slice(0, 100),
            exit_code: parsed.exit_code ?? null
          });
        }
        break;
    }
  }

  /**
   * Verify claim trong summary cua task_complete
   * @param {string} summary
   * @returns {{ issues: Array, verified: Array, ground_truth: Object }}
   */
  verify(summary) {
    if (!this.enabled || !summary) {
      return { issues: [], verified: [], ground_truth: this.getGroundTruth() };
    }

    const text = String(summary);
    const issues = [];
    const verified = [];

    // Extract file path mentions
    const mentionedFiles = new Set();
    let m;
    const re = new RegExp(FILE_PATH_RE.source, 'g');
    while ((m = re.exec(text))) {
      mentionedFiles.add(_normalize(m[1]));
    }

    // For each mentioned file, check if claim is supported
    for (const mentioned of mentionedFiles) {
      const changed = this._matchesChange(mentioned);
      const read = this._matchesRead(mentioned);

      // Check if agent uses action verb near this file
      const filePattern = mentioned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const contextRe = new RegExp(`(.{0,80})(${filePattern})(.{0,80})`, 'i');
      const ctxMatch = text.match(contextRe);
      const hasActionClaim = ctxMatch && ACTION_VERBS_RE.test(ctxMatch[1] + ' ' + ctxMatch[3]);

      if (hasActionClaim && !changed) {
        issues.push({
          type: 'unverified_change',
          claim: `Summary implies change to "${mentioned}" but no matching write/edit tool call recorded`,
          file: mentioned
        });
      } else if (changed) {
        verified.push({ file: mentioned, type: 'change' });
      } else if (read) {
        verified.push({ file: mentioned, type: 'read_only' });
      }
    }

    // Check for command claims
    const cmdMatches = text.match(/```(?:bash|sh|shell)?\n([^`]+)\n```/g) || [];
    for (const block of cmdMatches) {
      const cmd = block.replace(/```(?:bash|sh|shell)?\n|\n```/g, '').trim();
      if (cmd && !this.commandsExecuted.some(c => c.cmd.includes(cmd.slice(0, 30)))) {
        issues.push({
          type: 'unverified_command',
          claim: `Summary shows command "${cmd.slice(0, 60)}" but not in execute_command history`
        });
      }
    }

    return {
      issues,
      verified,
      ground_truth: this.getGroundTruth()
    };
  }

  getGroundTruth() {
    return {
      files_changed: [...this.actualChanges],
      files_read: [...this.actualReads],
      commands_count: this.commandsExecuted.length,
      failed_commands: this.commandsExecuted.filter(c => c.exit_code !== 0 && c.exit_code !== null).length
    };
  }

  _matchesChange(mentioned) {
    // Try exact match, then suffix match
    if (this.actualChanges.has(mentioned)) return true;
    for (const actual of this.actualChanges) {
      if (actual.endsWith('/' + mentioned) || mentioned.endsWith('/' + actual)) return true;
      if (path.basename(actual) === path.basename(mentioned)) return true;
    }
    return false;
  }

  _matchesRead(mentioned) {
    if (this.actualReads.has(mentioned)) return true;
    for (const actual of this.actualReads) {
      if (actual.endsWith('/' + mentioned) || mentioned.endsWith('/' + actual)) return true;
    }
    return false;
  }

  reset() {
    this.actualChanges.clear();
    this.actualReads.clear();
    this.commandsExecuted = [];
  }
}

function _normalize(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Format issues de hien thi cho user
 */
function formatIssues(issues) {
  if (!issues?.length) return '';
  const lines = ['⚠  Context guard found unverified claims in summary:'];
  for (const i of issues) {
    lines.push(`  - [${i.type}] ${i.claim}`);
  }
  lines.push('  (These may be hallucinations — verify manually before trusting.)');
  return lines.join('\n');
}

module.exports = { ContextGuard, formatIssues };
