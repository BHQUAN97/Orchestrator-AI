"""Extract R6 failure problem details (prompt + scoring rubric) from JS source."""
import io
import json
import re

txt = io.open("test/problems-realistic.js", encoding="utf-8").read()

FAILS = {7, 12, 13, 14, 15, 17, 18, 26, 27, 28, 30, 31, 34, 37, 39}

# Split per problem block: each starts with `  {\n` at top-level inside the array.
# Use the closing `\n  }` as separator.
blocks = re.split(r"\n  \},?\s*\n  \{", txt)

result = {}
for b in blocks:
    m_id = re.search(r"id:\s*(\d+),", b)
    if not m_id:
        continue
    pid = int(m_id.group(1))
    if pid not in FAILS:
        continue

    m_key = re.search(r"key:\s*'([^']+)'", b)
    m_cat = re.search(r"category:\s*'([^']+)'", b)
    m_diff = re.search(r"difficulty:\s*'([^']+)'", b)
    m_lang = re.search(r"lang:\s*'([^']+)'", b)
    m_prompt = re.search(r'prompt:\s*"((?:[^"\\]|\\.)*)"', b, re.DOTALL)
    m_hint = re.search(r'hint:\s*"((?:[^"\\]|\\.)*)"', b, re.DOTALL)
    m_kw = re.search(r"keywords:\s*\[(.*?)\]", b, re.DOTALL)
    m_tm = re.search(r"testMarker:\s*(/[^\n]*?)(?:,\s*\n)", b)
    m_bp = re.search(r"badPractices:\s*\[(.*?)\]", b, re.DOTALL)
    m_sf = re.search(r"sourceFile:\s*'([^']+)'", b)

    def unescape(s):
        return s.encode("utf-8").decode("unicode_escape") if s else ""

    result[pid] = {
        "key": m_key.group(1) if m_key else "",
        "category": m_cat.group(1) if m_cat else "",
        "difficulty": m_diff.group(1) if m_diff else "",
        "lang": m_lang.group(1) if m_lang else "",
        "prompt": unescape(m_prompt.group(1)) if m_prompt else "",
        "hint": unescape(m_hint.group(1)) if m_hint else "",
        "keywords": (m_kw.group(1).strip() if m_kw else ""),
        "testMarker": (m_tm.group(1).strip() if m_tm else ""),
        "badPractices": (m_bp.group(1).strip() if m_bp else ""),
        "sourceFile": m_sf.group(1) if m_sf else "",
    }

with io.open(".orcai/r6-failures-detail.json", "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"wrote {len(result)} failures")
print("ids:", sorted(result.keys()))
print("missing:", sorted(FAILS - set(result.keys())))
