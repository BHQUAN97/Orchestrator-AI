# Port Map — Tat ca projects

> QUAN TRONG: Check file nay TRUOC khi assign port moi
> Moi project co dai port rieng — KHONG BAO GIO conflict

## Bang tong hop

| Port | Service | Project |
|---|---|---|
| **1234** | LM Studio (local model) | System (chua start) |
| **3000** | Hermes Agent Dashboard | ai-orchestrator |
| **3306** | MySQL | WebPhoto |
| **3307** | MySQL | VIETNET |
| **3309** | MySQL | FashionEcom |
| **4001** | LiteLLM Proxy + Dashboard | ai-orchestrator |
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
| **9080** | Orchestrator Dashboard | ai-orchestrator |
| **9081** | Analytics API + Cost Tracking | ai-orchestrator |

## Dai port theo project

| Project | Dai port | Chi tiet |
|---|---|---|
| **ai-orchestrator** | 3000, 4001, 9080 | Hermes, LiteLLM, Dashboard |
| **VietNet2026** | 5100-5199 | 5100 HTTP, 5101 HTTPS, 5102 BE |
| **LeQuyDon** | 5200-5299 | 5200 HTTP, 5201 HTTPS, 5202 BE |
| **FashionEcom** | 5300-5399 | 5300 FE, 5301 BE, 3309 MySQL, 6382 Redis |
| **VIETNET** | 5400-5499 | 5400 API, 5401 FE, 5402 Adminer, 3307 MySQL |
| **WebPhoto** | 3306, 6379 | MySQL, Redis (giu nguyen vi dang chay) |
| **System** | 1234, 8000, 9001 | LM Studio, unknown, unknown |

## Dai trong — an toan de dung

| Dai | Goi y |
|---|---|
| 3001-3099 | AI agents moi |
| 4002-4099 | Proxy/Gateway moi |
| 5500-5999 | Project moi |
| 6380-6381, 6383+ | Redis instances moi |
| 9081-9099 | Monitoring dashboards |
| 9090 | Prometheus |
| 9091 | Grafana |
