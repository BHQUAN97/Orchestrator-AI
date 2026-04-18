#!/usr/bin/env node
/**
 * Batch Edit — atomic multi-file edit
 *
 * Agent truyen array edits: [{ path, old_string, new_string, replace_all? }, ...]
 * Atomic: validate TAT CA truoc khi ghi bat ky file nao.
 * Neu bat ky validation fails → return error, khong ghi gi.
 * Snapshot shadow-git 1 lan cho ca batch.
 *
 * Ideal cho refactor xuyen file: rename symbol, update imports, etc.
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {{ edits: Array<{path, old_string, new_string, replace_all?}> }} args
 * @param {FileManager} fileManager
 */
async function batchEdit(args, fileManager) {
  if (!args || typeof args !== 'object') {
    return { success: false, error: 'args phải là object chứa array edits' };
  }
  const { edits } = args;

  if (!Array.isArray(edits) || edits.length === 0) {
    return { success: false, error: 'edits must be a non-empty array' };
  }

  if (edits.length > 50) {
    return { success: false, error: `Too many edits (${edits.length}); max 50 per batch` };
  }

  // Phase 1: Validate tat ca — khong ghi gi
  const plans = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const { path: filePath, old_string, new_string, replace_all = false } = edit;

    if (!filePath || old_string === undefined || new_string === undefined) {
      return { success: false, error: `Edit #${i}: missing path/old_string/new_string` };
    }

    // Reuse validation tu FileManager
    let resolved;
    try {
      resolved = fileManager._validateWritePath(filePath);
    } catch (e) {
      return { success: false, error: `Edit #${i} (${filePath}): ${e.message}` };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, error: `Edit #${i}: file not found — ${filePath}` };
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    if (!content.includes(old_string)) {
      return { success: false, error: `Edit #${i} (${filePath}): old_string not found` };
    }

    const occurrences = content.split(old_string).length - 1;
    if (occurrences > 1 && !replace_all) {
      return {
        success: false,
        error: `Edit #${i} (${filePath}): ${occurrences} occurrences, set replace_all:true or use unique context`
      };
    }

    const after = replace_all
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, new_string);

    plans.push({
      path: filePath,
      resolved,
      before: content,
      after,
      replacements: replace_all ? occurrences : 1
    });
  }

  // Phase 2: Shadow-git snapshot (1 lan cho toan bo batch)
  if (fileManager.shadowGit) {
    await fileManager.shadowGit.ensureSnapshot('pre-batch-edit');
  }

  // Phase 3: Apply tat ca
  const applied = [];
  const failures = [];
  for (const plan of plans) {
    try {
      fs.writeFileSync(plan.resolved, plan.after, 'utf-8');
      applied.push({
        path: path.relative(fileManager.projectDir, plan.resolved),
        replacements: plan.replacements
      });
    } catch (e) {
      failures.push({ path: plan.path, error: e.message });
    }
  }

  return {
    success: failures.length === 0,
    applied,
    total: applied.length,
    ...(failures.length > 0 ? { failures } : {})
  };
}

module.exports = { batchEdit };
