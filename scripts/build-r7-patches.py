"""
Build R7 patch dataset = R6's per-problem failures + 9B's higher-scoring response.

Inputs:
  .orcai/bench-rag-results-r6.json   — R6 per-problem scores
  .orcai/bench-rag-results.json      — 9B per-problem scores (latest run = 9B)
  .orcai/distill-local-heavy.jsonl   — 9B's full responses (BENCH_SAVE_CODE=1 output)
  test/problems-realistic.js         — problem prompts (parsed via require)

Output:
  .orcai/training/r7-patches.jsonl   — pairs in chat format {messages: [user, assistant]}
  .orcai/training/r7-patches-meta.md — summary of which problems patched + score deltas

Inclusion rule:
  - 9B score >= 4 AND 9B score > R6 score → include 9B response as chosen patch
  - Skip if 9B score < 4 (low-quality teacher signal)
  - Skip if 9B score == R6 score (no signal)
"""
import json
import io
import os
import re
import sys
from pathlib import Path


def load_problems_realistic():
    """Parse the JS problems file with regex (good enough — fields are on one line)."""
    txt = Path("test/problems-realistic.js").read_text(encoding="utf-8")
    # Each problem block: { id: N, key: '...', ..., prompt: "...", ... }
    # We need id + prompt. Allow both single-line and multi-line prompts.
    out = {}
    # Match { id: N, key: 'KEY', ... prompt: "PROMPT", hint: ...
    # Use a tolerant regex on id + key + prompt fields
    pat = re.compile(
        r"\{\s*id:\s*(\d+),\s*key:\s*'([^']+)'[^}]*?prompt:\s*\"((?:[^\"\\]|\\.)*)\"",
        re.DOTALL,
    )
    for m in pat.finditer(txt):
        pid = int(m.group(1))
        key = m.group(2)
        prompt = m.group(3).encode().decode("unicode_escape")
        out[pid] = {"key": key, "prompt": prompt}
    return out


def load_9b_codes():
    """Each line: {model, problemId, problemKey, prompt, code, score, ...}."""
    out = {}
    with io.open(".orcai/distill-local-heavy.jsonl", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            pid = rec.get("problemId")
            if pid is None:
                continue
            out[int(pid)] = rec
    return out


def load_r6_scores():
    with io.open(".orcai/bench-rag-results-r6.json", encoding="utf-8") as f:
        data = json.load(f)
    probs = data["perModel"]["local-heavy"]["problems"]
    return {int(k): v["finalScore"] for k, v in probs.items()}


def main():
    problems = load_problems_realistic()
    print(f"[load] parsed {len(problems)} problems from test/problems-realistic.js")

    if not Path(".orcai/distill-local-heavy.jsonl").exists():
        print("[err] no 9B distill jsonl — run 9B bench with BENCH_SAVE_CODE=1 first")
        sys.exit(1)
    nine_b_codes = load_9b_codes()
    print(f"[load] {len(nine_b_codes)} responses captured from 9B bench")

    r6 = load_r6_scores()
    print(f"[load] {len(r6)} R6 per-problem scores")

    patches = []
    skipped = []
    for pid, p in problems.items():
        nb = nine_b_codes.get(pid)
        if nb is None:
            skipped.append((pid, "no 9B response"))
            continue
        nb_score = int(nb.get("score", 0))
        r6_score = int(r6.get(pid, 0))
        if nb_score < 4:
            skipped.append((pid, f"9B too weak ({nb_score}/5)"))
            continue
        if nb_score <= r6_score:
            skipped.append((pid, f"no signal R6={r6_score} 9B={nb_score}"))
            continue
        # accept patch
        patches.append({
            "problemId": pid,
            "key": p["key"],
            "r6_score": r6_score,
            "nb_score": nb_score,
            "delta": nb_score - r6_score,
            "code": nb.get("code", "").strip(),
        })

    Path(".orcai/training").mkdir(parents=True, exist_ok=True)
    out_path = Path(".orcai/training/r7-patches.jsonl")
    with io.open(out_path, "w", encoding="utf-8") as f:
        for pa in patches:
            rec = {
                "messages": [
                    {"role": "user", "content": problems[pa["problemId"]]["prompt"]},
                    {"role": "assistant", "content": pa["code"]},
                ],
                "meta": {
                    "source": "r7-patch-from-9b",
                    "problemId": pa["problemId"],
                    "key": pa["key"],
                    "r6_score": pa["r6_score"],
                    "nb_score": pa["nb_score"],
                },
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"[write] {len(patches)} patch pairs -> {out_path}")

    meta_path = Path(".orcai/training/r7-patches-meta.md")
    with io.open(meta_path, "w", encoding="utf-8") as f:
        f.write("# R7 patch dataset summary\n\n")
        f.write(f"- Patches included: **{len(patches)}**\n")
        f.write(f"- Total potential delta on bench: **+{sum(p['delta'] for p in patches)} pts**\n")
        f.write(f"- Skipped: {len(skipped)}\n\n")
        f.write("## Patches\n\n| pid | key | R6 | 9B | delta |\n|---:|---|---:|---:|---:|\n")
        for pa in sorted(patches, key=lambda x: -x["delta"]):
            f.write(f"| {pa['problemId']} | {pa['key']} | {pa['r6_score']} | {pa['nb_score']} | +{pa['delta']} |\n")
        f.write("\n## Skipped\n\n")
        for pid, reason in skipped[:50]:
            f.write(f"- P{pid}: {reason}\n")
    print(f"[write] meta -> {meta_path}")


if __name__ == "__main__":
    main()
