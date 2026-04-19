# Round 6 FT — Plan

## Where we are (Round 5.5 result)

| Metric | Value |
|---|---|
| Bench score | 175 / 200 (**87.5%**) |
| Baseline (no FT) | 174 / 200 (**87.0%**) |
| Delta | **+1 pt** — marginal |
| Data | 2,097 pairs (style 773 + classifier 298 + distill 74 + distill-v2 952) |
| Config | rank 16, α 32, DoRA, 3 epochs, MAX_SEQ_LEN **2048** |

Verdict: FT is effectively a no-op. Either the data is not informative, the capacity is too
small, or — most likely — the 2048 token cap is silently truncating the long code examples
in `distill-v2-merged.jsonl`, so the model never sees the target completions.

## Target

Reach **90%+** on the internal bench (match the 3.5-9B baseline class).

## Levers available for Round 6

Ordered by expected ROI.

### 1. MAX_SEQ_LEN (gated on tokenize-audit)
- **Action:** run `scripts/tokenize-audit.py` first.
- **Decision rule:**
  - p95 < 2048 -> keep 2048, the truncation theory is wrong, move to lever 2.
  - 2048 <= p95 < 4096 -> raise to **4096** (safe, ~2x VRAM).
  - p95 >= 4096 -> raise to **8192** (VRAM permitting on 24 GB cards).
- **Expected gain:** +1 to +3 pt *if* truncation is the bottleneck.
- **Cost:** ~1.3x training time per doubling.

### 2. LoRA rank 16 -> 32 (α 64)
- **Action:** `--lora-rank 32 --lora-alpha 64` on `train-lora-qwen7b-v2.py`.
- **Why:** at ~2k pairs with DoRA, rank 16 may be under-parameterised for the
  distilled code-review behavior. Rank 32 roughly doubles trainable params
  without exploding VRAM.
- **Expected gain:** +1 to +2 pt.
- **Cost:** negligible vs lever 1.

### 3. ORPO preference pass (post-SFT)
- **Action:** after the SFT adapter lands at 88-89%, generate a preference pair set
  from the bench failures and run a short ORPO pass on the same adapter.
- **Why:** ORPO directly optimises the decision boundary where we're losing points,
  rather than re-teaching the whole distribution.
- **Expected gain:** +1 to +2 pt.
- **Cost:** ~1 extra hour on the same pod.

## Expected gain stack

| Lever | Low | High |
|---|---|---|
| MAX_SEQ_LEN fix | +1 | +3 |
| Rank 32 | +1 | +2 |
| ORPO pass | +1 | +2 |
| **Total** | **+2 (realistic floor)** | **+4 (ceiling)** |

Starting from 87.5%, that puts the realistic landing zone at **89.5% - 91.5%**,
which clears the 90% target with some slack.

## Cost estimate

- Tokenize audit: free (local CPU, ~1-2 min).
- SFT Round 6 (4096 seq, rank 32, 3 epochs): ~2-3h on RTX 4090 @ ~$0.70/h = **$1.50-2.10**.
- ORPO pass: ~1h = **$0.70**.
- Buffer for retries / GGUF convert / bench: **$1-2**.
- **Total: $3-5.**

## Decision gate (do this before spending any GPU time)

1. Run `python scripts/tokenize-audit.py`.
2. Read `.orcai/training/tokenize-audit.md`.
3. Pick the `--max-seq-len` per the decision rule above.
4. Always apply rank 32 (lever 2 is cheap, no reason to skip).
5. Kick off SFT with:
   ```
   python scripts/train-lora-qwen7b-v2.py \
     --max-seq-len <from audit> \
     --lora-rank 32 \
     --lora-alpha 64 \
     --epochs 3
   ```
6. Bench. If < 89%, reconsider data quality before spending on ORPO.
7. If >= 89%, queue ORPO pass for the final push to 90%+.

## What we are *not* changing in Round 6

- Base model stays `Qwen/Qwen2.5-Coder-7B-Instruct`.
- Training data stays as-is (no new scraping / distillation this round).
- DoRA stays on.
- 4-bit NF4 quant stays (needed for 24 GB pods).
- Learning rate stays 2e-4 (worked fine in 5.5).

If Round 6 still misses 90%, the next move is data surgery (drop low-quality
pairs in classifier.jsonl, re-distill with a stronger teacher) — not more knobs.
