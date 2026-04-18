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
const registry = require('./registry');
const scheduledTasks = require('./scheduled-tasks');
const services = require('./services');

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
  // === REGISTRY ===
  {
    type: 'function',
    function: {
      name: 'registry_get',
      description: 'Doc Windows Registry value. Path dang HKLM:\\... hoac HKCU:\\... Read-only, khong can confirm.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          valueName: { type: 'string' },
        },
        required: ['path', 'valueName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registry_list',
      description: 'Liet ke subkeys va values duoi 1 registry path. Read-only.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registry_set',
      description: 'Ghi registry value. YEU CAU confirm=true. Chan HKLM\\SYSTEM\\CurrentControlSet\\Services, SAM, SECURITY, Policies (bypass qua env ORCAI_REGISTRY_UNSAFE=1).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          valueName: { type: 'string' },
          value: {},
          type: { type: 'string', enum: ['String', 'ExpandString', 'Binary', 'DWord', 'QWord', 'MultiString'] },
          confirm: { type: 'boolean' },
        },
        required: ['path', 'valueName', 'value', 'type', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registry_delete',
      description: 'Xoa registry value. YEU CAU confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          valueName: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['path', 'valueName', 'confirm'],
      },
    },
  },
  // === SCHEDULED TASKS ===
  {
    type: 'function',
    function: {
      name: 'tasks_list',
      description: 'Liet ke scheduled tasks qua schtasks /query /fo csv. filter la substring ten task.',
      parameters: {
        type: 'object',
        properties: { filter: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tasks_get',
      description: 'Lay chi tiet 1 scheduled task theo ten.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tasks_run',
      description: 'Chay ngay 1 scheduled task (khong doi schedule). Khong can confirm.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tasks_end',
      description: 'Dung 1 scheduled task dang chay.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tasks_create',
      description: 'Tao scheduled task moi. YEU CAU confirm=true. schedule: ONCE|DAILY|WEEKLY|ONLOGON|ONSTART.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          schedule: { type: 'string' },
          startTime: { type: 'string' },
          user: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['name', 'command', 'schedule', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tasks_delete',
      description: 'Xoa scheduled task. YEU CAU confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['name', 'confirm'],
      },
    },
  },
  // === SERVICES ===
  {
    type: 'function',
    function: {
      name: 'services_list',
      description: 'Liet ke Windows services (Get-Service). filter la substring.',
      parameters: {
        type: 'object',
        properties: { filter: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'services_get',
      description: 'Chi tiet 1 service.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'services_start',
      description: 'Start 1 service. YEU CAU confirm=true. Chan service he thong: winmgmt, rpcss, lsass, wininit, csrss, smss, services.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, confirm: { type: 'boolean' } },
        required: ['name', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'services_stop',
      description: 'Stop 1 service. YEU CAU confirm=true.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, confirm: { type: 'boolean' } },
        required: ['name', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'services_restart',
      description: 'Restart 1 service. YEU CAU confirm=true.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, confirm: { type: 'boolean' } },
        required: ['name', 'confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'services_set_start_type',
      description: 'Doi start type cua service. YEU CAU confirm=true.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['Auto', 'Manual', 'Disabled'] },
          confirm: { type: 'boolean' },
        },
        required: ['name', 'type', 'confirm'],
      },
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
  // Registry
  registry_get: (args = {}) => registry.registryGet(args),
  registry_list: (args = {}) => registry.registryList(args),
  registry_set: (args = {}) => registry.registrySet(args),
  registry_delete: (args = {}) => registry.registryDelete(args),
  // Scheduled tasks
  tasks_list: (args = {}) => scheduledTasks.tasksList(args),
  tasks_get: (args = {}) => scheduledTasks.tasksGet(args),
  tasks_run: (args = {}) => scheduledTasks.tasksRun(args),
  tasks_end: (args = {}) => scheduledTasks.tasksEnd(args),
  tasks_create: (args = {}) => scheduledTasks.tasksCreate(args),
  tasks_delete: (args = {}) => scheduledTasks.tasksDelete(args),
  // Services
  services_list: (args = {}) => services.servicesList(args),
  services_get: (args = {}) => services.servicesGet(args),
  services_start: (args = {}) => services.servicesStart(args),
  services_stop: (args = {}) => services.servicesStop(args),
  services_restart: (args = {}) => services.servicesRestart(args),
  services_set_start_type: (args = {}) => services.servicesSetStartType(args),
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
  // Registry
  registryGet: registry.registryGet,
  registryList: registry.registryList,
  registrySet: registry.registrySet,
  registryDelete: registry.registryDelete,
  // Scheduled tasks
  tasksList: scheduledTasks.tasksList,
  tasksGet: scheduledTasks.tasksGet,
  tasksRun: scheduledTasks.tasksRun,
  tasksEnd: scheduledTasks.tasksEnd,
  tasksCreate: scheduledTasks.tasksCreate,
  tasksDelete: scheduledTasks.tasksDelete,
  // Services
  servicesList: services.servicesList,
  servicesGet: services.servicesGet,
  servicesStart: services.servicesStart,
  servicesStop: services.servicesStop,
  servicesRestart: services.servicesRestart,
  servicesSetStartType: services.servicesSetStartType,
  // For orcai integration
  WINDOWS_TOOL_DEFINITIONS,
  WINDOWS_HANDLERS,
};
