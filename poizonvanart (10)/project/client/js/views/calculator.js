/**
 * PoizonVanart · views/calculator.js — интерактивный калькулятор выкупа и доставки «под ключ».
 * Поддерживает:
 *  - Автопарсер ссылок Poizon/Dewu и артикулов прямо в калькуляторе;
 *  - Мультивалютный пересчёт на лету (RUB, BYN, USD, CNY) без перезагрузки страницы;
 *  - Выбор доставки СДЭК (ПВЗ / Курьер);
 *  - Кнопки быстрого заказа под ключ и добавления в корзину.
 */
import { h, icon, toast, debounce } from '../dom.js';
import { endpoints } from '../api.js';
import { state, money, setCurrency, refreshCart } from '../state.js';
import { packName } from './home.js';

const CAT_NAMES = {
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

export async function renderCalculator(route) {
  const cfg = state.config || {};
  const weights = cfg.defaultWeightsKg || { sneakers: 1.4 };
  const wrap = h('div', { class: 'container', style: { maxWidth: '1060px' } });

  const model = {
    items: [{
      title: '',
      category: route.query?.category || 'sneakers',
      priceCny: 699,
      qty: 1,
      weightKg: null,
      color: '',
      size: '',
    }],
    destination: route.query?.dest || (state.user?.settings?.default_destination || 'RU_MOW'),
    packaging: 'basic',
    insured: true,
    packEachSeparately: false,
    deliveryType: 'cdek_pvz', // 'cdek_pvz' | 'cdek_courier'
  };

  const itemsBox = h('div', { class: 'stack gap-3' });
  const outBox = h('div', { class: 'card', style: { position: 'sticky', top: '86px' } });
  const formulaBox = h('div', { class: 'card' });

  // Заголовок
  wrap.appendChild(h('div', { class: 'section-head' },
    h('div', {},
      h('h1', {}, 'Калькулятор стоимости доставки «под ключ»'),
      h('p', { class: 'muted' }, 'Точный расчет с выкупом на Poizon, проверкой Legit Check, упаковкой и доставкой СДЭК')),
    h('div', { class: 'segmented' }, ['RUB', 'BYN', 'USD'].map((c) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(state.currency === c),
        onclick: () => setCurrency(c),
      }, c)))));

  // Быстрый парсер ссылки / артикула прямо в калькуляторе
  const parseInput = h('input', {
    class: 'input',
    placeholder: 'Вставьте ссылку dw4.co / dewu.com или артикул (напр. DD1391-100)',
    style: { flexGrow: '1' },
    onkeydown: (e) => { if (e.key === 'Enter') doQuickParse(); },
  });

  const parseBtn = h('button', {
    class: 'btn btn-primary nowrap',
    type: 'button',
    onclick: () => doQuickParse(),
  }, icon('refresh', 15), 'Рассчитать по ссылке');

  const parserWidget = h('div', {
    class: 'card',
    style: {
      background: 'linear-gradient(135deg, var(--card-1), var(--card-2))',
      border: '1px solid var(--brand)',
      padding: '16px 20px',
      marginBottom: '20px',
    },
  },
    h('div', { class: 'row spread gap-3 wrap', style: { alignItems: 'center' } },
      h('div', { class: 'grow' },
        h('div', { class: 'row gap-2', style: { alignItems: 'center', marginBottom: '4px' } },
          h('span', { class: 'chip chip-brand chip-sm' }, '⚡ Экспресс-расчет'),
          h('b', { class: 'small' }, 'Есть ссылка на Poizon или артикул?')),
        h('div', { class: 'tiny muted' }, 'Автоматически определим категорию, вес и цену товара в юанях:')),
      h('div', { class: 'row gap-2', style: { minWidth: '320px', flexGrow: 1, maxWidth: '520px' } },
        parseInput, parseBtn)));

  const samplePills = h('div', { class: 'row gap-2 wrap', style: { marginTop: '8px', alignItems: 'center' } },
    h('span', { class: 'tiny muted', style: { fontWeight: 600 } }, 'Попробовать:'),
    [
      { label: '👟 Dunk Panda', q: 'DD1391-100' },
      { label: '👟 Travis Scott J1', q: 'DM7866-162' },
      { label: '🧥 Essentials Hoodie', q: '192BT212000F' },
      { label: '🧥 Arc\'teryx Beta LT', q: '26844' },
    ].map((s) => h('button', {
      type: 'button', class: 'chip chip-sm',
      onclick: () => { parseInput.value = s.q; doQuickParse(); },
    }, s.label)));

  parserWidget.appendChild(samplePills);

  wrap.appendChild(parserWidget);

  async function doQuickParse() {
    const q = parseInput.value.trim();
    if (!q) return toast('Укажите ссылку или артикул', '', 'warn');
    parseBtn.disabled = true;
    parseBtn.textContent = 'Распознаём…';
    try {
      const res = await endpoints.parsePoizonLink({ url: q, destination: model.destination });
      if (res) {
        model.items[0] = {
          title: res.title || 'Товар Poizon',
          category: res.category || 'sneakers',
          priceCny: res.basePriceCny || 699,
          qty: 1,
          weightKg: res.weightKg || null,
          color: '',
          size: res.selectedSize?.size || '',
        };
        renderItems();
        await calc();
        toast('Товар распознан!', `${res.brand || ''} ${res.title}`, 'ok');
      }
    } catch (e) {
      toast('Ошибка распознавания', e.message, 'err');
    } finally {
      parseBtn.disabled = false;
      parseBtn.innerHTML = '';
      parseBtn.appendChild(icon('refresh', 15));
      parseBtn.append(' Рассчитать по ссылке');
    }
  }

  // Вкладки направлений
  const destTabs = h('div', { class: 'segmented' },
    Object.entries(cfg.tariffs || { RU_MOW: { label: 'Москва, РФ', usd_per_kg: 3.5 }, BY_MSQ: { label: 'Минск, РБ', usd_per_kg: 4.5 } }).map(([code, t]) => h('button', {
      type: 'button',
      'aria-pressed': String(model.destination === code),
      onclick: () => {
        model.destination = code;
        syncPressed(destTabs, code, Object.keys(cfg.tariffs || { RU_MOW: 1, BY_MSQ: 1 }));
        calc();
      },
    }, `${t.label || code} · $${t.usd_per_kg}/кг`)));

  // Вкладки упаковки
  const packTabs = h('div', { class: 'segmented' },
    Object.entries(cfg.packaging || { basic: 3, corners: 6, crate: 10 }).map(([code, price]) => h('button', {
      type: 'button',
      'aria-pressed': String(model.packaging === code),
      onclick: () => {
        model.packaging = code;
        syncPressed(packTabs, code, Object.keys(cfg.packaging || { basic: 3, corners: 6, crate: 10 }));
        calc();
      },
    }, `${packName(code)} · $${price}`)));

  wrap.appendChild(h('div', { class: 'grid grid-2', style: { alignItems: 'start', gap: '24px', gridTemplateColumns: '1.45fr 1fr' } },
    h('div', { class: 'stack gap-4' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          icon('box', 20),
          h('h3', {}, 'Позиции для расчета'),
          h('button', {
            class: 'btn btn-soft btn-sm',
            style: { marginLeft: 'auto' },
            type: 'button',
            onclick: () => {
              model.items.push({ title: '', category: 'sneakers', priceCny: 500, qty: 1, weightKg: null, color: '', size: '' });
              renderItems();
              calc();
            },
          }, icon('plus', 15), 'Добавить товар')),
        itemsBox,
        h('div', { class: 'divider' }),
        h('label', { class: 'checkbox' },
          h('input', {
            type: 'checkbox',
            checked: model.packEachSeparately,
            onchange: (e) => { model.packEachSeparately = e.target.checked; calc(); },
          }),
          h('span', {}, 'Упаковать каждую позицию в отдельное место ',
            h('span', { class: 'hint' }, '(для сохранения товарного вида обувных коробок)')))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, icon('truck', 20), h('h3', {}, 'Параметры доставки и страховки')),
        h('div', { class: 'field' }, h('label', {}, 'Город / хаб назначения'), destTabs),
        h('div', { class: 'field' }, h('label', {}, 'Тип усиленной упаковки'), packTabs),
        h('div', { class: 'stack gap-3', style: { marginTop: '12px' } },
          h('label', { class: 'checkbox' },
            h('input', {
              type: 'checkbox',
              checked: model.insured,
              onchange: (e) => { model.insured = e.target.checked; calc(); },
            }),
            h('span', {}, 'Полная страховка груза ',
              h('span', { class: 'hint' }, '(100% возврат стоимости при утере или повреждении)'))),
          h('div', { class: 'field' },
            h('label', {}, 'Служба доставки до клиента'),
            h('div', { class: 'segmented' }, [
              ['cdek_pvz', 'СДЭК ПВЗ (бесплатно)'],
              ['cdek_courier', 'СДЭК Курьер до двери (+350 ₽)'],
            ].map(([id, lbl]) => h('button', {
              type: 'button',
              'aria-pressed': String(model.deliveryType === id),
              onclick: (e) => {
                model.deliveryType = id;
                [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', 'false'));
                e.target.setAttribute('aria-pressed', 'true');
                calc();
              },
            }, lbl)))))),
      formulaBox),
    outBox));

  function syncPressed(box, code, keys) {
    [...box.children].forEach((b, i) => {
      b.setAttribute('aria-pressed', String(keys[i] === code));
    });
  }

  function renderItems() {
    itemsBox.innerHTML = '';
    model.items.forEach((it, idx) => {
      const catSelect = h('select', {
        class: 'select',
        onchange: (e) => {
          it.category = e.target.value;
          it.weightKg = null;
          renderItems();
          calc();
        },
      }, Object.entries(weights).map(([k, w]) =>
        h('option', { value: k, selected: k === it.category }, `${CAT_NAMES[k] || k} (~${w} кг)`)));

      const weightInput = h('input', {
        class: 'input',
        type: 'number',
        step: '0.05',
        min: 0,
        placeholder: `авто: ${weights[it.category] ?? 1.2} кг`,
        value: it.weightKg ?? '',
        oninput: (e) => {
          it.weightKg = e.target.value === '' ? null : Number(e.target.value);
          debouncedCalc();
        },
      });

      const priceInput = h('input', {
        class: 'input',
        type: 'number',
        min: 0,
        value: it.priceCny,
        oninput: (e) => {
          it.priceCny = Number(e.target.value) || 0;
          debouncedCalc();
        },
      });

      const titleInput = h('input', {
        class: 'input',
        placeholder: 'Название или артикул (например Nike Dunk Panda)',
        value: it.title || '',
        oninput: (e) => { it.title = e.target.value; },
      });

      itemsBox.appendChild(h('div', {
        class: 'card',
        style: { background: 'var(--card-2)', padding: '16px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' },
      },
        h('div', { class: 'row spread', style: { marginBottom: '10px' } },
          h('b', { class: 'small' }, `Позиция ${idx + 1}`),
          model.items.length > 1 ? h('button', {
            class: 'icon-btn',
            type: 'button',
            title: 'Удалить позицию',
            onclick: () => {
              model.items.splice(idx, 1);
              renderItems();
              calc();
            },
          }, icon('trash', 15)) : null),
        h('div', { class: 'field', style: { marginBottom: '10px' } },
          h('label', {}, 'Название товара'),
          titleInput),
        h('div', { class: 'pill-tabs', style: { marginBottom: '12px' } },
          ['sneakers', 'hoodie', 'tshirt', 'jacket', 'bag'].map((catKey) => h('button', {
            type: 'button',
            'aria-pressed': String(it.category === catKey),
            onclick: () => {
              it.category = catKey;
              it.weightKg = null;
              renderItems();
              calc();
            },
          }, CAT_NAMES[catKey] || catKey))),
        h('div', { class: 'grid grid-2', style: { gap: '12px' } },
          h('div', { class: 'field' }, h('label', {}, 'Категория'), catSelect),
          h('div', { class: 'field' }, h('label', {}, 'Вес (кг)'), weightInput),
          h('div', { class: 'field' }, h('label', {}, 'Цена в юанях (¥ CNY)'), priceInput),
          h('div', { class: 'field' },
            h('label', {}, 'Размер (EU/US)'),
            h('input', {
              class: 'input',
              placeholder: '42 EU / L / M',
              value: it.size || '',
              oninput: (e) => { it.size = e.target.value; },
            })))));
    });
  }

  const debouncedCalc = debounce(() => calc(), 250);

  async function calc() {
    outBox.innerHTML = '';
    outBox.appendChild(h('div', { style: { padding: '24px 0' } }, h('span', { class: 'spinner' })));
    try {
      const q = await endpoints.quote({
        items: model.items.map((it) => ({
          title: it.title || CAT_NAMES[it.category] || 'Товар',
          category: it.category,
          priceCnyMinor: Math.round((it.priceCny || 0) * 100),
          qty: it.qty,
          weightKg: it.weightKg ?? undefined,
          color: it.color,
          size: it.size,
        })),
        destination: model.destination,
        packaging: model.packaging,
        insured: model.insured,
        packEachSeparately: model.packEachSeparately,
        currency: state.currency,
      });

      const cur = q.currency;
      const b = q.breakdown;

      outBox.innerHTML = '';
      outBox.appendChild(h('div', { class: 'card-head' },
        icon('calc', 20),
        h('h3', {}, 'Итоговый расчет'),
        h('span', { class: 'chip chip-brand chip-sm', style: { marginLeft: 'auto' } }, `${cur}`)));

      outBox.appendChild(h('div', { class: 'breakdown' },
        brow('Стоимость товаров', `${(q.goodsCnyMinor / 100).toLocaleString('ru-RU')} ¥`, b.goods, cur),
        brow(`Комиссия сервиса · ${Math.round(q.commissionRate * 100)}%`, 'Выкуп и Legit Check', b.commission, cur),
        brow(`Доставка ${q.destinationLabel}`, `${q.weight.billableKg} кг × $${q.tariffUsdPerKg}`, b.shipping, cur),
        brow(`Упаковка (${packName(q.packaging.code)})`, `${q.packaging.places} место`, b.packaging, cur),
        brow('Страховка груза', q.insurance.enabled ? 'Включена' : '—', b.insurance, cur),
        b.unloading && b.unloading > 0 ? brow('Разгрузка', '', b.unloading, cur) : null,
        h('div', { class: 'divider', style: { margin: '8px 0' } }),
        h('div', { class: 'brow total' },
          h('span', { class: 'b-label' }, 'Итого «под ключ»:'),
          h('span', { class: 'b-value', style: { fontSize: '24px', color: 'var(--brand)' } }, money(b.total, cur)))));

      // Сроки и гарантия
      outBox.appendChild(h('div', { class: 'row gap-2 wrap', style: { margin: '14px 0 8px' } },
        h('span', { class: 'chip chip-ok chip-sm' }, '✓ 100% Legit Check'),
        h('span', { class: 'chip chip-sm' }, `🚚 ${q.etaDays.min}–${q.etaDays.max} дней`),
        h('span', { class: 'chip chip-sm' }, 'СДЭК')));

      // Две ключевые кнопки действий: «Оформить под ключ» и «В корзину»
      const actionStack = h('div', { class: 'stack gap-2', style: { marginTop: '16px' } },
        h('button', {
          class: 'btn btn-primary btn-lg btn-block',
          type: 'button',
          onclick: () => {
            const first = model.items[0] || {};
            window.openQuickOrderModal?.({
              title: first.title || CAT_NAMES[first.category] || '',
              category: first.category || 'sneakers',
              priceCny: first.priceCny || 699,
              destination: model.destination,
              color: first.color || '',
              size: first.size || '',
            });
          },
        }, icon('lock', 18), '⚡ Заказать под ключ'),
        h('button', {
          class: 'btn btn-soft btn-block',
          type: 'button',
          onclick: async () => {
            try {
              for (const it of model.items) {
                await endpoints.cartAdd({
                  source: 'manual',
                  title: it.title || CAT_NAMES[it.category] || 'Товар с Poizon',
                  category: it.category,
                  priceCnyMinor: Math.round((it.priceCny || 0) * 100),
                  qty: it.qty,
                  weightKg: it.weightKg ?? undefined,
                  color: it.color,
                  size: it.size,
                });
              }
              await refreshCart();
              toast('Товары добавлены в корзину', `${model.items.length} поз.`, 'ok');
              location.hash = '#/cart';
            } catch (err) {
              toast('Ошибка', err.message, 'err');
            }
          },
        }, icon('cart', 16), '🛒 Добавить в корзину'));

      outBox.appendChild(actionStack);
      renderFormula(q);
    } catch (e) {
      outBox.innerHTML = '';
      outBox.appendChild(h('div', { class: 'notice notice-warn' }, e.message));
    }
  }

  function brow(label, sub, value, cur) {
    return h('div', { class: 'brow' },
      h('span', { class: 'b-label' }, label, sub ? h('span', { class: 'tiny dim' }, ` · ${sub}`) : null),
      h('span', { class: 'b-value mono' }, money(value, cur)));
  }

  function renderFormula(q) {
    const b = q.breakdown;
    const cur = q.currency;
    formulaBox.innerHTML = '';
    formulaBox.appendChild(h('div', { class: 'card-head' }, icon('eye', 18), h('h4', {}, 'Прозрачная калькуляция')));
    formulaBox.appendChild(h('div', { class: 'small muted stack gap-2' },
      h('div', {}, h('code', { class: 'mono' }, `1. Выкуп товара: ${(q.goodsCnyMinor / 100).toLocaleString('ru-RU')} ¥ = ${money(b.goods, cur)}`)),
      h('div', {}, h('code', { class: 'mono' }, `2. Комиссия сервиса (${Math.round(q.commissionRate * 100)}%): ${money(b.commission, cur)} (включает выкуп, перевод и Legit Check)`)),
      h('div', {}, h('code', { class: 'mono' }, `3. Международная доставка: ${q.weight.billableKg} кг × $${q.tariffUsdPerKg} = ${money(b.shipping, cur)}`)),
      h('div', {}, h('code', { class: 'mono' }, `4. Упаковка: ${q.packaging.places} место = ${money(b.packaging, cur)}`)),
      q.insurance.enabled ? h('div', {}, h('code', { class: 'mono' }, `5. Страховка 100%: ${money(b.insurance, cur)}`)) : null,
      h('div', { style: { color: 'var(--brand)', fontWeight: 700, marginTop: '4px' } },
        h('code', { class: 'mono' }, `ИТОГО К ОПЛАТЕ = ${money(b.total, cur)}`))));
  }

  renderItems();
  await calc();

  // Реактивная подписка на смену валюты
  const onCurChanged = () => {
    [...curSwitch.children].forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.textContent.trim() === state.currency));
    });
    calc();
  };
  window.addEventListener('pv:currency-changed', onCurChanged);

  return wrap;
}
