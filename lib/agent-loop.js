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
      parentHookRunner: null
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
    this.executor.parentBudget = this.budget;
    this.executor.parentHookRunner = this.hookRunner;

    // Streaming max retry
    this.streamMaxRetries = options.streamMaxRetries ?? 1;

    // Callbacks
    this.onThinking = options.onThinking || null;   // AI đang suy nghĩ
    this.onToolCall = options.onToolCall || null;    // Trước khi chạy tool
    this.onToolResult = options.onToolResult || null; // Sau khi chạy tool
    this.onText = options.onText || null;            // AI trả lời text
    this.onError = options.onError || null;          // Lỗi

    // State
    this.messages = [];
    this.iteration = 0;
    this.consecutiveErrors = 0;
    this.completed = false;
    this.aborted = false;
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

    // Tools cho agent role + MCP tools neu co
    let tools = getTools(this.agentRole);
    if (this.mcpRegistry) {
      const mcpTools = this.mcpRegistry.getToolDefinitions();
      if (mcpTools.length > 0) tools = tools.concat(mcpTools);
    }

    // Init messages
    this.messages.push({ role: 'system', content: systemPrompt });
    this.messages.push({ role: 'user', content: userPrompt });

    // Chạy core loop
    await this._runLoop(tools);

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
      files_changed: stats.files_changed,
      commands_run: stats.commands_run,
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
    this.completed = false;
    this.aborted = false;
    this.consecutiveErrors = 0;

    let tools = getTools(this.agentRole);
    if (this.mcpRegistry) {
      const mcpTools = this.mcpRegistry.getToolDefinitions();
      if (mcpTools.length > 0) tools = tools.concat(mcpTools);
    }
    await this._runLoop(tools);

    const stats = this.executor.getStats();
    return {
      success: this.completed && !this.aborted,
      iterations: this.iteration,
      files_changed: stats.files_changed,
      final_message: this._getLastAssistantText()
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
    let batchFailCount = 0;
    let batchSuccessCount = 0;

    for (const tc of toolCalls) {
      const toolName = tc.function?.name;
      let args;
      try { args = JSON.parse(tc.function.arguments); } catch { args = tc.function.arguments; }

      // Notify
      if (this.onToolCall) this.onToolCall(toolName, args);

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
        // Execute
        result = await this.executor.execute(tc);

        // PostToolUse hook (non-blocking, just informational)
        try {
          await this.hookRunner.run('PostToolUse', {
            toolName, args,
            result: safeParse(result.content),
            projectDir: this.projectDir
          });
        } catch { /* ignore */ }
      }

      // Notify
      if (this.onToolResult) this.onToolResult(toolName, result);

      // Thêm result vào messages
      this.messages.push(result);

      // Check task_complete
      if (toolName === 'task_complete') this.completed = true;

      // Đếm success/fail trong batch
      const parsed = safeParse(result.content);
      if (parsed && parsed.success === false) {
        batchFailCount++;
      } else {
        batchSuccessCount++;
      }
    }

    // Đếm lỗi PER ITERATION: chỉ tăng nếu TẤT CẢ fail
    if (batchSuccessCount > 0) {
      this.consecutiveErrors = 0;
    } else if (batchFailCount > 0) {
      this.consecutiveErrors++;
    }
  }

  // =============================================
  // LLM CALL
  // =============================================

  async _callLLM(tools) {
    // Apply Anthropic prompt caching (LiteLLM forwards cache_control to provider)
    const cacheOpts = { model: this.model, enabled: this.promptCaching };
    const cachedMessages = applyCacheControl(this.messages, cacheOpts);
    const cachedTools = applyToolsCaching(tools, cacheOpts);

    const body = {
      model: this.model,
      messages: cachedMessages,
      tools: cachedTools,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.2
    };

    let response;
    try {
      response = await fetch(`${this.litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.litellmKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
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
    // Apply Anthropic prompt caching
    const cacheOpts = { model: this.model, enabled: this.promptCaching };
    const cachedMessages = applyCacheControl(this.messages, cacheOpts);
    const cachedTools = applyToolsCaching(tools, cacheOpts);

    const body = {
      model: this.model,
      messages: cachedMessages,
      tools: cachedTools,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true } // request usage trong stream cuoi
    };

    let response;
    try {
      response = await fetch(`${this.litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.litellmKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      // Network error → fallback sang non-streaming
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
   */
  _trimMessages() {
    const usage = this.tokenManager.getUsage(this.messages);

    // Trim nếu quá 70% context window hoặc quá maxMessages
    if (usage.usage_percent < 70 && this.messages.length <= this.maxMessages) return;

    const budget = Math.floor(this.tokenManager.maxTokens * 0.6);
    this.messages = this.tokenManager.trimMessages(this.messages, budget);
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
        return this.messages[i].content;
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
