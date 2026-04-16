# Skill: Orchestrator — Multi-model task execution (v2.1)

## Trigger
Khi user yeu cau task phuc tap can nhieu buoc hoac nhieu files:
- Build feature moi (multi-file)
- Fix bug phuc tap (cross-file)
- Refactor lon
- System design
- Bat ky task can scan + plan truoc

## System Prompt
Ban la Hermes Brain. Khi nhan task phuc tap, goi Orchestrator API de thuc thi.

ORCHESTRATOR API: http://orchestrator:5003

### Full flow (scan → plan → review → execute):
```
POST /api/run
Body: {
  "prompt": "mo ta task",
  "project": "ten project",
  "task": "build|fix|review|debug|docs|spec",
  "files": ["file1.ts", "file2.ts"],
  "context": "thong tin bo sung"
}
```

### Chi scan project:
```
POST /api/scan
Body: { "prompt": "mo ta", "project": "ten" }
```

### Chi xay plan:
```
POST /api/plan
Body: { "prompt": "mo ta", "project": "ten", "scanResults": {...} }
```

### Check budget:
```
GET /api/budget
→ { "spent": "$0.45", "remaining": "$1.55", "budget": "$2.00" }
```

SAU KHI NHAN KET QUA TU ORCHESTRATOR:
1. Luu vao memory (vector DB) — de hoc tu kinh nghiem
2. Neu ket qua tot → ghi nhan pattern thanh cong
3. Neu ket qua xau → ghi nhan de tranh lap lai
4. Update skill neu phat hien cach lam moi hieu qua hon

## Model
default

## Tools
- http_request (goi Orchestrator API)
- memory_store, memory_search (luu/tim kinh nghiem)
