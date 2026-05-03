#!/usr/bin/env node
'use strict';

/**
 * orcai-extract-training-data
 * Extracts fine-tuning data from OrcAI memory for local Qwen 7B training.
 *
 * Usage:
 *   node bin/orcai-extract-training-data.js [project-dir] [options]
 *   node bin/orcai-extract-training-data.js . --min-confidence 0.7 --format alpaca
 *   node bin/orcai-extract-training-data.js . --dry-run
 *
 * Output: .orcai/training/YYYY-MM-DD.jsonl (alpaca or chatml format)
 */

const fs = require('fs');
const path = require('path');

// --- CLI arg parsing ---
const args = process.argv.slice(2);
const projectDir = args.find(a => !a.startsWith('--')) || process.cwd();
const dryRun = args.includes('--dry-run');
const format = (args.find(a => a.startsWith('--format=')) || '').split('=')[1] || 'alpaca'; // alpaca | chatml
const minConfidence = parseFloat((args.find(a => a.startsWith('--min-confidence=')) || '').split('=')[1] || '0.6');
const minHelpedRatio = parseFloat((args.find(a => a.startsWith('--min-helped-ratio=')) || '').split('=')[1] || '0.0');
const includeGrades = ((args.find(a => a.startsWith('--grades=')) || '').split('=')[1] || 'lesson,established_pattern').split(',');

// --- Paths ---
const memoryPath = path.join(projectDir, '.orcai', 'memory', 'lessons.jsonl');
const trainingDir = path.join(projectDir, '.orcai', 'training');
const today = new Date().toISOString().slice(0, 10);
const outputPath = path.join(trainingDir, today + '.jsonl');

// --- Load memory ---
function loadMemory(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error('Memory file not found: ' + filePath);
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed JSON lines */ }
  }
  return entries;
}

// --- Filter entries suitable for training ---
function filterTrainable(entries) {
  return entries.filter(function(e) {
    // Must be in allowed grades
    const grade = e.grade || 'lesson';
    if (!includeGrades.includes(grade)) return false;

    // Must meet confidence threshold
    const conf = e.confidence || 0.5;
    if (conf < minConfidence) return false;

    // Must meet helped ratio threshold (if has usage data)
    if (e.used_count > 0) {
      const ratio = (e.helped_count || 0) / e.used_count;
      if (ratio < minHelpedRatio) return false;
    }

    // Skip entries with no useful summary
    if (!e.summary || e.summary.length < 10) return false;

    // Skip pure failures unless they're gotchas (negative examples are useful)
    if (e.outcome === 'fail' && e.type !== 'gotcha') return false;

    return true;
  });
}

// --- Convert to Alpaca format ---
// {"instruction": "...", "input": "...", "output": "..."}
function toAlpaca(entry) {
  const taskContext = entry.prompt_summary ? 'Task context: ' + entry.prompt_summary : '';
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(function(t) { return !t.startsWith('#'); }).join(', ') : '';

  if (entry.type === 'gotcha') {
    return {
      instruction: 'You are an AI coding agent. Avoid this mistake when working on similar tasks.',
      input: [taskContext, tags ? 'Domain: ' + tags : ''].filter(Boolean).join('\n'),
      output: 'AVOID: ' + entry.summary + (Array.isArray(entry.tool_chain) && entry.tool_chain.length ? '\nThis error occurred after: ' + entry.tool_chain.join(' -> ') : '')
    };
  }

  if (entry.type === 'model_escalation') {
    return {
      instruction: 'You are routing a coding task to the appropriate AI model.',
      input: taskContext,
      output: 'This task required escalation from ' + entry.model_used + ' to ' + entry.model_final + ': ' + entry.summary
    };
  }

  if (entry.type === 'tool_pattern') {
    return {
      instruction: 'You are an AI coding agent. Use effective tool sequences for coding tasks.',
      input: taskContext,
      output: 'Effective tool pattern: ' + (Array.isArray(entry.tools_used) ? entry.tools_used.join(' -> ') : '') + '\n' + entry.summary
    };
  }

  // Default: lesson / established_pattern
  return {
    instruction: 'You are an AI coding agent. Apply learned best practices for this task.',
    input: taskContext,
    output: entry.summary
  };
}

// --- Convert to ChatML format ---
// {"messages": [{"role": "system", ...}, {"role": "user", ...}, {"role": "assistant", ...}]}
function toChatML(entry) {
  const alpaca = toAlpaca(entry);
  return {
    messages: [
      { role: 'system', content: alpaca.instruction },
      { role: 'user', content: alpaca.input || 'Apply this learning.' },
      { role: 'assistant', content: alpaca.output }
    ]
  };
}

// --- Main ---
function main() {
  console.log('OrcAI Training Data Extractor');
  console.log('Project: ' + path.resolve(projectDir));
  console.log('Memory: ' + memoryPath);
  console.log('Format: ' + format + ' | Min confidence: ' + minConfidence + ' | Grades: ' + includeGrades.join(','));
  console.log('');

  const all = loadMemory(memoryPath);
  console.log('Loaded ' + all.length + ' memory entries');

  const trainable = filterTrainable(all);
  console.log('Filtered to ' + trainable.length + ' trainable entries');

  if (trainable.length === 0) {
    console.log('No trainable entries found. Run more OrcAI sessions to accumulate memory.');
    return;
  }

  // Stats
  const byType = {};
  const byGrade = {};
  for (const e of trainable) {
    const t = e.type || 'unknown';
    const g = e.grade || 'lesson';
    byType[t] = (byType[t] || 0) + 1;
    byGrade[g] = (byGrade[g] || 0) + 1;
  }
  console.log('By type: ' + JSON.stringify(byType));
  console.log('By grade: ' + JSON.stringify(byGrade));

  if (dryRun) {
    console.log('\n--- DRY RUN: Sample output (first 3 entries) ---');
    trainable.slice(0, 3).forEach(function(e, i) {
      const converted = format === 'chatml' ? toChatML(e) : toAlpaca(e);
      console.log('\n[' + (i + 1) + '] ' + e.type + ' | ' + (e.grade || 'lesson') + ' | conf=' + (e.confidence || 0.5));
      console.log(JSON.stringify(converted, null, 2));
    });
    return;
  }

  // Write output
  if (!fs.existsSync(trainingDir)) fs.mkdirSync(trainingDir, { recursive: true });

  const lines = trainable.map(function(e) {
    const converted = format === 'chatml' ? toChatML(e) : toAlpaca(e);
    return JSON.stringify(converted);
  });

  fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
  console.log('\nWrote ' + lines.length + ' training examples to: ' + outputPath);
  console.log('\nNext steps:');
  console.log('  Fine-tune Qwen 7B (GTX 1060 6GB Q4_K_M):');
  console.log('    Use LLaMA-Factory or Unsloth with this JSONL');
  console.log('    Recommended: LoRA rank=16, epochs=3, lr=2e-4');
  console.log('  Or upload to RunPod for cloud fine-tune (~$0.40/h on RTX 4090)');
}

main();
