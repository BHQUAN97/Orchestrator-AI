'use strict';

// Windows-native tool bundle cho orcai
// Export: cac ham + WINDOWS_TOOL_DEFINITIONS (OpenAI function-calling) + WINDOWS_HANDLERS
const { runPowerShell } = require('./ps-bridge');
const { everythingSearch, hasEverything } = require('./everything-search');
const { readClipboard, writeClipboard } = require('./clipboard');
const { readEventLog } = require('./event-log');
const { wmiQuery } = require('./wmi-query');
const { wslExec, listDistros } = require('./wsl-exec');
const { wingetSearch } = require('./winget-search');
const { sysInfo } = require('./sys-info');

// ---- OpenAI function-calling schema ----
const WINDOWS_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'ps_command',
      description: 'Chay mot PowerShell script tren Windows. Dung cho admin task, truy van he thong, automation. Timeout mac dinh 30s. Output > 100KB se bi cat bot.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'Noi dung PowerShell script (co the nhieu dong)' },
          timeout: { type: 'number', description: 'Timeout tinh bang ms', default: 30000 },
          cwd: { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'everything_search',
      description: 'Search file cuc nhanh bang Everything (voidtools) es.exe. Fallback sang Get-ChildItem neu chua cai Everything (nen cung cap path de tranh scan C:\\).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (filename, wildcard, regex)' },
          max_results: { type: 'number', default: 50 },
          regex: { type: 'boolean', default: false },
          path: { type: 'string', description: 'Gioi han scope trong folder nay (quan trong neu khong co Everything)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_read',
      description: 'Doc noi dung clipboard hien tai cua Windows. Gioi han 100KB.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_write',
      description: 'Ghi text vao clipboard Windows. Gioi han 100KB.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Noi dung can ghi vao clipboard' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'event_log',
      description: 'Doc Windows Event Log. Huu ich khi debug crash, service failure, system error.',
      parameters: {
        type: 'object',
        properties: {
          log: { type: 'string', description: 'Ten log: System | Application | Security', default: 'System' },
          level: { type: 'string', enum: ['Critical', 'Error', 'Warning', 'Information'], description: 'Loc theo severity' },
          source: { type: 'string', description: 'ProviderName (VD: Service Control Manager)' },
          max: { type: 'number', default: 20 },
          since_minutes: { type: 'number', default: 60, description: 'Chi lay event trong N phut gan day' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wmi_query',
      description: 'Truy van WMI/CIM qua Get-CimInstance. VD class: Win32_Process, Win32_Service, Win32_LogicalDisk, Win32_NetworkAdapter.',
      parameters: {
        type: 'object',
        properties: {
          class_name: { type: 'string', description: 'Ten class WMI (VD: Win32_Process)' },
          properties: { type: 'array', items: { type: 'string' }, description: 'List field can lay' },
          where: { type: 'string', description: 'WQL filter (VD: "Name LIKE \'%node%\'")' },
        },
        required: ['class_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wsl_exec',
      description: 'Chay bash command trong WSL tu Windows. Tu dong dung default distro neu khong chi dinh.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command' },
          distro: { type: 'string', description: 'Ten WSL distro (optional)' },
          cwd: { type: 'string', description: 'Working directory (Windows path, wsl tu convert)' },
          timeout: { type: 'number', default: 30000 },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'winget_search',
      description: 'Tim package qua Windows Package Manager (winget).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Ten/keyword package' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sys_info',
      description: 'Lay thong tin he thong nhanh: CPU usage/cores, RAM, disk usage, GPU. Chay trong ~1s.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ---- Handlers: map ten tool -> ham thuc thi ----
// Moi handler nhan 1 object args tu model, tra ve ket qua async
const WINDOWS_HANDLERS = {
  ps_command: (args = {}) => runPowerShell({
    script: args.script,
    timeout: args.timeout,
    cwd: args.cwd,
  }),
  everything_search: (args = {}) => everythingSearch(args),
  clipboard_read: () => readClipboard(),
  clipboard_write: (args = {}) => writeClipboard(args),
  event_log: (args = {}) => readEventLog(args),
  wmi_query: (args = {}) => wmiQuery(args),
  wsl_exec: (args = {}) => wslExec(args),
  winget_search: (args = {}) => wingetSearch(args),
  sys_info: () => sysInfo(),
};

module.exports = {
  // Raw functions
  runPowerShell,
  everythingSearch,
  hasEverything,
  readClipboard,
  writeClipboard,
  readEventLog,
  wmiQuery,
  wslExec,
  listDistros,
  wingetSearch,
  sysInfo,
  // For orcai integration
  WINDOWS_TOOL_DEFINITIONS,
  WINDOWS_HANDLERS,
};
