# Port Map — Tat ca projects

> QUAN TRONG: Check file nay TRUOC khi assign port moi
> Moi project co dai port rieng — KHONG BAO GIO conflict

## Bang tong hop

| Port | Service | Project |
|---|---|---|
| **1234** | LM Studio (local model) | System (chua start) |
| **3306** | MySQL | WebPhoto |
| **3307** | MySQL | VIETNET |
| **3309** | MySQL | FashionEcom |
| **5000** | Hermes Agent (Brain) | ai-orchestrator |
| **5001** | Hermes WebUI (Mobile) | ai-orchestrator |
| **5002** | LiteLLM Proxy + Dashboard | ai-orchestrator |
| **5003** | Orchestrator REST API | ai-orchestrator |
| **5004** | Analytics + Cost Dashboard | ai-orchestrator |
| **5100** | Nginx HTTP | VietNet2026 |
| **5101** | Nginx HTTPS | VietNet2026 |
| **5102** | Backend (NestJS) | VietNet2026 |
| **5200** | Nginx HTTP | LeQuyDon |
| **5201** | Nginx HTTPS | LeQuyDon |
| **5202** | Backend (NestJS) | LeQuyDon |
| **5300** | Frontend (Next.js) | FashionEcom |
| **5301** | Backend (NestJS) | FashionEcom |
| **5400** | API (Express) | VIETNET |
| **5401** | Frontend | VIETNET |
| **5402** | Adminer | VIETNET |
| **6379** | Redis | WebPhoto |
| **6382** | Redis | FashionEcom |

## Dai port theo project

| Project | Dai port | Chi tiet |
|---|---|---|
| **ai-orchestrator** | 5000-5009 | Hermes, WebUI, LiteLLM, Orchestrator API, Analytics |
| **VietNet2026** | 5100-5199 | 5100 HTTP, 5101 HTTPS, 5102 BE |
| **LeQuyDon** | 5200-5299 | 5200 HTTP, 5201 HTTPS, 5202 BE |
| **FashionEcom** | 5300-5399 | 5300 FE, 5301 BE, 3309 MySQL, 6382 Redis |
| **VIETNET** | 5400-5499 | 5400 API, 5401 FE, 5402 Adminer, 3307 MySQL |
| **WebPhoto** | 3306, 6379 | MySQL, Redis (giu nguyen vi dang chay) |
| **System** | 1234, 8000, 9001 | LM Studio, unknown, unknown |

## ai-orchestrator services (v2.1)

```
5000  Hermes Agent (Brain)       — Memory, Vector DB, Auto-learn, Web UI
5001  Hermes WebUI               — Mobile-friendly dashboard
5002  LiteLLM Proxy              — API Gateway, model routing, cost tracking
5003  Orchestrator API           — Scan, Plan, Route, Execute, Budget
5004  Analytics + Dashboard      — Cost tracking, daily/monthly trends
5005-5009                        — Reserved (future services)
```

## Kien truc Hermes + Orchestrator

```
User (Mobile/PC)
  ↓
Hermes Brain (:5000)
  ├── Memory: vector DB, long-term knowledge
  ├── Skills: auto-learn, self-improve
  ├── Decision: chon skill/action phu hop
  │
  ├── Task phuc tap ──→ Orchestrator API (:5003)
  │     ├── Scanner (cheap) → quet project
  │     ├── Planner (default) → xay dung plan
  │     ├── Tech Lead (smart) → review plan
  │     ├── Execute (multi-model) → build/fix
  │     └── Budget guard ($2/ngay)
  │
  ├── Task don gian ──→ LiteLLM truc tiep (:5002)
  │
  └── Analytics (:5004) ← track tat ca API calls

LiteLLM (:5002) ──→ OpenRouter / Gemini API
```

## Dai trong — an toan de dung

| Dai | Goi y |
|---|---|
| 5005-5009 | ai-orchestrator reserved |
| 5500-5999 | Project moi |
| 6380-6381, 6383+ | Redis instances moi |
| 9090 | Prometheus |
| 9091 | Grafana |
