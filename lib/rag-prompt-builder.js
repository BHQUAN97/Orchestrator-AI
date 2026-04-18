#!/usr/bin/env node
/**
 * RagPromptBuilder — RAG-aware system prompt cho local model
 *
 * Local Qwen 2.5 Coder (cutoff Sep 2024) hay drift tren framework moi.
 * Ta chen stack profile + few-shot examples tu codebase nguoi dung
 * → model sinh code match convention hien tai.
 *
 * Chi ap dung cho LOCAL model. Cloud model (Opus/Sonnet/DeepSeek) bypass
 * de tranh latency khong can thiet.
 */

const LOCAL_MODEL_RE = /^(local-|qwen2?\.?5-coder)/i;
const MIN_SIMILARITY = 0.55;

class RagPromptBuilder {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.embeddings = options.embeddings || null;
    this.contextManager = options.contextManager || null;
    this.maxExamples = options.maxExamples || 3;
    this.maxProfileChars = options.maxProfileChars || 2000;
    this.minSimilarity = options.minSimilarity || MIN_SIMILARITY;

    // Metrics — cho agent-loop expose ra ngoai
    this.metrics = {
      rag_applied: 0,
      rag_skipped_cloud: 0,
      rag_fallback_profile_only: 0,
      rag_fallback_none: 0
    };

    // Warn once flags
    this._warnedEmbeddings = false;
    this._warnedProfile = false;
  }

  /**
   * Check pattern: "local-*" hoac "qwen2.5-coder-*"
   */
  isLocalModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    return LOCAL_MODEL_RE.test(modelId);
  }

  /**
   * Build system prompt co RAG context.
   * @param {{basePrompt: string, userMessage: string, modelId: string}} args
   * @returns {Promise<string>}
   */
  async build({ basePrompt = '', userMessage = '', modelId = '' } = {}) {
    // Cloud model → return base khong doi byte
    if (!this.isLocalModel(modelId)) {
      this.metrics.rag_skipped_cloud++;
      return basePrompt;
    }

    // Fetch stack profile
    let profile = null;
    try {
      profile = this.contextManager?.getStackProfile?.(this.projectDir) || null;
    } catch {
      profile = null;
    }
    if (profile && profile.length > this.maxProfileChars) {
      profile = profile.slice(0, this.maxProfileChars) + '\n... [truncated]';
    }

    // Fetch examples qua embedding search
    let examples = [];
    let embeddingsFailed = false;
    if (this.embeddings && userMessage) {
      try {
        const hits = await this._searchExamples(userMessage);
        examples = (hits || [])
          .filter(h => typeof h.score === 'number' && h.score >= this.minSimilarity)
          .slice(0, this.maxExamples);
      } catch (err) {
        embeddingsFailed = true;
        if (!this._warnedEmbeddings) {
          this._warnedEmbeddings = true;
          console.warn(`[rag] embeddings search failed: ${err.message}`);
        }
      }
    } else if (!this.embeddings) {
      embeddingsFailed = true;
    }

    // Ca 2 fail → return base
    if (!profile && (embeddingsFailed || examples.length === 0)) {
      this.metrics.rag_fallback_none++;
      if (!this._warnedProfile) {
        this._warnedProfile = true;
        console.warn('[rag] no stack profile + no examples → basePrompt unchanged');
      }
      return basePrompt;
    }

    // Co profile nhung khong co examples → profile-only
    if (profile && examples.length === 0) {
      this.metrics.rag_fallback_profile_only++;
      return this._composeProfileOnly(basePrompt, profile);
    }

    // Full RAG path
    this.metrics.rag_applied++;
    return this._composeFull(basePrompt, profile || '(stack profile unavailable)', examples);
  }

  /**
   * Goi embedding store — uu tien .search() (per spec), fallback .query()
   */
  async _searchExamples(query) {
    const emb = this.embeddings;
    if (typeof emb.search === 'function') {
      return await emb.search({ query, topK: this.maxExamples });
    }
    if (typeof emb.query === 'function') {
      return await emb.query({ text: query, top_k: this.maxExamples });
    }
    throw new Error('embeddings missing search/query method');
  }

  _composeProfileOnly(basePrompt, profile) {
    return [
      basePrompt || '',
      '',
      '## USER STACK PROFILE',
      profile,
      '',
      '## INSTRUCTIONS',
      '- Use the exact framework versions and patterns from the stack profile',
      '- Prefer conventions above over "modern best practice" from training data'
    ].join('\n').trim();
  }

  _composeFull(basePrompt, profile, examples) {
    const formatted = examples.map((ex, i) => {
      const score = (typeof ex.score === 'number' ? ex.score : 0).toFixed(2);
      const code = (ex.text || '').trim();
      return `## Example ${i + 1} (similarity ${score})\n\`\`\`\n${code}\n\`\`\``;
    }).join('\n\n');

    return [
      basePrompt || '',
      '',
      '## USER STACK PROFILE',
      profile,
      '',
      '## RELEVANT EXAMPLES FROM CODEBASE',
      formatted,
      '',
      '## INSTRUCTIONS',
      '- Match the style and conventions shown above',
      '- Use the exact framework versions and patterns from the stack profile',
      '- Prefer reusing patterns from the examples over inventing new ones'
    ].join('\n').trim();
  }

  /**
   * Snapshot metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }

  resetMetrics() {
    for (const k of Object.keys(this.metrics)) this.metrics[k] = 0;
  }
}

module.exports = { RagPromptBuilder, LOCAL_MODEL_RE };
