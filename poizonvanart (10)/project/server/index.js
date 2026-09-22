/**
 * PoizonVanart · server/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP API + раздача статики. Node 20, 0 npm-зависимостей (демо-режим).
 * В продакшене этот слой заменяется на NestJS/Fastify-контроллеры; бизнес-логика
 * (core/*) переносится без изменений.
 *
 * Запуск:  node server/index.js   →  http://0.0.0.0:8080
 * ─────────────────────────────────────────────────────────────────────────────
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import * as S from './store.js';
import * as A from './auth.js';
import { HttpError, json, text, readBody, getCookie, setCookie, clientIp, rateLimit, serveStatic, placeholderSvg, randomToken } from './util.js';
import { MINOR, VIEW_CURRENCIES, convertMinor, formatMoney } from '../core/money.js';
import { buildQuote, resolveEffectiveRates, recalcByFactWeight } from '../core/pricing.js';
import { applyPaidOrder, commissionRateForTier, tierForLifetimeValue, tierProgress, DEFAULT_TIERS } from '../core/loyalty.js';
import { availableBonus, availableMain, availableTotal, planPayment, reconcile, TX_TYPES } from '../core/wallet.js';
import { calcReferralReward, extractReferralCode, generateReferralCode, isEligibleForReward, referralLink, referralStats } from '../core/referral.js';
import { calcTikTokReward, checkRequirements, parseTikTokUrl, resolveModeration, validateSubmission, DEFAULT_TIKTOK_CONFIG } from '../core/tiktok.js';
import { aggregatePnl, multiCurrencyPnl, orderPnl, pnlByDay, toCsv } from '../core/pnl.js';
import { CDEK_CITIES, CDEK_PVZ_POINTS, getPvzList, findPvzByCode, calcDeliveryOptions } from '../core/cdek.js';
import { parsePoizonQuery, POPULAR_POIZON_ITEMS } from '../core/poizon_parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
/** Явный PUBLIC_URL из окружения — всегда в приоритете. */
const PUBLIC_URL = process.env.PUBLIC_URL || '';

/**
 * Базовый URL для публичных ссылок (реферальная, «поделиться корзиной»).
 * Берётся из заголовков запроса, поэтому ссылка работает с любого устройства —
 * с телефона по локальной сети (http://192.168.x.x:8080) и за обратным прокси
 * (X-Forwarded-Host / X-Forwarded-Proto). Раньше здесь был жёсткий localhost,
 * из-за чего скопированная ссылка не открывалась на телефоне.
 */
function baseUrlOf(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req?.headers?.['x-forwarded-host']?.split(',')[0].trim() || req?.headers?.host || `localhost:${PORT}`;
  const proto = req?.headers?.['x-forwarded-proto']?.split(',')[0].trim()
    || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

// ── микророутер ────────────────────────────────────────────────────────────
const routes = [];
function on(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-zA-Z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, opts });
}
const get = (p, h, o) => on('GET', p, h, o);
const post = (p, h, o) => on('POST', p, h, o);
const patch = (p, h, o) => on('PATCH', p, h, o);
const del = (p, h, o) => on('DELETE', p, h, o);

// ── контекст ───────────────────────────────────────────────────────────────
function ctxFor(req, res) {
  const cfg = S.pricingConfig();
  const rates = resolveEffectiveRates(cfg.rates);
  return {
    req, res, cfg, rates,
    user: req.user || null,
    body: req.body || {},
    query: req.query || {},
    ip: clientIp(req),
    viewCurrency(user) {
      const q = VIEW_CURRENCIES.includes(req.query?.currency) ? req.query.currency : null;
      if (q) return q;
      const s = user && S.findOne('user_settings', { user_id: user.id });
      return VIEW_CURRENCIES.includes(s?.currency) ? s.currency : 'RUB';
    },
    toView(minor, from, currency) { return convertMinor(minor, from, currency, rates); },
    send(status, body, headers) { json(res, status, body, headers); },
  };
}

// ── маппинг статусов заказа ────────────────────────────────────────────────
const STATUS_RU = {
  draft: 'Черновик', awaiting_payment: 'Ожидает оплаты', paid: 'Оплачен', purchasing: 'Выкупаем на Poizon',
  purchased: 'Выкуплен, на складе в Китае', photo_report: 'Фотоотчёт готов', legit_check_failed: 'Не прошёл Legit Check',
  packed: 'Упакован и взвешен', sent_to_ru: 'Отправлен карго', in_transit: 'В пути', customs: 'Таможенное оформление',
  arrived_msk: 'Прибыл в Москву', arrived_minsk: 'Прибыл в Минск', ready_for_pickup: 'Готов к выдаче',
  delivered: 'Выдан', cancelled: 'Отменён', refunded: 'Возврат выполнен',
};
const CLIENT_FLOW = ['awaiting_payment', 'paid', 'purchasing', 'purchased', 'photo_report', 'packed', 'sent_to_ru', 'in_transit', 'customs', 'arrived', 'ready_for_pickup', 'delivered'];
const TRANSITIONS = {
  draft: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['purchasing', 'cancelled', 'legit_check_failed'],
  purchasing: ['purchased', 'legit_check_failed', 'cancelled'],
  purchased: ['photo_report', 'legit_check_failed', 'packed'],
  photo_report: ['packed', 'legit_check_failed'],
  legit_check_failed: ['refunded'],
  packed: ['sent_to_ru', 'cancelled'],
  sent_to_ru: ['in_transit'],
  in_transit: ['customs', 'arrived_msk', 'arrived_minsk'],
  customs: ['arrived_msk', 'arrived_minsk'],
  arrived_msk: ['ready_for_pickup'],
  arrived_minsk: ['ready_for_pickup'],
  ready_for_pickup: ['delivered'],
  delivered: [],
  cancelled: ['refunded'],
  refunded: [],
};
const CANCELLABLE = new Set(['awaiting_payment', 'paid', 'purchasing']);

// ── сериализаторы ──────────────────────────────────────────────────────────
function userDto(user, ctx) {
  const settings = S.findOne('user_settings', { user_id: user.id }) || {};
  const w = S.walletOf(user.id);
  const cur = ctx.viewCurrency(user);
  const role = A.roleOf(user);
  const tier = tierForLifetimeValue(user.lifetime_value_minor || 0, ctx.cfg.loyaltyTiers);
  const progress = tierProgress(user.lifetime_value_minor || 0, ctx.cfg.loyaltyTiers);
  const ordersCount = S.find('orders', { user_id: user.id }).length;
  const conv = (rub) => ctx.toView(rub, 'RUB', cur);
  return {
    id: user.id,
    publicUid: user.public_uid,
    public_uid: user.public_uid,
    firstName: user.first_name,
    first_name: user.first_name,
    lastName: user.last_name,
    last_name: user.last_name,
    phone: user.phone, email: user.email,
    role: role.code, roleName: role.name, permissions: A.permissionsOf(user),
    theme: settings.theme || 'dark',
    currency: cur,
    settings: {
      language: settings.language || 'ru',
      notifyTelegram: !!settings.notify_telegram, notifyEmail: !!settings.notify_email,
      notifyPriceDrop: !!settings.notify_price_drop, notifyStatus: !!settings.notify_status,
      defaultDestination: settings.default_destination || 'RU_MOW',
      defaultPackaging: settings.default_packaging || 'basic',
      defaultInsurance: settings.default_insurance || 'none',
    },
    loyalty: {
      tier: tier.code, tierName: tier.name, commissionRate: Number(tier.commission),
      lifetimeRubMinor: user.lifetime_value_minor || 0,
      lifetimeView: conv(user.lifetime_value_minor || 0),
      progress: progress.progress,
      nextTier: progress.next ? { code: progress.next.code, name: progress.next.name, commission: Number(progress.next.commission), remainRubMinor: progress.remainRubMinor, remainView: conv(progress.remainRubMinor) } : null,
      perks: tier.perks || [],
    },
    wallet: {
      accountingCurrency: w.currency || 'RUB',
      currency: cur,
      mainRubMinor: w.balance_main_minor, bonusRubMinor: w.balance_bonus_minor,
      mainView: conv(w.balance_main_minor), bonusView: conv(w.balance_bonus_minor),
      totalView: conv(w.balance_main_minor + w.balance_bonus_minor),
      available: { main: availableMain(w), bonus: availableBonus(w), total: availableTotal(w) },
    },
    referral: {
      code: user.referral_code,
      link: referralLink(baseUrlOf(ctx.req), user.referral_code),
      invitedCount: S.find('referrals', { referrer_id: user.id }).length,
    },
    stats: { ordersCount },
    telegramLinked: !!user.telegram_chat_id,
    createdAt: user.created_at,
  };
}

function settingsPublic(ctx) {
  const pub = S.publicConfig();
  const cfg = ctx.cfg;
  return {
    currencies: VIEW_CURRENCIES,
    rates: pub['rates.currency_rates'],
    ratesEffective: ctx.rates,
    tariffs: cfg.tariffs,
    packaging: cfg.packaging,
    insuranceTiers: cfg.insuranceTiers,
    unloadingUsd: cfg.unloadingUsd,
    unloadingVolumeMaxM3: cfg.unloadingVolumeMaxM3,
    volumetricDivisor: cfg.volumetricDivisor,
    minBillableKg: cfg.minBillableKg,
    loyaltyTiers: cfg.loyaltyTiers,
    commissionBaseRate: cfg.commissionBaseRate,
    defaultWeightsKg: cfg.defaultWeightsKg,
    referral: S.getSetting('referral.config', {}),
    tiktok: S.getSetting('tiktok.config', DEFAULT_TIKTOK_CONFIG),
    contacts: pub['contacts'] || {},
    payments: pub['payments.providers'] || {},
    statuses: STATUS_RU,
    clientFlow: CLIENT_FLOW,
    serverTime: new Date().toISOString(),
  };
}

function orderDto(order, ctx, { full = true } = {}) {
  const user = S.findOne('users', { id: order.user_id });
  const storedCur = order.currency_view;
  // Все суммы на сайте показываются в выбранной валюте → конвертируем снапшот заказа.
  const cur = VIEW_CURRENCIES.includes(ctx.query.currency) ? ctx.query.currency : storedCur;
  const c1 = (minor) => (cur === storedCur ? minor : convertMinor(minor, storedCur, cur, ctx.rates));
  const items = S.find('order_items', { order_id: order.id });
  const dto = {
    id: order.id,
    orderNo: order.order_no,
    order_no: order.order_no,
    order_number: order.order_no,
    status: order.status,
    statusRu: STATUS_RU[order.status] || order.status,
    status_ru: STATUS_RU[order.status] || order.status,
    destination: order.destination,
    destinationLabel: ctx.cfg.tariffs[order.destination]?.label || order.destination,
    currency: cur,
    currency_view: cur,
    storedCurrency: storedCur,
    tier: order.loyalty_tier_at_order,
    commissionRate: Number(order.commission_rate_at_order ?? 0.1),
    totalMinor: c1(order.total_minor),
    total_minor: c1(order.total_minor),
    paidMinor: c1(order.paid_minor),
    paid_minor: c1(order.paid_minor),
    breakdown: {
      goods: c1(order.goods_minor), commission: c1(order.commission_minor), shipping: c1(order.shipping_minor),
      packaging: c1(order.packaging_minor), insurance: c1(order.insurance_minor), unloading: c1(order.unloading_minor),
      discount: c1(order.discount_minor || 0), total: c1(order.total_minor),
    },
    goodsCnyMinor: order.goods_cny_minor,
    goods_cny_minor: order.goods_cny_minor,
    weight: { estKg: order.weight_est_kg, factKg: order.weight_fact_kg, volumeM3: order.volume_m3, billableKg: order.snapshot?.weight?.billableKg ?? order.weight_est_kg },
    places: order.places_count,
    paymentStatus: order.payment_status,
    payment_status: order.payment_status,
    paymentMethod: order.payment_method,
    payment_method: order.payment_method,
    paymentPlan: 'full',
    payment_plan: 'full',
    installments: [],
    deliveryType: order.delivery_type || 'cdek_pvz',
    cdekPvz: order.cdek_pvz || null,
    trackingNumber: order.tracking_number, carrier: order.carrier,
    recipient: { name: order.recipient_name, phone: order.recipient_phone, address: order.recipient_address },
    etaDays: ctx.cfg.tariffs[order.destination] ? { min: ctx.cfg.tariffs[order.destination].days_min, max: ctx.cfg.tariffs[order.destination].days_max } : null,
    timeline: { paidAt: order.paid_at, purchasedAt: order.purchased_at, sentAt: order.sent_at, deliveredAt: order.delivered_at, cancelledAt: order.cancelled_at, createdAt: order.created_at },
    progressIndex: progressIndexFor(order),
    canCancel: CANCELLABLE.has(order.status) && order.payment_status !== 'refunded',
    canDispute: !['cancelled', 'refunded', 'delivered'].includes(order.status),
    items: items.map((i) => ({
      id: i.id, title: i.title, brand: i.brand, color: i.color, size: i.size, imageUrl: i.image_url,
      externalUrl: i.external_url, priceCnyMinor: i.price_cny_minor, qty: i.qty, weightKg: i.weight_kg,
      goods: c1(i.line_goods_minor), commission: c1(i.line_commission_minor), shipping: c1(i.line_shipping_minor),
      lineTotal: c1(i.line_total_all_minor), legitCheck: i.legit_check, status: i.status,
    })),
    user: user ? { id: user.id, publicUid: user.public_uid, name: `${user.first_name || ''} ${user.last_name || ''}`.trim(), phone: user.phone } : null,
  };
  if (!full) return dto;
  dto.photos = S.find('order_photos', { order_id: order.id }, { sort: ['created_at', 'asc'] })
    .filter((p) => p.is_visible_to_client || A.can(ctx.user, 'warehouse.photos'))
    .map((p) => ({ id: p.id, url: p.url, kind: p.kind, caption: p.caption, createdAt: p.created_at }));
  dto.history = S.find('order_status_history', { order_id: order.id }, { sort: ['created_at', 'asc'] })
    .map((h) => ({ from: h.from_status, to: h.to_status, toRu: STATUS_RU[h.to_status], comment: h.comment, at: h.created_at }));
  dto.disputes = S.find('disputes', { order_id: order.id }).map((d) => ({
    id: d.id, reason: d.reason, status: d.status, description: d.description, resolution: d.resolution,
    refundMinor: d.refund_minor, refundTo: d.refund_to, createdAt: d.created_at, handledAt: d.handled_at,
  }));
  dto.adjustments = S.find('order_adjustments', { order_id: order.id }).map((a) => ({ id: a.id, kind: a.kind, amountMinor: convertMinor(a.amount_minor, a.currency, cur, ctx.rates), currency: cur, reason: a.reason, status: a.status }));
  dto.shipments = S.find('shipments', { order_id: order.id }).map((s) => ({ trackingNumber: s.tracking_number, carrier: s.carrier, status: s.status, shippedAt: s.shipped_at }));
  if (A.can(ctx.user, 'finance.read') || A.can(ctx.user, 'orders.write')) {
    dto.payments = S.find('payments', { order_id: order.id }).map((p) => ({
      id: p.id, provider: p.provider, method: p.method, amountMinor: p.amount_minor, currency: p.currency,
      status: p.status, feeMinor: p.fee_minor, paidAt: p.paid_at,
    }));
    dto.pnl = orderPnl({ ...order, revenue_minor: order.paid_minor, revenue_currency: order.currency_view }, ctx.cfg, 'RUB');
  }
  return dto;
}

function progressIndexFor(order) {
  const dest = order.destination === 'BY_MSQ' ? 'arrived_minsk' : 'arrived_msk';
  const flow = ['awaiting_payment', 'paid', 'purchasing', 'purchased', 'photo_report', 'packed', 'sent_to_ru', 'in_transit', 'customs', dest, 'ready_for_pickup', 'delivered'];
  if (order.status === 'legit_check_failed') return { flow, index: 4, failed: true, label: STATUS_RU.legit_check_failed };
  if (order.status === 'cancelled') return { flow, index: -1, failed: true, cancelled: true, label: STATUS_RU.cancelled };
  const idx = flow.indexOf(order.status);
  return { flow, index: idx >= 0 ? idx : 0, label: STATUS_RU[order.status] };
}

function cartDto(cart, ctx, user) {
  const items = S.find('cart_items', { cart_id: cart.id }, { sort: ['created_at', 'asc'] });
  const settings = user ? S.findOne('user_settings', { user_id: user.id }) : null;
  const currency = ctx.query.currency || cart.currency_view || settings?.currency || 'RUB';
  const tier = user ? tierForLifetimeValue(user.lifetime_value_minor || 0, ctx.cfg.loyaltyTiers).code : 'BASE';
  const quote = buildQuote({
    items, destination: cart.destination, packaging: cart.packaging, insured: cart.insurance === 'standard',
    packEachSeparately: !!cart.pack_each_separately, currency, tier, config: ctx.cfg,
  });
  return {
    id: cart.id, itemsCount: items.length, destination: cart.destination, packaging: cart.packaging,
    insurance: cart.insurance, packEachSeparately: !!cart.pack_each_separately,
    shareEnabled: !!cart.share_enabled, shareToken: cart.share_token || null,
    shareUrl: cart.share_token ? `${baseUrlOf(ctx.req)}/#/cart/s/${cart.share_token}` : null,
    currency,
    items: items.map((i) => ({
      id: i.id, source: i.source, variantId: i.variant_id, productId: i.product_id,
      title: i.title, brand: i.brand_hint || null, color: i.color, size: i.size,
      category: i.category_slug, imageUrl: i.image_url, externalUrl: i.external_url,
      priceCnyMinor: i.price_cny_minor, qty: i.qty, weightKg: i.weight_kg, dimsCm: i.dims_cm, notes: i.notes,
    })),
    quote,
  };
}

// ── бизнес-операции ────────────────────────────────────────────────────────
function pushStatus(order, to, actorId, comment) {
  const allowed = TRANSITIONS[order.status] || [];
  if (!allowed.includes(to)) throw new HttpError(409, 'invalid_transition', `Переход ${order.status} → ${to} запрещён`);
  const from = order.status;
  S.updateById('orders', order.id, { status: to });
  S.insert('order_status_history', { order_id: order.id, from_status: from, to_status: to, changed_by: actorId || null, comment: comment || null });
  S.update('order_items', { order_id: order.id }, { status: to });
  const stamps = { paid: 'paid_at', purchased: 'purchased_at', sent_to_ru: 'sent_at', delivered: 'delivered_at', cancelled: 'cancelled_at' };
  if (stamps[to]) S.updateById('orders', order.id, { [stamps[to]]: new Date().toISOString() });
  S.notify(order.user_id, 'order_status', {
    title: `Заказ ${order.order_no}: ${STATUS_RU[to]}`,
    body: `Статус заказа ${order.order_no} изменён на «${STATUS_RU[to]}»`,
    channel: 'inapp', payload: { orderId: order.id, status: to },
  });
  telegramNotify(order.user_id, `Заказ ${order.order_no}: ${STATUS_RU[to]}`);
  S.audit(actorId, 'order.status', 'order', order.id, { status: from }, { status: to });
  return S.findOne('orders', { id: order.id });
}

/** Оплата заказа: кошелёк / бонусы / комбинированно / карта (мок-эквайринг), с поддержкой рассрочки и 50/50. */
function payOrder(order, ctx, { method = 'card', amountOverride = null, installmentIndex = 0 } = {}) {
  const user = S.findOne('users', { id: order.user_id });
  const w = S.walletOf(user.id);
  const total = Number(amountOverride ?? (order.total_minor - (order.paid_minor || 0)));
  // Кошелёк ведётся в единой валюте учёта (RUB) → конвертируем сумму заказа.
  const totalRub = order.currency_view === 'RUB' ? total : convertMinor(total, order.currency_view, 'RUB', ctx.rates);
  const walletPart = ['wallet', 'bonus', 'combined'].includes(method);
  const plan = walletPart ? planPayment(w, totalRub) : planPayment({ ...w, balance_bonus_minor: 0, balance_main_minor: 0 }, totalRub);

  const payments = [];
  let covered = 0;
  if (plan.fromBonus > 0) {
    S.postWalletTx(user.id, { wallet_type: 'bonus', type: TX_TYPES.ORDER_PAYMENT_BONUS, amount_minor: -plan.fromBonus, currency: 'RUB', ref_type: 'order', ref_id: order.id, comment: `Оплата ${order.order_no} (бонусы)`, idempotency_key: `${order.id}:bonus:${Date.now()}`, created_by: ctx.user?.id ?? null });
    covered += plan.fromBonus;
  }
  if (plan.fromMain > 0) {
    S.postWalletTx(user.id, { wallet_type: 'main', type: TX_TYPES.ORDER_PAYMENT, amount_minor: -plan.fromMain, currency: 'RUB', ref_type: 'order', ref_id: order.id, comment: `Оплата ${order.order_no} (баланс)`, idempotency_key: `${order.id}:main:${Date.now()}`, created_by: ctx.user?.id ?? null });
    covered += plan.fromMain;
  }
    // Внутренний баланс учитывается в единой валюте учёта (RUB).
    // Все расчёты плана оплаты ведутся в RUB, а списания и эквайринг
    // фиксируются в валюте заказа order.currency_view.
    const totalView = total;
    const coveredRub = covered;
    const coveredView = convertMinor(coveredRub, 'RUB', order.currency_view, ctx.rates);
    const cardAmountView = Math.max(0, totalView - coveredView);
    if (cardAmountView > 0) {
      const fee = Math.round(cardAmountView * 0.023);
      payments.push(S.insert('payments', {
        order_id: order.id, user_id: user.id, provider: method === 'sbp' ? 'yookassa_sbp' : 'yookassa',
        provider_tx_id: randomToken(10).toUpperCase(), method: method === 'sbp' ? 'sbp' : 'card',
        amount_minor: cardAmountView, currency: order.currency_view, status: 'succeeded', fee_minor: fee,
        idempotency_key: `${order.id}:card:${Date.now()}`, payload: { gateway: 'direct' }, paid_at: new Date().toISOString(),
      }));
      S.updateById('orders', order.id, { acquiring_fee_minor: (order.acquiring_fee_minor || 0) + fee });
    }
    if (coveredView > 0) {
      payments.push(S.insert('payments', {
        order_id: order.id, user_id: user.id, provider: 'wallet', provider_tx_id: null,
        method: plan.fromBonus && !plan.fromMain ? 'bonus' : 'wallet', amount_minor: coveredView,
        currency: order.currency_view, status: 'succeeded', fee_minor: 0,
        idempotency_key: `${order.id}:wallet:${Date.now()}`, payload: { bonus: plan.fromBonus, main: plan.fromMain },
        paid_at: new Date().toISOString(),
      }));
    }
    afterSuccessfulPayment(order, ctx, payments, { bonus: plan.fromBonus, main: plan.fromMain, card: cardAmountView }, {
      amountPaidThisTime: total,
      installmentIndex,
    });
    return S.findOne('orders', { id: order.id });
}

function afterSuccessfulPayment(order, ctx, payments, split, { amountPaidThisTime = 0, installmentIndex = 0 } = {}) {
  const user = S.findOne('users', { id: order.user_id });
  let newPaidMinor = (order.paid_minor || 0) + amountPaidThisTime;
  if (!amountPaidThisTime) newPaidMinor = order.total_minor;
  if (newPaidMinor > order.total_minor) newPaidMinor = order.total_minor;

  let installments = order.installments ? JSON.parse(JSON.stringify(order.installments)) : null;
  let newPaymentStatus = newPaidMinor >= order.total_minor ? 'succeeded' : 'partial';

  if (installments && installments.length) {
    let targetIdx = installmentIndex;
    if (installments[targetIdx]?.status === 'paid') {
      targetIdx = installments.findIndex((it) => it.status !== 'paid');
    }
    if (targetIdx >= 0 && targetIdx < installments.length) {
      installments[targetIdx].status = 'paid';
      installments[targetIdx].paid_at = new Date().toISOString();
    }
    const allDone = installments.every((it) => it.status === 'paid');
    newPaymentStatus = allDone ? 'succeeded' : 'partial';
  }

  S.updateById('orders', order.id, {
    payment_status: newPaymentStatus,
    paid_minor: newPaidMinor,
    installments: installments || undefined,
    payment_method: split.card > 0 && (split.bonus + split.main) > 0 ? 'combined' : split.card > 0 ? (payments[0]?.method || 'card') : split.bonus > 0 && split.main > 0 ? 'combined' : split.bonus > 0 ? 'bonus' : 'wallet',
    // закупочные данные для P&L (в демо — производные от котировки)
    cogs_cny_minor: Math.round(order.goods_cny_minor * 0.985),
    cargo_usd_minor: Math.round((order.weight_est_kg) * (order.snapshot?.tariff_usd_per_kg ?? 4) * 100 * 0.92),
    extra_usd_minor: (order.snapshot?.packaging?.places ?? 1) * (order.snapshot?.packaging?.priceUsd ?? 3) * 100,
  });

  if (order.status === 'awaiting_payment') {
    pushStatus(S.findOne('orders', { id: order.id }), 'paid', ctx.user?.id ?? null, newPaymentStatus === 'partial' ? 'Первая часть оплаты получена' : 'Оплата получена');
  }

  // лояльность: начисляем пропорционально оплаченной сумме
  const rubMinor = convertMinor(amountPaidThisTime || order.total_minor, order.currency_view, 'RUB', ctx.rates);
  const res = applyPaidOrder(user.lifetime_value_minor || 0, rubMinor, ctx.cfg.loyaltyTiers);
  S.updateById('users', user.id, { lifetime_value_minor: res.lifetimeRubMinor, loyalty_tier: res.tier });
  if (res.upgraded) {
    S.notify(user.id, 'loyalty_upgraded', {
      title: `Новый уровень: ${res.to}`,
      body: `Комиссия сервиса снижена до ${(commissionRateForTier(res.to, ctx.cfg.loyaltyTiers) * 100).toFixed(0)}%`,
      payload: { from: res.from, to: res.to },
    });
    telegramNotify(user.id, `🎉 Новый уровень лояльности ${res.to}: комиссия ${(commissionRateForTier(res.to, ctx.cfg.loyaltyTiers) * 100).toFixed(0)}%`);
  }

  // реферальная программа: награда ТОЛЬКО за первый полностью оплаченный заказ
  if (newPaymentStatus === 'succeeded') {
    maybeRewardReferral(user, order, ctx);
  }

  S.notify(user.id, 'order_paid', {
    title: newPaymentStatus === 'partial' ? `Частичная оплата заказа ${order.order_no}` : `Заказ ${order.order_no} оплачен`,
    body: newPaymentStatus === 'partial' ? 'Платёж зачислен, товар запущен в выкуп' : 'Начинаем выкуп на Poizon',
    payload: { orderId: order.id, split },
  });
  S.audit(ctx.user?.id ?? null, 'order.paid', 'order', order.id, null, { total: order.total_minor, paid: newPaidMinor, split });

  if (order.status === 'awaiting_payment') {
    S.insert('tasks', { title: `Выкупить ${order.order_no}`, description: 'Выкуп на Poizon + фотоотчёт', assignee_id: null, created_by: null, order_id: order.id, status: 'todo', priority: 'high', due_at: null, completed_at: null });
  }
}

function maybeRewardReferral(user, order, ctx) {
  const binding = S.findOne('referrals', { referee_id: user.id });
  if (!binding) return;
  const paidOrders = S.find('orders', { user_id: user.id }).filter((o) => o.payment_status === 'succeeded');
  const isFirst = paidOrders.length === 1 && paidOrders[0].id === order.id;
  const eligibility = isEligibleForReward({ order: { ...order, payment_status: 'succeeded', paid_minor: order.total_minor }, referral: binding, isFirstOrder: isFirst });
  if (!eligibility.eligible) return { skipped: eligibility.reasons };
  const refCfg = S.getSetting('referral.config', {});
  const orderRub = convertMinor(order.total_minor, order.currency_view, 'RUB', ctx.rates);
  const reward = calcReferralReward(orderRub, refCfg);
  if (reward.referrerRewardRubMinor > 0) {
    S.postWalletTx(binding.referrer_id, {
      wallet_type: reward.walletType, type: TX_TYPES.REFERRAL_REWARD, amount_minor: reward.referrerRewardRubMinor,
      currency: 'RUB', ref_type: 'referral', ref_id: binding.id,
      comment: `Реферал ${user.public_uid}: первый оплаченный заказ ${order.order_no}`,
      idempotency_key: `referral:${binding.id}:${order.id}`, created_by: null,
    });
    const referrer = S.findOne('users', { id: binding.referrer_id });
    const cur = S.findOne('user_settings', { user_id: binding.referrer_id })?.currency || 'RUB';
    S.notify(binding.referrer_id, 'referral_reward', {
      title: 'Реферальный бонус начислен',
      body: `${user.first_name || 'Ваш друг'} оплатил первый заказ — вам начислено ${formatMoney(convertMinor(reward.referrerRewardRubMinor, 'RUB', cur, ctx.rates), cur)}`,
      payload: { orderId: order.id, reward: reward.referrerRewardRubMinor },
    });
    telegramNotify(binding.referrer_id, `💰 Реферальный бонус ${formatMoney(convertMinor(reward.referrerRewardRubMinor, 'RUB', cur, ctx.rates), cur)} за первый оплаченный заказ друга`);
    if (referrer) S.audit(null, 'referral.reward', 'referral', binding.id, null, { reward: reward.referrerRewardRubMinor, order: order.order_no });
  }
  S.updateById('referrals', binding.id, { status: 'rewarded', first_order_id: order.id, reward_minor: reward.referrerRewardRubMinor, rewarded_at: new Date().toISOString() });
  return { rewarded: reward.referrerRewardRubMinor };
}

/** Заглушка Telegram-бота (в проде — grammY + очередь BullMQ). */
function telegramNotify(userId, message) {
  const user = S.findOne('users', { id: userId });
  const settings = S.findOne('user_settings', { user_id: userId });
  if (!user?.telegram_chat_id || settings?.notify_telegram === false) return null;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    // fetch(`https://api.telegram.org/bot${token}/sendMessage`, {...}) — опционально
  }
  S.insert('notifications', { user_id: userId, channel: 'telegram', event: 'telegram', title: message, body: message, payload: { chatId: user.telegram_chat_id }, status: token ? 'queued' : 'sent', sent_at: new Date().toISOString() });
  return true;
}

function activeCart(ctx, { create = true } = {}) {
  const user = ctx.user;
  if (!user) {
    if (!create) return null;
    return S.insert('carts', { user_id: null, guest_token: ctx.req.guestToken, type: 'active', destination: 'RU_MOW', packaging: 'basic', insurance: 'none', currency_view: ctx.viewCurrency(null) });
  }
  let cart = S.findOne('carts', { user_id: user.id, type: 'active' });
  if (!cart && create) {
    const settings = S.findOne('user_settings', { user_id: user.id }) || {};
    cart = S.insert('carts', {
      user_id: user.id, type: 'active', destination: settings.default_destination || 'RU_MOW',
      packaging: settings.default_packaging || 'basic', insurance: settings.default_insurance || 'none',
      currency_view: settings.currency || 'RUB', share_enabled: false, share_token: null, pack_each_separately: false,
    });
  }
  return cart;
}

function normalizeCartItemInput(b, ctx) {
  const source = ['catalog', 'link', 'manual'].includes(b.source) ? b.source : 'manual';
  let title = A.validators.str(b.title, 240);
  let priceCny = A.validators.int(b.priceCnyMinor ?? b.price_cny_minor, 0, 100_000_000);
  let weight = Number(b.weightKg ?? b.weight_kg ?? 0);
  let color = A.validators.str(b.color, 80);
  let size = A.validators.str(b.size, 40);
  let imageUrl = A.validators.str(b.imageUrl ?? b.image_url, 500);
  let externalUrl = A.validators.str(b.externalUrl ?? b.external_url, 800);
  let categorySlug = A.validators.str(b.category ?? b.category_slug, 60);
  let variantId = b.variantId ?? b.variant_id ?? null;
  let productId = b.productId ?? b.product_id ?? null;
  let dims = b.dimsCm ?? b.dims_cm ?? null;

  if (variantId) {
    const v = S.findOne('product_variants', { id: variantId });
    if (!v) throw new HttpError(404, 'variant_not_found', 'Вариант товара не найден');
    const p = S.findOne('products', { id: v.product_id });
    variantId = v.id; productId = v.product_id;
    title = p?.name || title || 'Товар';
    priceCny = v.price_cny_minor;
    weight = Number(v.weight_kg || p?.weight_est_kg || 1);
    color = v.color || color; size = v.size_eur || size;
    imageUrl = p?.images?.[0] || null; externalUrl = p?.external_url || externalUrl;
    categorySlug = p?.category_slug || categorySlug;
    dims = dims || (categorySlug === 'sneakers' ? { l: 34, w: 22, h: 13 } : { l: 30, w: 24, h: 6 });
  }
  if (!title) throw new HttpError(400, 'title_required', 'Укажите название товара');
  if (!categorySlug) categorySlug = 'sneakers';
  if (!weight || weight <= 0) weight = Number(ctx.cfg.defaultWeightsKg[categorySlug] || 1);
  if (priceCny == null) throw new HttpError(400, 'price_required', 'Укажите цену в CNY');
  const qty = A.validators.int(b.qty ?? 1, 1, 99) || 1;
  if (source === 'link' && !externalUrl) throw new HttpError(400, 'url_required', 'Укажите ссылку на товар (Poizon/Dewu)');

  return {
    source, title, price_cny_minor: priceCny, weight_kg: Math.round(weight * 1000) / 1000, qty,
    color, size, category_slug: categorySlug, image_url: imageUrl, external_url: externalUrl,
    variant_id: variantId, product_id: productId, dims_cm: dims,
    brand_hint: A.validators.str(b.brand, 80), notes: A.validators.str(b.notes, 500),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════════════════
get('/api/config', (ctx) => ctx.send(200, { ok: true, data: settingsPublic(ctx) }));

get('/api/catalog', (ctx) => {
  const { q, category, brand, sort, featured } = ctx.query;
  let rows = S.find('products', { is_active: true });
  if (category) rows = rows.filter((p) => p.category_slug === category);
  if (brand) rows = rows.filter((p) => p.brand_slug === brand);
  if (featured === '1') rows = rows.filter((p) => p.is_featured);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((p) => [p.name, p.name_cn, p.sku, p.brand_name, p.category_name].filter(Boolean).join(' ').toLowerCase().includes(s));
  }
  const cur = ctx.viewCurrency(ctx.user);
  const data = rows.map((p) => {
    const variants = S.find('product_variants', { product_id: p.id });
    const minPrice = variants.length ? Math.min(...variants.map((v) => v.price_cny_minor)) : (p.price_cny_minor || 0);
    return {
      id: p.id, sku: p.sku, slug: p.slug, name: p.name, nameCn: p.name_cn, brand: p.brand_name, brandSlug: p.brand_slug,
      category: p.category_name, categorySlug: p.category_slug, image: p.images?.[0] || null,
      externalUrl: p.external_url, externalSource: p.external_source, featured: p.is_featured,
      weightEstKg: p.weight_est_kg, description: p.description,
      priceCnyMinor: minPrice,
      priceView: ctx.toView(minPrice, 'CNY', cur),
      priceCommissionView: ctx.toView(Math.round(minPrice * (ctx.cfg.commissionBaseRate || 0.1)), 'CNY', cur),
      currency: cur,
      sizes: [...new Set(variants.map((v) => v.size_eur).filter(Boolean))],
      colors: [...new Set(variants.map((v) => v.color).filter(Boolean))],
      variantsCount: variants.length,
    };
  });
  if (sort === 'price_asc') data.sort((a, b) => a.priceCnyMinor - b.priceCnyMinor);
  if (sort === 'price_desc') data.sort((a, b) => b.priceCnyMinor - a.priceCnyMinor);
  ctx.send(200, { ok: true, data, meta: { count: data.length, currency: cur, categories: S.find('categories', { is_active: true }, { sort: 'sort_order' }), brands: S.find('brands', {}) } });
});

get('/api/catalog/:slug', (ctx) => {
  const p = S.findOne('products', { slug: ctx.params.slug }) || S.findOne('products', { id: ctx.params.slug });
  if (!p) throw new HttpError(404, 'product_not_found', 'Товар не найден');
  const cur = ctx.viewCurrency(ctx.user);
  const variants = S.find('product_variants', { product_id: p.id }, { sort: 'seq' }).map((v) => ({
    id: v.id, color: v.color, sizeEur: v.size_eur, sizeUs: v.size_us, sizeCn: v.size_cn,
    priceCnyMinor: v.price_cny_minor, priceView: ctx.toView(v.price_cny_minor, 'CNY', cur),
    weightKg: v.weight_kg, stockStatus: v.stock_status, sku: v.sku,
  }));
  const guide = S.findOne('size_guides', { category_slug: p.category_slug, brand_slug: p.brand_slug })
    || S.findOne('size_guides', { category_slug: p.category_slug, brand_slug: null });
  ctx.send(200, {
    ok: true, data: {
      id: p.id, sku: p.sku, slug: p.slug, name: p.name, nameCn: p.name_cn, brand: p.brand_name,
      category: p.category_name, categorySlug: p.category_slug, description: p.description,
      images: p.images, externalUrl: p.external_url, externalSource: p.external_source, weightEstKg: p.weight_est_kg,
      currency: cur, variants, sizeGuide: guide || null,
      priceFromView: variants.length ? Math.min(...variants.map((v) => v.priceView)) : 0,
    },
  });
});

get('/api/size-guide', (ctx) => {
  const { footMm, brand, category, heightCm, weightKg } = ctx.query;
  const guides = S.find('size_guides', { is_active: true });
  const specific = brand ? guides.filter((g) => g.brand_slug === brand) : [];
  const general = guides.filter((g) => !g.brand_slug);
  const list = [...specific, ...general];
  let recommendation = null;
  if (footMm) {
    const mm = Number(footMm);
    const footwear = (specific.find((g) => g.kind === 'footwear') || general.find((g) => g.kind === 'footwear'));
    if (footwear) {
      const row = footwear.rows.reduce((best, r) => (Math.abs(Number(r.foot_mm) - mm) < Math.abs(Number(best.foot_mm) - mm) ? r : best), footwear.rows[0]);
      recommendation = { kind: 'footwear', footMm: mm, guide: footwear.brand_slug || 'general', row, note: footwear.notes };
    }
  }
  if (!recommendation && (heightCm || weightKg)) {
    const apparel = (specific.find((g) => g.kind === 'apparel') || general.find((g) => g.kind === 'apparel'));
    if (apparel) {
      const h = Number(heightCm || 0), w = Number(weightKg || 0);
      const row = apparel.rows.find((r) => {
        const [h1, h2] = String(r.height_cm).split(/[–-]/).map(Number);
        const [w1, w2] = String(r.weight_kg).split(/[–-]/).map(Number);
        return (!h || (h >= h1 && h <= h2)) && (!w || (w >= w1 && w <= w2));
      }) || null;
      recommendation = { kind: 'apparel', heightCm: h, weightKg: w, guide: apparel.brand_slug || 'general', row, note: apparel.notes };
    }
  }
  ctx.send(200, { ok: true, data: { guides: list, recommendation } });
});

get('/api/reviews', (ctx) => ctx.send(200, { ok: true, data: S.find('reviews', { is_published: true }, { sort: ['created_at', 'desc'] }) }));

post('/api/catalog/parse-link', (ctx) => {
  const q = ctx.body.url || ctx.body.query || ctx.body.sku || '';
  if (!q) throw new HttpError(400, 'query_required', 'Укажите ссылку или артикул Poizon');
  const res = parsePoizonQuery(q, {
    rates: ctx.rates,
    destination: ctx.body.destination || 'RU_MOW',
  });
  ctx.send(200, { ok: true, data: res });
});

get('/api/cdek/cities', (ctx) => {
  ctx.send(200, { ok: true, data: CDEK_CITIES });
});

get('/api/cdek/pvz', (ctx) => {
  const city = ctx.query.city || 'RU_MOW';
  const pvz = getPvzList(city);
  ctx.send(200, { ok: true, data: pvz });
});

get('/api/cdek/delivery-options', (ctx) => {
  const dest = ctx.query.destination || 'RU_MOW';
  const cur = ctx.viewCurrency(ctx.user);
  const options = calcDeliveryOptions({ destination: dest, currency: cur, rates: ctx.rates });
  ctx.send(200, { ok: true, data: options });
});

// ── капча ──────────────────────────────────────────────────────────────────
get('/api/auth/captcha', (ctx) => {
  if (!rateLimit(`captcha:${ctx.ip}`, 30, 60_000)) throw new HttpError(429, 'rate_limited', 'Слишком много запросов');
  ctx.send(200, { ok: true, data: A.issueCaptcha() });
});

// ── регистрация / вход ─────────────────────────────────────────────────────
function finishLogin(user, ctx) {
  const { accessToken, refreshToken } = A.createSession(user, ctx.req);
  A.rememberToken(accessToken, user.id);
  setCookie(ctx.res, 'pv_at', accessToken, { maxAge: 15 * 60, httpOnly: true });
  setCookie(ctx.res, 'pv_rt', refreshToken, { maxAge: 30 * 86400, httpOnly: true });
  return { token: accessToken, user: userDto(user, ctx) };
}

post('/api/auth/register', (ctx) => {
  const b = ctx.body;
  if (!rateLimit(`reg:${ctx.ip}`, 20, 60 * 60_000)) throw new HttpError(429, 'rate_limited', 'Слишком много регистраций');
  const answer = b.captchaAnswer || b.captchaToken;
  if (b.captchaId && !A.verifyCaptcha(b.captchaId, answer)) throw new HttpError(400, 'captcha_failed', 'Проверка безопасности не пройдена');
  const phone = A.validators.phone(b.phone);
  const cleanPhone = phone ? phone.replace(/[^\d+]/g, '') : null;
  const email = A.validators.email(b.email);
  if (!phone && !email) throw new HttpError(400, 'contact_required', 'Укажите телефон или e-mail');
  if (cleanPhone && S.find('users').some((u) => u.phone && u.phone.replace(/[^\d+]/g, '') === cleanPhone)) {
    throw new HttpError(409, 'phone_taken', 'Телефон уже зарегистрирован');
  }
  if (email && S.findOne('users', { email })) throw new HttpError(409, 'email_taken', 'E-mail уже зарегистрирован');
  const pw = A.validators.password(b.password);
  if (pw.error) throw new HttpError(400, 'weak_password', pw.error);
  if (b.agreeTerms === false) throw new HttpError(400, 'terms_required', 'Необходимо согласие с офертой');

  const bl = A.isBlacklisted({ phone, email, ip: ctx.ip });
  if (bl) throw new HttpError(403, 'blacklisted', `Регистрация заблокирована (${bl.kind})`);

  const role = S.findOne('roles', { code: 'client' });
  let code = '';
  do { code = generateReferralCode(); } while (S.findOne('users', { referral_code: code }));
  const seq = S.find('users', {}).length + 127;

  const user = S.insert('users', {
    public_uid: `PV-${String(seq).padStart(6, '0')}`, role_id: role.id, role_code: role.code,
    phone, email, telegram_username: A.validators.str(b.telegram, 60), telegram_chat_id: null,
    password_hash: A.hashPassword(pw.ok), first_name: A.validators.str(b.firstName, 60), last_name: A.validators.str(b.lastName, 60),
    referral_code: code, referred_by_id: null, loyalty_tier: 'BASE', lifetime_value_minor: 0,
    balance_main_minor: 0, balance_bonus_minor: 0, is_blacklisted: false, is_verified: false,
  });
  S.insert('user_settings', {
    user_id: user.id, theme: A.validators.theme(b.theme) || 'dark', currency: A.validators.currency(b.currency) || 'RUB',
    language: 'ru', notify_telegram: true, notify_email: true, notify_price_drop: true, notify_status: true,
    default_destination: A.validators.destination(b.destination) || 'RU_MOW', default_packaging: 'basic', default_insurance: 'none',
  });
  S.insert('wallets', { user_id: user.id, currency: 'RUB', balance_main_minor: 0, balance_bonus_minor: 0, frozen_minor: 0 });
  S.audit(user.id, 'auth.register', 'user', user.id, null, { public_uid: user.public_uid }, { ip: ctx.ip });

  // реферальная привязка
  const refCode = extractReferralCode(b.ref || getCookie(ctx.req, 'pv_ref'));
  if (refCode) {
    const referrer = S.findOne('users', { referral_code: refCode });
    const existingBinding = S.findOne('referrals', { referee_id: user.id });
    if (referrer && referrer.id !== user.id && !existingBinding) {
      S.updateById('users', user.id, { referred_by_id: referrer.id });
      S.insert('referrals', { referrer_id: referrer.id, referee_id: user.id, code_used: refCode, status: 'registered', first_order_id: null, reward_minor: 0, invitee_bonus_minor: 0, ip: ctx.ip });
      const refCfg = S.getSetting('referral.config', {});
      const bonus = Number(refCfg.invitee_bonus_rub_minor || 0);
      if (bonus > 0) {
        S.postWalletTx(user.id, { wallet_type: refCfg.wallet_type || 'bonus', type: TX_TYPES.PROMO, amount_minor: bonus, currency: 'RUB', ref_type: 'referral', comment: `Приветственный бонус по коду ${refCode}` });
        S.notify(user.id, 'welcome_bonus', { title: 'Приветственный бонус', body: `Вам начислено ${formatMoney(convertMinor(bonus, 'RUB', ctx.viewCurrency(user), ctx.rates), ctx.viewCurrency(user))} по приглашению друга` });
      }
    }
  }
  ctx.send(201, { ok: true, data: finishLogin(S.findOne('users', { id: user.id }), ctx) });
});

post('/api/auth/login', (ctx) => {
  const b = ctx.body;
  if (!rateLimit(`login:${ctx.ip}`, 25, 15 * 60_000)) throw new HttpError(429, 'rate_limited', 'Слишком много попыток входа');
  const answer = b.captchaAnswer || b.captchaToken;
  if (b.captchaId && !A.verifyCaptcha(b.captchaId, answer)) throw new HttpError(400, 'captcha_failed', 'Проверка безопасности не пройдена');
  const login = String(b.login || '').trim();
  const digitsOnly = login.replace(/[^\d+]/g, '');
  const user = S.find('users').find((u) =>
    (u.phone && (u.phone === login || (digitsOnly.length >= 7 && u.phone.replace(/[^\d+]/g, '') === digitsOnly))) ||
    (u.email && u.email.toLowerCase() === login.toLowerCase()) ||
    (u.public_uid && u.public_uid.toUpperCase() === login.toUpperCase())
  );
  if (!user || !A.verifyPassword(b.password, user.password_hash)) throw new HttpError(401, 'invalid_credentials', 'Неверный логин или пароль');
  if (user.is_blacklisted) throw new HttpError(403, 'blacklisted', 'Аккаунт заблокирован');
  S.audit(user.id, 'auth.login', 'user', user.id, null, null, { ip: ctx.ip });
  ctx.send(200, { ok: true, data: finishLogin(user, ctx) });
});

post('/api/auth/logout', (ctx) => {
  const token = (ctx.req.headers.authorization || '').replace('Bearer ', '') || getCookie(ctx.req, 'pv_at');
  A.forgetToken(token);
  setCookie(ctx.res, 'pv_at', '', { maxAge: 0 });
  setCookie(ctx.res, 'pv_rt', '', { maxAge: 0 });
  ctx.send(200, { ok: true });
});

post('/api/auth/refresh', (ctx) => {
  const rt = ctx.body.refreshToken || getCookie(ctx.req, 'pv_rt');
  const session = S.findOne('sessions', { refresh_hash: A.sha256(rt) });
  if (!session || new Date(session.expires_at) < new Date()) throw new HttpError(401, 'invalid_session', 'Сессия истекла');
  const user = S.findOne('users', { id: session.user_id });
  ctx.send(200, { ok: true, data: finishLogin(user, ctx) });
});

// ═══════════════════════════════════════════════════════════════════════════
// ME / SETTINGS / WALLET
// ═══════════════════════════════════════════════════════════════════════════
get('/api/me', (ctx) => {
  const user = A.requireAuth(ctx.req);
  ctx.send(200, { ok: true, data: userDto(user, ctx) });
});

patch('/api/me/settings', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const s = S.findOne('user_settings', { user_id: user.id }) || S.insert('user_settings', { user_id: user.id });
  const patch = {};
  if (ctx.body.theme !== undefined) {
    const t = A.validators.theme(ctx.body.theme);
    if (!t) throw new HttpError(400, 'invalid_theme', 'Допустимые значения: dark, light, system');
    patch.theme = t;
  }
  if (ctx.body.currency !== undefined) {
    const c = A.validators.currency(ctx.body.currency);
    if (!c || !VIEW_CURRENCIES.includes(c)) throw new HttpError(400, 'invalid_currency', 'Допустимые валюты: BYN, RUB, USD');
    patch.currency = c;
  }
  for (const [k, field] of [['notifyTelegram', 'notify_telegram'], ['notifyEmail', 'notify_email'], ['notifyPriceDrop', 'notify_price_drop'], ['notifyStatus', 'notify_status']]) {
    if (ctx.body[k] !== undefined) patch[field] = !!ctx.body[k];
  }
  if (ctx.body.defaultDestination) patch.default_destination = A.validators.destination(ctx.body.defaultDestination) || s.default_destination;
  if (ctx.body.defaultPackaging) patch.default_packaging = ctx.body.defaultPackaging;
  if (ctx.body.defaultInsurance) patch.default_insurance = ctx.body.defaultInsurance;
  S.updateById('user_settings', s.id, patch);
  S.audit(user.id, 'settings.update', 'user_settings', s.id, s, patch);
  ctx.send(200, { ok: true, data: userDto(user, ctx) });
});

patch('/api/me/profile', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const patch = {};
  const fn = ctx.body.firstName ?? ctx.body.first_name;
  if (fn !== undefined) patch.first_name = A.validators.str(fn, 60);
  const ln = ctx.body.lastName ?? ctx.body.last_name;
  if (ln !== undefined) patch.last_name = A.validators.str(ln, 60);
  if (ctx.body.telegram !== undefined || ctx.body.telegram_username !== undefined) patch.telegram_username = A.validators.str(ctx.body.telegram ?? ctx.body.telegram_username, 60);
  if (ctx.body.phone !== undefined) {
    const p = A.validators.phone(ctx.body.phone);
    if (p) {
      const existing = S.findOne('users', { phone: p });
      if (existing && existing.id !== user.id) throw new HttpError(409, 'phone_taken', 'Телефон занят');
      patch.phone = p;
    }
  }
  if (ctx.body.email !== undefined) {
    const em = A.validators.email(ctx.body.email);
    if (em) {
      const existing = S.findOne('users', { email: em });
      if (existing && existing.id !== user.id) throw new HttpError(409, 'email_taken', 'E-mail занят');
      patch.email = em;
    }
  }
  S.updateById('users', user.id, patch);
  ctx.send(200, { ok: true, data: userDto(S.findOne('users', { id: user.id }), ctx) });
});

get('/api/me/notifications', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const rows = S.find('notifications', { user_id: user.id, channel: 'inapp' }, { sort: ['created_at', 'desc'], limit: 50 });
  ctx.send(200, { ok: true, data: rows.map((n) => ({ id: n.id, event: n.event, title: n.title, body: n.body, at: n.created_at, read: n.status === 'read' })) });
});
post('/api/me/notifications/read', (ctx) => {
  const user = A.requireAuth(ctx.req);
  S.update('notifications', { user_id: user.id, channel: 'inapp' }, { status: 'read' });
  ctx.send(200, { ok: true });
});

// ── кошелёк ────────────────────────────────────────────────────────────────
get('/api/wallet', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const cur = ctx.viewCurrency(user);
  const w = S.walletOf(user.id);
  const txs = S.find('wallet_transactions', { user_id: user.id }, { sort: ['created_at', 'desc'], limit: 100 });
  const conv = (rub) => ctx.toView(rub, 'RUB', cur);
  ctx.send(200, {
    ok: true, data: {
      accountingCurrency: w.currency, currency: cur,
      mainRubMinor: w.balance_main_minor, bonusRubMinor: w.balance_bonus_minor,
      mainView: conv(w.balance_main_minor), bonusView: conv(w.balance_bonus_minor), totalView: conv(w.balance_main_minor + w.balance_bonus_minor),
      transactions: txs.map((t) => ({
        id: t.id, type: t.type, walletType: t.wallet_type, amountMinor: t.amount_minor,
        amountView: conv(t.amount_minor), currency: cur, comment: t.comment,
        balanceAfterView: conv(t.balance_after), refType: t.ref_type, refId: t.ref_id, at: t.created_at,
      })),
      reconciliation: reconcile(w, txs).ok,
    },
  });
});

post('/api/wallet/topup', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const amountRub = A.validators.int(ctx.body.amountRubMinor ?? ctx.body.amount_minor, 100, 100_000_000);
  if (!amountRub) throw new HttpError(400, 'invalid_amount', 'Некорректная сумма');
  const provider = ['card', 'sbp', 'erip'].includes(ctx.body.provider) ? ctx.body.provider : 'card';
  // Демо: эквайринг отвечает мгновенно. В проде: создать payment → redirect → webhook.
  const payment = S.insert('payments', {
    order_id: null, user_id: user.id, provider: provider === 'sbp' ? 'yookassa_sbp' : provider === 'erip' ? 'belpay' : 'yookassa',
    provider_tx_id: randomToken(10).toUpperCase(), method: provider === 'erip' ? 'erip' : provider === 'sbp' ? 'sbp' : 'card',
    amount_minor: amountRub, currency: 'RUB', status: 'succeeded', fee_minor: Math.round(amountRub * 0.0),
    idempotency_key: `topup:${user.id}:${Date.now()}`, payload: { walletType: 'main' }, paid_at: new Date().toISOString(),
  });
  const tx = S.postWalletTx(user.id, {
    wallet_type: 'main', type: TX_TYPES.TOPUP, amount_minor: amountRub, currency: 'RUB',
    ref_type: 'payment', ref_id: payment.id, comment: `Пополнение (${provider.toUpperCase()})`, idempotency_key: `topup:${payment.id}`,
  });
  S.audit(user.id, 'wallet.topup', 'payment', payment.id, null, { amountRub });
  ctx.send(200, { ok: true, data: { paymentId: payment.id, providerTxId: payment.provider_tx_id, amountRubMinor: amountRub, tx: tx.tx, wallet: S.walletOf(user.id) } });
});

post('/api/wallet/withdraw', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const amount = A.validators.int(ctx.body.amountRubMinor, 100, 100_000_000);
  const w = S.walletOf(user.id);
  if (!amount || amount > availableMain(w)) throw new HttpError(400, 'insufficient_funds', 'Недостаточно основного баланса (бонусы не выводятся)');
  S.postWalletTx(user.id, { wallet_type: 'main', type: TX_TYPES.WITHDRAW, amount_minor: -amount, currency: 'RUB', comment: 'Вывод средств', idempotency_key: `wd:${user.id}:${Date.now()}` });
  ctx.send(200, { ok: true, data: S.walletOf(user.id) });
});

// ── избранное ──────────────────────────────────────────────────────────────
get('/api/favorites', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const cur = ctx.viewCurrency(user);
  const rows = S.find('wishlists', { user_id: user.id }, { sort: ['created_at', 'desc'] });
  ctx.send(200, {
    ok: true, data: rows.map((w) => {
      const v = w.variant_id ? S.findOne('product_variants', { id: w.variant_id }) : null;
      const p = v ? S.findOne('products', { id: v.product_id }) : null;
      const priceNow = v?.price_cny_minor ?? null;
      return {
        id: w.id, variantId: w.variant_id, title: p?.name || w.custom_title, image: p?.images?.[0] || null,
        color: v?.color, size: v?.size_eur, priceCnyMinor: priceNow, priceView: priceNow ? ctx.toView(priceNow, 'CNY', cur) : null,
        priceAtAddCnyMinor: w.price_cny_minor_at_add, currency: cur,
        dropped: priceNow && w.price_cny_minor_at_add ? priceNow < w.price_cny_minor_at_add : false,
        alertPriceDrop: w.alert_price_drop, alertRateDrop: w.alert_rate_drop, externalUrl: p?.external_url || w.external_url,
      };
    }),
  });
});
post('/api/favorites', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const variantId = ctx.body.variantId;
  if (variantId) {
    const v = S.findOne('product_variants', { id: variantId });
    if (!v) throw new HttpError(404, 'variant_not_found', 'Вариант не найден');
    if (S.findOne('wishlists', { user_id: user.id, variant_id: variantId })) throw new HttpError(409, 'already_in_favorites', 'Уже в избранном');
    S.insert('wishlists', { user_id: user.id, variant_id: variantId, price_cny_minor_at_add: v.price_cny_minor, alert_price_drop: true, alert_rate_drop: true });
  } else {
    S.insert('wishlists', { user_id: user.id, variant_id: null, custom_title: A.validators.str(ctx.body.title, 200) || 'Товар по ссылке', external_url: A.validators.str(ctx.body.url, 800), price_cny_minor_at_add: A.validators.int(ctx.body.priceCnyMinor, 0) || null, alert_price_drop: true, alert_rate_drop: true });
  }
  ctx.send(201, { ok: true });
});
del('/api/favorites/:id', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const row = S.findOne('wishlists', { id: ctx.params.id });
  if (!row || row.user_id !== user.id) throw new HttpError(404, 'not_found', 'Не найдено');
  S.remove('wishlists', { id: row.id });
  ctx.send(200, { ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// КАЛЬКУЛЯТОР
// ═══════════════════════════════════════════════════════════════════════════
function calcInputFrom(ctx) {
  const b = ctx.body || {};
  const rawItems = Array.isArray(b.items) && b.items.length ? b.items : [b];
  // единая нормализация полей: priceCnyMinor/price_cny_minor, weightKg/weight_kg, dimsCm/dims_cm
  const items = rawItems.map((it) => ({
    id: it.id ?? null,
    title: it.title || it.name || 'Товар',
    category_slug: it.category || it.category_slug || 'sneakers',
    color: it.color || null,
    size: it.size || null,
    qty: A.validators.int(it.qty, 1, 99) || 1,
    price_cny_minor: A.validators.int(it.priceCnyMinor ?? it.price_cny_minor, 0, 100_000_000) || 0,
    weight_kg: it.weightKg ?? it.weight_kg ?? it.weight ?? null,
    dims_cm: it.dimsCm ?? it.dims_cm ?? null,
    source: it.source || 'manual',
    external_url: it.externalUrl ?? it.external_url ?? null,
  }));
  return {
    items,
    destination: A.validators.destination(b.destination) || 'RU_MOW',
    packaging: ['none', 'basic', 'corners', 'crate'].includes(b.packaging) ? b.packaging : 'basic',
    insured: !!b.insured,
    packEachSeparately: !!b.packEachSeparately,
    currency: A.validators.currency(b.currency) || (ctx.user ? ctx.viewCurrency(ctx.user) : 'RUB'),
    tier: ctx.user ? tierForLifetimeValue(ctx.user.lifetime_value_minor || 0, ctx.cfg.loyaltyTiers).code : 'BASE',
    discountMinor: 0,
  };
}
post('/api/calc/quote', (ctx) => {
  const input = calcInputFrom(ctx);
  const q = buildQuote({ ...input, config: ctx.cfg });
  ctx.send(200, { ok: true, data: q, meta: { tariffs: ctx.cfg.tariffs, packaging: ctx.cfg.packaging, defaultWeightsKg: ctx.cfg.defaultWeightsKg, insuranceTiers: ctx.cfg.insuranceTiers } });
});
get('/api/calc/quick', (ctx) => {
  const q = ctx.query;
  const input = {
    items: [{ title: 'Расчёт', category: q.category || 'sneakers', price_cny_minor: A.validators.int(q.priceCny, 0, 100_000_000) || 0, qty: A.validators.int(q.qty, 1, 99) || 1, weight_kg: Number(q.weightKg) || undefined }],
    destination: A.validators.destination(q.destination) || 'RU_MOW',
    packaging: q.packaging || 'basic', insured: q.insured === '1', currency: A.validators.currency(q.currency) || (ctx.user ? ctx.viewCurrency(ctx.user) : 'RUB'),
    tier: ctx.user ? tierForLifetimeValue(ctx.user.lifetime_value_minor || 0, ctx.cfg.loyaltyTiers).code : 'BASE',
  };
  ctx.send(200, { ok: true, data: buildQuote({ ...input, config: ctx.cfg }) });
});

// ═══════════════════════════════════════════════════════════════════════════
// КОРЗИНА
// ═══════════════════════════════════════════════════════════════════════════
get('/api/cart', (ctx) => {
  const cart = activeCart(ctx);
  ctx.send(200, { ok: true, data: cartDto(cart, ctx, ctx.user) });
});

post('/api/cart/items', (ctx) => {
  const cart = activeCart(ctx);
  const data = normalizeCartItemInput(ctx.body, ctx);
  const existing = S.findOne('cart_items', { cart_id: cart.id, variant_id: data.variant_id || '__none__', color: data.color || '', size: data.size || '' });
  if (existing && data.variant_id) {
    S.updateById('cart_items', existing.id, { qty: Math.min(99, existing.qty + data.qty) });
  } else {
    S.insert('cart_items', { cart_id: cart.id, ...data });
  }
  S.audit(ctx.user?.id ?? null, 'cart.add', 'cart', cart.id, null, { title: data.title });
  ctx.send(201, { ok: true, data: cartDto(S.findOne('carts', { id: cart.id }), ctx, ctx.user) });
});

patch('/api/cart/items/:id', (ctx) => {
  const cart = activeCart(ctx, { create: false });
  const item = S.findOne('cart_items', { id: ctx.params.id });
  if (!item || item.cart_id !== cart?.id) throw new HttpError(404, 'item_not_found', 'Позиция не найдена');
  const patch = {};
  if (ctx.body.qty !== undefined) patch.qty = A.validators.int(ctx.body.qty, 1, 99) || item.qty;
  for (const [k, f] of [['color', 'color'], ['size', 'size'], ['notes', 'notes'], ['category', 'category_slug']]) if (ctx.body[k] !== undefined) patch[f] = A.validators.str(ctx.body[k], 200);
  if (ctx.body.weightKg !== undefined) patch.weight_kg = Number(ctx.body.weightKg) || item.weight_kg;
  if (ctx.body.priceCnyMinor !== undefined && item.source !== 'catalog') patch.price_cny_minor = A.validators.int(ctx.body.priceCnyMinor, 0) ?? item.price_cny_minor;
  if (ctx.body.dimsCm !== undefined) patch.dims_cm = ctx.body.dimsCm;
  S.updateById('cart_items', item.id, patch);
  ctx.send(200, { ok: true, data: cartDto(cart, ctx, ctx.user) });
});

del('/api/cart/items/:id', (ctx) => {
  const cart = activeCart(ctx, { create: false });
  const item = S.findOne('cart_items', { id: ctx.params.id });
  if (!item || item.cart_id !== cart?.id) throw new HttpError(404, 'item_not_found', 'Позиция не найдена');
  S.remove('cart_items', { id: item.id });
  ctx.send(200, { ok: true, data: cartDto(cart, ctx, ctx.user) });
});

patch('/api/cart', (ctx) => {
  const cart = activeCart(ctx);
  const patch = {};
  if (ctx.body.destination) patch.destination = A.validators.destination(ctx.body.destination) || cart.destination;
  if (ctx.body.packaging && ['none', 'basic', 'corners', 'crate'].includes(ctx.body.packaging)) patch.packaging = ctx.body.packaging;
  if (ctx.body.insurance !== undefined) patch.insurance = ctx.body.insurance === 'standard' ? 'standard' : 'none';
  if (ctx.body.packEachSeparately !== undefined) patch.pack_each_separately = !!ctx.body.packEachSeparately;
  if (ctx.body.currency) patch.currency_view = A.validators.currency(ctx.body.currency) || cart.currency_view;
  S.updateById('carts', cart.id, patch);
  ctx.send(200, { ok: true, data: cartDto(S.findOne('carts', { id: cart.id }), ctx, ctx.user) });
});

del('/api/cart', (ctx) => {
  const cart = activeCart(ctx, { create: false });
  if (cart) { S.remove('cart_items', { cart_id: cart.id }); S.updateById('carts', cart.id, { type: 'archived' }); }
  ctx.send(200, { ok: true });
});

post('/api/cart/share', (ctx) => {
  const cart = activeCart(ctx);
  const token = cart.share_token || randomToken(10);
  S.updateById('carts', cart.id, { share_token: token, share_enabled: ctx.body.enabled !== false });
  ctx.send(200, { ok: true, data: { shareToken: token, shareUrl: `${baseUrlOf(ctx.req)}/#/cart/s/${token}`, enabled: ctx.body.enabled !== false } });
});

get('/api/cart/shared/:token', (ctx) => {
  const cart = S.findOne('carts', { share_token: ctx.params.token, share_enabled: true });
  if (!cart) throw new HttpError(404, 'cart_not_found', 'Общая корзина не найдена или доступ закрыт');
  const dto = cartDto(cart, ctx, ctx.user);
  dto.readOnly = !(ctx.user && ctx.user.id === cart.user_id);
  dto.owner = cart.user_id ? (() => { const u = S.findOne('users', { id: cart.user_id }); return { publicUid: u?.public_uid, name: `${u?.first_name || ''} ${u?.last_name || ''}`.trim() }; })() : null;
  ctx.send(200, { ok: true, data: dto });
});

/** Друг может скопировать общую корзину себе. */
post('/api/cart/shared/:token/import', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const shared = S.findOne('carts', { share_token: ctx.params.token, share_enabled: true });
  if (!shared) throw new HttpError(404, 'cart_not_found', 'Корзина не найдена');
  const mine = activeCart(ctx);
  const items = S.find('cart_items', { cart_id: shared.id });
  for (const it of items) S.insert('cart_items', { ...it, id: undefined, cart_id: mine.id, created_at: new Date().toISOString() });
  S.updateById('carts', mine.id, { destination: shared.destination, packaging: shared.packaging, insurance: shared.insurance });
  ctx.send(200, { ok: true, data: cartDto(S.findOne('carts', { id: mine.id }), ctx, user) });
});

// ═══════════════════════════════════════════════════════════════════════════
// ЗАКАЗЫ
// ═══════════════════════════════════════════════════════════════════════════
post('/api/orders', (ctx) => {
  const user = A.requireAuth(ctx.req);
  if (user.is_blacklisted) throw new HttpError(403, 'blacklisted', 'Аккаунт заблокирован');
  const cart = S.findOne('carts', { id: ctx.body.cartId }) || activeCart(ctx, { create: false });
  let items = cart ? S.find('cart_items', { cart_id: cart.id }) : [];
  // быстрая покупка без корзины
  if (!items.length && Array.isArray(ctx.body.items) && ctx.body.items.length) {
    items = ctx.body.items.map((i) => normalizeCartItemInput(i, ctx));
  }
  if (!items.length) throw new HttpError(400, 'empty_cart', 'Корзина пуста');

  const settings = S.findOne('user_settings', { user_id: user.id }) || {};
  const destination = A.validators.destination(ctx.body.destination) || cart?.destination || settings.default_destination || 'RU_MOW';
  const currency = A.validators.currency(ctx.body.currency) || settings.currency || 'RUB';
  const tier = tierForLifetimeValue(user.lifetime_value_minor || 0, ctx.cfg.loyaltyTiers);
  const quote = buildQuote({
    items, destination, packaging: cart?.packaging || 'basic', insured: (cart?.insurance || 'none') === 'standard',
    packEachSeparately: !!cart?.pack_each_separately, currency, tier: tier.code, config: ctx.cfg,
  });

  const orderNo = S.nextNumber('orders', 'order_no', `PV-${new Date().getFullYear()}-`, 6);
  const paymentPlan = 'full';
  const deliveryType = ['cdek_pvz', 'cdek_courier', 'pickup_hub'].includes(ctx.body.deliveryType) ? ctx.body.deliveryType : 'cdek_pvz';
  
  const installments = [];
  const totalOrderMinor = quote.breakdown.total;

  const order = S.insert('orders', {
    order_no: orderNo, user_id: user.id, cart_id: cart?.id || null, status: 'awaiting_payment', destination,
    recipient_name: ctx.body.recipientName || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
    recipient_phone: ctx.body.recipientPhone || user.phone,
    recipient_address: ctx.body.recipientAddress || S.findOne('user_addresses', { user_id: user.id })?.address_line || null,
    snapshot: { rates: ctx.cfg.rates, tariff_usd_per_kg: quote.tariffUsdPerKg, commission_rate: quote.commissionRate, packaging: quote.packaging, insurance: quote.insurance, weight: quote.weight, tiers: ctx.cfg.loyaltyTiers, quote },
    currency_view: currency,
    payment_plan: paymentPlan,
    installments,
    delivery_type: deliveryType,
    cdek_pvz: ctx.body.cdekPvz || null,
    goods_minor: quote.breakdown.goods, commission_minor: quote.breakdown.commission, shipping_minor: quote.breakdown.shipping,
    packaging_minor: quote.breakdown.packaging, insurance_minor: quote.breakdown.insurance, unloading_minor: quote.breakdown.unloading,
    discount_minor: 0, total_minor: quote.breakdown.total, paid_minor: 0, goods_cny_minor: quote.goodsCnyMinor,
    cogs_cny_minor: 0, cargo_usd_minor: 0, extra_usd_minor: 0, acquiring_fee_minor: 0,
    weight_est_kg: quote.weight.estKg, weight_fact_kg: null, volume_m3: quote.weight.volumeM3, places_count: quote.packaging.places,
    payment_status: 'pending', payment_method: null, loyalty_tier_at_order: tier.code, commission_rate_at_order: quote.commissionRate,
    referral_code_used: extractReferralCode(ctx.body.promo) || null, promo_code: A.validators.str(ctx.body.promo, 40),
    tracking_number: null, carrier: null, manager_id: null, warehouse_id: null, eta_from: null, eta_to: null,
    comment: A.validators.str(ctx.body.comment, 1000),
  });
  items.forEach((it, idx) => {
    const line = quote.lines[idx] || {};
    S.insert('order_items', {
      order_id: order.id, cart_item_id: it.id || null, variant_id: it.variant_id || null, product_id: it.product_id || null,
      title: it.title, brand: it.brand_hint || null, color: it.color, size: it.size, image_url: it.image_url,
      external_url: it.external_url, price_cny_minor: it.price_cny_minor, qty: it.qty, weight_kg: it.weight_kg,
      dims_cm: it.dims_cm || it.dims || null, category_slug: it.category_slug || it.category || null,
      weight_fact_kg: null, line_goods_minor: line.goods || 0, line_commission_minor: line.commission || 0,
      line_shipping_minor: line.shipping || 0, line_total_all_minor: line.lineTotal || 0, status: 'awaiting_payment', legit_check: null, notes: it.notes,
    });
  });
  S.insert('order_status_history', { order_id: order.id, from_status: null, to_status: 'awaiting_payment', changed_by: user.id, comment: 'Заказ создан' });
  if (cart) { S.remove('cart_items', { cart_id: cart.id }); S.updateById('carts', cart.id, { type: 'archived' }); }
  S.audit(user.id, 'order.create', 'order', order.id, null, { orderNo, total: quote.breakdown.total });

  const result = S.findOne('orders', { id: order.id });
  if (ctx.body.payNow && ['card', 'sbp', 'wallet', 'bonus', 'combined'].includes(ctx.body.method)) {
    const isSplit = paymentPlan !== 'full';
    const firstAmount = isSplit && installments.length ? installments[0].amount_minor : null;
    const paid = payOrder(result, ctx, { method: ctx.body.method, amountOverride: firstAmount, installmentIndex: 0 });
    return ctx.send(201, { ok: true, data: orderDto(paid, ctx) });
  }
  ctx.send(201, { ok: true, data: orderDto(result, ctx) });
});

get('/api/orders', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const rows = S.find('orders', { user_id: user.id }, { sort: ['created_at', 'desc'], limit: 100 });
  ctx.send(200, { ok: true, data: rows.map((o) => orderDto(o, ctx, { full: false })) });
});

get('/api/orders/:id', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const order = S.findOne('orders', { id: ctx.params.id }) || S.findOne('orders', { order_no: String(ctx.params.id).toUpperCase() });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  if (order.user_id !== user.id && !A.can(user, 'orders.read')) throw A.forbidden('Нет доступа к заказу');
  const dto = orderDto(order, ctx);
  if (A.isWarehouseOnly(user)) return ctx.send(200, { ok: true, data: A.sanitizeForWarehouse(dto) });
  ctx.send(200, { ok: true, data: dto });
});

post('/api/orders/:id/pay', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const order = S.findOne('orders', { id: ctx.params.id }) || S.findOne('orders', { order_no: String(ctx.params.id).toUpperCase() });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  if (order.user_id !== user.id && !A.can(user, 'orders.write')) throw A.forbidden();
  if (order.payment_status === 'succeeded') throw new HttpError(409, 'already_paid', 'Заказ уже оплачен');

  const isSplit = order.payment_plan && order.payment_plan !== 'full' && order.installments?.length;
  let installmentIndex = 0;
  let amountToPay = null;
  if (isSplit) {
    installmentIndex = order.installments.findIndex((it) => it.status !== 'paid');
    if (installmentIndex >= 0) {
      amountToPay = order.installments[installmentIndex].amount_minor;
    }
  }

  const method = ['card', 'sbp', 'wallet', 'bonus', 'combined'].includes(ctx.body.method) ? ctx.body.method : 'card';
  if (method !== 'card' && method !== 'sbp') {
    const w = S.walletOf(user.id);
    const needAmount = amountToPay ?? (order.total_minor - (order.paid_minor || 0));
    const totalRub = order.currency_view === 'RUB' ? needAmount : convertMinor(needAmount, order.currency_view, 'RUB', ctx.rates);
    const plan = planPayment(w, totalRub);
    if (method === 'wallet' && plan.fromBonus + plan.fromMain < totalRub && !ctx.body.allowCard) {
      throw new HttpError(400, 'insufficient_funds', 'Недостаточно средств на балансе', { plan });
    }
  }
  const paid = payOrder(order, ctx, { method, amountOverride: amountToPay, installmentIndex: Math.max(0, installmentIndex) });
  ctx.send(200, { ok: true, data: orderDto(paid, ctx) });
});

/** Предпросмотр распределения оплаты (для UI комбинированной оплаты). */
post('/api/orders/:id/payment-plan', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const order = S.findOne('orders', { id: ctx.params.id });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  const w = S.walletOf(user.id);
  const cur = ctx.viewCurrency(user);
  const totalRub = order.currency_view === 'RUB' ? order.total_minor : convertMinor(order.total_minor, order.currency_view, 'RUB', ctx.rates);
  const plan = planPayment(w, totalRub);
  ctx.send(200, {
    ok: true, data: {
      ...plan, currency: cur, totalRubMinor: totalRub, orderCurrency: order.currency_view,
      fromBonusView: ctx.toView(plan.fromBonus, 'RUB', cur),
      fromMainView: ctx.toView(plan.fromMain, 'RUB', cur),
      fromCardView: ctx.toView(plan.fromCard, 'RUB', cur),
      totalView: ctx.toView(plan.need, 'RUB', cur),
    },
  });
});

post('/api/orders/:id/cancel', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const order = S.findOne('orders', { id: ctx.params.id });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  if (order.user_id !== user.id && !A.can(user, 'orders.write')) throw A.forbidden();
  if (!CANCELLABLE.has(order.status)) throw new HttpError(409, 'not_cancellable', 'Отмена невозможна: товар уже отправлен из Китая');
  const cancelled = pushStatus(order, 'cancelled', user.id, A.validators.str(ctx.body.reason, 500) || 'Отмена клиентом');
  if (order.payment_status === 'succeeded') refundOrder(cancelled, ctx, { full: order.status === 'paid', to: 'wallet_main', reason: 'Отмена заказа' });
  ctx.send(200, { ok: true, data: orderDto(S.findOne('orders', { id: order.id }), ctx) });
});

function refundOrder(order, ctx, { full = true, to = 'wallet_main', reason = '' }) {
  const user = S.findOne('users', { id: order.user_id });
  const payments = S.find('payments', { order_id: order.id, status: 'succeeded' });
  const walletPaid = payments.filter((p) => p.provider === 'wallet').reduce((a, p) => a + Number(p.amount_minor || 0), 0);
  const cardPaid = payments.filter((p) => p.provider !== 'wallet').reduce((a, p) => a + Number(p.amount_minor || 0), 0);
  const refundTotal = full ? order.total_minor : Math.round(order.total_minor * 0.5);
  // пропорция возврата: сначала на кошелёк, затем на карту (в демо — всё на кошелёк)
  const toWallet = to === 'card' ? 0 : refundTotal;
  let toWalletRub = 0;
  if (toWallet > 0) {
    toWalletRub = convertMinor(toWallet, order.currency_view, 'RUB', ctx.rates);
    S.postWalletTx(user.id, {
      wallet_type: to === 'wallet_bonus' ? 'bonus' : 'main', type: TX_TYPES.REFUND, amount_minor: toWalletRub,
      currency: 'RUB', ref_type: 'order', ref_id: order.id, comment: `Возврат по заказу ${order.order_no}: ${reason}`,
      idempotency_key: `refund:${order.id}:${Date.now()}`, created_by: ctx.user?.id ?? null,
    });
  }
  void walletPaid;
  S.updateById('orders', order.id, { payment_status: 'refunded' });
  for (const p of payments) S.updateById('payments', p.id, { status: 'refunded' });
  S.notify(user.id, 'refund', { title: `Возврат по заказу ${order.order_no}`, body: `${reason}. Сумма возвращена на баланс.` , payload: { orderId: order.id, amount: toWallet } });
  telegramNotify(user.id, `↩️ Возврат по заказу ${order.order_no}: ${reason}`);
  S.audit(ctx.user?.id ?? null, 'order.refund', 'order', order.id, null, { refundTotal, to, reason });
  // clawback реферальной награды при полном возврате первого заказа
  const binding = S.findOne('referrals', { first_order_id: order.id, status: 'rewarded' });
  if (binding && full && S.getSetting('referral.config', {}).clawback_on_refund) {
    const clawbackAmount = Math.min(Number(binding.reward_minor || 0), S.walletOf(binding.referrer_id).balance_bonus_minor);
    if (clawbackAmount > 0) {
      S.postWalletTx(binding.referrer_id, { wallet_type: 'bonus', type: TX_TYPES.CLAWBACK, amount_minor: -clawbackAmount, currency: 'RUB', ref_type: 'referral', ref_id: binding.id, comment: `Отзыв награды: заказ ${order.order_no} возвращён`, idempotency_key: `clawback:${binding.id}:${order.id}` });
    }
    S.updateById('referrals', binding.id, { status: 'clawback' });
  }
  // корректировка накопленной суммы лояльности
  const rubMinor = convertMinor(refundTotal, order.currency_view, 'RUB', ctx.rates);
  const nextLtv = Math.max(0, Number(user.lifetime_value_minor || 0) - rubMinor);
  const nextTier = tierForLifetimeValue(nextLtv, ctx.cfg.loyaltyTiers);
  S.updateById('users', user.id, { lifetime_value_minor: nextLtv, loyalty_tier: nextTier.code });
  return { toWallet, toWalletRub, cardPaid };
}

// ── споры ──────────────────────────────────────────────────────────────────
post('/api/orders/:id/disputes', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const order = S.findOne('orders', { id: ctx.params.id });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  if (order.user_id !== user.id) throw A.forbidden();
  if (!['paid', 'purchasing', 'purchased', 'photo_report', 'legit_check_failed', 'packed'].includes(order.status)) {
    throw new HttpError(409, 'too_late', 'Возврат возможен только до отправки из Китая');
  }
  const reason = ['legit_check_failed', 'defect', 'wrong_size', 'wrong_color', 'cancel_before_ship', 'other'].includes(ctx.body.reason) ? ctx.body.reason : 'other';
  const dispute = S.insert('disputes', {
    order_id: order.id, order_item_id: ctx.body.itemId || null, user_id: user.id, reason, status: 'open',
    description: A.validators.str(ctx.body.description, 2000), attachments: ctx.body.attachments || [],
    resolution: null, refund_minor: 0, refund_to: 'wallet_main', handled_by: null, handled_at: null,
  });
  S.notify(user.id, 'dispute_created', { title: `Заявка на возврат ${order.order_no}`, body: 'Менеджер свяжется с вами в течение 24 часов' });
  S.insert('tasks', { title: `Спор по заказу ${order.order_no}`, description: dispute.description, assignee_id: null, created_by: user.id, order_id: order.id, status: 'todo', priority: reason === 'legit_check_failed' ? 'urgent' : 'high' });
  if (reason === 'legit_check_failed' && order.status === 'legit_check_failed') {
    refundOrder(S.findOne('orders', { id: order.id }), ctx, { full: true, to: 'wallet_main', reason: 'Не прошёл Legit Check (100% возврат на баланс)' });
    S.updateById('disputes', dispute.id, { status: 'refunded_full', resolution: 'Legit Check failed → 100% возврат на баланс', refund_minor: order.total_minor, handled_at: new Date().toISOString() });
    S.updateById('orders', order.id, { status: 'refunded' });
    S.insert('order_status_history', { order_id: order.id, from_status: 'legit_check_failed', to_status: 'refunded', changed_by: user.id, comment: '100% возврат на баланс' });
  }
  ctx.send(201, { ok: true, data: orderDto(S.findOne('orders', { id: order.id }), ctx) });
});

// ═══════════════════════════════════════════════════════════════════════════
// TIKTOK
// ═══════════════════════════════════════════════════════════════════════════
get('/api/tiktok', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const cfgT = S.getSetting('tiktok.config', DEFAULT_TIKTOK_CONFIG);
  const cur = ctx.viewCurrency(user);
  const rows = S.find('tiktok_submissions', { user_id: user.id }, { sort: ['created_at', 'desc'] });
  ctx.send(200, {
    ok: true, data: {
      config: { ...cfgT, reward_per_1000_view: ctx.toView(cfgT.reward_per_1000_views_rub_minor, 'RUB', cur) },
      currency: cur,
      totalEarnedView: ctx.toView(rows.reduce((a, r) => a + Number(r.reward_minor || 0), 0), 'RUB', cur),
      submissions: rows.map((r) => ({
        id: r.id, url: r.url, authorHandle: r.author_handle, viewsDeclared: r.views_declared, viewsVerified: r.views_verified,
        status: r.status, rewardMinor: r.reward_minor, rewardView: ctx.toView(r.reward_minor || 0, r.reward_currency || 'RUB', cur),
        rejectReason: r.reject_reason, reviewedAt: r.reviewed_at, createdAt: r.created_at, hashtagFound: r.hashtag_found, linkFound: r.link_found,
      })),
    },
  });
});

post('/api/tiktok/submissions', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const cfgT = S.getSetting('tiktok.config', DEFAULT_TIKTOK_CONFIG);
  const parsed = parseTikTokUrl(ctx.body.url);
  const existing = parsed.ok ? S.findOne('tiktok_submissions', { video_id: parsed.videoId }) : null;
  const today = new Date().toISOString().slice(0, 10);
  const submissionsToday = S.find('tiktok_submissions', { user_id: user.id }).filter((s) => String(s.created_at).slice(0, 10) === today).length;
  const requirements = checkRequirements({ description: ctx.body.description || '', hashtags: ctx.body.hashtags || [], linkInBio: !!ctx.body.linkInBio }, cfgT);
  const v = validateSubmission({ parsed, existingByVideoId: existing, submissionsToday, requirements, config: cfgT });
  if (!v.ok) throw new HttpError(400, 'invalid_submission', v.errors.join('. '), { errors: v.errors });
  const row = S.insert('tiktok_submissions', {
    user_id: user.id, url: parsed.normalizedUrl, video_id: parsed.videoId, author_handle: parsed.authorHandle,
    hashtag_found: requirements.hashtagFound, link_found: requirements.linkFound,
    views_declared: A.validators.int(ctx.body.views, 0, 100_000_000) || null, views_verified: null,
    status: 'pending', reward_minor: 0, reward_currency: 'RUB', reviewer_id: null, reviewed_at: null,
    reject_reason: null, order_ref: ctx.body.orderId || null, screenshot_url: A.validators.str(ctx.body.screenshotUrl, 500),
  });
  S.insert('tasks', { title: `Модерация TikTok: ${parsed.authorHandle || 'видео'}`, description: parsed.normalizedUrl, assignee_id: null, created_by: user.id, order_id: null, status: 'todo', priority: 'normal' });
  S.notify(user.id, 'tiktok_submitted', { title: 'Заявка отправлена на модерацию', body: 'Обычно проверяем в течение 24 часов' });
  ctx.send(201, { ok: true, data: { id: row.id, status: row.status, requirements } });
});

// ═══════════════════════════════════════════════════════════════════════════
// РЕФЕРАЛЫ
// ═══════════════════════════════════════════════════════════════════════════
get('/api/referrals', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const cur = ctx.viewCurrency(user);
  const rows = S.find('referrals', { referrer_id: user.id }, { sort: ['created_at', 'desc'] });
  const cfgR = S.getSetting('referral.config', {});
  const friends = rows.map((r) => {
    const u = S.findOne('users', { id: r.referee_id });
    const orders = S.find('orders', { user_id: r.referee_id });
    return {
      id: r.id, publicUid: u?.public_uid, name: u ? `${u.first_name || ''} ${u.last_name?.[0] || ''}.`.trim() : '—',
      status: r.status, registeredAt: r.created_at, rewardedAt: r.rewarded_at,
      rewardView: ctx.toView(r.reward_minor || 0, 'RUB', cur),
      ordersCount: orders.length, paidOrders: orders.filter((o) => o.payment_status === 'succeeded').length,
      totalSpentView: ctx.toView(orders.filter((o) => o.payment_status === 'succeeded').reduce((a, o) => a + convertMinor(o.total_minor, o.currency_view, 'RUB', ctx.rates), 0), 'RUB', cur),
    };
  });
  ctx.send(200, {
    ok: true, data: {
      code: user.referral_code, link: referralLink(baseUrlOf(ctx.req), user.referral_code),
      telegramLink: `https://t.me/poizonvanart_bot?start=${user.referral_code}`,
      config: { ...cfgR, rewardView: ctx.toView(cfgR.fallback_fixed_rub_minor || 0, 'RUB', cur), inviteeBonusView: ctx.toView(cfgR.invitee_bonus_rub_minor || 0, 'RUB', cur), capView: ctx.toView(cfgR.cap_rub_minor || 0, 'RUB', cur) },
      currency: cur, stats: referralStats(rows), friends,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ЧАТ ПОДДЕРЖКИ
// ═══════════════════════════════════════════════════════════════════════════
get('/api/chat', (ctx) => {
  const user = A.requireAuth(ctx.req);
  let threads;
  if (A.can(user, 'chat.write') && ctx.query.scope === 'all') {
    threads = S.find('chat_threads', {}, { sort: ['last_message_at', 'desc'], limit: 50 });
  } else {
    threads = S.find('chat_threads', { user_id: user.id }, { sort: ['last_message_at', 'desc'] });
  }
  ctx.send(200, {
    ok: true, data: threads.map((t) => {
      const u = S.findOne('users', { id: t.user_id });
      const msgs = S.find('chat_messages', { thread_id: t.id }, { sort: ['created_at', 'asc'], limit: 200 });
      return {
        id: t.id, subject: t.subject, status: t.status, orderId: t.order_id,
        user: u ? { id: u.id, publicUid: u.public_uid, name: `${u.first_name || ''} ${u.last_name || ''}`.trim() } : null,
        messages: msgs.map((m) => ({ id: m.id, authorType: m.author_type, authorId: m.author_id, body: m.body, at: m.created_at, read: m.is_read })),
        lastMessageAt: t.last_message_at,
      };
    }),
  });
});

post('/api/chat', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const rawText = ctx.body.body ?? ctx.body.text ?? ctx.body.message ?? '';
  const body = A.validators.str(rawText, 4000);
  if (!body) throw new HttpError(400, 'empty_message', 'Пустое сообщение');
  let thread = ctx.body.threadId ? S.findOne('chat_threads', { id: ctx.body.threadId }) : null;
  if (thread && thread.user_id !== user.id && !A.can(user, 'chat.write')) throw A.forbidden();
  if (!thread) {
    thread = S.insert('chat_threads', { user_id: user.id, order_id: ctx.body.orderId || null, status: 'open', subject: A.validators.str(ctx.body.subject, 200) || 'Обращение в поддержку', last_message_at: new Date().toISOString() });
  }
  const msg = S.insert('chat_messages', { thread_id: thread.id, author_id: user.id, author_type: A.can(user, 'chat.write') && thread.user_id !== user.id ? 'admin' : 'user', body, attachments: [], is_read: false });
  S.updateById('chat_threads', thread.id, { last_message_at: msg.created_at, status: msg.author_type === 'admin' ? 'pending_user' : 'open' });
  if (msg.author_type === 'user') {
    for (const admin of S.find('users', {}).filter((u) => A.can(u, 'chat.write') && u.id !== user.id)) {
      S.notify(admin.id, 'chat_message', { title: `Новое сообщение от ${user.public_uid}`, body: body.slice(0, 120), payload: { threadId: thread.id } });
    }
  } else {
    S.notify(thread.user_id, 'chat_message', { title: 'Ответ поддержки', body: body.slice(0, 120), payload: { threadId: thread.id } });
    telegramNotify(thread.user_id, `💬 Ответ поддержки: ${body.slice(0, 160)}`);
  }
  ctx.send(201, { ok: true, data: { threadId: thread.id, message: { id: msg.id, authorType: msg.author_type, body, at: msg.created_at } } });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════════════
function requirePerm(ctx, perm) {
  const user = A.requireAuth(ctx.req);
  A.requirePermission(user, perm);
  return user;
}

get('/api/admin/overview', (ctx) => {
  const user = requirePerm(ctx, 'orders.read');
  const orders = S.find('orders', {});
  const paid = orders.filter((o) => o.payment_status === 'succeeded');
  const users = S.find('users', { role_code: 'client' });
  const canFinance = A.can(user, 'finance.read');
  const pnl = canFinance ? aggregatePnl(paid.map((o) => ({ ...o, revenue_minor: o.paid_minor, revenue_currency: o.currency_view })), ctx.cfg, 'RUB') : null;
  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  ctx.send(200, {
    ok: true, data: {
      kpi: {
        ordersTotal: orders.length, ordersPaid: paid.length, clientsTotal: users.length,
        awaitingPayment: byStatus.awaiting_payment || 0, inWork: ['paid', 'purchasing', 'purchased', 'photo_report', 'packed'].reduce((a, s) => a + (byStatus[s] || 0), 0),
        inTransit: ['sent_to_ru', 'in_transit', 'customs'].reduce((a, s) => a + (byStatus[s] || 0), 0),
        delivered: byStatus.delivered || 0,
        avgCheckRub: canFinance && paid.length ? Math.round(paid.reduce((a, o) => a + convertMinor(o.total_minor, o.currency_view, 'RUB', ctx.rates), 0) / paid.length) : null,
      },
      byStatus,
      pnl: pnl ? { revenue: pnl.totals.revenue, gross: pnl.totals.gross, net: pnl.totals.net, marginPct: pnl.totals.marginPct } : null,
      pendingTiktok: S.find('tiktok_submissions', { status: 'pending' }).length,
      openDisputes: S.find('disputes', { status: { $in: ['open', 'in_review'] } }).length,
      openTasks: S.find('tasks', { status: { $in: ['todo', 'in_progress'] } }).length,
      warehouseMode: A.isWarehouseOnly(user),
    },
  });
});

get('/api/admin/orders', (ctx) => {
  const user = requirePerm(ctx, 'orders.read');
  const { status, q, destination, from, to } = ctx.query;
  let rows = S.find('orders', {}, { sort: ['created_at', 'desc'] });
  if (status) rows = rows.filter((o) => o.status === status);
  if (destination) rows = rows.filter((o) => o.destination === destination);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((o) => [o.order_no, o.tracking_number, o.recipient_name, o.recipient_phone, S.findOne('users', { id: o.user_id })?.public_uid].filter(Boolean).join(' ').toLowerCase().includes(s));
  }
  if (from) rows = rows.filter((o) => o.created_at >= from);
  if (to) rows = rows.filter((o) => o.created_at <= to);
  const wh = A.isWarehouseOnly(user);
  ctx.send(200, { ok: true, data: rows.map((o) => { const d = orderDto(o, ctx, { full: false }); return wh ? A.sanitizeForWarehouse(d) : d; }) });
});

// ВАЖНО: литеральный маршрут экспорта регистрируется ДО '/api/admin/orders/:id',
// иначе ':id' перехватывает 'export.csv' и запрос падает с «Заказ не найден».
get('/api/admin/orders/export.csv', (ctx) => {
  const user = requirePerm(ctx, 'export.data');
  const rows = S.find('orders', {}, { sort: ['created_at', 'desc'] });
  const csv = toCsv(rows.map((o) => {
    const u = S.findOne('users', { id: o.user_id });
    return { ...o, public_uid: u?.public_uid, client: `${u?.first_name || ''} ${u?.last_name || ''}`.trim() };
  }), [
    { key: 'order_no', title: 'Номер заказа' }, { key: 'public_uid', title: 'User ID' }, { key: 'client', title: 'Клиент' },
    { key: 'status', title: 'Статус' }, { key: 'destination', title: 'Направление' },
    { key: 'currency_view', title: 'Валюта' }, { key: 'total_minor', title: 'Сумма (минор)' },
    { key: 'goods_cny_minor', title: 'Товар CNY (минор)' }, { key: 'weight_est_kg', title: 'Вес расч., кг' }, { key: 'weight_fact_kg', title: 'Вес факт., кг' },
    { key: 'tracking_number', title: 'Трек-номер' }, { key: 'carrier', title: 'Перевозчик' },
    { key: 'payment_status', title: 'Оплата' }, { key: 'payment_method', title: 'Метод оплаты' },
    { key: 'created_at', title: 'Создан' }, { key: 'paid_at', title: 'Оплачен' }, { key: 'delivered_at', title: 'Выдан' },
  ]);
  S.audit(user.id, 'export.orders', 'order', null, null, { count: rows.length });
  text(ctx.res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="poizonvanart-orders-${new Date().toISOString().slice(0, 10)}.csv"` });
});

get('/api/admin/orders/:id', (ctx) => {
  const user = requirePerm(ctx, 'orders.read');
  const order = S.findOne('orders', { id: ctx.params.id });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  const dto = orderDto(order, ctx);
  ctx.send(200, { ok: true, data: A.isWarehouseOnly(user) ? A.sanitizeForWarehouse(dto) : dto });
});

post('/api/admin/orders/bulk-status', (ctx) => {
  const user = requirePerm(ctx, 'orders.status');
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : [];
  const to = ctx.body.status;
  if (!ids.length || !to) throw new HttpError(400, 'invalid_input', 'Нужны ids и status');
  const results = { ok: [], failed: [] };
  for (const id of ids) {
    const o = S.findOne('orders', { id });
    if (!o) { results.failed.push({ id, error: 'not_found' }); continue; }
    if (A.isWarehouseOnly(user) && !['purchasing', 'purchased', 'photo_report', 'packed', 'sent_to_ru'].includes(to)) {
      results.failed.push({ id, error: 'warehouse_mode_restricted' }); continue;
    }
    try { pushStatus(o, to, user.id, ctx.body.comment || 'Массовое изменение'); results.ok.push({ id, orderNo: o.order_no, status: to }); }
    catch (e) { results.failed.push({ id, orderNo: o.order_no, error: e.message }); }
  }
  ctx.send(200, { ok: true, data: results });
});

post('/api/admin/orders/:id/tracking', (ctx) => {
  const user = requirePerm(ctx, 'orders.status');
  const order = S.findOne('orders', { id: ctx.params.id });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  const tracking = A.validators.str(ctx.body.trackingNumber, 80);
  if (!tracking) throw new HttpError(400, 'invalid_tracking', 'Укажите трек-номер');
  const carrier = A.validators.str(ctx.body.carrier, 60) || order.carrier || 'VanCargo';
  S.updateById('orders', order.id, { tracking_number: tracking, carrier });
  let ship = S.findOne('shipments', { order_id: order.id });
  if (ship) S.updateById('shipments', ship.id, { tracking_number: tracking, carrier });
  else ship = S.insert('shipments', { order_id: order.id, tracking_number: tracking, carrier, destination: order.destination, weight_kg: order.weight_fact_kg || order.weight_est_kg, places_count: order.places_count, status: order.status, shipped_at: new Date().toISOString(), tracking_events: [] });
  S.notify(order.user_id, 'tracking', { title: `Трек-номер ${order.order_no}`, body: `${carrier}: ${tracking}`, payload: { orderId: order.id, tracking } });
  telegramNotify(order.user_id, `📦 Трек-номер заказа ${order.order_no}: ${carrier} ${tracking}`);
  S.audit(user.id, 'order.tracking', 'order', order.id, null, { tracking, carrier });
  ctx.send(200, { ok: true, data: orderDto(S.findOne('orders', { id: order.id }), ctx, { full: false }) });
});

post('/api/admin/labels', (ctx) => {
  const user = requirePerm(ctx, 'stickers.print');
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : [];
  const labels = ids.map((id) => {
    const o = S.findOne('orders', { id });
    if (!o) return null;
    const u = S.findOne('users', { id: o.user_id });
    const payload = {
      orderNo: o.order_no, userPublicUid: u?.public_uid, destination: o.destination,
      recipient: o.recipient_name, phone: o.recipient_phone, address: o.recipient_address,
      places: o.places_count, weightKg: o.weight_fact_kg || o.weight_est_kg,
      barcode: `PV${o.order_no.replace(/\D/g, '')}${u?.public_uid.replace(/\D/g, '')}`,
    };
    S.insert('labels', { order_id: o.id, code: payload.barcode, payload, printed_by: user.id, printed_at: new Date().toISOString() });
    return payload;
  }).filter(Boolean);
  ctx.send(200, { ok: true, data: labels });
});

// ── складской режим ────────────────────────────────────────────────────────
get('/api/admin/warehouse/queue', (ctx) => {
  requirePerm(ctx, 'orders.read');
  const queue = ['paid', 'purchasing', 'purchased', 'photo_report', 'packed'];
  const rows = S.find('orders', { status: { $in: queue } }, { sort: ['paid_at', 'asc'] });
  ctx.send(200, {
    ok: true, data: rows.map((o) => {
      const u = S.findOne('users', { id: o.user_id });
      return {
        id: o.id, orderNo: o.order_no, userPublicUid: u?.public_uid, status: o.status, statusRu: STATUS_RU[o.status],
        destination: o.destination, weightEstKg: o.weight_est_kg, weightFactKg: o.weight_fact_kg,
        places: o.places_count, paidAt: o.paid_at,
        photosCount: S.find('order_photos', { order_id: o.id }).length,
        items: S.find('order_items', { order_id: o.id }).map((i) => ({ id: i.id, title: i.title, color: i.color, size: i.size, qty: i.qty, imageUrl: i.image_url, externalUrl: i.external_url, legitCheck: i.legit_check })),
      };
    }),
  });
});

patch('/api/admin/warehouse/orders/:id', (ctx) => {
  const user = requirePerm(ctx, 'orders.status');
  const order = S.findOne('orders', { id: ctx.params.id });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  const patch = {};
  if (ctx.body.weightFactKg !== undefined) patch.weight_fact_kg = Number(ctx.body.weightFactKg) || null;
  if (ctx.body.volumeM3 !== undefined) patch.volume_m3 = Number(ctx.body.volumeM3) || order.volume_m3;
  if (ctx.body.places !== undefined) patch.places_count = A.validators.int(ctx.body.places, 1, 50) || order.places_count;
  S.updateById('orders', order.id, patch);

  // перерасчёт по фактическому весу → корректировка (доплата/возврат на баланс).
  // Математика живёт в core/pricing.js — сервер лишь применяет результат.
  if (patch.weight_fact_kg) {
    const recalc = recalcByFactWeight({
      input: order.snapshot?.input || { items: S.find('order_items', { order_id: order.id }).map((i) => ({
        title: i.title, category_slug: i.category_slug, qty: i.qty,
        price_cny_minor: i.price_cny_minor, weight_kg: i.weight_kg, dims_cm: i.dims_cm,
      })) },
      destination: order.destination,
      packaging: order.snapshot?.packaging?.code || order.snapshot?.packaging || 'basic',
      insured: !!(order.snapshot?.insurance?.enabled ?? order.snapshot?.insured),
      currency: order.currency_view,
      tier: order.loyalty_tier_at_order,
      tariffUsdPerKg: order.snapshot?.tariff_usd_per_kg,
      weightEstKg: order.weight_est_kg,
    }, patch.weight_fact_kg, ctx.cfg);
    const deltaView = recalc.deltaMinor;
    if (recalc.requiresRecalc && Math.abs(deltaView) >= 1) {
      S.insert('order_adjustments', { order_id: order.id, kind: 'weight_recalc', amount_minor: deltaView, currency: order.currency_view, reason: `Фактический вес ${patch.weight_fact_kg} кг против расчётного ${order.weight_est_kg} кг`, status: deltaView > 0 ? 'open' : 'refunded', created_by: user.id });
      if (deltaView < 0) {
        const refundRub = convertMinor(-deltaView, order.currency_view, 'RUB', ctx.rates);
        S.postWalletTx(order.user_id, { wallet_type: 'main', type: TX_TYPES.REFUND, amount_minor: refundRub, currency: 'RUB', ref_type: 'order', ref_id: order.id, comment: `Перерасчёт веса ${order.order_no}`, created_by: user.id });
      }
      S.notify(order.user_id, 'weight_recalc', { title: `Перерасчёт веса ${order.order_no}`, body: deltaView > 0 ? `Фактический вес больше расчётного: требуется доплата ${formatMoney(deltaView, order.currency_view)}` : `Фактический вес меньше: ${formatMoney(-deltaView, order.currency_view)} возвращено на баланс` });
    }
  }
  S.audit(user.id, 'warehouse.facts', 'order', order.id, { weight_est_kg: order.weight_est_kg }, patch);
  ctx.send(200, { ok: true, data: orderDto(S.findOne('orders', { id: order.id }), ctx) });
});

post('/api/admin/warehouse/orders/:id/photos', (ctx) => {
  const user = requirePerm(ctx, 'warehouse.photos');
  const order = S.findOne('orders', { id: ctx.params.id });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  const captions = Array.isArray(ctx.body.captions) && ctx.body.captions.length ? ctx.body.captions : ['Фотоотчёт со склада'];
  const kind = ['report', 'unboxing', 'defect', 'label', 'weight'].includes(ctx.body.kind) ? ctx.body.kind : 'report';
  const created = captions.slice(0, 20).map((c, i) => S.insert('order_photos', {
    order_id: order.id, order_item_id: ctx.body.itemId || null,
    url: `/img/report/${order.order_no}-${kind}-${Date.now()}-${i}.svg`, thumb_url: null, kind,
    caption: A.validators.str(c, 300), uploaded_by: user.id, is_visible_to_client: kind !== 'defect' || !!ctx.body.visibleToClient,
  }));
  if (order.status === 'purchased' || order.status === 'paid' || order.status === 'purchasing') {
    pushStatus(S.findOne('orders', { id: order.id }), 'photo_report', user.id, `Загружено фото: ${created.length}`);
  }
  S.notify(order.user_id, 'photo_report', { title: `Фотоотчёт по заказу ${order.order_no}`, body: `Добавлено фото: ${created.length}. Проверьте в личном кабинете.` });
  telegramNotify(order.user_id, `📸 Фотоотчёт по заказу ${order.order_no} готов`);
  ctx.send(201, { ok: true, data: { photos: created.length, order: orderDto(S.findOne('orders', { id: order.id }), ctx) } });
});

post('/api/admin/warehouse/orders/:id/legit-check', (ctx) => {
  const user = requirePerm(ctx, 'orders.status');
  const order = S.findOne('orders', { id: ctx.params.id });
  if (!order) throw new HttpError(404, 'order_not_found', 'Заказ не найден');
  const pass = !!ctx.body.pass;
  if (ctx.body.itemId) S.updateById('order_items', ctx.body.itemId, { legit_check: pass ? 'pass' : 'fail' });
  if (!pass) {
    pushStatus(order, 'legit_check_failed', user.id, ctx.body.comment || 'Legit Check не пройден');
    const refund = refundOrder(S.findOne('orders', { id: order.id }), ctx, { full: true, to: 'wallet_main', reason: 'Не прошёл Legit Check — 100% возврат на баланс' });
    S.updateById('orders', order.id, { status: 'refunded' });
    S.insert('order_status_history', { order_id: order.id, from_status: 'legit_check_failed', to_status: 'refunded', changed_by: user.id, comment: '100% возврат на баланс' });
    S.insert('disputes', { order_id: order.id, user_id: order.user_id, reason: 'legit_check_failed', status: 'refunded_full', description: ctx.body.comment || 'Legit Check не пройден', resolution: 'Автоматический 100% возврат на баланс', refund_minor: order.total_minor, refund_to: 'wallet_main', handled_by: user.id, handled_at: new Date().toISOString() });
    return ctx.send(200, { ok: true, data: { refunded: refund.toWallet, order: orderDto(S.findOne('orders', { id: order.id }), ctx) } });
  }
  S.audit(user.id, 'warehouse.legit_check', 'order', order.id, null, { pass: true });
  ctx.send(200, { ok: true, data: orderDto(order, ctx) });
});

// ── настройки / курсы ──────────────────────────────────────────────────────
get('/api/admin/settings', (ctx) => {
  requirePerm(ctx, 'rates.write');
  const rows = S.find('settings', {}, { sort: 'key' });
  ctx.send(200, { ok: true, data: rows.map((r) => ({ key: r.key, value: r.value, description: r.description, isPublic: !!r.is_public, updatedAt: r.updated_at })), rateHistory: S.find('rate_history', {}, { sort: ['valid_from', 'desc'], limit: 30 }) });
});

patch('/api/admin/settings/:key', (ctx) => {
  const user = requirePerm(ctx, 'rates.write');
  const key = ctx.params.key;
  const existing = S.findOne('settings', { key });
  if (!existing) throw new HttpError(404, 'setting_not_found', 'Настройка не найдена');
  const before = existing.value;
  let value = ctx.body.value;
  if (ctx.body.patch && typeof before === 'object' && !Array.isArray(before)) value = { ...before, ...ctx.body.patch };
  if (key === 'rates.currency_rates') {
    for (const [cur, r] of Object.entries(value || {})) {
      if (Number(r.base) <= 0) throw new HttpError(400, 'invalid_rate', `Некорректный базовый курс ${cur}`);
      if (Math.abs(Number(r.markup)) > 100) throw new HttpError(400, 'invalid_markup', 'Наценка должна быть в пределах ±100%');
    }
  }
  S.setSetting(key, value, user.id);
  S.insert('rate_history', { currency: key === 'rates.currency_rates' ? 'ALL' : key, base_rate: 0, markup_percent: 0, effective_rate: 0, source: 'admin', valid_from: new Date().toISOString(), created_by: user.id });
  S.audit(user.id, 'settings.update', 'settings', null, before, value);
  if (key === 'rates.currency_rates') notifyRateChange(before, value, ctx);
  ctx.send(200, { ok: true, data: { key, value, config: settingsPublic(ctx) } });
});

function notifyRateChange(before, after, ctx) {
  const threshold = Number(S.getSetting('alerts.rate_drop_threshold_percent', 2)) / 100;
  const dropped = [];
  for (const cur of ['CNY', 'USD', 'BYN']) {
    const b = Number(before?.[cur]?.base || 0), a = Number(after?.[cur]?.base || 0);
    if (b > 0 && a > 0 && (b - a) / b >= threshold) dropped.push({ cur, from: b, to: a });
  }
  if (!dropped.length) return;
  const watchers = S.find('wishlists', { alert_rate_drop: true });
  const userIds = [...new Set(watchers.map((w) => w.user_id))];
  for (const uid_ of userIds) {
    S.notify(uid_, 'rate_drop', {
      title: 'Курс снизился — товары в избранном подешевели',
      body: dropped.map((d) => `${d.cur}: ${d.from} → ${d.to}`).join(', '),
      payload: { dropped },
    });
    telegramNotify(uid_, `📉 Курс изменился: ${dropped.map((d) => `${d.cur} ${d.from}→${d.to}`).join(', ')}. Ваши избранные товары стали дешевле.`);
  }
  void ctx;
}

// ── TikTok-модерация ───────────────────────────────────────────────────────
get('/api/admin/tiktok', (ctx) => {
  requirePerm(ctx, 'tiktok.read');
  const status = ctx.query.status;
  let rows = S.find('tiktok_submissions', {}, { sort: ['created_at', 'desc'] });
  if (status) rows = rows.filter((r) => r.status === status);
  ctx.send(200, {
    ok: true, data: rows.map((r) => {
      const u = S.findOne('users', { id: r.user_id });
      const parsed = parseTikTokUrl(r.url);
      return {
        id: r.id, url: r.url, videoId: r.video_id, authorHandle: r.author_handle,
        user: u ? { id: u.id, publicUid: u.public_uid, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), phone: u.phone } : null,
        viewsDeclared: r.views_declared, viewsVerified: r.views_verified, status: r.status,
        hashtagFound: r.hashtag_found, linkFound: r.link_found, rewardMinor: r.reward_minor,
        rewardCurrency: r.reward_currency, rejectReason: r.reject_reason, createdAt: r.created_at, reviewedAt: r.reviewed_at,
        preview: parsed,
        estRewardRubMinor: calcTikTokReward(r.views_declared || 0, S.getSetting('tiktok.config', {})).rewardRubMinor,
      };
    }),
  });
});

post('/api/admin/tiktok/:id/review', (ctx) => {
  const user = requirePerm(ctx, 'tiktok.moderate');
  const sub = S.findOne('tiktok_submissions', { id: ctx.params.id });
  if (!sub) throw new HttpError(404, 'not_found', 'Заявка не найдена');
  if (sub.status === 'approved' && ctx.body.decision === 'approve') throw new HttpError(409, 'already_reviewed', 'Заявка уже одобрена');
  const cfgT = S.getSetting('tiktok.config', DEFAULT_TIKTOK_CONFIG);
  const decision = ctx.body.decision === 'reject' ? 'reject' : 'approve';
  const res = resolveModeration({ decision, viewsVerified: ctx.body.viewsVerified ?? sub.views_declared, submission: sub, config: cfgT });
  S.updateById('tiktok_submissions', sub.id, {
    status: res.status, views_verified: res.viewsVerified, reviewer_id: user.id, reviewed_at: new Date().toISOString(),
    reject_reason: decision === 'reject' ? A.validators.str(ctx.body.reason, 500) || 'Не соответствует правилам конкурса' : null,
  });
  let credited = 0;
  if (res.requiresCredit && res.rewardRubMinor > 0) {
    const tx = S.postWalletTx(sub.user_id, {
      wallet_type: res.walletType || 'bonus', type: TX_TYPES.TIKTOK_REWARD, amount_minor: res.rewardRubMinor, currency: 'RUB',
      ref_type: 'tiktok', ref_id: sub.id, comment: `TikTok: ${res.viewsVerified?.toLocaleString('ru-RU')} просмотров (${res.units} × 1000)`,
      idempotency_key: `tiktok:${sub.id}:${res.viewsVerified}`, created_by: user.id,
    });
    credited = res.rewardRubMinor;
    S.updateById('tiktok_submissions', sub.id, { reward_minor: res.rewardRubMinor, reward_currency: 'RUB' });
    const cur = S.findOne('user_settings', { user_id: sub.user_id })?.currency || 'RUB';
    S.notify(sub.user_id, 'tiktok_reward', {
      title: `Начислено за ${res.viewsVerified?.toLocaleString('ru-RU')} просмотров`,
      body: `${formatMoney(convertMinor(res.rewardRubMinor, 'RUB', cur, ctx.rates), cur)} на бонусный баланс`,
      payload: { submissionId: sub.id, reward: res.rewardRubMinor, txId: tx.tx.id },
    });
    telegramNotify(sub.user_id, `🎬 TikTok-бонус: ${formatMoney(convertMinor(res.rewardRubMinor, 'RUB', cur, ctx.rates), cur)} за ${res.viewsVerified?.toLocaleString('ru-RU')} просмотров`);
  }
  S.audit(user.id, 'tiktok.review', 'tiktok_submissions', sub.id, { status: sub.status }, { status: res.status, views: res.viewsVerified, credited });
  ctx.send(200, { ok: true, data: { status: res.status, viewsVerified: res.viewsVerified, rewardRubMinor: credited, units: res.units } });
});

// ── рефералы (админ) ───────────────────────────────────────────────────────
get('/api/admin/referrals', (ctx) => {
  requirePerm(ctx, 'referrals.read');
  const rows = S.find('referrals', {}, { sort: ['created_at', 'desc'] });
  ctx.send(200, {
    ok: true, data: rows.map((r) => {
      const referrer = S.findOne('users', { id: r.referrer_id });
      const referee = S.findOne('users', { id: r.referee_id });
      const firstOrder = r.first_order_id ? S.findOne('orders', { id: r.first_order_id }) : null;
      const orders = S.find('orders', { user_id: r.referee_id });
      return {
        id: r.id, status: r.status, codeUsed: r.code_used, createdAt: r.created_at, rewardedAt: r.rewarded_at,
        referrer: referrer ? { id: referrer.id, publicUid: referrer.public_uid, name: `${referrer.first_name || ''} ${referrer.last_name || ''}`.trim() } : null,
        referee: referee ? { id: referee.id, publicUid: referee.public_uid, name: `${referee.first_name || ''} ${referee.last_name || ''}`.trim(), phone: referee.phone } : null,
        firstOrder: firstOrder ? { orderNo: firstOrder.order_no, totalMinor: firstOrder.total_minor, currency: firstOrder.currency_view, paidAt: firstOrder.paid_at } : null,
        rewardMinor: r.reward_minor, inviteeBonusMinor: r.invitee_bonus_minor,
        refereeOrders: orders.length, refereePaidOrders: orders.filter((o) => o.payment_status === 'succeeded').length,
        ip: r.ip,
      };
    }), stats: referralStats(rows),
  });
});

// ── пользователи / blacklist / роли ────────────────────────────────────────
get('/api/admin/users', (ctx) => {
  requirePerm(ctx, 'users.read');
  const q = ctx.query.q ? String(ctx.query.q).toLowerCase() : null;
  let rows = S.find('users', {}, { sort: ['created_at', 'desc'] });
  if (q) rows = rows.filter((u) => [u.public_uid, u.phone, u.email, u.first_name, u.last_name, u.referral_code].filter(Boolean).join(' ').toLowerCase().includes(q));
  ctx.send(200, {
    ok: true, data: rows.map((u) => {
      const w = S.walletOf(u.id);
      const orders = S.find('orders', { user_id: u.id });
      return {
        id: u.id, publicUid: u.public_uid, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
        phone: u.phone, email: u.email, role: u.role_code, tier: u.loyalty_tier,
        lifetimeRubMinor: u.lifetime_value_minor, mainRubMinor: w.balance_main_minor, bonusRubMinor: w.balance_bonus_minor,
        blacklisted: !!u.is_blacklisted, telegramChatId: u.telegram_chat_id, createdAt: u.created_at,
        ordersCount: orders.length, paidOrdersCount: orders.filter((o) => o.payment_status === 'succeeded').length,
        referredBy: u.referred_by_id ? S.findOne('users', { id: u.referred_by_id })?.public_uid : null,
      };
    }), roles: S.find('roles', {}, { sort: 'id' }),
  });
});

patch('/api/admin/users/:id', (ctx) => {
  const admin = requirePerm(ctx, 'users.write');
  const u = S.findOne('users', { id: ctx.params.id });
  if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
  const patch = {};
  if (ctx.body.role && A.can(admin, 'users.write')) {
    const role = S.findOne('roles', { code: ctx.body.role });
    if (role) { patch.role_id = role.id; patch.role_code = role.code; }
  }
  if (ctx.body.blacklisted !== undefined) patch.is_blacklisted = !!ctx.body.blacklisted;
  if (ctx.body.tier) patch.loyalty_tier = String(ctx.body.tier).toUpperCase();
  if (ctx.body.lifetimeRubMinor !== undefined) patch.lifetime_value_minor = A.validators.int(ctx.body.lifetimeRubMinor, 0) ?? u.lifetime_value_minor;
  S.updateById('users', u.id, patch);
  S.audit(admin.id, 'user.update', 'user', u.id, u, patch);
  ctx.send(200, { ok: true, data: S.findOne('users', { id: u.id }) });
});

post('/api/admin/users/:id/adjust-balance', (ctx) => {
  const admin = requirePerm(ctx, 'wallet.adjust');
  const u = S.findOne('users', { id: ctx.params.id });
  if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
  const amount = A.validators.int(ctx.body.amountRubMinor, -100_000_000, 100_000_000);
  if (!amount) throw new HttpError(400, 'invalid_amount', 'Укажите сумму (не 0)');
  const walletType = ctx.body.walletType === 'bonus' ? 'bonus' : 'main';
  const tx = S.postWalletTx(u.id, {
    wallet_type: walletType, type: amount > 0 ? TX_TYPES.ADJUSTMENT : TX_TYPES.ADJUSTMENT, amount_minor: amount, currency: 'RUB',
    ref_type: 'admin', ref_id: u.id, comment: A.validators.str(ctx.body.comment, 300) || 'Ручная корректировка', created_by: admin.id,
  });
  S.notify(u.id, 'balance_adjusted', { title: amount > 0 ? 'Баланс пополнен' : 'Списание с баланса', body: tx.tx.comment });
  ctx.send(200, { ok: true, data: { tx: tx.tx, wallet: S.walletOf(u.id) } });
});

get('/api/admin/blacklist', (ctx) => { requirePerm(ctx, 'users.read'); ctx.send(200, { ok: true, data: S.find('blacklists', {}, { sort: ['created_at', 'desc'] }) }); });
post('/api/admin/blacklist', (ctx) => {
  const admin = requirePerm(ctx, 'users.blacklist');
  const kind = ['user', 'phone', 'ip', 'email', 'device'].includes(ctx.body.kind) ? ctx.body.kind : null;
  const value = A.validators.str(ctx.body.value, 200);
  if (!kind || !value) throw new HttpError(400, 'invalid_input', 'Нужны kind и value');
  if (S.findOne('blacklists', { kind, value })) throw new HttpError(409, 'exists', 'Уже в чёрном списке');
  const row = S.insert('blacklists', { kind, value, reason: A.validators.str(ctx.body.reason, 500), created_by: admin.id, expires_at: ctx.body.expiresAt || null });
  if (kind === 'user') S.updateById('users', value, { is_blacklisted: true });
  S.audit(admin.id, 'blacklist.add', 'blacklists', row.id, null, { kind, value });
  ctx.send(201, { ok: true, data: row });
});
del('/api/admin/blacklist/:id', (ctx) => {
  const admin = requirePerm(ctx, 'users.blacklist');
  const row = S.findOne('blacklists', { id: ctx.params.id });
  if (!row) throw new HttpError(404, 'not_found', 'Не найдено');
  if (row.kind === 'user') S.updateById('users', row.value, { is_blacklisted: false });
  S.remove('blacklists', { id: row.id });
  S.audit(admin.id, 'blacklist.remove', 'blacklists', row.id, row, null);
  ctx.send(200, { ok: true });
});

// ── споры (админ) ──────────────────────────────────────────────────────────
get('/api/admin/disputes', (ctx) => {
  requirePerm(ctx, 'disputes.read');
  const rows = S.find('disputes', {}, { sort: ['created_at', 'desc'] });
  ctx.send(200, {
    ok: true, data: rows.map((d) => {
      const o = S.findOne('orders', { id: d.order_id });
      const u = S.findOne('users', { id: d.user_id });
      return { id: d.id, orderNo: o?.order_no, orderStatus: o?.status, user: u?.public_uid, reason: d.reason, status: d.status, description: d.description, resolution: d.resolution, refundMinor: d.refund_minor, refundTo: d.refund_to, createdAt: d.created_at, handledAt: d.handled_at, totalMinor: o?.total_minor, currency: o?.currency_view };
    }),
  });
});

post('/api/admin/disputes/:id/resolve', (ctx) => {
  const admin = requirePerm(ctx, 'disputes.handle');
  const d = S.findOne('disputes', { id: ctx.params.id });
  if (!d) throw new HttpError(404, 'not_found', 'Спор не найден');
  const order = S.findOne('orders', { id: d.order_id });
  const decision = ['refunded_full', 'refunded_partial', 'rejected'].includes(ctx.body.decision) ? ctx.body.decision : 'rejected';
  S.updateById('disputes', d.id, { status: decision, resolution: A.validators.str(ctx.body.resolution, 1000), handled_by: admin.id, handled_at: new Date().toISOString() });
  if (decision !== 'rejected' && order && order.payment_status === 'succeeded') {
    const full = decision === 'refunded_full';
    const amountMinor = full ? order.total_minor : A.validators.int(ctx.body.refundMinor, 1, order.total_minor) || Math.round(order.total_minor / 2);
    const rub = convertMinor(amountMinor, order.currency_view, 'RUB', ctx.rates);
    S.postWalletTx(order.user_id, { wallet_type: 'main', type: TX_TYPES.REFUND, amount_minor: rub, currency: 'RUB', ref_type: 'dispute', ref_id: d.id, comment: `Возврат по спору ${order.order_no}`, created_by: admin.id });
    S.updateById('disputes', d.id, { refund_minor: amountMinor });
    S.updateById('orders', order.id, { payment_status: full ? 'refunded' : 'partially_refunded' });
    if (full) { S.updateById('orders', order.id, { status: 'refunded' }); S.insert('order_status_history', { order_id: order.id, from_status: order.status, to_status: 'refunded', changed_by: admin.id, comment: 'Возврат по спору' }); }
    S.notify(order.user_id, 'dispute_resolved', { title: `Решение по возврату ${order.order_no}`, body: full ? 'Полный возврат зачислен на баланс' : `Частичный возврат ${formatMoney(amountMinor, order.currency_view)} зачислен на баланс` });
  }
  S.audit(admin.id, 'dispute.resolve', 'disputes', d.id, { status: d.status }, { decision });
  ctx.send(200, { ok: true, data: S.findOne('disputes', { id: d.id }) });
});

// ── задачи ─────────────────────────────────────────────────────────────────
get('/api/admin/tasks', (ctx) => {
  requirePerm(ctx, 'tasks.read');
  const rows = S.find('tasks', {}, { sort: ['created_at', 'desc'], limit: 200 });
  ctx.send(200, {
    ok: true, data: rows.map((t) => ({
      id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority, dueAt: t.due_at,
      assignee: t.assignee_id ? (() => { const u = S.findOne('users', { id: t.assignee_id }); return { id: u?.id, publicUid: u?.public_uid, name: `${u?.first_name || ''} ${u?.last_name || ''}`.trim() }; })() : null,
      orderNo: t.order_id ? S.findOne('orders', { id: t.order_id })?.order_no : null, createdAt: t.created_at, completedAt: t.completed_at,
    })), users: S.find('users', {}).map((u) => ({ id: u.id, publicUid: u.public_uid, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), role: u.role_code })),
  });
});
post('/api/admin/tasks', (ctx) => {
  const user = requirePerm(ctx, 'tasks.write');
  const title = A.validators.str(ctx.body.title, 200);
  if (!title) throw new HttpError(400, 'title_required', 'Укажите заголовок');
  const row = S.insert('tasks', {
    title, description: A.validators.str(ctx.body.description, 2000), assignee_id: ctx.body.assigneeId || null,
    created_by: user.id, order_id: ctx.body.orderId || null, status: 'todo',
    priority: ['low', 'normal', 'high', 'urgent'].includes(ctx.body.priority) ? ctx.body.priority : 'normal',
    due_at: ctx.body.dueAt || null, completed_at: null,
  });
  if (row.assignee_id) S.notify(row.assignee_id, 'task_assigned', { title: 'Новая задача', body: title });
  ctx.send(201, { ok: true, data: row });
});
patch('/api/admin/tasks/:id', (ctx) => {
  const user = requirePerm(ctx, 'tasks.write');
  const t = S.findOne('tasks', { id: ctx.params.id });
  if (!t) throw new HttpError(404, 'not_found', 'Задача не найдена');
  const patch = {};
  if (ctx.body.status) patch.status = ctx.body.status;
  if (ctx.body.assigneeId !== undefined) patch.assignee_id = ctx.body.assigneeId || null;
  if (ctx.body.priority) patch.priority = ctx.body.priority;
  if (patch.status === 'done') patch.completed_at = new Date().toISOString();
  S.updateById('tasks', t.id, patch);
  S.audit(user.id, 'task.update', 'tasks', t.id, t, patch);
  ctx.send(200, { ok: true, data: S.findOne('tasks', { id: t.id }) });
});

// ── P&L ────────────────────────────────────────────────────────────────────
get('/api/admin/pnl', (ctx) => {
  requirePerm(ctx, 'finance.read');
  const { from, to, destination, currency } = ctx.query;
  let orders = S.find('orders', {}).filter((o) => o.payment_status === 'succeeded');
  if (from) orders = orders.filter((o) => (o.paid_at || o.created_at) >= from);
  if (to) orders = orders.filter((o) => (o.paid_at || o.created_at) <= to);
  if (destination) orders = orders.filter((o) => o.destination === destination);
  const opex = S.find('opex_entries', {});
  const opexRub = opex.reduce((a, e) => a + convertMinor(Number(e.amount_minor), e.currency, 'RUB', ctx.rates), 0);
  const prepared = orders.map((o) => ({ ...o, revenue_minor: o.paid_minor, revenue_currency: o.currency_view, paid_at: o.paid_at || o.created_at }));
  const orderById = new Map(prepared.map((o) => [o.id, o]));
  const reportCur = A.validators.currency(currency) || 'RUB';
  const multi = multiCurrencyPnl(prepared, ctx.cfg, {
    RUB: opexRub, BYN: convertMinor(opexRub, 'RUB', 'BYN', ctx.rates), USD: convertMinor(opexRub, 'RUB', 'USD', ctx.rates),
  });
  const primary = multi[reportCur];
  ctx.send(200, {
    ok: true, data: {
      currency: reportCur,
      totals: primary.totals,
      byDay: pnlByDay(primary.rows.map((r) => ({ ...r, paid_at: orderById.get(r.orderId)?.paid_at }))),
      byDestination: ['RU_MOW', 'BY_MSQ'].map((d) => {
        const rows = prepared.filter((o) => o.destination === d).map((o) => orderPnl(o, ctx.cfg, reportCur));
        return { destination: d, label: ctx.cfg.tariffs[d]?.label || d, orders: rows.length, revenue: rows.reduce((a, r) => a + r.revenue, 0), gross: rows.reduce((a, r) => a + r.gross, 0) };
      }),
      multi: Object.fromEntries(Object.entries(multi).map(([k, v]) => [k, v.totals])),
      opex: opex.map((e) => ({ id: e.id, day: e.day, category: e.category, amountMinor: convertMinor(Number(e.amount_minor), e.currency, reportCur, ctx.rates), currency: reportCur, comment: e.comment })),
      orders: primary.rows.map((r) => ({ ...r, destination: orderById.get(r.orderId)?.destination })),
      rates: ctx.rates,
    },
  });
});

get('/api/admin/pnl/export.csv', (ctx) => {
  const user = requirePerm(ctx, 'finance.read');
  // Валюта отчёта берётся из query: раньше здесь был жёсткий 'RUB', из-за чего
  // экспорт не совпадал с тем, что пользователь видит на экране (BYN/USD).
  const SYMBOLS = { RUB: '₽', BYN: 'Br', USD: '$' };
  const reportCur = SYMBOLS[ctx.query?.currency] ? String(ctx.query.currency) : 'RUB';
  const sym = SYMBOLS[reportCur];
  const orders = S.find('orders', {}).filter((o) => o.payment_status === 'succeeded');
  const rows = orders.map((o) => {
    const r = orderPnl({ ...o, revenue_minor: o.paid_minor, revenue_currency: o.currency_view }, ctx.cfg, reportCur);
    // в CSV процент нужен человекочитаемым (6.39), а не долей (0.06391658858547483)
    return { ...r, marginPct: Number.isFinite(r.marginPct) ? Math.round(r.marginPct * 10000) / 100 : '' };
  });
  const csv = toCsv(rows, [
    { key: 'orderNo', title: 'Заказ' },
    { key: 'revenue', title: `Приход ${sym} (минор)` }, { key: 'cogs', title: `Закупка ${sym} (минор)` },
    { key: 'cargo', title: `Карго ${sym} (минор)` }, { key: 'extra', title: `Прочее ${sym} (минор)` },
    { key: 'acquiring', title: `Эквайринг ${sym} (минор)` }, { key: 'gross', title: `Маржа ${sym} (минор)` },
    { key: 'marginPct', title: 'Маржа %' },
  ]);
  S.audit(user.id, 'export.pnl', 'report', null, null, { currency: reportCur, count: rows.length });
  text(ctx.res, 200, csv, 'text/csv; charset=utf-8', {
    'Content-Disposition': `attachment; filename="poizonvanart-pnl-${reportCur}-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

// ── аудит ──────────────────────────────────────────────────────────────────
get('/api/admin/audit', (ctx) => {
  requirePerm(ctx, 'users.read');
  const rows = S.find('audit_log', {}, { sort: ['created_at', 'desc'], limit: 200 });
  ctx.send(200, {
    ok: true, data: rows.map((r) => ({
      id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id,
      actor: r.actor_id ? S.findOne('users', { id: r.actor_id })?.public_uid : 'system',
      at: r.created_at, ip: r.ip,
    })),
  });
});

// ── вебхук эквайринга (мок) ────────────────────────────────────────────────
post('/api/webhooks/payment', (ctx) => {
  const { eventId, paymentId, status } = ctx.body;
  if (!eventId || !paymentId) throw new HttpError(400, 'invalid_webhook', 'Нужны eventId и paymentId');
  const seen = S.findOne('payments', { id: paymentId });
  if (!seen) throw new HttpError(404, 'payment_not_found', 'Платёж не найден');
  if (seen.payload?.processedEvents?.includes(eventId)) return ctx.send(200, { ok: true, duplicate: true });
  S.updateById('payments', paymentId, { status: status || 'succeeded', payload: { ...(seen.payload || {}), processedEvents: [...(seen.payload?.processedEvents || []), eventId] } });
  ctx.send(200, { ok: true });
});

// ── служебное ──────────────────────────────────────────────────────────────
get('/api/health', (ctx) => ctx.send(200, { ok: true, status: 'up', time: new Date().toISOString(), uptime: process.uptime() }));
post('/api/admin/reset-demo', (ctx) => {
  const user = A.requireAuth(ctx.req);
  if (A.roleOf(user).code !== 'owner') throw new HttpError(403, 'forbidden', 'Только владелец');
  S.resetDb();
  ctx.send(200, { ok: true, message: 'Демо-данные пересозданы' });
});

post('/api/admin/system/restart', (ctx) => {
  const user = A.requireAuth(ctx.req);
  const role = A.roleOf(user).code;
  if (role !== 'owner' && role !== 'admin') throw new HttpError(403, 'forbidden', 'Перезагрузка доступна только владельцу платформы');
  S.persistNow();
  S.audit(user.id, 'system.restart', 'system', 'server', null, { triggered_by: user.public_uid });
  ctx.send(200, { ok: true, data: { message: 'Сервер успешно перезагружается...' } });
  setTimeout(() => {
    console.log(`\n>>> [Система] Перезагрузка сервера по запросу владельца (${user.public_uid})...\n`);
    process.exit(42);
  }, 400);
});

// ═══════════════════════════════════════════════════════════════════════════
// HTTP-сервер
// ═══════════════════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '600' });
    return res.end();
  }

  try {
    // общее ядро (core/*.js) — используется и сервером, и браузером через import map
    if (url.pathname.startsWith('/core/')) {
      const file = path.resolve(CLIENT_DIR, '..', url.pathname.slice(1));
      const rootCore = path.resolve(CLIENT_DIR, '..', 'core');
      if (!file.startsWith(rootCore)) { res.writeHead(403); return res.end('Forbidden'); }
      return serveStatic(res, rootCore, url.pathname.replace(/^\/core/, '') || '/');
    }

    // динамические изображения-заглушки
    if (url.pathname.startsWith('/img/')) {
      const seed = url.pathname;
      const kind = url.pathname.includes('/report/') ? 'report' : 'product';
      const svg = placeholderSvg(seed, { label: url.searchParams.get('label') || seed, kind });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end(svg);
    }

    if (url.pathname.startsWith('/api/')) {
      if (!rateLimit(`ip:${clientIp(req)}`, 300, 60_000)) throw new HttpError(429, 'rate_limited', 'Слишком много запросов');
      const match = routes.find((r) => r.method === req.method && r.rx.test(url.pathname));
      if (!match) throw new HttpError(404, 'route_not_found', `Нет маршрута ${req.method} ${url.pathname}`);
      const params = {};
      const m = url.pathname.match(match.rx);
      match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      req.params = params;
      req.query = Object.fromEntries(url.searchParams.entries());
      req.body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      req.user = A.authFromRequest(req);
      req.guestToken = getCookie(req, 'pv_guest');
      if (!req.guestToken) { req.guestToken = randomToken(12); setCookie(res, 'pv_guest', req.guestToken, { maxAge: 30 * 86400, httpOnly: false }); }
      const ctx = ctxFor(req, res);
      ctx.params = params;
      await match.handler(ctx);
      if (!res.writableEnded) res.end();
      log(req, res, Date.now() - started);
      return;
    }

    serveStatic(res, CLIENT_DIR, url.pathname);
    log(req, res, Date.now() - started);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[error]', err);
    if (!res.headersSent) json(res, status, { ok: false, error: { code: err.code || 'internal_error', message: status >= 500 ? 'Внутренняя ошибка сервера' : err.message, details: err.details } });
    else res.end();
    log(req, res, Date.now() - started);
  }
});

function log(req, res, ms) {
  if (process.env.PV_QUIET) return;
  const p = req.url.split('?')[0];
  if (p.startsWith('/img/') || p.endsWith('.svg') || p.endsWith('.css') || p.endsWith('.js')) return;
  console.log(`${new Date().toISOString().slice(11, 19)} ${String(res.statusCode).padEnd(3)} ${req.method.padEnd(6)} ${p.padEnd(42)} ${ms}ms`);
}

/* Минимальная версия Node: поддержка ES модулей, встроенный fetch, crypto */
const NODE_MIN = [18, 0];
const NODE_CUR = process.versions.node.split('.').map(Number);
if (NODE_CUR[0] < NODE_MIN[0] || (NODE_CUR[0] === NODE_MIN[0] && NODE_CUR[1] < NODE_MIN[1])) {
  console.warn(`! Внимание: рекомендуется Node.js 18+ (сейчас v${process.versions.node}).`);
}

S.getDb();

/** Локальные IPv4-адреса — чтобы сразу дать ссылку для телефона/других устройств. */
function lanAddresses() {
  try {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
    return out;
  } catch { return []; }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Порт ${PORT} уже занят другим приложением.`);
    console.error(`  Запустите на другом порту:  PORT=8090 npm start   (Windows: set PORT=8090 && npm start)`);
    console.error(`  Или найдите процесс:        netstat -ano | findstr :${PORT}   (Windows) / lsof -i :${PORT}   (macOS, Linux)`);
  } else if (err.code === 'EACCES') {
    console.error(`\n✗ Нет прав на порт ${PORT} (порты ниже 1024 требуют прав администратора).`);
    console.error(`  Используйте порт выше 1024: PORT=8080 npm start`);
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(`\n✗ Адрес ${HOST} недоступен на этой машине. Запустите с HOST=0.0.0.0 или HOST=127.0.0.1.`);
  } else {
    console.error('\n✗ Не удалось запустить сервер:', err.message);
  }
  process.exit(1);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ОШИБКА] Порт ${PORT} уже занят другим приложением или предыдущей версией сервера.`);
    console.error(`  Закройте старое окно командной строки или завершите процесс на порту ${PORT}.`);
    console.error(`  Или запустите на другом порту, например: set PORT=3000 && start.bat\n`);
  } else {
    console.error('[server error]', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('──────────────────────────────────────────────────────────────');
  console.log('  PoizonVanart · Платформа выкупа и логистики с Poizon');
  console.log(`  → Адрес сайта:  http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  → В локальной сети / с телефона: http://${ip}:${PORT}`);
  console.log(`  База данных: ${S.paths.DATA_FILE}`);
  console.log('  Сервер успешно запущен.');
  console.log('──────────────────────────────────────────────────────────────');
});

process.on('SIGINT', () => { S.persistNow(); console.log('\n[store] saved, bye'); process.exit(0); });
process.on('SIGTERM', () => { S.persistNow(); process.exit(0); });
process.on('uncaughtException', (err) => {
  console.error('\n[fatal] непойманное исключение — данные сохранены, сервер останавливается.');
  console.error(err);
  try { S.persistNow(); } catch { /* best effort */ }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[warn] необработанный rejection:', reason?.message || reason);
});

export { server };
