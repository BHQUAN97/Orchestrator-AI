// Realistic coding-quality problem set — derived from patterns actually used across
// E:\DEVELOP\* projects (FashionEcom, VietNet2026, LeQuyDon, WebPhoto, WebTemplate,
// RemoteTerminal). Scan cache: .orcai/project-scan-cache.json.
//
// Shape: drop-in replacement for PROBLEMS in test/coding-quality-bench.js.
// Each problem has: { id, key, category, difficulty, lang, prompt, hint,
//   keywords:[RegExp], testMarker:RegExp, badPractices:[RegExp], sourceFile? }
'use strict';

const PROBLEMS_REALISTIC = [
  // ── express / node ───────────────────────────────────────────────
  {
    id: 1, key: 'jwt-verify-middleware', category: 'auth', difficulty: 'easy', lang: 'js',
    prompt: "Viet Express middleware `jwtAuth(req,res,next)` — doc Bearer token tu header Authorization, verify bang jsonwebtoken voi process.env.JWT_SECRET, set req.user = payload. Return 401 JSON `{error}` neu thieu/invalid/expired. Chi tra code JS, export qua module.exports.",
    hint: "Dung jwt.verify(token, secret), catch TokenExpiredError rieng. Header format: 'Bearer <token>'. Kiem tra co authorization header truoc khi split.",
    keywords: [/jsonwebtoken|require\(['"]jsonwebtoken['"]\)/, /Bearer/i, /jwt\.verify|verify\(/, /401/, /req\.user\s*=/],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/console\.log/, /:\s*any\b/],
    sourceFile: 'FashionEcom/backend/src/modules/auth/strategies/jwt.strategy.ts',
  },
  {
    id: 2, key: 'rate-limit-sliding', category: 'express', difficulty: 'medium', lang: 'js',
    prompt: "Viet Express middleware rate-limit sliding window 60s, toi da 30 req/IP, luu trong Map in-memory. Response 429 JSON `{error,retryAfter}` kem header Retry-After. Dung req.ip hoac x-forwarded-for. Chi tra code JS.",
    hint: "Filter timestamps trong window 60000ms bang Date.now(). Set header res.setHeader('Retry-After', seconds). Normalize IPv6 prefix ::ffff:.",
    keywords: [/Map\(/, /Date\.now\(\)/, /429/, /Retry-After|retryAfter/i, /req\.ip|x-forwarded-for/i],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/setInterval.*console/, /console\.log/],
    sourceFile: 'RemoteTerminal/auth.js',
  },
  {
    id: 3, key: 'csrf-header-check', category: 'express', difficulty: 'easy', lang: 'js',
    prompt: "Viet Express middleware CSRF protection — bo qua GET/HEAD/OPTIONS, voi POST/PUT/DELETE/PATCH yeu cau header X-Requested-With phai la 'XMLHttpRequest' hoac 'fetch'. Return 403 neu thieu. Chi tra code JS.",
    hint: "const SAFE=['GET','HEAD','OPTIONS']. Check req.headers['x-requested-with']. Response res.status(403).json({error:'...'}).",
    keywords: [/GET.*HEAD.*OPTIONS|SAFE_METHODS|SAFE/, /x-requested-with/i, /XMLHttpRequest|fetch/, /403/],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/console\.log/],
    sourceFile: 'FashionEcom/backend/src/common/middleware/csrf.middleware.ts',
  },
  {
    id: 4, key: 'error-handler', category: 'express', difficulty: 'easy', lang: 'js',
    prompt: "Viet Express error handler middleware `(err, req, res, next)` — log err.stack, neu err.status/err.statusCode co thi dung, mac dinh 500. Trong production (NODE_ENV) khong tra stack ra client, chi message. Chi tra code JS.",
    hint: "4 tham so la dau hieu error handler. Check process.env.NODE_ENV === 'production'. Response JSON co field error va statusCode.",
    keywords: [/err,\s*req,\s*res,\s*next/, /statusCode|status/, /NODE_ENV|production/, /err\.stack|stack/],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/console\.log\(err\)/],
    sourceFile: 'RemoteTerminal/server.js',
  },

  // ── nestjs (patterns used heavily) ───────────────────────────────
  {
    id: 5, key: 'nest-dto-validate', category: 'validation', difficulty: 'easy', lang: 'ts',
    prompt: "Viet NestJS DTO `CreateProductDto` dung class-validator cho: name (string, 3-200 ky tu), price (number, >0), categoryId (uuid), tags (optional array of string). Chi tra code TS.",
    hint: "Import @IsString, @Length, @IsNumber, @Min, @IsUUID, @IsOptional, @IsArray tu class-validator.",
    keywords: [/@IsString/, /@IsNumber|@Min|@IsPositive/, /@IsUUID/, /@IsOptional/, /class\s+Create\w+Dto/],
    testMarker: /export\s+class\s+\w+Dto/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'FashionEcom/backend/src/modules/products/dto',
  },
  {
    id: 6, key: 'nest-roles-guard', category: 'auth', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS RolesGuard implement CanActivate — doc metadata 'roles' tu Reflector, lay req.user, return true neu user.role nam trong danh sach. Kem decorator `@Roles(...roles)`. Chi tra code TS.",
    hint: "SetMetadata('roles', roles). context.switchToHttp().getRequest(). Reflector.getAllAndOverride<number[]>('roles', [handler, class]).",
    keywords: [/CanActivate/, /Reflector/, /getAllAndOverride|get\(/, /SetMetadata|@Roles/, /switchToHttp/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+Guard/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'FashionEcom/backend/src/common/guards/roles.guard.ts',
  },
  {
    id: 7, key: 'nest-logging-interceptor', category: 'refactor', difficulty: 'medium', lang: 'ts',
    prompt: "Viet NestJS LoggingInterceptor — log method + url + duration (ms) cua moi request, dung RxJS `tap`. Chi tra code TS.",
    hint: "implements NestInterceptor, next.handle().pipe(tap(()=>{const dt=Date.now()-start})). Logger tu @nestjs/common.",
    keywords: [/NestInterceptor/, /intercept\s*\(/, /tap\(|rxjs/, /Date\.now|performance\.now/, /Logger/],
    testMarker: /@Injectable\(\)|export\s+class\s+\w+Interceptor/,
    badPractices: [/:\s*any\b/, /console\.log/],
    sourceFile: 'FashionEcom/backend/src/common/interceptors',
  },

  // ── next.js patterns ─────────────────────────────────────────────
  {
    id: 8, key: 'next-middleware-admin', category: 'nextjs', difficulty: 'easy', lang: 'ts',
    prompt: "Viet Next.js 15 `middleware.ts` — bao ve route /admin/*. Neu khong co cookie 'auth-token' (hoac rong) thi redirect ve /admin-login?redirect=<pathname>. Export config voi matcher. Chi tra code TS.",
    hint: "import { NextRequest, NextResponse } from 'next/server'. request.cookies.get(name)?.value. NextResponse.redirect(new URL(...)). matcher: ['/admin/:path*'].",
    keywords: [/NextRequest|NextResponse/, /cookies\.get/, /redirect/, /matcher/, /\/admin/],
    testMarker: /export\s+(function\s+middleware|const\s+config)/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'FashionEcom/frontend/src/middleware.ts',
  },
  {
    id: 9, key: 'next-server-action-upload', category: 'nextjs', difficulty: 'hard', lang: 'ts',
    prompt: "Viet Next.js 15 Server Action `uploadImage(formData: FormData)` — validate file: chi cho jpg/png/webp, toi da 5MB. Save vao /public/uploads voi ten random, return `{ok:true,url}` hoac `{ok:false,error}`. Chi tra code TS.",
    hint: "'use server' directive. File tu formData.get('file') la instance of File. file.type, file.size. randomUUID tu crypto. fs.writeFile ghi vao path.join(process.cwd(),'public','uploads',name).",
    keywords: [/['"]use server['"]/, /FormData|File/, /image\/(jpeg|jpg|png|webp)/, /5\s*\*\s*1024\s*\*\s*1024|5242880/, /randomUUID|crypto/],
    testMarker: /export\s+async\s+function\s+upload/,
    badPractices: [/:\s*any\b/, /console\.log/],
    sourceFile: 'FashionEcom/frontend/src/app',
  },
  {
    id: 10, key: 'cn-util', category: 'ts-type', difficulty: 'trivial', lang: 'ts',
    prompt: "Viet Tailwind utility `cn(...inputs)` dung clsx va tailwind-merge de merge + dedupe class names. Chi tra code TS 1 file.",
    hint: "import { clsx, type ClassValue } from 'clsx'. import { twMerge } from 'tailwind-merge'. return twMerge(clsx(inputs)).",
    keywords: [/clsx/, /tailwind-merge|twMerge/, /ClassValue/, /export\s+function\s+cn/],
    testMarker: /export\s+function\s+cn|export\s+const\s+cn/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'FashionEcom/frontend/src/lib/utils.ts',
  },
  {
    id: 11, key: 'next-fetch-401-redirect', category: 'nextjs', difficulty: 'medium', lang: 'ts',
    prompt: "Viet `apiFetch<T>(path, options)` trong Next.js client — auto attach Authorization Bearer tu localStorage, neu response 401 thi clear token + redirect `/admin-login?redirect=<current>`. Return `{success,data,message}`. Chi tra code TS.",
    hint: "Check typeof window !== 'undefined'. Dung co bien chong redirect loop. encodeURIComponent pathname. Validate path chi cho start '/admin' tranh open redirect.",
    keywords: [/Authorization|Bearer/, /localStorage|sessionStorage/, /401/, /redirect/, /success|data/],
    testMarker: /export\s+async\s+function\s+\w+|export\s+const\s+\w+\s*=/,
    badPractices: [/:\s*any\b(?!\[\])/, /console\.log/],
    sourceFile: 'FashionEcom/frontend/src/lib/api/client.ts',
  },

  // ── utility / validation ─────────────────────────────────────────
  {
    id: 12, key: 'vn-phone-normalize', category: 'validation', difficulty: 'medium', lang: 'js',
    prompt: "Viet function `normalizeVietnamPhone(input)` — nhan SDT Viet Nam dang: '0912345678', '+84912345678', '84 912 345 678', '0912-345-678'. Validate va return +84xxxxxxxxx (10 so sau +84), hoac null neu invalid. Chi tra code JS + 3 assert example.",
    hint: "Strip khoang trang/dau gach. Loai bo prefix 0 hoac +84/84. Mobile VN bat dau 3/5/7/8/9 sau ma vung, tong 9 so sau +84.",
    keywords: [/\\+84|\+84/, /replace\(/, /\/\^|test\(|match\(/, /return\s+null|return\s+['"]['"]?\s*\?/, /^0|\^0/],
    testMarker: /module\.exports|export\s+(default|const|function)|console\.assert|assert\(/,
    badPractices: [/parseInt.*10.*10/, /eval\(/],
    sourceFile: 'FashionEcom/backend patterns — VN phone validation',
  },
  {
    id: 13, key: 'slug-vi', category: 'validation', difficulty: 'easy', lang: 'ts',
    prompt: "Viet `generateSlug(text)` trong TS — chuyen tieng Viet co dau → khong dau, lowercase, thay ky tu khong phai alpha-num bang dau gach, dedupe gach lien tiep, trim gach dau/cuoi, max 280 ky tu.",
    hint: "normalize('NFD').replace(/[\\u0300-\\u036f]/g,''). Xu ly dac biet chu d/D. Regex /[^a-z0-9\\s-]/g.",
    keywords: [/normalize\(['"]NFD['"]\)/, /\\u0300-\\u036f|u0300/, /toLowerCase/, /replace\(/, /\.slice\(0,\s*280\)/],
    testMarker: /export\s+function\s+generateSlug|export\s+const\s+generateSlug/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'LeQuyDon/frontend/src/lib/slug.ts',
  },
  {
    id: 14, key: 'format-vnd', category: 'node-util', difficulty: 'trivial', lang: 'ts',
    prompt: "Viet `formatVND(amount)` chuyen 1500000 → '1.500.000₫' dung Intl.NumberFormat locale vi-VN currency VND. Chi tra code TS.",
    hint: "new Intl.NumberFormat('vi-VN', { style:'currency', currency:'VND' }).format(amount).",
    keywords: [/Intl\.NumberFormat/, /vi-VN/, /VND/, /currency/],
    testMarker: /export\s+function\s+formatVND|export\s+const\s+formatVND/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'FashionEcom/frontend/src/lib/utils/format.ts',
  },
  {
    id: 15, key: 'password-hash', category: 'auth', difficulty: 'easy', lang: 'js',
    prompt: "Viet 2 function `hashPassword(plain)` va `comparePassword(plain, hash)` dung bcrypt voi cost 12. Chi tra code JS, export qua module.exports.",
    hint: "bcrypt.hash(plain, 12). bcrypt.compare(plain, hash). Dung async/await.",
    keywords: [/bcrypt/, /hash\(/, /compare\(/, /12\b|SALT_ROUNDS/, /async/],
    testMarker: /module\.exports/,
    badPractices: [/md5|sha1\(/i, /console\.log/],
    sourceFile: 'FashionEcom/backend/src/common/utils/password.util.ts',
  },

  // ── db / typeorm ─────────────────────────────────────────────────
  {
    id: 16, key: 'typeorm-entity', category: 'db', difficulty: 'medium', lang: 'ts',
    prompt: "Viet TypeORM entity `ProductEntity` — table 'products', cot: id (uuid, primary, generated), name (varchar 200), slug (varchar 280, unique), price (decimal 10,2), categoryId (uuid, FK), createdAt/updatedAt auto. Chi tra code TS.",
    hint: "@Entity('products'), @PrimaryGeneratedColumn('uuid'), @Column({type:'varchar',length:200}), @Index({unique:true}), @CreateDateColumn(), @UpdateDateColumn().",
    keywords: [/@Entity\(/, /@PrimaryGeneratedColumn|@PrimaryColumn/, /@Column/, /@CreateDateColumn|@UpdateDateColumn/, /uuid/],
    testMarker: /export\s+class\s+\w+Entity/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'FashionEcom/backend/src/modules/products/entities',
  },
  {
    id: 17, key: 'query-builder-search', category: 'db', difficulty: 'hard', lang: 'ts',
    prompt: "Viet NestJS service method `search(filters: {q?,categoryId?,minPrice?,maxPrice?,page=1,limit=20})` dung TypeORM QueryBuilder. Return `{items,total,page,limit,totalPages}`. Order theo createdAt DESC. Chi tra code TS.",
    hint: "this.repo.createQueryBuilder('p'). Dung andWhere co condition check truoc khi apply. skip((page-1)*limit).take(limit). getManyAndCount() return tuple.",
    keywords: [/createQueryBuilder/, /andWhere/, /skip\(|take\(/, /getManyAndCount/, /totalPages|Math\.ceil/],
    testMarker: /async\s+search|async\s+\w+\s*\(/,
    badPractices: [/:\s*any\b/, /SELECT\s+\*/i],
    sourceFile: 'FashionEcom/backend/src/modules/products/products.service.ts',
  },
  {
    id: 18, key: 'redis-cache-wrap', category: 'db', difficulty: 'medium', lang: 'js',
    prompt: "Viet function `withCache(redis, key, ttlSec, fetcher)` — check Redis GET, neu hit tra JSON.parse, neu miss chay fetcher(), SETEX ket qua, return ket qua. Chi tra code JS.",
    hint: "const cached = await redis.get(key). JSON.parse khi parse thanh cong moi dung cache, fallback re-fetch neu parse fail. await redis.setex(key, ttlSec, JSON.stringify(v)).",
    keywords: [/redis\.get|\.get\(/, /setex|SETEX|set\(.*EX/, /JSON\.parse/, /JSON\.stringify/, /async/],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/console\.log/],
    sourceFile: 'VietNet2026/backend redis patterns',
  },

  // ── devops ───────────────────────────────────────────────────────
  {
    id: 19, key: 'dockerfile-node-nest', category: 'devops', difficulty: 'medium', lang: 'dockerfile',
    prompt: "Viet Dockerfile cho NestJS backend Node 20 — multi-stage (builder + production), non-root user, HEALTHCHECK ping http://localhost:4000/api, EXPOSE 4000, CMD node dist/main.js. Chi tra Dockerfile.",
    hint: "FROM node:20-alpine AS builder; npm ci; npm run build; npm prune --production. Stage 2: addgroup/adduser, USER, COPY --from=builder --chown. HEALTHCHECK --interval=30s CMD wget --spider.",
    keywords: [/FROM\s+node:20-alpine\s+AS\s+\w+/i, /WORKDIR/, /HEALTHCHECK/i, /USER\s+\w+/, /EXPOSE\s+4000/],
    testMarker: /CMD\s+\[/,
    badPractices: [/FROM\s+node:latest/, /USER\s+root/, /npm\s+install(?!\s+--)/],
    sourceFile: 'WebTemplate/backend/Dockerfile',
  },
  {
    id: 20, key: 'docker-compose-mysql-redis', category: 'devops', difficulty: 'medium', lang: 'yaml',
    prompt: "Viet docker-compose.yml v2.30+ co: mysql:8.0 (database photo_storage, volume mysql_data, healthcheck mysqladmin ping), redis:7-alpine (volume redis_data, healthcheck redis-cli ping), va app Node 20 port 3000 depends_on db va redis voi condition service_healthy. Chi tra YAML.",
    hint: "healthcheck.test dung array form. volumes: top-level block voi mysql_data: {} redis_data: {}. depends_on: { db: { condition: service_healthy } }.",
    keywords: [/mysql:8\.0/i, /redis:7-alpine/i, /healthcheck\s*:/i, /service_healthy/, /volumes\s*:/],
    testMarker: /services\s*:/,
    badPractices: [/version\s*:\s*['"]?2\.[0-9]['"]?/, /\t/],
    sourceFile: 'WebPhoto/docker-compose.yml',
  },
  {
    id: 21, key: 'pm2-ecosystem', category: 'devops', difficulty: 'medium', lang: 'js',
    prompt: "Viet `ecosystem.config.js` cho PM2 voi 3 app: frontend (next start -p 3000, instances=2, NODE_ENV=production), api (node dist/main.js, port 4000, instances=max, exec_mode cluster), worker (node dist/worker.js, instances=1, cron restart '0 4 * * *'). Chi tra code JS.",
    hint: "module.exports = { apps: [...] }. Moi app: name, script, instances, exec_mode, env: { NODE_ENV, PORT }, cron_restart.",
    keywords: [/module\.exports\s*=\s*\{/, /apps\s*:/, /exec_mode\s*:\s*['"]cluster['"]/, /instances\s*:/, /cron_restart/],
    testMarker: /apps\s*:\s*\[/,
    badPractices: [/console\.log/],
    sourceFile: 'LeQuyDon / VietNet2026 pm2 patterns',
  },
  {
    id: 22, key: 'deploy-sh', category: 'devops', difficulty: 'medium', lang: 'sh',
    prompt: "Viet script `deploy.sh` bash: set -euo pipefail; check docker + docker compose co san; pull git branch main; neu thieu .env thi copy tu config/env roi chmod 600; docker compose pull + up -d --build; chay healthcheck curl -f localhost:4000/api trong vong 60s. Chi tra bash script.",
    hint: "command -v docker. git fetch + reset --hard origin/main. for i in {1..12}; do curl -fsS ... && break; sleep 5; done.",
    keywords: [/set\s+-euo\s+pipefail/, /command\s+-v\s+docker/, /docker\s+compose|docker-compose/, /git\s+(fetch|reset|pull)/, /curl\s+-f/],
    testMarker: /^#!\/bin\/bash|^#!\/usr\/bin\/env\s+bash/m,
    badPractices: [/rm\s+-rf\s+\//, /sudo\s+rm/],
    sourceFile: 'LeQuyDon/scripts/deploy.sh',
  },

  // ── python ───────────────────────────────────────────────────────
  {
    id: 23, key: 'py-rename-images', category: 'python', difficulty: 'easy', lang: 'py',
    prompt: "Viet Python script `rename_images.py` — input dir + glob pattern (vd '*.jpg'), rename anh thanh `{basename}_{index:03d}.{ext}` voi index dem tu 1. Dung pathlib, argparse. Print so file da doi. Chi tra code Python.",
    hint: "from pathlib import Path. argparse.ArgumentParser(). sorted(Path(dir).glob(pattern)). p.rename(p.with_name(new_name)). f'{i:03d}'.",
    keywords: [/pathlib|Path\(/, /argparse/, /glob\(/, /rename\(|with_name/, /\{i:03d\}|\{index:03d\}|:03/],
    testMarker: /if\s+__name__\s*==\s*['"]__main__['"]|def\s+main/,
    badPractices: [/os\.system/, /eval\(/],
    sourceFile: 'utility patterns',
  },
  {
    id: 24, key: 'py-retry-async', category: 'python', difficulty: 'medium', lang: 'py',
    prompt: "Viet Python decorator `@retry(max_attempts=3, backoff=2.0)` cho async function — log moi lan fail, asyncio.sleep(backoff**attempt), raise exception cuoi cung. Chi tra code Python.",
    hint: "import asyncio, functools, logging. @functools.wraps(fn). for attempt in range(max_attempts). await asyncio.sleep(backoff**attempt).",
    keywords: [/async\s+def|asyncio/, /functools\.wraps|@wraps/, /logging|logger|print/, /asyncio\.sleep/],
    testMarker: /def\s+retry|@retry/,
    badPractices: [/time\.sleep/],
    sourceFile: 'utility patterns',
  },
  {
    id: 25, key: 'py-phone-vn', category: 'python', difficulty: 'easy', lang: 'py',
    prompt: "Viet Python `normalize_phone_vn(s: str) -> str | None` — chap nhan '0912345678', '+84912345678', '84 912-345-678', return '+84xxxxxxxxx' hoac None. Chi tra code Python + 3 assert.",
    hint: "re.sub(r'[^0-9+]','',s). Neu bat dau '+84' giu. Bat dau '84' them '+'. Bat dau '0' thay bang '+84'. Validate do dai = 12 va mobile prefix 3/5/7/8/9.",
    keywords: [/import\s+re|re\.sub/, /\\+84|\+84/, /startswith|^84|\^0/, /None/, /def\s+normalize_phone_vn/],
    testMarker: /assert\s+normalize_phone_vn|if\s+__name__/,
    badPractices: [/eval\(/, /exec\(/],
    sourceFile: 'utility patterns',
  },

  // ── debug ────────────────────────────────────────────────────────
  {
    id: 26, key: 'debug-useeffect-loop', category: 'debug', difficulty: 'medium', lang: 'js',
    prompt:
      "React component sau bi infinite re-render. Tim loi va viet ban da sua (giai thich 1 dong roi code):\n" +
      "```jsx\nfunction Products(){\n  const [items,setItems]=useState([]);\n  const filters={category:'all'};\n  useEffect(()=>{\n    fetch('/api/products?cat='+filters.category).then(r=>r.json()).then(setItems);\n  },[filters]);\n  return <ul>{items.map(x=><li key={x.id}>{x.name}</li>)}</ul>;\n}\n```",
    hint: "filters la object literal tao moi moi render → reference khac → useEffect chay lai → setItems → re-render. Fix: useMemo hoac di chuyen ra ngoai hoac dung filters.category truc tiep trong dep array.",
    keywords: [/useMemo|filters\.category/, /\[filters\.category\]|useMemo.*filters/, /infinite|re-?render|reference/i],
    testMarker: /useEffect|useState/,
    badPractices: [/\.\.\.filters\s*\}/],
    sourceFile: 'common React bug',
  },
  {
    id: 27, key: 'debug-async-nest', category: 'debug', difficulty: 'hard', lang: 'ts',
    prompt:
      "NestJS service sau co race condition khi 2 request cung login 1 user. Tim + fix, tra ban sua:\n" +
      "```ts\nasync login(email: string, pw: string){\n  const u = await this.userRepo.findOne({where:{email}});\n  if(!u) throw new UnauthorizedException();\n  u.failedLogins = u.failedLogins + 1;\n  await this.userRepo.save(u);\n  if(u.failedLogins >= 5) u.locked = true;\n  await this.userRepo.save(u);\n  // ... check password, reset counter\n}\n```",
    hint: "Read-modify-write khong atomic. Dung this.userRepo.increment(...) hoac query 'UPDATE users SET failedLogins=failedLogins+1'. Transaction + pessimistic lock neu can consistent.",
    keywords: [/increment\(|UPDATE|\.update\(/, /atomic|race|lock|transaction/i, /QueryRunner|transaction|pessimistic/i],
    testMarker: /async\s+login/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'FashionEcom/backend/src/modules/auth/auth.service.ts',
  },

  // ── refactor ─────────────────────────────────────────────────────
  {
    id: 28, key: 'refactor-controller', category: 'refactor', difficulty: 'medium', lang: 'ts',
    prompt:
      "Refactor NestJS controller nay — tach business logic ra service, giu controller mong. Chi tra code 2 file:\n" +
      "```ts\n@Controller('orders')\nexport class OrdersController {\n  constructor(private repo: Repository<Order>){}\n  @Post()\n  async create(@Body() dto: any){\n    if(!dto.items?.length) throw new BadRequestException('items required');\n    let total = 0;\n    for(const it of dto.items){ total += it.price * it.qty; }\n    const tax = total * 0.1;\n    const order = this.repo.create({ ...dto, total, tax, status:'pending' });\n    return this.repo.save(order);\n  }\n}\n```",
    hint: "Tach OrdersService chua create(dto), tinh total/tax. Controller chi goi service. Tao CreateOrderDto thay cho any.",
    keywords: [/OrdersService/, /@Injectable/, /CreateOrderDto|dto/, /this\.ordersService|this\.service/],
    testMarker: /@Controller|@Injectable/,
    badPractices: [/:\s*any\b/, /@Body\(\)\s+dto:\s*any/],
    sourceFile: 'FashionEcom/backend/src/modules/orders',
  },
  {
    id: 29, key: 'refactor-fetch-hook', category: 'refactor', difficulty: 'medium', lang: 'ts',
    prompt:
      "Refactor component nay — rut fetch logic ra custom hook `useProducts()`. Tra ca 2 file hook + component:\n" +
      "```tsx\nfunction ProductsPage(){\n  const [data,setData]=useState([]);\n  const [loading,setLoading]=useState(true);\n  const [error,setError]=useState<string|null>(null);\n  useEffect(()=>{\n    fetch('/api/products').then(r=>r.json()).then(d=>{setData(d);setLoading(false);}).catch(e=>{setError(e.message);setLoading(false);});\n  },[]);\n  if(loading) return <div>Loading</div>;\n  if(error) return <div>{error}</div>;\n  return <ul>{data.map(p=><li key={p.id}>{p.name}</li>)}</ul>;\n}\n```",
    hint: "Hook return {data,loading,error}. Component chi consume hook. Dung useCallback cho refetch neu can.",
    keywords: [/function\s+useProducts|const\s+useProducts/, /return\s*\{[^}]*data[^}]*loading[^}]*error|return\s*\{[^}]*loading[^}]*data/, /useState/, /useEffect/],
    testMarker: /export\s+(function|const)\s+useProducts/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'LeQuyDon/frontend hooks pattern',
  },

  // ── ts-type ──────────────────────────────────────────────────────
  {
    id: 30, key: 'api-response-type', category: 'ts-type', difficulty: 'easy', lang: 'ts',
    prompt: "Viet generic TS type `ApiResponse<T>` giong backend user: `{success:boolean; data:T; message:string; pagination?:{page:number;limit:number;total:number;totalPages:number}}`. Them type helper `Paginated<T> = ApiResponse<T[]> & { pagination: NonNullable<ApiResponse<T>['pagination']> }`. Chi tra code TS.",
    hint: "interface ApiResponse<T>. type Paginated<T> = ApiResponse<T[]> & { pagination: NonNullable<...> }.",
    keywords: [/ApiResponse<T>|interface\s+ApiResponse/, /pagination/, /totalPages/, /Paginated|NonNullable/],
    testMarker: /type\s+\w+\s*=|interface\s+\w+/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'FashionEcom/frontend/src/lib/api/client.ts',
  },

  // ── extra node-util / ts-type / debug ────────────────────────────
  {
    id: 31, key: 'debounce-leading', category: 'node-util', difficulty: 'medium', lang: 'ts',
    prompt: "Viet `debounce<F extends (...a:any[])=>any>(fn:F, wait:number, opts?:{leading?:boolean}):F` trong TS — clearTimeout moi lan goi, neu leading=true thi goi ngay lan dau roi suppress. Chi tra code TS.",
    hint: "let t:any; let called=false. Neu opts?.leading && !called goi fn. Dung generic <F> va return dung chu ky.",
    keywords: [/setTimeout/, /clearTimeout/, /leading/, /extends\s*\(/, /return.*as\s+F|\)\s*:\s*F\b/],
    testMarker: /export\s+function\s+debounce|export\s+const\s+debounce/,
    badPractices: [/console\.log/],
    sourceFile: 'common utility — useDebouncedValue / debounce',
  },
  {
    id: 32, key: 'deep-partial', category: 'ts-type', difficulty: 'hard', lang: 'ts',
    prompt: "Viet type `DeepPartial<T>` trong TypeScript xu ly: array (giu la array DeepPartial<U>[]), readonly array, Date (giu nguyen, khong recurse), object (recurse), primitive (giu nguyen). Them 2 example usage de kiem chung.",
    hint: "T extends Date ? T : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>> : T extends (infer U)[] ? DeepPartial<U>[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T.",
    keywords: [/infer\s+\w+/, /extends/, /\?\s*:/, /Date/, /ReadonlyArray|readonly/],
    testMarker: /type\s+DeepPartial|type\s+\w+\s*=\s*DeepPartial/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'general TS type lib',
  },
  {
    id: 33, key: 'sleep-util', category: 'node-util', difficulty: 'trivial', lang: 'ts',
    prompt: "Viet `sleep(ms: number): Promise<void>` trong TS dung setTimeout + Promise. Them `sleepWithSignal(ms, signal?: AbortSignal)` huy khi signal.aborted. Chi tra code TS.",
    hint: "new Promise<void>(resolve => setTimeout(resolve, ms)). signal.addEventListener('abort', ()=>{clearTimeout(t); reject(new DOMException('Aborted','AbortError'))}).",
    keywords: [/Promise<void>/, /setTimeout/, /AbortSignal/, /addEventListener\(['"]abort/, /clearTimeout/],
    testMarker: /export\s+(function\s+sleep|const\s+sleep|async\s+function\s+sleep)/,
    badPractices: [/:\s*any\b/],
    sourceFile: 'general utility',
  },
  {
    id: 34, key: 'debug-memory-leak', category: 'debug', difficulty: 'hard', lang: 'js',
    prompt:
      "Express app ro ri bo nho — moi request tang heap. Xac dinh loi va fix, tra ban sua:\n" +
      "```js\nconst cache = {};\napp.get('/api/user/:id', async (req,res)=>{\n  const id = req.params.id;\n  cache[id] = cache[id] || await db.users.findById(id);\n  const onDone = ()=> console.log('done', id);\n  res.on('finish', onDone);\n  setInterval(()=>console.log('still alive', id), 60000);\n  res.json(cache[id]);\n});\n```",
    hint: "3 leaks: (1) cache grows unbounded — dung LRU hoac TTL. (2) setInterval chay mai — phai clearInterval hoac bo han. (3) listener tich luy — dung res.once thay res.on (thuc te finish fire 1 lan nhung van nen once).",
    keywords: [/LRU|Map|size|maxAge|TTL/i, /clearInterval|bo|remove/i, /once\(/, /leak|ro ri|memory/i],
    testMarker: /app\.get|req\.params|res\.json/,
    badPractices: [/setInterval\(/, /cache\[id\]\s*=\s*cache\[id\]\s*\|\|/],
    sourceFile: 'common Express memory-leak pattern',
  },

  // ── integration-flow problems (FashionEcom-sourced, multi-file, playbook-driven) ──
  {
    id: 35, key: 'integration-auth-login-full', category: 'integration-auth', difficulty: 'hard', lang: 'ts',
    prompt:
      "Viet NestJS 11 login flow complete: LoginDto (email+password, class-validator) + AuthController POST /auth/login + AuthService.login(dto). Service phai: (1) tim user, (2) bcrypt.compare password, (3) neu fail → tang user.failedLogins bang repository.increment() (atomic), (4) sign JWT access token (15m) + refresh token (7d) qua JwtService.signAsync, (5) log audit event qua Logger. Chi tra code TS, ban 3 file (dto/controller/service) trong 1 response. Stack: NestJS 11, TypeORM 0.3, bcrypt, @nestjs/jwt.",
    hint: "LoginDto dung @IsEmail/@IsString/@MinLength(8). Controller chi goi service, khong logic. Service: bcrypt.compare(dto.password, user.passwordHash). Dung repo.increment({email}, 'failedLogins', 1). JwtService.signAsync({ sub: user.id }, { expiresIn: '15m' }). Logger.log(`login success: ${user.id}`).",
    keywords: [/bcrypt\.compare/, /JwtService|signAsync/, /@Post\(['"]\/?login/, /class\s+LoginDto|@IsEmail|@IsString/, /increment\(|failedLogins/, /Logger|audit/i],
    testMarker: /@Controller\(['"]\/?auth|class\s+AuthController/,
    badPractices: [/:\s*any\b/, /console\.log/, /md5|sha1/],
    sourceFile: 'FashionEcom/backend/src/modules/auth (login flow)',
  },

  {
    id: 36, key: 'integration-refresh-rotate', category: 'integration-auth', difficulty: 'hard', lang: 'ts',
    prompt:
      "Viet NestJS refresh-token rotation flow: RefreshToken entity (id, userId, familyId, tokenHash, revokedAt, expiresAt) + AuthService.refresh(oldRefreshToken) phai: (1) hash + lookup token, (2) neu khong tim thay HOAC revokedAt != null → revoke CA FAMILY (tat ca token cung familyId) va throw UnauthorizedException (reuse detection), (3) neu OK → revoke token cu + issue new access + new refresh (cung familyId), (4) save. Chi tra code TS (entity + service method). Stack: NestJS 11, TypeORM 0.3, bcrypt for hash, @nestjs/jwt.",
    hint: "Family = chain identifier cho 1 login session. Reuse-detection: stolen refresh replayed => dau vet = (token_id exists nhung revokedAt != null). Khi phat hien: UPDATE RefreshToken SET revokedAt = NOW() WHERE familyId = X. Dung bcrypt.hash(token, 10) de luu tokenHash. Entity: @Entity() class RefreshToken { @PrimaryGeneratedColumn() id; @Column() userId; @Column() familyId; @Column() tokenHash; @Column({nullable:true}) revokedAt; @Column() expiresAt; }.",
    keywords: [/family|familyId/i, /revoke|revokedAt|invalidate/i, /UnauthorizedException|401/, /JwtService|signAsync/, /bcrypt\.(hash|compare)/, /@Entity|@Column/],
    testMarker: /async\s+refresh\s*\(|class\s+RefreshToken\b/,
    badPractices: [/:\s*any\b/, /console\.log/],
    sourceFile: 'FashionEcom/backend/src/modules/auth (refresh rotation)',
  },

  {
    id: 37, key: 'integration-upload-thumbnail', category: 'integration-media', difficulty: 'hard', lang: 'ts',
    prompt:
      "Viet NestJS media upload flow: MediaController POST /media/upload dung FileInterceptor('file') + MediaService.uploadAndThumbnail(file). Service phai: (1) validate size <= 5MB va mimetype start 'image/', neu fail throw BadRequestException, (2) generate 3 thumbnails (300/600/1200 px width, giu aspect ratio) qua sharp(file.buffer).resize({width}).toBuffer(), (3) save original + 3 thumbs vao /storage/YYYY/MM/<uuid>-<size>.webp qua fs.promises.writeFile, (4) return { url, thumbnails: [{size:300,url},{size:600,url},{size:1200,url}] }. Chi tra code 2 file TS (controller + service). Stack: NestJS 11, sharp, uuid.",
    hint: "UseInterceptors(FileInterceptor('file', {limits:{fileSize: 5*1024*1024}})). sharp(buffer).resize({width, withoutEnlargement:true}).webp().toBuffer(). path = path.join('storage', yyyy, mm, `${uuid}-${size}.webp`). Promise.all 3 thumbs song song.",
    keywords: [/FileInterceptor/, /sharp\(|\.resize\(/, /mimetype|startsWith\(['"]image/, /5\s*\*\s*1024|5242880|5\s*MB/i, /Promise\.all/, /BadRequestException/],
    testMarker: /@Post\(['"]\/?upload|UseInterceptors\(FileInterceptor/,
    badPractices: [/:\s*any\b/, /console\.log/],
    sourceFile: 'FashionEcom/backend/src/modules/media (upload + sharp thumbnails)',
  },

  {
    id: 38, key: 'integration-order-create', category: 'integration-orders', difficulty: 'hard', lang: 'ts',
    prompt:
      "Viet NestJS order creation flow: OrdersController POST /orders (CreateOrderDto: items[{productId, qty}], customerId) + OrdersService.create(dto). Service phai: (1) dung QueryRunner transaction, (2) cho moi item: load Product voi setLock('pessimistic_write') va check stock >= qty, neu thieu throw BadRequestException('out of stock: ' + productId), (3) decrement stock, (4) calculate subtotal + tax 10%, (5) save Order + OrderItems cung transaction, (6) commit, (7) emit audit event qua EventEmitter2 'order.created'. Chi tra code controller + service. Stack: NestJS 11, TypeORM 0.3 DataSource, @nestjs/event-emitter.",
    hint: "queryRunner = dataSource.createQueryRunner(); await queryRunner.startTransaction(); try { ... await queryRunner.commitTransaction(); } catch { await queryRunner.rollbackTransaction(); throw; } finally { await queryRunner.release(); }. queryRunner.manager.findOne(Product, {where:{id}, lock:{mode:'pessimistic_write'}}). this.eventEmitter.emit('order.created', { orderId, customerId, total }).",
    keywords: [/QueryRunner|createQueryRunner|startTransaction/, /pessimistic_write|setLock|lock:\s*{/, /BadRequestException|out of stock|insufficient/i, /commitTransaction|rollbackTransaction/, /eventEmitter|EventEmitter2|emit\(['"]order/, /subtotal|tax|0\.1|\*\s*10/],
    testMarker: /@Post\(\)\s*async\s+create|class\s+OrdersController/,
    badPractices: [/:\s*any\b/, /console\.log/],
    sourceFile: 'FashionEcom/backend/src/modules/orders (order creation with stock lock)',
  },

  {
    id: 39, key: 'integration-audit-interceptor', category: 'integration-logging', difficulty: 'medium', lang: 'ts',
    prompt:
      "Viet NestJS AuditInterceptor + redact helper: Interceptor log JSON moi request {method, url, userId, traceId, durationMs, statusCode} qua Logger, lay traceId tu header 'traceparent' (W3C format '00-<trace>-<span>-01', extract 32-char trace id). Redact fields: Authorization header, password/passwordHash/creditCard trong body → '[REDACTED]'. Chi tra code interceptor + redact helper trong 1 file.",
    hint: "implements NestInterceptor. next.handle().pipe(tap(()=>{ const dt = Date.now() - start; this.logger.log(JSON.stringify({...})); })). traceparent format: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'. Redact: recursive replace cac key sensitive in deep clone. JSON.stringify output.",
    keywords: [/NestInterceptor|intercept\(/, /tap\(|rxjs/, /traceparent|correlation/i, /\[REDACTED\]|redact/i, /JSON\.stringify/, /Logger|structured/],
    testMarker: /class\s+AuditInterceptor|implements\s+NestInterceptor/,
    badPractices: [/:\s*any\b/, /console\.log/],
    sourceFile: 'FashionEcom/backend/src/common/interceptors (audit + structured log)',
  },

  {
    id: 40, key: 'integration-dockerfile-full', category: 'integration-devops', difficulty: 'hard', lang: 'sh',
    prompt:
      "Viet Dockerfile production cho NestJS 11 backend (ai-orchestrator/FashionEcom pattern): (1) multi-stage node:20-alpine builder + runtime, (2) builder chay npm ci + npm run build, (3) runtime COPY --from=build /app/dist + prod node_modules, (4) non-root USER node, (5) HEALTHCHECK dung curl --fail http://localhost:4000/health moi 30s, start-period 10s, (6) dung tini hoac exec form CMD [\"node\",\"dist/main\"] de signal forward, (7) EXPOSE 4000. Chi tra Dockerfile noi dung.",
    hint: "FROM node:20-alpine AS build ... RUN npm ci ... RUN npm run build. FROM node:20-alpine AS prod ... RUN apk add --no-cache curl tini. COPY --from=build /app/dist ./dist. USER node. HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD curl --fail http://localhost:4000/health || exit 1. ENTRYPOINT [\"/sbin/tini\",\"--\"]. CMD [\"node\",\"dist/main\"]. EXPOSE 4000.",
    keywords: [/FROM\s+node.*AS\s+build/i, /HEALTHCHECK/i, /USER\s+node|USER\s+nonroot|adduser/i, /--from=build/, /CMD\s*\[/, /EXPOSE\s+4000/],
    testMarker: /FROM\s+node:\d+-alpine/i,
    badPractices: [/USER\s+root/i, /RUN\s+apt-get\s+upgrade/i, /ADD\s+http/i],
    sourceFile: 'FashionEcom/backend/Dockerfile (+ deploy-vps-nginx-pm2 playbook)',
  },
];

function PROBLEM_SET_STATS(set) {
  const arr = set || PROBLEMS_REALISTIC;
  const byCategory = {};
  const byDifficulty = {};
  const byLang = {};
  for (const p of arr) {
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    byDifficulty[p.difficulty] = (byDifficulty[p.difficulty] || 0) + 1;
    byLang[p.lang] = (byLang[p.lang] || 0) + 1;
  }
  return { total: arr.length, byCategory, byDifficulty, byLang };
}

module.exports = { PROBLEMS_REALISTIC, PROBLEM_SET_STATS };
