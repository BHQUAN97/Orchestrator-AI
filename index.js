/**
 * AI Orchestrator — Multi-model Coding Agent
 *
 * Export tất cả modules để dùng programmatically
 */

// Core v2 (giữ nguyên)
const { OrchestratorAgent, AGENT_ROLE_MAP } = require('./router/orchestrator-agent');
const { SmartRouter } = require('./router/smart-router');
const { ContextManager } = require('./router/context-manager');
const { TechLeadAgent } = require('./router/tech-lead-agent');
const { DecisionLock } = require('./router/decision-lock');
const { ContextCache } = require('./cache/context-cache');

// v3 — Coding Agent (mới)
const { AgentLoop } = require('./lib/agent-loop');
const { OrchestratorV3 } = require('./lib/orchestrator-v3');
const { ToolExecutor } = require('./tools/executor');
const { FileManager } = require('./tools/file-manager');
const { TerminalRunner } = require('./tools/terminal-runner');
const { TOOLS, getTools, getToolsSummary } = require('./tools/definitions');

// GĐ2-4 modules
const { RepoMapper } = require('./lib/repo-mapper');
const { TokenManager } = require('./lib/token-manager');
const { AutoVerify } = require('./lib/auto-verify');
const { ConversationManager } = require('./lib/conversation-manager');
const { Config } = require('./lib/config');

module.exports = {
  // v2
  OrchestratorAgent,
  SmartRouter,
  ContextManager,
  TechLeadAgent,
  DecisionLock,
  ContextCache,
  AGENT_ROLE_MAP,

  // v3 — Coding Agent
  AgentLoop,
  OrchestratorV3,
  ToolExecutor,
  FileManager,
  TerminalRunner,
  TOOLS,
  getTools,
  getToolsSummary,

  // GĐ2-4
  RepoMapper,
  TokenManager,
  AutoVerify,
  ConversationManager,
  Config
};
