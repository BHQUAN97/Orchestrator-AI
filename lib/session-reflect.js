'use strict';
/**
 * Session Reflection — chạy non-blocking sau mỗi task_complete
 *
 * Gọi cheap model để trích xuất 1-3 lesson có cấu trúc từ tool call history + outcome,
 * rồi append vào memory store. Fire-and-forget — KHÔNG block main agent flow.
 *
 * Constructor params match AgentLoop fields trực tiếp:
 *   litellmUrl  ← this.litellmUrl
 *   litellmKey  ← this.litellmKey
 *   memory      ← this.memoryStore
 *   model       ← 'cheap' (model alias, resolved bởi LiteLLM)
 */

class SessionReflector {
  /**
   * @param {object} opts
   * @param {string}      opts.litellmUrl  - LiteLLM base URL (e.g. http://localhost:5002)
   * @param {string}      opts.litellmKey  - LiteLLM API key
   * @param {object|null} opts.memory      - MemoryStore instance (must have .append())
   * @param {string}      [opts.model]     - Model alias to call. Default: 'cheap'
   */
  constructor({ litellmUrl, litellmKey, memory, model = 'cheap' }) {
    this.url = litellmUrl;
    this.key = litellmKey;
    this.memory = memory;
    this.model = model;
    // Chỉ enable khi đủ dependencies
    this.enabled = !!(litellmUrl && litellmKey && memory);
  }

  /**
   * Chạy reflection sau khi task hoàn tất.
   * Fire-and-forget — caller KHÔNG await.
   *
   * @param {object} opts
   * @param {string}   opts.taskPrompt       - Prompt gốc của task
   * @param {Array}    opts.toolCallHistory   - Array { tool, args, success, error }
   * @param {string}   opts.outcome           - 'success' | 'fail'
   * @param {string}   opts.modelUsed         - Model alias đã dùng (e.g. 'smart')
   * @param {number}   [opts.costUsd]         - Chi phí USD của session
   * @param {string}   [opts.projectDir]      - Project directory (unused, reserved)
   */
  async reflect({ taskPrompt, toolCallHistory, outcome, modelUsed, costUsd, projectDir }) {
    if (!this.enabled) return;

    try {
      const summary = this._summarizeHistory(toolCallHistory);
      if (!summary) return; // Không có gì để reflect

      const lessons = await this._extractLessons({ taskPrompt, summary, outcome, modelUsed });
      if (!lessons?.length) return;

      for (const lesson of lessons) {
        await this.memory.append({
          type: 'lesson',
          prompt_summary: taskPrompt?.slice(0, 150) || '',
          summary: lesson.summary,
          keywords: lesson.keywords || [],
          outcome: outcome || 'unknown',
          model_used: modelUsed || this.model,
          cost_usd: costUsd || 0,
          confidence: lesson.confidence || 0.65,
          tags: ['#auto-reflect', ...(lesson.tags || [])],
          grade: 'lesson',
          helped_count: 0,
          used_count: 0
        });
      }
    } catch {
      // Reflection là best-effort — KHÔNG bao giờ throw hoặc block flow chính
    }
  }

  /**
   * Tóm tắt 10 tool calls gần nhất thành compact string.
   * Trả null nếu history rỗng.
   *
   * @param {Array} history
   * @returns {string|null}
   */
  _summarizeHistory(history) {
    if (!history?.length) return null;
    const recent = history.slice(-10);
    return recent.map(t => {
      const args = JSON.stringify(t.args || {}).slice(0, 80);
      return `${t.tool}(${args}) → ${t.success ? 'ok' : 'err:' + (t.error || '?')}`;
    }).join('\n');
  }

  /**
   * Gọi cheap model để trích xuất lessons từ session summary.
   * Trả null nếu response lỗi hoặc parse thất bại.
   *
   * @param {object} params
   * @returns {Promise<Array|null>}
   */
  async _extractLessons({ taskPrompt, summary, outcome, modelUsed }) {
    const prompt = `You are analyzing a coding session to extract lessons for future improvement.

Task: ${taskPrompt?.slice(0, 200) || 'unknown'}
Outcome: ${outcome}
Model used: ${modelUsed}
Tool call history (last 10):
${summary}

Extract 1-3 concise lessons from this session. Only extract if there is a genuine insight (what worked, what failed, what to avoid, useful pattern discovered).

Respond with JSON array ONLY, no other text:
[
  {
    "summary": "one sentence lesson, specific and actionable",
    "keywords": ["keyword1", "keyword2"],
    "confidence": 0.7,
    "tags": ["#pattern-name"]
  }
]

If no clear lesson, return empty array: []`;

    let res;
    try {
      res = await fetch(`${this.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.key}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
          temperature: 0.3
        }),
        signal: AbortSignal.timeout(15000) // 15s max — không block lâu
      });
    } catch {
      // Network error / timeout → fail silently
      return null;
    }

    if (!res.ok) return null;

    let data;
    try {
      data = await res.json();
    } catch {
      return null;
    }

    const text = data?.choices?.[0]?.message?.content?.trim() || '';

    // Trích JSON array từ response (model đôi khi thêm text xung quanh)
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed.slice(0, 3) : null;
    } catch {
      return null;
    }
  }
}

module.exports = { SessionReflector };
