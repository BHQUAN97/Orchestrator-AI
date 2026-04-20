"""
Scrape training pairs from user's real projects for Round 8.

Sources: FashionEcom, VietNet2026, LeQuyDon, WebPhoto, WebTemplate, RemoteTerminal.

Skip strategy — read-once filtering:
  - Skip directories: node_modules, .git, build, dist, .next, vendor,
    coverage, __pycache__, .orcai, .venv*, .pytest_cache, third_party,
    logs, tmp, cache, .nuxt, .svelte-kit, .angular, .turbo, .vite
  - Skip by extension (images + binaries): .png .jpg .jpeg .gif .webp
    .svg .ico .bmp .tiff .avif .mp3 .mp4 .wav .webm .ogg .flac .pdf
    .zip .tar .gz .bz2 .7z .rar .exe .dll .so .dylib .ttf .woff .woff2
    .otf .eot .psd .sketch .fig .mov .avi .mkv .ai .indd .xd .heic
    .bin .class .jar .war .lock
  - Skip generated / lock: package-lock.json, yarn.lock, pnpm-lock.yaml,
    poetry.lock, Cargo.lock, composer.lock, go.sum
  - Skip large files > 500KB raw text (probably generated / bundled)
  - Skip minified: *.min.js / *.min.css
  - Skip files with no useful content extractable

Pair extraction patterns:
  1. JSDoc / TSDoc function block → (docstring prompt, function impl)
  2. Python docstring function → (docstring, impl)
  3. NestJS class @Controller/@Injectable with methods → (class signature + imports, impl)
  4. React component with prop types → (prop interface + summary, component impl)
  5. Test it/describe blocks → (describe/it prompt, test body)
  6. Single-file utilities < 80 lines → (file path + first comment, full file)
  7. Migration/DTO/Entity patterns → structural (type + description, impl)
  8. Shell scripts with header comments → (comment, script body)

Output:
  .orcai/training/scraped-pairs.jsonl       — raw extracted pairs
  .orcai/training/scraped-stats.md          — per-project + per-pattern stats
  .orcai/training/scraped-skipped.log       — what got skipped + why (sample)
"""
import hashlib
import io
import json
import os
import re
import sys
from pathlib import Path

PROJECTS_ROOT = Path("E:/DEVELOP")
PROJECTS = ["FashionEcom", "VietNet2026", "LeQuyDon", "WebPhoto", "WebTemplate", "RemoteTerminal"]

SKIP_DIRS = {
    "node_modules", ".git", "build", "dist", ".next", "vendor",
    "coverage", "__pycache__", ".orcai", ".venv", ".venv-ft",
    ".pytest_cache", "third_party", "logs", "tmp", "cache",
    ".nuxt", ".svelte-kit", ".angular", ".turbo", ".vite",
    ".cache", "out", ".storybook-out", "storybook-static",
    "public/uploads", "uploads", "storage",
}

SKIP_EXTS = {
    # images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
    ".bmp", ".tiff", ".avif", ".heic", ".psd", ".sketch", ".fig",
    ".xd", ".ai", ".indd",
    # audio / video
    ".mp3", ".mp4", ".wav", ".webm", ".ogg", ".flac", ".mov",
    ".avi", ".mkv",
    # fonts
    ".ttf", ".woff", ".woff2", ".otf", ".eot",
    # archives / binaries
    ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".exe", ".dll",
    ".so", ".dylib", ".bin", ".class", ".jar", ".war", ".pdf",
    # lock / compiled
    ".lock", ".pyc", ".map",
}

SKIP_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "Cargo.lock", "composer.lock", "go.sum",
    ".DS_Store", "Thumbs.db", "desktop.ini",
}

MAX_FILE_BYTES = 500_000  # skip anything bigger — probably generated

INCLUDE_EXTS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".sql",
    ".sh", ".bash", ".zsh",
    ".yml", ".yaml", ".toml", ".json", ".env.example",
    ".md", ".mdx",
    ".css", ".scss", ".sass",
    ".vue", ".svelte",
    ".html", ".htm",
    ".dockerfile", "Dockerfile",
    ".go", ".rs", ".java", ".kt",
    ".pug", ".hbs", ".ejs",
}


def should_skip(path: Path) -> tuple[bool, str]:
    name = path.name
    if name in SKIP_FILES:
        return True, "lockfile/system"
    if name.endswith(".min.js") or name.endswith(".min.css"):
        return True, "minified"
    ext = path.suffix.lower()
    if ext in SKIP_EXTS:
        return True, f"skip-ext {ext}"
    # Has Dockerfile variant
    if "dockerfile" in name.lower():
        return False, ""
    if ext not in INCLUDE_EXTS:
        return True, f"not-included-ext {ext or '<none>'}"
    try:
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            return True, f"too-big {size}"
        if size == 0:
            return True, "empty"
    except OSError:
        return True, "stat-fail"
    return False, ""


def walk_project(root: Path):
    """Yield source files under project, respecting SKIP_DIRS mid-walk."""
    for dirpath, dirnames, filenames in os.walk(root):
        # prune skip dirs in place
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            yield Path(dirpath) / fn


# ---- Pair extraction patterns ----

JSDOC_FN_RE = re.compile(
    r"(?P<doc>/\*\*[\s\S]*?\*/)\s*"
    r"(?:export\s+)?(?:async\s+)?"
    r"(?:function\s+(?P<fn1>\w+)|(?:const|let|var)\s+(?P<fn2>\w+)\s*=\s*(?:async\s*)?\()"
    r"[\s\S]*?"
    r"(?=\n(?:export\s+|function\s+|const\s+|let\s+|var\s+|\}\s*$|$))",
    re.MULTILINE,
)

PY_DEF_DOCSTRING_RE = re.compile(
    r"(?P<def>def\s+(?P<fn>\w+)\([^)]*\)[^:]*:)\s*\n"
    r'\s*"""(?P<doc>[\s\S]*?)"""',
    re.MULTILINE,
)


def extract_jsdoc_pairs(text: str, file_rel: str, lang: str) -> list[dict]:
    pairs = []
    # A simpler per-block approach: split on `/**` and parse manually
    i = 0
    while True:
        j = text.find("/**", i)
        if j < 0:
            break
        k = text.find("*/", j)
        if k < 0:
            break
        doc_block = text[j : k + 2]
        # take ~40 lines after */ as candidate function body
        after = text[k + 2 :]
        # skip blank
        m = re.match(r"\s*\n([\s\S]{0,4000})", after)
        if not m:
            i = k + 2
            continue
        body_candidate = m.group(1)
        # find first function signature in the body_candidate
        sig = re.search(
            r"^(?:export\s+)?(?:async\s+)?"
            r"(?:function\s+\w+\s*(?:<[^>]*>)?\s*\([^)]*\)[^{]*\{|"
            r"(?:const|let|var)\s+\w+\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)[^=]*=>\s*\{|"
            r"(?:public|private|protected|static|async)\s+\w+\s*\([^)]*\)[^{]*\{)",
            body_candidate,
            re.MULTILINE,
        )
        if not sig:
            i = k + 2
            continue
        sig_start = m.start(1) + sig.start()
        # find matching closing brace at same depth
        depth = 0
        body_start = m.start(1) + sig.end()
        body_end = body_start
        for idx in range(m.start(1) + sig.end() - 1, len(after)):
            c = after[idx]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    body_end = idx + 1
                    break
        if body_end <= sig_start:
            i = k + 2
            continue
        full_fn = after[sig_start:body_end]
        # prompt = clean docstring
        doc_clean = re.sub(r"^\s*\*\s?", "", doc_block[3:-2], flags=re.MULTILINE).strip()
        if len(doc_clean) < 20 or len(full_fn) < 80 or len(full_fn) > 3500:
            i = k + 2
            continue
        user_prompt = f"Viet lai function sau theo JSDoc — lang={lang}, file={file_rel}:\n{doc_clean}"
        pairs.append({
            "messages": [
                {"role": "user", "content": user_prompt},
                {"role": "assistant", "content": full_fn.strip()},
            ],
            "meta": {"source": "scrape-jsdoc", "file": file_rel, "lang": lang},
        })
        i = k + body_end + 10
    return pairs


def extract_py_pairs(text: str, file_rel: str) -> list[dict]:
    pairs = []
    for m in PY_DEF_DOCSTRING_RE.finditer(text):
        doc = m.group("doc").strip()
        fn = m.group("fn")
        if len(doc) < 20:
            continue
        # take function body until next top-level def or eof
        start = m.end()
        # naive: read to next `\ndef ` or `\nclass ` or eof
        next_def = re.search(r"^(?:def\s+|class\s+|\S)", text[start:], re.MULTILINE)
        # simpler: capture up to 150 lines max
        body_lines = text[start : start + 3000].split("\n")
        # strip to start of next def/class at same indent
        end_idx = 0
        for idx, ln in enumerate(body_lines):
            if idx == 0:
                continue
            if re.match(r"^(def |class |[A-Za-z_])", ln) and not ln.startswith(" "):
                end_idx = idx
                break
            end_idx = idx + 1
        body = "\n".join(body_lines[:end_idx])
        full = m.group("def") + "\n    \"\"\"" + doc + "\"\"\"" + body
        if len(full) < 120 or len(full) > 3500:
            continue
        pairs.append({
            "messages": [
                {"role": "user", "content": f"Viet function Python `{fn}` theo docstring — file={file_rel}:\n{doc}"},
                {"role": "assistant", "content": full.strip()},
            ],
            "meta": {"source": "scrape-py-docstring", "file": file_rel, "lang": "py"},
        })
    return pairs


# ---- Main ----

def main():
    stats = {p: {"files_scanned": 0, "files_kept": 0, "pairs": 0, "skipped": {}} for p in PROJECTS}
    out_path = Path(".orcai/training/scraped-pairs.jsonl")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    skip_log = Path(".orcai/training/scraped-skipped.log")

    seen_hashes: set[str] = set()
    total_pairs = 0

    with io.open(out_path, "w", encoding="utf-8") as fout, io.open(skip_log, "w", encoding="utf-8") as fskip:
        for proj in PROJECTS:
            proot = PROJECTS_ROOT / proj
            if not proot.is_dir():
                print(f"[miss] {proot}")
                continue
            print(f"[scan] {proj}")
            for fpath in walk_project(proot):
                stats[proj]["files_scanned"] += 1
                skip, reason = should_skip(fpath)
                if skip:
                    stats[proj]["skipped"][reason] = stats[proj]["skipped"].get(reason, 0) + 1
                    if stats[proj]["skipped"][reason] <= 3:
                        fskip.write(f"{proj}\t{reason}\t{fpath}\n")
                    continue
                try:
                    text = fpath.read_text(encoding="utf-8", errors="ignore")
                except Exception:
                    continue
                stats[proj]["files_kept"] += 1
                rel = fpath.relative_to(proot).as_posix()
                file_rel = f"{proj}/{rel}"
                ext = fpath.suffix.lower()
                pairs: list[dict] = []
                if ext in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
                    pairs = extract_jsdoc_pairs(text, file_rel, ext.lstrip("."))
                elif ext == ".py":
                    pairs = extract_py_pairs(text, file_rel)
                # dedup within run via body hash
                for pa in pairs:
                    body = pa["messages"][1]["content"]
                    h = hashlib.sha1(body.encode("utf-8")).hexdigest()[:16]
                    if h in seen_hashes:
                        continue
                    seen_hashes.add(h)
                    fout.write(json.dumps(pa, ensure_ascii=False) + "\n")
                    total_pairs += 1
                    stats[proj]["pairs"] += 1

    # write stats md
    md_path = Path(".orcai/training/scraped-stats.md")
    with io.open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# Scraped pair stats\n\nTotal pairs: **{total_pairs}**\n\n")
        f.write("## Per project\n\n| project | scanned | kept | pairs | top skip reasons |\n|---|---:|---:|---:|---|\n")
        for proj, s in stats.items():
            top_skip = ", ".join(
                f"{r}={c}" for r, c in sorted(s["skipped"].items(), key=lambda x: -x[1])[:3]
            )
            f.write(f"| {proj} | {s['files_scanned']} | {s['files_kept']} | {s['pairs']} | {top_skip} |\n")
    print(f"\n[done] {total_pairs} pairs -> {out_path}")
    print(f"[done] stats -> {md_path}")
    print(f"[done] skipped log -> {skip_log}")


if __name__ == "__main__":
    main()
