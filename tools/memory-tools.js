#!/usr/bin/env node
/**
 * Memory Tools — Agent-facing wrappers for MemoryStore
 *
 * - memory_save: agent explicitly save a lesson/fact/gotcha
 * - memory_recall: agent search past experience
 * - memory_list: agent view recent entries
 *
 * Note: Auto-save on task_complete happens in agent-loop (not a tool call).
 */

async function memorySave(args, store) {
  const { type = 'manual', summary, details, keywords } = args;
  if (!store) return { success: false, error: 'Memory store not initialized' };
  if (!summary) return { success: false, error: 'summary is required' };

  const entry = store.append({
    type: ['manual', 'lesson', 'gotcha', 'fact'].includes(type) ? type : 'manual',
    summary: String(summary).slice(0, 1000),
    details: details ? String(details).slice(0, 3000) : undefined,
    keywords: Array.isArray(keywords) ? keywords.slice(0, 15) : undefined
  });

  if (!entry) return { success: false, error: 'Failed to write memory' };
  return { success: true, id: entry.id, type: entry.type };
}

async function memoryRecall(args, store) {
  const { query, limit = 5 } = args;
  if (!store) return { success: false, error: 'Memory store not initialized' };
  if (!query) return { success: false, error: 'query is required' };

  const results = store.search(query, Math.min(Math.max(limit, 1), 20));
  return { success: true, query, results, total: results.length };
}

async function memoryList(args, store) {
  const { limit = 20, type } = args || {};
  if (!store) return { success: false, error: 'Memory store not initialized' };
  const entries = store.list({ limit: Math.min(Math.max(limit, 1), 100), type });
  const stats = store.getStats();
  return { success: true, entries, stats };
}

module.exports = { memorySave, memoryRecall, memoryList };
