"""
LoRA FT Qwen 3.5-4B-Instruct on v1+v2 data (2,097 pairs).

Smaller model than 7B → faster training (~25 min) + cheaper (~$0.15 cloud).
Expected: baseline ~80-85% → FT 85-90%.

Designed for RunPod RTX 4000 Ada / 4090 / L4 24GB.
"""
import json
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

BASE_MODEL = "Qwen/Qwen3.5-4B-Instruct"  # HF repo for the base model
OUTPUT_DIR = ".orcai/ft-output/qwen3.5-4b-lora-v1"
TRAINING_FILES = [
    ".orcai/training/style.jsonl",
    ".orcai/training/classifier.jsonl",
    ".orcai/training/distill.jsonl",
    ".orcai/training/distill-v2-merged.jsonl",
]

LORA_RANK = 16
LORA_ALPHA = 32
LORA_DROPOUT = 0.05
EPOCHS = 3
BATCH_SIZE = 2            # 4B smaller — can go batch 2 on 24GB
GRAD_ACCUM = 4            # effective batch 8 (same as 7B run)
LEARNING_RATE = 2e-4
MAX_SEQ_LEN = 2048
SEED = 42


def load_dataset():
    all_rows = []
    for f in TRAINING_FILES:
        if not Path(f).exists():
            print(f"[warn] missing {f}, skipping")
            continue
        n = 0
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
                n += 1
        print(f"[data]   {f}: {n}")
    print(f"[data] TOTAL: {len(all_rows)} pairs")
    return Dataset.from_list(all_rows)


def format_chat(example, tokenizer):
    return tokenizer.apply_chat_template(
        example["messages"], tokenize=False, add_generation_prompt=False
    )


def main():
    if not torch.cuda.is_available():
        print("[err] CUDA not available.")
        sys.exit(1)
    print(f"[cuda] {torch.cuda.get_device_name(0)} — {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    major, _ = torch.cuda.get_device_capability(0)
    use_bf16 = major >= 8
    compute_dtype = torch.bfloat16 if use_bf16 else torch.float16
    print(f"[cuda] compute dtype: {'bf16' if use_bf16 else 'fp16'}")

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_use_double_quant=True,
    )

    print(f"[model] loading {BASE_MODEL} (4-bit NF4)...")
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
    print(f"[train] saved → {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
