# Lessons Learned — Round 5.5 FT (Qwen 2.5-Coder-7B + DoRA)

> 2026-04-19. Document tất cả bug, root cause, fix, và best practice để áp dụng cho Round 6+.

---

## Timeline tóm tắt

| Time | Event | Outcome |
|---|---|---|
| 13:21 | Deploy pod 4000 Ada, launch pipeline | Training starts |
| 13:22 | Training step 1/786 | DoRA slow ~27s/step |
| 18:57 | Monitor timeout 5h → **auto-STOP pod** | Train killed at 92% (step 724/786) |
| 19:02 | Retry-start GPU not available | Loop |
| 19:32 | Iceland host "no instances currently available" | Migration fail |
| 19:35 | User clicks "Start Pod using CPUs" | Pod up, extract checkpoint 676MB |
| 19:55 | Terminate CPU pod + deploy 4090 | New pod on US host |
| 20:17 | Upload checkpoint + resume training | 4090 2.65 it/s (fast!) |
| 20:33 | Training complete step 786 | stage.train.done |
| 20:34 | **Merge OOM on GPU with DoRA** | PIPELINE_FAILED_AT=merge |
| 20:36 | Monitor auto-STOP pod (safety protocol) | Pod stopped again |
| 20:38 | 4090 busy, click Start using CPUs | Pod migrated to CPU host |
| 20:55 | Port changed + deps wiped on migration | Install deps, upload script |
| 20:56 | Merge on CPU (fixed) + convert GGUF | Running |

---

## BUG 1: Monitor timeout 5h hardcoded killed pod at 92%

### Root cause
`scripts/overnight-monitor-v2.sh` có:
```bash
for i in $(seq 1 100); do
  ...
  sleep 180
done
log "⏰ TIMEOUT after 5h — force stop pod"
curl -X POST ... /stop
```

100 × 180s = 18000s = 5h. DoRA training thực tế cần 5h40m. Pod bị STOP lúc step 724/786 (92%).

### Why missed
- Ước sai thời gian. Không account DoRA +15-20% overhead.
- Không có grace period hoặc "ask user before kill" logic.

### Fix applied
- Timeout tăng lên 4h cho retry (đúng ra phải 6-8h buffer)
- `monitor-v2-retry.sh` cảnh báo trước khi stop

### Best practice Round 6+
```bash
# 1. Estimate training time trước với formula:
#    time_per_step × total_steps × (1 + dora_overhead + safety_margin)
#    = 27s × 786 × 1.5 = 5h54m
# 2. Monitor timeout = 2× estimated time (buffer for merge + convert)
# 3. Before force stop, WAIT ON USER via status file or prompt
# 4. Never hardcode timeout without calc from actual step rate
```

---

## BUG 2: DoRA merge OOM trên GPU

### Root cause
`merge-lora-7b-v2.py` dùng `device_map="auto"` → load model trên GPU. Khi DoRA merge:
```python
# trong peft/tuners/lora/dora.py:
weight = weight + scaling * lora_weight  # allocates new tensor
```
DoRA weight_norm tính xong vẫn giữ tensor cũ → OOM ở step cuối. 7B bf16 cần ~14GB, DoRA merge peak ~22GB > 24GB 4090 buffer.

### Why missed
- Research note có mention DoRA adds VRAM overhead nhưng tôi dùng GPU default.
- Không test merge script với DoRA trước Round 5 (R5 dùng vanilla LoRA).

### Fix applied
Change `device_map="auto"` → `device_map="cpu"`:
```python
base = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    torch_dtype=dtype,
    device_map="cpu",  # DoRA merge cần nhiều RAM, CPU pod có 60-124GB
    trust_remote_code=True,
)
```

### Best practice Round 6+
- **Always merge on CPU** — cost time nhẹ (5-10min extra), nhưng reliable
- 7B bf16 CPU merge ~15GB RAM, fits bất kỳ pod nào
- Chỉ dùng GPU merge khi có 48GB+ VRAM (L40S, A100)
- Test merge script standalone TRƯỚC khi deploy pipeline

---

## BUG 3: Container disk wiped on pod migration

### Root cause
Khi pod "migrate" (e.g., RunPod auto-transfer to new host hoặc "Start using CPUs"):
- **Container disk (30GB)**: RESET về template default
- **Volume disk (60GB mounted /workspace)**: PRESERVED

Pip packages install vào `/usr/local/lib/python3.11/dist-packages/` → container disk → MẤT.
Code + data + checkpoints ở `/workspace/orchai/` → volume → CÒN.

### Fix applied
Reinstall deps mỗi khi migrate:
```bash
pip install --quiet --no-cache-dir \
  transformers==4.46.3 peft==0.13.2 trl==0.11.4 \
  bitsandbytes==0.49.2 datasets==3.0.2 accelerate==1.13.0 \
  liger-kernel==0.3.0 rich sentencepiece protobuf
```

### Best practice Round 6+
**Option A: Install deps to volume**
```bash
pip install --target=/workspace/pypkgs <packages>
export PYTHONPATH=/workspace/pypkgs:$PYTHONPATH
```
Survives migration.

**Option B: Docker image với deps pre-baked**
Build custom image với all deps installed, use as pod template.

**Option C: Auto-reinstall script**
Write `/workspace/setup.sh` trigger trên volume, chạy mỗi start:
```bash
if ! python3 -c "import peft, trl"; then
  pip install -r /workspace/requirements.txt
fi
```

---

## BUG 4: Port changes on restart

### Root cause
RunPod reassigns TCP port mapping on every pod stop/start.
- Initial deploy: port 24608
- First restart: port 10249
- CPU migration: port 17094

SSH command hardcoded port → fail after restart.

### Fix applied
Query API before SSH:
```bash
PORT=$(curl -sS -H "Authorization: Bearer $KEY" \
  "https://rest.runpod.io/v1/pods/$POD_ID" | \
  sed -n 's/.*"portMappings":{"22":\([0-9]*\).*/\1/p')
```

### Best practice Round 6+
- **Never hardcode port** in scripts — always query API
- Write helper `refresh_port()` function, call on every SSH fail
- Cache port in `.orcai/pod-info.txt`, refresh if SSH fails

---

## BUG 5: GPU host contention (no instances available)

### Root cause
Specific GPU host (e.g., Iceland EUR-IS-1) có thể hết slot. RunPod không tự fallback sang host khác nếu volume tied to specific host.

### Fix applied
- "Start Pod using CPUs" để tạm access volume (bypass GPU requirement)
- Extract checkpoint → deploy fresh pod elsewhere

### Best practice Round 6+
- **Use Network Volume** (not Volume Disk) → cross-host portable
  - Network Volume: $0.07/GB/mo under 1TB, can mount any pod
  - Volume Disk: $0.10/GB/mo running, tied to pod
- Deploy initial pod với Network Volume → migration seamless
- Keep critical artifacts (checkpoint, adapter) backed up local lần đầu

---

## BUG 6: SSH daemon slow to start

### Root cause
After pod restart, UI shows "RUNNING" + Jupyter Ready nhưng SSH daemon chưa up → connection refused.
Sometimes 1-5 minutes delay.

### Fix applied
Retry loop:
```bash
for i in 1 2 3 4 5 6; do
  if ssh $SSH_OPTS root@$HOST 'echo OK' 2>/dev/null | grep -q OK; then
    break
  fi
  sleep 20
done
```

### Best practice Round 6+
- Always retry SSH with exponential backoff 15-30s intervals
- Don't panic if first few fail — 2-5min is normal
- If >5min, check pod might be stuck in STARTING state

---

## BUG 7: Script display bug — log shows "step=0/786"

### Root cause
tqdm uses `\r` (carriage return) for progress bar updates, not `\n`. My grep:
```bash
grep -oE "[0-9]+/[0-9]+.*it/s" | tail -1
```
Matches but `tail -1` on single-line-with-many-\r picks first match only.

### Fix applied
```bash
tail -c 3000 log | tr "\r" "\n" | grep -oE "[0-9]+/786 \[[^]]+\]" | tail -1
```

### Best practice Round 6+
- Always `tr "\r" "\n"` BEFORE grep when parsing tqdm output
- Or use `grep -aoE` for binary data

---

## BUG 8: Missing `rich` module

### Root cause
`trl 0.11.4 → rich` dependency not installed automatically (optional dep).
Playbook dependency list missing `rich`.

### Fix applied
Added `rich` to install command.

### Best practice Round 6+
Test import full chain BEFORE launching pipeline:
```bash
python3 -c "
from trl import SFTTrainer
from peft import LoraConfig
import bitsandbytes, datasets, accelerate
print('ALL OK')
"
```

---

## BUG 9: Monitor auto-STOP on PIPELINE_FAILED

### Root cause
My script's safety protocol:
```bash
PIPELINE_FAILED_*)
  curl -X POST ... /stop
  exit 1
  ;;
```
Stops pod IMMEDIATELY on any failure — even transient/recoverable ones.

### Impact
After merge OOM, I was going to relaunch merge with fix. But monitor already stopped pod before my command reached.

### Fix for Round 6+
```bash
PIPELINE_FAILED_*)
  # Download log first, do NOT auto-stop
  scp pipeline.log ...
  log "Failure detected — pod kept RUNNING for user debug/retry"
  log "Run 'curl -X POST ... /stop' manually if want to stop"
  exit 1
  ;;
```

Let user decide. Auto-stop only on integrity failures AFTER successful pipeline.

---

## BUG 10: Resume from checkpoint needs explicit flag

### Root cause
`trainer.train()` doesn't auto-detect existing checkpoints — must call:
```python
trainer.train(resume_from_checkpoint=True)
```

### Fix applied
Added to train script:
```python
has_checkpoint = any(
    p.is_dir() and p.name.startswith("checkpoint-")
    for p in Path(OUTPUT_DIR).iterdir()
) if Path(OUTPUT_DIR).exists() else False
if has_checkpoint:
    trainer.train(resume_from_checkpoint=True)
else:
    trainer.train()
```

### Best practice Round 6+
Make resume the DEFAULT behavior. Training should never lose work.

---

## Cost breakdown Round 5.5

| Phase | Duration | $/h | Cost |
|---|---|---|---|
| 4000 Ada train 92% (aborted) | 5h35m | $0.26 | $1.45 |
| CPU pod extract checkpoint | ~10 min | $0.13 | $0.02 |
| 4090 resume train + OOM | 16 min | $0.69 | $0.18 |
| CPU pod merge + convert | ~30 min (est) | $0.345 | $0.17 |
| **Total** | 6h25m | | **~$1.82** |

Initial budget $1.50 estimated. Actual $1.82 = 21% over. Acceptable.

**Round 6 budget target:** nên ước $2-3 buffer cho unknowns.

---

## Key takeaways for Round 6+

### Hard rules
1. **Timeout = 2× estimated training time** (buffer for merge/convert/debug)
2. **Merge ALWAYS on CPU** (default, not GPU)
3. **Query port via API** on every SSH, never hardcode
4. **Install deps via requirements.txt** copied to volume, auto-reinstall on migration
5. **Monitor should NEVER auto-stop on failure** — download log, keep pod running, ask user

### Soft rules
6. Use **Network Volume** over Volume Disk for cross-host portability
7. **Backup checkpoint locally** mỗi 500 steps (or save_steps × 10)
8. **Test merge script standalone** with dummy adapter before pipeline
9. **Prefer 4090** ($0.69/h) over 4000 Ada ($0.26/h) — faster = cheaper/run
10. Use **Unsloth** instead of vanilla HF — 2x faster training

### Checklist before Round 6
- [ ] Update `train-lora-*.py`: `use_dora=True`, `resume_from_checkpoint=True` default
- [ ] Update `merge-lora-*.py`: `device_map="cpu"` default
- [ ] Update pipeline script: no auto-stop on failure
- [ ] Update monitor: timeout calc from step rate, not hardcoded
- [ ] Add `setup.sh` to volume for auto-deps-install on migration
- [ ] Create `pod-info.json` helper that queries API for port
- [ ] Document this lesson in playbook next to checklist

---

## Open items (transfer to Round 6 plan)

- Test Unsloth 2x speed claim on our data (Round 6 ablation)
- ORPO preference pass: collect 300-500 pairs v2 vs 3.5-9B, +1-3pt expected
- Speculative decoding: pair 7B + 0.5B draft for 1.5-2x inference speedup
- Try UD-Q3_K_XL on 9B for heavier tier
