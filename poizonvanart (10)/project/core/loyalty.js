/**
 * PoizonVanart · core/loyalty.js
 * Уровни лояльности VIP: автоматическое снижение комиссии сервиса
 * 10% → 8% → 5% по мере накопления суммы ОПЛАЧЕННЫХ заказов.
 */

export const DEFAULT_TIERS = [
  { code: 'BASE',   name: 'Base',    commission: 0.10, threshold_rub_minor: 0,        perks: ['Стандартная поддержка'] },
  { code: 'SILVER', name: 'Silver',  commission: 0.08, threshold_rub_minor: 5_000_000, perks: ['Комиссия 8%', 'Приоритетный выкуп'] },
  { code: 'GOLD',   name: 'Gold VIP', commission: 0.05, threshold_rub_minor: 20_000_000, perks: ['Комиссия 5%', 'Личный менеджер', 'Бесплатная разгрузка'] },
];

function sortTiers(tiers) {
  return [...(tiers || DEFAULT_TIERS)].sort(
    (a, b) => Number(a.threshold_rub_minor ?? 0) - Number(b.threshold_rub_minor ?? 0)
  );
}

/** Текущий уровень по накопленной сумме (в минорных единицах RUB). */
export function tierForLifetimeValue(lifetimeValueRubMinor, tiers) {
  const list = sortTiers(tiers);
  let current = list[0];
  for (const t of list) {
    if (Number(lifetimeValueRubMinor) >= Number(t.threshold_rub_minor ?? 0)) current = t;
  }
  return current;
}

/** Ставка комиссии для уровня. */
export function commissionRateForTier(tierCode, tiers, fallbackRate = 0.1) {
  const list = sortTiers(tiers);
  const found = list.find((t) => t.code === tierCode);
  if (found) return Number(found.commission);
  return Number(list[0]?.commission ?? fallbackRate);
}

/**
 * Прогресс до следующего уровня — для красивого progress bar в ЛК.
 * @returns {{tier:Object,next:Object|null,progress:number,remainRubMinor:number}}
 */
export function tierProgress(lifetimeValueRubMinor, tiers) {
  const list = sortTiers(tiers);
  const tier = tierForLifetimeValue(lifetimeValueRubMinor, list);
  const idx = list.indexOf(tier);
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  if (!next) return { tier, next: null, progress: 1, remainRubMinor: 0 };
  const span = Number(next.threshold_rub_minor) - Number(tier.threshold_rub_minor);
  const done = Number(lifetimeValueRubMinor) - Number(tier.threshold_rub_minor);
  return {
    tier,
    next,
    progress: span > 0 ? Math.max(0, Math.min(1, done / span)) : 1,
    remainRubMinor: Math.max(0, Number(next.threshold_rub_minor) - Number(lifetimeValueRubMinor)),
  };
}

/**
 * Пересчёт уровня после оплаты заказа.
 * Возвращает новый уровень и флаг повышения (для уведомления/конфетти).
 */
export function applyPaidOrder(prevLifetimeRubMinor, orderTotalRubMinor, tiers) {
  const before = tierForLifetimeValue(prevLifetimeRubMinor, tiers);
  const lifetime = Number(prevLifetimeRubMinor) + Number(orderTotalRubMinor || 0);
  const after = tierForLifetimeValue(lifetime, tiers);
  return {
    lifetimeRubMinor: lifetime,
    tier: after.code,
    upgraded: after.code !== before.code,
    from: before.code,
    to: after.code,
  };
}
