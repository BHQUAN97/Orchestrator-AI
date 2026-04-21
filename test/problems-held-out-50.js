'use strict';
// Held-out evaluation set — 50 problems NEVER used in training or patching.
// Zero overlap with problems-realistic.js.
// Purpose: honest generalization signal for R7/R8/R9 comparison.
// Built: 2026-04-20

const PROBLEMS_HELD_OUT_50 = [

  // ── auth (4) ──────────────────────────────────────────────────────
  {
    id: 1, key: 'api-key-middleware', category: 'auth', difficulty: 'easy', lang: 'js',
    prompt: "Viet Express middleware `apiKeyAuth(req,res,next)` — lay API key tu header X-API-Key, so sanh voi process.env.API_KEY bang crypto.timingSafeEqual de tranh timing attack. Return 401 JSON {error} neu thieu hoac sai. Chi tra code JS.",
    hint: "dung Buffer.from de chuyen string truoc khi compare. timingSafeEqual require 2 buffer cung do dai — pad hoac check length truoc.",
    keywords: [/X-API-Key|x-api-key/i, /timingSafeEqual/, /crypto/, /401/, /process\.env\.API_KEY/],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/===.*key|key.*===/],
  },
  {
    id: 2, key: 'refresh-token-middleware', category: 'auth', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS middleware `RefreshTokenMiddleware` implement NestMiddleware — neu request co cookie refreshToken hop le (verify JWT voi process.env.REFRESH_SECRET), tao access token moi va set header Authorization: Bearer <token> de controller phia sau dung. Bao qua neu khong co cookie. Chi tra code TS.",
    hint: "implement NestMiddleware. Dung cookie-parser da setup. jwt.sign voi expiresIn '15m'. Try/catch de skip khi token het han.",
    keywords: [/NestMiddleware/, /refreshToken|refresh_token/i, /jwt\.verify|jwt\.sign/, /REFRESH_SECRET/, /Authorization/],
    testMarker: /export\s+class\s+\w+Middleware/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 3, key: 'permission-decorator', category: 'auth', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS `@RequirePermissions(...perms)` decorator va PermissionsGuard — guard check req.user.permissions (string[]) co chua TAT CA perms yeu cau. Return 403 neu thieu bat ky permission nao. Chi tra code TS.",
    hint: "SetMetadata('permissions', perms). Guard dung Reflector.getAllAndOverride. every() check.",
    keywords: [/SetMetadata|RequirePermissions/, /Reflector/, /permissions/, /every\(|includes\(/, /403/],
    testMarker: /@Injectable\(\)|export\s+(class|function|const)\s+\w+(Guard|Decorator)/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 4, key: 'session-store-redis', category: 'auth', difficulty: 'medium', lang: 'js',
    prompt: "Viet Express session setup dung express-session voi Redis store (connect-redis). Config: secret tu process.env.SESSION_SECRET, cookie httpOnly + secure khi production, maxAge 24h, resave false, saveUninitialized false. Chi tra code JS.",
    hint: "const RedisStore = require('connect-redis')(session). createClient tu redis package. Kiem tra NODE_ENV==='production' de set secure cookie.",
    keywords: [/express-session|session\(/, /RedisStore|connect-redis/, /SESSION_SECRET/, /httpOnly/, /resave\s*:\s*false/],
    testMarker: /module\.exports|app\.use\(session/,
    badPractices: [/console\.log/],
  },

  // ── express (3) ───────────────────────────────────────────────────
  {
    id: 5, key: 'request-id-middleware', category: 'express', difficulty: 'easy', lang: 'js',
    prompt: "Viet Express middleware gan request ID cho moi request — neu da co header X-Request-Id thi dung lai, neu khong tao UUID v4 bang crypto.randomUUID(). Set req.id va res header X-Request-Id. Chi tra code JS.",
    hint: "req.id = req.headers['x-request-id'] || crypto.randomUUID(). res.setHeader sau khi set req.id.",
    keywords: [/X-Request-Id|x-request-id/i, /randomUUID|uuid/i, /req\.id\s*=/, /res\.setHeader/],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/Math\.random/],
  },
  {
    id: 6, key: 'body-size-limit', category: 'express', difficulty: 'easy', lang: 'js',
    prompt: "Viet Express middleware kiem tra Content-Length cua POST/PUT/PATCH request, reject 413 neu lon hon MAX_BODY_BYTES (default 1MB). Bo qua GET/HEAD/DELETE. Chi tra code JS.",
    hint: "const MAX = Number(process.env.MAX_BODY_BYTES) || 1048576. Check req.headers['content-length']. SAFE_METHODS array.",
    keywords: [/content-length/i, /413/, /1048576|1\s*\*\s*1024|MAX_BODY/, /GET.*HEAD|SAFE/],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/console\.log/],
  },
  {
    id: 7, key: 'cors-middleware', category: 'express', difficulty: 'medium', lang: 'js',
    prompt: "Viet Express CORS middleware tu viet (khong dung package cors) — cho phep origins tu ALLOWED_ORIGINS env (comma-separated), method GET/POST/PUT/DELETE/PATCH, headers Content-Type + Authorization. Handle preflight OPTIONS return 204. Chi tra code JS.",
    hint: "ALLOWED_ORIGINS.split(',').map(s=>s.trim()). Check req.headers.origin trong whitelist. res.setHeader Access-Control-Allow-Origin chi voi origin match.",
    keywords: [/Access-Control-Allow-Origin/, /Access-Control-Allow-Methods/, /ALLOWED_ORIGINS/, /OPTIONS/, /204/],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/\*.*Access-Control-Allow-Origin|Access-Control.*\*/],
  },

  // ── nestjs (4) ───────────────────────────────────────────────────
  {
    id: 8, key: 'nest-exception-filter', category: 'nestjs', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS AllExceptionsFilter implement ExceptionFilter — bat tat ca exception, neu la HttpException lay status + message cua no, con lai tra 500. Response JSON {statusCode, message, timestamp, path}. Chi tra code TS.",
    hint: "Catch(). context.switchToHttp(). exception instanceof HttpException ? exception.getResponse() : 500.",
    keywords: [/ExceptionFilter/, /Catch\(\)/, /HttpException/, /getResponse\(\)/, /timestamp/, /switchToHttp/],
    testMarker: /@Catch\(\)|export\s+class\s+\w+Filter/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 9, key: 'nest-config-service', category: 'nestjs', difficulty: 'easy', lang: 'ts',
    prompt: "Viet NestJS module dung @nestjs/config — AppConfigService inject ConfigService, expose cac getter: dbUrl (string), port (number, default 3000), isProduction (boolean). Throw error khi DB_URL khong co. Chi tra code TS.",
    hint: "configService.get<string>('DB_URL'). configService.get<number>('PORT', 3000). NODE_ENV === 'production'.",
    keywords: [/ConfigService/, /@nestjs\/config/, /get<string>|get<number>/, /DB_URL/, /isProduction/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+Config/,
    badPractices: [/process\.env\.\w+(?!\s*\|\|)/],
  },
  {
    id: 10, key: 'nest-pagination-pipe', category: 'nestjs', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS PaginationPipe implement PipeTransform — transform query string {page, limit} thanh {skip, take} (so nguyen, page>=1, limit 1-100 default 20). Throw BadRequestException neu gia tri invalid. Chi tra code TS.",
    hint: "PipeTransform<any, {skip:number,take:number}>. parseInt + isNaN check. Math.min(limit, 100). skip = (page-1)*take.",
    keywords: [/PipeTransform/, /BadRequestException/, /parseInt|Number\(/, /skip\s*=|skip:/, /take\s*=|take:/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+Pipe/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 11, key: 'nest-health-check', category: 'nestjs', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS HealthController dung @nestjs/terminus — endpoint GET /health kiem tra database (TypeOrmHealthIndicator) va disk (DiskHealthIndicator threshold 90%). Tra {status:'ok'} hoac 503. Chi tra code TS.",
    hint: "@HealthCheck(). this.db.pingCheck('database'). this.disk.checkStorage('disk', {thresholdPercent:0.9, path:'/'}).",
    keywords: [/HealthCheck|@HealthCheck/, /TypeOrmHealthIndicator|DiskHealthIndicator/, /pingCheck|checkStorage/, /terminus/, /503|SERVICE_UNAVAILABLE/],
    testMarker: /@Controller\('health'\)|export\s+class\s+\w+Health/,
    badPractices: [/:\s*any\b/],
  },

  // ── nextjs (4) ───────────────────────────────────────────────────
  {
    id: 12, key: 'next-generate-metadata', category: 'nextjs', difficulty: 'easy', lang: 'ts',
    prompt: "Viet Next.js 15 `generateMetadata({ params })` cho trang product detail — fetch product tu /api/products/:id, tra Metadata voi title, description (cut 160 char), openGraph image. Neu khong tim thay product return notFound(). Chi tra code TS.",
    hint: "import { Metadata } from 'next'. async function generateMetadata. fetch voi next:{revalidate:60}. description.slice(0,160).",
    keywords: [/generateMetadata/, /Metadata/, /openGraph/, /notFound\(\)/, /revalidate|cache/],
    testMarker: /export\s+(async\s+)?function\s+generateMetadata/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 13, key: 'next-route-handler-post', category: 'nextjs', difficulty: 'medium', lang: 'ts',
    prompt: "Viet Next.js App Router route handler POST /api/contact — validate body {name:string, email:string, message:string} (yeu cau ca 3), gui email qua nodemailer (SMTP config tu env), return 201 {id} hoac 400/500 JSON. Chi tra code TS.",
    hint: "import { NextRequest, NextResponse } from 'next/server'. req.json(). createTransport. sendMail. Xu ly async error.",
    keywords: [/NextRequest|NextResponse/, /req\.json\(\)/, /createTransport|nodemailer/, /sendMail/, /201|NextResponse\.json/],
    testMarker: /export\s+(async\s+)?function\s+POST/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 14, key: 'next-server-action-form', category: 'nextjs', difficulty: 'medium', lang: 'ts',
    prompt: "Viet Next.js 15 server action `submitContactForm(formData: FormData)` — validate name/email/message tu formData, neu loi return {errors:{field:string}}. Neu ok save vao DB qua prisma.contact.create, return {success:true, id}. Chi tra code TS.",
    hint: "'use server'. formData.get('name'). Zod hoac manual validate. revalidatePath sau khi save.",
    keywords: [/'use server'/, /FormData/, /formData\.get\(/, /prisma\.\w+\.create|db\.\w+/, /revalidatePath|revalidateTag/],
    testMarker: /export\s+(async\s+)?function\s+\w+Form|'use server'/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 15, key: 'next-parallel-routes-loading', category: 'nextjs', difficulty: 'medium', lang: 'ts',
    prompt: "Viet Next.js layout component co 2 parallel data fetch song song (Promise.all) — fetch user profile va user orders tu cac API endpoint rieng biet, hien thi ca hai. Dung Suspense voi fallback cho tung phan. Chi tra code TSX.",
    hint: "async layout/page component. Promise.all([fetchUser(id), fetchOrders(id)]). <Suspense fallback={<Loading/>}>.",
    keywords: [/Promise\.all/, /Suspense/, /fallback/, /async\s+function|async\s+\(/, /await/],
    testMarker: /export\s+(default\s+)?(async\s+)?function\s+\w+(Layout|Page)/,
    badPractices: [/useEffect|useState/],
  },

  // ── ts-type (3) ──────────────────────────────────────────────────
  {
    id: 16, key: 'branded-type', category: 'ts-type', difficulty: 'medium', lang: 'ts',
    prompt: "Viet TypeScript branded types cho UserId, OrderId, ProductId (deu la string underneath). Viet `brand<T, B>(value: T): T & Brand<B>` function. Viet function `getUserById(id: UserId)` — phai bao loi compile khi truyen plain string hoac OrderId sai. Chi tra code TS.",
    hint: "type Brand<B> = { readonly __brand: B }. type UserId = string & Brand<'UserId'>. Cast ban dau qua `brand<string,'UserId'>(rawId)` de tao gia tri.",
    keywords: [/Brand|__brand/, /UserId|OrderId|ProductId/, /brand<|brand\(/, /string &/, /readonly/],
    testMarker: /export\s+(type|function|const)\s+\w+(Id|brand)/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 17, key: 'required-deep', category: 'ts-type', difficulty: 'hard', lang: 'ts',
    prompt: "Viet TypeScript `RequiredDeep<T>` — giong Required nhung de quy cho tat ca nested objects (khong anh huong Array items). Test voi type co optional nested. Chi tra code TS.",
    hint: "T extends Array<infer U> ? Array<U> : T extends object ? { [K in keyof T]-?: RequiredDeep<T[K]> } : T",
    keywords: [/RequiredDeep/, /extends\s+(object|Array)/, /-\?\s*:/, /infer\s+\w+/],
    testMarker: /export\s+type\s+RequiredDeep/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 18, key: 'discriminated-union-narrow', category: 'ts-type', difficulty: 'medium', lang: 'ts',
    prompt: "Viet TypeScript discriminated union `ApiResult<T>` voi shape {status:'ok', data:T} | {status:'error', code:number, message:string}. Viet function `unwrap<T>(r: ApiResult<T>): T` throw Error khi error. Chi tra code TS.",
    hint: "switch(r.status). TypeScript phai narrow dung. throw new Error(`[${r.code}] ${r.message}`).",
    keywords: [/ApiResult/, /status:\s*'ok'|status:\s*'error'/, /unwrap/, /switch.*status|if.*status/, /throw\s+new\s+Error/],
    testMarker: /export\s+(type|interface|function)\s+\w+(Result|unwrap)/,
    badPractices: [/:\s*any\b/],
  },

  // ── validation (3) ───────────────────────────────────────────────
  {
    id: 19, key: 'cccd-validate', category: 'validation', difficulty: 'easy', lang: 'ts',
    prompt: "Viet function `validateCCCD(id: string): boolean` — CCCD Viet Nam hop le phai: 12 chu so, bat dau bang ma tinh (012-096 chan), khong co chu cai. Tra true/false. Chi tra code TS.",
    hint: "/^\\d{12}$/.test(). parseInt(id.slice(0,3)) check range. Danh sach ma tinh hoac range 001-099 theo quy dinh.",
    keywords: [/validateCCCD|cccd/i, /^\^\\d\{12\}|\\d{12}/, /slice\(0|substring/, /test\(|match\(/],
    testMarker: /export\s+(function|const)\s+validate\w+/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 20, key: 'date-range-validate', category: 'validation', difficulty: 'easy', lang: 'ts',
    prompt: "Viet function `validateDateRange(start: string, end: string, maxDays = 90): {valid: boolean, error?: string}` — parse ISO date, check start < end, check khoang cach <= maxDays. Chi tra code TS.",
    hint: "new Date(start).getTime(). Check isNaN. end - start in ms. Math.floor(diff / 86400000).",
    keywords: [/validateDateRange/, /new Date\(/, /isNaN/, /86400000|days/, /valid\s*:\s*(true|false)/],
    testMarker: /export\s+(function|const)\s+validate\w+/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 21, key: 'password-strength', category: 'validation', difficulty: 'easy', lang: 'ts',
    prompt: "Viet function `checkPasswordStrength(pw: string): {score: 0|1|2|3|4, label: string}` — score theo: do dai >=8, co chu hoa, chu thuong, so, ky tu dac biet. Moi dieu kien +1 diem, score 0-4. Labels: 'weak'|'fair'|'good'|'strong'|'very strong'. Chi tra code TS.",
    hint: "Regex rieng cho tung dieu kien. Array.filter(Boolean).length cho score.",
    keywords: [/checkPasswordStrength/, /score/, /[A-Z]|uppercase|hoa/, /[0-9]|digit|so/, /special|dac biet|[!@#$]/],
    testMarker: /export\s+(function|const)\s+check\w+/,
    badPractices: [/:\s*any\b/],
  },

  // ── node-util (3) ────────────────────────────────────────────────
  {
    id: 22, key: 'retry-exponential', category: 'node-util', difficulty: 'medium', lang: 'ts',
    prompt: "Viet `retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 200): Promise<T>` — retry voi exponential backoff + jitter (2^attempt * baseDelay + random 0-100ms). Throw loi cuoi cung neu het retry. Chi tra code TS.",
    hint: "for loop hoac recursive. await new Promise(r=>setTimeout(r, delay)). delay = Math.pow(2,i)*baseDelay + Math.random()*100.",
    keywords: [/retryWithBackoff/, /Math\.pow|2\s*\*\*|<</, /Math\.random\(\)/, /setTimeout/, /maxRetries/],
    testMarker: /export\s+(async\s+)?function\s+retry\w+/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 23, key: 'lru-cache', category: 'node-util', difficulty: 'medium', lang: 'ts',
    prompt: "Viet class `LRUCache<K, V>(capacity: number)` — get(key) tra undefined neu miss, set(key, value) evict LRU khi full. O(1) cho ca get va set dung Map (insertion order). Chi tra code TS.",
    hint: "Map giu insertion order. get: delete roi re-set de move to end. set: delete oldest = map.keys().next().value khi size > capacity.",
    keywords: [/LRUCache/, /Map/, /delete\s*\(/, /keys\(\)\.next\(\)/, /capacity/],
    testMarker: /export\s+(class|default\s+class)\s+LRU/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 24, key: 'event-emitter-typed', category: 'node-util', difficulty: 'medium', lang: 'ts',
    prompt: "Viet class `TypedEventEmitter<Events extends Record<string, any[]>>` — method on(event, listener), emit(event, ...args), off(event, listener). Type-safe: on('data', (buf: Buffer) => void) phai check dung. Chi tra code TS.",
    hint: "Map<keyof Events, Function[]>. on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void).",
    keywords: [/TypedEventEmitter/, /Record<string/, /extends\s+keyof/, /Map</, /on\s*<|emit\s*</],
    testMarker: /export\s+(class|default\s+class)\s+\w+Emitter/,
    badPractices: [/:\s*any\b/],
  },

  // ── db (4) ───────────────────────────────────────────────────────
  {
    id: 25, key: 'typeorm-transaction', category: 'db', difficulty: 'medium', lang: 'ts',
    prompt: "Viet TypeORM service method `transferFunds(fromId: string, toId: string, amount: number): Promise<void>` — deduct amount tu fromId, add vao toId trong 1 transaction. Throw BusinessError neu so du khong du. Chi tra code TS.",
    hint: "dataSource.transaction(async manager => {...}). manager.findOne({lock:{mode:'pessimistic_write'}}). Check balance truoc deduct.",
    keywords: [/transaction\s*\(|\.transaction/, /pessimistic_write|lock/, /manager\.findOne|manager\.save/, /BusinessError|InsufficientFunds/, /amount/],
    testMarker: /export\s+(class|async\s+function)\s+\w+(Service|transfer)/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 26, key: 'soft-delete-repo', category: 'db', difficulty: 'easy', lang: 'ts',
    prompt: "Viet TypeORM base entity voi soft delete — column deletedAt nullable, method `softDelete()` set deletedAt = new Date(). Viet repo method `findActive()` chi lay ban ghi chua xoa (deletedAt IS NULL). Chi tra code TS.",
    hint: "@Column({nullable:true}) deletedAt: Date | null. @BeforeRemove hoac method rieng. createQueryBuilder().where('deletedAt IS NULL').",
    keywords: [/deletedAt/, /@Column.*nullable/, /IS NULL|isNull/, /softDelete|soft_delete/, /findActive|active/],
    testMarker: /export\s+(class|abstract\s+class)\s+\w+(Entity|Base)/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 27, key: 'paginate-typeorm', category: 'db', difficulty: 'medium', lang: 'ts',
    prompt: "Viet generic function `paginate<T>(repo: Repository<T>, options: {page:number, limit:number, where?:FindOptionsWhere<T>, order?:FindOptionsOrder<T>}): Promise<{data:T[], total:number, pages:number}>` dung TypeORM. Chi tra code TS.",
    hint: "repo.findAndCount({skip:(page-1)*limit, take:limit, where, order}). pages = Math.ceil(total/limit).",
    keywords: [/paginate/, /findAndCount/, /skip\s*:|take\s*:/, /Math\.ceil/, /FindOptionsWhere|FindOptions/],
    testMarker: /export\s+(async\s+)?function\s+paginate/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 28, key: 'upsert-redis-counter', category: 'db', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS service method `incrementPageView(slug: string): Promise<number>` — dung Redis INCR de dem view, set TTL 24h khi key moi tao (SETNX pattern). Tra so luot view hien tai. Chi tra code TS.",
    hint: "const key = `pv:${slug}`. client.incr(key). SETNX + EXPIRE hoac SET EX NX. Multi/pipeline de atomic.",
    keywords: [/incr\(|INCR/, /setnx|SET.*NX|expire\(|EXPIRE/, /pv:|pageview/i, /ttl|TTL|86400/, /slug/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+Service/,
    badPractices: [/:\s*any\b/],
  },

  // ── devops (4) ───────────────────────────────────────────────────
  {
    id: 29, key: 'dockerfile-multistage', category: 'devops', difficulty: 'medium', lang: 'dockerfile',
    prompt: "Viet multi-stage Dockerfile cho Next.js 15 app — stage 1 (deps): cai production deps. Stage 2 (builder): copy src + build. Stage 3 (runner): dung node:20-alpine, copy tu builder, chay non-root user, EXPOSE 3000, CMD next start. Chi tra Dockerfile.",
    hint: "FROM node:20-alpine AS deps. COPY package*.json. FROM deps AS builder. COPY --from=deps. FROM node:20-alpine AS runner. RUN adduser.",
    keywords: [/AS deps|AS builder|AS runner/, /--from=/, /alpine/, /adduser|addgroup|non-root/, /EXPOSE 3000/],
    testMarker: /FROM\s+node:|FROM\s+\w+\s+AS/,
    badPractices: [/root\s*$|USER root/],
  },
  {
    id: 30, key: 'nginx-rate-limit', category: 'devops', difficulty: 'medium', lang: 'sh',
    prompt: "Viet nginx config cho API server — rate limit 10r/s per IP (burst 20), proxy_pass toi upstream localhost:3000, them headers X-Real-IP + X-Forwarded-For, timeout 30s, gzip response. Chi tra nginx config.",
    hint: "limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s. limit_req zone=api burst=20 nodelay. proxy_set_header.",
    keywords: [/limit_req_zone/, /limit_req\s+zone/, /proxy_pass/, /X-Real-IP|X-Forwarded-For/, /gzip/],
    testMarker: /server\s*\{|location\s*\//,
    badPractices: [/server_tokens\s+on/],
  },
  {
    id: 31, key: 'github-actions-deploy', category: 'devops', difficulty: 'medium', lang: 'yaml',
    prompt: "Viet GitHub Actions workflow deploy Next.js len VPS qua SSH khi push toi main — checkout, build Docker image, push len ghcr.io, SSH vao VPS kua appleboy/ssh-action de docker pull + restart. Dung secrets. Chi tra YAML.",
    hint: "on: push: branches: [main]. jobs: deploy. docker build -t ghcr.io/$GITHUB_REPOSITORY. appleboy/ssh-action@v1.",
    keywords: [/ghcr\.io/, /appleboy\/ssh-action/, /docker\s+(build|pull|restart)/, /secrets\./, /on:\s*push/],
    testMarker: /^on:|^jobs:/m,
    badPractices: [/password:\s*\w+(?!secrets)/],
  },
  {
    id: 32, key: 'docker-compose-healthcheck', category: 'devops', difficulty: 'easy', lang: 'yaml',
    prompt: "Viet docker-compose.yml cho NestJS app + PostgreSQL + Redis — NestJS depends_on postgres + redis voi condition: service_healthy. Postgres healthcheck dung pg_isready. Redis healthcheck dung redis-cli ping. Chi tra YAML.",
    hint: "healthcheck: test: [CMD, pg_isready, -U, postgres]. condition: service_healthy. depends_on: postgres: condition.",
    keywords: [/healthcheck/, /service_healthy/, /pg_isready/, /redis-cli\s+ping/, /depends_on/],
    testMarker: /^services:|^version:/m,
    badPractices: [/password:\s*[a-z]+(?!\$)/],
  },

  // ── python (3) ───────────────────────────────────────────────────
  {
    id: 33, key: 'py-excel-export', category: 'python', difficulty: 'medium', lang: 'py',
    prompt: "Viet Python function `export_to_excel(data: list[dict], filename: str) -> bytes` dung openpyxl — tao workbook voi header tu keys cua dict dau tien, format header bold + background xanh, auto-width column, tra bytes de send qua HTTP. Chi tra code Python.",
    hint: "Workbook(). ws.append(headers). Font(bold=True). PatternFill. column_dimensions[col].width. BytesIO. wb.save(bio).",
    keywords: [/openpyxl/, /Workbook\(\)/, /PatternFill|fill/, /BytesIO/, /bold\s*=\s*True/],
    testMarker: /def\s+export_to_excel|async\s+def\s+export/,
    badPractices: [/print\(/, /except\s*:/],
  },
  {
    id: 34, key: 'py-async-http-batch', category: 'python', difficulty: 'medium', lang: 'py',
    prompt: "Viet Python async function `fetch_all(urls: list[str], concurrency: int = 5) -> list[dict]` dung aiohttp voi asyncio.Semaphore de gioi han concurrent requests. Return list ket qua {url, status, body} theo thu tu. Chi tra code Python.",
    hint: "asyncio.Semaphore(concurrency). async with session.get(url) as resp. asyncio.gather(*tasks). Xu ly exception per-request.",
    keywords: [/aiohttp/, /Semaphore/, /asyncio\.gather/, /async with/, /ClientSession/],
    testMarker: /async\s+def\s+fetch_all/,
    badPractices: [/print\(/, /except\s*:/],
  },
  {
    id: 35, key: 'py-pydantic-settings', category: 'python', difficulty: 'easy', lang: 'py',
    prompt: "Viet Python Pydantic v2 Settings class doc config tu env — DATABASE_URL (str, required), REDIS_URL (str, default redis://localhost:6379), DEBUG (bool, default False), MAX_WORKERS (int, 1-16, default 4). Dung model_config = SettingsConfigDict(env_file='.env'). Chi tra code Python.",
    hint: "from pydantic_settings import BaseSettings, SettingsConfigDict. Field(ge=1, le=16). @validator hoac Field(default=...).",
    keywords: [/BaseSettings/, /SettingsConfigDict|model_config/, /DATABASE_URL|database_url/, /Field\(|field/, /env_file/],
    testMarker: /class\s+\w+Settings?\s*\(/,
    badPractices: [/os\.environ|os\.getenv/],
  },

  // ── debug (3) ────────────────────────────────────────────────────
  {
    id: 36, key: 'debug-stale-closure', category: 'debug', difficulty: 'medium', lang: 'js',
    prompt: `Co bug stale closure trong code sau — fix it:
\`\`\`js
function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setCount(count + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return <div>{count}</div>;
}
\`\`\`
Chi tra code JS da fix, giai thich ngan trong comment.`,
    hint: "setCount(prev => prev + 1) thay vi dung count truc tiep trong closure. Hoac them count vao dep array.",
    keywords: [/setCount\s*\(\s*(prev|c|n)\s*=>|functional update/, /clearInterval/, /useEffect/, /setInterval/],
    testMarker: /function\s+Counter|export\s+(default\s+)?function/,
    badPractices: [/setCount\s*\(\s*count\s*\+\s*1\s*\)/],
  },
  {
    id: 37, key: 'debug-promise-all-fail', category: 'debug', difficulty: 'medium', lang: 'ts',
    prompt: `Fix bug trong code sau — Promise.all fail-fast lam mat ket qua thanh cong, yeu cau lay tat ca ket qua ke ca khi 1 so reject:
\`\`\`ts
const results = await Promise.all(urls.map(url => fetch(url).then(r => r.json())));
\`\`\`
Viet lai dung Promise.allSettled hoac wrapper, tra {url, data?, error?}[]. Chi tra code TS.`,
    hint: "Promise.allSettled. Check status === 'fulfilled' | 'rejected'. Map thanh {url, data, error} uniform shape.",
    keywords: [/allSettled/, /fulfilled|rejected/, /status\s*===/, /error\s*\?|data\s*\?/],
    testMarker: /Promise\.allSettled|export\s+(async\s+)?function/,
    badPractices: [/Promise\.all\s*\(\s*urls\.map/],
  },
  {
    id: 38, key: 'debug-n-plus-1-typeorm', category: 'debug', difficulty: 'hard', lang: 'ts',
    prompt: `Fix N+1 query trong code sau:
\`\`\`ts
const orders = await orderRepo.find();
for (const order of orders) {
  order.items = await itemRepo.find({ where: { orderId: order.id } });
}
\`\`\`
Viet lai 1 query dung TypeORM relations hoac QueryBuilder voi JOIN. Chi tra code TS.`,
    hint: "orderRepo.find({ relations: ['items'] }) hoac createQueryBuilder('o').leftJoinAndSelect('o.items', 'item')",
    keywords: [/relations.*items|leftJoinAndSelect/, /createQueryBuilder|\.find\s*\(/, /leftJoin|JOIN/],
    testMarker: /export\s+(class|async\s+function)|const\s+\w+\s*=/,
    badPractices: [/for.*of.*orders[\s\S]{0,50}find\s*\(\s*\{[\s\S]{0,50}orderId/m],
  },

  // ── refactor (3) ─────────────────────────────────────────────────
  {
    id: 39, key: 'refactor-callback-promise', category: 'refactor', difficulty: 'easy', lang: 'js',
    prompt: `Refactor callback-style sang async/await:
\`\`\`js
function readConfig(callback) {
  fs.readFile('./config.json', 'utf8', (err, data) => {
    if (err) return callback(err);
    try { callback(null, JSON.parse(data)); }
    catch(e) { callback(e); }
  });
}
\`\`\`
Tra async function tra Promise. Chi tra code JS.`,
    hint: "const readConfig = async () => {...}. fs.promises.readFile hoac util.promisify.",
    keywords: [/async\s+function|async\s*\(/, /await\s+fs\.promises|promises\.readFile/, /JSON\.parse/, /try.*catch/],
    testMarker: /async\s+function\s+readConfig|export\s+(async|function)/,
    badPractices: [/callback\s*\(/],
  },
  {
    id: 40, key: 'refactor-split-component', category: 'refactor', difficulty: 'medium', lang: 'ts',
    prompt: `Refactor React component sau thanh 3 component nho:
- ProductCard (thumbnail + name + price)
- ProductActions (add to cart + wishlist buttons)
- ProductBadge (sale/new/out-of-stock badge)

Tach props type cho tung component. Chi tra code TSX.`,
    hint: "Moi component co props interface rieng. ProductCard nhan {id, name, price, thumbnail}. Truyen xuong props can thiet.",
    keywords: [/ProductCard/, /ProductActions/, /ProductBadge/, /interface\s+\w+Props/, /export\s+(default\s+)?function/],
    testMarker: /export\s+(default\s+)?(function|const)\s+Product\w+/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 41, key: 'refactor-god-class', category: 'refactor', difficulty: 'hard', lang: 'ts',
    prompt: `UserService co 200 lines xu ly: auth, profile update, notification, billing. Tach thanh 4 service rieng:
- AuthService: login, logout, changePassword
- ProfileService: getProfile, updateProfile, uploadAvatar
- NotificationService: sendEmail, sendSms, getPreferences
- BillingService: getInvoices, updatePaymentMethod

Viet interface cho tung service va class implement. Chi tra code TS skeleton (khong can body logic, chi method signatures + constructor inject).`,
    hint: "Moi service @Injectable(). UserService inject 4 service kia. Method signatures ro rang.",
    keywords: [/AuthService/, /ProfileService/, /NotificationService/, /BillingService/, /@Injectable\(\)/],
    testMarker: /export\s+(interface|class)\s+(Auth|Profile|Notification|Billing)Service/,
    badPractices: [/:\s*any\b/],
  },

  // ── integration (9) ──────────────────────────────────────────────
  {
    id: 42, key: 'integration-checkout-flow', category: 'integration-checkout', difficulty: 'hard', lang: 'ts',
    prompt: "Viet NestJS CheckoutService.processOrder(userId, cartId) — trong 1 DB transaction: (1) load cart items, (2) kiem tra stock, (3) tao Order + OrderItems, (4) deduct stock, (5) clear cart, (6) emit OrderCreated event. Throw InsufficientStockError neu thieu hang. Chi tra code TS.",
    hint: "dataSource.transaction(manager => ...). EventEmitter2 emit. Repository.decrement cho stock. Throw custom error.",
    keywords: [/transaction\s*\(|\.transaction/, /InsufficientStock|stock/, /EventEmitter2|emit\(/, /Order.*create|createOrder/, /cartId/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+Service/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 43, key: 'integration-notification-batch', category: 'integration-notification', difficulty: 'hard', lang: 'ts',
    prompt: "Viet NestJS job (cron hoac Bull queue) gui batch notification — lay users co is_active=true, chia thanh chunks 100, gui email qua nodemailer parallel (Promise.allSettled), log success/fail count, retry failed sau 5 phut. Chi tra code TS.",
    hint: "@Cron hoac @Process. Chunk array bang slice. Promise.allSettled. BullMQ add delay job cho retry.",
    keywords: [/@Cron|@Process|@BullWorker/, /Promise\.allSettled|allSettled/, /chunk|slice\s*\(\d|batch/, /retry|delay/, /nodemailer|transporter/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+(Job|Service|Processor)/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 44, key: 'integration-presigned-upload', category: 'integration-media', difficulty: 'hard', lang: 'ts',
    prompt: "Viet NestJS endpoint POST /upload/presign — nhan {filename, contentType, fileSize}, validate extension (jpg/png/webp/pdf) va size <= 50MB, tao S3 presigned PUT URL (expire 5 min) bang @aws-sdk/client-s3, save pending upload record vao DB, tra {uploadUrl, fileId}. Chi tra code TS.",
    hint: "PutObjectCommand. getSignedUrl tu @aws-sdk/s3-request-presigner. expiresIn: 300. Validate MIME type.",
    keywords: [/PutObjectCommand/, /getSignedUrl/, /s3-request-presigner/, /presign|presigned/, /expiresIn.*300|300.*expiresIn/],
    testMarker: /@Post\('.*presign'\)|export\s+class\s+\w+(Controller|Service)/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 45, key: 'integration-audit-service', category: 'integration-logging', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS AuditService.log(userId, action, resource, resourceId, meta?) — save vao audit_log table (TypeORM) async fire-and-forget (khong block caller). Viet AuditInterceptor tu dong inject userId va call AuditService sau khi response thanh cong. Chi tra code TS.",
    hint: "AuditService.log return void, dung save().catch(err => logger.error). NestInterceptor.tap() call service.",
    keywords: [/AuditService|audit/, /fire.and.forget|void|\.catch/, /NestInterceptor|intercept/, /tap\(/, /userId.*action|action.*userId/],
    testMarker: /@Injectable\(\)|export\s+class\s+Audit/,
    badPractices: [/:\s*any\b/, /await.*audit.*log/],
  },
  {
    id: 46, key: 'integration-search-filter', category: 'integration-search', difficulty: 'hard', lang: 'ts',
    prompt: "Viet NestJS ProductService.search(query: SearchDto) — fulltext search tren name+description dung TypeORM QueryBuilder ILIKE, filter theo categoryId[] + priceRange + inStock, sort theo field + direction, paginate. Chi tra code TS.",
    hint: "createQueryBuilder. andWhere dieu kien. ILIKE '%:q%'. In(...categoryIds). Between(min, max). orderBy dynamic.",
    keywords: [/createQueryBuilder/, /ILIKE|ilike/, /andWhere\s*\(/, /Between|between/, /orderBy/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+Service/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 47, key: 'integration-email-verify', category: 'integration-auth', difficulty: 'medium', lang: 'ts',
    prompt: "Viet flow xac thuc email — sendVerificationEmail(userId): tao token (crypto.randomBytes 32 hex), save vao user_verifications table voi expiry 24h, gui email chua link. verifyEmail(token): tim token, check expiry, set user.emailVerified=true, xoa token. Chi tra code TS.",
    hint: "crypto.randomBytes(32).toString('hex'). expiresAt = Date.now() + 86400000. Throw TokenExpiredError.",
    keywords: [/randomBytes/, /verif(y|ication|ied)|emailVerified/, /expiresAt|expiry/, /86400000|24.*hour/, /token/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+Service/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 48, key: 'integration-report-csv', category: 'integration-report', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS endpoint GET /reports/orders — query orders theo dateFrom/dateTo, transform thanh CSV (header: orderId, customerName, total, status, createdAt) dung fast-csv hoac manual, stream response voi Content-Disposition attachment. Chi tra code TS.",
    hint: "@Res() res: Response. res.setHeader('Content-Type','text/csv'). res.setHeader('Content-Disposition','attachment; filename=orders.csv'). fast-csv format().pipe(res).",
    keywords: [/Content-Disposition|attachment/, /Content-Type.*csv|text\/csv/, /fast-csv|csv-writer|stringify/, /stream|pipe\s*\(res/, /dateFrom|dateTo/],
    testMarker: /@Get\(.*report|export\s+class\s+\w+(Controller|Service)/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 49, key: 'integration-websocket-room', category: 'integration-realtime', difficulty: 'hard', lang: 'ts',
    prompt: "Viet NestJS WebSocket gateway cho chat room — handleJoinRoom(client, {roomId}): join socket room, emit room:joined voi members. handleMessage(client, {roomId, content}): broadcast toi room, save message vao DB. handleLeaveRoom: cleanup. Chi tra code TS.",
    hint: "@WebSocketGateway(). @SubscribeMessage. server.to(roomId).emit. client.join(roomId). this.server tu @WebSocketServer().",
    keywords: [/@WebSocketGateway/, /@SubscribeMessage/, /\.join\(roomId|\.to\(roomId/, /@WebSocketServer/, /emit\s*\(/],
    testMarker: /@WebSocketGateway\(\)|export\s+class\s+\w+Gateway/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 50, key: 'integration-cache-invalidation', category: 'integration-cache', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS CacheService wrapper quan ly cache pattern cho product — getProduct(id) check Redis truoc, neu miss fetch DB roi cache 10 phut. invalidateProduct(id) xoa cache. invalidateAll() xoa theo pattern product:*. Chi tra code TS.",
    hint: "const key = `product:${id}`. client.get/setEx/del. client.keys('product:*') + client.del(...keys) cho invalidateAll. JSON.stringify/parse.",
    keywords: [/product:\${id}|product:\$\{/, /setEx|set.*EX|expire/, /invalidate/, /keys\s*\(.*product|\*/, /JSON\.parse|JSON\.stringify/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+(Cache|Service)/,
    badPractices: [/:\s*any\b/],
  },
];

module.exports = PROBLEMS_HELD_OUT_50;
