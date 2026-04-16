#!/usr/bin/env node
/**
 * Token Manager — Quản lý token budget cho agent conversation
 *
 * Agent loop gửi messages (system + user + assistant + tool results) cho LLM.
 * Tool results có thể rất lớn (file contents, command output).
 * Module này giữ message array trong giới hạn token của model.
 *
 * STRATEGY:
 * - Luôn giữ: system prompt (messages[0]) + original user prompt (messages[1])
 * - 60% messages gần nhất: giữ nguyên
 * - 40% messages cũ: tóm tắt tool results, collapse consecutive tool results
 * - read_file content cũ → chỉ giữ metadata "read X lines from path"
 *
 * STATELESS: Không lưu state — chỉ là utility functions trên messages array
 */

// Heuristic: ~4 ký tự = 1 token (trung bình cho tiếng Anh + code)
const CHARS_PER_TOKEN = 4;

class TokenManager {
  /**
   * @param {Object} options
   * @param {number} options.maxTokens - Context window của model (default 128k)
   * @param {number} options.reserveTokens - Dành cho response (default 4096)
   */
  constructor(options = {}) {
    this.maxTokens = options.maxTokens || 128000;
    this.reserveTokens = options.reserveTokens || 4096;
  }

  /**
   * Ước lượng tổng tokens của message array
   * Dùng heuristic ~4 chars/token
   *
   * @param {Array} messages - OpenAI-format messages array
   * @returns {number} Estimated token count
   */
  estimateTokens(messages) {
    if (!messages || !messages.length) return 0;

    let totalChars = 0;

    for (const msg of messages) {
      // role + structural overhead (~4 tokens per message)
      totalChars += 16;

      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        // Content blocks (multi-part messages)
        for (const block of msg.content) {
          if (block.type === 'text') {
            totalChars += (block.text || '').length;
          } else if (block.type === 'tool_result') {
            totalChars += (block.content || '').length;
          }
        }
      }

      // Tool calls trong assistant message
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalChars += (tc.function?.name || '').length;
          totalChars += (tc.function?.arguments || '').length;
        }
      }

      // Tool result message (role=tool)
      if (msg.role === 'tool') {
        totalChars += (msg.content || '').length;
        totalChars += (msg.tool_call_id || '').length;
      }

      // Name field
      if (msg.name) {
        totalChars += msg.name.length;
      }
    }

    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  /**
   * Tóm tắt một tool result message — giữ 200 chars đầu + truncate
   *
   * @param {Object} toolMessage - Message có role=tool
   * @returns {Object} Compressed version (new object, không mutate)
   */
  summarizeToolResult(toolMessage) {
    const compressed = { ...toolMessage };
    const content = toolMessage.content || '';

    if (content.length <= 300) {
      return compressed;
    }

    // Phát hiện read_file pattern → chỉ giữ metadata
    const readFileMatch = content.match(/^(\d+)\s+lines? read from (.+)/);
    if (readFileMatch) {
      compressed.content = `[read ${readFileMatch[1]} lines from ${readFileMatch[2]}]`;
      return compressed;
    }

    // Phát hiện file content có line numbers (output của cat -n / Read tool)
    const lineNumberPattern = /^\s*\d+\t/m;
    if (lineNumberPattern.test(content)) {
      const lines = content.split('\n');
      const lineCount = lines.length;
      // Tìm file path từ context nếu có
      const firstLine = lines[0] || '';
      compressed.content = `[file content: ${lineCount} lines]\n${content.slice(0, 200)}...\n[truncated ${lineCount - 5}+ lines]`;
      return compressed;
    }

    // Mặc định: giữ 200 chars đầu
    compressed.content = content.slice(0, 200) + `...\n[truncated, original: ${content.length} chars]`;
    return compressed;
  }

  /**
   * Trim messages array để vừa token budget
   *
   * Rules:
   * - LUÔN giữ: messages[0] (system) + messages[1] (user prompt gốc)
   * - 60% messages gần nhất: giữ nguyên
   * - Messages cũ: tóm tắt tool results, collapse consecutive tool results
   * - Không mutate input array
   *
   * @param {Array} messages - Original messages array
   * @param {number} [maxTokens] - Override max tokens (default: this.maxTokens - this.reserveTokens)
   * @returns {Array} Trimmed messages array (new array)
   */
  trimMessages(messages, maxTokens) {
    if (!messages || messages.length <= 2) return [...(messages || [])];

    const budget = maxTokens || (this.maxTokens - this.reserveTokens);

    // Kiểm tra nếu đã vừa budget → return copy
    if (this.estimateTokens(messages) <= budget) {
      return [...messages];
    }

    // Tách messages: protected (đầu) + middle + recent
    const protected_ = messages.slice(0, 2); // system + original user
    const rest = messages.slice(2);

    // 60% gần nhất giữ nguyên
    const recentCount = Math.max(1, Math.floor(rest.length * 0.6));
    const recentStart = rest.length - recentCount;

    const olderMessages = rest.slice(0, recentStart);
    const recentMessages = rest.slice(recentStart);

    // Xử lý older messages: tóm tắt tool results
    const compressedOlder = this._compressOlderMessages(olderMessages);

    // Ghép lại
    let result = [...protected_, ...compressedOlder, ...recentMessages];

    // Nếu vẫn vượt budget → cắt bớt older messages từ cũ nhất
    while (this.estimateTokens(result) > budget && compressedOlder.length > 0) {
      compressedOlder.shift();
      result = [...protected_, ...compressedOlder, ...recentMessages];
    }

    // Nếu VẪN vượt → tóm tắt cả recent tool results
    if (this.estimateTokens(result) > budget) {
      const compressedRecent = recentMessages.map(msg => {
        if (msg.role === 'tool') return this.summarizeToolResult(msg);
        return { ...msg };
      });
      result = [...protected_, ...compressedOlder, ...compressedRecent];
    }

    return result;
  }

  /**
   * Lấy thông tin usage hiện tại
   *
   * @param {Array} messages - Messages array
   * @returns {{ estimated_tokens: number, max_tokens: number, usage_percent: number, messages_count: number }}
   */
  getUsage(messages) {
    const estimated = this.estimateTokens(messages);
    const effective = this.maxTokens - this.reserveTokens;

    return {
      estimated_tokens: estimated,
      max_tokens: this.maxTokens,
      usage_percent: Math.round((estimated / effective) * 100),
      messages_count: messages ? messages.length : 0,
    };
  }

  // --- Private helpers ---

  /**
   * Nén nhóm messages cũ:
   * - Tool results → summarize
   * - Consecutive tool results → collapse thành 1
   * - read_file content → chỉ metadata
   *
   * @param {Array} messages
   * @returns {Array} Compressed messages (new objects)
   * @private
   */
  _compressOlderMessages(messages) {
    const result = [];
    let consecutiveToolResults = [];

    const flushToolResults = () => {
      if (consecutiveToolResults.length === 0) return;

      if (consecutiveToolResults.length === 1) {
        // Một tool result đơn lẻ → summarize
        result.push(this.summarizeToolResult(consecutiveToolResults[0]));
      } else {
        // Nhiều tool results liên tiếp → collapse thành 1 tổng hợp
        const summaries = consecutiveToolResults.map(msg => {
          const name = msg.name || 'tool';
          const content = msg.content || '';
          const preview = content.slice(0, 100).replace(/\n/g, ' ');
          return `[${name}]: ${preview}${content.length > 100 ? '...' : ''}`;
        });

        // Giữ tool_call_id của cái cuối cùng để không phá conversation flow
        // Mỗi tool result vẫn phải map với tool_call_id riêng
        for (const msg of consecutiveToolResults) {
          result.push(this.summarizeToolResult(msg));
        }
      }

      consecutiveToolResults = [];
    };

    for (const msg of messages) {
      if (msg.role === 'tool') {
        consecutiveToolResults.push(msg);
      } else {
        flushToolResults();

        if (msg.role === 'assistant' && msg.content && typeof msg.content === 'string' && msg.content.length > 500) {
          // Tóm tắt assistant messages dài trong phần cũ
          result.push({
            ...msg,
            content: msg.content.slice(0, 300) + `...\n[truncated, original: ${msg.content.length} chars]`,
          });
        } else {
          result.push({ ...msg });
        }
      }
    }

    // Flush remaining
    flushToolResults();

    return result;
  }
}

module.exports = { TokenManager };
