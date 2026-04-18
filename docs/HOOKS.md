# Hooks

> Shell command tu dong chay tren event agent. Compat voi Claude Code format.

## Event types

| Event | Khi nao chay | Block duoc? |
|---|---|---|
| `SessionStart` | Agent khoi tao | No |
| `PreToolUse` | Truoc khi goi tool (matcher match) | Yes (exit != 0) |
| `PostToolUse` | Sau khi tool chay xong | No |
| `Stop` | Agent hoan thanh / abort | No |

## File config (thu tu load)

Hooks duoc **cong them** (KHONG override) theo thu tu:

1. `~/.claude/settings.json` (global)
2. `{projectDir}/.claude/settings.json` (project, chia voi Claude Code)
3. `{projectDir}/.orcai/settings.json` (project-only cho orcai)

→ Co the dung chung config voi Claude Code neu setup hook o `.claude/settings.json`.

## Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file|edit_file|edit_files",
        "hooks": [
          { "type": "command", "command": "npm run lint -- --fix" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "execute_command",
        "hooks": [
          { "type": "command", "command": "echo \"ran: $TOOL_NAME\" >> .orcai/tool.log" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "pm2 restart dev-server" }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "git status --short" }
        ]
      }
    ]
  }
}
```

### Fields

- `matcher` (optional) — regex match tool name. Bo trong → match tat ca.
- `hooks[].type` — luon la `"command"` (cho viet shell).
- `hooks[].command` — shell command chay. Timeout mac dinh 30s.

## Environment variables injected

Khi hook chay, se set them:

- `$TOOL_NAME` — ten tool dang goi (PreToolUse, PostToolUse)
- `$TOOL_ARGS_JSON` — JSON args cua tool (PostToolUse)
- `$TOOL_RESULT_JSON` — JSON result (PostToolUse)
- `$AGENT_ROLE` — role agent (builder, fe-dev, reviewer...)
- `$SESSION_ID` — session id
- `$PROJECT_DIR` — cwd

## Block PreToolUse

Exit code khac 0 tu PreToolUse hook se:
1. Block tool khong chay
2. Feed stderr cua hook lam error context cho agent
3. Agent co the retry voi approach khac

Vi du: hook `pre-commit` check format truoc khi `edit_file`.

## Options CLI

```bash
# Tat hook (debug)
orcai --no-hooks "task..."

# Default: hook enabled, load tat ca 3 source
orcai "task..."
```

## Verbose log

```bash
ORCAI_HOOKS_VERBOSE=1 orcai "..."
```

→ Print moi hook trigger, matcher, command, exit code.

## Test

`test/parity.test.js` line 313-348 cover:
- Load hooks tu cac file
- Matcher regex
- Timeout enforcement
- Env var injection
- Block behavior (exit code)

## Implementation

- Source: `lib/hooks.js`
- Timeout: 30s mac dinh (`HOOK_TIMEOUT_MS`)
- CLI flag: `--no-hooks` (disable)
- Wire: `lib/agent-loop.js` (PreToolUse + PostToolUse), CLI (SessionStart + Stop)

## Ke thua Claude Code

Orcai **KHONG sua** `~/.claude/settings.json`. Neu ban da co hook Claude Code, orcai tu chon lam follow:

```json
// ~/.claude/settings.json (da co san)
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write", "hooks": [...] }
    ]
  }
}
```

Luu y: matcher dung ten tool Claude Code (`Edit`, `Write`) va orcai (`edit_file`, `write_file`) co the khac. Neu muon apply cho ca hai, dung regex alternation: `Edit|edit_file|Write|write_file`.
