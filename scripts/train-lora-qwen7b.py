"""
LoRA fine-tune Qwen 2.5 Coder 7B on combined training corpus (cloud edition).

Designed for RTX 4090 24GB / A100 40GB. Not for GTX 1060 (7B too big).

Input:
  .orcai/training/style.jsonl        (773 pairs — commit style)
  .orcai/training/classifier.jsonl   (298 pairs — task classifier)
  .orcai/training/distill.jsonl      (74 distill pairs from GPT-5.4 Mini + DeepSeek V3.2)
  → merged → 1145 chat-completion pairs

Output:
  .orcai/ft-output/qwen7b-lora-v1/   (adapter weights + tokenizer)

Differences vs 3B script:
  - Base model: Qwen2.5-Coder-7B-Instruct
  - Compute dtype: bf16 (RTX 4090 Ampere+ has bf16 throughput)
  - save_steps 100 → 50 (safer; cloud is expensive if restart)
  - Same LoRA rank 16, same target modules, same data
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
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer

# ===================== Config =====================
BASE_MODEL = "Qwen/Qwen2.5-Coder-7B-Instruct"
OUTPUT_DIR = ".orcai/ft-output/qwen7b-lora-v1"
TRAINING_FILES = [
    ".orcai/training/style.jsonl",
    ".orcai/training/classifier.jsonl",
    ".orcai/training/distill.jsonl",
]
LORA_RANK = 16
LORA_ALPHA = 32
LORA_DROPOUT = 0.05
EPOCHS = 3
BATCH_SIZE = 1
GRAD_ACCUM = 8
LEARNING_RATE = 2e-4
MAX_SEQ_LEN = 2048
SEED = 42


def load_dataset():
    all_rows = []
    for f in TRAINING_FILES:
        if not Path(f).exists():
            print(f"[warn] missing {f}, skipping")
            continue
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
    print(f"[data] loaded {len(all_rows)} pairs from {len(TRAINING_FILES)} files")
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

    # Detect bf16 support (Ampere+ = compute 8.0+)
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
        r=LORA_RANK,
        lora_alpha=LORA_ALPHA,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=LORA_DROPOUT,
        bias="none",
        task_type="CAUSAL_LM",
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

    print("[train] starting...")
    trainer.train()

    trainer.model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    print(f"[train] saved adapter → {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
