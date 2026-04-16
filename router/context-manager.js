#!/usr/bin/env node
/**
 * Context Manager — Chuẩn hóa context cho multi-model orchestration
 *
 * Vấn đề: Mỗi model (Claude, DeepSeek, Kimi, Gemini) hiểu context dạng text khác nhau.
 * Giải pháp: Normalize context thành structured JSON → inject vào prompt theo format chuẩn.
 *
 * Mỗi model nhận CÙNG 1 context object, chỉ khác prompt template.
 * → Tất cả agent "hiểu một sự thật" — tránh vỡ khi multi-model.
 *
 * Cách dùng:
 *   const cm = new ContextManager({ projectDir: '/path/to/project' });
 *   const ctx = await cm.build({ task: 'build', files: ['src/auth.ts'], feature: 'auth' });
 *   const prompt = cm.inject(ctx, 'fe-dev');  // inject vào prompt template cho FE Dev
 */

const fs = require('fs');
const path = require('path');
const { ContextCache } = require('../cache/context-cache');

// === Structured Context Schema ===
// Mọi agent đều nhận context theo format này — không có ngoại lệ
const EMPTY_CONTEXT = {
  version: '1.0',
  timestamp: null,

  // Project metadata — mọi agent đều cần
  project: {
    name: '',
    stack: [],        // ['nextjs', 'nestjs', 'mysql', 'redis']
    dir: '',
    branch: '',
    lastCommit: ''
  },

  // Task hiện tại — agent chỉ làm đúng task này
  task: {
    id: null,
    type: '',         // build, fix, review, spec, debug, cleanup, docs
    description: '',
    files: [],        // files liên quan
    domain: '',       // frontend, backend, database, fullstack
    estimatedTokens: 0
  },

  // Constraints — KHÔNG được vi phạm
  constraints: {
    constitution: null,   // Nội dung constitution.md (nếu có)
    conventions: [],      // Coding conventions
    lockedDecisions: [],  // Quyết định đã lock bởi Tech Lead
    forbidden: []         // Hành động bị cấm
  },

  // Spec & Plan — context cho build/fix tasks
  spec: {
    summary: null,
    acceptanceCriteria: [],
    technicalNotes: null
  },

  plan: {
    summary: null,
    currentStep: null,
    totalSteps: 0,
    dependencies: []
  },

  // Kết quả từ agent trước — chain context
  previousResults: [],

  // Escalation info — khi agent gặp khó, gửi lên Tech Lead
  escalation: {
    fromAgent: null,
    reason: null,
    attemptsMade: 0,
    errorLog: []
  }
};

// === Domain detection cho task ===
function detectTaskDomain(files, prompt) {
  const domains = { frontend: 0, backend: 0, database: 0 };

  // Phân tích files
  for (const file of files) {
    const f = file.toLowerCase().replace(/\\/g, '/');
    if (/\.(tsx|jsx|vue|css|scss)$/.test(f) ||
        /\/(components|pages|app|layouts|hooks|styles)\//.test(f)) {
      domains.frontend += 2;
    }
    if (/\.(service|controller|guard|middleware|gateway)\.(ts|js)$/.test(f) ||
        /\/(api|server|modules|services|controllers)\//.test(f)) {
      domains.backend += 2;
    }
    if (/\.(entity|migration|schema|seed)\.(ts|js)$/.test(f) || /\.sql$/.test(f) ||
        /\/(entities|migrations|schemas|seeds)\//.test(f)) {
      domains.database += 2;
    }
  }

  // Phân tích prompt keywords
  const lower = (prompt || '').toLowerCase();
  if (/\b(component|jsx|tsx|react|vue|css|tailwind|ui|layout|responsive)\b/.test(lower)) domains.frontend++;
  if (/\b(api|endpoint|controller|service|nestjs|express|auth|middleware)\b/.test(lower)) domains.backend++;
  if (/\b(database|sql|query|migration|entity|table|typeorm|drizzle)\b/.test(lower)) domains.database++;

  // Chọn domain cao nhất
  const max = Math.max(domains.frontend, domains.backend, domains.database);
  if (max === 0) return 'general';
  if (domains.frontend === max && domains.backend === max) return 'fullstack';
  if (domains.frontend === max) return 'frontend';
  if (domains.backend === max) return 'backend';
  return 'database';
}

// === Detect project stack từ files ===
function detectStack(projectDir) {
  const stack = [];
  const check = (file, tag) => {
    if (fs.existsSync(path.join(projectDir, file))) stack.push(tag);
  };

  // JS/TS ecosystem
  check('package.json', 'node');
  check('next.config.js', 'nextjs');
  check('next.config.ts', 'nextjs');
  check('next.config.mjs', 'nextjs');
  check('vite.config.ts', 'vite');
  check('vite.config.js', 'vite');
  check('nuxt.config.ts', 'nuxt');
  check('nest-cli.json', 'nestjs');
  check('angular.json', 'angular');

  // Python
  check('requirements.txt', 'python');
  check('pyproject.toml', 'python');
  check('manage.py', 'django');
  check('app.py', 'flask');

  // Database
  check('docker-compose.yaml', 'docker');
  check('docker-compose.yml', 'docker');
  check('prisma/schema.prisma', 'prisma');

  // Config
  check('tailwind.config.js', 'tailwind');
  check('tailwind.config.ts', 'tailwind');
  check('.env', 'env-config');

  return [...new Set(stack)];
}

// === Lấy git info nhanh ===
function getGitInfo(projectDir) {
  const { execSync } = require('child_process');
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    const lastCommit = execSync('git log --oneline -1', { cwd: projectDir, encoding: 'utf-8' }).trim();
    return { branch, lastCommit };
  } catch {
    return { branch: 'unknown', lastCommit: 'unknown' };
  }
}

// === Context Manager Class ===
class ContextManager {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.projectName = options.projectName || path.basename(this.projectDir);
    this.cache = new ContextCache({ ttlMinutes: options.cacheTTL || 30 });
    this.decisionLock = options.decisionLock || null; // DecisionLock instance
  }

  /**
   * Build structured context cho 1 task
   * Mọi agent gọi hàm này trước khi bắt đầu làm việc
   */
  async build({ task = 'build', description = '', files = [], feature = null, previousResults = [] }) {
    const ctx = JSON.parse(JSON.stringify(EMPTY_CONTEXT));
    ctx.timestamp = new Date().toISOString();

    // 1. Project metadata
    const gitInfo = getGitInfo(this.projectDir);
    ctx.project = {
      name: this.projectName,
      stack: detectStack(this.projectDir),
      dir: this.projectDir,
      branch: gitInfo.branch,
      lastCommit: gitInfo.lastCommit
    };

    // 2. Task info
    ctx.task = {
      id: `${task}-${Date.now()}`,
      type: task,
      description,
      files,
      domain: detectTaskDomain(files, description),
      estimatedTokens: this._estimateTokens(files)
    };

    // 3. Constraints — load constitution + conventions
    ctx.constraints = await this._loadConstraints();

    // Thêm locked decisions nếu có DecisionLock
    if (this.decisionLock) {
      ctx.constraints.lockedDecisions = this.decisionLock.getActive();
    }

    // 4. Spec & Plan (nếu có feature)
    if (feature) {
      ctx.spec = this._loadSpec(feature);
      ctx.plan = this._loadPlan(feature);
    }

    // 5. Previous results (chain context từ agent trước)
    if (previousResults.length > 0) {
      ctx.previousResults = previousResults.map(r => ({
        agentRole: r.agentRole || 'unknown',
        model: r.model || 'unknown',
        summary: this._truncate(r.output || '', 500),
        success: r.success !== false,
        timestamp: r.timestamp || null
      }));
    }

    return ctx;
  }

  /**
   * Inject context vào prompt cho agent cụ thể
   * Trả về string prompt đã format — sẵn sàng gửi cho model
   */
  inject(ctx, agentRole, promptTemplate = null) {
    // Dùng template có sẵn hoặc custom
    const template = promptTemplate || this._getDefaultTemplate(agentRole);

    // Build structured context block — JSON format để mọi model parse giống nhau
    const contextBlock = this._formatContextBlock(ctx, agentRole);

    // Combine: template + context + task
    return [
      template,
      '',
      '=== CONTEXT (structured, DO NOT modify) ===',
      contextBlock,
      '=== END CONTEXT ===',
      '',
      `=== TASK ===`,
      ctx.task.description,
      `=== END TASK ===`,
      '',
      this._getConstraintBlock(ctx),
      this._getEscalationRules(agentRole)
    ].filter(Boolean).join('\n');
  }

  /**
   * Normalize output từ model — chuẩn hóa trước khi truyền cho agent tiếp theo
   * Giải quyết vấn đề: mỗi model trả output format khác nhau
   */
  normalizeOutput(rawOutput, agentRole, model) {
    return {
      agentRole,
      model,
      timestamp: new Date().toISOString(),
      // Tách code blocks ra riêng
      codeBlocks: this._extractCodeBlocks(rawOutput),
      // Tách decisions/recommendations
      decisions: this._extractDecisions(rawOutput),
      // Phần text còn lại (summary)
      summary: this._extractSummary(rawOutput),
      // Raw output cho reference
      raw: rawOutput,
      // Flag: agent có yêu cầu escalation không
      needsEscalation: this._detectEscalation(rawOutput)
    };
  }

  // === Private methods ===

  async _loadConstraints() {
    const constraints = {
      constitution: null,
      conventions: [],
      lockedDecisions: [],
      forbidden: [
        'Không sửa code ngoài scope task',
        'Không thay đổi API contract đã lock',
        'Không xóa test đang pass',
        'Không commit .env hoặc secrets'
      ]
    };

    // Load constitution
    const constitutionPath = path.join(this.projectDir, '.sdd', 'constitution.md');
    if (fs.existsSync(constitutionPath)) {
      let content = this.cache.get('constitution', constitutionPath);
      if (!content) {
        content = fs.readFileSync(constitutionPath, 'utf-8');
        this.cache.set('constitution', constitutionPath, content);
      }
      constraints.constitution = content;
    }

    // Load conventions từ CLAUDE.md hoặc .roo/rules
    const claudeMdPath = path.join(this.projectDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      let content = this.cache.get('conventions', claudeMdPath);
      if (!content) {
        content = fs.readFileSync(claudeMdPath, 'utf-8');
        this.cache.set('conventions', claudeMdPath, content);
      }
      // Trích conventions ngắn gọn thay vì full file
      constraints.conventions = this._extractConventions(content);
    }

    return constraints;
  }

  _loadSpec(feature) {
    const specPath = path.join(this.projectDir, '.sdd', 'features', feature, 'spec.md');
    if (!fs.existsSync(specPath)) return { summary: null, acceptanceCriteria: [], technicalNotes: null };

    const content = fs.readFileSync(specPath, 'utf-8');
    return {
      summary: this._truncate(content, 1000),
      acceptanceCriteria: this._extractListItems(content, /acceptance criteria/i),
      technicalNotes: this._extractSection(content, /technical/i)
    };
  }

  _loadPlan(feature) {
    const planPath = path.join(this.projectDir, '.sdd', 'features', feature, 'plan.md');
    if (!fs.existsSync(planPath)) return { summary: null, currentStep: null, totalSteps: 0, dependencies: [] };

    const content = fs.readFileSync(planPath, 'utf-8');
    const steps = (content.match(/^#+\s+(?:step|task|bước)\s+\d+/gim) || []).length;
    return {
      summary: this._truncate(content, 800),
      currentStep: null, // Sẽ được set bởi orchestrator
      totalSteps: steps || 1,
      dependencies: []
    };
  }

  _formatContextBlock(ctx, agentRole) {
    // Chỉ include thông tin agent CẦN — giảm tokens
    const relevant = {
      project: {
        name: ctx.project.name,
        stack: ctx.project.stack,
        branch: ctx.project.branch
      },
      task: {
        type: ctx.task.type,
        domain: ctx.task.domain,
        files: ctx.task.files
      }
    };

    // Thêm constraints cho mọi agent
    if (ctx.constraints.lockedDecisions.length > 0) {
      relevant.locked_decisions = ctx.constraints.lockedDecisions.map(d => ({
        decision: d.decision,
        by: d.approvedBy,
        scope: d.scope
      }));
    }

    // Thêm spec/plan cho builder
    if (['fe-dev', 'be-dev', 'builder', 'debugger'].includes(agentRole)) {
      if (ctx.spec.summary) relevant.spec = ctx.spec;
      if (ctx.plan.summary) relevant.plan = ctx.plan;
    }

    // Thêm previous results cho chaining
    if (ctx.previousResults.length > 0) {
      relevant.previous = ctx.previousResults;
    }

    return JSON.stringify(relevant, null, 2);
  }

  _getConstraintBlock(ctx) {
    const lines = ['=== CONSTRAINTS (MUST follow) ==='];

    if (ctx.constraints.constitution) {
      lines.push(`[Constitution]: ${this._truncate(ctx.constraints.constitution, 300)}`);
    }

    for (const rule of ctx.constraints.forbidden) {
      lines.push(`[FORBIDDEN]: ${rule}`);
    }

    for (const lock of ctx.constraints.lockedDecisions) {
      lines.push(`[LOCKED by ${lock.approvedBy}]: ${lock.decision} (scope: ${lock.scope})`);
    }

    lines.push('=== END CONSTRAINTS ===');
    return lines.join('\n');
  }

  // Quy tắc escalation — inject vào MỌI agent prompt
  _getEscalationRules(agentRole) {
    if (agentRole === 'tech-lead') return ''; // Tech Lead không escalate lên ai

    return `
=== ESCALATION RULES ===
Bạn PHẢI yêu cầu escalation lên Tech Lead khi:
1. Phân tích > 3 phút mà chưa tìm ra giải pháp rõ ràng
2. Cần thay đổi API contract hoặc database schema
3. Bug liên quan > 3 files và không rõ root cause
4. Conflict với locked decision — KHÔNG tự override
5. Cần thay đổi kiến trúc (thêm module, đổi pattern)
6. Không chắc chắn về security implications

Cách escalation: Trả về JSON có "escalation" field:
{
  "escalation": {
    "reason": "Lý do cần Tech Lead",
    "context": "Đã thử gì, kết quả ra sao",
    "suggestion": "Hướng bạn nghĩ có thể đúng (nếu có)",
    "severity": "high|medium"
  }
}
=== END ESCALATION ===`;
  }

  _getDefaultTemplate(agentRole) {
    // Load từ prompts/ directory nếu có, fallback về inline
    const templatePath = path.join(__dirname, '..', 'prompts', `${agentRole}.md`);
    if (fs.existsSync(templatePath)) {
      return fs.readFileSync(templatePath, 'utf-8');
    }

    // Fallback templates
    const templates = {
      'tech-lead': 'Bạn là Tech Lead (Claude). Review plan, approve/reject decisions, handle escalation từ dev agents.',
      'fe-dev': 'Bạn là Frontend Developer. Implement UI/UX code: React, Next.js, Vue, CSS, Tailwind.',
      'be-dev': 'Bạn là Backend Developer. Implement API, services, database: NestJS, Express, TypeORM.',
      'reviewer': 'Bạn là QC Engineer. Review code: security (OWASP), performance, logic, conventions.',
      'debugger': 'Bạn là Debug Specialist. Reproduce → isolate → fix với minimal impact.',
      'builder': 'Bạn là Full-Stack Developer. Implement theo spec và plan.'
    };
    return templates[agentRole] || 'Bạn là AI assistant. Làm chính xác nhiệm vụ được giao.';
  }

  // Tách code blocks từ output
  _extractCodeBlocks(text) {
    const blocks = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      blocks.push({ language: match[1] || 'text', code: match[2].trim() });
    }
    return blocks;
  }

  // Tách decisions từ output — tìm patterns như "Quyết định:", "Decision:", "→"
  _extractDecisions(text) {
    const decisions = [];
    const lines = text.split('\n');
    for (const line of lines) {
      if (/^(?:[-*]?\s*)?(?:quyết định|decision|→|chọn|selected|approach)[:：]/i.test(line.trim())) {
        decisions.push(line.trim().replace(/^[-*]\s*/, ''));
      }
    }
    return decisions;
  }

  // Tách summary — bỏ code blocks, lấy text chính
  _extractSummary(text) {
    const withoutCode = text.replace(/```[\s\S]*?```/g, '[code]');
    const lines = withoutCode.split('\n').filter(l => l.trim().length > 0);
    return lines.slice(0, 10).join('\n'); // Tối đa 10 dòng summary
  }

  // Detect xem agent có yêu cầu escalation không
  _detectEscalation(text) {
    // Tìm JSON escalation block
    try {
      const match = text.match(/"escalation"\s*:\s*\{[\s\S]*?\}/);
      if (match) return true;
    } catch { /* ignore */ }

    // Tìm keywords escalation
    const lower = text.toLowerCase();
    return /\b(escalat|cần tech lead|không thể tự quyết|vượt scope|cần review kiến trúc)\b/.test(lower);
  }

  // Trích conventions từ CLAUDE.md
  _extractConventions(content) {
    const conventions = [];
    const lines = content.split('\n');
    for (const line of lines) {
      if (/^[-*]\s+/.test(line) && line.length < 150) {
        conventions.push(line.replace(/^[-*]\s+/, '').trim());
      }
    }
    return conventions.slice(0, 20); // Tối đa 20 rules
  }

  _extractListItems(content, sectionRegex) {
    const lines = content.split('\n');
    const items = [];
    let inSection = false;
    for (const line of lines) {
      if (sectionRegex.test(line)) { inSection = true; continue; }
      if (inSection && /^#+\s/.test(line)) break; // section mới
      if (inSection && /^[-*]\s+/.test(line)) {
        items.push(line.replace(/^[-*]\s+/, '').trim());
      }
    }
    return items;
  }

  _extractSection(content, sectionRegex) {
    const lines = content.split('\n');
    const result = [];
    let inSection = false;
    for (const line of lines) {
      if (sectionRegex.test(line)) { inSection = true; continue; }
      if (inSection && /^#+\s/.test(line)) break;
      if (inSection) result.push(line);
    }
    return result.join('\n').trim() || null;
  }

  _truncate(text, maxLen) {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '... [truncated]';
  }

  _estimateTokens(files) {
    let total = 0;
    for (const file of files) {
      const fullPath = path.isAbsolute(file) ? file : path.join(this.projectDir, file);
      try {
        const stat = fs.statSync(fullPath);
        total += Math.round(stat.size / 4); // ~4 bytes per token
      } catch {
        total += 2000; // default estimate
      }
    }
    return total;
  }
}

module.exports = { ContextManager, detectTaskDomain, detectStack, EMPTY_CONTEXT };
