"""
Merge LoRA adapter into base model and save as full HF format.

Input:  .orcai/ft-output/qwen3b-lora-v1/   (LoRA adapter)
Output: .orcai/ft-output/qwen3b-merged/    (full merged model in HF format)

After merge, convert to GGUF for LM Studio:
  python third_party/llama.cpp/convert_hf_to_gguf.py .orcai/ft-output/qwen3b-merged \
    --outfile .orcai/ft-output/qwen3b-lora-v1.gguf --outtype f16
"""
import torch
from pathlib import Path
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE_MODEL = "Qwen/Qwen2.5-Coder-3B-Instruct"
ADAPTER_PATH = ".orcai/ft-output/qwen3b-lora-v1"
MERGED_PATH = ".orcai/ft-output/qwen3b-merged"


def main():
    if not Path(ADAPTER_PATH).exists():
        print(f"[err] adapter not found: {ADAPTER_PATH}")
        print("      Run scripts/train-lora-qwen3b.py first.")
        return

    print(f"[merge] loading base model {BASE_MODEL} (fp16)...")
    base = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch.float16,
        device_map="auto",
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
    print()
    print("Next:")
    print("  1) Clone llama.cpp (if not done):")
    print("       git clone https://github.com/ggerganov/llama.cpp third_party/llama.cpp")
    print("  2) Install llama.cpp conversion deps:")
    print("       pip install sentencepiece protobuf")
    print("  3) Convert to GGUF (f16 first, then quantize):")
    print(f"       python third_party/llama.cpp/convert_hf_to_gguf.py {MERGED_PATH} \\")
    print(f"         --outfile .orcai/ft-output/qwen3b-lora-v1-f16.gguf --outtype f16")
    print("  4) (optional) Quantize to Q4_K_M for smaller model:")
    print("       third_party/llama.cpp/quantize qwen3b-lora-v1-f16.gguf qwen3b-lora-v1-q4_k_m.gguf Q4_K_M")
    print("  5) Move GGUF into LM Studio models directory (usually")
    print("       C:\\Users\\<you>\\.lmstudio\\models\\Qwen\\Qwen2.5-Coder-3B-Instruct-FT\\)")
    print("  6) LM Studio → rescan models → load the FT variant → restart local server")


if __name__ == "__main__":
    main()
