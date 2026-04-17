#!/usr/bin/env node
/**
 * Create Skill — Tool cho agent/user tao custom slash command moi
 *
 * Ghi file .md vao {projectDir}/.claude/commands/ (preferred, Claude Code style)
 * hoac {projectDir}/skills/ (legacy orcai).
 *
 * Format: YAML frontmatter + body.
 * Trigger keywords stored de skill-matcher auto-suggest.
 */

const fs = require('fs');
const path = require('path');

const INVALID_NAME_RE = /[^a-zA-Z0-9_-]/;

/**
 * @param {{ name, description, body, trigger?, argument_hint?, location? }} args
 * @param {string} projectDir
 */
async function createSkill(args, projectDir) {
  const {
    name,
    description,
    body,
    trigger,
    argument_hint,
    location = 'claude'  // 'claude' → .claude/commands/, 'skills' → skills/
  } = args;

  if (!name || INVALID_NAME_RE.test(name)) {
    return { success: false, error: 'name required and must be [a-zA-Z0-9_-] only' };
  }
  if (name.length > 60) {
    return { success: false, error: 'name too long (max 60 chars)' };
  }
  if (!description) {
    return { success: false, error: 'description is required' };
  }
  if (!body || body.trim().length < 10) {
    return { success: false, error: 'body must be at least 10 chars of meaningful content' };
  }

  const targetDir = location === 'skills'
    ? path.join(projectDir, 'skills')
    : path.join(projectDir, '.claude', 'commands');

  const targetFile = path.join(targetDir, `${name}.md`);

  // Don't overwrite existing
  if (fs.existsSync(targetFile)) {
    return {
      success: false,
      error: `Skill "${name}" already exists at ${targetFile}. Delete first or use a different name.`
    };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    return { success: false, error: `Cannot create skill dir: ${e.message}` };
  }

  // Compose content
  const frontmatter = ['---'];
  frontmatter.push(`description: ${_escapeYaml(description)}`);
  if (trigger) frontmatter.push(`trigger: ${_escapeYaml(trigger)}`);
  if (argument_hint) frontmatter.push(`argument-hint: ${_escapeYaml(argument_hint)}`);
  frontmatter.push('---');
  frontmatter.push('');
  frontmatter.push(body.trim());
  frontmatter.push('');

  const content = frontmatter.join('\n');

  try {
    fs.writeFileSync(targetFile, content, 'utf-8');
  } catch (e) {
    return { success: false, error: `Failed to write skill: ${e.message}` };
  }

  return {
    success: true,
    name,
    path: path.relative(projectDir, targetFile),
    invoke_as: `/${name}${argument_hint ? ' ' + argument_hint : ''}`,
    location
  };
}

function _escapeYaml(s) {
  const str = String(s).trim();
  if (/[:\[\]{},&*#?|<>=!%@\-]/.test(str) || str.includes('\n')) {
    return `"${str.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return str;
}

module.exports = { createSkill };
