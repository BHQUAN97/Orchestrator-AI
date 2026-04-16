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
