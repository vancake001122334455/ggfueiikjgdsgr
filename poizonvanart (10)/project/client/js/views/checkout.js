/**
 * PoizonVanart · views/checkout.js — оформление единого мульти-заказа.
 * Поддерживает:
 *  1. Доставку СДЭК с интерактивным выбором ПВЗ или курьера до двери;
 *  2. Методы оплаты: Банковская карта, СБП / ЕРИП, баланс кошелька и комбинированная оплата;
 *  3. Фотоотчёт со склада в Китае и трекинг.
 */
import { h, icon, toast, spinner, modal } from '../dom.js';
import { endpoints } from '../api.js';
import { state, money, refreshCart, refreshUser, navigate } from '../state.js';
import { packName } from './home.js';

export async function renderCheckout() {
  const wrap = h('div', { class: 'container', style: { maxWidth: '1020px' } });
  if (!state.user) { navigate('#/auth'); return wrap; }
  const cart = await endpoints.cart();
  if (!cart || !cart.items.length) {
    wrap.appendChild(h('div', { class: 'card center' }, h('h3', {}, 'Корзина пуста'),
      h('p', { class: 'muted' }, 'Добавьте товары, чтобы оформить заказ'),
      h('a', { class: 'btn btn-primary', href: '#/catalog' }, 'В каталог')));
    return wrap;
  }

  // Состояние формы оформления
  let deliveryType = 'cdek_pvz'; // 'cdek_pvz' | 'cdek_courier' | 'pickup_hub'
  let selectedCity = cart.destination === 'BY_MSQ' ? 'BY_MSQ' : 'RU_MOW';
  let selectedPvz = null;
  let pvzFilterQuery = '';
  let pvzList = [];

  let method = 'card'; // 'card' | 'sbp' | 'wallet' | 'combined'

  const order = {
    recipientName: `${state.user.firstName || ''} ${state.user.lastName || ''}`.trim(),
    recipientPhone: state.user.phone || '',
    recipientAddress: '',
    comment: '',
  };

  const deliveryBox = h('div', { class: 'card' });
  const payBox = h('div', { class: 'card' });
  const commentBox = h('div', { class: 'card' });
  const summary = h('div', { class: 'card', style: { position: 'sticky', top: '86px' } });

  wrap.appendChild(h('div', { class: 'section-head' },
    h('div', {},
      h('h1', {}, 'Оформление заказа'),
      h('p', { class: 'muted' }, 'Единый мульти-заказ: ', h('b', {}, `${cart.items.length} позиц.`), ' · один общий номер · одна посылка'))));

  wrap.appendChild(h('div', { class: 'grid grid-2', style: { alignItems: 'start', gap: '24px', gridTemplateColumns: '1.45fr 1fr' } },
    h('div', { class: 'stack gap-4' },
      deliveryBox, payBox, commentBox),
    summary));

  // Загрузка начальных ПВЗ
  try {
    pvzList = await endpoints.cdekPvz(selectedCity);
    if (pvzList && pvzList.length > 0) {
      selectedPvz = pvzList[0];
      order.recipientAddress = `СДЭК ПВЗ [${selectedPvz.code}]: ${selectedPvz.address} (${selectedPvz.metro || selectedPvz.workTime})`;
    }
  } catch (e) {
    console.error('Ошибка загрузки СДЭК:', e);
  }

  function renderDelivery() {
    deliveryBox.innerHTML = '';
    deliveryBox.appendChild(h('div', { class: 'card-head' }, icon('truck', 20), h('h3', {}, 'Способ получения и СДЭК')));

    // Бейджи параметров доставки
    deliveryBox.appendChild(h('div', { class: 'row gap-2 wrap', style: { marginBottom: '16px' } },
      h('span', { class: 'chip chip-brand' }, `${cart.quote.destinationLabel}`),
      h('span', { class: 'chip' }, `${cart.quote.etaDays.min}–${cart.quote.etaDays.max} дней`),
      h('span', { class: 'chip' }, `${packName(cart.packaging)} · ${cart.quote.packaging.places} место`),
      cart.insurance === 'standard' ? h('span', { class: 'chip chip-ok' }, `страховка ${(cart.quote.insurance.rate * 100).toFixed(0)}%`) : null));

    // Выбор типа доставки: СДЭК ПВЗ / СДЭК Курьер / Самовывоз из хаба
    const deliveryOptions = [
      {
        id: 'cdek_pvz',
        title: 'СДЭК · Пункт выдачи (ПВЗ)',
        sub: 'Бесплатное хранение 7 дней, примерка на месте · 0 ₽ доплата',
        badge: 'Популярно',
      },
      {
        id: 'cdek_courier',
        title: 'СДЭК · Курьер до двери',
        sub: 'Лично в руки по указанному адресу · +350 ₽ / 12 BYN',
        badge: 'Экспресс',
      },
      {
        id: 'pickup_hub',
        title: 'Самовывоз из логистического хаба Vanart',
        sub: selectedCity === 'BY_MSQ' ? 'Минск, пр-кт Победителей, 65' : 'Москва-Сити, Башня Федерация',
        badge: '0 ₽',
      },
    ];

    deliveryBox.appendChild(h('div', { class: 'stack gap-2', style: { marginBottom: '16px' } },
      deliveryOptions.map((opt) =>
        h('label', {
          class: 'card',
          style: {
            display: 'flex', gap: '12px', alignItems: 'center', padding: '12px 14px', cursor: 'pointer',
            borderColor: deliveryType === opt.id ? 'var(--brand)' : 'var(--border)',
            background: deliveryType === opt.id ? 'var(--brand-soft)' : 'var(--card-2)',
          },
        },
          h('input', {
            type: 'radio', name: 'delivery_type', checked: deliveryType === opt.id,
            style: { accentColor: 'var(--brand)' },
            onchange: () => {
              deliveryType = opt.id;
              if (deliveryType === 'cdek_pvz' && selectedPvz) {
                order.recipientAddress = `СДЭК ПВЗ [${selectedPvz.code}]: ${selectedPvz.address} (${selectedPvz.metro || selectedPvz.workTime})`;
              } else if (deliveryType === 'pickup_hub') {
                order.recipientAddress = selectedCity === 'BY_MSQ' ? 'Хаб Vanart Cargo Минск, пр-кт Победителей 65' : 'Хаб Vanart Cargo Москва-Сити, Башня Федерация';
              } else {
                order.recipientAddress = '';
              }
              renderDelivery();
              renderSummary();
            },
          }),
          h('div', { class: 'grow' },
            h('div', { class: 'row spread' },
              h('b', { class: 'small' }, opt.title),
              h('span', { class: 'chip chip-sm' }, opt.badge)),
            h('div', { class: 'tiny muted' }, opt.sub))))));

    // Если выбран СДЭК ПВЗ — интерактивный выбор пункта выдачи
    if (deliveryType === 'cdek_pvz') {
      const pvzBox = h('div', { class: 'stack gap-3', style: { padding: '14px', background: 'var(--card-2)', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', marginBottom: '16px' } });
      
      const citySelect = h('select', {
        class: 'select',
        style: { maxWidth: '240px' },
        onchange: async (e) => {
          selectedCity = e.target.value;
          pvzBox.innerHTML = '';
          pvzBox.appendChild(spinner('Загрузка ПВЗ СДЭК…'));
          try {
            pvzList = await endpoints.cdekPvz(selectedCity);
            selectedPvz = pvzList[0] || null;
            if (selectedPvz) {
              order.recipientAddress = `СДЭК ПВЗ [${selectedPvz.code}]: ${selectedPvz.address} (${selectedPvz.metro || selectedPvz.workTime})`;
            }
          } catch (err) {
            console.error(err);
          }
          renderDelivery();
        },
      }, [
        { code: 'RU_MOW', name: 'Москва' },
        { code: 'RU_SPB', name: 'Санкт-Петербург' },
        { code: 'BY_MSQ', name: 'Минск' },
        { code: 'RU_EKB', name: 'Екатеринбург' },
        { code: 'RU_KZN', name: 'Казань' },
        { code: 'RU_OVB', name: 'Новосибирск' },
      ].map((c) => h('option', { value: c.code, selected: c.code === selectedCity }, c.name)));

      const filterInput = h('input', {
        class: 'input',
        placeholder: 'Поиск по адресу, метро…',
        style: { flexGrow: '1' },
        value: pvzFilterQuery,
        oninput: (e) => {
          pvzFilterQuery = e.target.value.toLowerCase();
          renderPvzListItems();
        },
      });

      const listContainer = h('div', { class: 'stack gap-2', style: { maxHeight: '220px', overflowY: 'auto' } });

      function renderPvzListItems() {
        listContainer.innerHTML = '';
        const filtered = pvzList.filter((p) =>
          !pvzFilterQuery ||
          p.name.toLowerCase().includes(pvzFilterQuery) ||
          p.address.toLowerCase().includes(pvzFilterQuery) ||
          (p.metro && p.metro.toLowerCase().includes(pvzFilterQuery)));

        if (!filtered.length) {
          listContainer.appendChild(h('div', { class: 'tiny muted center', style: { padding: '10px' } }, 'ПВЗ не найдены'));
          return;
        }

        filtered.forEach((pvz) => {
          const isSelected = selectedPvz?.code === pvz.code;
          const pvzRow = h('div', {
            class: 'card',
            style: {
              padding: '10px 12px',
              cursor: 'pointer',
              borderColor: isSelected ? 'var(--brand)' : 'var(--border)',
              background: isSelected ? 'var(--card-1)' : 'var(--card-3)',
            },
            onclick: () => {
              selectedPvz = pvz;
              order.recipientAddress = `СДЭК ПВЗ [${pvz.code}]: ${pvz.address} (${pvz.metro || pvz.workTime})`;
              renderDelivery();
            },
          },
            h('div', { class: 'row spread', style: { marginBottom: '4px' } },
              h('b', { class: 'small' }, `${pvz.name} · `, h('span', { class: 'mono' }, pvz.code)),
              isSelected ? h('span', { class: 'chip chip-ok chip-sm' }, '✓ Выбран') : null),
            h('div', { class: 'small' }, pvz.address),
            h('div', { class: 'tiny dim row gap-3 wrap', style: { marginTop: '4px' } },
              pvz.metro ? h('span', {}, icon('truck', 12), ` ${pvz.metro}`) : null,
              h('span', {}, `🕒 ${pvz.workTime}`),
              pvz.hasFitting ? h('span', { class: 'chip chip-sm' }, 'Примерочная') : null));
          listContainer.appendChild(pvzRow);
        });
      }

      renderPvzListItems();

      pvzBox.appendChild(h('div', { class: 'row gap-2 spread' },
        h('b', { class: 'small' }, 'Выберите город и ПВЗ СДЭК:'),
        citySelect));
      pvzBox.appendChild(filterInput);
      pvzBox.appendChild(listContainer);
      deliveryBox.appendChild(pvzBox);
    }

    // Поля получателя
    deliveryBox.appendChild(h('div', { class: 'grid grid-2', style: { gap: '14px', marginBottom: '14px' } },
      h('div', { class: 'field' },
        h('label', {}, 'Имя и фамилия получателя *'),
        h('input', { class: 'input', value: order.recipientName, placeholder: 'Иван Иванов', oninput: (e) => { order.recipientName = e.target.value; } })),
      h('div', { class: 'field' },
        h('label', {}, 'Телефон получателя *'),
        h('input', { class: 'input', value: order.recipientPhone, placeholder: '+7 900 123-45-67', oninput: (e) => { order.recipientPhone = e.target.value; } }))));

    deliveryBox.appendChild(h('div', { class: 'field' },
      h('label', {}, deliveryType === 'cdek_courier' ? 'Адрес доставки курьером *' : 'Адрес доставки / Пункт выдачи'),
      h('input', {
        class: 'input',
        value: order.recipientAddress,
        placeholder: deliveryType === 'cdek_courier' ? 'Город, улица, дом, корпус, квартира, домофон' : 'Адрес ПВЗ или филиала',
        oninput: (e) => { order.recipientAddress = e.target.value; },
      })));

    deliveryBox.appendChild(h('div', { class: 'notice notice-info', style: { marginTop: '10px' } }, icon('shield', 15),
      h('div', { class: 'tiny' }, 'Таможенные лимиты ЕАЭС: до 200 € и 31 кг на одну посылку беспошлинно. При превышении наши декларанты заранее свяжутся с вами.')));
  }

  function renderComment() {
    commentBox.innerHTML = '';
    commentBox.appendChild(h('div', { class: 'card-head' }, icon('chat', 20), h('h3', {}, 'Комментарий к заказу')));
    commentBox.appendChild(h('textarea', {
      class: 'textarea',
      placeholder: 'Например: сохранить оригинальные коробки без деформации, не срезать бирки Dewu, позвонить перед доставкой…',
      oninput: (e) => { order.comment = e.target.value; },
    }));
  }

  async function renderPayment() {
    payBox.innerHTML = '';
    payBox.appendChild(h('div', { class: 'card-head' }, icon('wallet', 20), h('h3', {}, 'Способ оплаты')));

    const totalRub = cart.quote.breakdown.total;
    const cur = cart.quote.currency;

    // Выбор инструмента оплаты
    payBox.appendChild(h('div', { class: 'tiny muted', style: { marginBottom: '8px', fontWeight: 600 } }, 'ВЫБЕРИТЕ СПОСОБ ОПЛАТЫ (100% ПРЕДОПЛАТА):'));
    const w = state.user.wallet;
    const opts = [
      { id: 'card', title: 'Банковская карта', sub: 'МИР, Visa, MasterCard · 3-D Secure', icon: 'wallet' },
      { id: 'sbp', title: 'СБП / ЕРИП (QR-код)', sub: 'Моментальная оплата со смартфона без комиссии', icon: 'refresh' },
      { id: 'wallet', title: 'С баланса кошелька', sub: `доступно ${money(w.mainView, state.currency)} + бонусы ${money(w.bonusView, state.currency)}`, icon: 'gift' },
      { id: 'combined', title: 'Комбинированная оплата', sub: 'бонусы → баланс → доплата картой', icon: 'chart' },
    ];

    payBox.appendChild(h('div', { class: 'stack gap-2' }, opts.map((o) =>
      h('label', {
        class: 'card',
        style: {
          display: 'flex', gap: '12px', alignItems: 'center', padding: '12px 14px', cursor: 'pointer',
          borderColor: method === o.id ? 'var(--brand)' : 'var(--border)',
          background: method === o.id ? 'var(--brand-soft)' : 'var(--card-2)',
        },
      },
        h('input', {
          type: 'radio', name: 'paymethod', checked: method === o.id,
          style: { accentColor: 'var(--brand)' },
          onchange: () => { method = o.id; renderPayment(); },
        }),
        icon(o.icon, 18),
        h('div', {},
          h('b', { class: 'small' }, o.title),
          h('div', { class: 'tiny muted' }, o.sub))))));

    if (method === 'wallet' || method === 'combined') {
      const planBox = h('div', { class: 'stack gap-2', style: { marginTop: '14px' } }, spinner('Считаем распределение…'));
      payBox.appendChild(planBox);
      try {
        const requiredNow = totalRub;
        const bonus = Math.min(w.wallet.available.bonus, requiredNow);
        const rest = requiredNow - bonus;
        const main = Math.min(w.wallet.available.main, rest);
        const card = rest - main;
        planBox.innerHTML = '';
        planBox.appendChild(h('div', { class: 'breakdown' },
          row('С бонусов', money(bonus, 'RUB'), bonus > 0),
          row('С основного баланса', money(main, 'RUB'), main > 0),
          row(method === 'wallet' && card > 0 ? 'Не хватает на балансе' : 'Доплата картой', money(card, 'RUB'), true, card > 0 && method === 'wallet' ? 'var(--danger)' : 'var(--brand)')));
        if (method === 'wallet' && card > 0) {
          planBox.appendChild(h('div', { class: 'notice notice-warn', style: { marginTop: '10px' } }, icon('info', 15),
            h('div', { class: 'tiny' }, 'Недостаточно средств. Пополните баланс или выберите оплату картой / комбинированную.'),
            h('button', { class: 'btn btn-soft btn-sm', onclick: () => navigate('#/account/wallet') }, 'Пополнить')));
        }
      } catch (e) { planBox.textContent = e.message; }
    }

    function row(label, value, strong, color) {
      return h('div', { class: 'brow' }, h('span', { class: 'b-label' }, label),
        h('span', { class: 'b-value', style: color ? { color } : null }, value));
    }
  }

  function renderSummary() {
    summary.innerHTML = '';
    const q = cart.quote;
    const cur = q.currency;
    const totalRub = q.breakdown.total;

    summary.appendChild(h('div', { class: 'card-head' }, icon('box', 20), h('h3', {}, 'Ваш мульти-заказ')));
    summary.appendChild(h('div', { class: 'stack gap-2', style: { maxHeight: '240px', overflow: 'auto', marginBottom: '12px' } },
      cart.items.map((it) => {
        const line = q.lines.find((l) => l.id === it.id) || {};
        return h('div', { class: 'row gap-3', style: { padding: '8px 0', borderBottom: '1px solid var(--border)' } },
          h('img', { src: it.imageUrl || `/img/p/${encodeURIComponent(it.title)}.svg`, style: { width: '44px', height: '44px', objectFit: 'cover', borderRadius: '8px' } }),
          h('div', { class: 'grow' },
            h('div', { class: 'small', style: { fontWeight: 600 } }, it.title),
            h('div', { class: 'tiny dim' }, [it.color, it.size, `${it.qty} шт.`].filter(Boolean).join(' · '))),
          h('b', { class: 'small mono nowrap' }, money(line.lineTotal ?? 0, cur)));
      })));

    summary.appendChild(h('div', { class: 'breakdown' },
      brow('Товар', `${(q.goodsCnyMinor / 100).toLocaleString('ru-RU')} ¥`, q.breakdown.goods),
      brow(`Комиссия сервиса · ${Math.round(q.commissionRate * 100)}% (${q.tier})`, '', q.breakdown.commission),
      brow(`Доставка СДЭК · ${q.weight.billableKg} кг × $${q.tariffUsdPerKg}`, deliveryType === 'cdek_courier' ? '+курьер' : 'до ПВЗ', q.breakdown.shipping),
      brow(`Упаковка · ${q.packaging.places} место`, packName(q.packaging.code), q.breakdown.packaging),
      brow('Страховка', q.insurance.enabled ? `${(q.insurance.rate * 100).toFixed(0)}%` : '—', q.breakdown.insurance),
      brow('Разгрузка', q.unloading.applies ? `$${q.unloading.usd}` : '—', q.breakdown.unloading),
      h('div', { class: 'divider', style: { margin: '8px 0' } }),
      h('div', { class: 'brow total', style: { marginTop: '4px' } },
        h('span', { class: 'b-label' }, 'Итого к оплате'),
        h('span', { class: 'b-value', style: { color: 'var(--brand)', fontSize: '20px' } }, money(totalRub, cur)))));

    const btnLabel = `Оплатить заказ (${money(totalRub, cur)})`;

    summary.appendChild(h('button', {
      class: 'btn btn-primary btn-lg btn-block',
      style: { marginTop: '16px' },
      onclick: submit,
    }, icon('lock', 17), btnLabel));

    summary.appendChild(h('p', { class: 'tiny dim center', style: { marginTop: '10px' } }, 'Нажимая кнопку, вы принимаете условия публичной оферты и регламент Legit Check'));
  }

  function brow(label, sub, value) {
    return h('div', { class: 'brow' }, h('span', { class: 'b-label' }, label, sub ? h('span', { class: 'tiny dim' }, ` · ${sub}`) : null),
      h('span', { class: 'b-value' }, money(value, cart.currency)));
  }

  async function submit() {
    if (!order.recipientName || !order.recipientPhone) return toast('Заполните данные', 'Укажите имя и телефон получателя', 'err');
    if (deliveryType === 'cdek_courier' && !order.recipientAddress) {
      return toast('Укажите адрес', 'Введите адрес для доставки курьером до двери', 'err');
    }
    const btn = summary.querySelector('button.btn-primary');
    btn.disabled = true; btn.appendChild(h('span', { class: 'spinner', style: { width: '15px', height: '15px', marginLeft: '8px' } }));
    try {
      const created = await endpoints.createOrder({
        destination: cart.destination,
        currency: cart.quote.currency,
        paymentPlan: 'full',
        deliveryType,
        cdekPvz: selectedPvz,
        payNow: method !== 'card' && method !== 'sbp',
        method,
        recipientName: order.recipientName,
        recipientPhone: order.recipientPhone,
        recipientAddress: order.recipientAddress,
        comment: order.comment,
      });
      await refreshCart(); await refreshUser();
      if (created.paymentStatus === 'succeeded' || created.paidMinor > 0) {
        toast('Заказ успешно создан', `${created.orderNo} · Оплачено ${money(created.paidMinor, created.currency)}`, 'ok');
        return navigate(`#/orders/${created.id}`);
      }
      // Карта / СБП модалка
      payCardModal(created);
    } catch (e) {
      toast('Ошибка оформления', e.message, 'err');
      btn.disabled = false;
    }
  }

  function payCardModal(createdOrder) {
    const cur = createdOrder.currency;
    const dueAmount = createdOrder.totalMinor;
    const m = modal({
      title: `Оплата заказа ${createdOrder.orderNo}`,
      wide: false,
      body: h('div', {},
        h('div', { class: 'notice notice-info', style: { marginBottom: '14px' } }, icon('lock', 16),
          h('div', { class: 'small' }, 'Демо-режим: безопасный платёжный шлюз (ЮKassa / bePaid / СБП QR).')),
        h('div', { class: 'breakdown' },
          h('div', { class: 'brow total' }, h('span', { class: 'b-label' }, 'К списанию сейчас'), h('span', { class: 'b-value' }, money(dueAmount, cur)))),
        h('div', { class: 'grid grid-2', style: { marginTop: '14px' } },
          h('div', { class: 'field' }, h('label', {}, 'Номер карты'), h('input', { class: 'input mono', placeholder: '0000 0000 0000 0000', value: '4111 1111 1111 1111' })),
          h('div', { class: 'field' }, h('label', {}, 'Срок / CVV'), h('div', { class: 'row gap-2' }, h('input', { class: 'input mono', placeholder: '12/28', value: '12/28' }), h('input', { class: 'input mono', placeholder: '123', value: '123', style: { width: '78px' } }))))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => { m.close(); navigate(`#/orders/${createdOrder.id}`); } }, 'Оплатить позже'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const btns = [...document.querySelectorAll('.modal .btn')]; btns.forEach((b) => (b.disabled = true));
            try {
              const paid = await endpoints.payOrder(createdOrder.id, { method: method === 'sbp' ? 'sbp' : 'card' });
              await refreshUser();
              m.close();
              toast('Оплата успешно проведена', `${createdOrder.orderNo} · ${money(paid.totalMinor, cur)}`, 'ok');
              navigate(`#/orders/${createdOrder.id}`);
            } catch (e) {
              btns.forEach((b) => (b.disabled = false));
              toast('Ошибка оплаты', e.message, 'err');
            }
          },
        }, icon('check', 16), `Оплатить ${money(dueAmount, cur)}`),
      ],
    });
  }

  renderDelivery();
  renderComment();
  renderSummary();
  await renderPayment();
  return wrap;
}
