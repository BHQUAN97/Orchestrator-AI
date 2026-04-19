"""
LoRA FT Qwen 2.5 Coder 7B — Round 5.5 / 6+ with v1+v2 data (~2097 pairs total).

Originally Round 5.5. Parameterised for Round 6+ via CLI args:
  --max-seq-len  (default 2048; raise to 4096/8192 if tokenize-audit shows truncation)
  --lora-rank    (default 16; try 32 or 64 for more capacity)
  --lora-alpha   (default 2 * rank)
  --epochs       (default 3)
  --use-dora / --no-use-dora (default on — +0.5-1pt free at r=8-16)
  --batch-size   (default 1)
  --grad-accum   (default 8)

Kept from Round 5.5:
- Data: style + classifier + distill + distill-v2-merged
- DoRA enabled
- target_modules = all-linear (7 proj)
- Auto resume_from_checkpoint

Designed for RunPod cloud (RTX 4000 Ada / 4090 / L4 24GB).
"""
import argparse
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
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer

BASE_MODEL = "Qwen/Qwen2.5-Coder-7B-Instruct"
OUTPUT_DIR = ".orcai/ft-output/qwen7b-lora-v2"
TRAINING_FILES = [
    ".orcai/training/style.jsonl",             # 773 pairs (v1)
    ".orcai/training/classifier.jsonl",        # 298 pairs (v1)
    ".orcai/training/distill.jsonl",           #  74 pairs (v1)
    ".orcai/training/distill-v2-merged.jsonl", # 952 pairs (v2)
]

# Fixed defaults (safe to tune later if needed)
LORA_DROPOUT = 0.05
LEARNING_RATE = 2e-4
SEED = 42

VALID_RANKS = {8, 16, 32, 64}
MIN_SEQ_LEN = 512
MAX_SEQ_LEN_HARD_CAP = 32768


def parse_args():
    p = argparse.ArgumentParser(description="LoRA FT Qwen 2.5 Coder 7B — parameterized for Round 6+")
    p.add_argument("--max-seq-len", type=int, default=2048,
                   help="Max sequence length for SFT. Raise to 4096/8192 after tokenize-audit.")
    p.add_argument("--lora-rank", type=int, default=16,
                   help="LoRA rank. Must be one of {8, 16, 32, 64}.")
    p.add_argument("--lora-alpha", type=int, default=None,
                   help="LoRA alpha. Defaults to 2 * rank if omitted.")
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--use-dora", dest="use_dora", action="store_true", default=True,
                   help="Enable DoRA (default: on).")
    p.add_argument("--no-use-dora", dest="use_dora", action="store_false",
                   help="Disable DoRA.")
    p.add_argument("--output-dir", type=str, default=OUTPUT_DIR,
                   help="Override output directory.")
    return p.parse_args()


def validate_args(args):
    if args.max_seq_len < MIN_SEQ_LEN or args.max_seq_len > MAX_SEQ_LEN_HARD_CAP:
        print(f"[err] --max-seq-len must be in [{MIN_SEQ_LEN}, {MAX_SEQ_LEN_HARD_CAP}] (got {args.max_seq_len})",
              file=sys.stderr)
        sys.exit(2)
    if args.lora_rank not in VALID_RANKS:
        print(f"[err] --lora-rank must be in {sorted(VALID_RANKS)} (got {args.lora_rank})",
              file=sys.stderr)
        sys.exit(2)
    if args.lora_alpha is None:
        args.lora_alpha = 2 * args.lora_rank
    if args.epochs < 1:
        print(f"[err] --epochs must be >= 1 (got {args.epochs})", file=sys.stderr)
        sys.exit(2)
    if args.batch_size < 1 or args.grad_accum < 1:
        print("[err] --batch-size and --grad-accum must be >= 1", file=sys.stderr)
        sys.exit(2)


def print_config(args):
    print("=" * 60)
    print("RUN CONFIG")
    print("=" * 60)
    print(f"  base_model         : {BASE_MODEL}")
    print(f"  output_dir         : {args.output_dir}")
    print(f"  max_seq_len        : {args.max_seq_len}")
    print(f"  lora_rank          : {args.lora_rank}")
    print(f"  lora_alpha         : {args.lora_alpha}")
    print(f"  lora_dropout       : {LORA_DROPOUT}")
    print(f"  use_dora           : {args.use_dora}")
    print(f"  epochs             : {args.epochs}")
    print(f"  batch_size         : {args.batch_size}")
    print(f"  grad_accum         : {args.grad_accum}")
    print(f"  effective_batch    : {args.batch_size * args.grad_accum}")
    print(f"  learning_rate      : {LEARNING_RATE}")
    print(f"  seed               : {SEED}")
    print(f"  training_files     : {len(TRAINING_FILES)}")
    for f in TRAINING_FILES:
        print(f"    - {f}")
    print("=" * 60)


def save_run_config(args, output_dir):
    cfg = {
        "base_model": BASE_MODEL,
        "output_dir": args.output_dir,
        "max_seq_len": args.max_seq_len,
        "lora_rank": args.lora_rank,
        "lora_alpha": args.lora_alpha,
        "lora_dropout": LORA_DROPOUT,
        "use_dora": args.use_dora,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "grad_accum": args.grad_accum,
        "effective_batch": args.batch_size * args.grad_accum,
        "learning_rate": LEARNING_RATE,
        "seed": SEED,
        "training_files": TRAINING_FILES,
        "target_modules": [
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
    }
    os.makedirs(output_dir, exist_ok=True)
    cfg_path = Path(output_dir) / "config.json"
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print(f"[config] saved run config -> {cfg_path}")


def load_dataset():
    all_rows = []
    per_file = {}
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
                count += 1
        per_file[f] = count
    for f, c in per_file.items():
        print(f"[data]   {f}: {c} pairs")
    print(f"[data] TOTAL: {len(all_rows)} pairs from {len(per_file)} files")
    return Dataset.from_list(all_rows)


def format_chat(example, tokenizer):
    return tokenizer.apply_chat_template(
        example["messages"], tokenize=False, add_generation_prompt=False
    )


def main():
    args = parse_args()
    validate_args(args)
    print_config(args)
    save_run_config(args, args.output_dir)

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

    peft_config = LoraConfig(
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=LORA_DROPOUT,
        bias="none",
        task_type="CAUSAL_LM",
        use_dora=args.use_dora,
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
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
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
        max_seq_length=args.max_seq_len,
        packing=False,
    )

    # Auto-resume from latest checkpoint if exists
    has_checkpoint = False
    if Path(args.output_dir).exists():
        has_checkpoint = any(
            p.is_dir() and p.name.startswith("checkpoint-")
            for p in Path(args.output_dir).iterdir()
        )
    if has_checkpoint:
        print(f"[train] RESUMING from latest checkpoint in {args.output_dir}")
        trainer.train(resume_from_checkpoint=True)
    else:
        print("[train] starting fresh (no checkpoint found)...")
        trainer.train()

    trainer.model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print(f"[train] saved adapter -> {args.output_dir}")


if __name__ == "__main__":
    main()
