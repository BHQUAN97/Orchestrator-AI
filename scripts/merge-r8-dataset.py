"""
Merge all R8 training sources into a single validated JSONL.

Input sources (in preference order for dedup):
  1. Original training data (high-quality, already proven):
     - .orcai/training/style.jsonl          (773)
     - .orcai/training/classifier.jsonl     (298)
     - .orcai/training/distill.jsonl        (74)
     - .orcai/training/distill-v2-merged.jsonl (952)
     - .orcai/training/r7-patches.jsonl     (15)
  2. Scraped from real projects:
     - .orcai/training/scraped-pairs.jsonl  (430)
  3. Agent-generated:
     - .orcai/training/agent-gen/*.jsonl    (1040)

Output:
  .orcai/training/r8-combined.jsonl      — ready to train
  .orcai/training/r8-combined-stats.md   — per-source breakdown

Validation:
  - JSON parse check
  - messages[0].role == "user", messages[1].role == "assistant"
  - len(user) 10-4000, len(asst) 20-6000 chars
  - Dedup by SHA1 of assistant content (first-seen wins)

No-leak check: reject pair if prompt token-Jaccard > 0.75 with any problem
in test/problems-realistic.js (the bench we'll evaluate against).
"""
import hashlib
import io
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


SOURCES = [
    # (display_name, glob_pattern)
    ("original/style", ".orcai/training/style.jsonl"),
    ("original/classifier", ".orcai/training/classifier.jsonl"),
    ("original/distill", ".orcai/training/distill.jsonl"),
    ("original/distill-v2", ".orcai/training/distill-v2-merged.jsonl"),
    ("original/r7-patches", ".orcai/training/r7-patches.jsonl"),
    ("scraped", ".orcai/training/scraped-pairs.jsonl"),
    ("agent-gen", ".orcai/training/agent-gen/*.jsonl"),
]

OUT = Path(".orcai/training/r8-combined.jsonl")
STATS = Path(".orcai/training/r8-combined-stats.md")

MIN_USER = 10
MAX_USER = 4000
MIN_AST = 3  # classifier data has 1-word tags ("build", "fix", etc.)
MAX_AST = 6000
LEAK_JACCARD = 0.75


def tokenize(s: str) -> set[str]:
    return {t for t in re.findall(r"\w+", s.lower()) if len(t) > 2}


def load_bench_prompts() -> list[set[str]]:
    """Pull prompts from problems-realistic.js via naive regex."""
    path = Path("test/problems-realistic.js")
    if not path.exists():
        return []
    txt = path.read_text(encoding="utf-8")
    out = []
    # match both single-line "prompt: ..." and concatenated multi-line
    for m in re.finditer(r'prompt:\s*(?:"((?:[^"\\]|\\.)*)"|\n?\s*"((?:[^"\\]|\\.)*)"(?:\s*\+\s*"((?:[^"\\]|\\.)*)")*)', txt, re.DOTALL):
        body = "".join(g or "" for g in m.groups())
        out.append(tokenize(body))
    return out


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / max(1, len(a | b))


def iter_sources():
    for name, pattern in SOURCES:
        if "*" in pattern:
            for p in sorted(Path(".").glob(pattern)):
                yield name + "/" + p.stem, p
        else:
            p = Path(pattern)
            if p.exists():
                yield name, p


def validate(rec, leak_prompts):
    msgs = rec.get("messages") or []
    if len(msgs) != 2:
        return False, "not 2 messages"
    if msgs[0].get("role") != "user" or msgs[1].get("role") != "assistant":
        return False, "wrong roles"
    u = (msgs[0].get("content") or "").strip()
    a = (msgs[1].get("content") or "").strip()
    if not (MIN_USER <= len(u) <= MAX_USER):
        return False, f"user len {len(u)}"
    if not (MIN_AST <= len(a) <= MAX_AST):
        return False, f"asst len {len(a)}"
    # leak check
    u_tok = tokenize(u)
    for bench_toks in leak_prompts:
        if jaccard(u_tok, bench_toks) >= LEAK_JACCARD:
            return False, "leak-vs-bench"
    return True, "ok"


def main():
    leak_prompts = load_bench_prompts()
    print(f"[leak-check] loaded {len(leak_prompts)} bench prompts from problems-realistic.js")

    per_source = Counter()
    per_source_drop = defaultdict(Counter)
    seen_hashes = set()
    kept = 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with io.open(OUT, "w", encoding="utf-8") as fout:
        for name, p in iter_sources():
            n_in = 0
            for line in io.open(p, encoding="utf-8"):
                line = line.strip()
                if not line:
                    continue
                n_in += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    per_source_drop[name]["bad-json"] += 1
                    continue
                ok, reason = validate(rec, leak_prompts)
                if not ok:
                    per_source_drop[name][reason] += 1
                    continue
                h = hashlib.sha1(
                    rec["messages"][1]["content"].encode("utf-8")
                ).hexdigest()[:16]
                if h in seen_hashes:
                    per_source_drop[name]["dup-hash"] += 1
                    continue
                seen_hashes.add(h)
                # Stamp r8-combined meta
                rec.setdefault("meta", {})["r8_source"] = name
                fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
                per_source[name] += 1
                kept += 1
            print(f"  {name}: kept {per_source[name]} / {n_in}")

    # stats md
    with io.open(STATS, "w", encoding="utf-8") as f:
        f.write(f"# r8-combined.jsonl stats\n\nTotal kept: **{kept}**\n\n")
        f.write("## Per source\n\n| source | kept | drops |\n|---|---:|---|\n")
        for name, ct in per_source.most_common():
            drops = ", ".join(
                f"{r}={c}" for r, c in per_source_drop[name].most_common()
            ) or "-"
            f.write(f"| {name} | {ct} | {drops} |\n")
        f.write(f"\nSeen unique assistant hashes: {len(seen_hashes)}\n")

    print(f"\n[done] kept={kept} -> {OUT}")
    print(f"[done] stats -> {STATS}")


if __name__ == "__main__":
    main()
