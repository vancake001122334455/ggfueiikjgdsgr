/**
 * PoizonVanart · core/pnl.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Финансовый учёт P&L в 3 валютах (RUB / BYN / USD).
 *
 *   Приход (Revenue)  — фактически полученные деньги клиента (RUB/BYN)
 *   Закупка (COGS)    — оплата товара на Poizon (CNY) по курсу закупки
 *   Карго (Logistics) — счёт перевозчика (USD)
 *   Прочее (Extra)    — упаковка / страховка / разгрузка (USD)
 *   Эквайринг         — комиссия платёжного провайдера
 *   Валовая маржа     = Revenue − COGS − Cargo − Extra − Acquiring
 *   Чистая прибыль    = Маржа − OPEX
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { MINOR, convertMinor, sum } from './money.js';
import { resolveEffectiveRates } from './pricing.js';

/** Приведение любой суммы к отчётной валюте (в минорных единицах). */
export function toReport(minor, from, to, effectiveRates) {
  return convertMinor(minor, from, to, effectiveRates);
}

/**
 * P&L одного заказа в отчётной валюте.
 * @param {Object} order  { revenue_minor, revenue_currency, cogs_cny_minor, cargo_usd_minor,
 *                          extra_usd_minor, acquiring_minor, commission_minor, total_minor, currency }
 * @param {Object} config { rates (raw settings), opexMinor? }
 */
export function orderPnl(order, config, reportCurrency = 'RUB') {
  const rates = resolveEffectiveRates(config.rates || {});
  const revCur = order.revenue_currency || order.currency || 'RUB';
  const revenue = toReport(Number(order.revenue_minor ?? order.paid_minor ?? 0), revCur, reportCurrency, rates);
  const cogs = toReport(Number(order.cogs_cny_minor ?? order.goods_cny_minor ?? 0), 'CNY', reportCurrency, rates);
  const cargo = toReport(Number(order.cargo_usd_minor ?? 0), 'USD', reportCurrency, rates);
  const extra = toReport(Number(order.extra_usd_minor ?? 0), 'USD', reportCurrency, rates);
  const acquiring = toReport(Number(order.acquiring_fee_minor ?? 0), revCur, reportCurrency, rates);
  const gross = revenue - cogs - cargo - extra - acquiring;
  const marginPct = revenue > 0 ? gross / revenue : 0;

  return {
    currency: reportCurrency,
    orderId: order.id ?? null,
    orderNo: order.order_no ?? null,
    revenue, cogs, cargo, extra, acquiring,
    commission: toReport(Number(order.commission_minor ?? 0), order.currency || revCur, reportCurrency, rates),
    gross,
    marginPct,
  };
}

/** Агрегированный P&L по набору заказов + OPEX. */
/**
 * В P&L попадают только полностью оплаченные заказы.
 * Фильтр живёт в ядре, чтобы любой вызывающий код (API, воркер, отчёт) получил одинаковый результат.
 */
export const isPnlRelevant = (o) =>
  !o || o.payment_status === undefined || o.payment_status === 'succeeded';

export function aggregatePnl(orders, config, reportCurrency = 'RUB', opexMinor = 0) {
  const paid = (orders || []).filter(isPnlRelevant);
  const rows = paid.map((o) => orderPnl(o, config, reportCurrency));
  const totals = {
    currency: reportCurrency,
    orders: rows.length,
    revenue: sum(rows.map((r) => r.revenue)),
    cogs: sum(rows.map((r) => r.cogs)),
    cargo: sum(rows.map((r) => r.cargo)),
    extra: sum(rows.map((r) => r.extra)),
    acquiring: sum(rows.map((r) => r.acquiring)),
    commission: sum(rows.map((r) => r.commission)),
  };
  totals.gross = totals.revenue - totals.cogs - totals.cargo - totals.extra - totals.acquiring;
  totals.opex = Math.round(Number(opexMinor || 0));
  totals.net = totals.gross - totals.opex;
  totals.marginPct = totals.revenue > 0 ? totals.gross / totals.revenue : 0;
  totals.netPct = totals.revenue > 0 ? totals.net / totals.revenue : 0;
  return { totals, rows };
}

/** Один и тот же отчёт сразу в 3 валютах (для переключателя в админке). */
export function multiCurrencyPnl(orders, config, opexByCurrency = {}) {
  const out = {};
  for (const cur of ['RUB', 'BYN', 'USD']) {
    out[cur] = aggregatePnl(orders, config, cur, opexByCurrency[cur] || 0);
  }
  return out;
}

/** Группировка по дням для графика. */
export function pnlByDay(rows, keyFn = (r) => (r.paid_at || r.created_at || '').slice(0, 10)) {
  const map = new Map();
  for (const r of rows || []) {
    const day = keyFn(r) || 'unknown';
    if (!map.has(day)) map.set(day, { day, revenue: 0, cogs: 0, cargo: 0, extra: 0, acquiring: 0, gross: 0, net: 0, orders: 0 });
    const b = map.get(day);
    b.revenue += Number(r.revenue || 0);
    b.cogs += Number(r.cogs || 0);
    b.cargo += Number(r.cargo || 0);
    b.extra += Number(r.extra || 0);
    b.acquiring += Number(r.acquiring || 0);
    b.gross += Number(r.gross || 0);
    b.orders += 1;
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Экспорт отчёта в CSV (Excel-совместимый, с BOM для кириллицы). */
export function toCsv(rows, columns) {
  const head = columns.map((c) => c.title).join(';');
  const body = rows
    .map((r) => columns.map((c) => csvCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(';'))
    .join('\n');
  return `\uFEFF${head}\n${body}\n`;
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  return /[;"\n]/.test(s) ? `"${s}"` : s;
}

export { MINOR };
