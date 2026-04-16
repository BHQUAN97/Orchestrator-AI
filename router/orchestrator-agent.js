#!/usr/bin/env node
/**
 * Orchestrator Agent v2 — Multi-model orchestration với Tech Lead + Escalation
 *
 * FLOW HOÀN CHỈNH:
 * 1. User gửi task → Dispatcher (Gemini Flash, rẻ) phân tích → tạo plan
 * 2. Tech Lead (Claude Sonnet) quick review plan → approve/modify/reject
 * 3. Context Manager normalize context → inject vào mỗi agent
 * 4. Execute subtasks → dev agents (Kimi/DeepSeek) chạy song song
 * 5. Nếu agent gặp khó → escalate lên Tech Lead
 * 6. Tech Lead xử lý escalation → GUIDE/REDIRECT/TAKE_OVER
 * 7. Dispatcher tổng hợp kết quả cuối cùng
 *
 * Anti-patterns đã giải quyết:
 * ❌ Agent tự quyết API → ✅ Decision Lock, Tech Lead approve
 * ❌ Output không normalize → ✅ Context Manager normalize
 * ❌ Context dạng text dài → ✅ Structured JSON context
 * ❌ Agent override nhau → ✅ Decision Lock registry
 */

const { SmartRouter } = require('./smart-router');
const { ContextManager } = require('./context-manager');
const { DecisionLock } = require('./decision-lock');
const { TechLeadAgent } = require('./tech-lead-agent');

const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:4001';
const LITELLM_KEY = process.env.LITELLM_KEY || 'sk-master-change-me';

// === Agent Role → Model mapping ===
// Mỗi subtask có agentRole, map sang model phù hợp
const AGENT_ROLE_MAP = {
  'tech-lead':  'smart',   // Claude Sonnet — reasoning sâu
  'fe-dev':     'default',  // Kimi K2.5 — FE specialist
  'be-dev':     'cheap',    // DeepSeek — BE specialist
  'reviewer':   'fast',     // Gemini Flash — scan nhanh, rẻ
  'debugger':   'smart',    // Claude Sonnet — cần trace sâu
  'docs':       'cheap',    // DeepSeek — text generation
  'builder':    'default',  // Kimi K2.5 — general code
  'dispatcher': 'fast'      // Gemini Flash — phân tích rẻ
};

// === Dispatcher Prompt (nâng cấp) ===
const DISPATCHER_SYSTEM = `Bạn là AI Orchestrator — phân tích và chia việc cho các agent chuyên biệt.

KHÔNG tự làm — chỉ phân tích rồi chia việc.

CÁC AGENT CÓ SẴN:
- "fe-dev" → model "default" (Kimi K2.5): Frontend — React, Next.js, Vue, CSS, Tailwind. RẺ.
- "be-dev" → model "cheap" (DeepSeek): Backend — NestJS, Express, DB, SQL, API. RẺ.
- "reviewer" → model "fast" (Gemini Flash): Review, scan, summarize. RẺ NHẤT.
- "debugger" → model "smart" (Claude Sonnet): Debug phức tạp, trace cross-file. ĐẮT.
- "docs" → model "cheap" (DeepSeek): Docs, comment, format. RẺ.
- "builder" → model "default" (Kimi K2.5): General code — khi không rõ FE/BE.

NGUYÊN TẮC:
1. Ưu tiên agent RẺ nhất có thể làm được
2. Chỉ dùng "debugger" (smart/đắt) khi THỰC SỰ cần trace > 3 files
3. Chia nhỏ task để mỗi agent chỉ làm phần chuyên của nó
4. Nếu task đơn giản → 1 agent là đủ, KHÔNG chia nhỏ quá mức
5. Gán agentRole cho mỗi subtask

Trả về JSON (KHÔNG markdown, KHÔNG giải thích):
{
  "analysis": "1 dòng mô tả công việc",
  "subtasks": [
    {
      "id": 1,
      "description": "Mô tả sub-task",
      "agentRole": "fe-dev|be-dev|reviewer|debugger|docs|builder",
      "model": "fast|default|cheap|smart",
      "reason": "Tại sao chọn agent này",
      "files": ["file1.ts"],
      "depends_on": [],
      "estimated_tokens": 5000
    }
  ],
  "parallel_groups": [[1,2], [3]],
  "total_estimated_cost": "$0.05"
}`;

// Số lần escalation tối đa cho 1 subtask trước khi dừng
const MAX_ESCALATIONS_PER_TASK = 3;

// === Orchestrator Agent v2 ===
class OrchestratorAgent {
  constructor(options = {}) {
    this.litellmUrl = options.litellmUrl || LITELLM_URL;
    this.litellmKey = options.litellmKey || LITELLM_KEY;
    this.projectDir = options.projectDir || process.cwd();
    this.dispatcherModel = options.dispatcherModel || 'fast';

    // Core modules
    this.smartRouter = new SmartRouter({
      availableModels: options.availableModels || ['gemini-flash', 'kimi-k2.5', 'deepseek', 'sonnet'],
      costOptimize: true
    });

    this.decisionLock = new DecisionLock({ projectDir: this.projectDir });

    this.contextManager = new ContextManager({
      projectDir: this.projectDir,
      projectName: options.projectName || require('path').basename(this.projectDir),
      decisionLock: this.decisionLock
    });

    this.techLead = new TechLeadAgent({
      litellmUrl: this.litellmUrl,
      litellmKey: this.litellmKey,
      projectDir: this.projectDir,
      decisionLock: this.decisionLock,
      contextManager: this.contextManager
    });

    // Config
    this.techLeadReview = options.techLeadReview !== false; // Mặc định bật
    this.maxEscalations = options.maxEscalations || MAX_ESCALATIONS_PER_TASK;

    // Logging
    this.executionLog = [];
  }

  // =============================================
  // FLOW CHÍNH: plan → review → execute → synthesize
  // =============================================

  /**
   * Bước 1: Phân tích task → tạo execution plan
   * Dùng Gemini Flash (rẻ nhất) làm dispatcher
   */
  async plan(userPrompt, context = {}) {
    const { files = [], project = '', feature = null } = context;

    // Build structured context
    const structuredCtx = await this.contextManager.build({
      task: context.task || 'build',
      description: userPrompt,
      files,
      feature
    });

    // Build prompt cho dispatcher — kèm locked decisions
    const activeLocks = this.decisionLock.getActive();
    const lockInfo = activeLocks.length > 0
      ? `\nLOCKED DECISIONS (KHÔNG thay đổi):\n${activeLocks.map(l => `- [${l.scope}] ${l.decision}`).join('\n')}`
      : '';

    const prompt = [
      `PROJECT: ${structuredCtx.project.name} (${structuredCtx.project.stack.join(', ')})`,
      `BRANCH: ${structuredCtx.project.branch}`,
      files.length > 0 ? `FILES: ${files.join(', ')}` : '',
      `DOMAIN: ${structuredCtx.task.domain}`,
      lockInfo,
      context.contextData ? `\nCONTEXT:\n${context.contextData}` : '',
      `\nTASK: ${userPrompt}`
    ].filter(Boolean).join('\n');

    // Gọi Gemini Flash để phân tích
    const response = await this._callModel(this.dispatcherModel, DISPATCHER_SYSTEM, prompt);

    try {
      const plan = JSON.parse(response.replace(/```json?\n?/g, '').replace(/```/g, '').trim());

      // Đảm bảo mỗi subtask có agentRole
      for (const subtask of plan.subtasks) {
        if (!subtask.agentRole) {
          subtask.agentRole = this._inferAgentRole(subtask);
        }
        if (!subtask.model) {
          subtask.model = AGENT_ROLE_MAP[subtask.agentRole] || 'default';
        }
      }

      return plan;
    } catch (e) {
      // Fallback: dùng SmartRouter
      console.log('⚠️  Dispatcher JSON parse failed, fallback to SmartRouter');
      const routeResult = this.smartRouter.route({
        task: context.task || 'build', files, prompt: userPrompt, project
      });
      return {
        analysis: userPrompt,
        subtasks: [{
          id: 1,
          description: userPrompt,
          agentRole: 'builder',
          model: routeResult.litellm_name,
          reason: routeResult.reasons.join(', '),
          files,
          depends_on: [],
          estimated_tokens: 10000
        }],
        parallel_groups: [[1]],
        total_estimated_cost: `$${(routeResult.cost * 10000 / 1000000).toFixed(4)}`
      };
    }
  }

  /**
   * Bước 2: Tech Lead review plan
   * Quick review trước (free, không gọi model), full review nếu cần
   */
  async review(plan, context = {}) {
    if (!this.techLeadReview) {
      return { action: 'approve', plan, decisions: [], modifications: [] };
    }

    // Quick review trước — miễn phí, không gọi API
    const quickResult = this.techLead.quickReview(plan);

    if (quickResult.passed) {
      console.log('✅ Tech Lead quick review: PASSED');
      return { action: 'approve', plan, decisions: [], modifications: [] };
    }

    console.log(`⚠️  Tech Lead quick review: ${quickResult.issues.length} issues`);
    for (const issue of quickResult.issues) {
      console.log(`   - ${issue}`);
    }

    // Nhiều vấn đề → full review bằng Claude Sonnet
    if (quickResult.needsFullReview) {
      console.log('🧠 Calling Tech Lead for full review...');
      const structuredCtx = await this.contextManager.build({
        task: context.task || 'build',
        description: plan.analysis,
        files: plan.subtasks.flatMap(s => s.files || [])
      });
      return await this.techLead.reviewPlan(plan, structuredCtx);
    }

    // Ít vấn đề → auto-fix rồi approve
    const fixedPlan = this._autoFixPlan(plan, quickResult.issues);
    return { action: 'approve', plan: fixedPlan, decisions: [], modifications: [], autoFixed: quickResult.issues };
  }

  /**
   * Bước 3: Execute plan — gọi agents theo thứ tự, xử lý escalation
   */
  async execute(plan, context = {}) {
    const results = {};
    const escalations = [];
    const startTime = Date.now();

    console.log(`\n📋 Plan: ${plan.analysis}`);
    console.log(`   ${plan.subtasks.length} subtasks, ${plan.parallel_groups.length} groups\n`);

    for (const group of plan.parallel_groups) {
      // Chạy song song trong group
      const tasks = group.map(id => {
        const subtask = plan.subtasks.find(s => s.id === id);
        if (!subtask) return null;

        const role = subtask.agentRole || 'builder';
        console.log(`🔄 [${subtask.id}] ${subtask.description} → ${role} (${subtask.model})`);

        return this._executeWithEscalation(subtask, context, results);
      }).filter(Boolean);

      const groupResults = await Promise.all(tasks);
      for (const res of groupResults) {
        results[res.id] = res;
        if (res.escalated) escalations.push(res);
      }
    }

    const elapsed = Date.now() - startTime;

    // Tổng hợp kết quả
    const summary = await this._synthesize(plan, results);

    const execution = {
      plan,
      results,
      summary,
      escalations,
      elapsed_ms: elapsed,
      models_used: [...new Set(Object.values(results).map(r => r.model))],
      decisions_locked: this.decisionLock.getActive().length,
      timestamp: new Date().toISOString()
    };

    this.executionLog.push(execution);
    return execution;
  }

  /**
   * Full flow: plan → review → execute
   */
  async run(userPrompt, context = {}) {
    // Bước 1: Plan
    console.log('📝 Step 1: Planning...');
    const plan = await this.plan(userPrompt, context);

    // Bước 2: Tech Lead review
    console.log('🧠 Step 2: Tech Lead review...');
    const reviewResult = await this.review(plan, context);

    if (reviewResult.action === 'reject') {
      console.log('❌ Plan REJECTED by Tech Lead');
      return {
        status: 'rejected',
        reason: reviewResult.guidance || 'Tech Lead rejected plan',
        plan,
        review: reviewResult
      };
    }

    // Dùng plan đã modify (nếu có)
    const approvedPlan = reviewResult.plan || plan;

    // Bước 3: Execute
    console.log('⚡ Step 3: Executing...');
    const execution = await this.execute(approvedPlan, context);

    // Report
    this._printReport(execution);

    return execution;
  }

  // =============================================
  // ESCALATION HANDLING
  // =============================================

  /**
   * Execute subtask với escalation loop
   * Nếu agent output cần escalation → gửi lên Tech Lead → retry
   */
  async _executeWithEscalation(subtask, context, previousResults) {
    let escalationCount = 0;
    let currentSubtask = { ...subtask };
    let lastResult = null;

    while (escalationCount <= this.maxEscalations) {
      // Execute subtask
      lastResult = await this._executeSubtask(currentSubtask, context, previousResults);

      // Normalize output
      const normalized = this.contextManager.normalizeOutput(
        lastResult.output,
        currentSubtask.agentRole || 'builder',
        currentSubtask.model
      );

      lastResult.normalized = normalized;

      // Check: cần escalation không?
      if (!normalized.needsEscalation || !lastResult.success) {
        break; // Không cần escalation hoặc task failed → dừng
      }

      // === ESCALATION ===
      escalationCount++;
      console.log(`🆘 [${subtask.id}] Escalation #${escalationCount} → Tech Lead`);

      // Parse escalation data từ output
      const escalationData = this._parseEscalationData(lastResult.output, currentSubtask);

      // Build context cho Tech Lead
      const structuredCtx = await this.contextManager.build({
        task: 'debug',
        description: `Escalation: ${escalationData.reason}`,
        files: currentSubtask.files || [],
        previousResults: [lastResult]
      });

      // Gọi Tech Lead xử lý
      const resolution = await this.techLead.handleEscalation(escalationData, structuredCtx);

      console.log(`🧠 Tech Lead: ${resolution.action} — ${resolution.analysis || ''}`);

      if (resolution.action === 'guide') {
        // Tech Lead cho hướng → retry subtask với context mới
        currentSubtask = {
          ...currentSubtask,
          description: `${currentSubtask.description}\n\n[Tech Lead guidance]: ${resolution.resolution?.steps?.join('. ') || resolution.guidance || ''}`,
        };
        // Thêm context mới nếu có
        if (resolution.resolution?.newContext) {
          currentSubtask.description += `\n[Additional context]: ${resolution.resolution.newContext}`;
        }
      } else if (resolution.action === 'redirect') {
        // Chuyển sang model/agent khác
        const newModel = resolution.resolution?.targetModel;
        if (newModel) {
          currentSubtask = { ...currentSubtask, model: newModel };
          console.log(`↪️  [${subtask.id}] Redirected → ${newModel}`);
        }
      } else if (resolution.action === 'take_over') {
        // Tech Lead tự xử lý — gọi model smart
        console.log(`🧠 [${subtask.id}] Tech Lead TAKING OVER`);
        currentSubtask = { ...currentSubtask, model: 'smart', agentRole: 'tech-lead' };
      }

      lastResult.escalated = true;
      lastResult.escalationCount = escalationCount;
      lastResult.techLeadResolution = resolution;
    }

    if (escalationCount > this.maxEscalations) {
      console.log(`⛔ [${subtask.id}] Max escalations (${this.maxEscalations}) reached — stopping`);
      lastResult.maxEscalationsReached = true;
    }

    return lastResult;
  }

  // =============================================
  // SUBTASK EXECUTION (nâng cấp với Context Manager)
  // =============================================

  async _executeSubtask(subtask, context, previousResults) {
    const start = Date.now();
    const agentRole = subtask.agentRole || 'builder';

    // Build structured context cho agent
    const structuredCtx = await this.contextManager.build({
      task: subtask.model === 'smart' ? 'debug' : 'build',
      description: subtask.description,
      files: subtask.files || [],
      feature: context.feature || null,
      previousResults: this._getPreviousResults(subtask, previousResults)
    });

    // Inject context vào prompt template
    const fullPrompt = this.contextManager.inject(structuredCtx, agentRole);

    // Check decision locks trước khi execute
    for (const file of (subtask.files || [])) {
      const validation = this.decisionLock.validate(file, agentRole);
      if (!validation.allowed) {
        console.log(`🔒 [${subtask.id}] Blocked by decision lock on "${file}"`);
        return {
          id: subtask.id,
          model: subtask.model,
          agentRole,
          output: `BLOCKED: File "${file}" có locked decision. ${JSON.stringify(validation.blockedBy)}. Cần escalate lên Tech Lead.`,
          elapsed_ms: Date.now() - start,
          success: false,
          blocked: true
        };
      }
    }

    try {
      // Gọi model qua LiteLLM
      const systemPrompt = fullPrompt; // Context Manager đã build full prompt
      const output = await this._callModel(subtask.model, systemPrompt, subtask.description);

      const result = {
        id: subtask.id,
        model: subtask.model,
        agentRole,
        output,
        elapsed_ms: Date.now() - start,
        tokens: Math.round(output.length / 4),
        success: true
      };

      console.log(`✅ [${subtask.id}] Done (${result.elapsed_ms}ms, ~${result.tokens} tokens)`);
      return result;
    } catch (err) {
      console.log(`❌ [${subtask.id}] Error: ${err.message}`);
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

  // =============================================
  // HELPERS
  // =============================================

  /**
   * Tổng hợp kết quả cuối cùng
   */
  async _synthesize(plan, results) {
    const summaryPrompt = `Tổng hợp kết quả các sub-tasks thành 1 kết quả thống nhất.
Chỉ trả về kết quả cuối cùng, KHÔNG lặp lại từng bước.

Plan: ${plan.analysis}

Results:
${Object.values(results).map(r =>
  `[Task ${r.id}] (${r.agentRole}/${r.model})${r.escalated ? ' [ESCALATED]' : ''}: ${r.success ? (r.normalized?.summary || r.output).slice(0, 500) : 'FAILED: ' + r.output}`
).join('\n\n')}

Locked decisions hiện tại: ${this.decisionLock.getActive().length}`;

    return await this._callModel(this.dispatcherModel, 'Tổng hợp kết quả ngắn gọn, tiếng Việt.', summaryPrompt);
  }

  /**
   * Lấy kết quả từ dependency tasks
   */
  _getPreviousResults(subtask, allResults) {
    if (!subtask.depends_on || subtask.depends_on.length === 0) return [];
    return subtask.depends_on
      .filter(depId => allResults[depId])
      .map(depId => ({
        agentRole: allResults[depId].agentRole,
        model: allResults[depId].model,
        output: allResults[depId].normalized?.summary || allResults[depId].output,
        success: allResults[depId].success,
        timestamp: allResults[depId].timestamp
      }));
  }

  /**
   * Parse escalation data từ agent output
   */
  _parseEscalationData(output, subtask) {
    // Thử parse JSON escalation block
    try {
      const match = output.match(/"escalation"\s*:\s*(\{[\s\S]*?\})/);
      if (match) {
        const data = JSON.parse(match[1]);
        return {
          fromAgent: subtask.agentRole || 'unknown',
          model: subtask.model,
          reason: data.reason || 'Unknown',
          context: data.context || output.slice(0, 500),
          suggestion: data.suggestion || null,
          severity: data.severity || 'medium',
          attemptsMade: 1,
          errorLog: []
        };
      }
    } catch { /* ignore parse errors */ }

    // Fallback: tạo escalation data từ output
    return {
      fromAgent: subtask.agentRole || 'unknown',
      model: subtask.model,
      reason: 'Agent requested escalation (no structured data)',
      context: output.slice(0, 500),
      suggestion: null,
      severity: 'medium',
      attemptsMade: 1,
      errorLog: []
    };
  }

  /**
   * Suy luận agentRole từ subtask nếu dispatcher không gán
   */
  _inferAgentRole(subtask) {
    const desc = (subtask.description || '').toLowerCase();
    const files = (subtask.files || []).join(' ').toLowerCase();

    if (/review|check|audit|scan/.test(desc)) return 'reviewer';
    if (/doc|readme|comment|jsdoc/.test(desc)) return 'docs';
    if (/debug|fix|bug|error/.test(desc)) return 'debugger';
    if (/\.(tsx|jsx|vue|css|scss)/.test(files) || /component|page|layout|style|frontend|ui/.test(desc)) return 'fe-dev';
    if (/\.(service|controller|guard|entity|migration)\./.test(files) || /api|endpoint|backend|database|sql/.test(desc)) return 'be-dev';
    return 'builder';
  }

  /**
   * Auto-fix plan issues nhỏ (không cần gọi Tech Lead)
   */
  _autoFixPlan(plan, issues) {
    const fixed = JSON.parse(JSON.stringify(plan));

    for (const issue of issues) {
      // Fix model assignment sai
      const modelMatch = issue.match(/Task (\d+):.*nên dùng (\w+)/);
      if (modelMatch) {
        const task = fixed.subtasks.find(s => s.id === parseInt(modelMatch[1]));
        if (task) {
          task.model = modelMatch[2];
          task.reason = `Auto-fixed: ${issue}`;
        }
      }
    }

    return fixed;
  }

  /**
   * In report cuối cùng — mobile-friendly
   */
  _printReport(execution) {
    const { plan, results, escalations, elapsed_ms, models_used, decisions_locked } = execution;
    const succeeded = Object.values(results).filter(r => r.success).length;
    const failed = Object.values(results).filter(r => !r.success).length;

    console.log('\n' + '='.repeat(50));
    console.log(`📋 ${plan.analysis}`);
    console.log(`✅ ${succeeded} passed | ❌ ${failed} failed | 🆘 ${escalations.length} escalated`);
    console.log(`🤖 Models: ${models_used.join(', ')}`);
    console.log(`🔒 Decisions locked: ${decisions_locked}`);
    console.log(`⏱️  ${elapsed_ms}ms`);
    console.log('='.repeat(50));
  }

  // =============================================
  // MODEL CALL (giữ nguyên từ v1, thêm retry)
  // =============================================

  async _callModel(model, systemPrompt, userContent) {
    return this._callModelWithRetry(model, systemPrompt, userContent, 3);
  }

  async _callModelWithRetry(model, systemPrompt, userContent, retries) {
    const response = await fetch(`${this.litellmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.litellmKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        max_tokens: 4000,
        temperature: 0.3
      })
    });

    const data = await response.json();

    if (data.error) {
      const errMsg = data.error.message || JSON.stringify(data.error);
      if (retries > 0 && (errMsg.includes('429') || errMsg.includes('RateLimit') || errMsg.includes('quota'))) {
        const waitSec = Math.min(60, 20 * (4 - retries));
        console.log(`⏳ Rate limited, waiting ${waitSec}s... (${retries} retries left)`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return this._callModelWithRetry(model, systemPrompt, userContent, retries - 1);
      }
      throw new Error(errMsg);
    }

    return data.choices?.[0]?.message?.content || '';
  }

  // =============================================
  // STATS
  // =============================================

  getStats() {
    const stats = {
      total_executions: this.executionLog.length,
      total_tasks: 0,
      total_escalations: 0,
      models: {},
      agents: {},
      decisions_locked: this.decisionLock.getActive().length,
      tech_lead: this.techLead.getStats()
    };

    for (const exec of this.executionLog) {
      for (const result of Object.values(exec.results)) {
        stats.total_tasks++;

        // Model stats
        if (!stats.models[result.model]) stats.models[result.model] = { count: 0, tokens: 0 };
        stats.models[result.model].count++;
        stats.models[result.model].tokens += result.tokens || 0;

        // Agent stats
        const role = result.agentRole || 'unknown';
        if (!stats.agents[role]) stats.agents[role] = { count: 0, escalated: 0 };
        stats.agents[role].count++;
        if (result.escalated) {
          stats.agents[role].escalated++;
          stats.total_escalations++;
        }
      }
    }

    return stats;
  }
}

module.exports = { OrchestratorAgent, AGENT_ROLE_MAP };
