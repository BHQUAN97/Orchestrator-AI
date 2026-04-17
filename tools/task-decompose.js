#!/usr/bin/env node
/**
 * Task Decompose — Classify + suggest decomposition cho complex task
 *
 * Dung SLMClassifier tu Hermes de:
 * 1. Phan loai intent/complexity/domain
 * 2. Dua ra model phu hop (via INTENT_MODEL_MAP)
 * 3. Goi y co nen decompose thanh subtasks khong (spawn_team)
 *
 * Khong tu dong spawn — agent doc goi y roi tu quyet spawn_subagent / spawn_team.
 * Chi phi: 1 classifier call (~$0.0001).
 */

const { INTENT_MODEL_MAP } = require('../router/slm-classifier');

async function decomposeTask(args, ctx) {
  const { prompt } = args;
  if (!prompt) return { success: false, error: 'prompt is required' };
  if (!ctx?.hermesBridge?.classifier) {
    return {
      success: false,
      error: 'Classifier unavailable. Start orcai with --use-classifier to enable.'
    };
  }

  try {
    const classification = await ctx.hermesBridge.classifier.classify({
      task: '', files: [], prompt
    });

    if (!classification?.intent) {
      return { success: false, error: 'Classifier returned no intent' };
    }

    const key = `${classification.intent}:${classification.complexity}`;
    const suggestedModel = INTENT_MODEL_MAP[key] || 'default';
    const complex = ['complex', 'expert'].includes(classification.complexity);

    // Heuristic decomposition suggestions
    const suggestions = [];
    if (complex) {
      switch (classification.domain) {
        case 'fullstack':
          suggestions.push({
            agents: [
              { description: 'Backend changes', subagent_type: 'explore', focus: 'api, database, services' },
              { description: 'Frontend changes', subagent_type: 'explore', focus: 'components, pages, state' }
            ],
            rationale: 'Fullstack task — split FE + BE for parallel exploration'
          });
          break;
        case 'backend':
          suggestions.push({
            agents: [
              { description: 'Code implementation', subagent_type: 'general-purpose', focus: 'service + API handler' },
              { description: 'Data layer', subagent_type: 'general-purpose', focus: 'migrations, schema, queries' }
            ],
            rationale: 'Backend complex — split logic + data for parallel work'
          });
          break;
        case 'frontend':
          suggestions.push({
            agents: [
              { description: 'Component structure', subagent_type: 'general-purpose', focus: 'JSX + hooks' },
              { description: 'Styles + responsive', subagent_type: 'general-purpose', focus: 'CSS, Tailwind, breakpoints' }
            ],
            rationale: 'FE complex — split component + style for parallel work'
          });
          break;
      }

      // Review pass suggestion
      if (classification.intent === 'build' || classification.intent === 'refactor') {
        suggestions.push({
          phase: 'post-implementation',
          agent: { description: 'Review changes', subagent_type: 'review' },
          rationale: 'Complex change — run reviewer subagent after implement'
        });
      }
    }

    return {
      success: true,
      classification,
      suggested_model: suggestedModel,
      complex,
      decomposition: suggestions.length > 0 ? suggestions : null,
      advice: complex
        ? 'Complex task — consider spawn_team with the suggested agents. Or switch model: use ' + suggestedModel
        : 'Simple/medium task — handle directly with current tools. Single agent sufficient.'
    };
  } catch (e) {
    return { success: false, error: `Classify failed: ${e.message}` };
  }
}

module.exports = { decomposeTask };
