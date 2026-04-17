#!/usr/bin/env node
/**
 * Agent Todos — Agent self-tracking tasks trong session
 *
 * Giong TodoWrite/TaskCreate cua Claude Code.
 * Agent tu tao/update danh sach task nho de track progress trong 1 run.
 * User thay todo list → biet agent dang lam gi, xong den dau.
 *
 * Life cycle: in-memory per AgentLoop instance. Reset khi new run().
 * Khong persist ra disk — chi la working memory cua agent.
 *
 * Tools:
 * - todo_write(todos: [{id?, subject, activeForm?, status?}, ...]) — bulk upsert
 *   - Neu co id → update. Neu khong → create mới.
 *   - Status: pending | in_progress | completed | deleted
 * - todo_list() — return tat ca todos hien co
 */

class AgentTodoStore {
  constructor() {
    this.todos = [];
    this.nextId = 1;
  }

  upsert({ id, subject, activeForm, status, description }) {
    if (id && this.todos.find(t => t.id === id)) {
      const todo = this.todos.find(t => t.id === id);
      if (subject !== undefined) todo.subject = subject;
      if (activeForm !== undefined) todo.activeForm = activeForm;
      if (description !== undefined) todo.description = description;
      if (status !== undefined) {
        todo.status = status;
        if (status === 'completed' && !todo.completedAt) todo.completedAt = Date.now();
      }
      return todo;
    }
    // Create
    const todo = {
      id: id || this.nextId++,
      subject: subject || '(unnamed)',
      activeForm: activeForm || subject,
      description: description || '',
      status: status || 'pending',
      createdAt: Date.now()
    };
    // Bump nextId if client supplied high id
    if (todo.id >= this.nextId) this.nextId = todo.id + 1;
    this.todos.push(todo);
    return todo;
  }

  list() { return [...this.todos]; }

  reset() { this.todos = []; this.nextId = 1; }

  getStats() {
    return {
      total: this.todos.length,
      pending: this.todos.filter(t => t.status === 'pending').length,
      in_progress: this.todos.filter(t => t.status === 'in_progress').length,
      completed: this.todos.filter(t => t.status === 'completed').length
    };
  }
}

/**
 * todo_write handler — bulk upsert todos
 * @param {{ todos: Array }} args
 * @param {AgentTodoStore} store
 * @param {Function} [onUpdate] - callback(todos) de CLI re-render
 */
function todoWrite(args, store, onUpdate) {
  if (!args || !Array.isArray(args.todos)) {
    return { success: false, error: 'todos must be an array' };
  }
  if (args.todos.length > 100) {
    return { success: false, error: `Too many todos (${args.todos.length}); max 100` };
  }

  const results = [];
  for (const t of args.todos) {
    if (t.status === 'deleted' && t.id) {
      // Delete
      const idx = store.todos.findIndex(s => s.id === t.id);
      if (idx !== -1) store.todos.splice(idx, 1);
      continue;
    }
    results.push(store.upsert(t));
  }

  if (onUpdate) {
    try { onUpdate(store.list()); } catch { /* ignore */ }
  }

  return {
    success: true,
    todos: results,
    stats: store.getStats()
  };
}

/**
 * todo_list handler
 */
function todoList(args, store) {
  return { success: true, todos: store.list(), stats: store.getStats() };
}

/**
 * Render todos cho CLI display
 */
function renderTodos(todos) {
  const chalk = require('chalk');
  if (!todos.length) return chalk.gray('  (no todos)');
  const icon = { pending: '☐', in_progress: '◐', completed: '✓', deleted: '✗' };
  const color = { pending: 'gray', in_progress: 'yellow', completed: 'green', deleted: 'red' };
  return todos.map(t => {
    const ic = icon[t.status] || '☐';
    const text = t.status === 'in_progress' ? t.activeForm : t.subject;
    const c = color[t.status] || 'white';
    return chalk[c](`  ${ic} ${text}`);
  }).join('\n');
}

module.exports = { AgentTodoStore, todoWrite, todoList, renderTodos };
