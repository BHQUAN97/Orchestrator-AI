#!/usr/bin/env node
/**
 * Tool Definitions — JSON Schema cho LLM tool_use
 *
 * Format: OpenAI-compatible (LiteLLM forward thẳng)
 * Mỗi tool có: name, description, parameters (JSON Schema)
 *
 * LLM nhận danh sách tools này → quyết định gọi tool nào → trả tool_calls
 * → Executor chạy → feed kết quả lại cho LLM
 */

const TOOLS = [
  // === FILE OPERATIONS ===
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Đọc nội dung file. Trả về nội dung với line numbers. Dùng offset/limit cho file lớn.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Đường dẫn file (tuyệt đối hoặc tương đối từ project root)'
          },
          offset: {
            type: 'integer',
            description: 'Dòng bắt đầu đọc (0-based). Mặc định 0',
            default: 0
          },
          limit: {
            type: 'integer',
            description: 'Số dòng tối đa đọc. Mặc định 200',
            default: 200
          }
        },
        required: ['path']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Ghi nội dung mới vào file. Tạo file mới hoặc ghi đè toàn bộ. Dùng edit_file nếu chỉ sửa 1 phần.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Đường dẫn file'
          },
          content: {
            type: 'string',
            description: 'Nội dung ghi vào file'
          }
        },
        required: ['path', 'content']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Sửa file bằng search & replace. Tìm old_string và thay bằng new_string. Tiết kiệm token hơn write_file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Đường dẫn file cần sửa'
          },
          old_string: {
            type: 'string',
            description: 'Chuỗi cần tìm (phải khớp chính xác, bao gồm indentation)'
          },
          new_string: {
            type: 'string',
            description: 'Chuỗi thay thế'
          },
          replace_all: {
            type: 'boolean',
            description: 'Thay thế tất cả occurrences. Mặc định false (chỉ thay lần đầu)',
            default: false
          }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },

  // === SEARCH & EXPLORE ===
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Liệt kê files/folders trong thư mục. Hỗ trợ glob pattern. Bỏ qua node_modules, .git, __pycache__.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Thư mục cần list. Mặc định "." (project root)',
            default: '.'
          },
          pattern: {
            type: 'string',
            description: 'Glob pattern lọc file. VD: "**/*.ts", "src/**/*.js"',
            default: '*'
          },
          max_depth: {
            type: 'integer',
            description: 'Độ sâu tối đa. Mặc định 3',
            default: 3
          }
        },
        required: []
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Tìm kiếm nội dung trong files (grep). Hỗ trợ regex. Trả về file + line number + matched content.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex hoặc text cần tìm'
          },
          path: {
            type: 'string',
            description: 'Thư mục tìm kiếm. Mặc định "." (project root)',
            default: '.'
          },
          include: {
            type: 'string',
            description: 'Glob pattern lọc file. VD: "*.ts", "*.{js,jsx}"'
          },
          max_results: {
            type: 'integer',
            description: 'Số kết quả tối đa. Mặc định 20',
            default: 20
          }
        },
        required: ['pattern']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Tim file theo glob pattern nhanh (fast-glob). Tra ve files sap xep theo mtime desc (moi nhat truoc). Tot hon list_files cho case "tim tat ca *.ts", khong gioi han do sau.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern. VD: "**/*.ts", "src/**/*.{js,jsx}", "tests/**/*.test.*"'
          },
          path: {
            type: 'string',
            description: 'Thu muc goc de glob. Mac dinh project root.',
            default: '.'
          },
          max_results: {
            type: 'integer',
            description: 'So file toi da. Mac dinh 100.',
            default: 100
          }
        },
        required: ['pattern']
      }
    }
  },

  // === NETWORK / WEB ===
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch URL (GET) va extract text (strip HTML). Dung doc API docs, blog, release notes. Timeout 15s, content truncate 50KB.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL (http/https). Khong chap nhan file://, javascript:, data:.'
          },
          max_length: {
            type: 'integer',
            description: 'Max chars content tra ve. Mac dinh 50000.',
            default: 50000
          }
        },
        required: ['url']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Tim kiem web. Uu tien Brave API (neu BRAVE_API_KEY), fallback DuckDuckGo HTML. Tra ve title + url + description.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Tu khoa tim kiem'
          },
          max_results: {
            type: 'integer',
            description: 'So ket qua toi da. Mac dinh 5.',
            default: 5
          }
        },
        required: ['query']
      }
    }
  },

  // === TERMINAL ===
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Chạy lệnh shell (bash). Dùng cho: npm, git, build, test, lint... Có timeout 30s mặc định. Lệnh nguy hiểm (rm -rf, drop, git push --force) sẽ bị chặn hoặc cần confirm. Voi background:true → spawn detached (dev server, watch), return PID ngay — dung bg_output/bg_kill sau.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Lệnh shell cần chạy'
          },
          cwd: {
            type: 'string',
            description: 'Thư mục chạy lệnh. Mặc định project root'
          },
          timeout: {
            type: 'integer',
            description: 'Timeout (ms). Mặc định 30000 (30s). Tối đa 120000 (2 phút)',
            default: 30000
          },
          background: {
            type: 'boolean',
            description: 'Spawn detached (dev server, tail -f, watch). Return PID ngay. Dung bg_output/bg_kill de quan ly.',
            default: false
          }
        },
        required: ['command']
      }
    }
  },

  // === BACKGROUND PROCESSES ===
  {
    type: 'function',
    function: {
      name: 'bg_list',
      description: 'Liet ke tat ca background processes da spawn. Tra ve PID, cmd, running status, exit code.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },

  {
    type: 'function',
    function: {
      name: 'bg_output',
      description: 'Lay output gan day cua background proc (tail mac dinh 50 dong).',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'PID cua bg proc' },
          tail: { type: 'integer', description: 'So dong tail. Mac dinh 50.', default: 50 }
        },
        required: ['pid']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'bg_kill',
      description: 'Kill background proc theo PID. Dung khi dev server dung, hoac dep process leak.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'PID de kill' }
        },
        required: ['pid']
      }
    }
  },

  // === BATCH EDIT ===
  {
    type: 'function',
    function: {
      name: 'edit_files',
      description: 'Atomic multi-file edit. Validate TAT CA edits truoc khi ghi; neu bat ky fail → khong ghi gi. Ideal cho refactor xuyen file (rename symbol, update imports). Max 50 edits.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'Array of edits. Moi edit giong edit_file: {path, old_string, new_string, replace_all?}',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path' },
                old_string: { type: 'string', description: 'String to find' },
                new_string: { type: 'string', description: 'String to replace' },
                replace_all: { type: 'boolean', description: 'Replace all occurrences', default: false }
              },
              required: ['path', 'old_string', 'new_string']
            }
          }
        },
        required: ['edits']
      }
    }
  },

  // === MCP RESOURCES ===
  {
    type: 'function',
    function: {
      name: 'read_mcp_resource',
      description: 'Doc MCP resource theo server name + uri. Resources la file/data do MCP server expose (vd: file system entries, database tables). Dung /mcp de xem danh sach server hien co.',
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Ten MCP server (vd: filesystem, github, memory)'
          },
          uri: {
            type: 'string',
            description: 'URI cua resource (vd: file:///path, resource://...)'
          }
        },
        required: ['server', 'uri']
      }
    }
  },

  // === SUBAGENT ===
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: 'Spawn child agent voi context rieng de lam 1 task doc lap. Child chi tra ve summary → giu parent context sach. Dung cho: explore (tim file), plan (thiet ke), review (kiem tra), debug (tim bug).',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Mo ta ngan (3-5 tu) ve task'
          },
          prompt: {
            type: 'string',
            description: 'Task chi tiet cho subagent — self-contained (subagent KHONG thay conversation hien tai)'
          },
          subagent_type: {
            type: 'string',
            enum: ['general-purpose', 'explore', 'plan', 'review', 'debug'],
            description: 'Loai subagent. explore=fast+scanner, plan=smart+planner, review=fast+reviewer, debug=smart+debugger',
            default: 'general-purpose'
          },
          auto_model: {
            type: 'boolean',
            description: 'Dung Hermes SmartRouter de chon model toi uu thay vi profile default. Mac dinh false.',
            default: false
          }
        },
        required: ['description', 'prompt']
      }
    }
  },

  // === MEMORY (tich luy kinh nghiem giua session) ===
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: 'Luu lai lesson/fact/gotcha vao long-term memory. Dung khi phat hien pattern quan trong can nho cho session sau (vd: project convention la nay, bug thuong gap kia). Khong goi bua — chi khi kinh nghiem that su tai su dung duoc.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['lesson', 'gotcha', 'fact', 'manual'],
            description: 'lesson: kinh nghiem thanh cong | gotcha: bay nen tranh | fact: su kien project | manual: ghi chu chung',
            default: 'manual'
          },
          summary: { type: 'string', description: 'Tom tat ngan (1-2 cau)' },
          details: { type: 'string', description: 'Chi tiet bo sung (optional, < 3000 chars)' },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords custom (optional — auto-extract neu khong cung cap)' }
        },
        required: ['summary']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Tim kiem kinh nghiem cu co lien quan den task hien tai. Dung TRUOC khi bat dau task de xem co bai hoc cu khong.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords/cau hoi can tim' },
          limit: { type: 'integer', description: 'So ket qua top-K. Mac dinh 5', default: 5 }
        },
        required: ['query']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'memory_list',
      description: 'Liet ke memory entries moi nhat. Filter theo type neu can.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 20 },
          type: { type: 'string', enum: ['lesson', 'gotcha', 'fact', 'manual'], description: 'Filter theo type' }
        }
      }
    }
  },

  // === SKILL CREATION ===
  {
    type: 'function',
    function: {
      name: 'create_skill',
      description: 'Tao custom slash command moi (skill .md voi frontmatter). User goi /<name> sau do. Dung khi phat hien workflow lap lai co the dong goi.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Slash command name [a-zA-Z0-9_-], max 60 char. User goi /<name>' },
          description: { type: 'string', description: 'Mo ta ngan ve skill' },
          body: { type: 'string', description: 'Noi dung skill (markdown). Co the chua $ARGUMENTS de substitute user args' },
          trigger: { type: 'string', description: 'Keywords trigger (comma-separated) de skill-matcher auto-suggest' },
          argument_hint: { type: 'string', description: 'Hint format cho user, vd "<file-path>"' },
          location: { type: 'string', enum: ['claude', 'skills'], default: 'claude', description: 'claude: .claude/commands/ (recommended) | skills: skills/' }
        },
        required: ['name', 'description', 'body']
      }
    }
  },

  // === TASK DECOMPOSITION (Hermes classifier) ===
  {
    type: 'function',
    function: {
      name: 'decompose_task',
      description: 'Phan tich task + goi y decomposition qua SLMClassifier. Tra ve classification (intent/complexity/domain), suggested_model (SmartRouter), va decomposition hint (co nen spawn_team khong). Dung TRUOC task phuc tap de lap ke hoach.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Task description de classify' }
        },
        required: ['prompt']
      }
    }
  },

  // === AGENT TEAM (parallel subagents) ===
  {
    type: 'function',
    function: {
      name: 'spawn_team',
      description: 'Chay 2-5 subagent SONG SONG voi role khac nhau, merge ket qua. Dung khi task co nhieu phan doc lap (explore FE + BE cung luc, review security + performance cung luc). Tiet kiem thoi gian so voi goi spawn_subagent tuan tu.',
      parameters: {
        type: 'object',
        properties: {
          agents: {
            type: 'array',
            description: 'Array 2-5 agent. Moi agent: {description, prompt, subagent_type?}',
            minItems: 2, maxItems: 5,
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'Mo ta ngan role cua agent' },
                prompt: { type: 'string', description: 'Task chi tiet — self-contained' },
                subagent_type: { type: 'string', enum: ['general-purpose', 'explore', 'plan', 'review', 'debug'], default: 'general-purpose' }
              },
              required: ['description', 'prompt']
            }
          }
        },
        required: ['agents']
      }
    }
  },

  // === AGENT SELF-TRACKING ===
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Bulk upsert agent self-todos de track progress trong task. Voi id → update (status: pending/in_progress/completed/deleted); khong id → create. Dung khi task phuc tap co > 3 step de user thay progress.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer', description: 'ID de update todo (omit de create moi)' },
                subject: { type: 'string', description: 'Ten ngan (imperative: "Fix login bug")' },
                activeForm: { type: 'string', description: 'Present continuous khi in_progress ("Fixing login bug")' },
                description: { type: 'string', description: 'Chi tiet (optional)' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'deleted'],
                  description: 'Trang thai (mac dinh pending)'
                }
              }
            }
          }
        },
        required: ['todos']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'todo_list',
      description: 'Lay danh sach todos hien tai cua agent (trong session nay).',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },

  // === USER INTERACTION ===
  {
    type: 'function',
    function: {
      name: 'ask_user_question',
      description: 'Hoi user khi can clarification (2+ file cung ten, lua chon approach, thieu info). Chi dung trong interactive mode. KHONG dung bua — chi khi that su ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'Cau hoi ngan gon, ro rang (1-2 cau)'
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Cac lua chon goi y. Neu khong dua → free text input.'
          },
          allow_free_text: {
            type: 'boolean',
            description: 'Cho user nhap text tu do ngoai options. Mac dinh false.',
            default: false
          }
        },
        required: ['question']
      }
    }
  },

  // === TASK MANAGEMENT ===
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Đánh dấu task hoàn thành và báo cáo kết quả. Gọi khi đã xong toàn bộ công việc.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Tóm tắt ngắn gọn kết quả (1-3 câu)'
          },
          files_changed: {
            type: 'array',
            items: { type: 'string' },
            description: 'Danh sách files đã thay đổi'
          }
        },
        required: ['summary']
      }
    }
  }
];

/**
 * Lấy tool definitions cho LLM call — filter theo permission profile
 * Layer 1 defense: LLM chi thay tools duoc phep (khong biet tools khac ton tai)
 */
function getTools(agentRole = 'builder') {
  const { ToolPermissions } = require('./permissions');
  const perms = new ToolPermissions(agentRole);
  const allowedNames = perms.getAllowedTools();

  return TOOLS.filter(t => allowedNames.includes(t.function.name));
}

/**
 * Lấy tool names dưới dạng text ngắn gọn — cho system prompt
 */
function getToolsSummary() {
  return TOOLS.map(t =>
    `- ${t.function.name}: ${t.function.description.split('.')[0]}`
  ).join('\n');
}

// === WINDOWS-NATIVE TOOLS (Phase 2) ===
// Append platform-specific tools — chi them neu chay tren Windows de tranh rac schema tren Linux/Mac
if (process.platform === 'win32') {
  try {
    const { WINDOWS_TOOL_DEFINITIONS } = require('./windows');
    TOOLS.push(...WINDOWS_TOOL_DEFINITIONS);
  } catch (e) {
    // Windows tools optional — neu load fail, bo qua
  }
}

// === ADVANCED TOOLS (ast_parse, git_advanced, screenshot, embedding) ===
// AST parsing (JS/TS) — cross-platform
TOOLS.push(
  {
    type: 'function',
    function: {
      name: 'ast_parse',
      description: 'Parse JS/TS file thanh AST, tra ve danh sach symbols (functions, classes, top-level const, exports). Chinh xac hon grep cho refactor.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Duong dan file .js/.jsx/.ts/.tsx/.mjs/.cjs' },
          include_locations: { type: 'boolean', default: true }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ast_find_symbol',
      description: 'Tim moi reference cua symbol trong 1 file (declaration + usages). Phan biet declaration vs reference, bo qua property access trung ten.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          symbol_name: { type: 'string' }
        },
        required: ['path', 'symbol_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ast_find_usages',
      description: 'Tim usages cua symbol xuyen nhieu file (max 100). Dung cho impact analysis truoc khi refactor.',
      parameters: {
        type: 'object',
        properties: {
          symbol_name: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'Danh sach file de quet, max 100' }
        },
        required: ['symbol_name', 'files']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ast_rename_symbol',
      description: 'Rename symbol trong 1 file bang AST (khong ham ho property access). Dry-run mac dinh — doi dry_run=false de ghi.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_name: { type: 'string' },
          new_name: { type: 'string' },
          dry_run: { type: 'boolean', default: true }
        },
        required: ['path', 'old_name', 'new_name']
      }
    }
  }
);

// git_advanced — convert Claude schema shape → OpenAI function shape
try {
  const { GIT_ADVANCED_SCHEMA } = require('./git-advanced');
  TOOLS.push({
    type: 'function',
    function: {
      name: GIT_ADVANCED_SCHEMA.name,
      description: GIT_ADVANCED_SCHEMA.description,
      parameters: GIT_ADVANCED_SCHEMA.input_schema
    }
  });
} catch { /* optional */ }

// embedding-search — schemas da san dang OpenAI format
try {
  const { TOOL_SCHEMAS: EMBED_SCHEMAS } = require('./embedding-search');
  TOOLS.push(...EMBED_SCHEMAS);
} catch { /* optional */ }

// research-tools — github_code_search / github_issue_search / npm_info / deep_research
try {
  const { TOOL_SCHEMAS: RESEARCH_SCHEMAS } = require('./research-tools');
  TOOLS.push(...RESEARCH_SCHEMAS);
} catch { /* optional */ }

// screenshot — Windows-only
if (process.platform === 'win32') {
  TOOLS.push(
    {
      type: 'function',
      function: {
        name: 'capture_screen',
        description: 'Chup man hinh Windows. Tra ve file path + base64 (data URL) de feed vision model. Chup full, monitor index, hoac region.',
        parameters: {
          type: 'object',
          properties: {
            monitor: { description: 'primary | all | index (0-based)', default: 'primary' },
            region: {
              type: 'object',
              properties: {
                x: { type: 'integer' }, y: { type: 'integer' },
                width: { type: 'integer' }, height: { type: 'integer' }
              }
            },
            format: { type: 'string', enum: ['png', 'jpg'], default: 'png' },
            save_path: { type: 'string', description: 'Path luu file; mac dinh .orcai/screenshots/<ts>.png' },
            return_base64: { type: 'boolean', default: true }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'capture_window',
        description: 'Chup 1 cua so cu the theo title (fuzzy match default). Auto-restore + foreground truoc khi chup.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            fuzzy: { type: 'boolean', default: true },
            format: { type: 'string', enum: ['png', 'jpg'], default: 'png' },
            save_path: { type: 'string' },
            return_base64: { type: 'boolean', default: true }
          },
          required: ['title']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_monitors',
        description: 'Liet ke monitor dang noi voi may — dimensions, primary flag, bounds.',
        parameters: { type: 'object', properties: {} }
      }
    }
  );
}

module.exports = { TOOLS, getTools, getToolsSummary };
