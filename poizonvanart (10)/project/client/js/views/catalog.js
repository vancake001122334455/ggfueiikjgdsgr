/**
 * PoizonVanart · views/catalog.js — каталог и карточка товара.
 */
import { h, icon, toast, spinner, emptyState } from '../dom.js';
import { endpoints } from '../api.js';
import { state, money, refreshCart, navigate } from '../state.js';
import { productCard } from './home.js';

export async function renderCatalog(route) {
  const q = route.query || {};
  const wrap = h('div', { class: 'container' });
  const filters = { q: q.q || '', category: q.category || '', brand: q.brand || '', sort: q.sort || '' };

  const listBox = h('div', { class: 'grid grid-auto' }, spinner('Загружаем каталог…'));
  const meta = h('div', { class: 'muted small' });

  const searchInput = h('input', {
    class: 'input', placeholder: 'Поиск: Nike, AJ1, худи Essentials…', value: filters.q, style: { maxWidth: '340px' },
    oninput: debounce((e) => { filters.q = e.target.value; load(); }, 300),
  });
  const catBox = h('div', { class: 'pill-tabs' });
  const brandSelect = h('select', { class: 'select', style: { maxWidth: '200px' }, onchange: (e) => { filters.brand = e.target.value; load(); } });
  const sortSelect = h('select', {
    class: 'select', style: { maxWidth: '200px' }, onchange: (e) => { filters.sort = e.target.value; load(); },
  }, [
    ['По популярности', ''], ['Сначала дешевле', 'price_asc'], ['Сначала дороже', 'price_desc'],
  ].map(([t, v]) => h('option', { value: v, selected: v === filters.sort }, t)));

  wrap.appendChild(h('div', { class: 'section-head' },
    h('div', {}, h('h1', {}, 'Каталог'), h('p', { class: 'muted' }, 'Товары, которые мы уже выкупаем с Poizon, Dewu и Taobao. Цены пересчитаны в ', h('b', {}, state.currency))),
    h('button', { class: 'btn btn-primary', onclick: () => window.openQuickOrderModal?.() }, icon('plus', 16), 'Заказать по своей ссылке')));

  const quickBar = h('div', {
    class: 'card',
    style: {
      background: 'linear-gradient(135deg, var(--card-1), var(--card-2))',
      border: '1px solid var(--brand)',
      padding: '16px 20px',
      marginBottom: '20px',
      borderRadius: 'var(--r-md)',
    },
  },
    h('div', { class: 'row spread gap-3 wrap', style: { alignItems: 'center' } },
      h('div', { class: 'grow' },
        h('div', { class: 'row gap-2', style: { alignItems: 'center', marginBottom: '4px' } },
          h('span', { class: 'chip chip-brand chip-sm' }, '⚡ Автопарсер Poizon'),
          h('b', { class: 'small' }, 'Нашли кроссовки или вещь на Poizon / Dewu?')),
        h('div', { class: 'tiny muted' }, 'Вставьте ссылку dw4.co или артикул (например DD1391-100) — моментально покажем размерную сетку, цены и экономию до 60% vs магазины РФ/РБ.')),
      h('div', { class: 'row gap-2', style: { minWidth: '320px', flexGrow: 1, maxWidth: '520px' } },
        h('input', {
          class: 'input',
          placeholder: 'dw4.co/t/… или артикул DD1391-100',
          id: 'catalogParserInput',
          onkeydown: (e) => {
            if (e.key === 'Enter') {
              const val = e.target.value.trim();
              if (val) window.openQuickOrderModal?.({ url: val });
            }
          },
        }),
        h('button', {
          class: 'btn btn-primary nowrap',
          onclick: () => {
            const input = document.getElementById('catalogParserInput');
            const val = input?.value?.trim() || '';
            window.openQuickOrderModal?.({ url: val });
          },
        }, icon('calc', 16), 'Рассчитать'))));

  wrap.appendChild(quickBar);
  wrap.appendChild(h('div', { class: 'row gap-3 wrap', style: { marginBottom: '16px' } }, searchInput, brandSelect, sortSelect));
  wrap.appendChild(catBox);
  wrap.appendChild(h('div', { class: 'row spread', style: { margin: '14px 0' } }, meta));
  wrap.appendChild(listBox);

  let categories = [], brands = [];

  async function load() {
    listBox.innerHTML = '';
    listBox.appendChild(spinner());
    try {
      const rows = await endpoints.catalog(filters);
      const items = Array.isArray(rows) ? rows : [];
      const metaInfo = rows?.__payload?.meta || {};
      categories = metaInfo.categories || [];
      brands = metaInfo.brands || [];
      renderCats();
      renderBrands();
      listBox.innerHTML = '';
      meta.textContent = `Найдено: ${items.length}`;
      if (!items.length) { listBox.appendChild(emptyState('Ничего не найдено', 'Попробуйте изменить фильтры или добавьте товар по ссылке с Poizon', h('a', { class: 'btn btn-primary', href: '#/cart' }, 'Добавить по ссылке'))); return; }
      items.forEach((p) => listBox.appendChild(productCard(p)));
    } catch (e) {
      listBox.innerHTML = '';
      listBox.appendChild(h('div', { class: 'notice notice-warn' }, e.message));
    }
  }

  function renderCats() {
    catBox.innerHTML = '';
    const all = h('button', { 'aria-pressed': String(!filters.category), onclick: () => { filters.category = ''; load(); } }, 'Все');
    catBox.appendChild(all);
    categories.forEach((c) => catBox.appendChild(h('button', {
      'aria-pressed': String(filters.category === c.slug),
      onclick: () => { filters.category = filters.category === c.slug ? '' : c.slug; load(); },
    }, `${c.name} · ${c.avg_weight_kg} кг`)));
  }
  function renderBrands() {
    const current = brandSelect.value;
    brandSelect.innerHTML = '';
    brandSelect.appendChild(h('option', { value: '' }, 'Все бренды'));
    brands.forEach((b) => brandSelect.appendChild(h('option', { value: b.slug, selected: filters.brand === b.slug }, b.name)));
    if (current) brandSelect.value = current;
  }

  await load();
  const onCurChanged = () => load();
  window.addEventListener('pv:currency-changed', onCurChanged);
  return wrap;
}

// ── КАРТОЧКА ТОВАРА ────────────────────────────────────────────────────────
export async function renderProduct(route) {
  const wrap = h('div', { class: 'container' });
  const p = await endpoints.product(route.params[0]);
  const colors = [...new Set(p.variants.map((v) => v.color))];
  const sizes = [...new Set(p.variants.map((v) => v.sizeEur).filter(Boolean))];
  let color = colors[0], size = sizes[0], qty = 1;

  const variantBox = h('div');
  const priceBox = h('div');
  const totalBox = h('div');
  let selectedCity = 'RU_MOW';
  const estimateBox = h('div', { class: 'notice notice-info', style: { marginTop: '14px', flexDirection: 'column', gap: '8px' } });

  const currentVariant = () => p.variants.find((v) => v.color === color && v.sizeEur === size)
    || p.variants.find((v) => v.color === color) || p.variants[0];

  function refresh() {
    const v = currentVariant();
    priceBox.innerHTML = '';
    priceBox.appendChild(h('div', { class: 'row gap-3 wrap', style: { alignItems: 'baseline' } },
      h('b', { style: { fontSize: '32px', letterSpacing: '-.03em' } }, money(v.priceView, p.currency)),
      h('span', { class: 'muted mono' }, `${(v.priceCnyMinor / 100).toLocaleString('ru-RU')} ¥`),
      h('span', { class: 'chip' }, `${v.weightKg} кг`),
      v.stockStatus === 'low' ? h('span', { class: 'chip chip-warn' }, 'мало на складе') : h('span', { class: 'chip chip-ok' }, 'в наличии')));
    
    // Расчет под ключ
    const destTariff = state.config?.tariffs?.[selectedCity] || { usd_per_kg: 3.5, label: 'Москва' };
    const rates = state.rates || { CNY: 13.2355, USD: 94.248, BYN: 33.698 };
    const goodsRub = Math.round(v.priceCnyMinor * (rates.CNY || 13.2355) / 100);
    const commRub = Math.round(goodsRub * 0.1);
    const weightKg = v.weightKg || p.weightEstKg || 1.2;
    const shipUsd = weightKg * destTariff.usd_per_kg + 3;
    const shipRub = Math.round(shipUsd * (rates.USD || 94.248));
    const totalRub = goodsRub + commRub + shipRub;
    const cur = state.currency || p.currency || 'RUB';
    const totalView = cur === 'RUB' ? totalRub : Math.round(totalRub / (rates[cur] || 1));

    estimateBox.innerHTML = '';
    estimateBox.appendChild(h('div', { class: 'row spread wrap gap-2', style: { width: '100%', alignItems: 'center' } },
      h('div', { class: 'small' }, icon('truck', 15), ' Итого «под ключ» с доставкой в:'),
      h('div', { class: 'segmented' },
        ['RU_MOW', 'BY_MSQ'].map((code) => h('button', {
          'aria-pressed': String(selectedCity === code),
          type: 'button',
          onclick: () => { selectedCity = code; refresh(); },
        }, code === 'RU_MOW' ? 'Москву' : 'Минск')))));
    estimateBox.appendChild(h('div', { class: 'row spread wrap gap-2', style: { width: '100%', alignItems: 'baseline' } },
      h('span', { class: 'tiny muted' }, `Товар + комиссия 10% + карго ${weightKg} кг + упаковка`),
      h('b', { style: { fontSize: '18px', color: 'var(--brand)' } }, money(totalView * 100, cur))));

    const mobPrice = wrap.querySelector('#mobile-bar-price');
    if (mobPrice) mobPrice.textContent = money(v.priceView, cur);

    variantBox.innerHTML = '';
    variantBox.appendChild(h('div', { class: 'field' }, h('label', {}, 'Цвет'),
      h('div', { class: 'pill-tabs' }, colors.map((c) => h('button', { 'aria-pressed': String(c === color), onclick: () => { color = c; refresh(); } }, c)))));
    variantBox.appendChild(h('div', { class: 'field' }, h('label', {}, 'Размер'),
      h('div', { class: 'pill-tabs' }, sizes.map((s) => h('button', {
        'aria-pressed': String(s === size),
        onclick: () => { size = s; refresh(); },
        disabled: !p.variants.some((v) => v.color === color && v.sizeEur === s),
      }, s))),
      h('a', { class: 'hint', href: '#/size-guide', style: { marginTop: '6px' } }, 'Не уверены в размере? Откройте размерный гид →')));
    void totalBox;
  }

  const addToCart = async () => {
    if (!state.user) { toast('Нужна авторизация', 'Войдите, чтобы добавить товар в корзину', 'info'); return navigate('#/auth'); }
    try {
      state.cart = await endpoints.cartAdd({ source: 'catalog', variantId: currentVariant().id, qty });
      await refreshCart();
      toast('Добавлено в корзину', `${p.name} · ${color} · ${size}`, 'ok');
      navigate('#/cart');
    } catch (e) { toast('Ошибка', e.message, 'err'); }
  };

  wrap.appendChild(h('div', { class: 'row gap-2 small muted', style: { marginBottom: '16px' } },
    h('a', { href: '#/' }, 'Главная'), ' / ', h('a', { href: '#/catalog' }, 'Каталог'), ' / ', h('span', {}, p.name)));

  wrap.appendChild(h('div', { class: 'grid grid-2', style: { alignItems: 'start', gap: '32px' } },
    h('div', {},
      h('img', { src: p.images?.[0] || `/img/p/${p.sku}.svg`, alt: p.name, style: { borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', width: '100%' } }),
      h('div', { class: 'row gap-2', style: { marginTop: '12px' } },
        h('span', { class: 'chip chip-brand' }, p.externalSource),
        p.externalUrl ? h('a', { class: 'chip', href: p.externalUrl, target: '_blank', rel: 'noopener' }, 'Открыть на площадке ↗') : null,
        h('span', { class: 'chip' }, `Артикул ${p.sku}`))),
    h('div', {},
      h('span', { class: 'product-brand' }, p.brand),
      h('h1', { style: { fontSize: '30px', margin: '6px 0 10px' } }, p.name),
      p.nameCn ? h('div', { class: 'muted small', style: { marginBottom: '12px' } }, p.nameCn) : null,
      priceBox,
      h('div', { class: 'divider' }),
      variantBox,
      estimateBox,
      h('div', { class: 'field' }, h('label', {}, 'Количество'),
        h('div', { class: 'row gap-2' },
          h('button', { class: 'icon-btn', onclick: () => { qty = Math.max(1, qty - 1); qtyInput.value = qty; } }, '−'),
          h('input', { class: 'input', style: { width: '80px', textAlign: 'center' }, type: 'number', min: 1, max: 20, value: 1, id: 'qty', oninput: (e) => { qty = Math.max(1, Number(e.target.value) || 1); } }),
          h('button', { class: 'icon-btn', onclick: () => { qty = Math.min(20, qty + 1); qtyInput.value = qty; } }, '+'))),
      h('div', { class: 'btn-group', style: { marginTop: '18px' } },
        h('button', {
          class: 'btn btn-primary btn-lg grow',
          onclick: () => {
            const v = currentVariant();
            window.openQuickOrderModal?.({
              title: p.name,
              category: p.categorySlug || 'sneakers',
              priceCny: Math.round(v.priceCnyMinor / 100),
              color,
              size,
            });
          },
        }, icon('lock', 18), '⚡ Заказать сейчас'),
        h('button', { class: 'btn btn-soft btn-lg', onclick: addToCart }, icon('cart', 18), 'В корзину'),
        h('button', { class: 'btn btn-ghost btn-lg', title: 'В избранное', onclick: async () => {
          if (!state.user) return navigate('#/auth');
          try { await endpoints.addFavorite({ variantId: currentVariant().id }); toast('В избранном', 'Уведомим при падении цены или курса', 'ok'); }
          catch (e) { toast('Уже в избранном', e.message, 'info'); }
        } }, icon('heart', 18))),
      h('p', { class: 'muted small', style: { marginTop: '16px' } }, p.description))));

  const qtyInput = wrap.querySelector('#qty');

  // доставка и гарантия
  wrap.appendChild(h('div', { class: 'grid grid-3', style: { marginTop: '32px' } },
    h('div', { class: 'card' }, h('h4', {}, icon('truck', 17), ' Доставка'),
      h('ul', { class: 'checklist', style: { marginTop: '10px' } },
        h('li', {}, `Москва: $${state.config?.tariffs?.RU_MOW?.usd_per_kg}/кг, ${state.config?.tariffs?.RU_MOW?.days_min}–${state.config?.tariffs?.RU_MOW?.days_max} дней`),
        h('li', {}, `Беларусь: $${state.config?.tariffs?.BY_MSQ?.usd_per_kg}/кг, ${state.config?.tariffs?.BY_MSQ?.days_min}–${state.config?.tariffs?.BY_MSQ?.days_max} дней`))),
    h('div', { class: 'card' }, h('h4', {}, icon('shield', 17), ' Legit Check'),
      h('ul', { class: 'checklist', style: { marginTop: '10px' } },
        h('li', {}, 'Сертификат и пломба Poizon'),
        h('li', {}, 'Фотоотчёт до отправки'),
        h('li', {}, '100% возврат, если не прошёл проверку'))),
    h('div', { class: 'card' }, h('h4', {}, icon('ruler', 17), ' Размер'),
      sizeGuideWidget(p))));

  const mobileBar = h('div', { class: 'mobile-action-bar' },
    h('div', {},
      h('div', { class: 'tiny muted' }, 'Цена товара'),
      h('b', { id: 'mobile-bar-price', style: { fontSize: '16px', color: 'var(--brand)' } }, money(currentVariant().priceView, p.currency))),
    h('div', { class: 'row gap-2' },
      h('button', {
        class: 'btn btn-primary btn-sm',
        onclick: () => {
          const v = currentVariant();
          window.openQuickOrderModal?.({
            title: p.name,
            category: p.categorySlug || 'sneakers',
            priceCny: Math.round(v.priceCnyMinor / 100),
            color,
            size,
          });
        },
      }, '⚡ Заказать'),
      h('button', { class: 'btn btn-soft btn-sm', onclick: addToCart }, icon('cart', 16))));
  wrap.appendChild(mobileBar);

  refresh();

  const onProductCur = async () => {
    try {
      const updated = await endpoints.product(route.params[0]);
      Object.assign(p, updated);
      refresh();
    } catch {}
  };
  window.addEventListener('pv:currency-changed', onProductCur);

  return wrap;
}

function sizeGuideWidget(p) {
  const g = p.sizeGuide;
  if (!g) return h('p', { class: 'small muted' }, 'Для этого товара гид появится позже.');
  if (g.kind === 'footwear') {
    const input = h('input', { class: 'input', type: 'number', placeholder: 'например, 265', style: { maxWidth: '130px' } });
    const out = h('div', { class: 'small', style: { marginTop: '8px' } });
    const btn = h('button', {
      class: 'btn btn-ghost btn-sm', onclick: () => {
        const mm = Number(input.value);
        if (!mm) { out.textContent = 'Введите длину стопы в мм'; return; }
        const row = g.rows.reduce((b, r) => Math.abs(Number(r.foot_mm) - mm) < Math.abs(Number(b.foot_mm) - mm) ? r : b, g.rows[0]);
        out.innerHTML = '';
        out.appendChild(h('b', {}, `EUR ${row.eur} · US ${row.us_m} · CN ${row.cn}`));
        out.appendChild(h('div', { class: 'tiny muted' }, `ближайший к ${mm} мм`));
      },
    }, 'Подобрать');
    return h('div', {}, h('div', { class: 'row gap-2' }, input, btn), out, h('p', { class: 'tiny muted', style: { marginTop: '8px' } }, g.notes));
  }
  return h('div', {}, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Размер'), h('th', {}, 'Рост'), h('th', {}, 'Вес'))),
    h('tbody', {}, g.rows.map((r) => h('tr', {}, h('td', {}, h('b', {}, r.size)), h('td', {}, r.height_cm), h('td', {}, r.weight_kg)))))),
  h('p', { class: 'tiny muted', style: { marginTop: '8px' } }, g.notes));
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
