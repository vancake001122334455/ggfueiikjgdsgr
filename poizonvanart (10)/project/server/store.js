/**
 * PoizonVanart · server/store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Демо-слой хранения: документное хранилище поверх JSON-файла (append-safe).
 *
 * ВАЖНО: это адаптер для запуска прототипа без npm-install. В продакшене
 * заменяется на Prisma + PostgreSQL (схема: db/migrations/001_init.sql).
 * Интерфейс намеренно узкий (find/findOne/insert/update/remove), чтобы
 * портирование свелось к замене одного файла.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildQuote, resolveEffectiveRates } from '../core/pricing.js';
import { convertMinor } from '../core/money.js';
import { tierForLifetimeValue } from '../core/loyalty.js';
import { emptyWallet, postTransaction } from '../core/wallet.js';
import { DEFAULT_TIERS } from '../core/loyalty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = process.env.PV_DATA_FILE || path.join(ROOT, 'data', 'db.json');
const SEED_FILE = path.join(ROOT, 'db', 'seed.data.json');

export const uid = (prefix = '') =>
  prefix + crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').slice(0, 12);

const COLLECTIONS = [
  'roles', 'users', 'user_settings', 'user_addresses', 'sessions', 'blacklists',
  'settings', 'rate_history', 'categories', 'brands', 'products', 'product_variants',
  'size_guides', 'wishlists', 'carts', 'cart_items', 'orders', 'order_items',
  'order_status_history', 'order_photos', 'order_adjustments', 'shipments', 'labels',
  'payments', 'wallets', 'wallet_transactions', 'referrals', 'tiktok_submissions',
  'disputes', 'chat_threads', 'chat_messages', 'notifications', 'tasks',
  'audit_log', 'promo_codes', 'reviews', 'opex_entries', 'meta',
];

let db = null;
let saveTimer = null;

export function getDb() {
  if (!db) db = load();
  return db;
}

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && raw.__schema === SCHEMA_VERSION) return raw;
      console.warn('[store] schema mismatch → reseed');
    } catch (e) {
      console.warn('[store] corrupt data file → reseed', e.message);
    }
  }
  const fresh = seed();
  persistNow(fresh);
  return fresh;
}

const SCHEMA_VERSION = '1.0.0';

export function persistNow(target = db) {
  if (!target) return;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(target, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistNow(), 120);
}

export function resetDb() {
  db = seed();
  persistNow(db);
  return db;
}

// ── helpers ────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();

function matches(doc, where) {
  return Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(doc[k]);
    if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne;
    return doc[k] === v;
  });
}

export function find(coll, where = {}, { sort, limit, offset } = {}) {
  let rows = (getDb()[coll] || []).filter((d) => matches(d, where));
  if (sort) {
    const [key, dir] = Array.isArray(sort) ? sort : [sort, 'asc'];
    rows = rows.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av === bv) return 0;
      const cmp = av > bv ? 1 : -1;
      return dir === 'desc' ? -cmp : cmp;
    });
  }
  if (offset) rows = rows.slice(offset);
  if (limit) rows = rows.slice(0, limit);
  return rows;
}

export function findOne(coll, where = {}) {
  return (getDb()[coll] || []).find((d) => matches(d, where)) || null;
}

export function insert(coll, doc) {
  const d = getDb();
  d[coll] = d[coll] || [];
  const row = { id: doc.id ?? uid(), created_at: doc.created_at ?? nowIso(), ...doc };
  row.id = row.id;
  d[coll].push(row);
  persist();
  return row;
}

export function insertMany(coll, docs) {
  return docs.map((doc) => insert(coll, doc));
}

export function update(coll, where, patch) {
  const rows = find(coll, where);
  for (const r of rows) Object.assign(r, patch, { updated_at: nowIso() });
  if (rows.length) persist();
  return rows;
}

export function updateById(coll, id, patch) {
  const row = findOne(coll, { id });
  if (!row) return null;
  Object.assign(row, patch, { updated_at: nowIso() });
  persist();
  return row;
}

export function remove(coll, where) {
  const d = getDb();
  const before = (d[coll] || []).length;
  d[coll] = (d[coll] || []).filter((x) => !matches(x, where));
  persist();
  return before - d[coll].length;
}

export function nextNumber(coll, field, prefix, pad = 6) {
  const rows = find(coll, {});
  const max = rows.reduce((m, r) => {
    const tail = String(r[field] || '').match(/(\d+)$/);
    const n = tail ? parseInt(tail[1], 10) : NaN;
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `${prefix}${String(max + 1).padStart(pad, '0')}`;
}

// ── settings / rates ───────────────────────────────────────────────────────
export function getSetting(key, fallback = null) {
  const row = findOne('settings', { key });
  return row ? row.value : fallback;
}
export function setSetting(key, value, actorId = null, description) {
  const row = findOne('settings', { key });
  if (row) {
    row.value = value;
    row.updated_at = nowIso();
    row.updated_by = actorId;
    if (description) row.description = description;
  } else {
    insert('settings', { key, value, description: description || null, is_public: false, updated_by: actorId });
  }
  persist();
  return getSetting(key);
}

/** Публичный конфиг для клиента (курсы, тарифы, упаковка, страховка, лояльность…). */
export function publicConfig() {
  const pub = find('settings', { is_public: true });
  const cfg = {};
  for (const s of pub) cfg[s.key] = s.value;
  return cfg;
}

/** Конфиг для движка расчёта цен. */
export function pricingConfig() {
  return {
    rates: getSetting('rates.currency_rates', {}),
    tariffs: getSetting('logistics.tariffs', {}),
    packaging: getSetting('logistics.packaging', { basic: 3 }),
    unloadingUsd: getSetting('logistics.unloading_usd', 3),
    unloadingVolumeMaxM3: getSetting('logistics.unloading_volume_max_m3', 0.4),
    volumetricDivisor: getSetting('logistics.volumetric_divisor', 5000),
    minBillableKg: getSetting('logistics.min_billable_kg', 0.5),
    insuranceTiers: getSetting('insurance.tiers', null),
    loyaltyTiers: getSetting('loyalty.tiers', DEFAULT_TIERS),
    commissionBaseRate: getSetting('commission.base_rate', 0.1),
    defaultWeightsKg: getSetting('catalog.default_weights_kg', {}),
  };
}

export function effectiveRates() {
  return resolveEffectiveRates(getSetting('rates.currency_rates', {}));
}

export function quote(input) {
  return buildQuote({ ...input, config: pricingConfig() });
}

// ── wallet ─────────────────────────────────────────────────────────────────
export function walletOf(userId) {
  let w = findOne('wallets', { user_id: userId });
  if (!w) {
    const u = findOne('users', { id: userId });
    w = insert('wallets', emptyWallet(userId, 'RUB', {
      main: u?.balance_main_minor || 0,
      bonus: u?.balance_bonus_minor || 0,
    }));
  }
  return w;
}

/** Провести транзакцию кошелька и синхронизировать денормализованный баланс на users. */
export function postWalletTx(userId, tx) {
  const w = walletOf(userId);
  const res = postTransaction(w, tx);
  updateById('wallets', w.id, {
    balance_main_minor: res.wallet.balance_main_minor,
    balance_bonus_minor: res.wallet.balance_bonus_minor,
  });
  const u = findOne('users', { id: userId });
  if (u) {
    u.balance_main_minor = res.wallet.balance_main_minor;
    u.balance_bonus_minor = res.wallet.balance_bonus_minor;
  }
  res.tx.id = res.tx.id ?? uid();
  insert('wallet_transactions', res.tx);
  persist();
  return res;
}

// ── audit & notifications ──────────────────────────────────────────────────
export function audit(actorId, action, entity, entityId, before, after, meta = {}) {
  return insert('audit_log', {
    actor_id: actorId ?? null, action, entity, entity_id: entityId ?? null,
    before: before ?? null, after: after ?? null, ip: meta.ip || null, user_agent: meta.ua || null,
  });
}

export function notify(userId, event, { title, body, channel = 'inapp', payload = {} } = {}) {
  return insert('notifications', { user_id: userId, channel, event, title, body, payload, status: 'sent', sent_at: nowIso() });
}

// ── SEED ───────────────────────────────────────────────────────────────────
// Демо-данные строятся так, чтобы кошелёк, леджер и заказы были согласованы:
// все движения денег проходят через один механизм (postTransaction),
// поэтому reconcile() всегда возвращает ok: true.
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export { hashPassword };

function seed() {
  const S = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const d = { __schema: SCHEMA_VERSION, seeded_at: nowIso() };
  for (const c of COLLECTIONS) d[c] = [];

  // ── roles ──────────────────────────────────────────────────────────────
  const roleByCode = {};
  for (const r of S.roles) {
    const row = { id: d.roles.length + 1, code: r.code, name: r.name, description: r.description || null, permissions: r.permissions, is_system: !!r.is_system, created_at: nowIso() };
    d.roles.push(row);
    roleByCode[r.code] = row;
  }

  // ── settings ───────────────────────────────────────────────────────────
  for (const [key, s] of Object.entries(S.settings)) {
    d.settings.push({ id: uid('st_'), key, value: s.value, description: s.description || null, is_public: !!s.is_public, updated_by: null, updated_at: nowIso() });
  }
  const cfg = {
    rates: S.settings['rates.currency_rates'].value,
    tariffs: S.settings['logistics.tariffs'].value,
    packaging: S.settings['logistics.packaging'].value,
    unloadingUsd: S.settings['logistics.unloading_usd'].value,
    unloadingVolumeMaxM3: S.settings['logistics.unloading_volume_max_m3'].value,
    volumetricDivisor: S.settings['logistics.volumetric_divisor'].value,
    minBillableKg: S.settings['logistics.min_billable_kg'].value,
    insuranceTiers: S.settings['insurance.tiers'].value,
    loyaltyTiers: S.settings['loyalty.tiers'].value,
    commissionBaseRate: S.settings['commission.base_rate'].value,
    defaultWeightsKg: S.settings['catalog.default_weights_kg'].value,
  };
  const ratesEff = resolveEffectiveRates(cfg.rates);

  // ── categories / brands ────────────────────────────────────────────────
  const catBySlug = {}, brandBySlug = {};
  S.categories.forEach((c, i) => {
    const row = { id: i + 1, slug: c.slug, name: c.name, parent_id: null, avg_weight_kg: c.avg_weight_kg, sort_order: c.sort_order, is_active: true };
    d.categories.push(row); catBySlug[c.slug] = row;
  });
  S.brands.forEach((b, i) => {
    const row = { id: i + 1, slug: b.slug, name: b.name, logo_url: null, size_bias: b.size_bias ?? 0 };
    d.brands.push(row); brandBySlug[b.slug] = row;
  });

  // ── products + variants ────────────────────────────────────────────────
  for (const p of S.products) {
    const brand = brandBySlug[p.brand] || null;
    const cat = catBySlug[p.category] || null;
    const minPrice = Math.min(...p.variants.map((v) => v.price_cny_minor));
    const product = {
      id: uid('pr_'), sku: p.sku, brand_id: brand?.id ?? null, category_id: cat?.id ?? null,
      brand_slug: p.brand, category_slug: p.category, brand_name: brand?.name || null, category_name: cat?.name || null,
      name: p.name, name_cn: p.name_cn || null, slug: p.slug, description: p.description || null,
      images: p.images || [], external_source: p.external_source || 'poizon', external_id: p.external_id || null,
      external_url: p.external_url || null, weight_est_kg: p.weight_est_kg ?? null,
      price_cny_minor: minPrice, is_active: true, is_featured: !!p.is_featured, created_at: nowIso(), updated_at: nowIso(),
    };
    d.products.push(product);
    p.variants.forEach((v, i) => {
      d.product_variants.push({
        id: uid('pv_'), product_id: product.id, seq: i, color: v.color, size_eur: v.size_eur || null,
        size_us: v.size_us || null, size_cn: v.size_cn || null, price_cny_minor: v.price_cny_minor,
        weight_kg: v.weight_kg ?? product.weight_est_kg, stock_status: v.stock_status || 'in_stock',
        sku: `${product.sku}-${(v.color || 'ONE').slice(0, 3).toUpperCase()}-${v.size_eur || 'OS'}`,
        images: [], created_at: nowIso(),
      });
    });
  }

  // ── size guides ────────────────────────────────────────────────────────
  for (const g of S.size_guides) {
    d.size_guides.push({ id: uid('sg_'), brand_slug: g.brand || null, category_slug: g.category || null, kind: g.kind, rows: g.rows, notes: g.notes || null, is_active: true });
  }

  // ── users (балансы = 0, будут начислены через леджер) ──────────────────
  const userByUid = {};
  for (const u of S.users) {
    const role = roleByCode[u.role] || roleByCode.client;
    const row = {
      id: uid('u_'), public_uid: u.public_uid, role_id: role.id, role_code: role.code,
      phone: u.phone || null, email: u.email || null, telegram_username: u.telegram_username || null,
      telegram_chat_id: u.telegram_chat_id || null, password_hash: hashPassword(u.password),
      first_name: u.first_name || null, last_name: u.last_name || null,
      referral_code: u.referral_code, referred_by_id: null,
      loyalty_tier: u.loyalty_tier || 'BASE', lifetime_value_minor: 0,
      balance_main_minor: 0, balance_bonus_minor: 0,
      is_blacklisted: false, is_verified: true, last_login_at: null, created_at: nowIso(), updated_at: nowIso(),
    };
    d.users.push(row);
    d.user_settings.push({
      id: uid('us_'), user_id: row.id, theme: u.settings?.theme || 'dark', currency: u.settings?.currency || 'RUB',
      language: 'ru', notify_telegram: true, notify_email: true, notify_price_drop: true, notify_status: true,
      default_destination: u.settings?.default_destination || 'RU_MOW',
      default_packaging: 'basic', default_insurance: 'none', updated_at: nowIso(),
    });
    d.wallets.push({ id: uid('w_'), user_id: row.id, currency: 'RUB', balance_main_minor: 0, balance_bonus_minor: 0, frozen_minor: 0, updated_at: nowIso() });
    if (u.address) d.user_addresses.push({ id: uid('ad_'), user_id: row.id, is_default: true, created_at: nowIso(), ...u.address });
    userByUid[u.public_uid] = row;
  }

  // ── реферальные привязки ───────────────────────────────────────────────
  for (const u of S.users) {
    if (!u.referred_by_code) continue;
    const invitee = userByUid[u.public_uid];
    const referrer = Object.values(userByUid).find((x) => x.referral_code === u.referred_by_code);
    if (!invitee || !referrer) continue;
    invitee.referred_by_id = referrer.id;
    d.referrals.push({
      id: uid('rf_'), referrer_id: referrer.id, referee_id: invitee.id, code_used: referrer.referral_code,
      status: 'registered', first_order_id: null, reward_minor: 0, invitee_bonus_minor: 0,
      rewarded_at: null, created_at: nowIso(),
    });
  }

  // локальные хелперы seed-контекста (без обращения к глобальному db)
  const walletOfUser = (userId) => d.wallets.find((w) => w.user_id === userId);
  function post(userId, tx) {
    const w = walletOfUser(userId);
    const key = tx.wallet_type === 'bonus' ? 'balance_bonus_minor' : 'balance_main_minor';
    const before = Number(w[key] || 0);
    const amount = Math.round(Number(tx.amount_minor));
    const after = before + amount;
    if (after < 0) throw new Error(`seed: insufficient ${tx.wallet_type} balance for ${userId} (${before} + ${amount})`);
    w[key] = after;
    w.updated_at = tx.created_at || nowIso();
    const u = d.users.find((x) => x.id === userId);
    if (u) u[key === 'balance_bonus_minor' ? 'balance_bonus_minor' : 'balance_main_minor'] = after;
    const rec = {
      id: uid('tx_'), user_id: userId, wallet_type: tx.wallet_type === 'bonus' ? 'bonus' : 'main',
      type: tx.type, amount_minor: amount, currency: tx.currency || 'RUB',
      balance_before: before, balance_after: after, ref_type: tx.ref_type || null, ref_id: tx.ref_id ?? null,
      idempotency_key: tx.idempotency_key || null, comment: tx.comment || null,
      created_by: tx.created_by ?? null, created_at: tx.created_at || nowIso(),
    };
    d.wallet_transactions.push(rec);
    return rec;
  }
  const convertToUserCur = (rubMinor, user) => {
    const cur = d.user_settings.find((s) => s.user_id === user.id)?.currency || 'RUB';
    return { cur, minor: convertMinor(rubMinor, 'RUB', cur, ratesEff) };
  };

  // ── стартовые зачисления из сида ───────────────────────────────────────
  for (const t of S.wallet_transactions_seed || []) {
    const u = userByUid[t.user]; if (!u) continue;
    post(u.id, {
      wallet_type: t.wallet_type, type: t.type, amount_minor: t.amount_minor, currency: t.currency || 'RUB',
      comment: t.comment, created_at: t.created_at,
    });
  }

  // ── заказы ─────────────────────────────────────────────────────────────
  const PAID_CHAIN = ['paid', 'purchasing', 'purchased', 'photo_report', 'legit_check_failed', 'packed', 'sent_to_ru', 'in_transit', 'customs', 'arrived_msk', 'arrived_minsk', 'ready_for_pickup', 'delivered'];

  for (const o of S.orders) {
    const user = userByUid[o.user]; if (!user) continue;
    const settings = d.user_settings.find((s) => s.user_id === user.id);
    const items = (o.items || []).map((it) => {
      const product = d.products.find((p) => p.sku === it.sku);
      const variants = d.product_variants.filter((v) => v.product_id === product?.id);
      const variant = variants[it.variant ?? 0] || variants[0];
      return {
        source: 'catalog', product_id: product?.id, variant_id: variant?.id,
        title: product?.name || 'Товар', brand: product?.brand_name, color: variant?.color,
        size: variant?.size_eur, image_url: product?.images?.[0] || null, external_url: product?.external_url || null,
        price_cny_minor: variant?.price_cny_minor || 0, qty: it.qty || 1,
        weight_kg: variant?.weight_kg || product?.weight_est_kg || 1,
        dims_cm: product?.category_slug === 'sneakers' ? { l: 34, w: 22, h: 13 } : { l: 30, w: 24, h: 6 },
        category_slug: product?.category_slug,
      };
    });

    const quote = buildQuote({
      items, destination: o.destination, packaging: o.packaging || 'basic', insured: !!o.insured,
      packEachSeparately: false, currency: o.currency || settings.currency || 'RUB',
      tier: user.loyalty_tier, config: cfg,
    });

    const isPaid = o.status !== 'awaiting_payment' && o.status !== 'draft' && o.status !== 'cancelled';
    const order = {
      id: uid('o_'), order_no: o.order_no, user_id: user.id, cart_id: null,
      status: o.status, destination: o.destination,
      recipient_name: `${user.first_name || ''} ${user.last_name || ''}`.trim(), recipient_phone: user.phone,
      recipient_address: d.user_addresses.find((a) => a.user_id === user.id)?.address_line || null,
      snapshot: {
        rates: cfg.rates, tariff_usd_per_kg: quote.tariffUsdPerKg, commission_rate: quote.commissionRate,
        packaging: quote.packaging, insurance: quote.insurance, weight: quote.weight, tiers: cfg.loyaltyTiers,
      },
      currency_view: quote.currency,
      goods_minor: quote.breakdown.goods, commission_minor: quote.breakdown.commission,
      shipping_minor: quote.breakdown.shipping, packaging_minor: quote.breakdown.packaging,
      insurance_minor: quote.breakdown.insurance, unloading_minor: quote.breakdown.unloading,
      discount_minor: 0, total_minor: quote.breakdown.total,
      paid_minor: isPaid ? quote.breakdown.total : 0,
      goods_cny_minor: quote.goodsCnyMinor,
      cogs_cny_minor: isPaid ? Math.round(quote.goodsCnyMinor * 0.985) : 0,
      cargo_usd_minor: isPaid ? Math.round(quote.weight.billableKg * quote.tariffUsdPerKg * 100 * 0.92) : 0,
      extra_usd_minor: isPaid ? quote.sourceMinor.packagingUsd + quote.sourceMinor.insuranceUsd + quote.sourceMinor.unloadingUsd : 0,
      acquiring_fee_minor: 0,
      weight_est_kg: quote.weight.estKg, weight_fact_kg: o.weight_fact_kg ?? null,
      volume_m3: quote.weight.volumeM3, places_count: quote.packaging.places,
      payment_status: isPaid ? 'succeeded' : 'pending', payment_method: o.payment_method || 'card',
      loyalty_tier_at_order: user.loyalty_tier, commission_rate_at_order: quote.commissionRate,
      referral_code_used: null, promo_code: null,
      tracking_number: o.tracking_number || null, carrier: o.carrier || null,
      manager_id: null, warehouse_id: userByUid['PV-000002']?.id || null,
      paid_at: o.paid_at || null, purchased_at: o.purchased_at || null, sent_at: o.sent_at || null,
      delivered_at: o.delivered_at || null, cancelled_at: null, eta_from: null, eta_to: null,
      comment: null, created_at: o.created_at || o.paid_at || nowIso(), updated_at: nowIso(),
    };

    // оплата: списываем с кошелька или фиксируем эквайринг
    if (isPaid) {
      const method = order.payment_method;
      const paidAt = order.paid_at || order.created_at;
      if (method === 'wallet' || method === 'bonus' || method === 'combined') {
        let need = order.total_minor;
        const w = walletOfUser(user.id);
        const fromBonus = Math.min(w.balance_bonus_minor, need);
        if (fromBonus > 0) { post(user.id, { wallet_type: 'bonus', type: 'order_payment_bonus', amount_minor: -fromBonus, ref_type: 'order', ref_id: order.id, comment: `Оплата заказа ${order.order_no} (бонусы)`, created_at: paidAt }); need -= fromBonus; }
        const fromMain = method === 'bonus' ? 0 : Math.min(walletOfUser(user.id).balance_main_minor, need);
        if (fromMain > 0) { post(user.id, { wallet_type: 'main', type: 'order_payment', amount_minor: -fromMain, ref_type: 'order', ref_id: order.id, comment: `Оплата заказа ${order.order_no} (баланс)`, created_at: paidAt }); need -= fromMain; }
        if (need > 0) {
          order.acquiring_fee_minor = Math.round(need * 0.023);
          d.payments.push({ id: uid('pay_'), order_id: order.id, user_id: user.id, provider: 'yookassa', provider_tx_id: uid('acq').toUpperCase(), method: 'card', amount_minor: need, currency: order.currency_view, status: 'succeeded', fee_minor: order.acquiring_fee_minor, idempotency_key: `${order.id}:card`, payload: {}, paid_at: paidAt, created_at: paidAt, updated_at: paidAt });
        }
        if (fromBonus + fromMain > 0) {
          d.payments.push({ id: uid('pay_'), order_id: order.id, user_id: user.id, provider: 'wallet', provider_tx_id: null, method: fromBonus && need === 0 && !fromMain ? 'bonus' : 'wallet', amount_minor: fromBonus + fromMain, currency: order.currency_view, status: 'succeeded', fee_minor: 0, idempotency_key: `${order.id}:wallet`, payload: {}, paid_at: paidAt, created_at: paidAt, updated_at: paidAt });
        }
      } else {
        order.acquiring_fee_minor = Math.round(order.total_minor * 0.023);
        d.payments.push({ id: uid('pay_'), order_id: order.id, user_id: user.id, provider: method === 'sbp' ? 'yookassa_sbp' : 'yookassa', provider_tx_id: uid('acq').toUpperCase(), method, amount_minor: order.total_minor, currency: order.currency_view, status: 'succeeded', fee_minor: order.acquiring_fee_minor, idempotency_key: `${order.id}:${method}`, payload: {}, paid_at: paidAt, created_at: paidAt, updated_at: paidAt });
      }
      // лояльность: накопление оплаченной суммы (в RUB-эквиваленте)
      const rubMinor = convertMinor(order.total_minor, order.currency_view, 'RUB', ratesEff);
      user.lifetime_value_minor += rubMinor;
    }

    d.orders.push(order);

    items.forEach((it, idx) => {
      const line = quote.lines[idx] || {};
      d.order_items.push({
        id: uid('oi_'), order_id: order.id, cart_item_id: null, variant_id: it.variant_id, product_id: it.product_id,
        title: it.title, brand: it.brand, color: it.color, size: it.size, image_url: it.image_url, external_url: it.external_url,
        price_cny_minor: it.price_cny_minor, qty: it.qty, weight_kg: it.weight_kg, weight_fact_kg: null,
        line_goods_minor: line.goods || 0, line_commission_minor: line.commission || 0,
        line_shipping_minor: line.shipping || 0, line_total_all_minor: line.lineTotal || 0,
        status: order.status, legit_check: order.status === 'legit_check_failed' ? 'fail' : null, notes: null, created_at: order.created_at,
      });
    });

    // история статусов
    d.order_status_history.push({ id: uid('h_'), order_id: order.id, from_status: null, to_status: 'awaiting_payment', changed_by: null, comment: 'Заказ создан', created_at: order.created_at });
    const idx = PAID_CHAIN.indexOf(order.status);
    if (idx >= 0) {
      for (let i = 0; i <= idx; i++) {
        d.order_status_history.push({
          id: uid('h_'), order_id: order.id, from_status: i === 0 ? 'awaiting_payment' : PAID_CHAIN[i - 1],
          to_status: PAID_CHAIN[i], changed_by: null, comment: i === 0 ? `Оплата: ${order.payment_method}` : null,
          created_at: order.paid_at || order.created_at,
        });
      }
    }
    if (order.tracking_number) {
      d.shipments.push({ id: uid('sh_'), order_id: order.id, tracking_number: order.tracking_number, carrier: order.carrier || 'VanCargo', destination: order.destination, weight_kg: order.weight_fact_kg || order.weight_est_kg, places_count: order.places_count, status: order.status, shipped_at: order.sent_at || null, delivered_at: order.delivered_at || null, tracking_events: [] });
    }
    const defaultPhotos = [
      { kind: 'tag', caption: 'Бирюзовая пломба Poizon Legit Check с уникальным номером' },
      { kind: 'cert', caption: 'Оригинальный сертификат подлинности Dewu с защитным QR' },
      { kind: 'box', caption: 'Фирменная коробка Poizon, углы и пломбировочный скотч целы' },
      { kind: 'weight', caption: `Контрольное взвешивание на калиброванных весах склада: ${order.weight_fact_kg || order.weight_est_kg || 1.45} кг` },
    ];
    const photoList = o.photos && o.photos.length ? o.photos : defaultPhotos;
    if (['photo_report', 'packed', 'sent_to_ru', 'customs', 'in_transit', 'delivered'].includes(order.status)) {
      for (let i = 0; i < photoList.length; i++) {
        const ph = photoList[i];
        d.order_photos.push({
          id: uid('ph_'), order_id: order.id, order_item_id: null,
          url: `/img/report/${order.order_no}-${ph.kind}-${i + 1}.svg?label=${encodeURIComponent(ph.caption)}`,
          thumb_url: null, kind: ph.kind || 'report', caption: ph.caption || null,
          uploaded_by: userByUid['PV-000002']?.id || null, is_visible_to_client: true, created_at: order.paid_at || nowIso(),
        });
      }
    }
  }

  // ── TikTok-заявки + начисления ─────────────────────────────────────────
  for (const t of S.tiktok_submissions || []) {
    const user = userByUid[t.user]; if (!user) continue;
    const m = t.url.match(/@([\w.\-]+)\/video\/(\d+)/);
    const views = t.views_verified ?? null;
    const per1000 = S.settings['tiktok.config'].value.reward_per_1000_views_rub_minor;
    const rewardRub = t.status === 'approved' && views ? Math.floor(views / 1000) * per1000 : 0;
    const sub = {
      id: uid('tt_'), user_id: user.id, url: t.url, video_id: m?.[2] || uid(), author_handle: m ? `@${m[1]}` : null,
      hashtag_found: !!t.hashtag_found, link_found: !!t.link_found,
      views_declared: t.views_declared ?? null, views_verified: views, status: t.status,
      reward_minor: 0, reward_currency: 'RUB',
      reviewer_id: t.reviewer ? userByUid[t.reviewer]?.id || null : null, reviewed_at: t.reviewed_at || null,
      reject_reason: null, order_ref: null, screenshot_url: null, created_at: t.created_at || nowIso(),
    };
    if (rewardRub > 0) {
      const { cur, minor } = convertToUserCur(rewardRub, user);
      sub.reward_minor = minor; sub.reward_currency = cur;
      post(user.id, { wallet_type: 'bonus', type: 'tiktok_reward', amount_minor: rewardRub, currency: 'RUB', ref_type: 'tiktok', ref_id: sub.id, comment: `TikTok: ${views?.toLocaleString('ru-RU')} просмотров`, created_at: t.reviewed_at || nowIso(), created_by: sub.reviewer_id });
    }
    d.tiktok_submissions.push(sub);
  }

  // ── Реферальные награды (только за ПЕРВЫЙ полностью оплаченный заказ) ──
  const refCfg = S.settings['referral.config'].value;
  for (const r of d.referrals) {
    const paid = d.orders
      .filter((o) => o.user_id === r.referee_id && o.payment_status === 'succeeded')
      .sort((a, b) => String(a.paid_at || a.created_at).localeCompare(String(b.paid_at || b.created_at)));
    // приветственный бонус приглашённому — при регистрации
    if (refCfg.invitee_bonus_rub_minor) {
      post(r.referee_id, { wallet_type: refCfg.wallet_type || 'bonus', type: 'promo', amount_minor: refCfg.invitee_bonus_rub_minor, currency: 'RUB', ref_type: 'referral', ref_id: r.id, comment: `Приветственный бонус по коду ${r.code_used}`, created_at: r.created_at });
      r.invitee_bonus_minor = refCfg.invitee_bonus_rub_minor;
    }
    const first = paid[0];
    if (!first) continue;
    const totalRub = convertMinor(first.total_minor, first.currency_view, 'RUB', ratesEff);
    const rewardRub = Math.min(Math.round((totalRub * Number(refCfg.percent || 0)) / 100), Number(refCfg.cap_rub_minor || Infinity));
    if (rewardRub > 0) {
      const referee = d.users.find((x) => x.id === r.referee_id);
      post(r.referrer_id, { wallet_type: refCfg.wallet_type || 'bonus', type: 'referral_reward', amount_minor: rewardRub, currency: 'RUB', ref_type: 'referral', ref_id: r.id, comment: `Реферал ${referee?.public_uid || ''}: первый оплаченный заказ ${first.order_no}`, created_at: first.paid_at || first.created_at });
    }
    r.status = 'rewarded';
    r.first_order_id = first.id;
    r.reward_minor = rewardRub;
    r.rewarded_at = first.paid_at || first.created_at;
  }

  // ── избранное, отзывы, задачи, чат ─────────────────────────────────────
  const ivan = userByUid['PV-000124'];
  const fav1 = d.product_variants.find((v) => v.sku?.startsWith('PV-NK-AJ1'));
  const fav2 = d.product_variants.find((v) => v.sku?.startsWith('PV-FOG'));
  if (ivan && fav1) d.wishlists.push({ id: uid('wl_'), user_id: ivan.id, variant_id: fav1.id, price_cny_minor_at_add: fav1.price_cny_minor + 9000, alert_price_drop: true, alert_rate_drop: true, created_at: nowIso() });
  if (ivan && fav2) d.wishlists.push({ id: uid('wl_'), user_id: ivan.id, variant_id: fav2.id, price_cny_minor_at_add: fav2.price_cny_minor, alert_price_drop: true, alert_rate_drop: false, created_at: nowIso() });

  for (const rv of S.reviews || []) d.reviews.push({ id: uid('rv_'), user_id: null, order_id: null, photos: [], rating: rv.rating, body: rv.body, author_name: rv.author_name, is_published: !!rv.is_published, created_at: nowIso() });

  for (const t of S.tasks_seed || []) {
    d.tasks.push({ id: uid('tk_'), title: t.title, description: null, assignee_id: userByUid[t.assignee]?.id || null, created_by: userByUid['PV-000001']?.id || null, order_id: null, status: t.status, priority: t.priority, due_at: null, completed_at: null, created_at: nowIso() });
  }

  if (ivan) {
    const thread = { id: uid('ct_'), user_id: ivan.id, order_id: null, status: 'open', subject: 'Вопрос по срокам доставки в Минск', last_message_at: nowIso(), created_at: nowIso() };
    d.chat_threads.push(thread);
    d.chat_messages.push({ id: uid('cm_'), thread_id: thread.id, author_id: ivan.id, author_type: 'user', body: 'Здравствуйте! Подскажите, если заказать сейчас две пары и худи, успеет ли прийти к концу октября в Минск?', attachments: [], is_read: true, created_at: nowIso() });
    d.chat_messages.push({ id: uid('cm_'), thread_id: thread.id, author_id: userByUid['PV-000003']?.id || null, author_type: 'admin', body: 'Добрый день! Да, срок по Беларуси 30–35 дней с момента выкупа. Если оформить сегодня — выкупим завтра, ориентировочно 25–30 октября будете забирать. Трек-номер придёт в Telegram.', attachments: [], is_read: false, created_at: nowIso() });
  }

  // ── история курсов ─────────────────────────────────────────────────────
  for (const [cur, r] of Object.entries(cfg.rates)) {
    d.rate_history.push({ id: uid('rh_'), currency: cur, base_rate: r.base, markup_percent: r.markup, effective_rate: r.base * (1 + r.markup / 100), source: 'manual', valid_from: nowIso(), created_by: null });
  }

  // ── пересчёт уровней лояльности по фактически накопленной сумме ──────────
  for (const u of d.users) {
    const t = tierForLifetimeValue(u.lifetime_value_minor, cfg.loyaltyTiers);
    u.loyalty_tier = t.code;
  }

  // ── OPEX для P&L ───────────────────────────────────────────────────────
  // OPEX за период демо-данных (используется в отчёте P&L)
  d.opex_entries.push({ id: uid('ox_'), day: '2026-09-01', category: 'salary', amount_minor: 900000, currency: 'RUB', comment: 'ФОТ склада КНР и менеджеров (доля периода)', created_by: null, created_at: nowIso() });
  d.opex_entries.push({ id: uid('ox_'), day: '2026-09-01', category: 'marketing', amount_minor: 220000, currency: 'RUB', comment: 'TikTok-продвижение, блогеры', created_by: null, created_at: nowIso() });
  d.opex_entries.push({ id: uid('ox_'), day: '2026-09-01', category: 'software', amount_minor: 45000, currency: 'RUB', comment: 'Серверы, CRM, Telegram-бот', created_by: null, created_at: nowIso() });

  d.meta.push({ id: 'schema', version: SCHEMA_VERSION, seeded_at: nowIso() });
  return d;
}

export const paths = { ROOT, DATA_FILE, SEED_FILE };
