/**
 * PoizonVanart · core/pricing.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ЕДИНЫЙ движок расчёта стоимости «под ключ». Используется:
 *   • калькулятором на лендинге,
 *   • корзиной (пересчёт на каждое изменение),
 *   • чекаутом (снапшот в заказ),
 *   • админкой (перерасчёт по фактическому весу).
 *
 * Правила:
 *   — вход и выход в ЦЕЛЫХ минорных единицах;
 *   — все курсы передаются извне (config), функция чистая и детерминированная;
 *   — упаковка оптимизируется: N товаров = 1 место (экономия $3–5),
 *     если не включён флаг packEachSeparately;
 *   — страховка считается от объявленной стоимости товара в USD по тирам;
 *   — разгрузка $3/место начисляется только если объём < 0.4 м³.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { MINOR, apportion, convertMinor, roundMoney, sum } from './money.js';
import { commissionRateForTier } from './loyalty.js';

/** Собирает effective-курсы "валюта → RUB" из настроек (база ЦБ + наценка X%). */
export function resolveEffectiveRates(ratesConfig) {
  const out = {};
  for (const [code, r] of Object.entries(ratesConfig || {})) {
    const base = Number(r?.base ?? (code === 'RUB' ? 1 : 0));
    const markup = Number(r?.markup ?? 0);
    out[code] = base * (1 + markup / 100);
  }
  if (!out.RUB) out.RUB = 1;
  return out;
}

/** Сколько RUB (decimal) стоит 1 единица валюты. */
export function rateToRub(effectiveRates, currency) {
  const r = effectiveRates[currency];
  if (!r) throw new Error(`rate not configured: ${currency}`);
  return r;
}

/** Конвертация минорных единиц с опорой на effective-курсы к RUB. */
export function fx(amountMinor, from, to, effectiveRates) {
  return convertMinor(amountMinor, from, to, effectiveRates);
}

/** Объёмный вес (кг): (Д×Ш×В см) / divisor. */
export function volumetricWeightKg(dims, divisor = 5000) {
  if (!dims) return 0;
  const l = Number(dims.l || 0), w = Number(dims.w || 0), h = Number(dims.h || 0);
  if (l <= 0 || w <= 0 || h <= 0) return 0;
  return (l * w * h) / divisor;
}

export function volumeM3(dims) {
  if (!dims) return 0;
  const l = Number(dims.l || 0), w = Number(dims.w || 0), h = Number(dims.h || 0);
  return (l * w * h) / 1_000_000;
}

/** Тариф страховки по объявленной стоимости (в USD). */
export function insuranceRate(declaredUsd, tiers) {
  const list = Array.isArray(tiers) && tiers.length ? tiers : [
    { max_usd: 500, rate: 0.02 },
    { max_usd: 1000, rate: 0.03 },
    { max_usd: null, rate: 0.03 },
  ];
  for (const t of list) {
    if (t.max_usd === null || t.max_usd === undefined || declaredUsd <= Number(t.max_usd)) return Number(t.rate);
  }
  return Number(list[list.length - 1].rate);
}

/** Нормализация позиции корзины/калькулятора. */
function normalizeItem(raw, defaultWeights = {}) {
  const qty = Math.max(1, Math.round(Number(raw.qty ?? 1)));
  const category = raw.category_slug || raw.category || 'sneakers';
  const weightKg = Number(raw.weight_kg ?? raw.weight ?? defaultWeights[category] ?? 1);
  const priceCnyMinor = Math.max(0, Math.round(Number(raw.price_cny_minor ?? 0)));
  const dims = raw.dims_cm || raw.dims || null;
  return {
    id: raw.id ?? raw.cart_item_id ?? null,
    title: raw.title || raw.name || 'Товар',
    category,
    color: raw.color || null,
    size: raw.size || raw.size_eur || null,
    qty,
    priceCnyMinor,
    weightKg: Math.max(0, weightKg),
    dims,
    source: raw.source || 'catalog',
    externalUrl: raw.external_url || null,
  };
}

/**
 * Главная функция: полный расчёт котировки.
 *
 * @param {Object} input
 * @param {Array}  input.items              позиции корзины
 * @param {String} input.destination        'RU_MOW' | 'BY_MSQ'
 * @param {String} [input.packaging]        'none'|'basic'|'corners'|'crate'
 * @param {Boolean}[input.insured]          страховка груза
 * @param {Boolean}[input.packEachSeparately] отключить оптимизацию упаковки
 * @param {String} [input.currency]         валюта отображения ('BYN'|'RUB'|'USD')
 * @param {String} [input.tier]             уровень лояльности
 * @param {Number} [input.discountMinor]    промокод/скидка (в валюте отображения)
 * @param {Object} input.config             settings-конфиг (rates, tariffs, packaging, insurance, commission, loyalty)
 * @returns {Object} quote — полная разбивка в исходных валютах + в валюте отображения
 */
export function buildQuote(input = {}) {
  const cfg = input.config || {};
  const items = (input.items || []).map((i) => normalizeItem(i, cfg.defaultWeightsKg || {}));
  const destination = input.destination || 'RU_MOW';
  const packaging = input.packaging ?? 'basic';
  const insured = !!input.insured;
  const packEachSeparately = !!input.packEachSeparately;
  const currency = input.currency || 'RUB';
  const tier = input.tier || 'BASE';

  const rates = resolveEffectiveRates(cfg.rates || {});
  const tariff = (cfg.tariffs || {})[destination] || { usd_per_kg: 4.5, days_min: 22, days_max: 28, label: destination };
  const packagingPriceUsd = Number((cfg.packaging || { basic: 3 })[packaging] ?? 0);
  const unloadingUsd = Number(cfg.unloadingUsd ?? 3);
  const unloadingVolumeMax = Number(cfg.unloadingVolumeMaxM3 ?? 0.4);
  const volumetricDivisor = Number(cfg.volumetricDivisor ?? 5000);
  const minBillableKg = Number(cfg.minBillableKg ?? 0.5);

  // ── 1. Товары (CNY) ──────────────────────────────────────────────────────
  const lines = items.map((it) => {
    const totalCnyMinor = it.priceCnyMinor * it.qty;
    const totalWeightKg = it.weightKg * it.qty;
    const volWeightKg = volumetricWeightKg(it.dims, volumetricDivisor) * it.qty;
    const volM3 = volumeM3(it.dims) * it.qty;
    return { ...it, totalCnyMinor, totalWeightKg, volWeightKg, volM3 };
  });

  const goodsCnyMinor = sum(lines.map((l) => l.totalCnyMinor));
  const weightEstKg = roundTo(sum(lines.map((l) => l.totalWeightKg)), 3);
  const volumeM3Total = roundTo(sum(lines.map((l) => l.volM3)), 4);
  const volumeWeightKg = roundTo(sum(lines.map((l) => l.volWeightKg)), 3);

  // ── 2. Объявленная стоимость в USD (для страховки) ────────────────────────
  const goodsRubDecimal = (goodsCnyMinor / MINOR.CNY) * rates.CNY;
  const declaredUsd = rates.USD ? goodsRubDecimal / rates.USD : 0;
  const declaredUsdMinor = roundMoney(declaredUsd * MINOR.USD);

  // ── 3. Логистика ─────────────────────────────────────────────────────────
  const billableWeightKg = roundTo(Math.max(weightEstKg, volumeWeightKg, minBillableKg), 3);
  const shippingUsd = billableWeightKg * Number(tariff.usd_per_kg ?? 0);
  const shippingUsdMinor = roundMoney(shippingUsd * MINOR.USD);

  // ── 4. Упаковка (оптимизация мест) ────────────────────────────────────────
  const placesCount = packEachSeparately ? Math.max(1, lines.reduce((a, l) => a + l.qty, 0)) : 1;
  const packagingOptimizedUsd = placesCount * packagingPriceUsd;
  const packagingNaiveUsd = Math.max(1, lines.reduce((a, l) => a + l.qty, 0)) * packagingPriceUsd;
  const packagingUsdMinor = roundMoney(packagingOptimizedUsd * MINOR.USD);
  const packagingSavedUsd = roundTo(Math.max(0, packagingNaiveUsd - packagingOptimizedUsd), 2);

  // ── 5. Страховка ─────────────────────────────────────────────────────────
  const insRate = insured ? insuranceRate(declaredUsd, cfg.insuranceTiers) : 0;
  const insuranceUsd = insured ? declaredUsd * insRate : 0;
  const insuranceUsdMinor = roundMoney(insuranceUsd * MINOR.USD);

  // ── 6. Разгрузка ─────────────────────────────────────────────────────────
  const unloadingApplies = volumeM3Total > 0 && volumeM3Total < unloadingVolumeMax;
  const unloadingUsdMinor = unloadingApplies ? roundMoney(unloadingUsd * placesCount * MINOR.USD) : 0;

  // ── 7. Комиссия сервиса (зависит от уровня лояльности) ────────────────────
  const commissionRate = commissionRateForTier(tier, cfg.loyaltyTiers, cfg.commissionBaseRate ?? 0.1);

  // ── 8. Переводим всё в валюту отображения ─────────────────────────────────
  const toView = (minor, from) => fx(minor, from, currency, rates);

  const goodsView = toView(goodsCnyMinor, 'CNY');
  const commissionView = roundMoney(goodsView * commissionRate);
  const shippingView = toView(shippingUsdMinor, 'USD');
  const packagingView = toView(packagingUsdMinor, 'USD');
  const insuranceView = toView(insuranceUsdMinor, 'USD');
  const unloadingView = toView(unloadingUsdMinor, 'USD');
  const discountView = Math.min(Number(input.discountMinor ?? 0), goodsView + commissionView);

  const subtotalView = goodsView + commissionView + shippingView + packagingView + insuranceView + unloadingView;
  const totalView = Math.max(0, subtotalView - discountView);

  // ── 9. Построчная разбивка (для таблицы в корзине/чекауте) ────────────────
  const weights = lines.map((l) => l.totalCnyMinor || 1);
  const goodsByLine = apportion(goodsView, weights);
  const commissionByLine = apportion(commissionView, weights);
  const shippingByLine = apportion(shippingView, lines.map((l) => l.totalWeightKg || 0.001));

  const quoteLines = lines.map((l, i) => ({
    id: l.id,
    title: l.title,
    color: l.color,
    size: l.size,
    qty: l.qty,
    priceCnyMinor: l.priceCnyMinor,
    totalCnyMinor: l.totalCnyMinor,
    weightKg: l.weightKg,
    totalWeightKg: l.totalWeightKg,
    goods: goodsByLine[i],
    commission: commissionByLine[i],
    shipping: shippingByLine[i],
    lineTotal: goodsByLine[i] + commissionByLine[i] + shippingByLine[i],
  }));

  return {
    currency,
    destination,
    destinationLabel: tariff.label || destination,
    etaDays: { min: tariff.days_min ?? 22, max: tariff.days_max ?? 28 },
    tariffUsdPerKg: Number(tariff.usd_per_kg ?? 0),
    rates,
    commissionRate,
    tier,
    insurance: { enabled: insured, rate: insRate, declaredUsd: roundTo(declaredUsd, 2) },
    packaging: { code: packaging, priceUsd: packagingPriceUsd, places: placesCount, optimized: !packEachSeparately, savedUsd: packagingSavedUsd },
    unloading: { applies: unloadingApplies, usd: unloadingApplies ? unloadingUsd * placesCount : 0 },
    weight: { estKg: weightEstKg, volumetricKg: volumeWeightKg, billableKg: billableWeightKg, volumeM3: volumeM3Total },
    goodsCnyMinor,
    declaredUsdMinor,
    sourceMinor: {
      goodsCny: goodsCnyMinor,
      shippingUsd: shippingUsdMinor,
      packagingUsd: packagingUsdMinor,
      insuranceUsd: insuranceUsdMinor,
      unloadingUsd: unloadingUsdMinor,
    },
    breakdown: {
      goods: goodsView,
      commission: commissionView,
      shipping: shippingView,
      packaging: packagingView,
      insurance: insuranceView,
      unloading: unloadingView,
      discount: discountView,
      subtotal: subtotalView,
      total: totalView,
    },
    lines: quoteLines,
    itemCount: sum(lines.map((l) => l.qty)),
  };
}

/**
 * Мгновенная конвертация готовой котировки в другую валюту отображения.
 * Используется на клиенте для "переключения валюты без перезагрузки" (0 мс),
 * пока сервер пересчитывает авторитетную котировку по своим настройкам.
 * Итог пересобирается из конвертированных строк, чтобы сумма сходилась точно.
 */
export function convertQuote(quote, toCurrency) {
  if (!quote || quote.currency === toCurrency) return quote;
  const rates = quote.rates || {};
  const conv = (minor, from) => fx(minor, from, toCurrency, rates);
  const b = quote.breakdown;
  const lines = (quote.lines || []).map((l) => {
    const goods = conv(l.goods, quote.currency);
    const commission = conv(l.commission, quote.currency);
    const shipping = conv(l.shipping, quote.currency);
    return { ...l, goods, commission, shipping, lineTotal: goods + commission + shipping };
  });
  const breakdown = {
    goods: conv(b.goods, quote.currency),
    commission: conv(b.commission, quote.currency),
    shipping: conv(b.shipping, quote.currency),
    packaging: conv(b.packaging, quote.currency),
    insurance: conv(b.insurance, quote.currency),
    unloading: conv(b.unloading, quote.currency),
    discount: conv(b.discount, quote.currency),
  };
  breakdown.subtotal =
    breakdown.goods + breakdown.commission + breakdown.shipping +
    breakdown.packaging + breakdown.insurance + breakdown.unloading;
  breakdown.total = Math.max(0, breakdown.subtotal - breakdown.discount);
  return { ...quote, currency: toCurrency, breakdown, lines };
}

/**
 * Пересчёт заказа по фактическому весу (склад/админка) → доплата или возврат на баланс.
 * Дельта считается в USD (тариф $/кг) и приводится к валюте заказа по эффективному курсу.
 *
 * @param {Object} snapshot снапшот заказа: { input, destination, packaging, insured, currency, tier,
 *                          tariffUsdPerKg?, weightEstKg? }
 * @param {number} factWeightKg фактический вес после взвешивания
 * @param {Object} config pricingConfig()
 * @param {Object} [options] { thresholdRatio = 0.05 } — порог существенности отклонения
 */
export function recalcByFactWeight(snapshot, factWeightKg, config, options = {}) {
  const thresholdRatio = Number(options.thresholdRatio ?? 0.05);
  const input = snapshot?.input ?? snapshot ?? {};
  const items = Array.isArray(input.items) ? input.items : [];
  const base = buildQuote({ ...input, items: items.map((i) => ({ ...i })), config });

  const estKg = Number(snapshot?.weightEstKg ?? base.weight.estKg);
  const factKg = Number(factWeightKg || 0);
  const deltaWeightKg = roundTo(factKg - estKg, 3);
  const deviationRatio = estKg > 0 ? Math.abs(deltaWeightKg) / estKg : 0;
  const requiresRecalc = deviationRatio > thresholdRatio;

  const tariffUsdPerKg = Number(snapshot?.tariffUsdPerKg ?? base.tariffUsdPerKg ?? 0);
  const deltaUsdMinor = roundMoney(deltaWeightKg * tariffUsdPerKg * MINOR.USD);
  const currency = base.currency;
  const deltaMinor = fx(deltaUsdMinor, 'USD', currency, base.rates);

  return {
    estKg,
    factKg,
    deltaWeightKg,
    deviationRatio: roundTo(deviationRatio, 4),
    requiresRecalc,
    tariffUsdPerKg,
    deltaUsdMinor,
    deltaMinor,
    currency,
    needsExtraPayment: deltaMinor > 0,
    refundMinor: deltaMinor < 0 ? -deltaMinor : 0,
  };
}

function roundTo(n, digits) {
  const p = 10 ** digits;
  return Math.round(Number(n) * p) / p;
}

export default { buildQuote, convertQuote, resolveEffectiveRates, fx, insuranceRate, volumetricWeightKg };
