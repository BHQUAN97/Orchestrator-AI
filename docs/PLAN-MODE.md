# Plan Mode

> Agent phan tich truoc → user duyet → moi execute. Chong agent sua nham code.

## Cach dung

```bash
orcai --plan "refactor auth module de dung JWT"
```

## Flow

```
1. Planner role (read-only)
   - Doc file, grep code, tim reference
   - KHONG write_file, edit_file, delete_file
   - Output: implementation plan (5 muc)

2. User duyet (inquirer prompt)
   - Approve: chay plan nhu thiet ke
   - Modify: nhap feedback → plan refined
   - Reject: abort

3. Builder role (full access)
   - Nhan agreed plan lam context
   - Implement theo plan
   - Tu verify bang test
```

## Plan format (do Planner xuat)

1. **Understanding** — task yeu cau gi (1-2 cau)
2. **Steps** — 3-7 action item da danh so
3. **Files to change** — list kem ly do
4. **Risks/tradeoffs** — 1-2 bullet
5. **Verification** — cach biet chay dung

## Options

```bash
# Bo qua approval (dung khi automation)
orcai --plan --yes "task..."

# Ket hop voi worktree
orcai --plan --worktree "task..."

# Set budget cap
orcai --plan --budget 0.50 "task..."
```

## Khi nao dung plan mode

- Task anh huong > 3 file
- Refactor module core
- Task lien quan security/auth
- Feature moi can nhieu tool call
- Lan dau thu 1 model moi

## Khi khong can plan mode

- Fix typo 1 file
- Read-only query
- Chay test/lint
- Task simple da lam quen

## Test

File `lib/plan-mode.js` duoc cover boi `test/parity.test.js` line 383-387 (smoke test).
Logic approve/modify/reject test qua `inquirer.prompt` mock.

## Implementation

- Source: `lib/plan-mode.js` — 123 dong
- Entry: `bin/orcai.js` line 644 (non-interactive), 1136 (interactive)
- CLI flag: `--plan` (line 89)
