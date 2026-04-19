"""Merge Qwen 7B LoRA v3 (Round 6) adapter into base."""
import torch
from pathlib import Path
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE_MODEL = "Qwen/Qwen2.5-Coder-7B-Instruct"
ADAPTER_PATH = ".orcai/ft-output/qwen7b-lora-v4-r7"
MERGED_PATH = ".orcai/ft-output/qwen7b-merged-v4-r7"


def main():
    if not Path(ADAPTER_PATH).exists():
        print(f"[err] adapter not found: {ADAPTER_PATH}")
        return

    major, _ = torch.cuda.get_device_capability(0) if torch.cuda.is_available() else (0, 0)
    dtype = torch.bfloat16 if major >= 8 else torch.float16
    print(f"[merge] dtype: {dtype}")

    print(f"[merge] loading base model {BASE_MODEL} on CPU...")
    base = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        torch_dtype=dtype,
        device_map="cpu",
        trust_remote_code=True,
    )
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)

    print(f"[merge] loading adapter from {ADAPTER_PATH}...")
    merged = PeftModel.from_pretrained(base, ADAPTER_PATH)

    print("[merge] merging LoRA weights into base...")
    merged = merged.merge_and_unload()

    print(f"[merge] saving full merged model → {MERGED_PATH}")
    merged.save_pretrained(MERGED_PATH, safe_serialization=True)
    tokenizer.save_pretrained(MERGED_PATH)

    print("[merge] DONE.")


if __name__ == "__main__":
    main()
