#!/usr/bin/env node
/**
 * Orchestrator v3 — Nang cap tu v2.1: agents co "tay chan" (tools)
 *
 * THAY DOI CHINH so voi v2.1:
 * - v2.1: Agent chi nhan text prompt → tra text response
 * - v3: Agent nhan prompt + tools → tu doc file, sua code, chay test
 *
 * FLOW (ke thua v2.1 — scan → plan → review → execute):
 * 1. Scanner (cheap) quet project, thu thap context
 * 2. Planner (default) xay dung plan tu scan data
 * 3. Tech Lead (smart/Sonnet) review plan → approve/modify
 * 4. Agents thuc thi subtasks VOI TOOLS — doc/ghi file, chay lenh
 * 5. Self-correction: neu test fail → agent tu sua
 * 6. Neu agent gap kho → escalate: smart → architect (Opus)
 * 7. Tong hop ket qua
 *
 * Tich hop:
 * - Ke thua scan(), plan(), review(), execute() tu v2.1
 * - Them AgentLoop cho moi subtask execution
 * - Them ToolExecutor cho file/terminal operations
 */

const path = require('path');
const { OrchestratorAgent, AGENT_ROLE_MAP } = require('../router/orchestrator-agent');
const { AgentLoop } = require('./agent-loop');
const { getToolsSummary } = require('../tools/definitions');

class OrchestratorV3 extends OrchestratorAgent {
  constructor(options = {}) {
    super(options);
    this.useTools = options.useTools !== false; // Mặc định bật tool use

    // Callbacks cho UI
    this.onToolCall = options.onToolCall || null;
    this.onToolResult = options.onToolResult || null;
    this.onConfirm = options.onConfirm || null;
  }

  /**
   * Override _executeSubtask từ v2
   * Thay vì chỉ gọi model → nhận text, giờ dùng AgentLoop với tools
   */
  async _executeSubtask(subtask, context, previousResults) {
    if (!this.useTools) {
      // Fallback v2: chỉ gọi model lấy text
      return super._executeSubtask(subtask, context, previousResults);
    }

    const start = Date.now();
    const agentRole = subtask.agentRole || 'builder';

    // Xac dinh task type tu agentRole (khong dung model name)
    const ROLE_TO_TASK = {
      'architect': 'design', 'tech-lead': 'review', 'debugger': 'debug',
      'reviewer': 'review', 'scanner': 'analyze', 'planner': 'plan',
      'fe-dev': 'build', 'be-dev': 'build', 'builder': 'build',
      'docs': 'docs'
    };
    const taskType = ROLE_TO_TASK[agentRole] || 'build';

    // Build context (ke thua v2.1)
    const structuredCtx = await this.contextManager.build({
      task: taskType,
      description: subtask.description,
      files: subtask.files || [],
      feature: context.feature || null,
      previousResults: this._getPreviousResults(subtask, previousResults)
    });

    // Inject context vào prompt
    const contextPrompt = this.contextManager.inject(structuredCtx, agentRole);

    // Check decision locks
    for (const file of (subtask.files || [])) {
      const validation = this.decisionLock.validate(file, agentRole);
      if (!validation.allowed) {
        return {
          id: subtask.id,
          model: subtask.model,
          agentRole,
          output: `BLOCKED: File "${file}" có locked decision.`,
          elapsed_ms: Date.now() - start,
          success: false,
          blocked: true
        };
      }
    }

    // === DÙNG AGENT LOOP thay vì _callModel ===
    const agentLoop = new AgentLoop({
      litellmUrl: this.litellmUrl,
      litellmKey: this.litellmKey,
      model: subtask.model,
      projectDir: this.projectDir,
      agentRole,
      maxIterations: 20, // Mỗi subtask tối đa 20 iterations

      // Forward callbacks
      onToolCall: this.onToolCall,
      onToolResult: this.onToolResult,
      onConfirm: this.onConfirm,

      // Khi agent text output (không phải tool call)
      onText: (text) => {
        // Log nhưng không interrupt flow
      }
    });

    // System prompt = context từ v2 + tool instructions
    const systemPrompt = `${contextPrompt}

BẠN CÓ CÁC TOOLS:
${getToolsSummary()}

Sau khi hoàn thành, gọi task_complete với summary ngắn gọn.`;

    try {
      const result = await agentLoop.run(systemPrompt, subtask.description);
      const elapsed = Date.now() - start;

      return {
        id: subtask.id,
        model: subtask.model,
        agentRole,
        output: result.summary || result.final_message || 'No output',
        elapsed_ms: elapsed,
        tokens: result.tool_calls * 500, // Estimate
        success: result.success,
        iterations: result.iterations,
        tool_calls: result.tool_calls,
        files_changed: result.files_changed,
        escalated: false
      };
    } catch (err) {
      return {
        id: subtask.id,
        model: subtask.model,
        agentRole,
        output: `Error: ${err.message}`,
        elapsed_ms: Date.now() - start,
        success: false
      };
    }
  }

  /**
   * Override _printReport — thêm tool stats
   */
  _printReport(execution) {
    super._printReport(execution);

    // Thêm tool stats
    const allFiles = [];
    const totalToolCalls = [];
    for (const result of Object.values(execution.results)) {
      if (result.files_changed) allFiles.push(...result.files_changed);
      if (result.tool_calls) totalToolCalls.push(result.tool_calls);
    }

    if (allFiles.length > 0) {
      console.log(`📁 Files changed: ${[...new Set(allFiles)].join(', ')}`);
    }
    if (totalToolCalls.length > 0) {
      console.log(`🔧 Total tool calls: ${totalToolCalls.reduce((a, b) => a + b, 0)}`);
    }
  }
}

module.exports = { OrchestratorV3 };
