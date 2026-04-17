#!/usr/bin/env node
/**
 * Tool Permissions — He thong phan quyen cho AI Agents
 *
 * Moi agent role co 1 permission profile dinh nghia:
 * - Tools nao duoc phep dung
 * - Gioi han cu the cho tung tool (vd: chi doc, khong ghi)
 * - Rate limit rieng (so lan goi toi da)
 *
 * PERMISSION LEVELS:
 *   full    — toan quyen, khong gioi han
 *   read    — chi doc file, list, search. Khong ghi, khong execute
 *   write   — doc + ghi file. Khong execute command
 *   execute — doc + ghi + chay lenh shell
 *   admin   — full + khong bi command blocklist (chi cho internal tools)
 *
 * DEFENSE-IN-DEPTH:
 *   Layer 1: getTools() — LLM chi thay tools duoc phep (khong biet tools khac ton tai)
 *   Layer 2: ToolPermissions.check() — executor kiem tra truoc khi chay (phong LLM hallucinate tool)
 *   Layer 3: FileManager/TerminalRunner — validate path, block commands (last resort)
 */

// === Permission profiles theo agent role ===
const ROLE_PERMISSIONS = {
  // Architect — full access, can doc/ghi/execute de design
  'architect': {
    level: 'execute',
    allowed: ['read_file', 'write_file', 'edit_file', 'edit_files', 'list_files', 'search_files', 'glob', 'execute_command', 'web_fetch', 'web_search', 'spawn_subagent', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    limits: {
      execute_command: { maxCalls: 20, maxTimeout: 120000 },
      write_file: { maxCalls: 30 },
      edit_file: { maxCalls: 50 },
      spawn_subagent: { maxCalls: 5 },
      web_fetch: { maxCalls: 10 },
      web_search: { maxCalls: 10 }
    }
  },

  // Tech Lead — full access, review + escalation handler
  'tech-lead': {
    level: 'execute',
    allowed: ['read_file', 'write_file', 'edit_file', 'edit_files', 'list_files', 'search_files', 'glob', 'execute_command', 'web_fetch', 'web_search', 'spawn_subagent', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    limits: {
      execute_command: { maxCalls: 15, maxTimeout: 60000 },
      write_file: { maxCalls: 20 },
      edit_file: { maxCalls: 30 },
      spawn_subagent: { maxCalls: 5 },
      web_fetch: { maxCalls: 10 },
      web_search: { maxCalls: 10 }
    }
  },

  // Builder/Dev — full access cho code
  'builder': {
    level: 'execute',
    allowed: ['read_file', 'write_file', 'edit_file', 'edit_files', 'list_files', 'search_files', 'glob', 'execute_command', 'web_fetch', 'web_search', 'spawn_subagent', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    limits: {
      execute_command: { maxCalls: 30, maxTimeout: 120000 },
      write_file: { maxCalls: 50 },
      edit_file: { maxCalls: 80 },
      spawn_subagent: { maxCalls: 3 },
      web_fetch: { maxCalls: 15 },
      web_search: { maxCalls: 10 }
    }
  },
  'fe-dev': {
    level: 'execute',
    allowed: ['read_file', 'write_file', 'edit_file', 'edit_files', 'list_files', 'search_files', 'glob', 'execute_command', 'web_fetch', 'web_search', 'spawn_subagent', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    limits: {
      execute_command: { maxCalls: 30, maxTimeout: 120000 },
      write_file: { maxCalls: 50 },
      edit_file: { maxCalls: 80 },
      spawn_subagent: { maxCalls: 3 },
      web_fetch: { maxCalls: 15 },
      web_search: { maxCalls: 10 }
    }
  },
  'be-dev': {
    level: 'execute',
    allowed: ['read_file', 'write_file', 'edit_file', 'edit_files', 'list_files', 'search_files', 'glob', 'execute_command', 'web_fetch', 'web_search', 'spawn_subagent', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    limits: {
      execute_command: { maxCalls: 30, maxTimeout: 120000 },
      write_file: { maxCalls: 50 },
      edit_file: { maxCalls: 80 },
      spawn_subagent: { maxCalls: 3 },
      web_fetch: { maxCalls: 15 },
      web_search: { maxCalls: 10 }
    }
  },

  // Debugger — full access, can trace + fix
  'debugger': {
    level: 'execute',
    allowed: ['read_file', 'write_file', 'edit_file', 'edit_files', 'list_files', 'search_files', 'glob', 'execute_command', 'web_fetch', 'web_search', 'spawn_subagent', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    limits: {
      execute_command: { maxCalls: 40, maxTimeout: 120000 },
      write_file: { maxCalls: 20 },
      edit_file: { maxCalls: 40 },
      spawn_subagent: { maxCalls: 3 },
      web_fetch: { maxCalls: 15 },
      web_search: { maxCalls: 10 }
    }
  },

  // Reviewer — chi doc, search, chay test. KHONG ghi file
  'reviewer': {
    level: 'read',
    allowed: ['read_file', 'list_files', 'search_files', 'glob', 'execute_command', 'web_fetch', 'web_search', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    denied: ['write_file', 'edit_file', 'spawn_subagent'],
    limits: {
      execute_command: {
        maxCalls: 10,
        maxTimeout: 60000,
        // Reviewer chi duoc chay test/lint, khong duoc chay build/install
        allowedCommands: [/npm\s+test/, /npm\s+run\s+(test|lint|check|typecheck)/, /npx\s+(jest|vitest|eslint|tsc)/, /pytest/, /python\s+-m\s+(pytest|unittest)/]
      },
      web_fetch: { maxCalls: 10 },
      web_search: { maxCalls: 5 }
    }
  },

  // Scanner — chi doc, KHONG ghi, KHONG execute
  'scanner': {
    level: 'read',
    allowed: ['read_file', 'list_files', 'search_files', 'glob', 'web_fetch', 'web_search', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    denied: ['write_file', 'edit_file', 'execute_command', 'spawn_subagent'],
    limits: {
      read_file: { maxCalls: 50 },
      search_files: { maxCalls: 20 },
      glob: { maxCalls: 30 },
      web_fetch: { maxCalls: 10 },
      web_search: { maxCalls: 5 }
    }
  },

  // Planner — chi doc, KHONG ghi, KHONG execute
  'planner': {
    level: 'read',
    allowed: ['read_file', 'list_files', 'search_files', 'glob', 'web_fetch', 'web_search', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    denied: ['write_file', 'edit_file', 'execute_command', 'spawn_subagent'],
    limits: {
      read_file: { maxCalls: 30 },
      web_fetch: { maxCalls: 5 },
      web_search: { maxCalls: 5 }
    }
  },

  // Docs — doc + ghi file, KHONG execute command
  'docs': {
    level: 'write',
    allowed: ['read_file', 'write_file', 'edit_file', 'edit_files', 'list_files', 'search_files', 'glob', 'web_fetch', 'web_search', 'read_mcp_resource', 'ask_user_question', 'task_complete'],
    denied: ['execute_command', 'spawn_subagent'],
    limits: {
      write_file: { maxCalls: 20 },
      edit_file: { maxCalls: 30 },
      web_fetch: { maxCalls: 20 },
      web_search: { maxCalls: 10 }
    }
  },

  // Dispatcher/Synthesizer — khong can tools, chi tong hop text
  'dispatcher': {
    level: 'read',
    allowed: ['task_complete'],
    denied: ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files', 'glob', 'execute_command', 'web_fetch', 'web_search', 'spawn_subagent'],
    limits: {}
  }
};

// MCP tools (prefix mcp__) duoc phep cho moi role co level 'execute' — orcai khong phan quyen chi tiet theo MCP tool
const MCP_TOOL_PREFIX = 'mcp__';

class ToolPermissions {
  constructor(agentRole = 'builder') {
    this.role = agentRole;
    this.profile = ROLE_PERMISSIONS[agentRole] || ROLE_PERMISSIONS['builder'];
    // Dem so lan goi moi tool — cho rate limiting
    this.callCounts = {};
  }

  /**
   * Kiem tra agent co quyen goi tool nay khong
   * Tra ve { allowed, reason } — reason giai thich neu bi chan
   */
  check(toolName, args = {}) {
    // Tool luon duoc phep
    if (toolName === 'task_complete') {
      return { allowed: true };
    }

    // MCP tools — cho phep cho roles co level execute/write
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      if (this.profile.level === 'execute' || this.profile.level === 'write') {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Role "${this.role}" (level ${this.profile.level}) khong duoc goi MCP tools.`
      };
    }

    // Check tool co trong danh sach allowed
    if (this.profile.denied && this.profile.denied.includes(toolName)) {
      return {
        allowed: false,
        reason: `Role "${this.role}" khong co quyen dung tool "${toolName}". Level: ${this.profile.level}`
      };
    }

    if (!this.profile.allowed.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" khong nam trong allowed list cua role "${this.role}"`
      };
    }

    // Check rate limit
    const limits = this.profile.limits[toolName];
    if (limits) {
      const count = this.callCounts[toolName] || 0;

      if (limits.maxCalls && count >= limits.maxCalls) {
        return {
          allowed: false,
          reason: `Rate limit: role "${this.role}" da goi "${toolName}" ${count}/${limits.maxCalls} lan. Het quota.`
        };
      }

      // Check command timeout
      if (toolName === 'execute_command' && limits.maxTimeout && args.timeout > limits.maxTimeout) {
        return {
          allowed: false,
          reason: `Timeout ${args.timeout}ms vuot qua gioi han ${limits.maxTimeout}ms cho role "${this.role}"`
        };
      }

      // Check allowed commands (reviewer chi duoc chay test/lint)
      if (toolName === 'execute_command' && limits.allowedCommands && args.command) {
        const cmdAllowed = limits.allowedCommands.some(pattern => pattern.test(args.command));
        if (!cmdAllowed) {
          return {
            allowed: false,
            reason: `Role "${this.role}" chi duoc chay test/lint commands. Lenh "${args.command.slice(0, 50)}" khong duoc phep.`
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Ghi nhan 1 lan goi tool — cho rate limiting
   */
  recordCall(toolName) {
    this.callCounts[toolName] = (this.callCounts[toolName] || 0) + 1;
  }

  /**
   * Lay danh sach tool names duoc phep — dung cho getTools() filter
   */
  getAllowedTools() {
    return this.profile.allowed;
  }

  /**
   * Lay thong ke so lan goi
   */
  getUsage() {
    return {
      role: this.role,
      level: this.profile.level,
      calls: { ...this.callCounts },
      limits: Object.fromEntries(
        Object.entries(this.profile.limits).map(([tool, limit]) => [
          tool,
          {
            used: this.callCounts[tool] || 0,
            max: limit.maxCalls || 'unlimited',
            remaining: limit.maxCalls ? Math.max(0, limit.maxCalls - (this.callCounts[tool] || 0)) : 'unlimited'
          }
        ])
      )
    };
  }

  /**
   * Reset dem — dung khi bat dau task moi
   */
  reset() {
    this.callCounts = {};
  }
}

module.exports = { ToolPermissions, ROLE_PERMISSIONS };
