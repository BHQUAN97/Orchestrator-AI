// Generator for FashionEcom distillation pairs — writes JSONL.
// Each pair is a real production pattern extracted from E:\DEVELOP\FashionEcom.
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '.orcai', 'training', 'distill-v2', 'project-01-fashionecom.jsonl');

const pairs = [];

function add(problem_key, category, difficulty, lang, user, assistant) {
  pairs.push({
    messages: [
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ],
    meta: {
      source: 'claude-code-agent-project',
      problem_key,
      project: 'FashionEcom',
      category,
      difficulty,
      lang,
      score: 5,
    },
  });
}

// ========== EASY (15%) ==========
add('fe-slug-vietnamese', 'utility', 'easy', 'ts',
'Viet util `createSlug(text)` cho ten san pham tieng Viet — bo dau, doi d->d, lowercase, thay khoang trang bang gach, bo ky tu dac biet. VD "Ao Polo Nam Cao Cap" -> "ao-polo-nam-cao-cap".',
`// === file: backend/src/common/utils/slug.util.ts ===
/**
 * Tao slug tu tieng Viet — bo dau, lowercase, thay khoang trang bang dau gach
 */
export function createSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\\s-]/g, '')
    .replace(/[\\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}`);

add('fe-bcrypt-password', 'auth', 'easy', 'ts',
'Tao helper hash + compare password dung bcryptjs voi SALT_ROUNDS=12.',
`// === file: backend/src/common/utils/password.util.ts ===
import * as bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}`);

add('fe-mask-account-number', 'security', 'easy', 'ts',
'Che 1 phan so tai khoan ngan hang — chi hien 4 so cuoi. VD "1234567890" -> "******7890". Return null neu input null, giu nguyen neu <= 4 ky tu.',
`// === file: backend/src/modules/payments/payments.service.ts ===
private maskAccountNumber(accountNumber: string | null): string | null {
  if (!accountNumber || accountNumber.length <= 4) return accountNumber;
  const visible = accountNumber.slice(-4);
  const masked = '*'.repeat(accountNumber.length - 4);
  return \`\${masked}\${visible}\`;
}`);

add('fe-safe-sort-whitelist', 'security', 'easy', 'ts',
'Viet helper `safeSortField` chong SQL injection qua orderBy() — whitelist cac column cho phep theo entity (product/order/user), validate regex alphanumeric + camelCase.',
`// === file: backend/src/common/utils/safe-sort.util.ts ===
const SORT_WHITELISTS: Record<string, string[]> = {
  product: ['createdDate', 'catProductName', 'catProductCode', 'catProductStatus', 'modifiedDate'],
  order: ['createdDate', 'salOrderCode', 'salOrderStatus', 'salOrderTotal', 'modifiedDate'],
  user: ['createdDate', 'sysUserEmail', 'sysUserRole', 'sysUserStatus'],
};

export function safeSortField(field: string | undefined, entity: string, defaultField: string): string {
  if (!field) return defaultField;
  const whitelist = SORT_WHITELISTS[entity];
  if (!whitelist) return defaultField;
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(field)) return defaultField;
  return whitelist.includes(field) ? field : defaultField;
}

export function safeSortOrder(order: string | undefined): 'ASC' | 'DESC' {
  if (!order) return 'DESC';
  return order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}`);

add('fe-entity-code-gen', 'utility', 'easy', 'ts',
'Util sinh ma entity theo pattern `PREFIX-YYYYMMDD-XXX` (padding 3 so). Dung chung cho RMA, PO, GRN.',
`// === file: backend/src/common/utils/code-generation.util.ts ===
export async function generateEntityCode(
  prefix: string,
  repo: { count: (options?: any) => Promise<number> },
  padLength = 3,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = await repo.count();
  return \`\${prefix}-\${today}-\${String(count + 1).padStart(padLength, '0')}\`;
}`);

add('fe-jwt-strategy', 'auth', 'easy', 'ts',
'NestJS JwtStrategy — validate payload, verify user ton tai va active (status=1) trong DB.',
`// === file: backend/src/modules/auth/strategies/jwt.strategy.ts ===
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

export interface JwtPayload { sub: string; email: string; role: number; }

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.userRepo.findOne({
      where: { sysUserId: payload.sub, sysUserStatus: 1 },
    });
    if (!user) throw new UnauthorizedException('Tai khoan khong ton tai hoac da bi khoa');
    return { userId: payload.sub, email: payload.email, role: payload.role };
  }
}`);

add('fe-roles-guard', 'auth', 'easy', 'ts',
'RolesGuard cho NestJS — doc @Roles metadata, SUPER_ADMIN luon bypass.',
`// === file: backend/src/common/guards/roles.guard.ts ===
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../constants/roles.constant';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) return true;
    const { user } = context.switchToHttp().getRequest();
    if (user?.role === UserRole.SUPER_ADMIN) return true;
    return requiredRoles.includes(user?.role);
  }
}`);

add('fe-response-interceptor', 'api', 'easy', 'ts',
'Global interceptor wrap response thanh { success, data, message, pagination? }. Neu response da co success thi giu nguyen.',
`// === file: backend/src/common/interceptors/response.interceptor.ts ===
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, map } from 'rxjs';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((responseData) => {
        if (responseData?.success !== undefined) return responseData;
        const { data, pagination, message, ...rest } = responseData || {};
        return {
          success: true,
          data: data ?? responseData,
          message: message || 'OK',
          ...(pagination && { pagination }),
          ...rest,
        };
      }),
    );
  }
}`);

add('fe-calc-effective-price', 'payment', 'easy', 'ts',
'Tinh gia hieu luc cho variant — uu tien sale_price (fixed) > discount % > discount amount > gia goc.',
`// === file: backend/src/common/utils/price-integrity.util.ts ===
export function calcEffectivePrice(
  originalPrice: number,
  salePrice?: number | null,
  discountType?: number | null,
  discountValue?: number | null,
): number {
  if (salePrice != null && salePrice > 0) return Number(salePrice);
  if (discountType === 1 && discountValue && discountValue > 0) {
    return Math.round(originalPrice * (1 - Number(discountValue) / 100));
  }
  if (discountType === 2 && discountValue && discountValue > 0) {
    return Math.max(0, originalPrice - Number(discountValue));
  }
  return originalPrice;
}`);

add('fe-cart-zustand-store', 'frontend-state', 'easy', 'ts',
'Zustand cart store co persist — addItem (cong don qty neu trung variant, cap tai max_qty), updateQty, removeItem, getSubtotal, getCount.',
`// === file: frontend/src/lib/stores/cart.store.ts ===
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CartItem {
  variantId: string;
  productId: string;
  name: string;
  slug: string;
  color: string;
  color_hex: string;
  size: string;
  price: number;
  compare_at_price: number;
  image: string;
  qty: number;
  sku: string;
  max_qty: number;
}

interface CartState {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  updateQty: (variantId: string, qty: number) => void;
  removeItem: (variantId: string) => void;
  clearCart: () => void;
  getSubtotal: () => number;
  getCount: () => number;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      addItem: (item) => set((state) => {
        const existing = state.items.find((i) => i.variantId === item.variantId);
        if (existing) {
          const newQty = Math.min(existing.qty + item.qty, item.max_qty);
          return {
            items: state.items.map((i) =>
              i.variantId === item.variantId ? { ...i, qty: newQty } : i,
            ),
          };
        }
        return { items: [...state.items, item] };
      }),
      updateQty: (variantId, qty) => set((state) => ({
        items: qty <= 0
          ? state.items.filter((i) => i.variantId !== variantId)
          : state.items.map((i) =>
              i.variantId === variantId ? { ...i, qty: Math.min(qty, i.max_qty) } : i,
            ),
      })),
      removeItem: (variantId) => set((state) => ({
        items: state.items.filter((i) => i.variantId !== variantId),
      })),
      clearCart: () => set({ items: [] }),
      getSubtotal: () => get().items.reduce((sum, i) => sum + i.price * i.qty, 0),
      getCount: () => get().items.reduce((sum, i) => sum + i.qty, 0),
    }),
    { name: 'fashionecom-cart' },
  ),
);`);

add('fe-csrf-middleware', 'security', 'easy', 'ts',
'Middleware CSRF protection kieu JWT bearer — yeu cau header X-Requested-With=XMLHttpRequest/fetch cho cac method khac GET/HEAD/OPTIONS.',
`// === file: backend/src/common/middleware/csrf.middleware.ts ===
import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

  use(req: Request, _res: Response, next: NextFunction) {
    if (this.SAFE_METHODS.includes(req.method)) return next();
    const xrw = req.headers['x-requested-with'];
    const ALLOWED = ['XMLHttpRequest', 'fetch'];
    if (!xrw || !ALLOWED.includes(String(xrw))) {
      throw new ForbiddenException('Missing or invalid X-Requested-With header');
    }
    next();
  }
}`);

add('fe-next-middleware-admin', 'frontend-auth', 'easy', 'ts',
'Next.js middleware guard admin routes — redirect ve /admin-login neu thieu cookie, giu lai redirect query.',
`// === file: frontend/src/middleware.ts ===
import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === '/admin-login') return NextResponse.next();

  const token = request.cookies.get('fashionecom-auth-token')?.value;
  const isValidToken = token && token.trim().length >= 10;
  if (pathname.startsWith('/admin') && !isValidToken) {
    const loginUrl = new URL('/admin-login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/admin/:path*', '/admin-login'] };`);

console.error('easy pairs:', pairs.length);
module.exports = { pairs, add };
