#!/usr/bin/env node
/**
 * Tech Lead Agent — Claude đóng vai Tech Lead trong multi-model orchestration
 *
 * Vai trò:
 * 1. Review plan từ Orchestrator trước khi dev agents chạy
 * 2. Approve/reject/modify quyết định kiến trúc
 * 3. Handle escalation khi dev agents gặp vấn đề khó
 * 4. Lock decisions quan trọng → agent sau không được override
 * 5. Tổng hợp kết quả cuối cùng, đảm bảo consistency
 *
 * Model: "smart" (Claude Sonnet) — cần reasoning sâu
 * CHỈ gọi khi cần — tránh lãng phí (đắt hơn dev models 3-10x)
 *
 * Cách dùng:
 *   const techLead = new TechLeadAgent({ litellmUrl, litellmKey });
 *   const review = await techLead.reviewPlan(plan, context);
 *   const escalation = await techLead.handleEscalation(escalationData, context);
 */

const { DecisionLock } = require('./decision-lock');
const { ContextManager } = require('./context-manager');

const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:4001';
const LITELLM_KEY = process.env.LITELLM_KEY || 'sk-master-change-me';

// === Tech Lead System Prompt ===
const TECH_LEAD_SYSTEM = `Bạn là Tech Lead (Senior Architect) trong hệ thống multi-model AI orchestration.

VAI TRÒ CỦA BẠN:
- Review và approve/reject execution plans
- Quyết định kiến trúc, API contract, database schema
- Handle escalation từ dev agents khi họ gặp vấn đề khó
- Lock các quyết định quan trọng để dev agents tuân theo
- Đảm bảo consistency giữa frontend và backend

NGUYÊN TẮC:
1. KHÔNG tự implement code — chỉ review, decide, guide
2. Quyết định phải CLEAR và ACTIONABLE — dev agent đọc xong biết phải làm gì
3. Lock quyết định khi: API contract, DB schema, auth flow, shared interfaces
4. Ưu tiên đơn giản — không over-engineer
5. Mỗi quyết định phải kèm LÝ DO ngắn gọn

KHI REVIEW PLAN:
- Check: task có đúng model không? (FE → Kimi, BE → DeepSeek, complex → Sonnet)
- Check: thứ tự dependencies có đúng? (DB trước API, API trước FE)
- Check: có task nào thiếu? Có task nào dư?
- Check: scope có vượt quá yêu cầu không?

KHI HANDLE ESCALATION:
- Đọc kỹ context: agent đã thử gì, lỗi gì
- Quyết định 1 trong 3:
  a) GUIDE: Cho hướng giải quyết cụ thể → agent tiếp tục
  b) REDIRECT: Chuyển sang model khác phù hợp hơn
  c) TAKE_OVER: Vấn đề quá phức tạp → Tech Lead tự xử lý (hiếm)

OUTPUT FORMAT — LUÔN trả về JSON:
{
  "action": "approve|reject|modify|guide|redirect|take_over",
  "decisions": [
    {
      "decision": "Mô tả quyết định",
      "scope": "api|database|architecture|ui|auth|...",
      "lock": true/false,
      "reason": "Lý do"
    }
  ],
  "modifications": [],
  "guidance": "Hướng dẫn cụ thể cho dev agent (nếu có)",
  "notes": "Ghi chú thêm"
}`;

// === Escalation Handler Prompt ===
const ESCALATION_SYSTEM = `Bạn là Tech Lead đang xử lý escalation từ dev agent.

Dev agent đã gặp vấn đề KHÔNG TỰ GIẢI QUYẾT ĐƯỢC và escalate lên bạn.

NHIỆM VỤ:
1. Phân tích vấn đề từ context agent gửi
2. Xác định root cause hoặc hướng giải quyết
3. Quyết định: GUIDE (cho hướng) | REDIRECT (chuyển model) | TAKE_OVER (tự làm)

NGUYÊN TẮC ESCALATION:
- Ưu tiên GUIDE — để agent tự hoàn thành (rẻ hơn, nhanh hơn)
- REDIRECT khi vấn đề thuộc domain khác (FE agent gặp vấn đề BE → redirect sang BE agent)
- TAKE_OVER chỉ khi vấn đề cross-cutting, cần nhìn toàn cảnh
- Mỗi escalation = 1 quyết định, KHÔNG để treo

OUTPUT FORMAT — JSON:
{
  "action": "guide|redirect|take_over",
  "analysis": "Phân tích ngắn gọn vấn đề",
  "rootCause": "Root cause (nếu xác định được)",
  "resolution": {
    "steps": ["Bước 1", "Bước 2"],
    "targetModel": "model nào thực hiện (nếu redirect)",
    "newContext": "Context bổ sung cho agent"
  },
  "decisions": [
    {
      "decision": "Quyết định liên quan",
      "scope": "scope",
      "lock": true/false,
      "reason": "Lý do"
    }
  ],
  "preventionNote": "Ghi chú để tránh lặp lại vấn đề tương tự"
}`;

// === Tech Lead Agent Class ===
class TechLeadAgent {
  constructor(options = {}) {
    this.litellmUrl = options.litellmUrl || LITELLM_URL;
    this.litellmKey = options.litellmKey || LITELLM_KEY;
    this.model = options.model || 'smart'; // Claude Sonnet — reasoning sâu
    this.decisionLock = options.decisionLock || new DecisionLock({ projectDir: options.projectDir });
    this.contextManager = options.contextManager || null;

    // Thống kê
    this.stats = {
      plansReviewed: 0,
      plansApproved: 0,
      plansRejected: 0,
      escalationsHandled: 0,
      decisionsLocked: 0
    };

    // Lịch sử escalation — để phát hiện patterns lặp lại
    this.escalationHistory = [];
  }

  /**
   * Review execution plan trước khi dev agents chạy
   * Trả về: approved plan (có thể đã modify) + locked decisions
   */
  async reviewPlan(plan, context = {}) {
    this.stats.plansReviewed++;

    const prompt = this._buildReviewPrompt(plan, context);
    const response = await this._callModel(TECH_LEAD_SYSTEM, prompt);
    const review = this._parseJSON(response);

    if (!review) {
      // Parse thất bại → approve mặc định (không block flow)
      console.log('⚠️  Tech Lead response không parse được → auto-approve');
      this.stats.plansApproved++;
      return { action: 'approve', plan, decisions: [], modifications: [] };
    }

    // Lock các quyết định được đánh dấu lock: true
    if (review.decisions) {
      for (const dec of review.decisions) {
        if (dec.lock) {
          this.decisionLock.lock({
            decision: dec.decision,
            scope: dec.scope,
            approvedBy: 'tech-lead',
            reason: dec.reason
          });
          this.stats.decisionsLocked++;
        }
      }
    }

    // Áp dụng modifications vào plan
    if (review.action === 'modify' && review.modifications) {
      plan = this._applyModifications(plan, review.modifications);
    }

    if (review.action === 'approve' || review.action === 'modify') {
      this.stats.plansApproved++;
    } else {
      this.stats.plansRejected++;
    }

    return {
      action: review.action,
      plan,
      decisions: review.decisions || [],
      modifications: review.modifications || [],
      guidance: review.guidance || null,
      notes: review.notes || null
    };
  }

  /**
   * Handle escalation từ dev agent
   * Gọi khi agent output có needsEscalation = true
   */
  async handleEscalation(escalationData, context = {}) {
    this.stats.escalationsHandled++;

    // Check escalation pattern — nếu cùng vấn đề lặp lại > 2 lần → TAKE_OVER
    const repeated = this._checkRepeatedEscalation(escalationData);

    const prompt = this._buildEscalationPrompt(escalationData, context, repeated);
    const response = await this._callModel(ESCALATION_SYSTEM, prompt);
    const resolution = this._parseJSON(response);

    if (!resolution) {
      return {
        action: 'guide',
        analysis: 'Không parse được Tech Lead response',
        resolution: {
          steps: ['Retry task với context chi tiết hơn'],
          targetModel: null,
          newContext: ''
        },
        decisions: []
      };
    }

    // Lock decisions nếu có
    if (resolution.decisions) {
      for (const dec of resolution.decisions) {
        if (dec.lock) {
          this.decisionLock.lock({
            decision: dec.decision,
            scope: dec.scope,
            approvedBy: 'tech-lead',
            reason: dec.reason || 'Escalation resolution'
          });
          this.stats.decisionsLocked++;
        }
      }
    }

    // Lưu vào history
    this.escalationHistory.push({
      timestamp: new Date().toISOString(),
      from: escalationData.fromAgent,
      reason: escalationData.reason,
      action: resolution.action,
      resolved: true
    });

    return resolution;
  }

  /**
   * Quick review — check nhẹ không cần gọi model
   * Dùng cho task đơn giản, tránh tốn tiền gọi Sonnet
   */
  quickReview(plan) {
    const issues = [];

    // Check 1: model assignment hợp lý
    for (const subtask of (plan.subtasks || [])) {
      if (subtask.model === 'smart' && /\b(docs|comment|format|rename)\b/i.test(subtask.description)) {
        issues.push(`Task ${subtask.id}: "${subtask.description}" dùng model smart (đắt) cho task đơn giản → nên dùng cheap`);
      }
      if (subtask.model === 'cheap' && /\b(architect|security|spec|design)\b/i.test(subtask.description)) {
        issues.push(`Task ${subtask.id}: "${subtask.description}" dùng model cheap cho task phức tạp → nên dùng smart`);
      }
    }

    // Check 2: dependencies cycle
    // (đơn giản: không deep check, chỉ check trực tiếp)
    for (const subtask of (plan.subtasks || [])) {
      for (const dep of (subtask.depends_on || [])) {
        const depTask = plan.subtasks.find(s => s.id === dep);
        if (depTask && (depTask.depends_on || []).includes(subtask.id)) {
          issues.push(`Circular dependency: task ${subtask.id} ↔ task ${dep}`);
        }
      }
    }

    // Check 3: task quá lớn
    for (const subtask of (plan.subtasks || [])) {
      if ((subtask.estimated_tokens || 0) > 50000) {
        issues.push(`Task ${subtask.id}: estimated ${subtask.estimated_tokens} tokens — nên chia nhỏ`);
      }
    }

    return {
      passed: issues.length === 0,
      issues,
      needsFullReview: issues.length > 2 // Nhiều vấn đề → cần full review bằng model
    };
  }

  /**
   * Lấy thống kê
   */
  getStats() {
    return {
      ...this.stats,
      activeDecisions: this.decisionLock.getActive().length,
      recentEscalations: this.escalationHistory.slice(-10)
    };
  }

  // === Private ===

  _buildReviewPrompt(plan, context) {
    const parts = [
      `PLAN CẦN REVIEW:`,
      JSON.stringify(plan, null, 2),
      ''
    ];

    if (context.project) {
      parts.push(`PROJECT: ${context.project.name} (${(context.project.stack || []).join(', ')})`);
    }

    // Thêm locked decisions hiện tại
    const activeLocks = this.decisionLock.getActive();
    if (activeLocks.length > 0) {
      parts.push(`\nQUYẾT ĐỊNH ĐÃ LOCK (KHÔNG thay đổi):`);
      for (const lock of activeLocks) {
        parts.push(`- [${lock.scope}] ${lock.decision}`);
      }
    }

    parts.push('\nHãy review plan trên và trả về JSON theo format đã định.');
    return parts.join('\n');
  }

  _buildEscalationPrompt(escalation, context, repeated) {
    const parts = [
      `ESCALATION TỪ: ${escalation.fromAgent || 'unknown'}`,
      `MODEL: ${escalation.model || 'unknown'}`,
      `LÝ DO: ${escalation.reason || 'không rõ'}`,
      '',
      `CONTEXT:`,
      escalation.context || 'Không có context chi tiết',
      '',
      `ĐÃ THỬ:`,
      `- Số lần thử: ${escalation.attemptsMade || 0}`,
      escalation.errorLog ? `- Lỗi: ${JSON.stringify(escalation.errorLog)}` : '',
      '',
      `GỢI Ý CỦA AGENT: ${escalation.suggestion || 'Không có'}`
    ];

    if (repeated) {
      parts.push(`\n⚠️  VẤN ĐỀ NÀY ĐÃ ESCALATE ${repeated.count} LẦN TRƯỚC. Cân nhắc TAKE_OVER.`);
    }

    // Project context
    if (context.project) {
      parts.push(`\nPROJECT: ${context.project.name}`);
    }

    // Locked decisions
    const activeLocks = this.decisionLock.getActive();
    if (activeLocks.length > 0) {
      parts.push(`\nLOCKED DECISIONS:`);
      for (const lock of activeLocks) {
        parts.push(`- [${lock.scope}] ${lock.decision}`);
      }
    }

    parts.push('\nPhân tích và trả về JSON theo format đã định.');
    return parts.join('\n');
  }

  _checkRepeatedEscalation(escalation) {
    const similar = this.escalationHistory.filter(h =>
      h.from === escalation.fromAgent &&
      h.reason && escalation.reason &&
      this._similarity(h.reason, escalation.reason) > 0.6
    );

    if (similar.length >= 2) {
      return { count: similar.length, previous: similar };
    }
    return null;
  }

  // Đo tương đồng đơn giản giữa 2 strings
  _similarity(a, b) {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    return intersection / Math.max(wordsA.size, wordsB.size);
  }

  _applyModifications(plan, modifications) {
    const modified = JSON.parse(JSON.stringify(plan));

    for (const mod of modifications) {
      if (mod.type === 'change_model' && mod.taskId) {
        const task = modified.subtasks.find(s => s.id === mod.taskId);
        if (task) {
          task.model = mod.newModel;
          task.reason = `Tech Lead: ${mod.reason || 'model change'}`;
        }
      }

      if (mod.type === 'add_task') {
        const newId = Math.max(...modified.subtasks.map(s => s.id)) + 1;
        modified.subtasks.push({
          id: newId,
          description: mod.description,
          model: mod.model || 'default',
          reason: `Tech Lead added: ${mod.reason || ''}`,
          files: mod.files || [],
          depends_on: mod.depends_on || [],
          estimated_tokens: mod.estimated_tokens || 5000
        });
      }

      if (mod.type === 'remove_task' && mod.taskId) {
        modified.subtasks = modified.subtasks.filter(s => s.id !== mod.taskId);
        // Xóa khỏi parallel groups
        modified.parallel_groups = modified.parallel_groups
          .map(g => g.filter(id => id !== mod.taskId))
          .filter(g => g.length > 0);
      }

      if (mod.type === 'reorder') {
        modified.parallel_groups = mod.newGroups;
      }
    }

    return modified;
  }

  _parseJSON(text) {
    try {
      // Thử parse trực tiếp
      return JSON.parse(text);
    } catch {
      // Tìm JSON block trong response
      try {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
      } catch { /* ignore */ }
    }
    return null;
  }

  async _callModel(systemPrompt, userContent) {
    const response = await fetch(`${this.litellmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.litellmKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        max_tokens: 4000,
        temperature: 0.2 // Thấp hơn dev agents — cần decisions ổn định
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.choices?.[0]?.message?.content || '';
  }
}

module.exports = { TechLeadAgent };
