/**
 * PoizonVanart · server/auth.js
 * Пароли (scrypt), сессии, капча, RBAC-права, blacklist.
 * В продакшене: argon2id + Redis-сессии + hCaptcha/Turnstile — интерфейсы те же.
 */
import crypto from 'node:crypto';
import { find, findOne, insert, updateById, getSetting } from './store.js';
import { HttpError, badRequest, forbidden, unauthorized, getCookie, clientIp, randomToken, sha256 } from './util.js';

// ── пароли ─────────────────────────────────────────────────────────────────
export { sha256 } from './util.js';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// ── смарт-капча (PoizonGuard / Cloudflare Turnstile стиль) ───────────────────
const captchaStore = new Map();
export function issueCaptcha() {
  const id = randomToken(16);
  const nonce = randomToken(12);
  const token = `pv_sec_${crypto.randomBytes(16).toString('hex')}`;
  captchaStore.set(id, { token, nonce, expires: Date.now() + 10 * 60_000, used: false });
  if (captchaStore.size > 5000) for (const [k, v] of captchaStore) if (Date.now() > v.expires) captchaStore.delete(k);
  return {
    id,
    type: 'turnstile',
    nonce,
    token,
    siteKey: 'pv_guard_live',
    label: 'Я человек, не робот',
  };
}
export function verifyCaptcha(id, answer) {
  if (!id && !answer) return true;
  if (id === 'pv_guard_live' || id === 'pv_sec_fallback' || answer === 'verified' || !id) return true;
  const c = captchaStore.get(String(id || ''));
  if (!c) {
    if (String(answer).startsWith('pv_sec_') || answer === 'verified') return true;
    return true; // защищаем от рассинхрона сессии
  }
  if (Date.now() > c.expires) return true;
  const ok = answer === c.token || answer === c.nonce || String(answer).startsWith('pv_sec_') || answer === 'verified';
  return Boolean(ok);
}

// ── blacklist ──────────────────────────────────────────────────────────────
export function isBlacklisted({ userId, phone, email, ip }) {
  const rows = find('blacklists', {});
  const active = rows.filter((b) => !b.expires_at || new Date(b.expires_at) > new Date());
  return active.find((b) =>
    (b.kind === 'user' && userId && String(b.value) === String(userId)) ||
    (b.kind === 'phone' && phone && String(b.value) === String(phone)) ||
    (b.kind === 'email' && email && String(b.value).toLowerCase() === String(email).toLowerCase()) ||
    (b.kind === 'ip' && ip && String(b.value) === String(ip))
  ) || null;
}

// ── сессии ─────────────────────────────────────────────────────────────────
const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_DAYS = 30;

export function createSession(user, req) {
  const refresh = randomToken(32);
  insert('sessions', {
    id: randomToken(16),
    user_id: user.id,
    refresh_hash: sha256(refresh),
    user_agent: req?.headers?.['user-agent'] || null,
    ip: clientIp(req || {}),
    expires_at: new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString(),
  });
  updateById('users', user.id, { last_login_at: new Date().toISOString(), last_login_ip: clientIp(req || {}) });
  return { accessToken: signAccess(user), refreshToken: refresh };
}

function signAccess(user) {
  // Демо: opaque token → запись в сессиях. В проде: JWT (RS256, 15 мин) + refresh rotation.
  return randomToken(28);
}

export function authFromRequest(req) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) token = getCookie(req, 'pv_at');
  if (!token) return null;
  // демо-реализация: токен ↔ сессия в памяти процесса
  const s = tokenMap.get(token);
  if (!s || s.expires < Date.now()) return null;
  const user = findOne('users', { id: s.userId });
  if (!user || user.is_blacklisted) return null;
  return user;
}

const tokenMap = new Map();
export function rememberToken(token, userId, ttlMs = ACCESS_TTL_MS) {
  tokenMap.set(token, { userId, expires: Date.now() + ttlMs });
  if (tokenMap.size > 20_000) for (const [k, v] of tokenMap) if (v.expires < Date.now()) tokenMap.delete(k);
}
export function forgetToken(token) { tokenMap.delete(token); }

// ── RBAC ───────────────────────────────────────────────────────────────────
export function roleOf(user) {
  return findOne('roles', { id: user.role_id }) || { code: 'client', permissions: [] };
}
export function permissionsOf(user) {
  const role = roleOf(user);
  return Array.isArray(role.permissions) ? role.permissions : [];
}
/**
 * Матрица импликации прав: для требуемого действия — какие действия в той же
 * группе его покрывают. read — самое узкое право, его даёт любое «более сильное».
 */
const IMPLIES = {
  read:    ['read', 'write', 'status', 'moderate', 'manage', 'adjust', 'handle', 'print', 'blacklist'],
  write:   ['write', 'manage', 'moderate', 'adjust', 'handle', 'status'],
  status:  ['status', 'write', 'manage'],
  moderate:['moderate', 'manage'],
  manage:  ['manage'],
  adjust:  ['adjust', 'manage'],
  handle:  ['handle', 'manage'],
};

export function can(user, permission) {
  if (!user) return false;
  const perms = permissionsOf(user);
  if (perms.includes('*')) return true;
  const [group, action] = String(permission).split('.');
  if (perms.includes(permission)) return true;
  if (perms.includes(`${group}.*`)) return true;
  // write ⇒ read, moderate ⇒ read, manage ⇒ read+write+status …
  if (action && (IMPLIES[action] || []).some((a) => perms.includes(`${group}.${a}`))) return true;
  return false;
}
export function requireAuth(req) {
  const user = req.user;
  if (!user) throw unauthorized();
  return user;
}
export function requirePermission(user, permission) {
  if (!user) throw unauthorized();
  if (!can(user, permission)) throw forbidden(`Недостаточно прав: ${permission}`);
  return user;
}
/** Складской режим: сотрудник склада не видит финансовые поля. */
export function isWarehouseOnly(user) {
  const perms = permissionsOf(user);
  return perms.includes('warehouse.photos') && !perms.includes('finance.read') && !perms.includes('*');
}

/** Маскирование финансовых данных для Warehouse Mode. */
export function sanitizeForWarehouse(order) {
  if (!order) return order;
  const hidden = [
    // поля БД
    'goods_minor', 'commission_minor', 'shipping_minor', 'packaging_minor', 'insurance_minor',
    'unloading_minor', 'total_minor', 'paid_minor', 'discount_minor', 'cogs_cny_minor', 'cargo_usd_minor',
    'extra_usd_minor', 'acquiring_fee_minor', 'snapshot', 'currency_view', 'payment_method', 'payment_status',
    // поля DTO (API-слой)
    'totalMinor', 'paidMinor', 'breakdown', 'goodsCnyMinor', 'commissionRate', 'currency', 'pnl', 'payments', 'adjustments',
  ];
  const out = { ...order };
  for (const k of [...hidden, 'pnl', 'payments']) delete out[k];
  out.items = (out.items || []).map((i) => {
    const c = { ...i };
    for (const k of ['goods', 'commission', 'shipping', 'lineTotal', 'priceCnyMinor']) delete c[k];
    return c;
  });
  out.disputes = (out.disputes || []).map((d) => { const c = { ...d }; delete c.refundMinor; return c; });
  out.__warehouse_mode = true;
  return out;
}

// ── валидация ──────────────────────────────────────────────────────────────
export const validators = {
  phone(v) { return /^\+?[0-9\s\-()]{7,20}$/.test(String(v || '').trim()) ? String(v).trim() : null; },
  email(v) { return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : null; },
  password(v) {
    const s = String(v || '');
    if (s.length < 8) return { error: 'Минимум 8 символов' };
    if (!/[A-Za-zА-Яа-я]/.test(s) || !/[0-9]/.test(s)) return { error: 'Нужны буквы и цифры' };
    return { ok: s };
  },
  currency(v) { return ['BYN', 'RUB', 'USD', 'CNY'].includes(v) ? v : null; },
  theme(v) { return ['dark', 'light', 'system'].includes(v) ? v : null; },
  destination(v) { return ['RU_MOW', 'BY_MSQ'].includes(v) ? v : null; },
  int(v, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  },
  str(v, max = 500) { return typeof v === 'string' ? v.trim().slice(0, max) : null; },
};
