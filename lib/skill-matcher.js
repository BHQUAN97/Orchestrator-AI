#!/usr/bin/env node
/**
 * Skill Matcher — Detect trigger keywords trong prompt → suggest skill
 *
 * Moi skill .md co the co:
 * - YAML frontmatter: trigger: "fix, bug, sua"
 * - Legacy section: ## Trigger\nfix bug, sua code, ...
 *
 * Skill Matcher:
 * 1. Load tat ca skills
 * 2. Extract trigger keywords
 * 3. Khi user go prompt → score moi skill (keyword count / prompt length)
 * 4. Tra ve top matches voi score > threshold
 *
 * Khong tu dong execute — chi suggest de user biet co skill phu hop.
 */

const { discoverCommands } = require('./slash-commands');

const MIN_KEYWORD_LEN = 3;
const SCORE_THRESHOLD = 0.2;

/**
 * Parse trigger keywords tu skill body/meta
 */
function extractTriggers(cmd) {
  const triggers = new Set();

  // YAML frontmatter field
  if (cmd.trigger) {
    for (const t of String(cmd.trigger).split(/[,;|]/)) {
      const cleaned = t.trim().toLowerCase();
      if (cleaned.length >= MIN_KEYWORD_LEN) triggers.add(cleaned);
    }
  }

  // Legacy: ## Trigger section
  const body = cmd.body || '';
  const triggerMatch = body.match(/##\s*Trigger\s*\n([\s\S]*?)(?:\n##|\n$|$)/i);
  if (triggerMatch) {
    // Parse tokens (comma or line-separated)
    const text = triggerMatch[1];
    for (const t of text.split(/[,\n]/)) {
      const cleaned = t.replace(/^[-*•]+\s*/, '').trim().toLowerCase();
      if (cleaned.length >= MIN_KEYWORD_LEN && !cleaned.startsWith('khi ')) {
        // Split phrases to individual keywords
        for (const word of cleaned.split(/[\s:]+/)) {
          if (word.length >= MIN_KEYWORD_LEN && !/^[a-z]{1,2}$/i.test(word)) {
            triggers.add(word);
          }
        }
      }
    }
  }

  return [...triggers];
}

/**
 * Index skills with their triggers
 */
function buildIndex(projectDir) {
  const commands = discoverCommands(projectDir);
  const index = [];
  for (const cmd of commands.values()) {
    const triggers = extractTriggers(cmd);
    if (triggers.length === 0) continue;
    index.push({
      name: cmd.name,
      description: cmd.description,
      triggers
    });
  }
  return index;
}

/**
 * Score prompt against index — tra ve ranked matches
 * @param {string} prompt
 * @param {Array} index - tu buildIndex()
 * @param {number} limit
 * @returns {Array<{name, score, matched}>}
 */
function match(prompt, index, limit = 3) {
  if (!prompt || !index?.length) return [];

  const promptLower = prompt.toLowerCase();
  const results = [];

  for (const skill of index) {
    const matched = skill.triggers.filter(t => promptLower.includes(t));
    if (matched.length === 0) continue;

    // Score: so keyword match / tong trigger (weighted)
    const uniqMatched = new Set(matched).size;
    const score = uniqMatched / Math.max(skill.triggers.length, 1);
    if (score < SCORE_THRESHOLD) continue;

    results.push({
      name: skill.name,
      description: skill.description,
      score: Number(score.toFixed(2)),
      matched: [...new Set(matched)]
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Shortcut: load + match
 */
function suggestSkills(prompt, projectDir, limit = 3) {
  const index = buildIndex(projectDir);
  return match(prompt, index, limit);
}

module.exports = { extractTriggers, buildIndex, match, suggestSkills };
