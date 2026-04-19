"""
LoRA fine-tune Qwen 2.5 Coder 3B on combined training corpus.

Input:
  .orcai/training/style.jsonl        (773 existing pairs — commit style)
  .orcai/training/classifier.jsonl   (298 existing pairs — task classifier)
  .orcai/training/distill.jsonl      (74 distill pairs from GPT-5.4 Mini + DeepSeek V3.2)
  → merged → 1145 chat-completion pairs

Output:
  .orcai/ft-output/qwen3b-lora-v1/   (adapter weights + tokenizer + config)

Hardware target: GTX 1060 6GB (Pascal, compute 6.1).
  - 4-bit NF4 quant (bitsandbytes) — works on Pascal but slower than Ampere
  - LoRA rank 16 on attention + MLP projection layers
  - gradient checkpointing, batch size 1, gradient accumulation 8

Run (must STOP LM Studio first to free VRAM):
  # Activate venv then:
  python scripts/train-lora-qwen3b.py
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
BASE_MODEL = "Qwen/Qwen2.5-Coder-3B-Instruct"
OUTPUT_DIR = ".orcai/ft-output/qwen3b-lora-v1"
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
    """Merge all JSONL training files into one HuggingFace Dataset."""
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
    """Apply chat template to each example for SFT."""
    return tokenizer.apply_chat_template(
        example["messages"], tokenize=False, add_generation_prompt=False
    )


def main():
    # Verify CUDA
    if not torch.cuda.is_available():
        print("[err] CUDA not available. Install torch with CUDA support.")
        sys.exit(1)
    print(f"[cuda] device: {torch.cuda.get_device_name(0)}")
    print(f"[cuda] VRAM total: {torch.cuda.get_device_properties(0).total_memory / 1e9:.2f} GB")

    # 4-bit quant config
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16,
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
        torch_dtype=torch.float16,
    )
    model = prepare_model_for_kbit_training(model)

    # LoRA config — target attention + MLP projections
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

    # Dataset
    raw_ds = load_dataset()
    # SFTTrainer needs a plain text column or formatting_func
    formatted = raw_ds.map(
        lambda ex: {"text": format_chat(ex, tokenizer)},
        remove_columns=raw_ds.column_names,
    )
    print(f"[data] formatted {len(formatted)} rows")

    # Training args
    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        num_train_epochs=EPOCHS,
        per_device_train_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRAD_ACCUM,
        learning_rate=LEARNING_RATE,
        fp16=True,
        gradient_checkpointing=True,
        optim="paged_adamw_8bit",
        logging_steps=10,
        save_steps=100,
        save_total_limit=2,
        report_to="none",
        warmup_ratio=0.05,
        lr_scheduler_type="cosine",
        seed=SEED,
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

    # Save adapter only (not full model — LoRA is the delta)
    trainer.model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    print(f"[train] saved adapter → {OUTPUT_DIR}")
    print()
    print("Next steps:")
    print(f"  1) Merge adapter with base model: python scripts/merge-lora.py")
    print(f"  2) Convert to GGUF for LM Studio: llama.cpp/convert_hf_to_gguf.py ...")
    print(f"  3) Reload LM Studio with merged GGUF")
    print(f"  4) Re-bench: node test/coding-quality-bench-rag.js ...")


if __name__ == "__main__":
    main()
