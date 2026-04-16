# Upgrade Plan — Cai tien luong hien tai

> Khong thay the Claude Code. Toi uu hoa chi phi bang cach chon dung model cho dung viec.

---

## Phan tich luong hien tai

### Diem manh (GIU NGUYEN)
1. SDD Pipeline: /spec → /build → /check → /ship — chay tot
2. 20 commands + 9 agents — da cover du use cases
3. Context loading: trust-graph → context-cache → CLAUDE.md → constitution
4. Auto-update cuoi phien: context-cache, git-nexus, memory, backup
5. .claude-shared repo: sync tri thuc cross-machine

### Diem yeu (CAN CAI TIEN)
1. **Moi task deu dung Opus** — task nhe cung ton $15/1M tokens
2. **Khong co model routing** — Claude Code chi co Opus hoac Sonnet
3. **Trust Graph chua tich hop** — ai-orchestrator chay rieng, Claude Code khong dung
4. **Review/Docs/Scan** — Opus overkill, model re lam tot 75-80%
5. **Hermes chua integrate** — chay Docker rieng, khong ket noi workflow

---

## 3 Cap do cai tien

### Cap 1: NGAY LAP TUC (0 cost, chi thay doi config)

**Claude Code da co san model switching:**
- `/fast` — toggle Fast mode (van la Opus nhung nhanh hon)  
- Subagent: `model: "sonnet"` trong Agent tool calls

**Cai tien:** Thay doi commands de dung subagent model phu hop.

Commands nen chuyen sang Sonnet (thay vi Opus):
- `/task` — task don le
- `/fix` (bug don gian) — 1 file  
- `/cleanup` — refactor
- `/plan` — plan nhanh
- `/docs` — documentation

**Cach thuc hien:** Them frontmatter `model: sonnet` vao cac commands tren.

---

### Cap 2: KHI CO API KEYS (can dang ky + cau hinh)

**Dung LiteLLM cho task khong can Claude Code agent loop:**

| Task | Chuyen sang | Cach goi |
|---|---|---|
| `/review` scan toan project | Gemini Flash qua LiteLLM | Script goi API |
| `/docs` viet JSDoc | DeepSeek qua LiteLLM | Script goi API |
| `/wire-memory` tong hop | Gemini Flash qua LiteLLM | Script goi API |
| `/security` OWASP scan | Gemini Flash qua LiteLLM | Script goi API |

**Cach thuc hien:** Tao wrapper scripts goi LiteLLM API tu trong commands.

---

### Cap 3: TICH HOP SAU (can dev them)

1. Trust Graph output → inject vao Claude Code context
2. Smart Router → tu dong chon model trong Claude Code subagents
3. Orchestrator Agent → chia feature lon thanh parallel subtasks
4. Cost tracking → dashboard real-time

---

## Chi tiet Cap 1 — Thuc hien ngay

### 1.1 Commands chuyen sang Sonnet subagent

Thay doi trong cac command files:

**`/task`** — Dung Agent tool voi model sonnet:
```yaml
---
name: task
description: "Task don le — Developer agent, dung Sonnet de tiet kiem"
user-invocable: true
agent: Developer
preferred-model: sonnet
---
```

**`/fix`** (bug don gian):
- Neu user mo ta bug ro rang (1 file, logic cu the) → route sang Sonnet
- Neu bug phuc tap (multi-file, khong biet root cause) → giu Opus

**`/cleanup`, `/docs`, `/plan`**:
- Doi sang Sonnet — khong can Opus cho cac task nay

### 1.2 Smart subagent routing trong commands

Them vao cac commands can routing:

```
Khi thuc hien task, DANH GIA truoc:
- Neu task chi lien quan 1-3 files, logic ro → dung Agent tool voi model: "sonnet"
- Neu task lien quan >5 files, can trace logic phuc tap → tu lam (Opus)
- Neu task chi la docs/comment/rename → dung Agent tool voi model: "haiku"
```

---

## Chi tiet Cap 2 — Khi co API keys

### 2.1 Script goi LiteLLM tu Claude Code

Tao utility script:

```bash
# E:/DEVELOP/ai-orchestrator/cli.sh
# Goi model qua LiteLLM tu command line

MODEL=${1:-default}  # default, smart, fast, cheap
PROMPT="$2"

curl -s http://localhost:4001/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\"}],\"max_tokens\":4000}" \
  | jq -r '.choices[0].message.content'
```

### 2.2 Commands goi LiteLLM cho task nhe

Trong `/review` command, them:
```
Neu task chi la scan code (khong can fix):
  → Chay: bash E:/DEVELOP/ai-orchestrator/cli.sh fast "Review code nay: {code}"
  → Parse ket qua va bao cao
```

### 2.3 Trust Graph inject vao context

Trong `/build` va `/fix` commands, them:
```
Truoc khi doc code, chay Trust Graph:
  → node E:/DEVELOP/ai-orchestrator/graph/query.js {project} {file} 15
  → Doc chi cac file trong ket qua (khong doc toan project)
  → Tiet kiem tokens, tang do chinh xac
```

---

## Chi tiet Cap 3 — Tich hop sau

### 3.1 Hook Trust Graph vao context loading

Thay doi Global CLAUDE.md section "Context Loading":

```
Khi bat dau lam viec voi 1 file cu the:
1. Chay: node E:/DEVELOP/ai-orchestrator/graph/query.js {project} {file} 15
2. Doc CHI cac file trong ket qua (thay vi grep toan project)
3. Giam context tu ~500 files → 10-15 files
```

### 3.2 Cost-aware model selection

Them vao Global CLAUDE.md:

```
Khi dung Agent tool (subagent), chon model theo task:
- model: "opus" — spec, architecture, debug >5 files
- model: "sonnet" — build, task, fix 1-3 files, review logic
- model: "haiku" — docs, comment, format, rename
```

### 3.3 LiteLLM integration cho batch tasks

Tao command `/batch-review`:
- Doc tat ca files thay doi (git diff)
- Goi Gemini Flash qua LiteLLM cho tung file
- Tong hop ket qua
- Chi phi: $0.01 thay vi $2 (Opus)

---

## Timeline khuyen nghi

| Tuan | Lam gi | Effort |
|---|---|---|
| **Ngay** | Cap 1: Them `model: "sonnet"` vao /task, /fix, /cleanup, /docs, /plan | 15 phut |
| **Khi co key** | Cap 2: Dang ky OpenRouter, test cli.sh, tich hop vao /review | 1 gio |
| **Tuan sau** | Cap 3: Hook Trust Graph, cost-aware routing, /batch-review | 2-3 gio |

---

## Models nen dang ky (thu tu uu tien)

### 1. OpenRouter — DANG KY TRUOC
- 1 key, 200+ models, $5 free credit
- Test duoc: Kimi K2.5, Gemini, DeepSeek, Sonnet
- https://openrouter.ai/keys

### 2. DeepSeek — Dang ky thu 2
- Free tier khong gioi han (nhung cham)
- Tot cho BE code, SQL, API
- https://platform.deepseek.com/api_keys

### 3. Gemini — Da co (nhung free tier qua it)
- Nang cap len paid ($0.15/1M) de bo gioi han 20 req/ngay
- Hoac dung qua OpenRouter

### 4. Kimi — Dang ky thu 3
- Free tier 15 req/ngay
- Tot cho FE code
- https://platform.moonshot.cn/console/api-keys
