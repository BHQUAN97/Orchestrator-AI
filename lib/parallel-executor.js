#!/usr/bin/env node
/**
 * Parallel Executor — Chay song song cho read-safe tools
 *
 * Khi LLM tra ve 1 batch tool_calls co nhieu read-safe tools (read_file,
 * list_files, search_files, glob, web_fetch...), ta chay song song voi
 * Promise.all thay vi tuan tu → tang toc rat nhieu.
 *
 * Read-safe = khong side effect: khong ghi file, khong chay lenh, khong
 * spawn subagent (vi spawn dung budget). Chi doc.
 *
 * Write-unsafe tools (write_file, edit_file, execute_command, spawn_*)
 * VAN chay tuan tu — cac tool nay co the depend on nhau (vi du edit sau
 * khi write).
 */

const READ_SAFE_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_files',
  'glob',
  'web_fetch',
  'web_search',
  'memory_recall',
  'memory_list',
  'todo_list',
  'decompose_task',
  'read_mcp_resource'
]);

/**
 * Kiem tra 1 batch tool calls co phai toan read-safe khong
 */
function isBatchReadSafe(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
  if (toolCalls.length < 2) return false; // 1 call khong can parallel
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (!name || !READ_SAFE_TOOLS.has(name)) return false;
  }
  return true;
}

/**
 * Check neu 1 tool name la read-safe
 */
function isReadSafe(toolName) {
  return READ_SAFE_TOOLS.has(toolName);
}

module.exports = { isBatchReadSafe, isReadSafe, READ_SAFE_TOOLS };
