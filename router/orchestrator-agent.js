#!/usr/bin/env node
/**
 * Orchestrator Agent v2.1 — Multi-model orchestration voi 7 buoc
 *
 * FLOW HOAN CHINH (v2.1 — 2026-04-16):
 * 1. User gui task
 * 2. Scanner (cheap) → quet project, doc file, hieu boi canh. RE.
 * 3. Planner (default) → xay dung execution plan tu scan results. GIA VUA.
 * 4. Tech Lead (smart) → quick review plan → approve/modify/reject
 * 5. Execute subtasks → dev agents chay song song
 * 6. Neu agent gap kho → escalate: smart → architect
 * 7. Synthesize ket qua cuoi cung
 *
 * THAY DOI SO VOI v2:
 * + Them Scanner: quet project truoc khi plan (giam ao giac)
 * + Them Planner: xay dung plan chi tiet (thay dispatcher lam ca 2)
 * + Dispatcher chi con lam synthesize cuoi cung
 * + Escalation chain: cheap → default → smart → architect
 *
 * Anti-patterns da giai quyet:
 * ❌ Dispatcher tu plan khong hieu project → ✅ Scanner quet truoc
 * ❌ Plan bi ao giac vi khong doc code → ✅ Scanner doc file thuc te
 * ❌ Agent tu quyet API → ✅ Decision Lock, Tech Lead approve
 * ❌ Khong co duong escalate len top → ✅ Architect tier (Opus)
 */

const { SmartRouter } = require('./smart-router');
const { ContextManager } = require('./context-manager');
const { DecisionLock } = require('./decision-lock');
const { TechLeadAgent } = require('./tech-lead-agent');

const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:5002';
const LITELLM_KEY = process.env.LITELLM_KEY || 'sk-master-change-me';

// === Agent Role → Model mapping (v2.1 — 2026-04-16) ===
// 5 tiers: architect > smart > default > fast > cheap
const AGENT_ROLE_MAP = {
  'architect':  'architect', // Claude Opus 4.6 — SA, system design, task cuc kho
  'tech-lead':  'smart',     // Claude Sonnet 4.6 — review, escalation, reasoning
  'planner':    'default',   // DeepSeek V3.2 — xay dung plan tu scan data
  'fe-dev':     'default',   // DeepSeek V3.2 — full-stack code gen
  'be-dev':     'default',   // DeepSeek V3.2 — full-stack code gen
  'reviewer':   'fast',      // Gemini 3 Flash — scan nhanh, re
  'debugger':   'smart',     // Claude Sonnet 4.6 — trace sau
  'scanner':    'cheap',     // GPT-5.4 Mini — quet project, doc file, thu thap context
  'docs':       'cheap',     // GPT-5.4 Mini — text generation
  'builder':    'default',   // DeepSeek V3.2 — general code
  'dispatcher': 'fast'       // Gemini 3 Flash — synthesize ket qua
};

// === Scanner Prompt — quet project, thu thap context (cheap, re) ===
const SCANNER_SYSTEM = `Ban la Scanner — quet va thu thap thong tin tu project.

NHIEM VU:
- Doc file structure, package.json, config files
- Tim cac file lien quan den task duoc yeu cau
- Phat hien: stack, framework, patterns dang dung
- Ghi nhan: existing code, naming conventions, folder structure
- Tim van de tiem an: conflicts, missing deps, tech debt

KHONG tu fix hay implement — chi QUET va BAO CAO.

Tra ve JSON:
{
  "stack": ["next.js", "nestjs", "mysql"],
  "relevant_files": [
    { "path": "src/auth/auth.service.ts", "summary": "JWT login logic", "lines": 120 }
  ],
  "existing_patterns": ["Repository pattern", "DTO validation", "Guard-based auth"],
  "potential_issues": ["Missing error handling in auth", "No rate limiting"],
  "context_for_planner": "Mo ta ngan gon nhung gi planner can biet",
  "estimated_complexity": "low|medium|high|very_high"
}`;

// === Planner Prompt — xay dung plan tu scan data (default, gia vua) ===
const PLANNER_SYSTEM = `Ban la Planner — xay dung execution plan tu ket qua scan.

Ban se nhan:
1. User request (task can lam)
2. Scan results (thong tin thuc te tu project)
3. Locked decisions (khong duoc thay doi)

CÁC AGENT CO SAN (sap theo gia):
- "docs"     → "cheap"     (GPT-5.4 Mini):     Docs, comment, format. RE NHAT.
- "reviewer" → "fast"      (Gemini 3 Flash):    Review, scan, summarize. RE.
- "fe-dev"   → "default"   (DeepSeek V3.2):     Frontend code. GIA VUA.
- "be-dev"   → "default"   (DeepSeek V3.2):     Backend code. GIA VUA.
- "builder"  → "default"   (DeepSeek V3.2):     General code. GIA VUA.
- "debugger" → "smart"     (Claude Sonnet 4.6):  Debug phuc tap. DAT.
- "architect"→ "architect"  (Claude Opus 4.6):    System design. RAT DAT.

NGUYEN TAC:
1. DUA TREN SCAN RESULTS — khong tu bua file/function khong ton tai
2. Uu tien agent RE nhat co the lam duoc
3. Chi dung "debugger" khi CAN trace > 3 files
4. Chi dung "architect" khi system design / trade-off analysis
5. Chia nho task de moi agent chi lam phan chuyen cua no
6. Task don gian → 1 agent la du, KHONG chia nho qua muc

Tra ve JSON (KHONG markdown, KHONG giai thich):
{
  "analysis": "1 dong mo ta",
  "complexity": "low|medium|high|very_high",
  "subtasks": [
    {
      "id": 1,
      "description": "Mo ta sub-task — DUNG file path thuc te tu scan",
      "agentRole": "fe-dev|be-dev|reviewer|debugger|docs|builder|architect",
      "model": "cheap|fast|default|smart|architect",
      "reason": "Tai sao chon agent nay",
      "files": ["file1.ts"],
      "depends_on": [],
      "estimated_tokens": 5000
    }
  ],
  "parallel_groups": [[1,2], [3]],
  "total_estimated_cost": "$0.05"
}`;

// === Dispatcher Prompt — chi con dung de synthesize cuoi cung ===
const DISPATCHER_SYSTEM = `Ban la Synthesizer — tong hop ket qua tu nhieu agents.
Tra ve ket qua cuoi cung ngan gon, tieng Viet.
KHONG lap lai tung buoc — chi ket qua.`;

// So lan escalation toi da cho 1 subtask truoc khi dung
const MAX_ESCALATIONS_PER_TASK = 3;

// === Chi phi uoc tinh per 1K tokens (input + output trung binh) ===
const MODEL_COST_PER_1K = {
  'architect': 0.045,  // ~$15 input + $75 output / 1M, avg ~$45/1M
  'smart':     0.009,  // ~$3 input + $15 output / 1M, avg ~$9/1M
  'default':   0.00075, // ~$0.30 input + $1.20 output / 1M
  'fast':      0.000375, // ~$0.15 input + $0.60 output / 1M
  'cheap':     0.0005   // ~$0.20 input + $0.80 output / 1M
};

// === Budget gioi han ===
const DAILY_BUDGET = 2.00; // $2/ngay — KHONG vuot qua

// === Orchestrator Agent v2.1 ===
class OrchestratorAgent {
  constructor(options = {}) {
    this.litellmUrl = options.litellmUrl || LITELLM_URL;
    this.litellmKey = options.litellmKey || LITELLM_KEY;
    this.projectDir = options.projectDir || process.cwd();
    this.dispatcherModel = options.dispatcherModel || 'fast';
    this.dailyBudget = options.dailyBudget || DAILY_BUDGET;

    // Budget tracking
    this.budgetTracker = {
      date: new Date().toISOString().split('T')[0],
      spent: 0,
      calls: {}  // { model: { count, tokens, cost } }
    };

    // Core modules
    this.smartRouter = new SmartRouter({
      availableModels: options.availableModels || ['opus-4.6', 'sonnet-4.6', 'deepseek-v3.2', 'gemini-3-flash', 'gpt-5.4-mini'],
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
  // FLOW CHINH: scan → plan → review → execute → synthesize
  // =============================================

  /**
   * Buoc 1a: Scanner quet project — thu thap context thuc te (cheap, re)
   * Giam ao giac vi planner se co data thuc te tu scan
   */
  async scan(userPrompt, context = {}) {
    const { files = [], project = '' } = context;

    // Build structured context
    const structuredCtx = await this.contextManager.build({
      task: context.task || 'build',
      description: userPrompt,
      files
    });

    // Thu thap file listing THUC TE tu project truoc khi gui cho scanner
    // Scanner (cheap model) khong co tools doc file → can inject data thuc te
    const fileData = await this._collectProjectData(files);

    const prompt = [
      `PROJECT: ${structuredCtx.project.name} (${structuredCtx.project.stack.join(', ')})`,
      `DIR: ${structuredCtx.project.dir}`,
      `BRANCH: ${structuredCtx.project.branch}`,
      '',
      `=== DU LIEU THUC TE TU PROJECT (da doc san) ===`,
      fileData,
      '',
      files.length > 0 ? `FILES HINT TU USER: ${files.join(', ')}` : '',
      context.contextData ? `\nEXTRA CONTEXT:\n${context.contextData}` : '',
      `\nTASK CAN QUET: ${userPrompt}`
    ].filter(Boolean).join('\n');

    console.log('🔍 Scanner: quet project...');
    const response = await this._callModel('cheap', SCANNER_SYSTEM, prompt);

    try {
      return JSON.parse(response.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    } catch {
      console.log('⚠️  Scanner JSON parse failed, dung basic scan');
      return {
        stack: structuredCtx.project.stack || [],
        relevant_files: files.map(f => ({ path: f, summary: 'User-specified', lines: 0 })),
        existing_patterns: [],
        potential_issues: [],
        context_for_planner: userPrompt,
        estimated_complexity: 'medium'
      };
    }
  }

  /**
   * Thu thap du lieu thuc te tu project de inject vao scanner prompt
   * Scanner (cheap) khong co tools → can doc truoc roi dua vao
   */
  async _collectProjectData(hintFiles = []) {
    const fs = require('fs');
    const path = require('path');
    const parts = [];

    // 1. Doc package.json
    try {
      const pkgPath = path.join(this.projectDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        parts.push(`[package.json] name=${pkg.name}, deps: ${Object.keys(pkg.dependencies || {}).slice(0, 20).join(', ')}`);
        if (pkg.devDependencies) {
          parts.push(`  devDeps: ${Object.keys(pkg.devDependencies).slice(0, 10).join(', ')}`);
        }
      }
    } catch { /* ignore */ }

    // 2. Doc folder structure (depth 2, max 50 entries)
    try {
      const tree = this._listDir(this.projectDir, 2, 50);
      parts.push(`\n[Folder structure]\n${tree}`);
    } catch { /* ignore */ }

    // 3. Doc hint files (dau 50 dong moi file)
    for (const file of hintFiles.slice(0, 5)) {
      try {
        const fullPath = path.isAbsolute(file) ? file : path.join(this.projectDir, file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n').slice(0, 50).join('\n');
          parts.push(`\n[${file}] (${content.split('\n').length} lines)\n${lines}`);
        }
      } catch { /* ignore */ }
    }

    return parts.join('\n') || 'Khong doc duoc du lieu project';
  }

  /**
   * List directory tree (gioi han depth va entries)
   */
  _listDir(dir, maxDepth, maxEntries, depth = 0, entries = { count: 0 }) {
    const fs = require('fs');
    const path = require('path');
    if (depth > maxDepth || entries.count > maxEntries) return '';

    const SKIP = ['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.cache', 'coverage'];
    const lines = [];

    try {
      const items = fs.readdirSync(dir).filter(i => !SKIP.includes(i)).slice(0, 30);
      for (const item of items) {
        if (entries.count > maxEntries) break;
        entries.count++;
        const fullPath = path.join(dir, item);
        const indent = '  '.repeat(depth);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            lines.push(`${indent}${item}/`);
            lines.push(this._listDir(fullPath, maxDepth, maxEntries, depth + 1, entries));
          } else {
            lines.push(`${indent}${item}`);
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* ignore */ }

    return lines.filter(Boolean).join('\n');
  }

  /**
   * Buoc 1b: Planner xay dung execution plan tu scan results (default, gia vua)
   * Nhan scan data thuc te → plan chinh xac hon, it bua
   */
  async plan(userPrompt, context = {}) {
    const { files = [], project = '', feature = null } = context;

    // Scan truoc (neu chua co scan results)
    let scanResults = context.scanResults;
    if (!scanResults) {
      scanResults = await this.scan(userPrompt, context);
    }

    // Build locked decisions context
    const activeLocks = this.decisionLock.getActive();
    const lockInfo = activeLocks.length > 0
      ? `\nLOCKED DECISIONS (KHONG thay doi):\n${activeLocks.map(l => `- [${l.scope}] ${l.decision}`).join('\n')}`
      : '';

    const prompt = [
      `=== SCAN RESULTS (du lieu thuc te tu project) ===`,
      JSON.stringify(scanResults, null, 2),
      lockInfo,
      `\n=== USER REQUEST ===`,
      userPrompt
    ].join('\n');

    console.log(`📐 Planner: xay dung plan (complexity: ${scanResults.estimated_complexity || 'unknown'})...`);

    // Chon model cho planner dua tren complexity
    const plannerModel = scanResults.estimated_complexity === 'very_high' ? 'smart' : 'default';
    const response = await this._callModel(plannerModel, PLANNER_SYSTEM, prompt);

    try {
      const plan = JSON.parse(response.replace(/```json?\n?/g, '').replace(/```/g, '').trim());

      // Dam bao moi subtask co agentRole va model
      for (const subtask of plan.subtasks) {
        if (!subtask.agentRole) {
          subtask.agentRole = this._inferAgentRole(subtask);
        }
        if (!subtask.model) {
          subtask.model = AGENT_ROLE_MAP[subtask.agentRole] || 'default';
        }
      }

      // Dinh kem scan results vao plan de agents co context
      plan.scanResults = scanResults;

      return plan;
    } catch (e) {
      // Fallback: dung SmartRouter
      console.log('⚠️  Planner JSON parse failed, fallback to SmartRouter');
      const routeResult = this.smartRouter.route({
        task: context.task || 'build',
        files: scanResults.relevant_files?.map(f => f.path) || files,
        prompt: userPrompt,
        project
      });
      return {
        analysis: userPrompt,
        complexity: scanResults.estimated_complexity || 'medium',
        scanResults,
        subtasks: [{
          id: 1,
          description: userPrompt,
          agentRole: 'builder',
          model: routeResult.litellm_name,
          reason: routeResult.reasons.join(', '),
          files: scanResults.relevant_files?.map(f => f.path) || files,
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
    // Buoc 1: Scan + Plan (scan chay ben trong plan() neu chua co)
    console.log('🔍 Step 1: Scan & Plan...');
    const plan = await this.plan(userPrompt, context);

    // Buoc 2: Tech Lead review
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

      if (resolution.action === 'escalate_architect') {
        // Chuyen thang len Architect (Opus) — tier cao nhat
        console.log(`🏛️  [${subtask.id}] ESCALATE → Architect (Opus 4.6)`);
        currentSubtask = {
          ...currentSubtask,
          model: 'architect',
          agentRole: 'architect',
          description: `${currentSubtask.description}\n\n[Escalated from Tech Lead]: ${resolution.analysis || ''}\n[Root cause]: ${resolution.rootCause || 'unknown'}\n[Previous context]: ${resolution.resolution?.newContext || ''}`
        };
      } else if (resolution.action === 'guide') {
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
        // Escalate len tier cao hon hien tai
        const currentModel = currentSubtask.model;
        const nextTier = this._getNextEscalationTier(currentModel);
        console.log(`🧠 [${subtask.id}] TAKE_OVER: ${currentModel} → ${nextTier.model} (${nextTier.role})`);
        currentSubtask = { ...currentSubtask, model: nextTier.model, agentRole: nextTier.role };
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

    // Xac dinh task type tu agentRole (khong dung model name)
    const ROLE_TO_TASK = {
      'architect': 'design', 'tech-lead': 'review', 'debugger': 'debug',
      'reviewer': 'review', 'scanner': 'analyze', 'planner': 'plan',
      'fe-dev': 'build', 'be-dev': 'build', 'builder': 'build',
      'docs': 'docs'
    };
    const taskType = ROLE_TO_TASK[agentRole] || 'build';

    // Build structured context cho agent
    const structuredCtx = await this.contextManager.build({
      task: taskType,
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
   * Escalation chain: cheap → default → smart → architect
   * Tra ve tier cao hon hien tai
   */
  _getNextEscalationTier(currentModel) {
    const ESCALATION_CHAIN = [
      { model: 'cheap',     role: 'docs' },
      { model: 'fast',      role: 'reviewer' },
      { model: 'default',   role: 'builder' },
      { model: 'smart',     role: 'tech-lead' },
      { model: 'architect', role: 'architect' }
    ];
    const currentIndex = ESCALATION_CHAIN.findIndex(t => t.model === currentModel);
    // Tra ve tier ke tiep, hoac architect neu da o cao nhat
    const nextIndex = Math.min(currentIndex + 1, ESCALATION_CHAIN.length - 1);
    return ESCALATION_CHAIN[nextIndex];
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
    const budget = this.getBudgetStatus();
    console.log(`💰 Budget: ${budget.spent} / ${budget.budget} (${budget.percent})`);
    console.log('='.repeat(50));
  }

  // =============================================
  // BUDGET TRACKING — gioi han $2/ngay
  // =============================================

  /**
   * Reset budget tracker neu sang ngay moi
   */
  _resetBudgetIfNewDay() {
    const today = new Date().toISOString().split('T')[0];
    if (this.budgetTracker.date !== today) {
      console.log(`💰 Budget reset: new day ${today} (yesterday spent: $${this.budgetTracker.spent.toFixed(4)})`);
      this.budgetTracker = { date: today, spent: 0, calls: {} };
    }
  }

  /**
   * Check con du budget truoc khi goi model
   * Neu het budget → tu dong downgrade model
   */
  _checkBudget(model, estimatedTokens = 3000) {
    this._resetBudgetIfNewDay();

    const costPer1K = MODEL_COST_PER_1K[model] || 0.001;
    const estimatedCost = costPer1K * (estimatedTokens / 1000);
    const remaining = this.dailyBudget - this.budgetTracker.spent;

    if (estimatedCost > remaining) {
      // Tim model re hon co the dung
      const DOWNGRADE_CHAIN = ['architect', 'smart', 'default', 'fast', 'cheap'];
      const currentIndex = DOWNGRADE_CHAIN.indexOf(model);

      for (let i = currentIndex + 1; i < DOWNGRADE_CHAIN.length; i++) {
        const altModel = DOWNGRADE_CHAIN[i];
        const altCost = (MODEL_COST_PER_1K[altModel] || 0.001) * (estimatedTokens / 1000);
        if (altCost <= remaining) {
          console.log(`💰 Budget guard: ${model} ($${estimatedCost.toFixed(4)}) vuot budget → downgrade ${altModel} ($${altCost.toFixed(4)})`);
          console.log(`   Remaining: $${remaining.toFixed(4)} / $${this.dailyBudget}`);
          return { model: altModel, downgraded: true, originalModel: model };
        }
      }

      // Het sach budget
      console.log(`⛔ Budget EXHAUSTED: $${this.budgetTracker.spent.toFixed(4)} / $${this.dailyBudget}. Khong the goi model nao.`);
      return { model: null, downgraded: true, exhausted: true };
    }

    return { model, downgraded: false };
  }

  /**
   * Ghi nhan chi phi sau khi goi model
   */
  _trackCost(model, tokens) {
    const costPer1K = MODEL_COST_PER_1K[model] || 0.001;
    const cost = costPer1K * (tokens / 1000);
    this.budgetTracker.spent += cost;

    if (!this.budgetTracker.calls[model]) {
      this.budgetTracker.calls[model] = { count: 0, tokens: 0, cost: 0 };
    }
    this.budgetTracker.calls[model].count++;
    this.budgetTracker.calls[model].tokens += tokens;
    this.budgetTracker.calls[model].cost += cost;
  }

  /**
   * Lay trang thai budget hien tai
   */
  getBudgetStatus() {
    this._resetBudgetIfNewDay();
    return {
      date: this.budgetTracker.date,
      spent: `$${this.budgetTracker.spent.toFixed(4)}`,
      remaining: `$${(this.dailyBudget - this.budgetTracker.spent).toFixed(4)}`,
      budget: `$${this.dailyBudget}`,
      percent: `${Math.round((this.budgetTracker.spent / this.dailyBudget) * 100)}%`,
      calls: this.budgetTracker.calls
    };
  }

  // =============================================
  // MODEL CALL (v2.1 — budget-aware)
  // =============================================

  async _callModel(model, systemPrompt, userContent) {
    // Budget check truoc khi goi
    const budgetCheck = this._checkBudget(model);
    if (budgetCheck.exhausted) {
      throw new Error(`Budget exhausted: $${this.budgetTracker.spent.toFixed(2)} / $${this.dailyBudget}. Khong the goi model.`);
    }
    const actualModel = budgetCheck.model;

    return this._callModelWithRetry(actualModel, systemPrompt, userContent, 3);
  }

  async _callModelWithRetry(model, systemPrompt, userContent, retries) {
    // Dynamic max_tokens theo model tier
    const MAX_TOKENS = {
      'architect': 8000,  // Opus can nhieu token cho system design
      'smart':     6000,  // Sonnet cho review/debug
      'default':   4000,  // DeepSeek cho build
      'fast':      3000,  // Gemini cho scan/review
      'cheap':     2000   // GPT Mini cho docs/scan
    };
    const maxTokens = MAX_TOKENS[model] || 4000;

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
        max_tokens: maxTokens,
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

    // Track chi phi thuc te
    const usage = data.usage || {};
    const totalTokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    this._trackCost(model, totalTokens || Math.round((data.choices?.[0]?.message?.content || '').length / 4));

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
