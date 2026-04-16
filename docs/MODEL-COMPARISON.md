# So sanh Model — Dat 80-90% Claude Code (Opus)

> Danh gia thuc te dua tren stack: Next.js + NestJS + TypeORM + MySQL

---

## Bang so sanh tong the

| Kha nang | Claude Opus (100%) | Sonnet 4.6 | Kimi K2.5 | Gemini 2.5 Flash | DeepSeek V3 |
|---|---|---|---|---|---|
| **Multi-file edit** | ★★★★★ | ★★★★☆ (85%) | ★★★☆☆ (65%) | ★★☆☆☆ (40%) | ★★★☆☆ (60%) |
| **Architecture/Spec** | ★★★★★ | ★★★★☆ (80%) | ★★★☆☆ (55%) | ★★★☆☆ (60%) | ★★★☆☆ (55%) |
| **NestJS backend** | ★★★★★ | ★★★★☆ (85%) | ★★★★☆ (75%) | ★★★☆☆ (60%) | ★★★★☆ (80%) |
| **Next.js frontend** | ★★★★★ | ★★★★☆ (85%) | ★★★★☆ (80%) | ★★★☆☆ (55%) | ★★★☆☆ (60%) |
| **TypeORM/DB** | ★★★★★ | ★★★★☆ (85%) | ★★★☆☆ (65%) | ★★★☆☆ (55%) | ★★★★☆ (80%) |
| **Debug complex** | ★★★★★ | ★★★★☆ (80%) | ★★☆☆☆ (45%) | ★★★☆☆ (50%) | ★★★☆☆ (55%) |
| **Code review** | ★★★★★ | ★★★★☆ (85%) | ★★★☆☆ (65%) | ★★★★☆ (75%) | ★★★☆☆ (65%) |
| **Docs/Comment** | ★★★★★ | ★★★★☆ (90%) | ★★★★☆ (80%) | ★★★★☆ (85%) | ★★★★☆ (85%) |
| **Follow instructions** | ★★★★★ | ★★★★☆ (90%) | ★★★☆☆ (65%) | ★★★☆☆ (60%) | ★★★☆☆ (55%) |
| **Tool use (agentic)** | ★★★★★ | ★★★★☆ (85%) | ★★★☆☆ (60%) | ★★★☆☆ (55%) | ★★☆☆☆ (40%) |
| **Context window** | 200K | 200K | 128K | **1M** | 128K |
| **Cost (input/1M)** | $15 | **$3** | **$1** | **$0.15** | **$0.27** |

## Ket luan model

### Dat 85-90%: **Claude Sonnet 4.6**
- Gan nhu tuong duong Opus cho hau het coding tasks
- Yeu hon: architecture phuc tap, debug nhieu layer
- **Re hon 5x** — $3 vs $15 per 1M input
- **CUNG chay trong Claude Code** — chi can `/fast` hoac `--model sonnet`

### Dat 75-80% cho FE: **Kimi K2.5**
- Tot cho React/Next.js/Vue/Tailwind
- Yeu: multi-file edit, follow complex instructions
- **Re hon 15x**

### Dat 75-80% cho BE: **DeepSeek V3**
- Tot cho NestJS/Express/TypeORM/SQL
- Yeu: tool use, agentic workflow
- **Re hon 55x**

### Dat 70-75% cho review/scan: **Gemini 2.5 Flash**
- Context 1M — doc duoc toan bo project
- Nhanh, re, tot cho pattern matching
- Yeu: code generation, complex logic
- **Re hon 100x**

---

## Khuyen nghi cho tung command

| Command | Model khuyen nghi | % vs Opus | Ly do |
|---|---|---|---|
| `/spec` | **Opus** (giu nguyen) | 100% | Can reasoning sau, khong tiet kiem duoc |
| `/build` (feature lon) | **Opus** (giu nguyen) | 100% | Multi-file edit, follow spec |
| `/build` (feature nho) | **Sonnet** | 85% | 1-3 files, logic ro |
| `/task` | **Sonnet** | 85% | Task don le, ro rang |
| `/fix` (bug phuc tap) | **Opus** | 100% | Trace across layers |
| `/fix` (bug don gian) | **Sonnet** | 85% | 1 file, logic ro |
| `/debug` | **Opus** | 100% | Can reasoning sau |
| `/check` | **Sonnet** | 85% | Review logic + constitution |
| `/review` | **Gemini Flash** (qua LiteLLM) | 75% | Scan pattern, re |
| `/security` | **Gemini Flash** (qua LiteLLM) | 75% | OWASP pattern matching |
| `/docs` | **DeepSeek** (qua LiteLLM) | 80% | Text generation |
| `/cleanup` | **Sonnet** | 85% | Refactor can hieu context |
| `/wire-memory` | **Gemini Flash** (qua LiteLLM) | 80% | Summarize, re |
| `/ui-test` | **Gemini Flash** (qua LiteLLM) | 70% | Multimodal |
| `/morning` | **Opus** (giu nguyen) | 100% | Doc nhieu project, orchestrate |
| `/plan` | **Sonnet** | 85% | Plan nho |
| `/perf` | **Opus** | 100% | Profile + fix can reasoning |

### Uoc tinh tiet kiem

| Scenario | Chi Opus | Optimized | Tiet kiem |
|---|---|---|---|
| 1 ngay lam viec binh thuong | ~$10 | ~$4 | 60% |
| Build 1 feature lon | ~$5 | ~$3 | 40% |
| Review + docs 1 project | ~$3 | ~$0.50 | 83% |
| Morning + plan + task nho | ~$2 | ~$0.80 | 60% |
