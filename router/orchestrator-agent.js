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
const { PipelineTracer } = require('../lib/pipeline-tracer');

const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:5002';
const LITELLM_KEY = process.env.LITELLM_KEY || 'sk-master-change-me';

// === Agent Role → Model mapping (v2.3 — 2026-04-18 rebalance sau R-tier reasoning bench) ===
//
// Bench tong hop (16 task: 5A + 5B + 3R, 2 model can so):
//   cheap (GPT-5.4 Mini):  100% pass A+B+R, $0.010-0.015/task, 12-13s, 400K ctx
//   qwen3-plus:             100% pass A+B+R, $0.050-0.184/task, 20-41s, 1M ctx
//                           ^ R-tier qwen3-plus ton 12x, MISS 1/3 reasoning (R02 leak)
//
// Quyet dinh: cheap DOMINATES ca code gen + reasoning. qwen3-plus giu trong
// config nhu explicit opt-in (khi that su can 1M ctx > 400K, hiem).
// architect (Opus) chi khi SA/design cuc kho (~2% workload).
const AGENT_ROLE_MAP = {
  'architect':  'architect', // Claude Opus 4.6 — SA, system design, task cuc kho (2% workload)
  'tech-lead':  'cheap',     // GPT-5.4 Mini — review/reasoning, 100% R-tier pass
  'planner':    'cheap',     // GPT-5.4 Mini — plan, 100% A+B+R pass, stage-RAG tu dong inject
  'fe-dev':     'cheap',     // GPT-5.4 Mini — 100% pass, re nhat
  'be-dev':     'cheap',     // GPT-5.4 Mini — 100% pass, re nhat
  'reviewer':   'fast',      // Gemini 3 Flash — scan nhanh, direct Google quota
  'debugger':   'cheap',     // GPT-5.4 Mini — trace, 100% R-tier (R02 WIN qwen3-plus)
  'scanner':    'cheap',     // GPT-5.4 Mini — quet project, doc file
  'docs':       'cheap',     // GPT-5.4 Mini — text generation
  'builder':    'cheap',     // GPT-5.4 Mini — 100% pass A+B tier
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

// === Token accounting fallback counter ===
// Khi API response thieu usage.*_tokens, _callModelWithRetry phai uoc luong
// tokens = content.length / 4. Counter nay giup phat hien runaway (vi du
// 68K-token tren task tac la "count async") bang cach:
//  - console.warn moi lan fallback chay
//  - luu tong so lan + tong tokens uoc luong de test/diagnostic query
// Exported duoi module.exports de test co the reset/inspect.
const tokenFallbackStats = {
  missingUsageCount: 0,
  totalFallbackTokens: 0
};

// === Orchestrator Agent v2.1 ===
class OrchestratorAgent {
  constructor(options = {}) {
    this.litellmUrl = options.litellmUrl || LITELLM_URL;
    this.litellmKey = options.litellmKey || LITELLM_KEY;
    this.projectDir = options.projectDir || process.cwd();
    this.dispatcherModel = options.dispatcherModel || 'fast';
    this.dailyBudget = options.dailyBudget || DAILY_BUDGET;

    // Budget tracking — date theo BUDGET_TZ (default Asia/Ho_Chi_Minh) chu khong UTC.
    // Container chay UTC nhung user VN reset budget luc 0h ICT, khong phai 7h ICT.
    this._budgetTz = options.budgetTz || process.env.BUDGET_TZ || 'Asia/Ho_Chi_Minh';
    this.budgetTracker = {
      date: this._todayInTz(),
      spent: 0,
      calls: {}  // { model: { count, tokens, cost } }
    };

    // Async mutex cho budget operations — tranh race condition khi parallel tasks
    this._budgetLock = Promise.resolve();

    // Load budget tu disk (persist qua process restart)
    this._loadBudget();

    // Flush budget khi process exit — dam bao khong mat data debounced
    if (!OrchestratorAgent._exitHookRegistered) {
      OrchestratorAgent._exitHookRegistered = true;
      OrchestratorAgent._instances = OrchestratorAgent._instances || [];
      process.on('exit', () => {
        for (const inst of OrchestratorAgent._instances) {
          try { inst.flushBudget(); } catch { /* ignore */ }
        }
      });
    }
    OrchestratorAgent._instances = OrchestratorAgent._instances || [];
    OrchestratorAgent._instances.push(this);

    // Core modules
    this.smartRouter = new SmartRouter({
      availableModels: options.availableModels || ['opus-4.6', 'sonnet-4.6', 'deepseek-v3.2', 'gemini-3-flash', 'gpt-5.4-mini'],
      costOptimize: true,
      preferLocal: options.preferLocal || false
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

    // Logging — bounded ring buffer, tranh memory leak khi process chay lau
    this.executionLog = [];
    this.MAX_EXECUTION_LOG = options.maxExecutionLog || 100;
    // Stats incremental — KHONG iterate executionLog moi lan getStats() (O(N) → O(1))
    this._statsAggregate = { total_executions: 0, total_tasks: 0, total_escalations: 0, models: {}, agents: {} };

    // Pipeline Tracer — unified tracing cho debug
    this.tracer = new PipelineTracer({
      maxTraces: options.maxTraces || 100,
      logDir: options.traceLogDir || require('path').join(this.projectDir, 'data', 'traces')
    });

    // Scan data cache — tranh doc disk lap lai trong 5 phut
    this._scanCache = { data: null, key: null, expiry: 0 };
    this._scanCacheTTL = options.scanCacheTTL || 5 * 60 * 1000; // 5 phut
  }

  // =============================================
  // FLOW CHINH: classify → scan → plan → review → execute → synthesize
  // =============================================

  /**
   * Pre-classify task bang SLM — quyet dinh fast-path hay full-path
   * Chi phi: ~$0.00005 (50 tokens, cheap model), latency ~200-500ms
   */
  async _classifyTask(userPrompt, context = {}) {
    // Skip SLM cho task hien nhien — tiet kiem ~$0.00005 + 200-500ms latency
    // Trigger fast-path luon cho task ngan / task='docs' / task='review' khong files
    if (typeof userPrompt === 'string' && userPrompt.length < 50) {
      return { complexity: 'simple', intent: 'fix', domain: 'docs', skipped: 'short_prompt' };
    }
    if (context.task === 'docs') {
      return { complexity: 'simple', intent: 'docs', domain: 'docs', skipped: 'docs_task' };
    }
    try {
      if (!this._slmClassifier) {
        const { SLMClassifier } = require('./slm-classifier');
        this._slmClassifier = new SLMClassifier({
          litellmUrl: this.litellmUrl,
          litellmKey: this.litellmKey
        });
      }
      return await this._slmClassifier.classify({
        task: context.task || '',
        files: context.files || [],
        prompt: userPrompt,
        project: context.project || ''
      });
    } catch (err) {
      // Track fail rate de phat hien neu SLM bi degraded
      this._slmFails = (this._slmFails || 0) + 1;
      if (this._slmFails % 10 === 0) console.warn(`⚠️  SLM classifier failed ${this._slmFails} times — check LiteLLM`);
      return null;
    }
  }

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

    const parsed = this._parseModelJSON(response);
    if (parsed) {
      return parsed;
    } else {
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
    // Cache key = sorted hint files list
    const cacheKey = hintFiles.slice().sort().join('|');
    if (this._scanCache.key === cacheKey && Date.now() < this._scanCache.expiry) {
      console.log('📦 Scan cache hit (TTL 5min)');
      return this._scanCache.data;
    }

    const fs = require('fs');
    const path = require('path');
    const parts = [];

    // Micro-scan: khi user chi dinh files cu the → chi doc files do, skip folder tree
    const microScan = hintFiles.length > 0;

    if (!microScan) {
      // Full scan: doc package.json + folder tree (khi khong co hint files)
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
    }

    // 3. Doc hint files — micro-scan doc nhieu hon (80 dong, 8 files)
    const maxFiles = microScan ? 8 : 5;
    const maxLines = microScan ? 80 : 50;
    for (const file of hintFiles.slice(0, maxFiles)) {
      try {
        const fullPath = path.isAbsolute(file) ? file : path.join(this.projectDir, file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n').slice(0, maxLines).join('\n');
          parts.push(`\n[${file}] (${content.split('\n').length} lines)\n${lines}`);
        }
      } catch { /* ignore */ }
    }

    const result = parts.join('\n') || 'Khong doc duoc du lieu project';

    // Luu vao cache
    this._scanCache = { data: result, key: cacheKey, expiry: Date.now() + this._scanCacheTTL };

    return result;
  }

  /**
   * Load .orchignore — danh sach thu muc/file bo qua khi scan
   * Format giong .gitignore: 1 pattern/dong, # la comment
   */
  _loadOrchIgnore() {
    if (this._orchIgnorePatterns) return this._orchIgnorePatterns;

    const fs = require('fs');
    const path = require('path');
    const ignorePath = path.join(this.projectDir, '.orchignore');

    try {
      if (fs.existsSync(ignorePath)) {
        const content = fs.readFileSync(ignorePath, 'utf8');
        this._orchIgnorePatterns = content.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'));
      } else {
        this._orchIgnorePatterns = [];
      }
    } catch {
      this._orchIgnorePatterns = [];
    }

    return this._orchIgnorePatterns;
  }

  /**
   * List directory tree (gioi han depth va entries)
   */
  _listDir(dir, maxDepth, maxEntries, depth = 0, entries = { count: 0 }) {
    const fs = require('fs');
    const path = require('path');
    if (depth > maxDepth || entries.count > maxEntries) return '';

    const SKIP = ['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.cache', 'coverage', ...this._loadOrchIgnore()];
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

    const plan = this._parseModelJSON(response);
    if (plan && plan.subtasks) {
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
    } else {
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
      timestamp: new Date().toISOString(),
      project: context.project || null  // Tag de filter qua /api/history?project=
    };

    this.executionLog.push(execution);
    // Cap log: drop oldest khi vuot MAX (stats van duoc giu nhe nho aggregate rieng)
    while (this.executionLog.length > this.MAX_EXECUTION_LOG) this.executionLog.shift();
    // Aggregate stats incrementally — chi cong them, khong recompute toan log
    this._aggregateStats(execution);
    return execution;
  }

  /**
   * Uoc tinh chi phi plan tu so subtask × estimated_tokens × cost/model
   * Dung cho dry-run + /api/estimate endpoint
   */
  _estimatePlanCost(plan) {
    let totalTokens = 0;
    let totalCost = 0;
    const byModel = {};
    for (const sub of (plan?.subtasks || [])) {
      // Validate estimated_tokens — LLM doi khi tra -1 / 0 / null → fallback 5000
      const rawTokens = sub.estimated_tokens;
      const tokens = (typeof rawTokens === 'number' && rawTokens > 0) ? rawTokens : 5000;
      const model = sub.model || 'default';
      const costPer1K = MODEL_COST_PER_1K[model] || 0.001;
      const cost = costPer1K * (tokens / 1000);
      totalTokens += tokens;
      totalCost += cost;
      if (!byModel[model]) byModel[model] = { tokens: 0, cost: 0, count: 0 };
      byModel[model].tokens += tokens;
      byModel[model].cost += cost;
      byModel[model].count++;
    }
    return {
      total_tokens: totalTokens,
      total_cost: `$${totalCost.toFixed(4)}`,
      total_cost_raw: totalCost,
      by_model: byModel,
      subtasks: plan?.subtasks?.length || 0
    };
  }

  /**
   * Cheap estimate: chi goi SLM classifier + heuristic, KHONG goi planner LLM.
   * Dung cho /api/estimate khi user muon check cost truoc khi run that.
   * 18-20× re hon goi plan() (200-500ms vs 5-10s + cost smart model).
   */
  async cheapEstimate(userPrompt, context = {}) {
    const cls = await this._classifyTask(userPrompt, context);
    const complexity = cls?.complexity || 'medium';
    const intent = cls?.intent || 'build';
    const domain = cls?.domain || 'fullstack';

    // Heuristic so subtask theo complexity
    const SUBTASK_COUNT = { simple: 1, medium: 2, complex: 3, expert: 4, very_high: 4, high: 3, low: 1 };
    const numSubtasks = SUBTASK_COUNT[complexity] || 2;

    // Heuristic model tier theo intent + complexity (tu SLM mapping cua slm-classifier.js)
    const KEY = `${intent}:${complexity}`;
    const TIER_BY_INTENT = {
      'docs': 'cheap', 'review': 'fast', 'fix': 'default', 'build': 'default',
      'test': 'default', 'refactor': 'default', 'debug': 'smart', 'architect': 'architect'
    };
    let tier = TIER_BY_INTENT[intent] || 'default';
    if (complexity === 'expert' || complexity === 'very_high') tier = 'architect';
    else if (complexity === 'complex' || complexity === 'high') tier = (tier === 'cheap' || tier === 'fast') ? 'default' : tier;

    // Avg tokens per subtask theo tier (estimate)
    const TOKENS_PER_SUBTASK = { architect: 6000, smart: 4000, default: 3000, fast: 2000, cheap: 1500 };
    const tokensPerTask = TOKENS_PER_SUBTASK[tier] || 3000;
    const totalTokens = tokensPerTask * numSubtasks;
    const costPer1K = MODEL_COST_PER_1K[tier] || 0.001;
    const totalCost = costPer1K * (totalTokens / 1000);

    return {
      total_tokens: totalTokens,
      total_cost: `$${totalCost.toFixed(4)}`,
      total_cost_raw: totalCost,
      by_model: { [tier]: { tokens: totalTokens, cost: totalCost, count: numSubtasks } },
      subtasks: numSubtasks,
      classification: { intent, complexity, domain },
      method: 'heuristic',  // Phan biet voi _estimatePlanCost dung plan thuc
      note: 'Estimate dua tren SLM classify + heuristic. Dung dry-run de co plan that.'
    };
  }

  /**
   * Lay history executions gan day — dung cho /api/history endpoint
   */
  getHistory(limit = 20, project = null) {
    let logs = this.executionLog.slice();
    if (project) {
      logs = logs.filter(e => e.project === project);
    }
    return logs.slice(-Math.min(limit, this.MAX_EXECUTION_LOG)).reverse().map(e => ({
      timestamp: e.timestamp,
      summary: e.summary?.slice(0, 200) || e.plan?.analysis?.slice(0, 200) || '',
      models_used: e.models_used,
      elapsed_ms: e.elapsed_ms,
      tasks: Object.keys(e.results || {}).length,
      escalations: e.escalations?.length || 0,
      project: e.project || null
    }));
  }

  /**
   * Cong don stats khi them 1 execution — O(subtasks) thay vi O(N×M) khi getStats
   */
  _aggregateStats(execution) {
    this._statsAggregate.total_executions++;
    for (const result of Object.values(execution.results)) {
      this._statsAggregate.total_tasks++;
      const m = result.model;
      if (!this._statsAggregate.models[m]) this._statsAggregate.models[m] = { count: 0, tokens: 0 };
      this._statsAggregate.models[m].count++;
      this._statsAggregate.models[m].tokens += result.tokens || 0;
      const role = result.agentRole || 'unknown';
      if (!this._statsAggregate.agents[role]) this._statsAggregate.agents[role] = { count: 0, escalated: 0 };
      this._statsAggregate.agents[role].count++;
      if (result.escalated) {
        this._statsAggregate.agents[role].escalated++;
        this._statsAggregate.total_escalations++;
      }
    }
  }

  /**
   * Full flow: plan → review → execute
   * Options:
   *  - context.dryRun = true → return plan + estimate, KHONG execute (an toan test)
   *  - context.signal (AbortSignal) → cancel mid-pipeline (throw AbortError)
   *  - context.project = '<name>' → attribute budget vao project rieng
   */
  async run(userPrompt, context = {}) {
    const dryRun = context.dryRun === true;
    const signal = context.signal || null;
    const checkAbort = () => {
      if (signal && signal.aborted) throw Object.assign(new Error('Run cancelled'), { code: 'ABORT' });
    };

    // Tao trace moi cho toan bo pipeline
    const trace = this.tracer.start('run', {
      prompt: userPrompt.slice(0, 200),
      files: context.files?.length || 0,
      project: context.project || ''
    });

    try {
      checkAbort();

      // Buoc 0+1 PARALLEL: classify + scan chay song song.
      // Truoc day sequential (classify → scan) ton ~300-500ms wait.
      // SLM classify (200-500ms) chay cung luc scanner (1-3s) → tiet kiem latency.
      // Trade-off: neu isSimple+files → scan call dung de nhung con re ($0.0005).
      trace.step('classify', { model: 'cheap' });
      trace.step('scan', { model: 'cheap' });

      const [clsRes, scanRes] = await Promise.allSettled([
        this._classifyTask(userPrompt, context),
        this.scan(userPrompt, context)
      ]);

      const classification = clsRes.status === 'fulfilled' ? clsRes.value : null;
      const isSimple = classification && classification.complexity === 'simple';
      trace.stepDone('classify', { complexity: classification?.complexity, fast_path: isSimple });

      if (scanRes.status === 'rejected') {
        trace.stepFail('scan', scanRes.reason, { model: 'cheap' });
        const summary = this.tracer.finish(trace);
        return { status: 'error', ...summary.error_attribution, trace: summary };
      }
      const scanResults = scanRes.value;
      trace.stepDone('scan', { stack: scanResults?.stack?.length || 0 });

      // Buoc 1b: Plan voi scan results da co (KHONG goi scan lan 2)
      trace.step('plan', { model: isSimple ? 'default' : 'default' });
      let plan;
      try {
        plan = await this.plan(userPrompt, { ...context, scanResults });
        trace.stepDone('plan', { subtasks: plan.subtasks?.length });
      } catch (err) {
        trace.stepFail('plan', err, { model: 'default' });
        const summary = this.tracer.finish(trace);
        return { status: 'error', ...summary.error_attribution, trace: summary };
      }

      checkAbort();

      // Dry-run: return plan + estimate, KHONG goi review/execute.
      // An toan test prompt khong mutate file. Tiet kiem 80% chi phi.
      if (dryRun) {
        const summary = this.tracer.finish(trace);
        const estimate = this._estimatePlanCost(plan);
        return {
          status: 'dry_run',
          plan,
          estimate,
          trace: summary,
          message: 'Dry-run: plan generated, execute SKIPPED (set dry=false to apply)'
        };
      }

      // Buoc 2: Tech Lead review (skip cho simple tasks)
      let approvedPlan = plan;
      if (isSimple) {
        trace.step('review', { model: 'skip' });
        trace.stepDone('review', { action: 'auto_approve', reason: 'simple task' });
      } else {
        trace.step('review', { model: 'smart' });
        let reviewResult;
        try {
          reviewResult = await this.review(plan, context);
          trace.stepDone('review', { action: reviewResult.action });
        } catch (err) {
          trace.stepFail('review', err, { model: 'smart' });
          const summary = this.tracer.finish(trace);
          return { status: 'error', ...summary.error_attribution, trace: summary };
        }

        if (reviewResult.action === 'reject') {
          trace.warn('review', `Plan REJECTED: ${reviewResult.guidance || 'no reason'}`);
          const summary = this.tracer.finish(trace);
          return {
            status: 'rejected',
            reason: reviewResult.guidance || 'Tech Lead rejected plan',
            plan,
            review: reviewResult,
            trace: summary
          };
        }

        approvedPlan = reviewResult.plan || plan;
      }

      checkAbort();

      // Buoc 3: Execute
      trace.step('execute', { subtasks: approvedPlan.subtasks?.length });
      let execution;
      try {
        execution = await this.execute(approvedPlan, context);
        trace.stepDone('execute', {
          success: true,
          models_used: execution.models_used
        });
      } catch (err) {
        trace.stepFail('execute', err);
        const summary = this.tracer.finish(trace);
        return { status: 'error', ...summary.error_attribution, trace: summary };
      }

      // Report
      this._printReport(execution);

      // Finish trace
      const summary = this.tracer.finish(trace, execution);
      execution.trace = summary;

      return execution;
    } catch (err) {
      // Catch-all — bat loi khong du doan
      trace.stepFail('unknown', err);
      const summary = this.tracer.finish(trace);
      return { status: 'error', ...summary.error_attribution, trace: summary };
    }
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
      // Architect ceiling: neu da o tier cao nhat (architect) va da chay 1 lan,
      // KHONG retry tiep — moi lan goi architect ton ~$0.045/1k. Truoc day loop
      // se goi architect 3 lan vo ich vi khong co tier nao cao hon.
      if (currentSubtask.model === 'architect' && escalationCount > 0) {
        console.log(`🛑 [${subtask.id}] Architect ceiling — break (avoid burning $0.045/1k)`);
        if (lastResult) lastResult.escalation_ceiling_reached = true;
        break;
      }

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
      const errorMsg = err.message || String(err);
      console.log(`❌ [${subtask.id}] Error: ${errorMsg}`);

      // Log structured error cho debugging
      const result = {
        id: subtask.id,
        model: subtask.model,
        agentRole,
        output: `Error: ${errorMsg}`,
        elapsed_ms: Date.now() - start,
        success: false,
        // Error attribution — de trace biet step nao fail
        errorDetail: {
          step: 'subtask',
          subtaskId: subtask.id,
          model: subtask.model,
          agentRole,
          message: errorMsg,
          files: subtask.files || []
        }
      };
      return result;
    }
  }

  // =============================================
  // JSON PARSING — robust handler cho model output
  // =============================================

  /**
   * Parse JSON tu model response — xu ly cac truong hop loi pho bien:
   * 1. Markdown code blocks (co the nested)
   * 2. Trailing commas truoc } va ]
   * 3. JS-style comments (single-line // va multi-line block comments)
   * 4. JSON nam giua text khac
   * Tra ve parsed object hoac null neu khong parse duoc
   */
  _parseModelJSON(response) {
    if (!response || typeof response !== 'string') return null;

    // Fast-path: thu parse truc tiep tren response da trim — tranh 4 regex pass
    // Khi LLM tuan thu prompt "ONLY JSON", hau het response sach. Hit rate ~70-80%.
    const trimmed = response.trim();
    try { return JSON.parse(trimmed); } catch { /* tiep tuc slow-path */ }

    let cleaned = trimmed;

    // 1. Strip markdown code blocks (handle nested — xoa ngoai cung truoc)
    // Loai bo ```json ... ``` va ``` ... ```
    cleaned = cleaned.replace(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)```/g, '$1');

    cleaned = cleaned.trim();

    // 2. Xoa JS-style comments — CHI ngoai string (tranh pha URL trong JSON)
    // Multi-line comments: /* ... */ (an toan vi khong xuat hien trong JSON values)
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
    // Single-line comments: chi xoa neu o dau dong hoac sau whitespace (khong phai trong string)
    // Tranh pha "https://..." trong JSON values
    cleaned = cleaned.replace(/^\s*\/\/[^\n]*/gm, '');

    // 3. Xoa trailing commas truoc } va ]
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

    // 4. Thu JSON.parse sau khi clean
    try {
      return JSON.parse(cleaned);
    } catch { /* tiep tuc thu brace-matching */ }

    // 5. Tim va extract JSON block dau tien bang brace matching
    const startChars = ['{', '['];
    for (const startChar of startChars) {
      const endChar = startChar === '{' ? '}' : ']';
      const startIndex = cleaned.indexOf(startChar);
      if (startIndex === -1) continue;

      let depth = 0;
      let inString = false;
      let escape = false;

      for (let i = startIndex; i < cleaned.length; i++) {
        const ch = cleaned[i];

        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }

        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === startChar) depth++;
        if (ch === endChar) depth--;

        if (depth === 0) {
          let block = cleaned.slice(startIndex, i + 1);
          // Xoa trailing commas trong block
          block = block.replace(/,\s*([}\]])/g, '$1');
          try {
            return JSON.parse(block);
          } catch { break; } // Block nay khong hop le, thu startChar tiep theo
        }
      }
    }

    return null;
  }

  // =============================================
  // HELPERS
  // =============================================

  /**
   * Tổng hợp kết quả cuối cùng
   * Fast-path: ≤3 results va khong fail → format thuan, KHONG goi LLM (tiet kiem token)
   * Slow-path: nhieu result/co fail → goi dispatcher LLM tong hop
   */
  async _synthesize(plan, results) {
    const arr = Object.values(results);
    const failed = arr.filter(r => !r.success);

    // Fast-path: it ket qua, khong fail → concat template, ~0 token
    if (arr.length <= 3 && failed.length === 0) {
      const lines = arr.map(r => {
        const summary = (r.normalized?.summary || r.output || '').slice(0, 300);
        return `• [${r.id}/${r.agentRole}]${r.escalated ? ' (escalated)' : ''}: ${summary}`;
      });
      return `${plan.analysis}\n\n${lines.join('\n')}`;
    }

    // Slow-path: complex result → goi LLM tong hop
    const summaryPrompt = `Tổng hợp kết quả các sub-tasks thành 1 kết quả thống nhất.
Chỉ trả về kết quả cuối cùng, KHÔNG lặp lại từng bước.

Plan: ${plan.analysis}

Results:
${arr.map(r =>
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
  // BUDGET LOCK — async mutex cho budget operations
  // =============================================

  /**
   * Async mutex pattern — dam bao chi 1 budget operation chay tai 1 thoi diem
   * Tranh race condition khi Promise.all chay nhieu subtask song song
   */
  async _withBudgetLock(fn) {
    const release = this._budgetLock;
    let resolve;
    this._budgetLock = new Promise(r => { resolve = r; });
    await release;
    try { return await fn(); } finally { resolve(); }
  }

  // =============================================
  // BUDGET PERSISTENCE — luu/doc tu disk
  // =============================================

  _getBudgetPath() {
    return require('path').join(this.projectDir, 'data', 'budget-tracker.json');
  }

  /**
   * Load budget tu disk — giu chi phi khi restart process
   * Chi load neu cung ngay, khac ngay → reset ve 0
   */
  _loadBudget() {
    try {
      const data = JSON.parse(require('fs').readFileSync(this._getBudgetPath(), 'utf8'));
      if (data.date === this._todayInTz()) {
        this.budgetTracker = data;
      }
    } catch { /* first run hoac file corrupt — dung defaults */ }
  }

  /**
   * Luu budget xuong disk — debounced 5s de tranh sync write moi LLM call
   * (50 calls/min = 50 sync write block event loop). force=true khi shutdown.
   * Tradeoff: crash co the mat ~5s data; chap nhan duoc cho budget tracking.
   */
  _saveBudget(force = false) {
    const now = Date.now();
    if (!force && this._lastBudgetSave && now - this._lastBudgetSave < 5000) {
      // Schedule lazy save 1 lan thay vi spam
      if (!this._budgetSavePending) {
        this._budgetSavePending = setTimeout(() => {
          this._budgetSavePending = null;
          this._saveBudget(true);
        }, 5000 - (now - this._lastBudgetSave));
      }
      return;
    }
    this._lastBudgetSave = now;
    if (this._budgetSavePending) { clearTimeout(this._budgetSavePending); this._budgetSavePending = null; }
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(this._getBudgetPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._getBudgetPath(), JSON.stringify(this.budgetTracker, null, 2));
  }

  /**
   * Flush budget xuong disk ngay — goi tu graceful shutdown
   */
  flushBudget() { this._saveBudget(true); }

  // =============================================
  // BUDGET TRACKING — gioi han $2/ngay
  // =============================================

  /**
   * Reset budget tracker neu sang ngay moi
   */
  _resetBudgetIfNewDay() {
    const today = this._todayInTz();
    if (this.budgetTracker.date !== today) {
      console.log(`💰 Budget reset: new day ${today} (yesterday spent: $${this.budgetTracker.spent.toFixed(4)})`);
      this.budgetTracker = { date: today, spent: 0, calls: {} };
    }
  }

  /**
   * Lay ngay hien tai theo timezone cau hinh (default Asia/Ho_Chi_Minh).
   * Tranh container UTC reset budget sai gio cho user dia phuong.
   * Format YYYY-MM-DD de match cu.
   */
  _todayInTz() {
    try {
      // 'sv' locale tra ve YYYY-MM-DD format chinh xac
      return new Date().toLocaleDateString('sv', { timeZone: this._budgetTz });
    } catch {
      // Fallback neu TZ invalid
      return new Date().toISOString().split('T')[0];
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

    // Reserve estimated cost — tranh race condition khi parallel tasks
    const reservedCost = costPer1K * (estimatedTokens / 1000);
    this.budgetTracker.spent += reservedCost;
    this._saveBudget();
    return { model, downgraded: false, reservedCost };
  }

  /**
   * Ghi nhan chi phi sau khi goi model
   */
  _trackCost(model, tokens, reservedCost = 0) {
    const costPer1K = MODEL_COST_PER_1K[model] || 0.001;
    const actualCost = costPer1K * (tokens / 1000);
    // Reconcile: tra lai reserved, ghi nhan actual
    const delta = actualCost - reservedCost;
    this.budgetTracker.spent += delta;

    if (!this.budgetTracker.calls[model]) {
      this.budgetTracker.calls[model] = { count: 0, tokens: 0, cost: 0 };
    }
    this.budgetTracker.calls[model].count++;
    this.budgetTracker.calls[model].tokens += tokens;
    this.budgetTracker.calls[model].cost += actualCost;

    // Persist xuong disk sau moi lan track
    this._saveBudget();
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

  /**
   * Goi vision model voi anh — content la array { type: 'text' | 'image_url' }.
   * LiteLLM forward sang OpenAI vision format. Models support: fast (Gemini 3
   * Flash), smart (Claude Sonnet 4.6), architect (Opus 4.6). Cheap/default
   * thuong khong vision → auto-upgrade sang fast.
   *
   * @param {string} model - 'fast' / 'smart' / 'architect' (vision-capable)
   * @param {string} systemPrompt - system message
   * @param {string} userText - user text question
   * @param {string[]} images - array of data:image/...;base64,... or http URLs
   */
  async callVisionModel(model, systemPrompt, userText, images = []) {
    if (!images.length) return this._callModel(model, systemPrompt, userText);

    // Vision capability check — neu model khong vision → auto-upgrade sang fast
    const VISION_CAPABLE = new Set(['fast', 'smart', 'architect']);
    const visionModel = VISION_CAPABLE.has(model) ? model : 'fast';
    if (visionModel !== model) {
      console.log(`👁️  Model "${model}" khong vision-capable → auto-upgrade "${visionModel}"`);
    }

    // Budget check + reserve
    const budgetCheck = await this._withBudgetLock(() => this._checkBudget(visionModel, 5000));
    if (budgetCheck.exhausted) {
      throw new Error(`Budget exhausted: $${this.budgetTracker.spent.toFixed(2)} / $${this.dailyBudget}`);
    }
    const actualModel = budgetCheck.model;
    const reservedCost = budgetCheck.reservedCost || 0;

    // Build vision content array (OpenAI format — LiteLLM forward sang Gemini/Claude/etc)
    const userContent = [
      { type: 'text', text: userText || 'Phan tich anh nay.' },
      ...images.slice(0, 4).map(url => ({  // Cap 4 anh / call de tranh blow context
        type: 'image_url',
        image_url: { url, detail: 'auto' }
      }))
    ];

    const TIMEOUT_MS = parseInt(process.env.LITELLM_TIMEOUT_MS) || 120000; // Vision cham hon
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      // Vision max_tokens 2000 (giam tu 3000) — fit OpenRouter free tier credit
      const VISION_MAX_TOKENS = parseInt(process.env.VISION_MAX_TOKENS) || 2000;
      const response = await fetch(`${this.litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.litellmKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: actualModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          max_tokens: VISION_MAX_TOKENS,
          temperature: 0.3
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await response.json();

      if (data.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        // Refund truoc khi check credit downgrade
        if (reservedCost > 0) {
          await this._withBudgetLock(() => {
            this.budgetTracker.spent = Math.max(0, this.budgetTracker.spent - reservedCost);
          });
        }
        // Auto-downgrade neu credit insufficient — fast la model vision re nhat,
        // khong xuong duoc thap hon trong vision tier. Throw clear message.
        const isCreditErr = /requires more credits|credit_balance|insufficient.*balance|credit.*low/i.test(errMsg);
        if (isCreditErr) {
          throw new Error(`Het credit cho vision model "${actualModel}". Toi-up OpenRouter hoac giam VISION_MAX_TOKENS env (hien tai ${VISION_MAX_TOKENS})`);
        }
        throw new Error(errMsg);
      }

      // Track actual cost
      const usage = data.usage || {};
      const totalTokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
      await this._withBudgetLock(() => this._trackCost(actualModel, totalTokens || 5000, reservedCost));

      return {
        text: data.choices?.[0]?.message?.content || '',
        model: actualModel,
        usage: { tokens: totalTokens, prompt: usage.prompt_tokens, completion: usage.completion_tokens }
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (reservedCost > 0) {
        await this._withBudgetLock(() => {
          this.budgetTracker.spent = Math.max(0, this.budgetTracker.spent - reservedCost);
        });
      }
      throw err;
    }
  }

  async _callModel(model, systemPrompt, userContent) {
    // Budget check truoc khi goi — dung lock tranh race condition
    const budgetCheck = await this._withBudgetLock(() => this._checkBudget(model));
    if (budgetCheck.exhausted) {
      throw new Error(`Budget exhausted: $${this.budgetTracker.spent.toFixed(2)} / $${this.dailyBudget}. Khong the goi model.`);
    }
    const actualModel = budgetCheck.model;
    const reservedCost = budgetCheck.reservedCost || 0;

    try {
      return await this._callModelWithRetry(actualModel, systemPrompt, userContent, 3, reservedCost);
    } catch (err) {
      // Refund reserved cost neu retry exhausted/timeout/network fail — tranh false depletion.
      // _trackCost khong chay khi throw → reserved bi giu lai vinh vien neu khong refund.
      if (reservedCost > 0) {
        await this._withBudgetLock(() => {
          this.budgetTracker.spent = Math.max(0, this.budgetTracker.spent - reservedCost);
          this._saveBudget();
        });
      }
      throw err;
    }
  }

  async _callModelWithRetry(model, systemPrompt, userContent, retries, reservedCost = 0) {
    // Dynamic max_tokens theo model tier — giam smart 6000→3000 de fit OpenRouter
    // free tier (~1751 credit). Architect giu 8000 vi rare + cost trade-off OK.
    const MAX_TOKENS = {
      'architect': 8000,
      'smart':     3000,  // Sonnet — giam tu 6000 de tranh "requires more credits"
      'default':   4000,
      'fast':      3000,
      'cheap':     2000
    };
    const maxTokens = MAX_TOKENS[model] || 4000;

    // Timeout 90s/call — tranh fetch hang vo tan khi LiteLLM treo
    const TIMEOUT_MS = parseInt(process.env.LITELLM_TIMEOUT_MS) || 90000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response, data;
    try {
      response = await fetch(`${this.litellmUrl}/v1/chat/completions`, {
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
        }),
        signal: controller.signal
      });
      data = await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      // Network err / timeout / abort → retry voi exponential backoff
      const isTimeout = err.name === 'AbortError';
      const isNetwork = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || /fetch failed|network/i.test(err.message);
      if (retries > 0 && (isTimeout || isNetwork)) {
        const waitSec = Math.min(15, 2 ** (4 - retries));
        const reason = isTimeout ? `timeout >${TIMEOUT_MS}ms` : `network ${err.code || err.message}`;
        console.log(`⏳ LiteLLM ${reason}, retry in ${waitSec}s (${retries} retries left)`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return this._callModelWithRetry(model, systemPrompt, userContent, retries - 1, reservedCost);
      }
      throw new Error(`LiteLLM call failed: ${isTimeout ? 'timeout' : err.message}`);
    }
    clearTimeout(timeoutId);

    if (data.error) {
      const errMsg = data.error.message || JSON.stringify(data.error);

      // Auto-downgrade khi provider bao thieu credit/balance — switch sang model re hon.
      // OpenRouter: "requires more credits, or fewer max_tokens".
      // Anthropic: "credit_balance_too_low".
      const isCreditErr = /requires more credits|credit_balance|insufficient.*balance|credit.*low/i.test(errMsg);
      if (retries > 0 && isCreditErr) {
        const DOWNGRADE = ['architect', 'smart', 'default', 'fast', 'cheap'];
        const idx = DOWNGRADE.indexOf(model);
        if (idx >= 0 && idx < DOWNGRADE.length - 1) {
          const cheaperModel = DOWNGRADE[idx + 1];
          console.log(`💸 Credit insufficient cho "${model}" → auto-downgrade "${cheaperModel}"`);
          // Refund reserved cua model cu, _callModel se reserve lai cho model moi qua _checkBudget
          if (reservedCost > 0) {
            await this._withBudgetLock(() => {
              this.budgetTracker.spent = Math.max(0, this.budgetTracker.spent - reservedCost);
            });
          }
          // Re-enter qua _callModel (de _checkBudget reserve dung cost cho model moi)
          return this._callModel(cheaperModel, systemPrompt, userContent);
        }
      }

      // Rate limit retry voi backoff
      if (retries > 0 && (errMsg.includes('429') || errMsg.includes('RateLimit') || errMsg.includes('quota'))) {
        const waitSec = Math.min(30, 2 ** (4 - retries));
        console.log(`⏳ Rate limited, waiting ${waitSec}s... (${retries} retries left)`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return this._callModelWithRetry(model, systemPrompt, userContent, retries - 1, reservedCost);
      }
      throw new Error(errMsg);
    }

    // Track chi phi thuc te — dung lock tranh race condition
    const usage = data.usage || {};
    const totalTokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    const responseContent = data.choices?.[0]?.message?.content || '';
    let tokensForCost = totalTokens;
    if (!totalTokens) {
      // Fallback: API response khong co usage — uoc luong tho theo do dai content.
      // Estimate nay CO THE SAI lon (tung gay runaway 68K tokens tren task nho).
      // Log warn + count de debug — xem tokenFallbackStats neu nghi runaway.
      const contentLen = responseContent.length;
      const estimated = Math.round(contentLen / 4);
      tokensForCost = estimated;
      tokenFallbackStats.missingUsageCount += 1;
      tokenFallbackStats.totalFallbackTokens += estimated;
      console.warn(
        `[token-fallback] role=${this.currentAgentRole || 'unknown'} ` +
        `model=${model} content_len=${contentLen} est_tokens=${estimated} ` +
        `count=${tokenFallbackStats.missingUsageCount} — usage missing, fallback estimate may be wrong`
      );
    }
    await this._withBudgetLock(() => this._trackCost(model, tokensForCost, reservedCost));

    return responseContent;
  }

  // =============================================
  // STATS
  // =============================================

  getStats() {
    // O(1) — tra ve aggregate da maintain incremental, khong iterate executionLog
    // Truoc day O(N×M) → spam /api/stats co the pin CPU khi N lon
    return {
      ...this._statsAggregate,
      decisions_locked: this.decisionLock.getActive().length,
      tech_lead: this.techLead.getStats(),
      log_size: this.executionLog.length,
      log_capped: this.executionLog.length >= this.MAX_EXECUTION_LOG
    };
  }
}

module.exports = { OrchestratorAgent, AGENT_ROLE_MAP, tokenFallbackStats };
