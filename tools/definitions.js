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
      description: 'Chạy lệnh shell (bash). Dùng cho: npm, git, build, test, lint... Có timeout 30s mặc định. Lệnh nguy hiểm (rm -rf, drop, git push --force) sẽ bị chặn hoặc cần confirm.',
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
          }
        },
        required: ['command']
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
          }
        },
        required: ['description', 'prompt']
      }
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

module.exports = { TOOLS, getTools, getToolsSummary };
