"""
Generate R8 training pairs via Anthropic API (Claude as teacher).

Categories:
  - code patterns (NestJS, Next.js, testing, TypeORM, utils, docker) via SONNET
  - UX/UI design thinking via OPUS
  - Problem-clarification skill via OPUS

Output: .orcai/training/claude-gen-pairs.jsonl (each line = OpenAI chat format).

API key resolution order:
  1. env ANTHROPIC_API_KEY
  2. ~/.anthropic/api-key (single line)
  3. ~/.config/anthropic/api-key

Usage:
  ANTHROPIC_API_KEY=sk-ant-... python scripts/gen-claude-pairs.py \\
      --category all --concurrency 6 --dry-run
  # remove --dry-run to actually spend money
"""
import argparse
import io
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

MODEL_SONNET = "claude-sonnet-4-6"
MODEL_OPUS = "claude-opus-4-7"

OUT_PATH = Path(".orcai/training/claude-gen-pairs.jsonl")
LOG_PATH = Path(".orcai/training/claude-gen.log")

# ---------- API key resolution ----------

def load_api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    for cand in ("~/.anthropic/api-key", "~/.config/anthropic/api-key"):
        p = Path(os.path.expanduser(cand))
        if p.is_file():
            k = p.read_text(encoding="utf-8").strip()
            if k:
                return k
    sys.exit(
        "ANTHROPIC_API_KEY not set. Either:\n"
        "  1. export ANTHROPIC_API_KEY=sk-ant-...\n"
        "  2. echo 'sk-ant-...' > ~/.anthropic/api-key\n"
        "Get a key at: https://console.anthropic.com/settings/keys"
    )


# ---------- Task templates ----------
# Each template is a "meta-prompt" — we ask the teacher to invent a realistic
# user request in the target domain PLUS a high-quality solution. We extract
# the (prompt, solution) pair from the teacher's structured JSON reply.

SYS_CODE = """You are a senior Vietnamese full-stack engineer creating high-quality
training pairs for fine-tuning a 7B code assistant.

Output MUST be a single JSON object with exactly these fields:
  "user_prompt": a realistic Vietnamese coding request (mix Vietnamese
    with English technical terms, like a solo dev would write), 1-3 sentences
  "assistant_code": the idiomatic, production-grade solution (TypeScript/JS
    unless the request says otherwise). Must compile, be complete enough to
    drop into a project, and avoid `: any` unless the API signature requires it.
    Omit placeholder comments like `// TODO`.

No prose outside the JSON. No ```json fences. Just the raw object.
"""

SYS_UX = """You are a senior Vietnamese product engineer mentoring a junior on UX/UI
patterns. You will generate one training pair teaching a specific UX concept.

Output MUST be a single JSON object with exactly these fields:
  "user_prompt": a realistic Vietnamese request from a solo developer wanting
    a UI component or feature (1-3 sentences, mention the stack if relevant)
  "assistant_code": the *production* solution that demonstrates the UX lesson
    in code — normally a React/TSX component or hook. Must include ALL of:
    (1) correct loading / empty / error / success states where relevant,
    (2) accessibility (aria-*, role, focus management, keyboard),
    (3) responsive / mobile-first via Tailwind or CSS,
    (4) idiomatic shadcn/ui or tailwind-merge style composition if applicable.
    A short Vietnamese comment at the top explaining the UX reasoning is OK.
    Avoid `: any`. Avoid console.log.

No prose outside the JSON. No code fences. Raw object only.
"""

SYS_CLARIFY = """You are teaching a 7B code assistant the skill of clarifying vague user
requests BEFORE diving into code. This is a META skill training pair.

Output MUST be a single JSON object with exactly these fields:
  "user_prompt": a realistic AMBIGUOUS Vietnamese request that a solo dev might
    send (e.g. "Them auth cho app", "Toi ung app cham"), 1-2 sentences, lacking
    key details like stack / scope / constraints.
  "assistant_code": the assistant's reply. It MUST:
    (1) start by LISTING 3-6 concrete clarifying questions in Vietnamese,
        numbered, each calling out WHY the answer matters (one short phrase);
    (2) state 2-4 sensible default assumptions it will use if the user
        doesn't answer;
    (3) give a short skeleton / plan under those assumptions so the user isn't
        blocked (actual code fragment OK but not full solution).
    Format: plain text with the numbered list on top, then "Gia dinh tam:",
    then "Nhap:" with the skeleton.

No prose outside the JSON. No code fences. Raw object only.
"""

# Per-category recipes: (count, system_prompt, topic_hint_templates, model)
RECIPES = {
    # --- CODE PATTERNS (Sonnet) -------------------------------------------
    "nestjs": {
        "count": 400, "sys": SYS_CODE, "model": MODEL_SONNET,
        "topics": [
            "NestJS controller {verb} {resource} voi {auth} va {validation}",
            "NestJS service {domain} dung TypeORM Repository voi {feature}",
            "NestJS guard {name} kiem tra {condition} truoc khi cho qua",
            "NestJS interceptor {purpose} log/transform {target}",
            "NestJS DTO {resource} voi class-validator {constraints}",
            "NestJS module {domain} dong goi controller + service + repo",
            "NestJS pipe {transform} validate + transform {input}",
            "NestJS filter exception {kind} format response {shape}",
        ],
        "vars": {
            "verb": ["POST", "GET /:id", "PATCH /:id", "DELETE /:id", "GET search"],
            "resource": ["products", "orders", "users", "posts", "reviews", "carts", "media", "notifications"],
            "auth": ["JWT guard", "Roles guard", "API key", "optional auth"],
            "validation": ["DTO + class-validator", "Zod pipe", "DTO whitelist"],
            "domain": ["billing", "media", "catalog", "inventory", "analytics", "shipping"],
            "feature": ["pagination", "search text", "filter by category", "bulk upsert", "soft delete"],
            "name": ["RolesGuard", "OwnerGuard", "RateLimitGuard", "TenantGuard", "CsrfGuard"],
            "condition": ["user.role co quyen", "IP chua bi throttle", "resource thuoc user", "request co CSRF token"],
            "purpose": ["audit log", "response caching", "timeout", "retry idempotent"],
            "target": ["body", "response", "headers", "metrics"],
            "constraints": ["required fields", "enum roles", "min/max length", "nested object", "array of UUIDs"],
            "transform": ["trim strings", "parse int safe", "validate UUID", "parse date ISO"],
            "input": ["req.params", "req.query", "req.body"],
            "kind": ["Validation", "NotFound", "HttpException", "DB constraint"],
            "shape": ["{error, statusCode, path}", "RFC 7807 problem+json"],
        },
    },
    "nextjs": {
        "count": 350, "sys": SYS_CODE, "model": MODEL_SONNET,
        "topics": [
            "Next.js 15 App Router server action {action} voi {auth} va {validation}",
            "Next.js middleware {feature} chay truoc {path}",
            "Next.js route handler /app/api/{path}/route.ts method {method}",
            "Next.js layout {segment} voi {ui_feature}",
            "Next.js page server component fetch {resource} + {pattern}",
            "Next.js client component 'use client' dung {hook_pattern}",
        ],
        "vars": {
            "action": ["createPost", "updateProfile", "deleteAccount", "uploadAvatar", "checkout"],
            "auth": ["cookie session", "JWT cookie", "NextAuth", "no auth (public)"],
            "validation": ["Zod schema", "manual validate"],
            "feature": ["admin gate", "i18n redirect", "auth redirect", "A/B test cookie"],
            "path": ["/admin/*", "/dashboard/*", "/app/(user)/*"],
            "method": ["POST", "GET", "DELETE", "PATCH"],
            "segment": ["(marketing)", "(app)/dashboard", "admin"],
            "ui_feature": ["sidebar", "breadcrumbs", "user dropdown", "global search"],
            "resource": ["san pham list", "detail page", "user profile", "dashboard stats"],
            "pattern": ["ISR revalidate 60s", "no-cache dynamic", "parallel data fetch"],
            "hook_pattern": ["useTransition form", "useOptimistic add", "useFormState action", "useSWR poll"],
        },
    },
    "testing": {
        "count": 350, "sys": SYS_CODE, "model": MODEL_SONNET,
        "topics": [
            "Jest unit test cho function {target} — test {cases}",
            "Vitest test cho React component {component} — kiem tra {behavior}",
            "Playwright e2e test flow {flow} — assert {outcome}",
            "Jest integration test NestJS controller {resource} dung supertest",
            "Testing hook custom useXXX — mock {dependency}",
        ],
        "vars": {
            "target": ["slugify", "formatVND", "validatePhone", "parseJwt", "retryAsync"],
            "cases": ["happy path, edge cases, error", "null/undefined input", "max length boundary"],
            "component": ["PostList", "LoginForm", "ProductCard", "CartDrawer"],
            "behavior": ["render loading", "show error", "submit valid form", "keyboard navigation"],
            "flow": ["login + redirect", "add to cart + checkout", "upload image", "forgot password"],
            "outcome": ["redirect /dashboard", "toast success", "URL changes", "API called"],
            "resource": ["/api/auth/login", "/api/products", "/api/orders"],
            "dependency": ["fetch API", "localStorage", "router", "socket.io client"],
        },
    },
    "typeorm": {
        "count": 300, "sys": SYS_CODE, "model": MODEL_SONNET,
        "topics": [
            "TypeORM migration add {column} to {table} voi default {default}",
            "TypeORM entity {name} voi {relations}",
            "TypeORM repository custom method {query} dung QueryBuilder",
            "TypeORM transaction wrap {operation} dung DataSource",
            "TypeORM seeder script init {data}",
        ],
        "vars": {
            "column": ["deletedAt timestamp", "status enum", "slug unique", "metadata jsonb"],
            "table": ["users", "orders", "products", "posts"],
            "default": ["null", "now()", "empty string", "uuid_generate_v4()"],
            "name": ["Order", "User", "Product", "Review", "Notification"],
            "relations": ["ManyToOne user", "OneToMany items", "ManyToMany tags", "OneToOne profile"],
            "query": ["search voi full-text", "aggregate tong doanh thu", "top 10 by rating", "stale records"],
            "operation": ["create order + items atomic", "transfer balance", "merge duplicate users"],
            "data": ["admin users", "sample products", "categories tree"],
        },
    },
    "utils": {
        "count": 300, "sys": SYS_CODE, "model": MODEL_SONNET,
        "topics": [
            "TypeScript utility `{name}` — {desc}",
            "Node utility `{name}` — {desc}, test voi console.assert",
            "Vietnamese i18n helper `{name}` — {desc}",
            "Date/time helper `{name}` — {desc}",
            "Validation helper `{name}` — {desc}",
        ],
        "vars": {
            "name": [
                "chunkArray", "throttle", "pickBy", "deepClone", "safeJsonParse",
                "slugifyVi", "maskEmail", "maskPhoneVN", "formatRelativeTime",
                "parseQuery", "buildUrl", "hashObject", "sleep", "retryWithBackoff",
                "memoize", "debounce", "once", "groupBy", "sortByMultiple",
            ],
            "desc": [
                "chia array thanh chunk kich thuoc N, xu ly remainder",
                "han che goi fn moi {ms} ms, bo qua call thua",
                "pick key tu object theo predicate",
                "deep clone khong dung JSON (giu Date, Map)",
                "parse JSON safe, return default neu loi",
                "chuyen tieng Viet thanh slug (khong dau, lowercase, dash)",
                "che email: ab***@domain.com",
                "che SDT: +8491****78",
                "'2 phut truoc', '3 ngay truoc', tieng Viet",
                "parse query string thanh record an toan",
                "build URL tu base + path + query, encode dung",
                "hash stable object (order-independent) thanh string",
            ],
        },
    },
    "docker": {
        "count": 150, "sys": SYS_CODE, "model": MODEL_SONNET,
        "topics": [
            "Dockerfile multi-stage {stack} voi {feature}",
            "docker-compose.yml {services} cho dev",
            "Healthcheck endpoint {service} + Dockerfile HEALTHCHECK",
            "GitHub Actions workflow build + push Docker {stack}",
        ],
        "vars": {
            "stack": ["Node.js 20 + pnpm", "Next.js 15 standalone", "NestJS prod", "Python 3.11 FastAPI"],
            "feature": ["non-root user", "cache mount", "distroless runtime", "builder + runner split"],
            "services": ["mysql + redis + app", "postgres + worker", "mongo + minio"],
            "service": ["Express", "NestJS", "Next.js"],
        },
    },
    "refactor-debug": {
        "count": 250, "sys": SYS_CODE, "model": MODEL_SONNET,
        "topics": [
            "Debug React component bi {bug} — tim loi + fix",
            "Fix NestJS service race condition {scenario}",
            "Refactor controller {kind} — tach business logic ra service",
            "Fix Express memory leak {cause}",
            "Fix N+1 query TypeORM {context}",
        ],
        "vars": {
            "bug": ["infinite re-render", "stale closure", "memory leak subscription", "event listener duplicate"],
            "scenario": ["double-submit order", "counter increment race", "session token rotation"],
            "kind": ["bloated with validation + DB + email", "inline SQL", "hardcoded config"],
            "cause": ["unbounded cache", "setInterval khong clear", "listener tich luy"],
            "context": ["load posts + author + comments", "order list + items", "user + roles + perms"],
        },
    },
    # --- UX/UI THINKING (Opus) --------------------------------------------
    "ux-component-api": {
        "count": 100, "sys": SYS_UX, "model": MODEL_OPUS,
        "topics": [
            "Component {name} TSX voi variants: {variants}, size: {sizes}, state disabled + loading",
            "Compound component {name} (Root + Item + Trigger) voi keyboard nav",
            "Form field {name} voi label + error + helper text + aria",
            "Overlay {name} (Dialog/Sheet/Popover) voi focus trap + ESC close + portal",
        ],
        "vars": {
            "name": ["Button", "Badge", "Card", "Alert", "Input", "Select", "Tabs", "Accordion", "Dialog", "Drawer", "Toast", "Tooltip"],
            "variants": ["default/secondary/destructive/ghost/outline", "success/warning/info/danger"],
            "sizes": ["sm/md/lg", "compact/normal"],
        },
    },
    "ux-states": {
        "count": 100, "sys": SYS_UX, "model": MODEL_OPUS,
        "topics": [
            "{resource} list voi loading skeleton + empty state + error retry + success",
            "{form} voi submitting state + success toast + error recovery + dirty warning on leave",
            "{infinite_scroll} voi initial skeleton + loading-more indicator + end-of-list",
            "Search UI voi {debounce}, no-results state co suggestion, loading spinner inline",
        ],
        "vars": {
            "resource": ["Post", "Product", "Order", "Notification", "Comment", "User"],
            "form": ["LoginForm", "CheckoutForm", "ProfileForm", "PasswordResetForm"],
            "infinite_scroll": ["FeedList", "SearchResults", "ChatMessages"],
            "debounce": ["300ms", "500ms"],
        },
    },
    "ux-forms": {
        "count": 80, "sys": SYS_UX, "model": MODEL_OPUS,
        "topics": [
            "Form {what} voi inline validation on blur + submit-time + server error mapping",
            "Multi-step form {what} voi progress + back-next + validate step + save draft",
            "Form field {field} voi mask/format {format} va accessibility",
        ],
        "vars": {
            "what": ["Register", "Checkout address", "Post compose", "Feedback survey"],
            "field": ["PhoneInput VN", "CreditCardInput", "DateRangePicker", "MoneyInput VND", "OtpInput 6 digits"],
            "format": ["auto-format on blur", "live format as you type"],
        },
    },
    "ux-a11y": {
        "count": 60, "sys": SYS_UX, "model": MODEL_OPUS,
        "topics": [
            "Navigate {widget} bang keyboard day du (arrows, Home/End, ESC)",
            "Screen-reader announce {event} qua aria-live hoac role=status",
            "Focus management khi {scenario}",
            "Color contrast + focus ring cho theme toi/sang",
        ],
        "vars": {
            "widget": ["dropdown menu", "tabs", "combobox", "tree-view", "date-picker"],
            "event": ["form submit success", "new chat message", "item added to cart", "error occurred"],
            "scenario": ["mo dialog", "dong drawer", "chuyen trang SPA", "submit form thanh cong"],
        },
    },
    "ux-responsive": {
        "count": 50, "sys": SYS_UX, "model": MODEL_OPUS,
        "topics": [
            "Layout {name} mobile-first voi Tailwind, breakpoints sm/md/lg",
            "Navigation {variant} — mobile drawer, tablet-up sidebar + top bar",
            "Data table {resource} responsive: card on mobile, table on tablet+",
        ],
        "vars": {
            "name": ["Dashboard", "ProductGrid", "Two-column admin", "Landing hero"],
            "variant": ["Primary nav", "Dashboard sidebar"],
            "resource": ["Orders", "Users", "Products"],
        },
    },
    "ux-interactions": {
        "count": 50, "sys": SYS_UX, "model": MODEL_OPUS,
        "topics": [
            "Micro-interaction {element} voi framer-motion hoac Tailwind transition",
            "Optimistic update {action} + rollback on error + toast",
            "Skeleton loader shape matching {component}",
        ],
        "vars": {
            "element": ["Button press", "Toggle switch", "Heart like", "Copy-to-clipboard feedback"],
            "action": ["like post", "add to cart", "follow user", "vote poll"],
            "component": ["PostCard", "UserAvatar", "ProductGrid"],
        },
    },
    "ux-dark-mode": {
        "count": 20, "sys": SYS_UX, "model": MODEL_OPUS,
        "topics": [
            "Dark mode toggle voi next-themes + system preference + hydration-safe",
            "Color tokens CSS variables cho theme light/dark voi Tailwind",
        ],
        "vars": {},
    },
    # --- CLARIFICATION SKILL (Opus) ---------------------------------------
    "clarify-vague-feature": {
        "count": 80, "sys": SYS_CLARIFY, "model": MODEL_OPUS,
        "topics": [
            "User request mo ho: '{req}'",
        ],
        "vars": {
            "req": [
                "Them tinh nang comment cho post",
                "Lam trang admin",
                "Add search",
                "Toi muon app nhanh hon",
                "Viet auth di",
                "Em can dashboard",
                "App bi loi",
                "Refactor lai controller",
                "Tao landing page",
                "Add analytics",
            ],
        },
    },
    "clarify-bug": {
        "count": 40, "sys": SYS_CLARIFY, "model": MODEL_OPUS,
        "topics": [
            "User bug report thieu context: '{report}'",
        ],
        "vars": {
            "report": [
                "App bi freeze khi click nut submit",
                "Loi 500 khi upload",
                "Trang khong load",
                "Kh\u00f4ng nhan duoc email",
                "Build bi fail CI",
                "Deploy xong app chay cham",
                "Dang nhap xong tu dang xuat",
                "Webhook khong duoc goi",
            ],
        },
    },
    "clarify-scope": {
        "count": 40, "sys": SYS_CLARIFY, "model": MODEL_OPUS,
        "topics": [
            "Scope ambiguity: '{task}' — can xac dinh boundary",
        ],
        "vars": {
            "task": [
                "Migrate tu Pages Router sang App Router",
                "Chuyen tu Express sang NestJS",
                "Upgrade Node 18 -> 20",
                "Tach monolith thanh microservices",
                "Rewrite frontend bang React 19",
                "Them multi-tenant cho app hien tai",
            ],
        },
    },
    "clarify-perf": {
        "count": 30, "sys": SYS_CLARIFY, "model": MODEL_OPUS,
        "topics": [
            "Performance complaint: '{msg}'",
        ],
        "vars": {
            "msg": [
                "Trang cham qua",
                "Query DB bi timeout",
                "Memory usage cao bat thuong",
                "API response time spike",
                "Bundle size qua lon",
            ],
        },
    },
    "clarify-security": {
        "count": 30, "sys": SYS_CLARIFY, "model": MODEL_OPUS,
        "topics": [
            "Security concern: '{msg}'",
        ],
        "vars": {
            "msg": [
                "Lam sao de app an toan hon?",
                "Chong brute force login",
                "CSRF protection nhu nao",
                "Secret ro ri qua git, xu ly sao",
                "Penetration test tra ve XSS, fix the nao",
            ],
        },
    },
    "clarify-refactor": {
        "count": 30, "sys": SYS_CLARIFY, "model": MODEL_OPUS,
        "topics": [
            "Refactor request mo ho: '{msg}'",
        ],
        "vars": {
            "msg": [
                "Code cua toi qua ban, refactor di",
                "File auth.service.ts qua lon",
                "Don dep dead code",
                "Tach component PageHome",
                "Cleanup routes",
            ],
        },
    },
    # --- META SKILLS (summary / diagnose / solution / error-analysis) -----
    "summary-long-report": {
        "count": 60, "sys": (
            "You are teaching a 7B assistant to SUMMARIZE a long, noisy technical\n"
            "report / issue / log into a compact, actionable summary.\n\n"
            "Output MUST be a single JSON object: {user_prompt, assistant_code}.\n"
            "  user_prompt: a long Vietnamese dump (error report, meeting notes,\n"
            "    user feedback thread, PR discussion) — 500-2000 chars, realistic\n"
            "    and messy.\n"
            "  assistant_code: a structured Vietnamese summary — max 300 chars with:\n"
            "    (a) TL;DR one sentence,\n"
            "    (b) 3 bullet key points,\n"
            "    (c) 2-3 concrete next actions,\n"
            "    (d) severity tag [critical/major/minor/info].\n"
            "No prose outside JSON."
        ), "model": MODEL_OPUS,
        "topics": [
            "Summarize incident report: '{what}'",
            "Summarize PR discussion thread: '{what}'",
            "Summarize user bug report dump: '{what}'",
            "Summarize standup notes ve '{what}'",
        ],
        "vars": {
            "what": [
                "production deploy fail 3am, rollback + fix 5h",
                "refactor auth module, argue 2 hours",
                "app slow sau khi merge MR#234",
                "customer report: order bi duplicate",
                "load test timeout 500 errors",
            ],
        },
    },
    "diagnose-rootcause": {
        "count": 80, "sys": (
            "Teach the 7B to FIND the root cause given symptoms, a stack trace,\n"
            "or a misbehaving code snippet.\n\n"
            "Output: {user_prompt, assistant_code}.\n"
            "  user_prompt: symptoms + code or log snippet (200-1500 chars), real-looking.\n"
            "  assistant_code: structured Vietnamese diagnosis —\n"
            "    (1) `Root cause:` one sentence,\n"
            "    (2) `Bang chung:` pointer to specific line(s) / log entry,\n"
            "    (3) `Cach fix ngan:` 2-5 line patch snippet,\n"
            "    (4) `Ngan ngua:` 1-2 lines about how to avoid next time.\n"
            "No prose outside JSON."
        ), "model": MODEL_OPUS,
        "topics": [
            "Diagnose {bug} given code + log snippet",
            "Find root cause of {perf} from given trace",
            "Diagnose {db} issue from query log",
        ],
        "vars": {
            "bug": [
                "race condition login", "infinite useEffect loop",
                "memory leak setInterval", "JWT verify fail intermittent",
                "stale React state after mutation", "CORS preflight fail",
                "socket.io disconnect loop", "redis cache stale",
                "cookie HttpOnly missing on prod",
            ],
            "perf": [
                "API response p99 spike 5s", "bundle size 3MB after upgrade",
                "DB CPU 95% sau deploy", "frontend FCP 4s tren 3G",
            ],
            "db": [
                "N+1 query posts + comments", "slow query orders by date",
                "deadlock 2 transactions", "missing index users.email",
            ],
        },
    },
    "solution-proposal": {
        "count": 80, "sys": (
            "Teach the 7B to PROPOSE 2-3 alternative solutions for a given problem,\n"
            "each with trade-offs, then a recommendation.\n\n"
            "Output: {user_prompt, assistant_code}.\n"
            "  user_prompt: a concrete problem statement in Vietnamese (100-500 chars).\n"
            "  assistant_code: Vietnamese structured reply —\n"
            "    `Option A: <name>` (3 bullets: pros / cons / when)\n"
            "    `Option B: <name>` (same 3 bullets)\n"
            "    optional `Option C: <name>`\n"
            "    `Khuyen nghi:` one sentence + why,\n"
            "    `Rui ro chinh:` 1-2 lines.\n"
            "Code snippets OK but brief. No prose outside JSON."
        ), "model": MODEL_OPUS,
        "topics": [
            "Propose solutions for: '{problem}'",
        ],
        "vars": {
            "problem": [
                "Chong race condition counter increment",
                "Cache layer cho API get-user, invalidate thong minh",
                "Rate limit /api/login chong brute force",
                "Upload anh lon, ne OOM backend",
                "Real-time notifications: SSE vs WebSocket vs polling",
                "Migration du lieu 10M rows khong downtime",
                "Multi-tenant DB: shared schema vs schema-per-tenant vs DB-per-tenant",
                "SEO cho SPA: SSR vs SSG vs hybrid",
                "Store sensitive config: env vars vs KMS vs Vault",
                "Pagination large offset: offset vs cursor vs keyset",
                "Image optimization: next/image vs sharp self-host vs CDN",
                "Full-text search: Postgres FTS vs Meilisearch vs Elastic",
                "Queue: Bull vs BullMQ vs SQS",
                "Database: Postgres vs MySQL vs MongoDB cho ecommerce",
                "API style: REST vs GraphQL vs tRPC",
                "Logging: console + centralized service vs structured file",
                "Background job retry: exponential vs constant vs dead letter",
                "Session store: Redis vs JWT stateless vs DB table",
            ],
        },
    },
    "error-analysis-calc": {
        "count": 60, "sys": (
            "Teach the 7B to ANALYZE a quantitative error / performance report\n"
            "with actual numbers — compute percentages, trends, magnitudes,\n"
            "estimate root cause impact.\n\n"
            "Output: {user_prompt, assistant_code}.\n"
            "  user_prompt: a metrics dump + symptom (bench result, log counts,\n"
            "    latency histogram, memory profile, DB query stats).\n"
            "  assistant_code: structured Vietnamese analysis —\n"
            "    (1) `Quan sat:` concrete numbers, compute ratios / deltas,\n"
            "    (2) `Gia thuyet:` 1-2 likely causes ranked by impact,\n"
            "    (3) `Test thu:` 1 concrete experiment to confirm,\n"
            "    (4) `Impact:` estimated % improvement if fixed.\n"
            "Show the math inline where useful. No prose outside JSON."
        ), "model": MODEL_OPUS,
        "topics": [
            "Analyze latency histogram: p50={p50}, p95={p95}, p99={p99} — {context}",
            "Analyze error rate: {err} errors over {total} requests trong {window}",
            "Analyze memory growth: heap start {start}MB, after 1h {end}MB — {hint}",
            "Analyze DB query stats: {slow} slow queries out of {total}, avg {ms}ms",
        ],
        "vars": {
            "p50": ["80ms", "200ms", "500ms"],
            "p95": ["300ms", "1.2s", "3s"],
            "p99": ["2s", "8s", "15s"],
            "context": [
                "API /products list, cache off",
                "login endpoint sau them 2FA",
                "upload photo voi thumbnail pipeline",
            ],
            "err": ["1523", "47", "8200"],
            "total": ["200000", "15000", "500000"],
            "window": ["1h", "peak traffic 10 phut", "1 ngay"],
            "start": ["120", "500", "1400"],
            "end": ["1800", "3400", "6800"],
            "hint": ["moi request them 1 listener", "cache Map khong co TTL"],
            "slow": ["47", "230", "1100"],
            "ms": ["850", "2400", "6100"],
        },
    },
}


def fill_template(tmpl: str, vars: dict[str, list[str]], rng: random.Random) -> str:
    out = tmpl
    for k, opts in vars.items():
        if "{" + k + "}" in out:
            out = out.replace("{" + k + "}", rng.choice(opts))
    return out


def make_prompt(seed: int, topic: str) -> str:
    return (
        f"[seed {seed}] Topic to teach the 7B student this turn: {topic}\n\n"
        "Emit exactly one JSON object per the system instructions. Do not explain."
    )


# ---------- API call ----------

_lock = threading.Lock()
_counters = {"ok": 0, "fail": 0, "tokens_in": 0, "tokens_out": 0}


def call_claude(api_key: str, model: str, system: str, user: str, max_tokens: int = 2000, retries: int = 3) -> dict | None:
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
        },
    )
    delay = 2
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return None
        except Exception:
            if attempt < retries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return None
    return None


def extract_pair(api_resp: dict, meta_extras: dict) -> dict | None:
    if not api_resp or "content" not in api_resp:
        return None
    try:
        text = "".join(
            blk.get("text", "") for blk in api_resp["content"] if blk.get("type") == "text"
        ).strip()
        # Strip possible fences defensively
        if text.startswith("```"):
            text = text.strip("`").split("\n", 1)[-1]
            if text.endswith("```"):
                text = text.rsplit("```", 1)[0]
        obj = json.loads(text)
        up = (obj.get("user_prompt") or "").strip()
        ac = (obj.get("assistant_code") or "").strip()
        if len(up) < 20 or len(ac) < 50:
            return None
        pair = {
            "messages": [
                {"role": "user", "content": up},
                {"role": "assistant", "content": ac},
            ],
            "meta": {
                "source": "claude-gen-r8",
                **meta_extras,
            },
        }
        usage = api_resp.get("usage", {})
        with _lock:
            _counters["tokens_in"] += int(usage.get("input_tokens", 0))
            _counters["tokens_out"] += int(usage.get("output_tokens", 0))
        return pair
    except Exception:
        return None


# ---------- Driver ----------

def generate(category: str, recipe: dict, api_key: str, concurrency: int, dry_run: bool, append_fh) -> int:
    n = recipe["count"]
    rng = random.Random(hash(category) & 0xFFFFFFFF)
    jobs = []
    for seed in range(n):
        tmpl = rng.choice(recipe["topics"])
        topic = fill_template(tmpl, recipe["vars"], rng)
        jobs.append((seed, topic))
    if dry_run:
        print(f"[dry] {category}: would generate {n} pairs with model={recipe['model']}")
        for s, t in jobs[:3]:
            print(f"  sample: {t}")
        return 0

    sys_prompt = recipe["sys"]
    model = recipe["model"]

    written = 0
    start = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = {
            ex.submit(call_claude, api_key, model, sys_prompt, make_prompt(s, t)): (s, t)
            for s, t in jobs
        }
        for fut in as_completed(futs):
            seed, topic = futs[fut]
            resp = fut.result()
            pair = extract_pair(resp, {
                "category": category,
                "model": model,
                "topic": topic,
                "seed": seed,
            })
            with _lock:
                if pair:
                    append_fh.write(json.dumps(pair, ensure_ascii=False) + "\n")
                    append_fh.flush()
                    _counters["ok"] += 1
                    written += 1
                else:
                    _counters["fail"] += 1
                if (_counters["ok"] + _counters["fail"]) % 25 == 0:
                    elapsed = time.time() - start
                    rate = (_counters["ok"] + _counters["fail"]) / max(1, elapsed)
                    print(
                        f"  [{category}] ok={_counters['ok']} fail={_counters['fail']} "
                        f"rate={rate:.2f}/s tokens={_counters['tokens_in']}/{_counters['tokens_out']}"
                    )
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", default="all", help="all | comma-separated recipe keys")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args()

    api_key = "" if args.dry_run else load_api_key()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    if args.category == "all":
        targets = list(RECIPES.keys())
    else:
        targets = [c.strip() for c in args.category.split(",") if c.strip()]
        missing = [c for c in targets if c not in RECIPES]
        if missing:
            sys.exit(f"unknown categories: {missing}. Available: {list(RECIPES.keys())}")

    # In dry-run just print counts
    if args.dry_run:
        total = 0
        for c in targets:
            r = RECIPES[c]
            total += r["count"]
            print(f"  {c}: {r['count']} pairs via {r['model']}")
        print(f"TOTAL: {total} pairs")
        return

    # Append mode to allow resuming
    with io.open(args.out, "a", encoding="utf-8") as fh:
        for c in targets:
            r = RECIPES[c]
            print(f"\n=== {c} ({r['count']} pairs, model={r['model']}) ===")
            generate(c, r, api_key, args.concurrency, False, fh)

    print(f"\n[done] total ok={_counters['ok']} fail={_counters['fail']}")
    print(f"  tokens: in={_counters['tokens_in']} out={_counters['tokens_out']}")
    # Rough cost estimate (Sonnet: $3/$15, Opus: $15/$75 per MTok — v rough)
    cost = (_counters['tokens_in'] * 0.000009 + _counters['tokens_out'] * 0.000045)
    print(f"  est cost: ${cost:.2f}  (mix-model average, actual depends on model split)")


if __name__ == "__main__":
    main()
