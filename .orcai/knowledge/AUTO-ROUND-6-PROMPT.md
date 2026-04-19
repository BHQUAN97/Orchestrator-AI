# Auto Round 6 Prompt — Copy paste vào Claude Code session mới

> **Cách dùng**: Mở conversation mới với Claude Code. Paste TOÀN BỘ block prompt dưới đây vào prompt đầu tiên.
> Claude sẽ biết state hiện tại, đọc docs, chạy auto full pipeline, handle lỗi an toàn.

---

## PROMPT (copy từ đây)

```
Tôi muốn chạy Round 6 FT cho ai-orchestrator tại E:\DEVELOP\ai-orchestrator. 
Round 5.5 vừa xong 87.5% (175/200), muốn target 90%+ match Qwen 3.5-9B.

HÃY THỰC HIỆN TỰ ĐỘNG TẤT CẢ, KHÔNG HỎI TÔI TỪNG BƯỚC (ngoại trừ những decision gate quan trọng).

## BƯỚC 1 — Đọc tài liệu context TRƯỚC khi làm bất cứ gì

Đọc theo thứ tự (bắt buộc):
1. `C:\Users\buiho\.claude\projects\E--DEVELOP-ai-orchestrator\memory\phase-5-handoff-2026-04-19-complete.md` — state cuối Round 5.5
2. `.orcai/knowledge/LESSONS-ROUND-5.5-FT.md` — 10 bugs + fix
3. `.orcai/knowledge/AUTO-ROUND-RUNBOOK.md` — runbook chi tiết
4. `.orcai/knowledge/SESSION-2026-04-19-COMPLETE-SUMMARY.md` — summary
5. `scripts/round6-plan.md` — plan R6
6. Check current state: `curl -H "Authorization: Bearer $(cat ~/.runpod/api-key)" https://rest.runpod.io/v1/pods` (should be [])

## BƯỚC 2 — Pre-flight checklist

Verify các điều kiện:
- [ ] Balance RunPod ≥ $5 (hỏi user)
- [ ] FT v2 GGUF backup exist: `ls /e/DEVELOP/.claude-shared/models-backup/`
- [ ] Git repo clean or all changes committed: `cd /e/DEVELOP/ai-orchestrator && git status`
- [ ] Scripts cần có: deploy-pod-safe.sh, setup-pod.sh, monitor-smart.sh, cost-guardian.sh, tokenize-audit.py — check `ls scripts/`

Nếu thiếu bất kỳ điều kiện nào → DỪNG, báo user fix trước.

## BƯỚC 3 — Data audit (free, 1 phút)

```bash
cd /e/DEVELOP/ai-orchestrator
python3 scripts/tokenize-audit.py
cat .orcai/training/tokenize-audit.md
```

Parse `.orcai/training/tokenize-audit.json`:
- p95 < 2048 → báo user: "Data p95=X không cần tăng seq_len, Round 6 chỉ nên thử rank 32 + ORPO"
- p95 2048-4096 → set MAX_SEQ_LEN=4096
- p95 > 4096 → set MAX_SEQ_LEN=8192

Hỏi user confirm decision này.

## BƯỚC 4 — Backup FT v2 model trước (tránh mất)

```bash
mkdir -p /e/DEVELOP/.claude-shared/models-backup/
# Chỉ copy nếu chưa có
if [ ! -f /e/DEVELOP/.claude-shared/models-backup/qwen7b-ft-v2-Q4_K_M-pre-round6.gguf ]; then
  cp .orcai/ft-output-v2/qwen7b-ft-v2-Q4_K_M.gguf \
     /e/DEVELOP/.claude-shared/models-backup/qwen7b-ft-v2-Q4_K_M-pre-round6.gguf
fi
```

Commit git state:
```bash
cd /e/DEVELOP/ai-orchestrator
git status
# Nếu có uncommitted changes, commit với message "checkpoint before Round 6"
```

## BƯỚC 5 — Start cost guardian (background)

```bash
BALANCE=$(hỏi user: "Balance RunPod hiện tại bao nhiêu USD?")
nohup bash scripts/cost-guardian.sh --balance-start $BALANCE > /dev/null 2>&1 &
echo "cost-guardian PID=$!"
```

## BƯỚC 6 — Deploy pod an toàn

```bash
# Deploy 4090 với 80GB volume (dư cho merge)
bash scripts/deploy-pod-safe.sh "RTX 4090" 80
```

Check output:
- Exit 0 + POD_ID/POD_HOST/POD_PORT in `.orcai/pod-info.txt` → proceed
- Exit != 0 → STOP, báo user lỗi gì (spec fail, SSH fail, API fail)

## BƯỚC 7 — Setup pod deps

```bash
bash scripts/setup-pod.sh
# Expected: "SETUP OK"
```

Exit != 0 → STOP, retry once hoặc báo user.

## BƯỚC 8 — Upload + launch training

```bash
source .orcai/pod-info.txt
SSH_OPTS="-i ~/.ssh/id_ed25519 -p $POD_PORT -o ConnectTimeout=20 -o ServerAliveInterval=30"
SCP_OPTS="-i ~/.ssh/id_ed25519 -P $POD_PORT -o ConnectTimeout=60 -o ServerAliveInterval=30"

# Upload
ssh $SSH_OPTS root@$POD_HOST "mkdir -p /workspace/orchai/{scripts,.orcai/training,.orcai/ft-output}"
scp $SCP_OPTS .orcai/training/*.jsonl root@$POD_HOST:/workspace/orchai/.orcai/training/
scp $SCP_OPTS scripts/train-lora-qwen7b-v2.py scripts/merge-lora-7b-v2.py \
    scripts/convert-to-gguf-v2.sh scripts/pod-run-pipeline-v2.sh \
    root@$POD_HOST:/workspace/orchai/scripts/

# Launch training với args Round 6:
MAX_SEQ_LEN=$MAX_SEQ_LEN  # từ bước 3
LORA_RANK=32              # Round 6 bump lên 32
EPOCHS=3

ssh $SSH_OPTS root@$POD_HOST "cd /workspace/orchai && \
  source /workspace/setup-env.sh && \
  setsid nohup bash scripts/pod-run-pipeline-v2.sh \
    --max-seq-len $MAX_SEQ_LEN \
    --lora-rank $LORA_RANK \
    --epochs $EPOCHS \
    >/dev/null 2>&1 & disown"
```

(Hoặc ssh launch direct python3 train script — adapt theo pod-run-pipeline-v2.sh hiện tại)

## BƯỚC 9 — Monitor smart (background)

```bash
nohup bash scripts/monitor-smart.sh $POD_ID qwen7b-ft-v2-Q4_K_M.gguf 786 > /dev/null 2>&1 &
MONITOR_PID=$!
echo "monitor PID=$MONITOR_PID"
```

## BƯỚC 10 — Setup wake trigger cho bạn

```bash
# Watch for bench-ft-v2-result.md appear OR monitor log shows FAIL/TIMEOUT
until [ -f .orcai/ft-output-v2/bench-ft-v2-result.md ] || \
      grep -qE "FAILED|TIMEOUT" .orcai/monitor.log 2>/dev/null; do
  sleep 60
done
# Notify user
```

Run trong background (run_in_background: true), timeout 10h.

## BƯỚC 11 — Post-training auto (khi wake trigger fire)

Nếu bench-ft-v2-result.md xuất hiện → pipeline OK:
1. Check score từ result file
2. Import vào LM Studio
3. Local bench với local-heavy identifier
4. Write leaderboard compare
5. Update memory:
   - `C:\Users\buiho\.claude\projects\E--DEVELOP-ai-orchestrator\memory\phase-5-handoff-YYYY-MM-DD-round6.md`
   - Update MEMORY.md index
6. Push `.claude-shared`
7. Commit ai-orchestrator repo với bench result

Nếu log FAILED/TIMEOUT → pipeline fail:
1. Download pipeline.log
2. KHÔNG tự terminate pod (monitor-smart.sh đã đảm bảo)
3. Phân tích log, báo user root cause
4. Đề xuất: (a) retry manually, (b) deploy new pod, (c) accept failure
5. User quyết → tôi action

## BƯỚC 12 — Cleanup nếu user confirm done

```bash
# Stop cost guardian
bash scripts/cost-guardian.sh --stop

# Verify 0 pods
KEY=$(cat ~/.runpod/api-key)
curl -sS -H "Authorization: Bearer $KEY" https://rest.runpod.io/v1/pods | head -c 100

# Final cost report
cat .orcai/cost-tracker.json
```

## RULES TỒN TẠI CẢ ROUND

1. **Không auto-kill pod** trên fail — chỉ terminate khi success + integrity OK
2. **Cost alert ≥ $5** → báo user, chờ approve trước khi tiếp
3. **GPU choice**: 4090 default (nhanh hơn 4000 Ada 3x, giá 2.65x)
4. **Volume disk ≥ 60GB** — deploy reject nếu nhỏ hơn
5. **Dynamic timeout** từ step rate, không hardcode
6. **Port query via API** mỗi lần SSH, không hardcoded
7. **Backup GGUF cũ** trước khi start Round 6
8. **Commit git** trước khi chạy để rollback được

## BUDGET

- Expected cost: $3-5
- Hard stop: $7 (user confirm nếu vượt)
- Emergency: $10 auto-terminate

Bắt đầu ngay, làm tuần tự, báo tôi khi đến decision gate hoặc khi xong.
```

---

## PROMPT variants

### Variant A: Chỉ train, không bench sau

Thay bước 11 bằng:
```
Khi training + merge + convert + download xong, terminate pod. KHÔNG bench local. 
Chờ tôi bench thủ công.
```

### Variant B: Chạy với budget tight $3

Thêm vào BUDGET section:
```
Nếu cost > $2.50 (83% budget) và chưa đến stage merge:
- Đề xuất abort và deploy lại pod nhỏ hơn / cheaper GPU
```

### Variant C: ORPO pass sau SFT

Thêm vào sau bước 11:
```
Sau bench SFT, nếu score < 90% và user confirm:
- Collect 300-500 preference pairs (v2 vs 3.5-9B) 
- Run ORPO script (tôi sẽ tạo thêm)
- Bench lại sau ORPO
```

---

## Notes

- File này self-contained, paste là chạy
- Claude sẽ tự đọc 5 docs khác, không cần user explain thêm
- User chỉ cần: balance số, confirm decision gate, chờ kết quả
- Tổng thời gian expected: 4-8h tuỳ config
- User có thể ngủ sau khi pass BƯỚC 9
