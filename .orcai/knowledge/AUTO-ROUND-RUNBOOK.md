# Auto Round N+ Runbook — Phase 5 Continue

> **Purpose**: Template an toàn để chạy FT Round tiếp theo mà không lặp 10 bugs session 2026-04-19.
> **Reference**: `LESSONS-ROUND-5.5-FT.md` + `SESSION-2026-04-19-COMPLETE-SUMMARY.md`
> **Last updated**: 2026-04-19 23:30 local

---

## Trước khi chạy — Pre-flight (USER làm)

### 1. Commit + backup model cũ (5 phút)

```bash
cd /e/DEVELOP/ai-orchestrator
# Commit code changes hiện tại
git status
git add <files>
git commit -m "checkpoint before Round N"

# Backup GGUF hiện tại (4.4GB) ra ngoài git
mkdir -p /e/DEVELOP/.claude-shared/models-backup/
cp .orcai/ft-output-v2/qwen7b-ft-v2-Q4_K_M.gguf \
   /e/DEVELOP/.claude-shared/models-backup/qwen7b-ft-v2-Q4_K_M-$(date +%Y%m%d).gguf
# Note: models-backup đã gitignored để tránh push 4GB lên github
```

### 2. Verify checklist

- [ ] Balance RunPod ≥ $5 (`curl -H "Authorization: Bearer $(cat ~/.runpod/api-key)" https://rest.runpod.io/v1/pods` hoạt động)
- [ ] SSH key đã upload RunPod Settings
- [ ] Auto-Pay: OFF (tránh silent charge)
- [ ] GGUF model cũ đã backup (bước 1)
- [ ] Local disk ≥ 20GB free (download GGUF mới)
- [ ] LM Studio closed (tránh chiếm VRAM lúc bench cuối)

### 3. Decision gate: nên chạy Round này?

Trước khi click go:
- [ ] Rõ hypothesis gì test? (VD: "tăng MAX_SEQ_LEN sẽ +1pt")
- [ ] Expected gain ≥ 1pt? (dưới 1pt = noise, không đáng)
- [ ] Budget cho round này? ($3-5 OK, $10+ cần suy nghĩ)
- [ ] Có script fix cho các bug cũ chưa? (deploy-pod-safe, monitor-smart, etc.)

---

## Auto-run Phase (tôi có thể tự làm)

### Stage 0: Cost guardian (async background)

```bash
# Start cost guardian trước — ngay khi có balance
cd /e/DEVELOP/ai-orchestrator
nohup bash scripts/cost-guardian.sh --balance-start $BALANCE_USD > /dev/null 2>&1 &
echo "cost-guardian started"
```

### Stage 1: Data audit (1 phút, free)

```bash
# Check data length distribution
python3 scripts/tokenize-audit.py

# Output: .orcai/training/tokenize-audit.md + .json
# Rule auto-decide:
#   p95 < 2048 → MAX_SEQ_LEN=2048
#   p95 2048-4096 → MAX_SEQ_LEN=4096
#   p95 > 4096 → MAX_SEQ_LEN=8192
```

Parse `.orcai/training/tokenize-audit.json` → set `MAX_SEQ_LEN`.

### Stage 2: Deploy pod an toàn (5 phút)

```bash
# Auto deploy + verify spec
bash scripts/deploy-pod-safe.sh "RTX 4090" 80
# Creates .orcai/pod-info.txt with POD_ID, POD_HOST, POD_PORT
```

Script sẽ:
- Reject nếu volume < 60GB
- Verify memory >= 30GB, vCPU >= 4 sau deploy
- Tự terminate nếu spec fail (tránh pod 488MB dùng tiền vô ích)
- Wait SSH sẵn sàng

Exit code != 0 → STOP, không tiếp tục.

### Stage 3: Setup pod (3 phút)

```bash
# Install deps vào /workspace/pypkgs (persist qua migration)
bash scripts/setup-pod.sh
```

Sau bước này, deps ở `/workspace/pypkgs`, source `/workspace/setup-env.sh` khi dùng.

### Stage 4: Upload + launch training (5 phút)

```bash
source .orcai/pod-info.txt  # POD_ID, POD_HOST, POD_PORT
SSH_OPTS="-i ~/.ssh/id_ed25519 -p $POD_PORT -o ConnectTimeout=20"
SCP_OPTS="-i ~/.ssh/id_ed25519 -P $POD_PORT -o ConnectTimeout=60"

# Upload data + scripts
ssh $SSH_OPTS root@$POD_HOST "mkdir -p /workspace/orchai/{scripts,.orcai/training,.orcai/ft-output}"
scp $SCP_OPTS .orcai/training/*.jsonl root@$POD_HOST:/workspace/orchai/.orcai/training/
scp $SCP_OPTS scripts/train-lora-qwen7b-v2.py scripts/merge-lora-7b-v2.py \
    scripts/convert-to-gguf-v2.sh scripts/pod-run-pipeline-v2.sh \
    root@$POD_HOST:/workspace/orchai/scripts/

# Launch training detached with CORRECT args
ssh $SSH_OPTS root@$POD_HOST "cd /workspace/orchai && \
  source /workspace/setup-env.sh && \
  setsid nohup python3 scripts/train-lora-qwen7b-v2.py \
    --max-seq-len $MAX_SEQ_LEN \
    --lora-rank $LORA_RANK \
    --lora-alpha $((LORA_RANK * 2)) \
    --epochs 3 \
    > .orcai/ft-output/pipeline.log 2>&1 & disown"
```

### Stage 5: Monitor smart (background, timeout tự động)

```bash
# Monitor sẽ:
# - Dynamic timeout = 2 × estimated (từ step rate thực)
# - NEVER auto-stop nếu pipeline fail → user decide
# - Download + terminate CHỈ khi success + integrity OK

nohup bash scripts/monitor-smart.sh $POD_ID qwen7b-ft-v2-Q4_K_M.gguf 786 > /dev/null 2>&1 &
```

### Stage 6: Chờ completion (4-8 tiếng tuỳ seq len)

Check periodically via `.orcai/monitor-status.md`. User có thể ngủ.

---

## Failure handling — KHI CÓ LỖI (tôi không auto-kill)

### Lỗi thường gặp + action

| Lỗi | Script xử lý | User action |
|---|---|---|
| GPU host busy (no free GPUs) | auto-retry start | Chờ, hoặc deploy new pod |
| Merge OOM (DoRA) | `merge-lora-7b-v2.py` đã CPU default | N/A |
| Port đổi sau restart | `monitor-smart.sh` tự refresh | N/A |
| Container disk full | Xoá HF cache trước save | N/A |
| Volume disk quota | Deploy với >= 60GB | N/A |
| Pod migrate 488MB RAM | `deploy-pod-safe.sh` verify spec | Retry với pod mới |
| Training stuck > 2× estimated | `monitor-smart.sh` log warn, extend | User check log, quyết |
| PIPELINE_FAILED_* | Monitor keep pod, download log | User debug + retry manually |

**Script QUAN TRỌNG**: `monitor-smart.sh` KHÔNG BAO GIỜ auto-stop. User phải chủ động terminate.

---

## Post-training (USER check)

### Verify + ship

1. **Integrity check**: `monitor-smart.sh` làm tự động
2. **Terminate pod**: tự động sau success (chỉ success mới DELETE)
3. **Import LM Studio**:
   ```bash
   cp .orcai/ft-output-v2/qwen7b-ft-v2-Q4_K_M.gguf \
      ~/.lmstudio/models/local/qwen2.5-coder-7b-ft-v2/
   ```
4. **Bench**:
   ```bash
   lms unload --all
   lms load qwen2.5-coder-7b-ft-v2 --identifier local-heavy --gpu max --context-length 4096 -y
   node test/coding-quality-bench-rag.js --problem-set realistic --models local-heavy
   ```
5. **Compare**: check `.orcai/ft-output-v2/bench-ft-v2-result.md`
6. **Commit**:
   ```bash
   git add .orcai/ft-output-v2/bench-ft-v2-result.md
   git commit -m "bench(r6): score XX/200 (XX.X%)"
   ```

---

## Ship decision tree

| Post-FT score | Action |
|---|---|
| ≥ 90% | 🎉 Ship, match 3.5-9B quality with 3x speed |
| 88-89% | ✓ Ship as workhorse (gain > noise) |
| 87-87.5% | Marginal, keep existing FT v2 or try different tack |
| < 87% | Regression, investigate or discard |

---

## Emergency brake

**Nếu user thấy bất thường bất cứ lúc nào:**

```bash
# Terminate TẤT CẢ pods đang chạy
KEY=$(cat ~/.runpod/api-key)
for ID in $(curl -sS -H "Authorization: Bearer $KEY" https://rest.runpod.io/v1/pods | \
  grep -oE '"id":"[^"]*"' | cut -d'"' -f4); do
  curl -X DELETE -H "Authorization: Bearer $KEY" https://rest.runpod.io/v1/pods/$ID
  echo "terminated $ID"
done

# Stop cost guardian
bash scripts/cost-guardian.sh --stop

# Verify 0 pods
curl -sS -H "Authorization: Bearer $KEY" https://rest.runpod.io/v1/pods | head -c 100
```

---

## Budget checkpoints

| Spent | Action |
|---|---|
| $1 | Log info, OK tiếp |
| $2 | Warn, check pipeline vẫn progress |
| $3 | Desktop popup, verify training |
| $5 | Critical, stop nếu không rõ ETA |
| $10 | Emergency, auto-terminate all (`AUTO_STOP_ON_CRIT=1`) |

Cost guardian theo dõi tự động và alert.

---

## Rollback plan (nếu Round N fail)

Kết thúc round nào cũng phải giữ được:
1. **Model cũ**: backup ở `/e/DEVELOP/.claude-shared/models-backup/` (không mất)
2. **LM Studio**: model cũ vẫn trong `~/.lmstudio/models/local/`
3. **Git**: commit trước khi start Round N, revert được

Nếu Round N bench score < score cũ:
```bash
# Revert LM Studio to previous model
rm -rf ~/.lmstudio/models/local/qwen2.5-coder-7b-ft-vN
cp /e/DEVELOP/.claude-shared/models-backup/qwen7b-ft-v2-Q4_K_M-YYYYMMDD.gguf \
   ~/.lmstudio/models/local/qwen2.5-coder-7b-ft-v2/
```

---

## Round 6 prompt template (USER dán vào session mới)

Xem file `AUTO-ROUND-6-PROMPT.md` để copy-paste cho Claude Code session mới. File đó self-contained, Claude Code mới sẽ biết phải làm gì từ đầu.
