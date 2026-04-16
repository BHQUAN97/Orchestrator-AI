# Huong dan su dung AI Orchestrator v2.1

> Tu khi mo may tinh den khi dung thanh thao

---

## Muc luc

1. [Mo may tinh — Khoi dong](#1-mo-may-tinh--khoi-dong)
2. [Cau hinh lan dau (chi lam 1 lan)](#2-cau-hinh-lan-dau-chi-lam-1-lan)
3. [Start he thong hang ngay](#3-start-he-thong-hang-ngay)
4. [Su dung qua Hermes Web UI (PC)](#4-su-dung-qua-hermes-web-ui-pc)
5. [Su dung qua Mobile](#5-su-dung-qua-mobile)
6. [Su dung qua CLI (Terminal)](#6-su-dung-qua-cli-terminal)
7. [Su dung qua Orchestrator API truc tiep](#7-su-dung-qua-orchestrator-api-truc-tiep)
8. [Kiem tra budget va chi phi](#8-kiem-tra-budget-va-chi-phi)
9. [Ket thuc ngay lam viec](#9-ket-thuc-ngay-lam-viec)
10. [Xu ly loi thuong gap](#10-xu-ly-loi-thuong-gap)
11. [Tips va best practices](#11-tips-va-best-practices)

---

## 1. Mo may tinh — Khoi dong

### Buoc 1: Mo Docker Desktop

```
1. Mo Docker Desktop tu Start menu (hoac taskbar)
2. Doi cho den khi icon Docker o system tray chuyen xanh (running)
3. Mat khoang 30-60 giay
```

### Buoc 2: Kiem tra Docker da san sang

Mo Terminal (PowerShell hoac Git Bash):

```bash
docker info
```

Neu thay thong tin Docker → san sang. Neu loi → Docker chua start xong.

---

## 2. Cau hinh lan dau (chi lam 1 lan)

### 2.1 Tao file .env

```bash
cd E:\DEVELOP\ai-orchestrator
copy .env.example .env
```

### 2.2 Dien API keys

Mo file `.env` va dien 2 key BAT BUOC:

```env
# BAT BUOC — dang ky tai https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxx

# BAT BUOC — dang ky tai https://aistudio.google.com/apikey
GEMINI_API_KEY=AIzaxxxxxxxxx
```

> OpenRouter cho truy cap: Opus, Sonnet, DeepSeek, GPT Mini, Kimi
> Gemini key cho truy cap: Gemini 3 Flash (direct, nhanh hon qua OpenRouter)

### 2.3 Pull Docker images (lan dau mat ~5 phut)

```bash
cd E:\DEVELOP\ai-orchestrator
docker compose pull
```

### 2.4 Install npm dependencies (neu chua)

```bash
npm install
```

### 2.5 Test nhanh

```bash
# Start he thong
start.bat

# Test LiteLLM
curl http://localhost:5002/health

# Test Orchestrator API
curl http://localhost:5003/health

# Test goi model
curl http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"hello"}]}'
```

---

## 3. Start he thong hang ngay

### Cach 1: Double-click start.bat (khuyen dung)

```
1. Mo File Explorer → E:\DEVELOP\ai-orchestrator
2. Double-click start.bat
3. Doi ~30 giay cho tat ca services khoi dong
4. Tu dong mo Hermes trong browser
```

### Cach 2: Terminal

```bash
cd E:\DEVELOP\ai-orchestrator
docker compose up -d
```

### Kiem tra tat ca services dang chay

```bash
docker compose ps
```

Ket qua mong doi:

```
NAME                STATUS
orcai-litellm       running (healthy)
orcai-hermes        running
orcai-webui         running
orcai-orchestrator  running (healthy)
orcai-analytics     running
orcai-trustgraph    running
```

### URLs sau khi start

| URL | Service | Dung cho |
|-----|---------|----------|
| http://localhost:5000 | Hermes Brain | Chat, memory, skills |
| http://localhost:5001 | Hermes WebUI | Mobile-friendly UI |
| http://localhost:5002/ui | LiteLLM Dashboard | Xem models, logs, cost |
| http://localhost:5003 | Orchestrator API | REST API endpoints |
| http://localhost:5004 | Analytics | Cost tracking dashboard |

---

## 4. Su dung qua Hermes Web UI (PC)

### 4.1 Mo Hermes

Mo browser → `http://localhost:5000`

### 4.2 Chat truc tiep (task don gian)

Hermes tu chon model phu hop. Chi viec noi:

```
fix bug login trong FashionEcom
```

```
review file src/auth/auth.service.ts trong LeQuyDon
```

```
viet JSDoc cho toan bo utils/ trong VietNet2026
```

### 4.3 Goi Orchestrator (task phuc tap)

Voi task lon (multi-file, can plan), Hermes tu dong goi Orchestrator. Hoac ban co the yeu cau ro:

```
Dung orchestrator: build feature login voi JWT auth cho FashionEcom
```

Hermes se:
1. Goi `POST :5003/api/run`
2. Orchestrator scan project → plan → review → execute
3. Tra ket qua ve Hermes
4. Hermes luu vao memory de hoc

### 4.4 Xem memory cua Hermes

```
xem memory ve FashionEcom
```

```
tim tat ca bugs da fix truoc do
```

Hermes search vector DB va tra ve ket qua lien quan.

### 4.5 Cai tien skills

```
skill developer dang hoat dong tot khong?
```

```
update skill reviewer: them check cho N+1 query
```

Hermes se tu dong update skill files.

---

## 5. Su dung qua Mobile

### 5.1 Truy cap

Mo browser tren dien thoai:
```
http://<IP-may-PC>:5001
```

> Tim IP may PC: mo Terminal → `ipconfig` → tim IPv4 Address (vd: 192.168.1.100)
> URL: `http://192.168.1.100:5001`

### 5.2 Tuong tu nhu PC

Giao dien WebUI da toi uu cho mobile. Su dung giong nhu Hermes tren PC.

---

## 6. Su dung qua CLI (Terminal)

### 6.1 OrcAI CLI — Interactive mode

```bash
cd E:\DEVELOP\ai-orchestrator
node bin/orcai.js -i -p E:\DEVELOP\FashionEcom
```

Hoac chi dinh model:

```bash
# Dung Sonnet cho debug phuc tap
node bin/orcai.js -i -p E:\DEVELOP\FashionEcom -m smart -r debugger

# Dung DeepSeek cho build nhanh
node bin/orcai.js -i -p E:\DEVELOP\LeQuyDon -m default -r builder
```

### 6.2 OrcAI CLI — One-shot mode

```bash
# Fix bug nhanh
node bin/orcai.js -p E:\DEVELOP\FashionEcom "fix bug upload avatar bi loi"

# Review code
node bin/orcai.js -p E:\DEVELOP\LeQuyDon -m fast -r reviewer "review src/auth/"
```

### 6.3 Slash commands trong interactive mode

```
/stats    — Xem thong ke tool calls
/files    — Xem files da thay doi
/undo     — Hoan tac thay doi cuoi
/sessions — Xem lich su sessions
/help     — Hien help
/exit     — Thoat
```

### 6.4 CLI scripts nhanh

```bash
# Goi model truc tiep (khong qua Orchestrator)
bash cli.sh fast "explain this code: function hello() { return 'world'; }"

# Goi voi analytics tracking
bash ask.sh smart "thiet ke database cho blog" FashionEcom spec
```

---

## 7. Su dung qua Orchestrator API truc tiep

### 7.1 Full flow (khuyen dung)

```bash
curl -X POST http://localhost:5003/api/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "build login page voi JWT auth",
    "project": "FashionEcom",
    "task": "build",
    "files": ["src/auth/login.tsx", "src/api/auth.service.ts"]
  }'
```

Response:
```json
{
  "success": true,
  "summary": "Da tao login page + auth endpoint...",
  "subtasks": 3,
  "escalations": 0,
  "models_used": ["default", "fast"],
  "elapsed_ms": 15000,
  "budget": { "spent": "$0.08", "remaining": "$1.92" }
}
```

### 7.2 Chi scan project

```bash
curl -X POST http://localhost:5003/api/scan \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "tim tat ca auth-related files",
    "project": "FashionEcom"
  }'
```

### 7.3 Chi xay plan (khong execute)

```bash
curl -X POST http://localhost:5003/api/plan \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "refactor auth module sang middleware pattern",
    "project": "LeQuyDon",
    "task": "build"
  }'
```

### 7.4 Check budget

```bash
curl http://localhost:5003/api/budget
```

Response:
```json
{
  "date": "2026-04-16",
  "spent": "$0.45",
  "remaining": "$1.55",
  "budget": "$2.00",
  "percent": "23%",
  "calls": {
    "cheap": { "count": 5, "tokens": 12000, "cost": 0.006 },
    "default": { "count": 3, "tokens": 9000, "cost": 0.007 },
    "smart": { "count": 1, "tokens": 4000, "cost": 0.036 }
  }
}
```

### 7.5 Smart routing (chon model cho task)

```bash
curl -X POST http://localhost:5003/api/route \
  -H "Content-Type: application/json" \
  -d '{
    "task": "build",
    "files": ["src/components/Login.tsx"],
    "prompt": "tao form login voi validation"
  }'
```

### 7.6 Xem thong ke

```bash
curl http://localhost:5003/api/stats
curl http://localhost:5003/api/models
```

---

## 8. Kiem tra budget va chi phi

### 8.1 Budget hien tai

```bash
curl http://localhost:5003/api/budget
```

### 8.2 Analytics dashboard

Mo browser → `http://localhost:5004`

Xem:
- Chi phi theo ngay/tuan/thang
- Chi phi theo model (architect/smart/default/fast/cheap)
- Chi phi theo project
- So sanh: dung Opus cho tat ca vs multi-model

### 8.3 LiteLLM dashboard

Mo browser → `http://localhost:5002/ui`
Login: admin / admin

Xem:
- Tat ca API calls
- Token usage per model
- Error rates
- Rate limits

### 8.4 Budget guard tu dong

Khi chi phi gan $2/ngay:
- Orchestrator **tu dong downgrade** model: architect → smart → default → fast → cheap
- Neu het sach → tra loi loi, khong goi API nua
- Reset luc 00:00 moi ngay

---

## 9. Ket thuc ngay lam viec

### Cach 1: Double-click stop.bat

```
1. Mo File Explorer → E:\DEVELOP\ai-orchestrator
2. Double-click stop.bat
3. Doi ~10 giay cho tat ca services dung
```

### Cach 2: Terminal

```bash
cd E:\DEVELOP\ai-orchestrator
docker compose down
```

> Hermes memory KHONG mat khi stop — luu trong Docker volume `hermes_data`

---

## 10. Xu ly loi thuong gap

### Docker khong start

```
Van de: "docker: command not found" hoac "Cannot connect to Docker daemon"
Fix: Mo Docker Desktop truoc, doi icon xanh, roi thu lai
```

### LiteLLM health check fail

```bash
# Check logs
docker compose logs litellm --tail 50

# Thuong do: .env thieu API key
# Fix: kiem tra .env co OPENROUTER_API_KEY va GEMINI_API_KEY
```

### Orchestrator API khong phan hoi

```bash
# Check logs
docker compose logs orchestrator --tail 50

# Thuong do: LiteLLM chua san sang
# Fix: doi LiteLLM healthy truoc, roi restart orchestrator
docker compose restart orchestrator
```

### Model tra loi loi "budget exhausted"

```bash
# Check budget
curl http://localhost:5003/api/budget

# Neu het budget → doi sang ngay mai (tu dong reset)
# Hoac tang budget trong .env:
# DAILY_BUDGET=3.00
# Roi restart: docker compose restart orchestrator
```

### Hermes khong nho gi

```bash
# Check hermes data volume
docker volume inspect ai-orchestrator_hermes_data

# Neu mat data → tao lai volume
docker compose down -v  # CANH BAO: xoa tat ca data
docker compose up -d
```

### Port bi conflict

```bash
# Tim process dang dung port
netstat -ano | findstr :5000

# Kill process do (thay PID)
taskkill /PID <PID> /F

# Hoac doi port trong .env
HERMES_PORT=5010
```

---

## 11. Tips va best practices

### Tiet kiem chi phi

1. **Task don gian → noi truc tiep voi Hermes** (khong can Orchestrator)
2. **Chi goi Orchestrator khi task phuc tap** (multi-file, can plan)
3. **Tranh dung architect tier** tru khi that su can system design
4. **Scan truoc, plan sau** — giam ao giac, tiet kiem retry

### Model nao cho viec nao

| Task | Model/Tier | Chi phi |
|------|-----------|---------|
| Hoi nhanh, giai thich code | fast (Gemini) | ~$0.001 |
| Viet docs, comment | cheap (GPT Mini) | ~$0.002 |
| Build feature 1-3 files | default (DeepSeek) | ~$0.003 |
| Debug phuc tap, review plan | smart (Sonnet) | ~$0.03 |
| System design, kien truc | architect (Opus) | ~$0.15 |

### Workflow khuyen dung hang ngay

```
Sang:
  1. Mo may → start.bat
  2. Mo Hermes (localhost:5000)
  3. "scan project FashionEcom — co gi moi?"
  4. Bat dau lam viec

Trong ngay:
  5. Task don gian → chat Hermes truc tiep
  6. Task phuc tap → "dung orchestrator: build feature X"
  7. Review code → "review file Y"
  8. Check budget → "budget con bao nhieu?"

Toi:
  9. "tong ket hom nay da lam gi?"
  10. stop.bat
```

### Hermes cang dung cang gioi

- Hermes **tu hoc** tu moi conversation
- **Luu pattern** thanh cong/that bai vao vector DB
- **Tu update skill** khi phat hien cach lam moi tot hon
- **Tim kiem** kinh nghiem cu khi gap van de tuong tu
- → Sau 1-2 tuan su dung, Hermes se biet project cua ban rat ro

---

## Quick Reference Card

```
START:    start.bat    (hoac: docker compose up -d)
STOP:     stop.bat     (hoac: docker compose down)

HERMES:   http://localhost:5000     (Brain — chat, memory)
MOBILE:   http://localhost:5001     (WebUI cho dien thoai)
LITELLM:  http://localhost:5002/ui  (Model dashboard)
API:      http://localhost:5003     (Orchestrator REST API)
COST:     http://localhost:5004     (Analytics dashboard)

BUDGET:   $2/ngay — tu dong downgrade khi gan het
MODELS:   architect > smart > default > fast > cheap
CLI:      node bin/orcai.js -i -p <project_path>
```
