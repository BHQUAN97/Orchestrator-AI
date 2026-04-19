# LoRA FT Setup — Path A (Local Qwen 3B on GTX 1060)

> Thao tác từng bước, copy paste vào terminal.

## 1. Stop LM Studio (giải phóng ~5 GB VRAM)

Mở LM Studio GUI → Local Server → **Stop Server**.
Hoặc task-kill process `LM Studio.exe`. Verify:
```bash
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader
# Expect: ~200 MB used, ~5800 MB free
```

## 2. Tạo venv + install dependencies

Chạy trong CMD/PowerShell (không phải Git Bash — pip on Windows sometimes prefers native shell):

```powershell
cd E:\DEVELOP\ai-orchestrator

# Tạo virtualenv riêng cho FT
"C:\Users\buiho\AppData\Local\Programs\Python\Python312\python.exe" -m venv .venv-ft

# Activate
.venv-ft\Scripts\activate

# Upgrade pip
python -m pip install --upgrade pip

# PyTorch with CUDA 12.1 (compatible with driver 572+)
pip install torch==2.4.1 --index-url https://download.pytorch.org/whl/cu121

# ML stack
pip install "transformers>=4.46" "peft>=0.13" "trl>=0.11" "datasets>=3.0" "accelerate>=1.0" "bitsandbytes>=0.44"

# Verify CUDA works
python -c "import torch; print('cuda:', torch.cuda.is_available()); print('device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none')"
```

**Expected:** `cuda: True` và `device: NVIDIA GeForce GTX 1060 6GB`.

## 3. Chạy LoRA FT

```powershell
# Still in .venv-ft
python scripts/train-lora-qwen3b.py
```

**Expected runtime:** 1-2 giờ trên GTX 1060 với 1145 pairs × 3 epochs.

**Dấu hiệu OK:**
- Log: `[data] loaded 1145 pairs`
- Log: `trainable params: ~X% of all params`
- Training progress bar tiến đều, loss giảm từ ~2.0 → ~0.5-0.8
- Checkpoint save mỗi 100 steps vào `.orcai/ft-output/qwen3b-lora-v1/`

**Dấu hiệu lỗi:**
- `CUDA out of memory` → script default config đã tight. Giảm `MAX_SEQ_LEN=1024` hoặc `GRAD_ACCUM=16`.
- `bitsandbytes CUDA error` on Pascal → fallback 8-bit: đổi `load_in_4bit=True` → `load_in_8bit=True` trong script.

## 4. Sau khi train xong

LoRA adapter là DELTA, phải merge với base model hoặc dùng PEFT inference.

Option A — Merge + convert to GGUF cho LM Studio:
```powershell
# Clone llama.cpp (for GGUF conversion)
git clone https://github.com/ggerganov/llama.cpp third_party/llama.cpp
# TODO: merge-lora.py chưa có — hỏi AI viết tiếp nếu cần
```

Option B — Dùng trực tiếp qua Transformers (không qua LM Studio):
- Chạy `scripts/infer-lora.py` (chưa viết, cần thêm)
- Hoặc chuyển bench sang gọi Transformers Python

## 5. Re-bench

Sau khi model FT load được vào LM Studio (hoặc inference server khác), chạy lại bench:
```bash
LITELLM_URL=http://localhost:5002 LITELLM_KEY=sk-master-change-me \
  BENCH_TIMEOUT_MS=180000 BENCH_RAG_MAX_EXAMPLES=3 BENCH_RAG_MIN_SIMILARITY=0.65 \
  BENCH_NO_HINTS=1 \
  node test/coding-quality-bench-rag.js --problem-set realistic --models local-workhorse \
  --out .orcai/bench-round5-ft-workhorse.json
```

Compare với baseline `.orcai/bench-round5-no-hints-heavy.json` để xem +X pts.

---

## Troubleshooting

**Q: pip install torch treo ở download?**
A: PyTorch CUDA wheel ~2.6 GB. Dùng mirror gần: `pip install torch --index-url https://download.pytorch.org/whl/cu121 --timeout 600`

**Q: bitsandbytes throws `CUDA Setup failed`?**
A: Pascal (GTX 1060) cần CUDA 12.1. Verify `nvcc --version`. Nếu CUDA 12.8 → có thể cần build bitsandbytes từ source, hoặc downgrade cuda toolkit path.

**Q: Loss không giảm?**
A: Learning rate quá cao. Thử `LEARNING_RATE = 1e-4`.

**Q: Model tạo ra code kém hơn baseline?**
A: Overfit. Giảm `EPOCHS = 2` hoặc tăng `LORA_DROPOUT = 0.1`.
