"""
Tokenize audit for Round 6 FT — measure sequence length distribution across all training data.

Purpose:
  Round 5.5 FT result: 175/200 (87.5%) — only +1pt over baseline.
  Hypothesis: MAX_SEQ_LEN=2048 truncates long code examples, starving model of useful context.
  This script tokenizes ALL training data with the Qwen 2.5 Coder 7B chat template
  and reports percentile distribution so we can pick the right MAX_SEQ_LEN for Round 6.

Outputs:
  - .orcai/training/tokenize-audit.md   (markdown report, human-readable)
  - .orcai/training/tokenize-audit.json (machine-readable summary)
  - stdout: findings + recommendation

Usage:
  cd E:/DEVELOP/ai-orchestrator
  python scripts/tokenize-audit.py

Requires: transformers, (optional) tokenizers.
"""
import json
import os
import statistics
import sys
from pathlib import Path

try:
    from transformers import AutoTokenizer
except ImportError:
    print("[err] transformers not installed. Run: pip install transformers", file=sys.stderr)
    sys.exit(2)

BASE_MODEL = "Qwen/Qwen2.5-Coder-7B-Instruct"
TRAINING_FILES = [
    ".orcai/training/style.jsonl",
    ".orcai/training/classifier.jsonl",
    ".orcai/training/distill.jsonl",
    ".orcai/training/distill-v2-merged.jsonl",
]
OUTPUT_MD = ".orcai/training/tokenize-audit.md"
OUTPUT_JSON = ".orcai/training/tokenize-audit.json"
THRESHOLDS = [1024, 2048, 4096, 8192]


def percentile(sorted_vals, p):
    """Simple linear-interpolation percentile for a pre-sorted list."""
    if not sorted_vals:
        return 0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def summarize(lengths):
    """Return dict of stats for a list of token counts."""
    if not lengths:
        return {
            "count": 0, "median": 0, "p50": 0, "p75": 0, "p90": 0,
            "p95": 0, "p99": 0, "max": 0, "mean": 0, "over": {},
        }
    s = sorted(lengths)
    over = {}
    total = len(s)
    for t in THRESHOLDS:
        n_over = sum(1 for v in s if v > t)
        over[str(t)] = {
            "count": n_over,
            "pct": round(100.0 * n_over / total, 2),
        }
    return {
        "count": total,
        "median": int(statistics.median(s)),
        "p50": int(percentile(s, 50)),
        "p75": int(percentile(s, 75)),
        "p90": int(percentile(s, 90)),
        "p95": int(percentile(s, 95)),
        "p99": int(percentile(s, 99)),
        "max": int(s[-1]),
        "mean": round(statistics.mean(s), 1),
        "over": over,
    }


def tokenize_file(path, tokenizer):
    """Tokenize every record of one jsonl file; return list of token counts."""
    lengths = []
    skipped = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            if "messages" not in rec or len(rec["messages"]) < 2:
                skipped += 1
                continue
            try:
                ids = tokenizer.apply_chat_template(
                    rec["messages"],
                    tokenize=True,
                    add_generation_prompt=False,
                )
                lengths.append(len(ids))
            except Exception as e:
                skipped += 1
                print(f"[warn] tokenize failed in {path}: {e}", file=sys.stderr)
    return lengths, skipped


def md_table(label, stats):
    """Render one stats dict as a markdown block."""
    lines = []
    lines.append(f"### {label}")
    lines.append("")
    lines.append(f"- count: **{stats['count']}**")
    lines.append(f"- mean: {stats['mean']}")
    lines.append(f"- median / p50: {stats['median']}")
    lines.append(f"- p75: {stats['p75']}")
    lines.append(f"- p90: {stats['p90']}")
    lines.append(f"- p95: **{stats['p95']}**")
    lines.append(f"- p99: {stats['p99']}")
    lines.append(f"- max: {stats['max']}")
    lines.append("")
    lines.append("| threshold | over | pct |")
    lines.append("|-----------|------|-----|")
    for t in THRESHOLDS:
        row = stats["over"].get(str(t), {"count": 0, "pct": 0})
        lines.append(f"| > {t} | {row['count']} | {row['pct']}% |")
    lines.append("")
    return "\n".join(lines)


def recommend(p95):
    """Pick a recommended MAX_SEQ_LEN from p95."""
    if p95 < 2048:
        return 2048, "p95 fits comfortably in 2048 — keep current setting."
    if p95 < 4096:
        return 4096, "p95 exceeds 2048 — truncation is losing signal. Raise to 4096."
    return 8192, "p95 exceeds 4096 — long examples dominate. Raise to 8192 (VRAM permitting)."


def main():
    print(f"[tokenize-audit] loading tokenizer {BASE_MODEL} ...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)

    per_file = {}
    all_lengths = []
    total_skipped = 0
    for path in TRAINING_FILES:
        if not Path(path).exists():
            print(f"[warn] missing {path}, skipping")
            per_file[path] = {"error": "missing"}
            continue
        print(f"[tokenize-audit] processing {path} ...")
        lengths, skipped = tokenize_file(path, tokenizer)
        per_file[path] = summarize(lengths)
        per_file[path]["skipped"] = skipped
        all_lengths.extend(lengths)
        total_skipped += skipped
        print(f"  -> {len(lengths)} records, skipped {skipped}")

    combined = summarize(all_lengths)
    combined["skipped"] = total_skipped

    rec_len, rec_reason = recommend(combined["p95"])

    summary = {
        "base_model": BASE_MODEL,
        "files": per_file,
        "combined": combined,
        "recommendation": {
            "max_seq_len": rec_len,
            "reason": rec_reason,
            "current": 2048,
        },
        "thresholds": THRESHOLDS,
    }

    os.makedirs(Path(OUTPUT_JSON).parent, exist_ok=True)
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"[tokenize-audit] wrote {OUTPUT_JSON}")

    md_parts = []
    md_parts.append("# Tokenize Audit — Round 6 FT Prep")
    md_parts.append("")
    md_parts.append(f"Tokenizer: `{BASE_MODEL}`")
    md_parts.append("")
    md_parts.append(f"Files tokenized: {len(TRAINING_FILES)}  ")
    md_parts.append(f"Total records: **{combined['count']}**  ")
    md_parts.append(f"Skipped (parse/fmt errors): {total_skipped}")
    md_parts.append("")
    md_parts.append("## Combined (all files)")
    md_parts.append("")
    md_parts.append(md_table("all", combined))
    md_parts.append("## Per-file")
    md_parts.append("")
    for path, stats in per_file.items():
        if "error" in stats:
            md_parts.append(f"### {path}\n\n- missing / not found\n")
            continue
        md_parts.append(md_table(path, stats))
    md_parts.append("## Recommendation")
    md_parts.append("")
    md_parts.append(f"- Current MAX_SEQ_LEN: **2048**")
    md_parts.append(f"- p95 (combined): **{combined['p95']}**")
    md_parts.append(f"- Recommended MAX_SEQ_LEN for Round 6: **{rec_len}**")
    md_parts.append(f"- Reason: {rec_reason}")
    md_parts.append("")

    with open(OUTPUT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(md_parts))
    print(f"[tokenize-audit] wrote {OUTPUT_MD}")

    print("")
    print("=" * 60)
    print("FINDINGS")
    print("=" * 60)
    print(f"Total records tokenized: {combined['count']}")
    print(f"Median: {combined['median']}  |  p75: {combined['p75']}  |  p90: {combined['p90']}")
    print(f"p95: {combined['p95']}  |  p99: {combined['p99']}  |  max: {combined['max']}")
    print("")
    print("Over thresholds:")
    for t in THRESHOLDS:
        row = combined["over"][str(t)]
        print(f"  > {t:5d}: {row['count']:4d} records ({row['pct']}%)")
    print("")
    print("=" * 60)
    print("RECOMMENDATION")
    print("=" * 60)
    print(f"Current MAX_SEQ_LEN: 2048")
    print(f"Recommended for Round 6: {rec_len}")
    print(f"Reason: {rec_reason}")
    print("")


if __name__ == "__main__":
    main()
