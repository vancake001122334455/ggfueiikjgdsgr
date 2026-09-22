/**
 * PoizonVanart · core/wallet.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Кошелёк с append-only леджером. Баланс пользователя — производная от леджера,
 * денормализованное поле служит только для быстрого чтения и сверяется джобом.
 *
 * Правила списания при оплате заказа:
 *   1) бонусный баланс (bonus) — тратится ПЕРВЫМ и полностью;
 *   2) основной баланс (main);
 *   3) остаток — картой / СБП (комбинированная оплата).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const WALLET_TYPES = ['main', 'bonus'];

export const TX_TYPES = {
  TOPUP: 'topup',
  TOPUP_BONUS: 'topup_bonus',
  ORDER_PAYMENT: 'order_payment',
  ORDER_PAYMENT_BONUS: 'order_payment_bonus',
  REFUND: 'refund',
  REFUND_BONUS: 'refund_bonus',
  REFERRAL_REWARD: 'referral_reward',
  TIKTOK_REWARD: 'tiktok_reward',
  LOYALTY_REWARD: 'loyalty_reward',
  PROMO: 'promo',
  ADJUSTMENT: 'adjustment',
  WITHDRAW: 'withdraw',
  CLAWBACK: 'clawback',
};

/** Начальное состояние кошелька. */
export function emptyWallet(userId, currency = 'RUB', initial = {}) {
  return {
    user_id: userId,
    currency,
    balance_main_minor: Math.max(0, Math.round(initial.main ?? 0)),
    balance_bonus_minor: Math.max(0, Math.round(initial.bonus ?? 0)),
    frozen_minor: 0,
    updated_at: new Date().toISOString(),
  };
}

const balKey = (walletType) => (walletType === 'bonus' ? 'balance_bonus_minor' : 'balance_main_minor');

/** Доступно к списанию (основной баланс минус замороженное). */
export function availableMain(wallet) {
  return Math.max(0, Number(wallet.balance_main_minor || 0) - Number(wallet.frozen_minor || 0));
}
export function availableBonus(wallet) {
  return Math.max(0, Number(wallet.balance_bonus_minor || 0));
}
export function availableTotal(wallet) {
  return availableMain(wallet) + availableBonus(wallet);
}

/**
 * План оплаты: сколько спишем с бонусов, сколько с основного баланса,
 * сколько останется доплатить картой. НИЧЕГО не мутирует — только план.
 */
export function planPayment(wallet, amountMinor) {
  const need = Math.max(0, Math.round(amountMinor));
  const bonus = Math.min(availableBonus(wallet), need);
  const rest = need - bonus;
  const main = Math.min(availableMain(wallet), rest);
  const card = rest - main;
  return {
    need,
    fromBonus: bonus,
    fromMain: main,
    fromCard: card,
    method: card > 0 ? (bonus + main > 0 ? 'combined' : 'card') : bonus > 0 && main > 0 ? 'combined' : bonus > 0 ? 'bonus' : 'wallet',
    coveredByWallet: bonus + main,
    sufficient: card === 0,
  };
}

/**
 * Запись транзакции в леджер + применение к балансу.
 * @returns {{wallet:Object,tx:Object}}
 */
export function postTransaction(wallet, tx) {
  const type = tx.wallet_type === 'bonus' ? 'bonus' : 'main';
  const key = balKey(type);
  const before = Number(wallet[key] || 0);
  const amount = Math.round(Number(tx.amount_minor || 0));
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('wallet: amount_minor must be a non-zero integer');
  }
  const after = before + amount;
  if (after < 0) {
    throw new Error(`wallet: insufficient ${type} balance (have ${before}, need ${-amount})`);
  }
  const nextWallet = { ...wallet, [key]: after, updated_at: new Date().toISOString() };
  const record = {
    id: tx.id ?? null,
    user_id: wallet.user_id,
    wallet_type: type,
    type: tx.type,
    amount_minor: amount,
    currency: tx.currency || wallet.currency || 'RUB',
    balance_before: before,
    balance_after: after,
    ref_type: tx.ref_type || null,
    ref_id: tx.ref_id ?? null,
    idempotency_key: tx.idempotency_key || null,
    comment: tx.comment || null,
    created_by: tx.created_by ?? null,
    created_at: tx.created_at || new Date().toISOString(),
  };
  return { wallet: nextWallet, tx: record };
}

/** Массовое применение плана оплаты: создаёт 1–2 транзакции списания. */
export function applyPaymentPlan(wallet, plan, meta = {}) {
  let w = wallet;
  const txs = [];
  if (plan.fromBonus > 0) {
    const r = postTransaction(w, {
      wallet_type: 'bonus', type: TX_TYPES.ORDER_PAYMENT_BONUS, amount_minor: -plan.fromBonus,
      ref_type: 'order', ref_id: meta.orderId ?? null, comment: meta.comment || 'Оплата заказа (бонусы)',
      idempotency_key: meta.idempotencyKey ? `${meta.idempotencyKey}:bonus` : null, created_by: meta.actorId ?? null,
    });
    w = r.wallet; txs.push(r.tx);
  }
  if (plan.fromMain > 0) {
    const r = postTransaction(w, {
      wallet_type: 'main', type: TX_TYPES.ORDER_PAYMENT, amount_minor: -plan.fromMain,
      ref_type: 'order', ref_id: meta.orderId ?? null, comment: meta.comment || 'Оплата заказа (баланс)',
      idempotency_key: meta.idempotencyKey ? `${meta.idempotencyKey}:main` : null, created_by: meta.actorId ?? null,
    });
    w = r.wallet; txs.push(r.tx);
  }
  return { wallet: w, txs };
}

/** Зачисление (пополнение, бонус, возврат). */
export function credit(wallet, { walletType = 'main', type, amountMinor, comment, ref, idempotencyKey, actorId }) {
  const r = postTransaction(wallet, {
    wallet_type: walletType, type, amount_minor: Math.abs(Math.round(amountMinor)),
    comment, ref_type: ref?.type || null, ref_id: ref?.id ?? null,
    idempotency_key: idempotencyKey || null, created_by: actorId ?? null,
  });
  return r;
}

/** Списание (вывод, корректировка, clawback). */
export function debit(wallet, { walletType = 'main', type, amountMinor, comment, ref, idempotencyKey, actorId }) {
  const r = postTransaction(wallet, {
    wallet_type: walletType, type, amount_minor: -Math.abs(Math.round(amountMinor)),
    comment, ref_type: ref?.type || null, ref_id: ref?.id ?? null,
    idempotency_key: idempotencyKey || null, created_by: actorId ?? null,
  });
  return r;
}

/** Сверка: баланс из леджера против денормализованного поля. */
export function reconcile(wallet, transactions) {
  const calc = { main: 0, bonus: 0 };
  for (const t of transactions) {
    if (t.user_id !== wallet.user_id) continue;
    calc[t.wallet_type === 'bonus' ? 'bonus' : 'main'] += Number(t.amount_minor || 0);
  }
  return {
    ledger: { main: calc.main, bonus: calc.bonus },
    stored: { main: Number(wallet.balance_main_minor || 0), bonus: Number(wallet.balance_bonus_minor || 0) },
    ok: calc.main === Number(wallet.balance_main_minor || 0) && calc.bonus === Number(wallet.balance_bonus_minor || 0),
    diff: { main: calc.main - Number(wallet.balance_main_minor || 0), bonus: calc.bonus - Number(wallet.balance_bonus_minor || 0) },
  };
}
