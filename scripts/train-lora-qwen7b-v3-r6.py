"""
LoRA FT Qwen 2.5 Coder 7B — Round 6 (v3) continue-train from R5.5 adapter.

Hypothesis to test (from 2026-04-19 audit):
- R5 + R5.5 had MAX_SEQ_LEN=2048; ~10-15% training pairs have response >1500 tokens
  → model learned from TRUNCATED code → bad pattern signal.
- R6 fix: MAX_SEQ_LEN=4096 + continue-train từ R5.5 adapter.

Differences vs R5.5 (train-lora-qwen7b-v2.py):
- MAX_SEQ_LEN: 2048 → 4096 (core fix)
- CONTINUE-TRAIN từ R5.5 adapter (qwen7b-lora-v2) thay vì fresh adapter
- EPOCHS: 3 → 1 (đã converge 3 epoch ở R5.5, chỉ cần 1 epoch trên full-length signal)
- LEARNING_RATE: 2e-4 → 1e-4 (continue-train cần LR thấp hơn, tránh catastrophic forgetting)
- OUTPUT_DIR → qwen7b-lora-v3-r6
- Giữ nguyên: DoRA, rank 16 α 32, 7 proj, bf16, bs 1 grad_accum 8, save_steps 50

VRAM estimate (4-bit base + grad_checkpoint + seq 4096 bs 1):
~8-10 GB → fit RTX 4000 Ada 20GB, 4090 24GB, L4 24GB.
"""
import json
import os
import sys
from pathlib import Path

import torch
from datasets import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    TrainingArguments,
)
from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer

BASE_MODEL = "Qwen/Qwen2.5-Coder-7B-Instruct"
ADAPTER_V2_PATH = ".orcai/ft-output/qwen7b-lora-v2"  # R5.5 output, starting point
OUTPUT_DIR = ".orcai/ft-output/qwen7b-lora-v3-r6"
TRAINING_FILES = [
    ".orcai/training/style.jsonl",
    ".orcai/training/classifier.jsonl",
    ".orcai/training/distill.jsonl",
    ".orcai/training/distill-v2-merged.jsonl",
]
LORA_RANK = int(os.environ.get("R6_LORA_RANK", "32"))
LORA_ALPHA = int(os.environ.get("R6_LORA_ALPHA", str(LORA_RANK * 2)))
LORA_DROPOUT = 0.05
EPOCHS = int(os.environ.get("R6_EPOCHS", "3"))
BATCH_SIZE = 1
GRAD_ACCUM = 8
LEARNING_RATE = float(os.environ.get("R6_LR", "2e-4"))
MAX_SEQ_LEN = int(os.environ.get("R6_MAX_SEQ_LEN", "4096"))
SEED = 42

# Fallback: neu ADAPTER_V2_PATH khong ton tai, cho phep train-from-scratch qua env var
FRESH_START = os.environ.get("R6_FRESH_START", "0") == "1"


def load_dataset():
    all_rows = []
    per_file = {}
    over_seq_len = 0
    for f in TRAINING_FILES:
        if not Path(f).exists():
            print(f"[warn] missing {f}, skipping")
            continue
        count = 0
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "messages" not in rec or len(rec["messages"]) < 2:
                    continue
                all_rows.append({"messages": rec["messages"]})
                # Estimate token count ~ chars / 3.5 (rough for code)
                total_chars = sum(len(m.get("content", "")) for m in rec["messages"])
                if total_chars / 3.5 > MAX_SEQ_LEN:
                    over_seq_len += 1
                count += 1
        per_file[f] = count
    for f, c in per_file.items():
        print(f"[data]   {f}: {c} pairs")
    print(f"[data] TOTAL: {len(all_rows)} pairs from {len(per_file)} files")
    print(f"[data] est pairs still >MAX_SEQ_LEN({MAX_SEQ_LEN}): {over_seq_len} "
          f"({100*over_seq_len/max(1,len(all_rows)):.1f}%)")
    return Dataset.from_list(all_rows)


def format_chat(example, tokenizer):
    return tokenizer.apply_chat_template(
        example["messages"], tokenize=False, add_generation_prompt=False
    )


def main():
    if not torch.cuda.is_available():
        print("[err] CUDA not available.")
        sys.exit(1)
    print(f"[cuda] device: {torch.cuda.get_device_name(0)}")
    print(f"[cuda] VRAM total: {torch.cuda.get_device_properties(0).total_memory / 1e9:.2f} GB")

    major, _ = torch.cuda.get_device_capability(0)
    use_bf16 = major >= 8
    compute_dtype = torch.bfloat16 if use_bf16 else torch.float16
    print(f"[cuda] compute dtype: {'bf16' if use_bf16 else 'fp16'} (capability {major}.x)")

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_use_double_quant=True,
    )

    print(f"[model] loading {BASE_MODEL} with 4-bit NF4...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=compute_dtype,
    )
    model = prepare_model_for_kbit_training(model)

    adapter_v2_exists = Path(ADAPTER_V2_PATH).exists() and any(
        (Path(ADAPTER_V2_PATH) / f).exists()
        for f in ("adapter_config.json", "adapter_model.safetensors", "adapter_model.bin")
    )

    if adapter_v2_exists and not FRESH_START:
        # Continue-train: load V2 adapter, keep same config, enable training
        print(f"[peft] CONTINUE-TRAIN: loading R5.5 adapter from {ADAPTER_V2_PATH}")
        model = PeftModel.from_pretrained(model, ADAPTER_V2_PATH, is_trainable=True)
        print("[peft] adapter loaded, is_trainable=True")
    else:
        if FRESH_START:
            print("[peft] FRESH_START flag set — training new adapter from scratch")
        else:
            print(f"[peft] V2 adapter NOT found at {ADAPTER_V2_PATH} — training new adapter")
        peft_config = LoraConfig(
            r=LORA_RANK,
            lora_alpha=LORA_ALPHA,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            lora_dropout=LORA_DROPOUT,
            bias="none",
            task_type="CAUSAL_LM",
            use_dora=True,
        )
        model = get_peft_model(model, peft_config)
    model.print_trainable_parameters()

    raw_ds = load_dataset()
    formatted = raw_ds.map(
        lambda ex: {"text": format_chat(ex, tokenizer)},
        remove_columns=raw_ds.column_names,
    )
    print(f"[data] formatted {len(formatted)} rows")

    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        num_train_epochs=EPOCHS,
        per_device_train_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRAD_ACCUM,
        learning_rate=LEARNING_RATE,
        bf16=use_bf16,
        fp16=not use_bf16,
        gradient_checkpointing=True,
        optim="paged_adamw_8bit",
        logging_steps=10,
        save_steps=50,
        save_total_limit=3,
        report_to="none",
        warmup_ratio=0.05,
        lr_scheduler_type="cosine",
        seed=SEED,
        dataloader_num_workers=2,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        args=training_args,
        train_dataset=formatted,
        dataset_text_field="text",
        max_seq_length=MAX_SEQ_LEN,
        packing=False,
    )

    # Resume chi ap dung voi R6 checkpoints trong OUTPUT_DIR (khong phai v2 adapter)
    has_r6_checkpoint = Path(OUTPUT_DIR).exists() and any(
        p.is_dir() and p.name.startswith("checkpoint-")
        for p in Path(OUTPUT_DIR).iterdir()
    )
    if has_r6_checkpoint:
        print(f"[train] RESUMING from R6 checkpoint in {OUTPUT_DIR}")
        trainer.train(resume_from_checkpoint=True)
    else:
        print("[train] starting R6 run (continue-train from v2 adapter)...")
        trainer.train()

    trainer.model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    print(f"[train] saved adapter → {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
