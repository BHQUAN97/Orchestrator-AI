#!/usr/bin/env node
/**
 * Agent Loop — Vòng lặp tự trị cho Coding Agent
 *
 * Đây là "não" của coding agent — tương tự agentic loop của Claude Code:
 *
 * FLOW:
 * 1. Gửi prompt + tools cho LLM
 * 2. LLM trả về: text (done) HOẶC tool_calls (cần thực thi)
 * 3. Nếu tool_calls → execute → feed results lại cho LLM → quay lại bước 2
 * 4. Nếu tool_call là task_complete → dừng, báo cáo
 * 5. Nếu lỗi → inject error context → retry (tối đa 3 lần)
 * 6. Nếu vượt max iterations → dừng, báo cáo partial
 *
 * SELF-CORRECTION:
 * - Khi execute_command trả exit_code !== 0 → LLM nhận được error log
 * - LLM tự quyết định: sửa code → chạy lại, hay thay đổi approach
 * - Nếu cùng lỗi lặp 3 lần → dừng, escalate
 *
 * TOKEN MANAGEMENT:
 * - Giữ conversation history rolling (tối đa 50 messages)
 * - Tóm tắt tool results dài (> 5000 chars)
 * - Không cache toàn bộ file content trong history
 */

const { getTools } = require('../tools/definitions');
const { ToolExecutor } = require('../tools/executor');
const { TokenManager } = require('./token-manager');
const { AutoVerify } = require('./auto-verify');
const { applyCacheControl, applyToolsCaching, extractCacheStats } = require('./prompt-cache');
const { BudgetTracker } = require('./budget');
const { HookRunner } = require('./hooks');
const { applyThinking, getMessageText } = require('./extended-thinking');
const { MemoryStore, formatMemoryContext } = require('./memory');
const { ContextGuard } = require('./context-guard');
const { HermesBridge } = require('./hermes-bridge');
const { isBatchReadSafe } = require('./parallel-executor');
const { fetchWithRetry } = require('./retry');
const { StuckDetector } = require('./stuck-detector');
const { SelfHealer } = require('./self-healer');
const { RagPromptBuilder } = require('./rag-prompt-builder');

// Mặc định
const MAX_ITERATIONS = 30;          // Tối đa 30 lượt tool call
const MAX_MESSAGES = 80;            // Giữ tối đa 80 messages (TokenManager sẽ trim thông minh)
const MAX_CONSECUTIVE_ERRORS = 3;   // 3 lỗi liên tiếp → dừng

class AgentLoop {
  constructor(options = {}) {
    this.litellmUrl = options.litellmUrl || process.env.LITELLM_URL || 'http://localhost:4001';
    this.litellmKey = options.litellmKey || process.env.LITELLM_KEY || 'sk-master-change-me';
    this.model = options.model || 'smart';
    this.projectDir = options.projectDir || process.cwd();
    this.agentRole = options.agentRole || 'builder';

    // Subagent depth (set by parent when spawning)
    this.subagentDepth = options.subagentDepth || 0;

    // MCP registry (shared across AgentLoop instances)
    this.mcpRegistry = options.mcpRegistry || null;

    // Tool executor — truyen agentRole de phan quyen
    // Note: parentBudget/parentHookRunner pass qua de subagent inherit
    this.executor = new ToolExecutor({
      projectDir: this.projectDir,
      agentRole: this.agentRole,
      readableRoots: options.readableRoots || [],
      onConfirm: options.onConfirm || null,
      onOutput: options.onOutput || null,
      onWriteApproval: options.onWriteApproval || null,
      litellmUrl: this.litellmUrl,
      litellmKey: this.litellmKey,
      subagentDepth: this.subagentDepth,
      mcpRegistry: this.mcpRegistry,
      parentBudget: null, // set sau khi this.budget khoi tao
      parentHookRunner: null,
      interactive: options.interactive !== false, // default true (CLI usually interactive)
      memoryStore: null, // wired sau
      contextGuard: null, // wired sau
      onTodosUpdate: options.onTodosUpdate || null
    });

    // Token manager — quản lý context window
    this.tokenManager = new TokenManager({
      maxTokens: options.maxTokens || 128000,
      reserveTokens: options.reserveTokens || 4096
    });

    // Auto-verify — tự chạy test sau khi edit
    this.autoVerify = new AutoVerify({ projectDir: this.projectDir });
    this._pendingVerify = false;  // Flag: cần verify sau edit

    // Limits
    this.maxIterations = options.maxIterations || MAX_ITERATIONS;
    this.maxMessages = options.maxMessages || MAX_MESSAGES;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors || MAX_CONSECUTIVE_ERRORS;

    // Streaming — hiển thị text real-time khi LLM generate
    this.streaming = options.streaming !== false; // default true

    // Prompt caching — Anthropic cache_control (90% cheaper cached tokens)
    this.promptCaching = options.promptCaching !== false; // default true

    // Cache + cost stats tich luy qua nhieu call
    this.cacheStats = {
      total_prompt_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      total_completion_tokens: 0
    };

    // Budget tracker
    this.budget = options.budget instanceof BudgetTracker
      ? options.budget
      : new BudgetTracker({
          capUsd: options.budgetUsd || Infinity,
          model: this.model
        });

    // Hook runner (Claude Code PreToolUse / PostToolUse / Stop / SessionStart)
    this.hookRunner = options.hookRunner || new HookRunner({
      projectDir: this.projectDir,
      enabled: options.hooks !== false
    });
    this._sessionStarted = false;

    // Wire budget + hooks vao executor de subagent inherit
    // (memoryStore + contextGuard duoc wire sau khi init, o cuoi constructor)
    this.executor.parentBudget = this.budget;
    this.executor.parentHookRunner = this.hookRunner;

    // Streaming max retry
    this.streamMaxRetries = options.streamMaxRetries ?? 1;

    // Extended thinking (Anthropic Claude feature)
    this.thinking = options.thinking === true || process.env.ORCAI_THINKING === '1';
    this.thinkingAuto = options.thinkingAuto !== false; // auto-detect complex prompts
    this.thinkingBudget = options.thinkingBudget || 8000;

    // Transcript logger (optional)
    this.transcriptLogger = options.transcriptLogger || null;

    // Memory store (optional — tich luy kinh nghiem giua session)
    this.memoryStore = options.memoryStore ||
      (options.memory !== false ? new MemoryStore(this.projectDir) : null);

    // Context guard (chong ao giac — enable by default)
    this.contextGuard = options.contextGuard ||
      (options.contextGuardEnabled !== false ? new ContextGuard() : null);

    // Auto-save memory on task_complete (default on)
    this.memoryAutoSave = options.memoryAutoSave !== false;

    // Hermes bridge — SmartRouter + SLMClassifier + DecisionLock
    this.hermesBridge = options.hermesBridge ||
      (options.hermes !== false
        ? new HermesBridge({
            projectDir: this.projectDir,
            litellmUrl: this.litellmUrl,
            litellmKey: this.litellmKey,
            useClassifier: options.useClassifier === true
          })
        : null);

    // Routing authority: HermesBridge (luon chay khi bridge co mat, khong can flag)
    // _hintFiles: files tu RequestAnalyzer.changes[] de SmartRouter score chinh xac
    this.lastRoutingDecision = null;
    this._hintFiles = [];

    // Stuck detector (chong loop)
    this.stuckDetector = options.stuckDetector !== false ? new StuckDetector() : null;

    // Tool result cache — read-safe tool voi cung args se tra cache thay vi re-execute
    // Giam token inflation khi agent "double-check" bang cach goi lai cung tool.
    // Default ON — can disable: options.toolResultCache === false
    this.toolResultCacheEnabled = options.toolResultCache !== false;
    this.toolResultCache = new Map(); // key: "toolName:argsHash" → { result, iteration }
    this.toolCacheStats = { hits: 0, misses: 0, tokensSaved: 0 };

    // Self-healer (tu dong ghi gotcha + de xuat workaround khi loi lap)
    this.selfHealer = options.selfHealer !== false
      ? new SelfHealer({ memoryStore: null, enabled: true }) // memoryStore wire duoi day
      : null;

    // Retry config cho LLM fetch
    this.retries = options.retries ?? 3;

    // Parallel batch execution cho read-safe tools
    this.parallelReadSafe = options.parallelReadSafe !== false;

    // RAG prompt builder — chi active cho local model, lazy init
    this.ragDisabled = process.env.ORCAI_RAG_DISABLE === '1' || options.ragDisabled === true;
    this.ragPromptBuilder = null; // lazy
    this.ragEmbeddings = options.ragEmbeddings || null;   // dep injection cho test
    this.ragContextManager = options.ragContextManager || null;

    // Agent bus (inter-agent messaging — parent ↔ subagent progress)
    this.agentBus = options.agentBus || null;
    this.agentId = options.agentId || null;

    // Capture last user prompt to inform thinking heuristic
    this._lastUserPromptSample = '';

    // Wire memory + context guard + hermes + bus vao executor (sau khi da init)
    this.executor.memoryStore = this.memoryStore;
    this.executor.contextGuard = this.contextGuard;
    this.executor.hermesBridge = this.hermesBridge;
    this.executor.agentBus = this.agentBus;
    this.executor.selfHealer = this.selfHealer;

    // Wire memoryStore vao self-healer de no persist gotchas
    if (this.selfHealer && this.memoryStore) {
      this.selfHealer.memoryStore = this.memoryStore;
    }

    // Callbacks
    this.onThinking = options.onThinking || null;   // AI đang suy nghĩ
    this.onToolCall = options.onToolCall || null;    // Trước khi chạy tool
    this.onToolResult = options.onToolResult || null; // Sau khi chạy tool
    this.onText = options.onText || null;            // AI trả lời text
    this.onComplete = options.onComplete || null;    // Response hoan thanh (flush text buffer)
    this.onError = options.onError || null;          // Lỗi

    // State
    this.messages = [];
    this.iteration = 0;
    this.consecutiveErrors = 0;
    this.completed = false;
    this.aborted = false;

    // Interrupt: goi interrupt() trong khi agent dang chay de huy giua chung
    this._interruptRequested = false;
  }

  /**
   * Yeu cau dung loop ngay sau iteration hien tai.
   * An toan de goi tu SIGINT handler trong khi agent dang chay.
   */
  interrupt() {
    this._interruptRequested = true;
  }

  /**
   * Set file hints tu RequestAnalyzer.changes[] truoc khi goi run()/continueWith().
   * HermesBridge.selectModel() dung danh sach nay de SmartRouter score dung theo file type.
   * @param {string[]} files
   */
  setHintFiles(files) {
    this._hintFiles = Array.isArray(files) ? files : [];
  }

  /**
   * Chạy agentic loop cho 1 task
   *
   * @param {string} systemPrompt - System prompt cho agent
   * @param {string} userPrompt - Yêu cầu từ user
   * @returns {Object} - { success, summary, files_changed, iterations, messages }
   */
  async run(systemPrompt, userPrompt) {
    this.executor.reset();
    this.messages = [];
    this.iteration = 0;
    this.consecutiveErrors = 0;
    this.completed = false;
    this.aborted = false;
    this._interruptRequested = false;
    this.toolResultCache.clear();
    this.toolCacheStats = { hits: 0, misses: 0, tokensSaved: 0 };
    if (this.stuckDetector) this.stuckDetector.reset();
    const _runStart = Date.now();

    // Tools cho agent role + MCP tools neu co
    let tools = getTools(this.agentRole);
    if (this.mcpRegistry) {
      const mcpTools = this.mcpRegistry.getToolDefinitions();
      if (mcpTools.length > 0) tools = tools.concat(mcpTools);
    }

    // Hermes routing — luon chay khi bridge co mat (khong can flag)
    // HermesBridge la routing authority: SmartRouter (heuristic) hoac SLMClassifier (LLM)
    if (this.hermesBridge && userPrompt) {
      try {
        const decision = await this.hermesBridge.selectModel({
          task: this.agentRole,
          prompt: userPrompt,
          files: this._hintFiles  // tu RequestAnalyzer.changes[] — SmartRouter can de score
        });
        if (decision?.model && decision.model !== this.model) {
          const prev = this.model;
          this.model = decision.model;
          this.lastRoutingDecision = decision;
          // onRouting: thong bao model switch (KHONG dung onError — day la info, khong phai loi)
          if (this.onRouting) this.onRouting({ from: prev, to: decision.model, decision });
        } else {
          this.lastRoutingDecision = decision;
        }
      } catch {
        // ignore routing errors — giu model da co
      }
    }

    // Inject relevant memories vao system prompt
    // Uu tien hermesBridge (co local + cross-project) hon raw memoryStore (chi local keyword)
    let enrichedSystem = systemPrompt;
    if (this.hermesBridge && userPrompt) {
      try {
        const mems = await this.hermesBridge.getRelevantMemories(userPrompt, {
          topK: 3, memoryStore: this.memoryStore
        });
        const memBlock = this.hermesBridge.formatMemoriesForPrompt(mems);
        if (memBlock) enrichedSystem = systemPrompt + '\n\n' + memBlock;
      } catch {
        // fallback: raw search neu bridge loi
        if (this.memoryStore) {
          const relevant = this.memoryStore.search(userPrompt, 3);
          if (relevant.length > 0) enrichedSystem = systemPrompt + '\n\n' + formatMemoryContext(relevant);
        }
      }
    } else if (this.memoryStore && userPrompt) {
      const relevant = this.memoryStore.search(userPrompt, 3);
      if (relevant.length > 0) enrichedSystem = systemPrompt + '\n\n' + formatMemoryContext(relevant);
    }

    // Inject active decision locks
    if (this.hermesBridge) {
      const lockBlock = this.hermesBridge.formatLocksForPrompt();
      if (lockBlock) enrichedSystem = enrichedSystem + '\n\n' + lockBlock;
    }

    // Init messages
    this.messages.push({ role: 'system', content: enrichedSystem });
    this.messages.push({ role: 'user', content: userPrompt });
    this._lastUserPromptSample = userPrompt?.slice(0, 500) || '';

    if (this.transcriptLogger) {
      this.transcriptLogger.logMeta({ event: 'run_start', role: this.agentRole, model: this.model });
    }

    // Chạy core loop
    await this._runLoop(tools);

    if (this.transcriptLogger) {
      this.transcriptLogger.logMeta({
        event: 'run_end',
        completed: this.completed,
        aborted: this.aborted,
        iterations: this.iteration,
        reason: this.abortReason || null
      });
    }

    // Auto-save memory on successful completion
    if (this.memoryAutoSave && this.memoryStore && this.completed && !this.aborted) {
      const summary = this._getCompletionSummary();
      if (summary) {
        this.memoryStore.append({
          type: 'lesson',
          prompt_summary: userPrompt.slice(0, 300),
          summary: String(summary).slice(0, 500),
          files_changed: this.executor.filesChanged ? [...this.executor.filesChanged] : [],
          iterations: this.iteration,
          model: this.model
        });
      }
    }

    // === KẾT QUẢ ===
    const stats = this.executor.getStats();

    return {
      success: this.completed && !this.aborted,
      aborted: this.aborted,
      reason: this.aborted
        ? (this.consecutiveErrors >= this.maxConsecutiveErrors
          ? 'too_many_errors'
          : this.iteration >= this.maxIterations
            ? 'max_iterations'
            : 'unknown')
        : 'completed',
      iterations: this.iteration,
      tool_calls: stats.total_calls,
      by_tool: stats.by_tool,
      files_changed: stats.files_changed,
      commands_run: stats.commands_run,
      commands_run_detail: this.executor.commandsRun ? [...this.executor.commandsRun] : [],
      elapsed_ms: stats.total_elapsed_ms,
      wall_elapsed_ms: Date.now() - _runStart,
      errors: stats.errors,
      // Lấy text cuối cùng từ assistant
      final_message: this._getLastAssistantText(),
      // Lấy task_complete summary nếu có
      summary: this._getCompletionSummary()
    };
  }

  /**
   * Tiếp tục loop với message mới từ user (follow-up)
   * Không reset executor — filesChanged tích lũy từ run trước
   */
  async continueWith(userMessage) {
    this.messages.push({ role: 'user', content: userMessage });
    this._lastUserPromptSample = userMessage?.slice(0, 500) || '';
    this.completed = false;
    this.aborted = false;
    this.consecutiveErrors = 0;
    const _runStart = Date.now();

    // Re-route per turn — user follow-up co the khac complexity voi turn truoc
    if (this.hermesBridge && userMessage) {
      try {
        const decision = await this.hermesBridge.selectModel({
          task: this.agentRole,
          prompt: userMessage,
          files: this._hintFiles
        });
        if (decision?.model && decision.model !== this.model) {
          const prev = this.model;
          this.model = decision.model;
          this.lastRoutingDecision = decision;
          if (this.onRouting) this.onRouting({ from: prev, to: decision.model, decision });
        }
      } catch { /* giu model hien tai */ }
    }

    let tools = getTools(this.agentRole);
    if (this.mcpRegistry) {
      const mcpTools = this.mcpRegistry.getToolDefinitions();
      if (mcpTools.length > 0) tools = tools.concat(mcpTools);
    }
    await this._runLoop(tools);

    const stats = this.executor.getStats();
    return {
      success: this.completed && !this.aborted,
      aborted: this.aborted,
      reason: this.aborted
        ? (this.consecutiveErrors >= this.maxConsecutiveErrors ? 'too_many_errors'
          : this.iteration >= this.maxIterations ? 'max_iterations' : 'unknown')
        : 'completed',
      iterations: this.iteration,
      tool_calls: stats.total_calls,
      by_tool: stats.by_tool,
      files_changed: stats.files_changed,
      commands_run: stats.commands_run,
      commands_run_detail: this.executor.commandsRun ? [...this.executor.commandsRun] : [],
      elapsed_ms: stats.total_elapsed_ms,
      wall_elapsed_ms: Date.now() - _runStart,
      errors: stats.errors,
      final_message: this._getLastAssistantText(),
      summary: this._getCompletionSummary()
    };
  }

  // =============================================
  // CORE LOOP — dùng chung cho run() và continueWith()
  // =============================================

  /**
   * Vòng lặp chính — gọi LLM, xử lý tool calls, kiểm tra lỗi
   * Caller đọc this.completed, this.aborted, etc. sau khi kết thúc
   */
  async _runLoop(tools) {
    // SessionStart hook (fire once)
    if (!this._sessionStarted) {
      this._sessionStarted = true;
      try {
        await this.hookRunner.run('SessionStart', { projectDir: this.projectDir });
      } catch { /* don't block on hook failures */ }
    }

    while (this.iteration < this.maxIterations && !this.completed && !this.aborted) {
      // Interrupt check — user Ctrl+C trong khi agent dang chay
      if (this._interruptRequested) {
        this._interruptRequested = false;
        this.aborted = true;
        this.abortReason = 'interrupted';
        if (this.onError) this.onError('Interrupted by user');
        break;
      }

      // Budget check
      if (this.budget.isExceeded()) {
        if (this.onError) this.onError(`Budget exceeded: $${this.budget.spentUsd.toFixed(4)} >= $${this.budget.capUsd}`);
        this.aborted = true;
        this.abortReason = 'budget_exceeded';
        break;
      }

      this.iteration++;

      if (this.onThinking) {
        this.onThinking(this.iteration, this.maxIterations);
      }

      // Emit progress qua agent bus (cho parent quan sat subagent)
      if (this.agentBus && this.agentId) {
        this.agentBus.emit('progress', {
          agentId: this.agentId,
          iteration: this.iteration,
          maxIterations: this.maxIterations
        });
      }

      // Self-healer suggestion — inject system reminder neu co loi lap
      if (this._pendingHealerSuggestion) {
        this.messages.push({
          role: 'user',
          content: `[Self-healer] ${this._pendingHealerSuggestion.message}`
        });
        this._pendingHealerSuggestion = null;
      }

      // Gọi LLM (streaming hoặc non-streaming tùy config)
      let response;
      try {
        response = this.streaming
          ? await this._callLLMStreaming(tools)
          : await this._callLLM(tools);
      } catch (e) {
        if (this.onError) this.onError(`LLM call failed: ${e.message}`);
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          this.aborted = true;
          break;
        }
        // Retry: thêm error context
        this.messages.push({
          role: 'user',
          content: `[System] LLM call failed: ${e.message}. Hãy thử lại.`
        });
        continue;
      }

      const message = response.choices?.[0]?.message;
      if (!message) {
        this.aborted = true;
        break;
      }

      // Lưu assistant message vào history
      this.messages.push(message);

      if (this.transcriptLogger) {
        this.transcriptLogger.logMessage(message);
      }

      // Check: có tool_calls không?
      const toolCalls = message.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // LLM trả text thuần → done hoặc cần clarification
        // Nếu non-streaming thì gọi onText (streaming đã gọi real-time rồi)
        if (!this.streaming && this.onText) this.onText(message.content || '');
        // Nếu không có tool call → loop kết thúc
        this.completed = true;
        break;
      }

      // === EXECUTE TOOL CALLS ===
      await this._executeToolBatch(toolCalls);

      // User abort qua diff approval?
      if (this.executor.userAborted) {
        this.aborted = true;
        this.abortReason = 'user_aborted';
        break;
      }

      // Task complete?
      if (this.completed) break;

      // Quá nhiều lỗi liên tiếp?
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        if (this.onError) {
          this.onError(`${this.maxConsecutiveErrors} lỗi liên tiếp — dừng để tránh loop vô hạn`);
        }
        this.aborted = true;
        break;
      }

      // Auto-verify: nếu vừa edit file → inject verify prompt
      this._injectAutoVerify(toolCalls);

      // Trim messages nếu quá dài (dùng TokenManager)
      this._trimMessages();
    }

    // Flush text buffer (markdown render) truoc khi ket thuc
    if (this.onComplete) this.onComplete();

    // Stop hook — sau khi loop ket thuc (completed/aborted)
    try {
      await this.hookRunner.run('Stop', {
        projectDir: this.projectDir,
        completed: this.completed,
        aborted: this.aborted,
        iterations: this.iteration
      });
    } catch { /* ignore */ }
  }

  /**
   * Thực thi batch tool calls và đếm lỗi PER ITERATION
   * Nếu TẤT CẢ tool calls fail → tăng consecutiveErrors
   * Nếu CÓ ÍT NHẤT 1 thành công → reset consecutiveErrors
   */
  async _executeToolBatch(toolCalls) {
    // Parallel path: neu toan bo batch la read-safe → chay Promise.all
    if (this.parallelReadSafe && isBatchReadSafe(toolCalls)) {
      return this._executeToolBatchParallel(toolCalls);
    }
    return this._executeToolBatchSerial(toolCalls);
  }

  async _executeToolBatchSerial(toolCalls) {
    let batchFailCount = 0;
    let batchSuccessCount = 0;

    for (const tc of toolCalls) {
      const result = await this._executeSingleToolCall(tc);
      this.messages.push(result);

      if (tc.function?.name === 'task_complete') this.completed = true;
      if (this.executor.userAborted) break;

      const parsed = safeParse(result.content);
      if (parsed && parsed.success === false) batchFailCount++;
      else batchSuccessCount++;
    }

    if (batchSuccessCount > 0) this.consecutiveErrors = 0;
    else if (batchFailCount > 0) this.consecutiveErrors++;
  }

  async _executeToolBatchParallel(toolCalls) {
    // Chay Promise.all cho cac read-safe tool
    const settled = await Promise.allSettled(
      toolCalls.map(tc => this._executeSingleToolCall(tc))
    );

    let batchFailCount = 0;
    let batchSuccessCount = 0;

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const tc = toolCalls[i];
      let result;
      if (s.status === 'fulfilled') {
        result = s.value;
      } else {
        result = {
          tool_call_id: tc.id,
          role: 'tool',
          content: JSON.stringify({ success: false, error: `Parallel exec error: ${s.reason?.message || s.reason}` })
        };
      }
      this.messages.push(result);

      const parsed = safeParse(result.content);
      if (parsed && parsed.success === false) batchFailCount++;
      else batchSuccessCount++;
    }

    if (batchSuccessCount > 0) this.consecutiveErrors = 0;
    else if (batchFailCount > 0) this.consecutiveErrors++;
  }

  async _executeSingleToolCall(tc) {
    const toolName = tc.function?.name;
    let args;
    try { args = JSON.parse(tc.function.arguments); } catch { args = tc.function.arguments; }

    // Notify
    if (this.onToolCall) this.onToolCall(toolName, args);
    if (this.transcriptLogger) this.transcriptLogger.logToolCall(toolName, args);

    // Tool result cache check — tra cache cho read-safe tool co cung args
    const cacheKey = _cacheKey(toolName, args);
    if (this.toolResultCacheEnabled && cacheKey && this.toolResultCache.has(cacheKey)) {
      const cached = this.toolResultCache.get(cacheKey);
      this.toolCacheStats.hits++;
      this.toolCacheStats.tokensSaved += Math.ceil((cached.result.content?.length || 0) / 4);
      // Tra ban cache kem note de agent biet (khong phai re-execute)
      const cachedResult = {
        tool_call_id: tc.id,
        role: 'tool',
        content: _wrapCachedContent(cached.result.content, cached.iteration)
      };
      if (this.onToolResult) this.onToolResult(toolName, cachedResult);
      if (this.transcriptLogger) this.transcriptLogger.logToolResult(toolName, cachedResult);
      // Stuck detector van track cache hit (goi cung args nhieu lan = potentially stuck)
      if (this.stuckDetector) {
        const stuck = this.stuckDetector.record(toolName, args);
        if (stuck) {
          this.messages.push({ role: 'user', content: `[System reminder] ${stuck.message}` });
          this.stuckDetector.reset();
        }
      }
      return cachedResult;
    }

    // Stuck detector — check TRUOC khi execute de warn early
    let stuckWarning = null;
    if (this.stuckDetector) {
      stuckWarning = this.stuckDetector.record(toolName, args);
    }

    // PreToolUse hook — block if hook exits non-zero
    let preHookRes;
    try {
      preHookRes = await this.hookRunner.run('PreToolUse', { toolName, args, projectDir: this.projectDir });
    } catch { preHookRes = { blocked: false }; }

    let result;
    if (preHookRes.blocked) {
      result = {
        tool_call_id: tc.id,
        role: 'tool',
        content: JSON.stringify({
          success: false,
          error: `BLOCKED by PreToolUse hook: ${preHookRes.reason || 'hook exit !=0'}`
        })
      };
    } else {
      result = await this.executor.execute(tc);

      // PostToolUse hook (non-blocking)
      try {
        await this.hookRunner.run('PostToolUse', {
          toolName, args,
          result: safeParse(result.content),
          projectDir: this.projectDir
        });
      } catch { /* ignore */ }
    }

    if (this.onToolResult) this.onToolResult(toolName, result);
    if (this.transcriptLogger) this.transcriptLogger.logToolResult(toolName, result);

    // Tool result cache store — chi cache cho read-safe tool voi result hop le
    if (this.toolResultCacheEnabled && cacheKey) {
      const parsed = safeParse(result.content);
      if (parsed && parsed.success !== false) {
        this.toolResultCache.set(cacheKey, { result, iteration: this.iteration });
        // Bound cache size de tranh memory leak trong long session
        if (this.toolResultCache.size > 50) {
          const firstKey = this.toolResultCache.keys().next().value;
          this.toolResultCache.delete(firstKey);
        }
      }
      this.toolCacheStats.misses++;
    }

    // Feed stuck-detector post-exec result de track searchedPaths
    if (this.stuckDetector) {
      this.stuckDetector.recordResult(toolName, args, result);
    }

    // Inject stuck warning (da detect TRUOC execute nhung push sau result de giu thu tu)
    if (stuckWarning) {
      this.messages.push({ role: 'user', content: `[System reminder] ${stuckWarning.message}` });
      this.stuckDetector.reset();
    }

    // Self-healer observe — detect repeated failures, auto-save gotchas
    if (this.selfHealer) {
      try {
        const suggestion = this.selfHealer.observe(toolName, args, result);
        if (suggestion) {
          // Inject suggestion as system reminder at next iteration
          this._pendingHealerSuggestion = suggestion;
        }
      } catch { /* silent */ }
    }

    return result;
  }

  // =============================================
  // RAG — enrich system prompt cho local model
  // =============================================

  /**
   * Lazy-init RagPromptBuilder — chi tao khi goi local lan dau
   */
  _getRagBuilder() {
    if (this.ragDisabled) return null;
    if (this.ragPromptBuilder) return this.ragPromptBuilder;
    try {
      // Lazy requires de tranh circular hoac overhead khi cloud-only run
      const embeddings = this.ragEmbeddings || this._lazyLoadEmbeddings();
      const contextManager = this.ragContextManager || this._lazyLoadContextManager();
      this.ragPromptBuilder = new RagPromptBuilder({
        projectDir: this.projectDir,
        embeddings,
        contextManager
      });
    } catch (e) {
      if (this.onError) this.onError(`[rag] init failed: ${e.message}`);
      this.ragDisabled = true;
      return null;
    }
    return this.ragPromptBuilder;
  }

  _lazyLoadEmbeddings() {
    try {
      const { EmbeddingStore } = require('./embeddings');
      return new EmbeddingStore({ projectDir: this.projectDir });
    } catch { return null; }
  }

  _lazyLoadContextManager() {
    try {
      const { ContextManager } = require('../router/context-manager');
      return new ContextManager({ projectDir: this.projectDir });
    } catch { return null; }
  }

  /**
   * Apply RAG neu model local HOAC agent role la "thinking stage" (scanner/planner/...)
   * KHONG modify this.messages — tra ve copy moi voi system message duoc enrich.
   * Giu nguyen this.messages de Anthropic prompt cache luon hit (stable prefix).
   *
   * @param {Array} messages - message array hien tai (khong bi modify)
   * @returns {Array} new messages array (copy, system msg co the duoc enrich)
   */
  async _applyRagIfNeeded(messages) {
    if (this.ragDisabled) return messages;
    const builder = this._getRagBuilder();
    if (!builder) return messages;

    // Gate check: local model OR stage role → apply RAG
    const decision = builder.shouldApplyRag({ modelId: this.model, agentRole: this.agentRole });
    if (!decision.apply) {
      builder.metrics.rag_skipped_cloud++;
      return messages;
    }

    const sysIdx = messages.findIndex(m => m.role === 'system');
    if (sysIdx === -1) return messages;

    // Lay noi dung goc tu messages (luon la bản gốc vì ta không mutate nữa)
    const sysContent = messages[sysIdx].content;
    const basePrompt = typeof sysContent === 'string'
      ? sysContent
      : (Array.isArray(sysContent) ? sysContent.map(b => b.text || '').join('') : '');

    try {
      const enriched = await builder.build({
        basePrompt,
        userMessage: this._lastUserPromptSample || '',
        modelId: this.model,
        agentRole: this.agentRole
      });
      const out = [...messages];
      out[sysIdx] = { ...messages[sysIdx], content: enriched };
      return out;
    } catch (e) {
      if (this.onError) this.onError(`[rag] build failed: ${e.message}`);
      return messages;
    }
  }

  // Backwards-compat alias
  _applyRagIfLocal() { return this._applyRagIfNeeded(this.messages); }

  /**
   * Lay metrics cho caller — dashboard / CLI debugging
   */
  getRagMetrics() {
    if (!this.ragPromptBuilder) {
      return {
        rag_applied: 0,
        rag_applied_local: 0,
        rag_applied_stage: 0,
        rag_skipped_cloud: 0,
        rag_fallback_profile_only: 0,
        rag_fallback_none: 0,
        enabled: !this.ragDisabled,
        initialized: false
      };
    }
    return {
      ...this.ragPromptBuilder.getMetrics(),
      enabled: !this.ragDisabled,
      initialized: true
    };
  }

  // =============================================
  // LLM CALL
  // =============================================

  async _callLLM(tools) {
    const messagesForCall = await this._applyRagIfNeeded(this.messages); // non-mutating copy
    // Apply Anthropic prompt caching (LiteLLM forwards cache_control to provider)
    const cacheOpts = { model: this.model, enabled: this.promptCaching };
    const cachedMessages = applyCacheControl(messagesForCall, cacheOpts);
    const cachedTools = applyToolsCaching(tools, cacheOpts);

    let body = {
      model: this.model,
      messages: cachedMessages,
      tools: cachedTools,
      tool_choice: 'auto',
      max_tokens: parseInt(process.env.ORCAI_MAX_OUTPUT_TOKENS, 10) || 4096,
      temperature: 0.2
    };

    // Extended thinking (Claude only)
    body = applyThinking(body, {
      model: this.model,
      budget: this.thinkingBudget,
      forceEnable: this.thinking,
      autoDetect: this.thinkingAuto,
      userPromptSample: this._lastUserPromptSample
    });

    let response;
    try {
      response = await fetchWithRetry(
        () => fetch(`${this.litellmUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.litellmKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }),
        {
          retries: this.retries,
          onRetry: (attempt, delay, reason) => {
            if (this.onError) this.onError(`LLM retry ${attempt}/${this.retries} after ${delay}ms (${reason})`);
          }
        }
      );
    } catch (e) {
      throw new Error(_formatNetworkError(e, this.litellmUrl));
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      throw new Error(`LiteLLM response not JSON (HTTP ${response.status}): ${e.message}`);
    }

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    this._updateCacheStats(data);
    return data;
  }

  /**
   * Accumulate cache hit/miss tokens across calls + track cost
   */
  _updateCacheStats(response) {
    const stats = extractCacheStats(response);
    if (!stats) return;
    this.cacheStats.total_prompt_tokens += stats.prompt_tokens || 0;
    this.cacheStats.total_cache_creation_tokens += stats.cache_creation_input_tokens || 0;
    this.cacheStats.total_cache_read_tokens += stats.cache_read_input_tokens || 0;
    this.cacheStats.total_completion_tokens += stats.completion_tokens || 0;

    // Cap nhat budget tracker (bao gom cache_creation + cache_read vao cost)
    this.budget.record(this.model, {
      prompt_tokens: stats.prompt_tokens,
      cache_creation_input_tokens: stats.cache_creation_input_tokens,
      cache_read_input_tokens: stats.cache_read_input_tokens,
      completion_tokens: stats.completion_tokens
    });
  }

  /**
   * Lay cache statistics (cho CLI hien /tokens)
   * Bugfix: total_input = prompt + cache_creation + cache_read (truoc day thieu cache_creation)
   */
  getCacheStats() {
    const s = this.cacheStats;
    const totalInput = s.total_prompt_tokens + s.total_cache_creation_tokens + s.total_cache_read_tokens;
    const hitRate = totalInput > 0 ? (s.total_cache_read_tokens / totalInput * 100).toFixed(1) : 0;
    return {
      ...s,
      cache_hit_rate_pct: Number(hitRate),
      total_input_tokens: totalInput,
      cost: this.budget.getStats()
    };
  }

  /**
   * Gọi LLM với streaming — text hiển thị real-time, tool_calls tích lũy từ delta chunks
   *
   * SSE format từ LiteLLM/OpenAI:
   * - data: {"choices":[{"delta":{"content":"text"}}]}    → text chunk
   * - data: {"choices":[{"delta":{"tool_calls":[...]}}]}  → tool call delta
   * - data: [DONE]                                         → kết thúc stream
   *
   * @param {Array} tools - Tool definitions
   * @returns {Object} - Same format as _callLLM: { choices: [{ message: {...} }] }
   */
  async _callLLMStreaming(tools) {
    const messagesForCall = await this._applyRagIfNeeded(this.messages); // non-mutating copy
    // Apply Anthropic prompt caching
    const cacheOpts = { model: this.model, enabled: this.promptCaching };
    const cachedMessages = applyCacheControl(messagesForCall, cacheOpts);
    const cachedTools = applyToolsCaching(tools, cacheOpts);

    let body = {
      model: this.model,
      messages: cachedMessages,
      tools: cachedTools,
      tool_choice: 'auto',
      max_tokens: parseInt(process.env.ORCAI_MAX_OUTPUT_TOKENS, 10) || 4096,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true } // request usage trong stream cuoi
    };

    // Extended thinking (Claude only)
    body = applyThinking(body, {
      model: this.model,
      budget: this.thinkingBudget,
      forceEnable: this.thinking,
      autoDetect: this.thinkingAuto,
      userPromptSample: this._lastUserPromptSample
    });

    let response;
    try {
      response = await fetchWithRetry(
        () => fetch(`${this.litellmUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.litellmKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }),
        {
          retries: this.retries,
          onRetry: (attempt, delay, reason) => {
            if (this.onError) this.onError(`Stream retry ${attempt}/${this.retries} after ${delay}ms (${reason})`);
          }
        }
      );
    } catch (e) {
      // Network error sau khi retries → fallback sang non-streaming
      return this._callLLM(tools);
    }

    // Nếu server không hỗ trợ streaming (trả JSON thường) → fallback
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') && !contentType.includes('text/plain')) {
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data;
    }

    // === Parse SSE stream ===
    // Tích lũy content và tool_calls từ các delta chunks
    let fullContent = '';
    const toolCallsMap = new Map(); // index → { id, type, function: { name, arguments } }
    let finishReason = null;
    let streamUsage = null; // Anthropic/OpenAI usage trong chunk cuoi

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ''; // Buffer cho incomplete lines

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split thành lines, giữ lại line cuối nếu chưa complete
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // skip empty lines & comments

          if (trimmed === 'data: [DONE]') {
            continue; // Stream kết thúc
          }

          if (!trimmed.startsWith('data: ')) continue;

          // Parse JSON chunk
          let chunk;
          try {
            chunk = JSON.parse(trimmed.slice(6));
          } catch {
            continue; // Skip malformed chunks
          }

          // Capture usage (may appear in trailing chunk with empty choices)
          if (chunk.usage) {
            streamUsage = chunk.usage;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) {
            // Check finish_reason ở chunk cuối
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            continue;
          }

          // Tích lũy finish_reason
          if (chunk.choices[0].finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }

          // Text content → hiển thị real-time
          if (delta.content) {
            fullContent += delta.content;
            if (this.onText) this.onText(delta.content);
          }

          // Tool calls → tích lũy từng phần (name, arguments đến theo chunks)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;

              if (!toolCallsMap.has(idx)) {
                // Tool call mới — khởi tạo
                toolCallsMap.set(idx, {
                  id: tc.id || '',
                  type: 'function',
                  function: { name: '', arguments: '' }
                });
              }

              const existing = toolCallsMap.get(idx);

              // Cập nhật id nếu có (chỉ đến ở chunk đầu)
              if (tc.id) existing.id = tc.id;

              // Tích lũy function name (thường đến 1 lần)
              if (tc.function?.name) {
                existing.function.name += tc.function.name;
              }

              // Tích lũy function arguments (đến từng mảnh JSON)
              if (tc.function?.arguments) {
                existing.function.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    } catch (e) {
      // Mid-stream failure — 2 strategies:
      // 1. Neu da nhan du tool_calls voi arguments hop le → dung ket qua partial
      // 2. Neu partial/malformed → retry streaming (default 1 lan), cuoi cung fallback non-stream
      const partialValid = toolCallsMap.size > 0 && [...toolCallsMap.values()].every(tc => {
        if (!tc.function?.name) return false;
        if (!tc.function.arguments) return true; // empty is valid (no-arg tool)
        try { JSON.parse(tc.function.arguments); return true; } catch { return false; }
      });

      if (partialValid) {
        // Ket qua streaming du dung — fall through
      } else if ((this._streamRetries || 0) < this.streamMaxRetries) {
        this._streamRetries = (this._streamRetries || 0) + 1;
        if (this.onError) this.onError(`Stream interrupted (${e.message}), retrying...`);
        try {
          return await this._callLLMStreaming(tools);
        } finally {
          this._streamRetries = 0;
        }
      } else {
        this._streamRetries = 0;
        // Last resort: fall back to non-streaming
        if (this.onError) this.onError(`Stream failed after retries, falling back to non-stream: ${e.message}`);
        return this._callLLM(tools);
      }
    }

    // === Xây dựng response object cùng format với _callLLM ===
    const toolCalls = toolCallsMap.size > 0
      ? Array.from(toolCallsMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => tc)
      : undefined;

    const message = {
      role: 'assistant',
      content: fullContent || null,
      ...(toolCalls ? { tool_calls: toolCalls } : {})
    };

    const result = {
      choices: [{ message, finish_reason: finishReason || 'stop' }],
      ...(streamUsage ? { usage: streamUsage } : {})
    };

    // Track cache stats if usage was included in stream
    if (streamUsage) this._updateCacheStats(result);

    return result;
  }

  // =============================================
  // MESSAGE MANAGEMENT
  // =============================================

  /**
   * Trim messages dùng TokenManager — thông minh hơn cắt thô
   * Trigger som hon (50% thay vi 70%) de giam token inflation cho task don gian.
   */
  _trimMessages() {
    const usage = this.tokenManager.getUsage(this.messages);

    // Trim nếu quá 50% context window hoặc quá maxMessages
    if (usage.usage_percent < 50 && this.messages.length <= this.maxMessages) return;

    const budget = Math.floor(this.tokenManager.maxTokens * 0.4);
    this.messages = this.tokenManager.trimMessages(this.messages, budget);
  }

  /**
   * Thong ke tool result cache — cho CLI hien va benchmark
   */
  getToolCacheStats() {
    return { ...this.toolCacheStats, size: this.toolResultCache.size };
  }

  /**
   * Auto-verify: nếu vừa edit/write file → inject prompt nhắc chạy test
   * Chỉ inject 1 lần sau mỗi batch edits, không spam
   */
  _injectAutoVerify(toolCalls) {
    if (!toolCalls) return;

    const hasEdit = toolCalls.some(tc => {
      const name = tc.function?.name;
      return this.autoVerify.shouldVerify(name);
    });

    if (hasEdit && !this._pendingVerify) {
      this._pendingVerify = true;
      const filesChanged = [...this.executor.filesChanged];
      const verifyPrompt = this.autoVerify.getVerifyPrompt(filesChanged);
      if (verifyPrompt) {
        this.messages.push({
          role: 'user',
          content: `[System Auto-Verify] ${verifyPrompt}`
        });
      }
    }

    // Reset flag sau khi agent chạy execute_command (đã verify)
    const hasExec = toolCalls.some(tc => tc.function?.name === 'execute_command');
    if (hasExec) {
      this._pendingVerify = false;
    }
  }

  /**
   * Lấy text cuối cùng từ assistant
   */
  _getLastAssistantText() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant' && this.messages[i].content) {
        // Support content blocks from extended thinking
        return getMessageText(this.messages[i]) || null;
      }
    }
    return null;
  }

  /**
   * Lấy summary từ task_complete call
   */
  _getCompletionSummary() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === 'tool') {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed.completed) return parsed.summary;
        } catch { /* ignore */ }
      }
    }
    return null;
  }
}

function safeParse(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// Read-safe tools — cache-able vi deterministic trong cung 1 session
const CACHEABLE_TOOLS = new Set([
  'read_file', 'list_files', 'search_files', 'glob',
  'ast_parse', 'ast_find_symbol', 'ast_find_usages'
]);

function _cacheKey(toolName, args) {
  if (!CACHEABLE_TOOLS.has(toolName)) return null;
  let argsStr = '';
  try { argsStr = typeof args === 'string' ? args : JSON.stringify(args); } catch { return null; }
  return `${toolName}:${argsStr}`;
}

function _wrapCachedContent(content, sourceIteration) {
  const header = `[cached from iteration ${sourceIteration} — content unchanged]\n`;
  if (typeof content === 'string') return header + content;
  return content;
}

/**
 * Format network error voi hint cu the (LiteLLM down, DNS, firewall...)
 */
function _formatNetworkError(err, url) {
  const msg = err.message || String(err);
  const causeCode = err.cause?.code || err.code || '';
  if (causeCode === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
    return `LiteLLM khong chay tai ${url}. Kiem tra: "docker compose ps" hoac khoi dong "docker compose up -d litellm"`;
  }
  if (causeCode === 'ENOTFOUND' || /ENOTFOUND/.test(msg)) {
    return `Khong resolve duoc host ${url}. Check DNS / --url config / VPN.`;
  }
  if (causeCode === 'ETIMEDOUT' || /ETIMEDOUT|timeout/i.test(msg)) {
    return `Timeout khi goi ${url}. Server co the dang qua tai hoac LITELLM_TIMEOUT_MS qua thap.`;
  }
  if (/fetch failed/i.test(msg)) {
    return `Network error goi ${url}: ${msg}. Kiem tra: service chay chua, URL dung chua, firewall/VPN.`;
  }
  return `LLM call failed: ${msg}`;
}

module.exports = { AgentLoop };
