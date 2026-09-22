/**
 * PoizonVanart · views/cart.js
 * Мульти-корзина: несколько товаров, автоматический пересчёт логистики и комиссии,
 * оптимизация упаковки (объединение в 1 место), «Поделиться корзиной».
 */
import { h, icon, toast, spinner, emptyState, copyToClipboard, modal, confirmDialog } from '../dom.js';
import { endpoints } from '../api.js';
import { state, money, refreshCart, navigate, setCurrency } from '../state.js';
import { renderQuote, packName } from './home.js';

export async function renderCart(route) {
  const shareToken = route.name === 'shared-cart' ? route.params[0] : null;
  const wrap = h('div', { class: 'container' });
  const listBox = h('div', { class: 'stack gap-3' });
  const summaryBox = h('div', { class: 'card', style: { position: 'sticky', top: '86px' } });
  let cart = null;
  let readOnly = false;
  let loadError = null;

  async function load() {
    loadError = null;
    listBox.innerHTML = ''; listBox.appendChild(spinner('Загружаем корзину…'));
    try {
      cart = shareToken ? await endpoints.sharedCart(shareToken) : await endpoints.cart();
    } catch (e) {
      // битый/закрытый токен общей корзины или сетевой сбой — показываем понятное
      // состояние вместо вечного спиннера (раньше здесь был unhandled rejection)
      cart = null;
      loadError = e;
    }
    if (!cart) cart = { items: [], groups: [], totals: null, owner: null, readOnly: !!shareToken };
    readOnly = !!cart.readOnly || !!shareToken;
    if (!shareToken) state.cart = cart;
    render();
  }

  function render() {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'section-head' },
      h('div', {}, h('h1', {}, shareToken ? 'Общая корзина' : 'Корзина'),
        h('p', { class: 'muted' },
          loadError ? 'Не удалось загрузить данные'
            : shareToken ? `Корзина пользователя ${cart.owner?.name || ''} · только просмотр`
              : `${cart.items?.length || 0} позиц. · единый мульти-заказ с общим номером`)),
      shareToken && !loadError ? h('button', { class: 'btn btn-primary', onclick: importShared }, icon('download', 16), 'Скопировать себе') : h('div', { class: 'btn-group' },
        h('button', { class: 'btn btn-ghost', onclick: shareModal }, icon('share', 16), 'Поделиться'),
        h('a', { class: 'btn btn-soft', href: '#/catalog' }, icon('plus', 16), 'Добавить товар'))));

    if (shareToken) {
      wrap.appendChild(h('div', { class: 'notice notice-info', style: { marginBottom: '16px' } }, icon('users', 16),
        h('div', { class: 'small' }, 'Совместный заказ: вы можете скопировать эти позиции в свою корзину и оформить единый мульти-заказ. Упаковка объединяется в одно место — это экономит $3–5.')));
    }

    wrap.appendChild(h('div', { class: 'grid grid-2', style: { alignItems: 'start', gap: '24px', gridTemplateColumns: '1.5fr 1fr' } },
      h('div', { class: 'stack gap-4' }, listBox, addByLinkCard(load)), summaryBox));

    renderItems();
    renderSummary();
  }

  function renderItems() {
    listBox.innerHTML = '';
    if (loadError) {
      listBox.appendChild(emptyState(
        shareToken ? 'Общая корзина недоступна' : 'Не удалось загрузить корзину',
        shareToken ? 'Ссылка устарела или владелец закрыл доступ. Попросите новую ссылку либо добавьте товары самостоятельно.' : (loadError.message || 'Проверьте соединение'),
        h('div', { class: 'btn-group', style: { justifyContent: 'center' } },
          h('a', { class: 'btn btn-primary', href: '#/catalog' }, 'В каталог'),
          shareToken ? h('a', { class: 'btn btn-ghost', href: '#/cart' }, 'Моя корзина') : h('button', { class: 'btn btn-ghost', onclick: load }, 'Повторить'))));
      return;
    }
    if (!cart.items?.length) {
      listBox.appendChild(emptyState('Корзина пуста', 'Добавьте товар из каталога или вставьте ссылку с Poizon',
        h('div', { class: 'btn-group', style: { justifyContent: 'center' } },
          h('a', { class: 'btn btn-primary', href: '#/catalog' }, 'В каталог'),
          h('a', { class: 'btn btn-ghost', href: '#/calc' }, 'Калькулятор'))));
      return;
    }
    cart.items.forEach((it) => listBox.appendChild(itemRow(it)));
    listBox.appendChild(h('div', { class: 'card', style: { background: 'var(--surface)' } },
      h('div', { class: 'row gap-4 wrap small' },
        h('span', { class: 'chip' }, `Общий вес: ${cart.quote.weight.estKg} кг`),
        h('span', { class: 'chip' }, `Биллинг-вес: ${cart.quote.weight.billableKg} кг`),
        h('span', { class: 'chip' }, `Мест: ${cart.quote.packaging.places}`),
        h('span', { class: 'chip' }, `Объём: ${cart.quote.weight.volumeM3} м³`),
        h('span', { class: 'chip chip-info' }, `Товаров: ${cart.quote.itemCount} шт.`)),
      cart.quote.packaging.savedUsd > 0 ? h('p', { class: 'small', style: { margin: '10px 0 0', color: 'var(--ok)' } },
        icon('gift', 15), ` Упаковка оптимизирована: ${cart.quote.itemCount} товаров объединены в 1 место — экономия $${cart.quote.packaging.savedUsd}`) : null));
  }

  function itemRow(it) {
    const q = cart.quote.lines.find((l) => l.id === it.id) || {};
    return h('div', { class: 'card', style: { display: 'grid', gridTemplateColumns: '88px 1fr auto', gap: '16px', alignItems: 'center', padding: '14px' } },
      h('img', { src: it.imageUrl || `/img/p/${encodeURIComponent(it.title)}.svg`, alt: it.title, style: { width: '88px', height: '74px', objectFit: 'cover', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)' } }),
      h('div', { class: 'stack gap-1' },
        h('div', { class: 'row gap-2 wrap' },
          h('span', { class: `chip ${it.source === 'catalog' ? 'chip-brand' : ''}` }, it.source === 'catalog' ? 'каталог' : 'по ссылке'),
          it.category ? h('span', { class: 'chip' }, it.category) : null),
        h('b', { class: 'small' }, it.title),
        h('div', { class: 'tiny muted' }, [it.brand, it.color, it.size && `размер ${it.size}`, `${it.weightKg} кг`].filter(Boolean).join(' · ')),
        it.externalUrl ? h('a', { class: 'tiny dim', href: it.externalUrl, target: '_blank', rel: 'noopener' }, 'источник ↗') : null,
        readOnly ? null : h('div', { class: 'row gap-2', style: { marginTop: '6px' } },
          h('div', { class: 'row gap-1' },
            h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' }, onclick: () => changeQty(it, it.qty - 1) }, '−'),
            h('input', {
              class: 'input', style: { width: '52px', padding: '4px 6px', textAlign: 'center' }, type: 'number', min: 1, max: 99, value: it.qty,
              onchange: (e) => changeQty(it, Number(e.target.value) || 1),
            }),
            h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' }, onclick: () => changeQty(it, it.qty + 1) }, '+')),
          it.source !== 'catalog' ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => editItem(it) }, icon('gear', 14), 'Изменить') : null,
          h('button', { class: 'btn btn-danger btn-sm', onclick: () => removeItem(it) }, icon('trash', 14)))),
      h('div', { class: 'right stack gap-1' },
        h('b', { class: 'mono' }, money(q.lineTotal ?? 0, cart.currency)),
        h('div', { class: 'tiny dim mono' }, `${(it.priceCnyMinor / 100).toLocaleString('ru-RU')} ¥ × ${it.qty}`),
        h('div', { class: 'tiny dim' }, `комиссия ${money(q.commission ?? 0, cart.currency)}`),
        h('div', { class: 'tiny dim' }, `доставка ${money(q.shipping ?? 0, cart.currency)}`)));
  }

  function renderSummary() {
    summaryBox.innerHTML = '';
    if (loadError || !cart.items?.length || !cart.quote) { summaryBox.appendChild(h('p', { class: 'muted small' }, loadError ? 'Расчёт недоступен' : 'Добавьте товары — расчёт появится здесь.')); return; }
    renderQuote(summaryBox, cart.quote);

    // управление параметрами
    const controls = h('div', { class: 'stack gap-3', style: { marginTop: '16px' } },
      h('div', { class: 'field' }, h('label', {}, 'Направление'),
        h('div', { class: 'segmented' }, Object.entries(state.config.tariffs || {}).map(([code, t]) =>
          h('button', { 'aria-pressed': String(cart.destination === code), disabled: readOnly, onclick: () => update({ destination: code }) }, `${t.label}`)))),
      h('div', { class: 'field' }, h('label', {}, 'Упаковка'),
        h('div', { class: 'segmented' }, Object.entries(state.config.packaging || {}).map(([code, price]) =>
          h('button', { 'aria-pressed': String(cart.packaging === code), disabled: readOnly, onclick: () => update({ packaging: code }) }, `${packName(code)} $${price}`)))),
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: cart.insurance === 'standard', disabled: readOnly, onchange: (e) => update({ insurance: e.target.checked ? 'standard' : 'none' }) }),
        h('span', { class: 'track' }), h('span', { class: 'small' }, 'Страховка груза (2–3%)')),
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: !!cart.packEachSeparately, disabled: readOnly, onchange: (e) => update({ packEachSeparately: e.target.checked }) }),
        h('span', { class: 'track' }), h('span', { class: 'small' }, 'Каждую позицию — отдельным местом')),
      h('div', { class: 'field' }, h('label', {}, 'Валюта отображения'),
        h('div', { class: 'segmented' }, ['RUB', 'BYN', 'USD'].map((c) =>
          h('button', { 'aria-pressed': String(state.currency === c), onclick: () => setCurrency(c) }, c)))));

    summaryBox.appendChild(controls);
    if (!readOnly) {
      summaryBox.appendChild(h('div', { class: 'btn-group', style: { marginTop: '16px' } },
        h('a', { class: 'btn btn-primary btn-lg btn-block', href: '#/checkout' }, 'Оформить мульти-заказ', icon('arrow', 18)),
        h('button', { class: 'btn btn-danger btn-sm', onclick: clearCart }, 'Очистить корзину')));
    }
    summaryBox.appendChild(h('p', { class: 'tiny dim', style: { marginTop: '12px' } },
      `Курс CNY: ${cart.quote.rates.CNY.toFixed(4)} ₽ · Курс USD: ${cart.quote.rates.USD.toFixed(2)} ₽ · Срок: ${cart.quote.etaDays.min}–${cart.quote.etaDays.max} дней`));
  }

  async function update(patch) {
    try {
      cart = await endpoints.cartUpdate(patch);
      state.cart = cart;
      render();
    } catch (e) { toast('Ошибка', e.message, 'err'); }
  }
  async function changeQty(it, qty) {
    if (qty < 1) return removeItem(it);
    try { cart = await endpoints.cartItemUpdate(it.id, { qty }); state.cart = cart; render(); }
    catch (e) { toast('Ошибка', e.message, 'err'); }
  }
  async function removeItem(it) {
    if (!await confirmDialog('Удалить позицию?', `${it.title} будет удалён из корзины`, 'Удалить', true)) return;
    try { cart = await endpoints.cartItemRemove(it.id); state.cart = cart; await refreshCart(); render(); }
    catch (e) { toast('Ошибка', e.message, 'err'); }
  }
  async function clearCart() {
    if (!await confirmDialog('Очистить корзину?', 'Все позиции будут удалены', 'Очистить', true)) return;
    await endpoints.cartClear();
    await refreshCart();
    load();
  }
  function editItem(it) {
    const fields = { title: it.title, color: it.color, size: it.size, priceCnyMinor: it.priceCnyMinor, weightKg: it.weightKg, notes: it.notes };
    const form = h('div', {},
      field('Название', 'title', 'text'), field('Цвет', 'color', 'text'), field('Размер', 'size', 'text'),
      field('Цена, CNY', 'priceCnyMinor', 'number', (v) => v / 100), field('Вес, кг', 'weightKg', 'number'),
      h('div', { class: 'field' }, h('label', {}, 'Комментарий для склада'), h('textarea', { class: 'textarea', oninput: (e) => { fields.notes = e.target.value; } }, it.notes || '')));
    function field(label, key, type, map) {
      return h('div', { class: 'field' }, h('label', {}, label),
        h('input', {
          class: 'input', type, value: map ? map(it[key]) : (it[key] ?? ''),
          oninput: (e) => {
            let v = e.target.value;
            if (type === 'number') v = Number(v);
            if (key === 'priceCnyMinor') v = Math.round(Number(v) * 100);
            fields[key] = v;
          },
        }));
    }
    const m = modal({
      title: 'Изменить позицию', body: form,
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            try { cart = await endpoints.cartItemUpdate(it.id, fields); state.cart = cart; m.close(); render(); toast('Сохранено', 'Позиция обновлена, расчёт пересчитан', 'ok'); }
            catch (e) { toast('Ошибка', e.message, 'err'); }
          },
        }, 'Сохранить'),
      ],
    });
  }

  async function shareModal() {
    const res = await endpoints.cartShare(true);
    const input = h('input', { class: 'input mono', value: res.shareUrl, readonly: true });
    modal({
      title: 'Поделиться корзиной', body: h('div', {},
        h('p', { class: 'small muted' }, 'Отправьте ссылку другу — он увидит позиции и итоговую стоимость в своей валюте и сможет скопировать корзину себе для совместного заказа.'),
        h('div', { class: 'field' }, h('label', {}, 'Ссылка'), input),
        h('div', { class: 'btn-group' },
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { copyToClipboard(res.shareUrl); toast('Ссылка скопирована', '', 'ok'); } }, icon('share', 15), 'Копировать'),
          h('a', { class: 'btn btn-ghost btn-sm', href: `https://t.me/share/url?url=${encodeURIComponent(res.shareUrl)}&text=${encodeURIComponent('Собираем совместный заказ на PoizonVanart')}`, target: '_blank', rel: 'noopener' }, 'Отправить в Telegram'))),
    });
    input.select();
  }

  async function importShared() {
    if (!state.user) { toast('Нужна авторизация', 'Войдите, чтобы скопировать корзину', 'info'); return navigate('#/auth'); }
    try {
      await endpoints.importSharedCart(shareToken);
      await refreshCart();
      toast('Скопировано', 'Позиции добавлены в вашу корзину', 'ok');
      navigate('#/cart');
    } catch (e) { toast('Ошибка', e.message, 'err'); }
  }

  await load();
  const onCartCur = () => load();
  window.addEventListener('pv:currency-changed', onCartCur);
  return wrap;
}

// ── ДОБАВИТЬ ПО ССЫЛКЕ ─────────────────────────────────────────────────────
function addByLinkCard(onAdded) {
  const weights = state.config?.defaultWeightsKg || {};
  const form = { url: '', title: '', category: 'sneakers', color: '', size: '', priceCny: '', qty: 1, weightKg: '' };
  let weightInput = null;

  const onField = (key, asNumber = false) => (e) => {
    form[key] = asNumber ? (Number(e.target.value) || 1) : e.target.value;
  };

  const linkInput = h('input', {
    class: 'input', placeholder: 'https://www.poizon.com/product?spu=…',
    oninput: (e) => { form.url = e.target.value; tryParse(e.target.value); },
  });
  const CAT_PRESETS = {
    sneakers: { name: 'Кроссовки и кеды', icon: '👟', weight: 1.4 },
    hoodie: { name: 'Худи и свитшоты', icon: '🧥', weight: 1.1 },
    tshirt: { name: 'Футболки и майки', icon: '👕', weight: 0.5 },
    jacket: { name: 'Куртки и пуховики', icon: '🧥', weight: 2.0 },
    pants: { name: 'Брюки и джинсы', icon: '👖', weight: 0.8 },
    shorts: { name: 'Шорты', icon: '🩳', weight: 0.4 },
    bag: { name: 'Сумки и рюкзаки', icon: '👜', weight: 1.2 },
    cap: { name: 'Кепки и шапки', icon: '🧢', weight: 0.25 },
    accessories: { name: 'Аксессуары и часы', icon: '💍', weight: 0.3 },
  };

  const titleInput = h('input', { class: 'input', placeholder: 'Air Jordan 1 Retro High / Essentials Hoodie', oninput: onField('title') });
  const categorySelect = h('select', {
    class: 'select',
    onchange: (e) => {
      form.category = e.target.value;
      if (!form.weightKg && weightInput) {
        weightInput.placeholder = `авто: ${weights[form.category] ?? 1} кг`;
      }
      syncCatPills();
    },
  }, Object.keys(weights).map((k) => {
    const meta = CAT_PRESETS[k] || { name: k, icon: '📦', weight: weights[k] || 1 };
    return h('option', { value: k, selected: k === form.category }, `${meta.icon} ${meta.name} (~${weights[k] ?? meta.weight} кг)`);
  }));

  const catPills = h('div', { class: 'pill-tabs', style: { marginBottom: '8px' } },
    ['sneakers', 'hoodie', 'tshirt', 'jacket', 'bag'].map((catKey) => {
      const meta = CAT_PRESETS[catKey];
      return h('button', {
        type: 'button',
        'aria-pressed': String(form.category === catKey),
        onclick: () => {
          form.category = catKey;
          categorySelect.value = catKey;
          if (!form.weightKg && weightInput) weightInput.placeholder = `авто: ${weights[catKey] ?? 1} кг`;
          syncCatPills();
        },
      }, `${meta.icon} ${meta.name}`);
    }));

  function syncCatPills() {
    [...catPills.children].forEach((btn, i) => {
      const keys = ['sneakers', 'hoodie', 'tshirt', 'jacket', 'bag'];
      btn.setAttribute('aria-pressed', String(form.category === keys[i]));
    });
  }
  const colorInput = h('input', { class: 'input', placeholder: 'Chicago', oninput: onField('color') });
  const sizeInput = h('input', { class: 'input', placeholder: '42 / L', oninput: onField('size') });
  const priceInput = h('input', { class: 'input', type: 'number', min: 0, placeholder: '1499', oninput: onField('priceCny') });
  weightInput = h('input', {
    class: 'input', type: 'number', step: '0.05', placeholder: `авто: ${weights.sneakers ?? 1} кг`,
    oninput: onField('weightKg'),
  });
  const qtyInput = h('input', {
    class: 'input', type: 'number', min: 1, max: 20, value: 1, style: { maxWidth: '110px' },
    oninput: onField('qty', true),
  });

  const field = (label, control, required = false) =>
    h('div', { class: 'field' }, h('label', {}, required ? `${label} *` : label), control);

  const grid = h('div', { class: 'grid grid-2' },
    field('Название', titleInput),
    field('Категория', h('div', {}, catPills, categorySelect)),
    field('Цвет', colorInput),
    field('Размер', sizeInput),
    field('Цена, CNY', priceInput, true),
    field('Вес, кг', weightInput));

  const hint = h('div', { class: 'hint', id: 'link-hint', style: { marginBottom: '10px' } },
    'Цена обязательна: мы выкупаем товар по фактической цене площадки на момент выкупа.');

  const pasteBtn = h('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Вставить скопированную ссылку из буфера',
    onclick: async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          const match = text.match(/https?:\/\/[^\s"'<>]+/);
          const val = match ? match[0] : text.trim();
          linkInput.value = val;
          form.url = val;
          tryParse(val);
          toast('Ссылка вставлена', val.length > 50 ? val.slice(0, 48) + '…' : val, 'ok');
        }
      } catch (err) {
        toast('Буфер обмена', 'Вставьте ссылку вручную через контекстное меню', 'info');
      }
    },
  }, icon('copy', 14), 'Вставить из буфера');

  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('plus', 20), h('h3', {}, 'Добавить товар по ссылке с Poizon'),
      h('a', { class: 'tiny', href: '#/how', style: { marginLeft: 'auto' } }, 'как скопировать ссылку?')),
    h('div', { class: 'field' },
      h('div', { class: 'row spread', style: { marginBottom: '4px' } },
        h('label', {}, 'Ссылка на товар'),
        pasteBtn),
      linkInput),
    grid,
    h('div', { class: 'row gap-3 wrap', style: { alignItems: 'flex-end', margin: '10px 0' } },
      field('Количество', qtyInput)),
    hint,
    h('button', { class: 'btn btn-primary btn-block', onclick: submit }, icon('cart', 17), 'Добавить в корзину'));

  function tryParse(url) {
    const hintBox = card.querySelector('#link-hint');
    if (!hintBox) return;
    const spu = String(url).match(/spu=(\d+)/)?.[1];
    if (spu) {
      hintBox.textContent = `Распознан spu=${spu}. Проверим наличие в каталоге и подставим цену, если товар уже есть в базе.`;
      hintBox.style.color = 'var(--ok)';
    } else if (url) {
      hintBox.textContent = 'Ссылка сохранится как есть — цену и параметры укажите вручную.';
      hintBox.style.color = '';
    }
  }

  async function submit() {
    if (!form.url) return toast('Нужна ссылка', 'Вставьте ссылку на товар с Poizon', 'err');
    if (!form.priceCny) return toast('Нужна цена', 'Укажите цену в CNY — она видна в приложении Poizon', 'err');
    if (!state.user) {
      toast('Нужна авторизация', 'Войдите, чтобы собирать корзину', 'info');
      location.hash = '#/auth';
      return;
    }
    try {
      await endpoints.cartAdd({
        source: 'link', externalUrl: form.url, title: form.title || 'Товар с Poizon', category: form.category,
        color: form.color, size: form.size, priceCnyMinor: Math.round(Number(form.priceCny) * 100),
        qty: form.qty, weightKg: form.weightKg ? Number(form.weightKg) : undefined,
      });
      await refreshCart();
      toast('Добавлено в корзину', `${form.title || 'Товар'} · ${Number(form.priceCny).toLocaleString('ru-RU')} ¥ × ${form.qty}`, 'ok');
      form.url = form.title = form.color = form.size = form.priceCny = form.weightKg = '';
      onAdded?.();
    } catch (e) { toast('Ошибка', e.message, 'err'); }
  }
  return card;
}
