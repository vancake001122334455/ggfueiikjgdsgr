/**
 * PoizonVanart · views/home.js — лендинг: hero, преимущества, схема работы,
 * быстрый калькулятор, лояльность, гарантия, отзывы, TikTok-блок.
 */
import { h, icon, toast } from '../dom.js';
import { endpoints } from '../api.js';
import { state, money, moneyFrom, navigate, setCurrency } from '../state.js';

export async function renderHome(route) {
  const cfg = state.config || {};
  const wrap = h('div');

  wrap.appendChild(hero(cfg));
  wrap.appendChild(await catalogPreview());
  wrap.appendChild(quickCalcSection());
  wrap.appendChild(howItWorks());
  wrap.appendChild(await reviewsSection());

  if (route?.name === 'ref') void setCurrency;
  return wrap;
}

// ── HERO ───────────────────────────────────────────────────────────────────
function hero(cfg) {
  const tariffs = cfg.tariffs || {};
  return h('section', { class: 'hero' },
    h('div', { class: 'container' },
      h('div', { class: 'hero-grid' },
        h('div', {},
          h('span', { class: 'eyebrow' }, icon('shield', 14), 'Poizon Legit Check · 100% оригинал'),
          h('h1', {}, 'Оригинальные кроссовки и streetwear из Китая — ', h('em', {}, 'под ключ'), ' в Москву и Минск'),
          h('p', { class: 'lead' },
            'Выкупаем с Poizon, Dewu и Taobao на нашем складе в Китае, делаем фотоотчёт, проверяем подлинность и везём сборным карго. ',
            'Комиссия ', h('b', {}, `${Math.round((cfg.commissionBaseRate || 0.1) * 100)}%`),
            ' · доставка ', h('b', {}, `$${tariffs.RU_MOW?.usd_per_kg ?? 3.5}/кг`), ' в Москву и ',
            h('b', {}, `$${tariffs.BY_MSQ?.usd_per_kg ?? 4.5}/кг`), ' в Беларусь.'),
          h('div', { class: 'btn-group', style: { marginTop: '24px' } },
            h('button', { class: 'btn btn-primary btn-lg', onclick: () => window.openQuickOrderModal?.() }, icon('plus', 18), '⚡ Заказать с Poizon'),
            h('a', { class: 'btn btn-ghost btn-lg', href: '#/calc' }, icon('calc', 18), 'Калькулятор стоимости')),
          h('div', { class: 'hero-stats' },
            stat('22–28', 'дней до Москвы'),
            stat('30–35', 'дней до Минска'),
            stat('4 800+', 'выкупленных позиций'),
            stat('4.9', 'средняя оценка'))),
        h('div', {}, heroCard(cfg)))));
}
const stat = (v, l) => h('div', { class: 'hero-stat' }, h('b', {}, v), h('span', {}, l));

function heroCard(cfg) {
  const tariffs = cfg.tariffs || {};
  const rows = [
    ['Комиссия сервиса', `${Math.round((cfg.commissionBaseRate || 0.1) * 100)}% → 5% для VIP`],
    ['Москва', `$${tariffs.RU_MOW?.usd_per_kg ?? 3.5} / кг · ${tariffs.RU_MOW?.days_min ?? 22}–${tariffs.RU_MOW?.days_max ?? 28} дней`],
    ['Беларусь', `$${tariffs.BY_MSQ?.usd_per_kg ?? 4.5} / кг · ${tariffs.BY_MSQ?.days_min ?? 30}–${tariffs.BY_MSQ?.days_max ?? 35} дней`],
    ['Упаковка', `$${cfg.packaging?.basic ?? 3} базовая · $${cfg.packaging?.corners ?? 5} уголки · $${cfg.packaging?.crate ?? 6} обрешётка`],
    ['Страховка', `2% до $500 · 3% до $1000`],
    ['Разгрузка', `$3/место (бесплатно для VIP GOLD)`],
  ];
  return h('div', { class: 'card hero-preview-card', style: { background: 'linear-gradient(165deg, var(--card-2), var(--card))', position: 'relative', overflow: 'hidden' } },
    h('div', { class: 'hero-badge-row', style: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '16px', paddingBottom: '14px', borderBottom: '1px solid var(--border)' } },
      h('img', { src: '/img/avatar.png', alt: 'PoizonVanart', width: 48, height: 48, style: { borderRadius: '12px', boxShadow: '0 6px 20px rgba(212, 163, 115, 0.35)', flexShrink: '0' } }),
      h('div', {},
        h('h3', { style: { margin: 0, fontSize: '17px' } }, 'Тарифы «под ключ»'),
        h('div', { class: 'tiny muted' }, 'Poizon / Dewu · Официальный Legit Check'))),
    h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('div', { class: 'divider' }),
    h('div', { class: 'notice notice-info' }, icon('shield', 16),
      h('div', {}, h('b', {}, 'Все цены пересчитываются в вашу валюту. '),
        h('span', { class: 'small muted' }, 'Курс CNY и USD задаётся в админке: курс ЦБ + наценка. Выберите валюту в шапке — BYN / RUB / USD.'))));
}

// ── БЫСТРЫЙ КАЛЬКУЛЯТОР НА ГЛАВНОЙ ─────────────────────────────────────────
function quickCalcSection() {
  const cfg = state.config || {};
  const cats = Object.entries(cfg.defaultWeightsKg || { sneakers: 1.4 });
  const form = h('div', { class: 'grid grid-3' });
  const out = h('div', { class: 'card' });
  let current = { category: 'sneakers', priceCny: 1200, qty: 1, destination: 'RU_MOW', insured: false };

  const select = (label, options, value, oninput) => h('div', { class: 'field' }, h('label', {}, label),
    h('select', { class: 'select', onchange: (e) => oninput(e.target.value) },
      options.map(([v, t]) => h('option', { value: v, selected: v === String(value) }, t))));

  const catNames = {
    sneakers: '👟 Кроссовки и кеды',
    hoodie: '🧥 Худи и свитшоты',
    tshirt: '👕 Футболки и майки',
    jacket: '🧥 Куртки и пуховики',
    pants: '👖 Брюки и джинсы',
    shorts: '🩳 Шорты',
    bag: '👜 Сумки и рюкзаки',
    cap: '🧢 Кепки и шапки',
    accessories: '💍 Аксессуары и часы',
  };

  form.appendChild(select('Категория товара', cats.map(([k, w]) => [k, `${catNames[k] || k} (~${w} кг)`]), current.category, (v) => { current.category = v; calc(); }));
  form.appendChild(h('div', { class: 'field' }, h('label', {}, 'Цена в юанях (CNY)'),
    h('input', { class: 'input', type: 'number', min: 1, value: current.priceCny, oninput: (e) => { current.priceCny = Number(e.target.value) || 0; calc(); } })));
  form.appendChild(h('div', { class: 'field' }, h('label', {}, 'Количество'),
    h('input', { class: 'input', type: 'number', min: 1, max: 20, value: current.qty, oninput: (e) => { current.qty = Number(e.target.value) || 1; calc(); } })));
  form.appendChild(select('Куда доставляем', [['RU_MOW', 'Москва, РФ'], ['BY_MSQ', 'Минск, РБ']], current.destination, (v) => { current.destination = v; calc(); }));
  form.appendChild(h('div', { class: 'field' }, h('label', {}, 'Упаковка'),
    h('select', { class: 'select', onchange: (e) => { current.packaging = e.target.value; calc(); } },
      Object.entries(cfg.packaging || { basic: 3 }).map(([k, v]) => h('option', { value: k }, `${packName(k)} · $${v}`)))));
  form.appendChild(h('div', { class: 'field' }, h('label', {}, 'Страховка груза'),
    h('label', { class: 'switch', style: { marginTop: '8px' } },
      h('input', { type: 'checkbox', onchange: (e) => { current.insured = e.target.checked; calc(); } }),
      h('span', { class: 'track' }), h('span', { class: 'small' }, '2–3% от стоимости'))));

  async function calc() {
    out.innerHTML = '';
    out.appendChild(h('div', { class: 'row gap-3 muted small' }, h('div', { class: 'spinner' }), 'Считаем…'));
    try {
      const q = await endpoints.quote({
        items: [{ title: catNames[current.category] || 'Товар', category: current.category, priceCnyMinor: Math.round((current.priceCny || 0) * 100), qty: current.qty }],
        destination: current.destination, packaging: current.packaging || 'basic', insured: current.insured, currency: state.currency,
      });
      renderQuote(out, q);
    } catch (e) { out.textContent = e.message; }
  }

  const sec = h('section', { class: 'section' },
    h('div', { class: 'container' },
      h('div', { class: 'section-head' },
        h('div', {}, h('h2', {}, 'Умный калькулятор стоимости'),
          h('p', { class: 'muted' }, 'Цена товара + комиссия сервиса + логистика + упаковка + страховка. Итог — сразу в вашей валюте.')),
        h('a', { class: 'btn btn-ghost', href: '#/calc' }, 'Полный калькулятор', icon('arrow', 16))),
      h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
        h('div', { class: 'card' }, form),
        out)));
  calc();
  window.addEventListener('pv:currency-changed', () => calc());
  return sec;
}

export function packName(code) {
  return { none: 'Без упаковки', basic: 'Базовая', corners: 'Картонные уголки', crate: 'Жёсткая обрешётка' }[code] || code;
}

export function renderQuote(out, q) {
  out.innerHTML = '';
  if (!q) { out.appendChild(h('p', { class: 'muted small' }, 'Расчёт появится после добавления товаров.')); return; }
  const cur = q.currency;
  const b = q.breakdown;
  const rows = [
    ['Товар', `${(q.goodsCnyMinor / 100).toLocaleString('ru-RU')} ¥`, b.goods],
    [`Комиссия сервиса · ${Math.round(q.commissionRate * 100)}% (${q.tier})`, '', b.commission],
    [`Доставка · ${q.weight.billableKg} кг × $${q.tariffUsdPerKg}`, q.destinationLabel, b.shipping],
    [`Упаковка · ${q.packaging.places} место`, packName(q.packaging.code), b.packaging],
    ['Страховка', q.insurance.enabled ? `${(q.insurance.rate * 100).toFixed(0)}% от $${q.insurance.declaredUsd}` : 'не включена', b.insurance],
    ['Разгрузка', q.unloading.applies ? `$${q.unloading.usd}` : 'не применяется', b.unloading],
  ];
  out.appendChild(h('div', { class: 'card-head' }, icon('calc', 20), h('h3', {}, 'Расчёт «под ключ»'),
    h('span', { class: 'chip chip-brand', style: { marginLeft: 'auto' } }, `срок ${q.etaDays.min}–${q.etaDays.max} дней`)));
  out.appendChild(h('div', { class: 'breakdown' },
    rows.map(([label, sub, value]) => h('div', { class: 'brow' },
      h('span', { class: 'b-label' }, label, sub ? h('span', { class: 'tiny dim' }, `· ${sub}`) : null),
      h('span', { class: 'b-value' }, money(value, cur)))),
    q.packaging.savedUsd > 0 ? h('div', { class: 'brow saving' },
      h('span', { class: 'b-label' }, icon('gift', 15), 'Экономия на объединении упаковки'),
      h('span', { class: 'b-value' }, `−$${q.packaging.savedUsd}`)) : null,
    h('div', { class: 'brow total' }, h('span', { class: 'b-label' }, 'Итого к оплате'),
      h('span', { class: 'b-value' }, money(b.total, cur)))));
  out.appendChild(h('div', { class: 'notice notice-ok', style: { marginTop: '14px' } }, icon('check', 16),
    h('div', { class: 'small' }, 'Расчёт предварительный: после взвешивания на складе в Китае возможен перерасчёт по фактическому весу (разницу вернём на баланс или запросим доплату).')));
}

// ── КАК ЭТО РАБОТАЕТ ───────────────────────────────────────────────────────
function howItWorks() {
  const steps = [
    ['cart', 'Добавьте товары', 'Ссылкой с Poizon или из каталога. Укажите категорию, цвет, размер и цену в CNY.'],
    ['wallet', 'Оплатите заказ', 'Картой, СБП, с внутреннего баланса или комбинированно — бонусы тратятся первыми.'],
    ['camera', 'Выкупаем и снимаем отчёт', 'Наш склад в Китае выкупает товар, проверяет Legit Check и присылает фотоотчёт.'],
    ['truck', 'Везём и выдаём', 'Сборная посылка едет карго, вы получаете трек-номер и забираете в Москве или Минске.'],
  ];
  return h('section', { class: 'section' }, h('div', { class: 'container' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'Как это работает'), h('p', { class: 'muted' }, 'Четыре шага от ссылки в Poizon до коробки у вас в руках'))),
    h('div', { class: 'grid grid-4' }, steps.map(([ic, title, text], i) =>
      h('div', { class: 'card card-hover' },
        h('div', { class: 'row gap-3', style: { marginBottom: '10px' } },
          h('span', { class: 'logo-mark', style: { background: 'var(--surface-2)', color: 'var(--brand)', boxShadow: 'none' } }, icon(ic, 16)),
          h('span', { class: 'tiny dim mono' }, `0${i + 1}`)),
        h('h4', {}, title), h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, text))))));
}

// ── ПРЕВЬЮ КАТАЛОГА ────────────────────────────────────────────────────────
async function catalogPreview() {
  const sec = h('section', { class: 'section' }, h('div', { class: 'container' },
    h('div', { class: 'section-head' },
      h('div', {}, h('h2', {}, 'Что сейчас выкупают'), h('p', { class: 'muted' }, 'Цены показаны без комиссии и доставки — итог считает калькулятор')),
      h('a', { class: 'btn btn-ghost', href: '#/catalog' }, 'Весь каталог', icon('arrow', 16))),
    h('div', { class: 'grid grid-4', id: 'home-products' }, h('div', { class: 'skeleton', style: { height: '300px' } }))));
  try {
    const data = await endpoints.catalog({ featured: 1 });
    const box = sec.querySelector('#home-products');
    box.innerHTML = '';
    (Array.isArray(data) ? data : []).slice(0, 4).forEach((p) => box.appendChild(productCard(p)));
  } catch (e) { console.error(e); }
  return sec;
}

export function productCard(p) {
  return h('div', { class: 'product-card', style: { display: 'flex', flexDirection: 'column' } },
    h('a', { href: `#/p/${p.slug}`, style: { textDecoration: 'none', color: 'inherit', display: 'block' } },
      h('div', { class: 'product-media' },
        p.featured ? h('span', { class: 'tag-flag' }, '★ ХИТ') : null,
        h('span', { class: 'tag-verified' }, icon('shield', 11), '100% Legit'),
        h('img', { src: p.image || `/img/p/${p.sku}.svg`, alt: p.name, loading: 'lazy' })),
      h('div', { class: 'product-body' },
        h('span', { class: 'product-brand' }, p.brand),
        h('span', { class: 'product-name' }, p.name),
        h('div', { class: 'row gap-2 wrap' },
          h('span', { class: 'chip chip-sm' }, p.category),
          h('span', { class: 'chip chip-sm' }, `${p.weightEstKg || 1} кг`)),
        h('div', { class: 'product-price' },
          h('b', {}, money(p.priceView, p.currency)),
          h('span', { class: 'tiny dim' }, `${(p.priceCnyMinor / 100).toLocaleString('ru-RU')} ¥`)))),
    h('div', { style: { padding: '0 14px 14px', marginTop: 'auto' } },
      h('button', {
        class: 'btn btn-soft btn-sm btn-block',
        type: 'button',
        title: 'Заказать этот товар под ключ',
        onclick: (e) => {
          e.stopPropagation();
          e.preventDefault();
          window.openQuickOrderModal?.({
            title: p.name,
            category: p.categorySlug || 'sneakers',
            priceCny: Math.round(p.priceCnyMinor / 100),
            color: p.colors?.[0] || '',
            size: p.sizes?.[0] || '',
          });
        },
      }, icon('plus', 14), '⚡ Быстрый заказ')));
}

// ── ТАРИФЫ ─────────────────────────────────────────────────────────────────
function tariffsSection(cfg) {
  const t = cfg.tariffs || {};
  const card = (code, title, flag) => {
    const r = t[code] || {};
    return h('div', { class: 'card card-hover' },
      h('div', { class: 'row gap-3', style: { marginBottom: '12px' } }, h('span', { style: { fontSize: '24px' } }, flag), h('h3', {}, title)),
      h('div', { class: 'row spread', style: { marginBottom: '8px' } }, h('span', { class: 'muted small' }, 'Тариф карго'), h('b', { class: 'mono' }, `$${r.usd_per_kg ?? '—'} / кг`)),
      h('div', { class: 'row spread', style: { marginBottom: '8px' } }, h('span', { class: 'muted small' }, 'Срок'), h('b', { class: 'mono' }, `${r.days_min ?? '—'}–${r.days_max ?? '—'} дней`)),
      h('div', { class: 'row spread' }, h('span', { class: 'muted small' }, 'Пример: 2 кг'), h('b', { class: 'mono' }, moneyFrom(Math.round((r.usd_per_kg ?? 0) * 2 * 100), 'USD'))),
      h('a', { class: 'btn btn-soft btn-block', style: { marginTop: '16px' }, href: `#/calc?dest=${code}` }, 'Рассчитать для этого направления'));
  };
  return h('section', { class: 'section' }, h('div', { class: 'container' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'Логистика и тарифы'), h('p', { class: 'muted' }, 'Честные ставки карго без скрытых наценок'))),
    h('div', { class: 'grid grid-2' }, card('RU_MOW', 'Москва, Россия', '🇷🇺'), card('BY_MSQ', 'Минск, Беларусь', '🇧🇾')),
    h('div', { class: 'grid grid-3', style: { marginTop: '16px' } },
      miniCard('Упаковка', [`${cfg.packaging?.basic ?? 3}$ · базовая за место`, `${cfg.packaging?.corners ?? 5}$ · картонные уголки`, `${cfg.packaging?.crate ?? 6}$ · жёсткая обрешётка`, 'Объединяем товары в одну посылку — экономия $3–5']),
      miniCard('Страховка', ['2% при стоимости до $500', '3% от $500 до $1000', 'Полное возмещение при утере груза']),
      miniCard('Разгрузка', [`$3 за место, если объём < ${cfg.unloadingVolumeMaxM3 ?? 0.4} м³`, 'Для GOLD VIP — бесплатно', 'Считается автоматически в корзине']))));
}
const miniCard = (title, lines) => h('div', { class: 'card' }, h('h4', {}, title),
  h('ul', { class: 'checklist', style: { marginTop: '10px' } }, lines.map((l) => h('li', {}, l))));

// ── ЛОЯЛЬНОСТЬ ─────────────────────────────────────────────────────────────
function loyaltySection(cfg) {
  const tiers = cfg.loyaltyTiers || [];
  return h('section', { class: 'section' }, h('div', { class: 'container' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'Уровни лояльности VIP'),
      h('p', { class: 'muted' }, 'Комиссия сервиса снижается автоматически по мере накопления суммы оплаченных заказов'))),
    h('div', { class: 'grid grid-3' }, tiers.map((t, i) =>
      h('div', { class: `card card-hover ${i === tiers.length - 1 ? 'kpi-accent' : ''}` },
        h('div', { class: 'row spread' }, h('h3', {}, t.name), h('span', { class: 'chip chip-brand' }, `${Math.round(t.commission * 100)}%`)),
        h('p', { class: 'small muted', style: { margin: '8px 0 12px' } },
          t.threshold_rub_minor ? `от ${moneyFrom(t.threshold_rub_minor, 'RUB')} оплаченных заказов` : 'стартовый уровень'),
        h('ul', { class: 'checklist' }, (t.perks || []).map((p) => h('li', {}, p))))))));
}

// ── ГАРАНТИЯ ───────────────────────────────────────────────────────────────
function guaranteeTeaser() {
  return h('section', { class: 'section' }, h('div', { class: 'container' },
    h('div', { class: 'card', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px', alignItems: 'center' } },
      h('div', {},
        h('span', { class: 'eyebrow' }, icon('shield', 14), 'Гарантия подлинности'),
        h('h2', { style: { marginBottom: '12px' } }, 'Poizon Legit Check: сертификат, пломба, QR-метка'),
        h('p', { class: 'muted' }, 'Каждая позиция на Poizon проходит многоэтапную проверку подлинности: материал, швы, фурнитура, упаковка, серийные номера. К товару прилагается сертификат с пломбой и QR-кодом, который проверяется в приложении Poizon.'),
        h('ul', { class: 'checklist', style: { marginTop: '14px' } },
          h('li', {}, 'Не прошёл Legit Check — 100% возврат на баланс'),
          h('li', {}, 'Фотоотчёт со склада до отправки: коробка, пломба, сертификат, бирки'),
          h('li', {}, 'Возврат до отправки из Китая — по одному клику в кабинете'),
          h('li', {}, 'Страховка груза до полной стоимости')),
        h('div', { class: 'btn-group', style: { marginTop: '18px' } },
          h('a', { class: 'btn btn-primary', href: '#/guarantee' }, 'Подробнее о Legit Check'),
          h('a', { class: 'btn btn-ghost', href: '#/refund' }, 'Правила возврата'))),
      h('div', {}, h('img', { src: '/img/report/legit-check.svg?label=Legit+Check', alt: 'Проверка подлинности Poizon', style: { borderRadius: 'var(--r-lg)', border: '1px solid var(--border)' } })))));
}

// ── ОТЗЫВЫ ─────────────────────────────────────────────────────────────────
async function reviewsSection() {
  const sec = h('section', { class: 'section' }, h('div', { class: 'container' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'Отзывы и фото выкупленных товаров'), h('p', { class: 'muted' }, 'Реальные заказы наших клиентов'))),
    h('div', { class: 'grid grid-3', id: 'reviews-box' }, h('div', { class: 'skeleton', style: { height: '160px' } }))));
  try {
    const reviews = await endpoints.reviews();
    const box = sec.querySelector('#reviews-box');
    box.innerHTML = '';
    reviews.forEach((r) => box.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row gap-2', style: { marginBottom: '8px' } },
        h('span', { class: 'avatar' }, (r.author_name || 'К')[0]),
        h('div', {}, h('b', { class: 'small' }, r.author_name),
          h('div', { class: 'tiny', style: { color: 'var(--gold)' } }, '★'.repeat(r.rating || 5) + '☆'.repeat(5 - (r.rating || 5))))),
      h('p', { class: 'small muted', style: { margin: 0 } }, r.body))));
  } catch (e) { console.error(e); }
  return sec;
}

// ── TIKTOK / РЕФЕРАЛКА ─────────────────────────────────────────────────────
function growthTeaser() {
  const t = state.config?.tiktok || {};
  const r = state.config?.referral || {};
  return h('section', { class: 'section' }, h('div', { class: 'container' },
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'card kpi-accent' },
        h('div', { class: 'row gap-3', style: { marginBottom: '10px' } }, icon('tiktok', 22), h('h3', {}, 'Баланс за просмотры в TikTok')),
        h('p', { class: 'muted small' }, 'Снимите распаковку или обзор, поставьте хэштег ', h('b', {}, t.hashtag || '#poizonvanart'),
          ' и ссылку на сайт. Отправьте ссылку на видео — после модерации начислим бонус на счёт.'),
        h('div', { class: 'row gap-4', style: { margin: '16px 0' } },
          h('div', {}, h('b', { class: 'mono', style: { fontSize: '22px' } }, moneyFrom(t.reward_per_1000_views_rub_minor || 1500, 'RUB')),
            h('div', { class: 'tiny dim' }, 'за 1 000 просмотров')),
          h('div', {}, h('b', { class: 'mono', style: { fontSize: '22px' } }, '24 ч'), h('div', { class: 'tiny dim' }, 'сроки модерации'))),
        h('a', { class: 'btn btn-primary', href: state.user ? '#/account/tiktok' : '#/auth?mode=register' }, state.user ? 'Отправить видео' : 'Зарегистрироваться и зарабатывать')),
      h('div', { class: 'card' },
        h('div', { class: 'row gap-3', style: { marginBottom: '10px' } }, icon('gift', 22), h('h3', {}, 'Приведи друга')),
        h('p', { class: 'muted small' }, 'Поделитесь персональной ссылкой. Бонус начислим ', h('b', {}, 'только после того'),
          ', как друг оформит и полностью оплатит свой первый заказ — честно и без накруток.'),
        h('div', { class: 'row gap-4', style: { margin: '16px 0' } },
          h('div', {}, h('b', { class: 'mono', style: { fontSize: '22px' } }, `${r.percent || 3}%`), h('div', { class: 'tiny dim' }, 'от первого заказа друга')),
          h('div', {}, h('b', { class: 'mono', style: { fontSize: '22px' } }, moneyFrom(r.invitee_bonus_rub_minor || 20000, 'RUB')), h('div', { class: 'tiny dim' }, 'бонус приглашённому'))),
        h('a', { class: 'btn btn-ghost', href: state.user ? '#/account/referral' : '#/auth?mode=register' }, 'Получить ссылку')))));
}

export { toast };
