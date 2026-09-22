/**
 * PoizonVanart · core/referral.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Реферальная программа. КЛЮЧЕВОЕ ПРАВИЛО:
 *   начисление происходит ТОЛЬКО после того, как приглашённый друг
 *   оформил и ПОЛНОСТЬЮ ОПЛАТИЛ свой ПЕРВЫЙ заказ.
 * При полном возврате этого заказа награда отзывается (clawback).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEFAULT_REFERRAL_CONFIG = {
  trigger: 'first_paid_order',
  reward_type: 'percent_of_order',   // percent_of_order | fixed
  percent: 3,                        // 3% от суммы первого оплаченного заказа
  cap_rub_minor: 150_000,            // потолок награды (1 500 ₽)
  fallback_fixed_rub_minor: 30_000,  // если reward_type = fixed
  invitee_bonus_rub_minor: 20_000,   // приветственный бонус приглашённому
  cookie_days: 30,
  wallet_type: 'bonus',
  clawback_on_refund: true,
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O/1/I — меньше опечаток

/** Генерация читаемого уникального промокода: PV-XXXXXX → XXXXXX. */
export function generateReferralCode(random = Math.random, length = 6, prefix = '') {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return prefix ? `${prefix}${s}` : s;
}

/** Нормализация кода/ссылки: 'https://site/#/r/IVANPV' → 'IVANPV'. */
export function extractReferralCode(input) {
  if (!input) return null;
  const s = String(input).trim();
  const patterns = [
    /[?&]ref=([A-Za-z0-9_-]+)/,
    /[?&]promo=([A-Za-z0-9_-]+)/,
    /#\/r\/([A-Za-z0-9_-]+)/,
    /\/r\/([A-Za-z0-9_-]+)/,
    /t\.me\/[A-Za-z0-9_]+\?start=([A-Za-z0-9_-]+)/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1].toUpperCase();
  }
  return /^[A-Za-z0-9_-]{3,24}$/.test(s) ? s.toUpperCase() : null;
}

export function referralLink(baseUrl, code) {
  return `${String(baseUrl).replace(/\/$/, '')}/#/r/${encodeURIComponent(code)}`;
}

/** Антифрод-проверки при привязке реферера. */
export function canBindReferrer({ invitee, referrer, existingBinding }, cfg = {}) {
  const errors = [];
  if (!referrer) errors.push('referrer_not_found');
  if (!invitee) errors.push('invitee_not_found');
  if (referrer && invitee && referrer.id === invitee.id) errors.push('self_referral');
  if (existingBinding) errors.push('already_bound');
  if (invitee?.ordersPaidCount > 0) errors.push('not_a_new_user');
  const ipWindowDays = cfg.ipWindowDays ?? 30;
  if (invitee?.sameIpRecentCount >= (cfg.maxSameIp ?? 3) && ipWindowDays) errors.push('ip_cluster');
  return { ok: errors.length === 0, errors };
}

/**
 * Расчёт награды за первый оплаченный заказ приглашённого.
 * @param {number} orderTotalRubMinor сумма заказа в копейках RUB
 */
export function calcReferralReward(orderTotalRubMinor, config = {}) {
  const c = { ...DEFAULT_REFERRAL_CONFIG, ...config };
  const total = Math.max(0, Math.round(Number(orderTotalRubMinor || 0)));
  let reward;
  if (c.reward_type === 'fixed') {
    reward = Math.round(Number(c.fallback_fixed_rub_minor || 0));
  } else {
    reward = Math.round((total * Number(c.percent || 0)) / 100);
    if (c.cap_rub_minor != null) reward = Math.min(reward, Math.round(Number(c.cap_rub_minor)));
  }
  return {
    referrerRewardRubMinor: reward,
    inviteeBonusRubMinor: Math.round(Number(c.invitee_bonus_rub_minor || 0)),
    walletType: c.wallet_type || 'bonus',
    trigger: c.trigger,
    breakdown: { orderTotalRubMinor: total, percent: Number(c.percent || 0), capRubMinor: c.cap_rub_minor ?? null },
  };
}

/** Можно ли начислять: заказ оплачен полностью, это первый заказ, награда ещё не выдавалась. */
export function isEligibleForReward({ order, referral, isFirstOrder }) {
  const reasons = [];
  if (!order) reasons.push('no_order');
  if (order && order.payment_status !== 'succeeded') reasons.push('not_fully_paid');
  if (order && Number(order.paid_minor || 0) < Number(order.total_minor || 0)) reasons.push('partially_paid');
  if (!isFirstOrder) reasons.push('not_first_order');
  if (!referral) reasons.push('no_referral_binding');
  if (referral && ['rewarded'].includes(referral.status)) reasons.push('already_rewarded');
  if (referral && ['fraud'].includes(referral.status)) reasons.push('flagged_fraud');
  return { eligible: reasons.length === 0, reasons };
}

/** Сводка по реферальной программе для ЛК/админки. */
export function referralStats(referrals, ordersByUser = {}) {
  const invited = referrals.length;
  const activated = referrals.filter((r) => ['first_paid', 'rewarded'].includes(r.status)).length;
  const rewardedSum = referrals.reduce((a, r) => a + Number(r.reward_minor || 0), 0);
  const invitedOrders = referrals.reduce((a, r) => a + Number(ordersByUser[r.referee_id]?.length || 0), 0);
  return {
    invited,
    activated,
    conversion: invited ? activated / invited : 0,
    rewardedSum,
    invitedOrders,
    pending: referrals.filter((r) => r.status === 'registered').length,
  };
}
