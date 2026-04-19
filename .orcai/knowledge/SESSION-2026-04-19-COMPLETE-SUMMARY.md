# Session 2026-04-19: Phase 5 Round 5.5 — Full Summary

> Tổng hợp session 1 ngày thực hiện FT Round 5.5 cho ai-orchestrator.
> Bao gồm: kết quả, toàn bộ lỗi + fix, next steps, kinh nghiệm triển khai cho Round 6+.

---

## 1. Kết quả tóm tắt

### ✅ Hoàn thành
- Bench Qwen 3.5-4B: 140/200 (70%) — loại khỏi candidate FT
- Data distill v2: 952 pairs generated từ 13 parallel Claude agents
- Data tổng v1+v2: **2,097 pairs** ready cho FT
- Training Qwen 2.5-Coder-7B + LoRA DoRA: **786 steps hoàn tất** (3 epochs)
- Merge LoRA → base: 27GB bf16 merged model
- Convert GGUF Q4_K_M: 4.4GB final GGUF
- Checkpoint local backup: 676MB tarball (safety copy)

### 🔄 Đang chạy
- Download GGUF về local: 4.3/4.4GB (~99%)

### 📋 Còn phải làm (next steps)
1. Verify GGUF integrity local bytes == remote bytes
2. TERMINATE pod cuối (5vctqp24qf2wfe)
3. Import GGUF vào LM Studio
4. Bench FT v2 trên 40-problem realistic (dự kiến 87-90%)
5. Update router.json: workhorse = FT v2
6. Update memory files + handoff
7. Push .claude-shared

### 💰 Cost thực tế
| Phase | Thời gian | Cost |
|---|---|---|
| 4000 Ada train 92% (aborted) | 5h35m | $1.45 |
| CPU pod extract checkpoint | 10 min | $0.02 |
| 4090 resume train + merge OOM | 16 min | $0.18 |
| CPU pod merge fail (488MB) | 30 min | $0.17 |
| 4090 merge+convert v2 (success) | 30 min | $0.35 |
| Volume storage background | scattered | $0.15 |
| **Total** | ~7h | **~$2.32** |

Balance: $15.00 → ~$12.68 remaining

---

## 2. Danh sách 13 lỗi gặp trong session

### BUG #1: Qwen3.5-9B UD-Q3_K_XL size ước sai
- **Tôi nói**: ~4GB, fit 6GB
- **Thực tế**: 5.05GB, **không** fit 6GB
- **Fix**: Giữ Q3_K_M 4.67GB hiện tại

### BUG #2: Monitor timeout 5h hardcoded
- **Triệu chứng**: Monitor gọi API stop pod lúc training 92% (step 724/786)
- **Root cause**: `for i in $(seq 1 100); do ...sleep 180` = max 5h, training DoRA cần 5h40m
- **Fix**: Tăng timeout lên 4h cho retry monitor; best practice: **timeout = 2× estimated time**
- **Prevention**: Tính timeout từ step rate thực tế, không hardcode

### BUG #3: DoRA merge GPU OOM
- **Triệu chứng**: `CUDA out of memory. Tried to allocate 260 MiB. 21.96 GB allocated`
- **Root cause**: `device_map="auto"` load GPU, DoRA weight_norm spike ~22GB vs 24GB VRAM
- **Fix**: Change to `device_map="cpu"` (host RAM dồi dào 62-503GB)
- **Prevention**: **Always merge on CPU with DoRA**

### BUG #4: Container disk wiped on pod migration
- **Triệu chứng**: Sau pod transfer, `transformers` module not found
- **Root cause**: Container disk (30GB, /) = ephemeral, reset on migration. Volume (/workspace) persistent.
- **Fix**: Reinstall deps sau mỗi migration
- **Prevention**: Install deps vào `/workspace/pypkgs` + set PYTHONPATH

### BUG #5: Port đổi mỗi khi pod restart
- **Triệu chứng**: SSH connection refused sau restart
- **Root cause**: RunPod reassigns TCP port on every start
- **Fix**: Query API trước SSH: `sed -n 's/.*"portMappings":{"22":\([0-9]*\).*/\1/p'`
- **Prevention**: Never hardcode port, always refresh via API

### BUG #6: GPU host contention (no instances available)
- **Triệu chứng**: "Start pod: There are not enough free GPUs on the host"
- **Root cause**: RTX 4000 Ada tại Iceland EUR-IS-1 host busy
- **Fix**: Start Pod using CPUs → extract checkpoint → deploy new pod khác host
- **Prevention**: Dùng Network Volume (portable) thay Volume Disk (tied to pod)

### BUG #7: Pod migration to undersized 488MB RAM host
- **Triệu chứng**: Merge process silent-killed, SSH reset
- **Root cause**: RunPod "transfer pod" migrate sang host khác nhưng spec siêu tệ (488MB RAM)
- **Fix**: Không thể fix, phải terminate + deploy pod mới với spec đảm bảo
- **Prevention**: Verify `memoryInGb` từ API response sau migrate

### BUG #8: SSH daemon slow to start
- **Triệu chứng**: UI shows RUNNING nhưng SSH connection refused 1-5 min
- **Fix**: Retry loop với backoff 15-30s
- **Prevention**: Accept 2-5min delay as normal

### BUG #9: Monitor regex bug — log shows "step=0/786"
- **Root cause**: tqdm dùng `\r` không `\n`, `grep | tail -1` pick first match
- **Fix**: `tr "\r" "\n"` trước grep

### BUG #10: Missing `rich` module for trl
- **Root cause**: trl 0.11.4 optional dep
- **Fix**: Add `rich` to install list
- **Prevention**: Test imports chain trước launch: `python3 -c "from trl import SFTTrainer; ..."`

### BUG #11: Auto-STOP on PIPELINE_FAILED
- **Triệu chứng**: Monitor kill pod ngay khi merge fail, trước khi user retry
- **Root cause**: My safety protocol quá aggressive
- **Fix Round 6+**: Download log, KEEP pod running, let user decide

### BUG #12: Resume from checkpoint needs explicit flag
- **Root cause**: `trainer.train()` không auto-detect
- **Fix**: Added `resume_from_checkpoint=True` with checkpoint detection

### BUG #13: Disk quota exceeded khi merge save
- **Triệu chứng**: safetensors I/O error after saving 4/6 shards
- **Root cause**: Pod volume 20GB quota, merged bf16 ~16-18GB + HF cache 14GB > 20GB
- **Fix**: Deploy pod với **100GB volume** (cover fully)
- **Prevention**: Volume disk ≥ 60GB cho merge 7B bf16, ≥ 100GB cho 13B+

---

## 3. Timeline chi tiết session

| Time local | Event | Result |
|---|---|---|
| 12:17 | Bench Qwen 3.5-4B start | |
| 12:57 | Bench 4B done: 140/200 (70%) | Loại 4B khỏi FT |
| 13:08 | Deploy pod 4000 Ada R5.5 | Cost $0.26/h |
| 13:22 | Training step 0/786 start | |
| 17:28 | Training step 548/786 (70%) | GPU 121W 100% util |
| 18:17 | Training step 657/786 (84%) | Ổn định |
| 18:57 | **Monitor 5h timeout → kill pod** | step 724/786 (92%) |
| 19:02 | Retry-start GPU: "no free GPUs" | Host busy Iceland |
| 19:35 | Click "Start using CPUs" | Extract checkpoint |
| 19:55 | Download checkpoint 676MB local | ✅ Safe backup |
| 19:57 | Terminate CPU pod | |
| 20:08 | Deploy new 4090 pod | $0.69/h, 62GB RAM |
| 20:17 | Resume training from step 700 | Fast! 2.65 it/s |
| 20:33 | Training step 786 DONE | Adapter saved |
| 20:34 | **Merge GPU OOM** | DoRA needs >24GB VRAM |
| 20:36 | Monitor auto-STOP pod (bug) | |
| 20:38 | 4090 busy, start as CPU | Migrate to 488MB RAM pod |
| 20:55 | Merge silent-killed (OOM) | 488MB too small |
| 21:17 | Terminate dead pod | |
| 22:19 | **Deploy new pod via API** (bypass UI) | 4090, 62GB RAM |
| 22:24 | Merge (CPU) first attempt | Disk quota 20GB hit |
| 22:35 | Deploy pod mới 100GB volume | RTX 4090 US-NC-1 |
| 22:42 | Merge + convert v2 SUCCESS | 4.4GB GGUF ready |
| 22:45 | Download GGUF 50% | In progress... |

---

## 4. Insight quan trọng từ user

### MAX_SEQ_LEN=2048 có thể là bottleneck
- User audit 50/952 pairs → 49 usable (~98%)
- **Data KHÔNG phải bottleneck**
- Nguyên nhân +0.5pt R5 có thể do: **MAX_SEQ_LEN=2048 quá ngắn** truncate long code
- **Round 6 action**: Tokenize data trước, nếu p95 > 2048 → tăng lên 4096

### Giá rẻ không quan trọng bằng tốc độ
- User: "1 ngày rồi chưa có kết quả" — time matter more than $0.30 saving
- **Round 6 action**: Default 4090 $0.69/h thay vì 4000 Ada $0.26/h
- 4090 nhanh 3x → tổng cost có thể rẻ hơn

### Pod UI vs API
- User hỏi "tại sao pod chết liên tục vậy" — lỗi cascaded
- **Round 6 action**: Deploy via REST API (đã verified work), không bắt user click UI
- Script `deploy-pod.sh` sẵn sàng template

---

## 5. Next steps (khi GGUF download xong)

### Bước 1 — Verify integrity (2 phút)
```bash
LOCAL=$(stat -c %s /e/DEVELOP/ai-orchestrator/.orcai/ft-output-v2/qwen7b-ft-v2-Q4_K_M.gguf)
REMOTE=$(ssh ... 'stat -c %s /workspace/orchai/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf')
[ "$LOCAL" = "$REMOTE" ] && echo OK || echo FAIL
```

### Bước 2 — Terminate pod cuối (1 phút)
```bash
KEY=$(cat ~/.runpod/api-key)
curl -X DELETE -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/5vctqp24qf2wfe"
```

### Bước 3 — Import vào LM Studio (5 phút)
```bash
MODEL_NAME="qwen2.5-coder-7b-ft-v2"
IMPORT_DIR="$HOME/.lmstudio/models/local/$MODEL_NAME"
mkdir -p "$IMPORT_DIR"
cp .orcai/ft-output-v2/qwen7b-ft-v2-Q4_K_M.gguf "$IMPORT_DIR/"
lms load "local/$MODEL_NAME" --identifier local-heavy --gpu max --context-length 4096 -y
```

### Bước 4 — Bench FT v2 (15-20 phút)
```bash
LITELLM_URL=http://localhost:1234 \
BENCH_TIMEOUT_MS=120000 \
BENCH_RAG_MAX_EXAMPLES=2 \
BENCH_NO_HINTS=1 \
node test/coding-quality-bench-rag.js --problem-set realistic --models local-heavy
```
Target: ≥87% (vs baseline 86.5%)

### Bước 5 — Compare + decision
| Score FT v2 | Verdict |
|---|---|
| ≥90% | 🎉 Match 3.5-9B, ship as heavy workhorse |
| 87-89% | ✓ Clear gain, ship as default workhorse |
| 86.5-87% | Marginal (noise), consider R6 |
| <86% | Regression, investigate |

### Bước 6 — Update router (5 phút)
```json
{
  "workhorse": "local/qwen2.5-coder-7b-ft-v2",
  "heavy": "unsloth/qwen3.5-9b"
}
```

### Bước 7 — Update memory (10 phút)
- `phase-5-handoff-2026-04-19.md` — bench result + verdict
- `MEMORY.md` — link to handoff
- `context-cache/ai-orchestrator.context.md` — recent focus
- Push `.claude-shared`

### Bước 8 — Sleep 🌙 (1 ngày rồi!)

---

## 6. Best practices Round 6+

### Hard rules
1. **Pod spec verify sau deploy**: `memoryInGb`, `vcpuCount`, `containerDiskInGb`, `volumeInGb` đều check
2. **Volume ≥ 60GB** cho 7B merge, ≥ 100GB cho 13B
3. **Timeout = 2× estimated training time** (never hardcoded)
4. **Merge ALWAYS CPU** với DoRA (device_map="cpu")
5. **Monitor NEVER auto-stop** on pipeline fail — download log, keep pod
6. **Port query API** on every SSH — never hardcoded
7. **Deploy via REST API** — không bắt user click UI
8. **4090 default** — speed > saving $0.30/h

### Soft rules
9. Backup checkpoint mỗi 500 steps ra local (route `/e/DEVELOP/.claude-shared/checkpoints-backup/`)
10. Tokenize data trước FT → decide MAX_SEQ_LEN (4096 nếu p95 > 2048)
11. Install deps vào `/workspace/pypkgs` để persist qua migration
12. Use Unsloth over vanilla HF (2x faster, same quality)
13. Test merge script standalone before pipeline launch
14. Setup.sh tự động deps khi pod start (trigger từ /workspace)

### Script updates cần làm
- [ ] `train-lora-qwen7b-v2.py`: `use_dora=True`, `resume_from_checkpoint` logic ✓ đã có
- [ ] `merge-lora-7b-v2.py`: `device_map="cpu"` default, del HF cache trước save ✓ đã có
- [ ] `pod-run-pipeline-v2.sh`: No auto-stop on failure
- [ ] `monitor-*.sh`: Timeout calc from step rate, not hardcoded
- [ ] `deploy-pod-api.sh`: REST API deploy (terminate old, deploy new)
- [ ] `tokenize-audit.py`: Check data token length distribution
- [ ] `setup-pod.sh`: Auto install deps on volume

---

## 7. Artifacts location

### Local (persistent)
```
E:/DEVELOP/ai-orchestrator/
├── .orcai/
│   ├── ft-output-v2/
│   │   ├── qwen7b-ft-v2-Q4_K_M.gguf     (4.4GB — main artifact)
│   │   └── lora-v2-ckpt.tgz              (676MB — adapter backup)
│   ├── training/
│   │   ├── style.jsonl                   (773 pairs v1)
│   │   ├── classifier.jsonl              (298 pairs v1)
│   │   ├── distill.jsonl                 (74 pairs v1)
│   │   └── distill-v2-merged.jsonl       (952 pairs v2)
│   └── knowledge/
│       ├── PHASE-5-ROUND-5.5-PLAN.md
│       ├── RUNPOD-CLOUD-FT-PLAYBOOK.md
│       ├── RESEARCH-LATEST-FT-TECH-2026.md
│       ├── LESSONS-ROUND-5.5-FT.md       (chi tiết 10 bugs + fix)
│       └── SESSION-2026-04-19-COMPLETE-SUMMARY.md  (file này)
└── scripts/
    ├── train-lora-qwen7b-v2.py           (with DoRA + resume)
    ├── merge-lora-7b-v2.py               (with CPU + cache del)
    ├── convert-to-gguf-v2.sh
    ├── pod-run-pipeline-v2.sh
    ├── overnight-monitor-v2.sh
    ├── monitor-v2-retry.sh
    ├── overnight-postprocess.sh          (auto bench)
    ├── overnight-finalize.sh             (memory update)
    ├── retry-start-pod.sh                (GPU availability retry)
    ├── watch-migration.sh                (auto migration detect)
    ├── resume-launch.sh                  (post-restart relaunch)
    └── extract-checkpoint.sh             (extract adapter from stopped pod)
```

### RunPod (cần cleanup)
- Pod `5vctqp24qf2wfe` — **TERMINATE sau khi download xong**
- Pod `csgp52btkz8q7k` — EXITED (terminate nếu chưa)
- Pod `gqczcmonbiodqy` — EXITED (terminate nếu chưa)

---

## 8. Khi bắt đầu Round 6

### Chuẩn bị (1h)
1. Tokenize data v1+v2, check p95 token length
2. Decide MAX_SEQ_LEN based on p95 (2048 vs 4096 vs 8192)
3. Clean RunPod pods cũ
4. Verify scripts đã apply lessons (DoRA, CPU merge, etc.)
5. Budget: ~$3-5 based on SEQ_LEN choice

### Execution (1-5h tuỳ config)
```bash
# Deploy pod 4090 via API (60GB volume)
bash scripts/deploy-pod-api.sh

# Upload data + scripts
bash scripts/upload-all.sh

# Launch pipeline detached with SMART monitor (no auto-stop)
bash scripts/launch-pipeline-v2.sh

# Monitor (non-blocking)
bash scripts/monitor-smart.sh &

# Auto: postprocess + bench + finalize + memory update
```

### Verification
- Bench improvement over baseline 86.5%
- Target: ≥90% (match 3.5-9B quality with 3x speed)

---

**End of session summary. Good luck Round 6+.** 🚀
