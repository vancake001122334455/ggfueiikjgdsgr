/**
 * PoizonVanart · core/money.js
 * Деньги и валюты. ВСЕ расчёты — в целых минорных единицах (копейки / центы / 分).
 * Никаких float в деньгах. Округление — только на границе отображения.
 */

export const MINOR = { RUB: 100, BYN: 100, USD: 100, CNY: 100 };

export const CURRENCY = {
  RUB: { code: 'RUB', symbol: '₽', locale: 'ru-RU', label: 'Российский рубль', minorName: 'коп.' },
  BYN: { code: 'BYN', symbol: 'Br', locale: 'ru-BY', label: 'Белорусский рубль', minorName: 'коп.' },
  USD: { code: 'USD', symbol: '$', locale: 'en-US', label: 'Доллар США', minorName: '¢' },
  CNY: { code: 'CNY', symbol: '¥', locale: 'zh-CN', label: 'Китайский юань', minorName: '分' },
};

export const VIEW_CURRENCIES = ['BYN', 'RUB', 'USD'];

/** целое → decimal строка (1234 → "12.34") */
export function minorToDecimal(minor, currency = 'RUB') {
  const m = MINOR[currency] ?? 100;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  const int = Math.floor(abs / m);
  const frac = String(abs % m).padStart(String(m).length - 1, '0');
  return `${sign}${int}.${frac}`;
}

/** decimal строка/число → целое (12.34 → 1234) */
export function decimalToMinor(value, currency = 'RUB') {
  const m = MINOR[currency] ?? 100;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * m);
}

/** Перевод минорных единиц одной валюты в другую по effective-курсу к RUB. */
export function convertMinor(amountMinor, from, to, effectiveRatesToRUB) {
  if (from === to) return Math.round(amountMinor);
  const rf = effectiveRatesToRUB[from];
  const rt = effectiveRatesToRUB[to];
  if (!rf || !rt) throw new Error(`unknown currency rate ${from}/${to}`);
  // amount_in_rub = amountMinor/fromMinor * rateFrom ; result = rub/toRate * toMinor
  const fromMinor = MINOR[from] ?? 100;
  const toMinor = MINOR[to] ?? 100;
  const rub = (amountMinor / fromMinor) * rf;
  return Math.round((rub / rt) * toMinor);
}

/** Форматирование для UI. */
export function formatMoney(minor, currency = 'RUB', opts = {}) {
  const c = CURRENCY[currency] ?? CURRENCY.RUB;
  const value = Number(minorToDecimal(minor, currency));
  const nf = new Intl.NumberFormat(c.locale, {
    style: 'currency',
    currency: c.code,
    minimumFractionDigits: currency === 'CNY' ? 0 : 2,
    maximumFractionDigits: currency === 'CNY' ? 0 : 2,
  });
  try {
    return nf.format(value);
  } catch {
    return `${value.toFixed(2)} ${c.symbol}`;
  }
}

export function formatNumber(n, digits = 2, locale = 'ru-RU') {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
}

/**
 * Пропорциональное распределение целой суммы по долям без потери/дублирования единицы.
 * Возвращает массив целых, сумма которого ТОЧНО равна total.
 */
export function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rest; k++) floors[order[k % order.length].i] += 1;
  return floors;
}

export const roundMoney = (x) => Math.round(x);
export const sum = (arr) => arr.reduce((a, b) => a + b, 0);
