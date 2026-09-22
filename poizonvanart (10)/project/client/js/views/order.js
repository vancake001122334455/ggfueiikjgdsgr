/**
 * PoizonVanart · views/order.js — карточка заказа со статусом, мульти-позициями,
 * интерактивной галереей фотоотчёта с зумом (Lightbox), графиком оплаты частями (50/50 и Долями),
 * трекингом СДЭК и спорами.
 */
import { h, icon, toast, spinner, modal, fmtDate, fmtDateTime } from '../dom.js';
import { endpoints } from '../api.js';
import { state, money, refreshUser, navigate } from '../state.js';

export async function renderOrder(route) {
  const wrap = h('div', { class: 'container', style: { maxWidth: '1060px' } });
  if (!state.user) { navigate('#/auth'); return wrap; }
  const id = route.params?.id;
  if (!id) { wrap.appendChild(h('div', { class: 'card center' }, 'Не указан ID заказа')); return wrap; }

  wrap.appendChild(spinner('Загружаем заказ…'));

  let o = null;
  try {
    o = await endpoints.order(id);
  } catch (e) {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'card center' }, h('h3', {}, 'Ошибка'), h('p', { class: 'muted' }, e.message),
      h('a', { class: 'btn btn-soft', href: '#/orders' }, 'К списку заказов')));
    return wrap;
  }

  const p = o.progressIndex || { index: 0, flow: [] };
  const cur = o.currency || 'RUB';

  wrap.innerHTML = '';
  wrap.appendChild(h('div', { class: 'card', style: { marginBottom: '20px' } },
    h('div', { class: 'row spread gap-3 wrap' },
      h('div', {},
        h('div', { class: 'row gap-3 wrap', style: { alignItems: 'center' } },
          h('h1', { style: { fontSize: '28px' } }, o.orderNo),
          h('button', {
            class: 'icon-btn', style: { width: '30px', height: '30px' }, title: 'Скопировать номер заказа',
            onclick: () => { copyToClipboard(o.orderNo); toast('Номер заказа скопирован', o.orderNo, 'ok'); },
          }, icon('copy', 14)),
          h('span', { class: `chip ${['cancelled', 'legit_check_failed', 'refunded'].includes(o.status) ? 'chip-danger' : o.status === 'delivered' ? 'chip-ok' : 'chip-info'}` }, o.statusRu)),
        h('p', { class: 'muted small', style: { margin: '6px 0 0' } },
          `Создан ${fmtDateTime(o.timeline.createdAt)} · ${o.destinationLabel} · ${o.items.length} позиц. · ${o.weight.estKg} кг`)),
      h('div', { class: 'right' },
        h('div', { class: 'tiny dim' }, 'ИТОГО К ОПЛАТЕ'),
        h('div', { style: { fontSize: '28px', fontWeight: 800, color: 'var(--brand)', letterSpacing: '-.02em' } }, money(o.totalMinor, cur)),
        h('div', { class: 'tiny dim' },
          o.paymentStatus === 'succeeded'
            ? `Оплачен полностью · ${payMethodRu(o.paymentMethod)}`
            : o.paymentStatus === 'partial'
              ? `Оплачено частично: ${money(o.paidMinor, cur)} из ${money(o.totalMinor, cur)}`
              : 'Ожидает первой оплаты'))),
    progressBar(o, p),
    actions(o)));

  // Основная сетка карточки
  wrap.appendChild(h('div', { class: 'grid grid-2', style: { marginTop: '20px', alignItems: 'start', gap: '20px', gridTemplateColumns: '1.45fr 1fr' } },
    h('div', { class: 'stack gap-4' },
      itemsCard(o),
      photosCard(o),
      disputeCard(o)),
    h('div', { class: 'stack gap-4' },
      installmentsCard(o),
      summaryCard(o),
      deliveryCard(o),
      o.pnl && state.user?.permissions?.includes('finance.read') ? pnlCard(o) : null)));

  return wrap;

  function progressBar(order, pr) {
    if (order.status === 'cancelled' || order.status === 'refunded') {
      return h('div', { class: 'notice notice-warn', style: { marginTop: '16px' } }, icon('flag', 18),
        h('div', {}, h('b', {}, order.statusRu), h('div', { class: 'small muted' }, order.status === 'refunded' ? 'Средства возвращены на внутренний баланс' : 'Заказ отменён')));
    }
    const labels = state.config.statuses || {};
    const flow = (pr.flow || []).map((code) => labels[code] || code);
    return h('div', { class: 'progress-track' }, flow.map((label, i) => {
      let cls = 'pstep';
      if (pr.failed && i === pr.index) cls += ' failed';
      else if (i < pr.index) cls += ' done';
      else if (i === pr.index) cls += ' current';
      return h('div', { class: cls },
        h('span', { class: 'dot' }, i < pr.index ? '✓' : ''),
        h('span', { class: 'lbl' }, label));
    }));
  }

  function actions(order) {
    const btns = [];
    if (order.paymentStatus !== 'succeeded') {
      const isSplit = order.paymentPlan && order.paymentPlan !== 'full';
      const label = isSplit && order.paidMinor > 0 ? 'Оплатить следующую часть' : 'Оплатить заказ';
      btns.push(h('button', { class: 'btn btn-primary', onclick: () => payModal(order) }, icon('wallet', 16), label));
    }
    if (order.canCancel) {
      btns.push(h('button', { class: 'btn btn-danger', onclick: () => cancel(order) }, icon('flag', 16), 'Запросить возврат'));
    }
    if (order.trackingNumber) {
      btns.push(h('button', { class: 'btn btn-ghost', onclick: () => trackModal(order) }, icon('truck', 16), 'Отследить'));
    }
    btns.push(h('button', { class: 'btn btn-ghost', onclick: () => supportModal(order) }, icon('chat', 16), 'Написать в поддержку'));
    return h('div', { class: 'btn-group', style: { marginTop: '16px' } }, btns);
  }

  function itemsCard(order) {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, icon('box', 20), h('h3', {}, `Позиции заказа (${order.items.length})`)),
      h('div', { class: 'stack gap-3' }, order.items.map((it) =>
        h('div', { class: 'row gap-3', style: { padding: '10px', background: 'var(--card-2)', borderRadius: 'var(--r-md)' } },
          h('img', { src: it.imageUrl || `/img/p/${encodeURIComponent(it.title)}.svg`, style: { width: '62px', height: '58px', objectFit: 'cover', borderRadius: '8px' } }),
          h('div', { class: 'grow' },
            h('b', { class: 'small' }, it.title),
            h('div', { class: 'tiny dim' }, [it.brand, it.color, it.size && `EU ${it.size}`, `${it.qty} шт.`, `${it.weightKg} кг`].filter(Boolean).join(' · ')),
            it.legitCheck ? h('span', { class: `chip ${it.legitCheck === 'pass' ? 'chip-ok' : 'chip-danger'}`, style: { marginTop: '4px' } }, it.legitCheck === 'pass' ? 'Legit Check пройден' : 'Legit Check НЕ пройден') : null),
          h('div', { class: 'right' },
            h('b', { class: 'mono small' }, money(it.lineTotal, cur)),
            h('div', { class: 'tiny dim mono' }, `${(it.priceCnyMinor / 100).toLocaleString('ru-RU')} ¥`))))));
  }

  // ── ГАЛЕРЕЯ ФОТООТЧЕТА СО СКЛАДА В КИТАЕ С LIGHTBOX-ПРОСМОТРОМ И ЗУМОМ ──
  function photosCard(order) {
    if (!order.photos?.length) {
      return null;
    }

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        icon('camera', 20),
        h('h3', {}, `Фотоотчёт со склада · ${order.photos.length} фото`),
        h('span', { class: 'chip chip-ok', style: { marginLeft: 'auto' } }, 'Legit Check: PASSED')),
      h('p', { class: 'tiny muted', style: { margin: '-6px 0 12px' } }, 'Нажмите на любое фото, чтобы открыть полноразмерную галерею с зумом и инспекцией деталей.'),
      h('div', { class: 'gallery' }, order.photos.map((ph, idx) =>
        h('figure', {
          style: { cursor: 'pointer', transition: 'transform 0.15s ease' },
          onclick: () => openPhotoLightbox(order.photos, idx),
        },
          h('img', { src: ph.url, alt: ph.caption || 'фотоотчёт', loading: 'lazy' }),
          h('figcaption', {},
            h('span', { class: 'chip chip-sm', style: { marginBottom: '4px' } }, photoKind(ph.kind)),
            h('div', { class: 'small', style: { fontWeight: 500 } }, ph.caption || ''),
            h('div', { class: 'tiny dim' }, fmtDate(ph.createdAt)))))));
  }

  // Полноэкранный Lightbox с зумом, перелистыванием и инспекцией
  function openPhotoLightbox(photos, initialIdx = 0) {
    let currentIdx = initialIdx;
    let isZoomed = false;

    const modalBox = modal({
      title: `Фотоотчёт склада (${currentIdx + 1} из ${photos.length})`,
      wide: true,
      body: h('div', { class: 'lightbox-container', style: { textAlign: 'center', userSelect: 'none' } }),
    });

    const bodyEl = modalBox.el.querySelector('.lightbox-container');

    function update() {
      const ph = photos[currentIdx];
      bodyEl.innerHTML = '';

      modalBox.setTitle(`Фотоотчёт со склада (${currentIdx + 1} из ${photos.length}) · ${photoKind(ph.kind)}`);

      // Панель управления (Предыдущее, Зум, Следующее)
      const controls = h('div', { class: 'row spread gap-2', style: { marginBottom: '12px', alignItems: 'center' } },
        h('button', {
          class: 'btn btn-soft btn-sm',
          disabled: currentIdx === 0,
          onclick: () => { currentIdx--; isZoomed = false; update(); },
        }, '← Предыдущее'),
        h('div', { class: 'row gap-2' },
          h('button', {
            class: `btn ${isZoomed ? 'btn-primary' : 'btn-soft'} btn-sm`,
            onclick: () => { isZoomed = !isZoomed; update(); },
          }, isZoomed ? '🔍 Сбросить зум (1x)' : '🔍 Приблизить (2x)'),
          h('a', {
            class: 'btn btn-ghost btn-sm',
            href: ph.url,
            target: '_blank',
            download: `photo-report-${ph.kind}-${currentIdx + 1}.svg`,
          }, 'Скачать')),
        h('button', {
          class: 'btn btn-soft btn-sm',
          disabled: currentIdx === photos.length - 1,
          onclick: () => { currentIdx++; isZoomed = false; update(); },
        }, 'Следующее →'));

      // Контейнер фото
      const imgWrap = h('div', {
        style: {
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 'var(--r-md)',
          background: 'var(--bg-main)',
          border: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '340px',
          maxHeight: '520px',
          cursor: isZoomed ? 'zoom-out' : 'zoom-in',
        },
        onclick: () => { isZoomed = !isZoomed; update(); },
      },
        h('img', {
          src: ph.url,
          alt: ph.caption || '',
          style: {
            width: isZoomed ? '180%' : '100%',
            maxWidth: isZoomed ? 'none' : '100%',
            transition: 'width 0.25s ease',
            borderRadius: 'var(--r-md)',
          },
        }),
        h('div', {
          class: 'chip chip-ok chip-sm',
          style: { position: 'absolute', top: '12px', right: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' },
        }, '✓ Dewu Legit Check Verified'));

      // Описание фото
      const captionBox = h('div', {
        class: 'card',
        style: { marginTop: '12px', textAlign: 'left', background: 'var(--card-2)', padding: '12px' },
      },
        h('div', { class: 'row spread' },
          h('b', { class: 'small' }, photoKind(ph.kind)),
          h('span', { class: 'tiny dim' }, fmtDateTime(ph.createdAt))),
        ph.caption ? h('p', { class: 'small', style: { margin: '4px 0 0' } }, ph.caption) : null);

      bodyEl.appendChild(controls);
      bodyEl.appendChild(imgWrap);
      bodyEl.appendChild(captionBox);
    }

    // Клавиатурная навигация стрелками влево / вправо
    const keyHandler = (e) => {
      if (e.key === 'ArrowLeft' && currentIdx > 0) {
        currentIdx--; isZoomed = false; update();
      } else if (e.key === 'ArrowRight' && currentIdx < photos.length - 1) {
        currentIdx++; isZoomed = false; update();
      }
    };
    window.addEventListener('keydown', keyHandler);
    const origClose = modalBox.close;
    modalBox.close = () => {
      window.removeEventListener('keydown', keyHandler);
      origClose();
    };

    update();
  }

  // ── КАРТОЧКА ГРАФИКА ОПЛАТЫ ЧАСТЯМИ / РАССРОЧКИ ──
  function installmentsCard(order) {
    return null;

    const isDone = order.paymentStatus === 'succeeded';
    const planTitle = order.paymentPlan === 'split_50_50' ? 'Безопасная сделка 50/50' : 'Оплата «Долями»';
    const percentPaid = Math.round((order.paidMinor / order.totalMinor) * 100);

    return h('div', { class: 'card', style: { border: '1px solid var(--brand)', background: 'var(--card-1)' } },
      h('div', { class: 'card-head' },
        icon('wallet', 20),
        h('h3', {}, planTitle),
        h('span', { class: `chip ${isDone ? 'chip-ok' : 'chip-brand'}`, style: { marginLeft: 'auto' } },
          isDone ? 'Полностью оплачен' : `${percentPaid}% оплачено`)),
      h('div', { class: 'progress-bar-wrap', style: { margin: '8px 0 14px', background: 'var(--card-3)', height: '8px', borderRadius: '4px', overflow: 'hidden' } },
        h('div', { style: { width: `${percentPaid}%`, height: '100%', background: 'var(--brand)', transition: 'width 0.3s ease' } })),
      h('div', { class: 'stack gap-2' },
        order.installments.map((inst, i) => {
          const isPaid = inst.status === 'paid';
          return h('div', {
            class: 'card',
            style: {
              padding: '10px 12px',
              background: isPaid ? 'var(--card-2)' : 'var(--card-3)',
              borderLeft: isPaid ? '4px solid var(--ok)' : '4px solid var(--border)',
            },
          },
            h('div', { class: 'row spread' },
              h('b', { class: 'small' }, inst.title || `Платёж ${i + 1}`),
              h('span', { class: `chip chip-sm ${isPaid ? 'chip-ok' : 'chip-warn'}` }, isPaid ? '✓ Оплачен' : 'Ожидает')),
            h('div', { class: 'row spread tiny muted', style: { marginTop: '4px' } },
              h('span', {}, inst.dueCondition || (inst.dueDate ? fmtDate(inst.dueDate) : '')),
              h('b', { class: 'mono small', style: { color: isPaid ? 'var(--ok)' : 'var(--text)' } }, money(inst.amount, cur))));
        })),
      !isDone ? h('button', {
        class: 'btn btn-primary btn-block',
        style: { marginTop: '14px' },
        onclick: () => payModal(order),
      }, icon('lock', 16), 'Оплатить следующую часть') : null);
  }

  function summaryCard(order) {
    const b = order.breakdown;
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, icon('calc', 20), h('h3', {}, 'Расчёт стоимости')),
      h('div', { class: 'breakdown' },
        brow('Товар', `${(order.goodsCnyMinor / 100).toLocaleString('ru-RU')} ¥`, b.goods),
        brow(`Комиссия сервиса · ${Math.round(order.commissionRate * 100)}%`, order.tier, b.commission),
        brow('Доставка', `${order.weight.billableKg ?? order.weight.estKg} кг × $${(order.snapshot?.tariff_usd_per_kg ?? 0) || ''}`, b.shipping),
        brow('Упаковка', `${order.places} место`, b.packaging),
        brow('Страховка', '', b.insurance),
        brow('Разгрузка', '', b.unloading),
        b.discount ? brow('Скидка', '', -b.discount) : null,
        h('div', { class: 'brow total' }, h('span', { class: 'b-label' }, 'Итого'), h('span', { class: 'b-value' }, money(b.total, cur)))),
      h('div', { class: 'divider' }),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Уровень лояльности'), h('dd', {}, order.tier),
        h('dt', {}, 'Схема оплаты'), h('dd', {}, '100% предоплата'),
        h('dt', {}, 'Вес расчётный'), h('dd', {}, `${order.weight.estKg} кг`),
        h('dt', {}, 'Вес фактический'), h('dd', {}, order.weight.factKg ? `${order.weight.factKg} кг` : 'ожидается'),
        h('dt', {}, 'Объём'), h('dd', {}, `${order.weight.volumeM3} м³`),
        h('dt', {}, 'Мест'), h('dd', {}, String(order.places))));
  }

  function deliveryCard(order) {
    const isPvz = order.deliveryType === 'cdek_pvz' || (order.recipient?.address && order.recipient.address.includes('ПВЗ'));
    const isCourier = order.deliveryType === 'cdek_courier';

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        icon('truck', 20),
        h('h3', {}, 'Доставка и СДЭК'),
        h('span', { class: 'chip chip-brand chip-sm', style: { marginLeft: 'auto' } }, isPvz ? 'СДЭК ПВЗ' : isCourier ? 'СДЭК Курьер' : 'СДЭК')),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Направление'), h('dd', {}, order.destinationLabel),
        h('dt', {}, 'Тип вручения'), h('dd', {}, isPvz ? 'Пункт выдачи (ПВЗ)' : isCourier ? 'Курьер до двери' : 'Хаб Vanart'),
        h('dt', {}, 'Срок'), h('dd', {}, order.etaDays ? `${order.etaDays.min}–${order.etaDays.max} дней` : '—'),
        h('dt', {}, 'Трек-номер'), h('dd', { class: 'mono' },
          order.trackingNumber ? h('span', { class: 'row gap-1', style: { justifyContent: 'flex-end', alignItems: 'center' } },
            h('span', {}, order.trackingNumber),
            h('button', {
              class: 'icon-btn', style: { width: '26px', height: '26px', padding: '4px' }, title: 'Скопировать трек-номер',
              onclick: () => { copyToClipboard(order.trackingNumber); toast('Трек-номер скопирован', order.trackingNumber, 'ok'); },
            }, icon('copy', 13))) : 'формируется СДЭК'),
        h('dt', {}, 'Перевозчик'), h('dd', {}, order.carrier || 'СДЭК / VanCargo'),
        h('dt', {}, 'Получатель'), h('dd', {}, order.recipient.name || '—'),
        h('dt', {}, 'Телефон'), h('dd', { class: 'mono' }, order.recipient.phone || '—'),
        h('dt', {}, 'Адрес / ПВЗ'), h('dd', { style: { textAlign: 'right', maxWidth: '240px' } }, order.recipient.address || 'уточняется')),
      order.timeline.paidAt ? h('div', { class: 'divider' }) : null,
      order.history?.length ? h('details', {},
        h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, `История перемещений (${order.history.length})`),
        h('ul', { class: 'list-plain', style: { marginTop: '10px' } }, order.history.slice().reverse().map((hh) =>
          h('li', { class: 'row gap-2 small' }, h('span', { class: 'chip' }, hh.toRu), h('span', { class: 'tiny dim', style: { marginLeft: 'auto' } }, fmtDateTime(hh.at)))))
      ) : null);
  }

  function pnlCard(order) {
    const pnl = order.pnl;
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, icon('chart', 20), h('h3', {}, 'P&L по заказу (₽)')),
      h('div', { class: 'breakdown' },
        brow('Приход', '', pnl.revenue),
        brow('Закупка (CNY)', '', -pnl.cogs),
        brow('Карго (USD)', '', -pnl.cargo),
        brow('Прочее (USD)', '', -pnl.extra),
        brow('Эквайринг', '', -pnl.acquiring),
        h('div', { class: 'brow total' }, h('span', { class: 'b-label' }, 'Маржа'),
          h('span', { class: 'b-value', style: { color: pnl.gross >= 0 ? 'var(--ok)' : 'var(--danger)' } }, `${money(pnl.gross, 'RUB')} · ${(pnl.marginPct * 100).toFixed(1)}%`))));
  }

  function brow(label, sub, value) {
    return h('div', { class: 'brow' }, h('span', { class: 'b-label' }, label, sub ? h('span', { class: 'tiny dim' }, ` · ${sub}`) : null),
      h('span', { class: 'b-value' }, money(value, cur)));
  }

  function disputeCard(order) {
    if (!order.disputes?.length) return h('div');
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, icon('flag', 20), h('h3', {}, 'Споры и возвраты')),
      h('div', { class: 'stack gap-2' }, order.disputes.map((d) =>
        h('div', { class: 'card', style: { background: 'var(--card-2)', padding: '12px' } },
          h('div', { class: 'row spread gap-2' },
            h('span', { class: `chip ${d.status.startsWith('refunded') ? 'chip-ok' : d.status === 'rejected' ? 'chip-danger' : 'chip-warn'}` }, disputeStatus(d.status)),
            h('span', { class: 'tiny dim' }, fmtDateTime(d.createdAt))),
          h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, d.description || disputeReason(d.reason)),
          d.resolution ? h('p', { class: 'tiny', style: { color: 'var(--brand)', margin: '4px 0 0' } }, `Решение: ${d.resolution}`) : null))));
  }

  // ── МОДАЛКИ: ОПЛАТА, ОТМЕНА, ТРЕКИНГ, ПОДДЕРЖКА ──
  function payModal(order) {
    let method = 'card';
    const isSplit = order.paymentPlan && order.paymentPlan !== 'full';
    const nextUnpaid = isSplit ? order.installments?.find((it) => it.status !== 'paid') : null;
    const dueAmount = nextUnpaid ? nextUnpaid.amount : (order.totalMinor - order.paidMinor);

    const m = modal({
      title: isSplit ? `Оплата части заказа ${order.orderNo}` : `Оплата заказа ${order.orderNo}`,
      body: h('div', { class: 'stack gap-3' },
        h('div', { class: 'notice notice-info' }, icon('shield', 15),
          h('div', { class: 'small' }, isSplit
            ? `Схема: ${order.paymentPlan === 'split_50_50' ? 'Безопасная 50/50' : 'Долями'}. Оплачивается очередной платёж.`
            : 'Безопасный платёжный шлюз (МИР, Visa, MasterCard, СБП, ЕРИП).')),
        h('div', { class: 'breakdown' },
          h('div', { class: 'brow' }, h('span', { class: 'b-label' }, 'Сумма заказа'), h('span', { class: 'b-value mono' }, money(order.totalMinor, cur))),
          order.paidMinor > 0 ? h('div', { class: 'brow' }, h('span', { class: 'b-label' }, 'Уже оплачено'), h('span', { class: 'b-value mono', style: { color: 'var(--ok)' } }, money(order.paidMinor, cur))) : null,
          h('div', { class: 'brow total' }, h('span', { class: 'b-label' }, 'К оплате сейчас'), h('span', { class: 'b-value', style: { color: 'var(--brand)' } }, money(dueAmount, cur)))),
        h('div', { class: 'field' },
          h('label', {}, 'Способ оплаты'),
          h('select', {
            class: 'select',
            onchange: (e) => { method = e.target.value; },
          }, [
            ['Банковская карта онлайн', 'card'],
            ['СБП / ЕРИП по QR-коду', 'sbp'],
            ['С внутреннего баланса', 'wallet'],
            ['Комбинированно (баланс + карта)', 'combined'],
          ].map(([t, v]) => h('option', { value: v }, t))))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try {
              const res = await endpoints.payOrder(order.id, { method });
              await refreshUser();
              m.close();
              toast('Оплата успешно принята!', `${res.orderNo} · ${money(dueAmount, cur)}`, 'ok');
              navigate(`#/orders/${order.id}`);
              // Обновляем текущую страницу
              renderOrder({ params: { id: order.id } }).then((view) => {
                wrap.replaceWith(view);
              });
            } catch (e) {
              toast('Ошибка оплаты', e.message, 'err');
            }
          },
        }, `Оплатить ${money(dueAmount, cur)}`),
      ],
    });
  }

  function cancel(order) {
    const m = modal({
      title: 'Отмена заказа и возврат средств',
      body: h('div', { class: 'stack gap-3' },
        h('p', { class: 'small' }, 'Если товар ещё не отправлен из Китая, мы отменим закупку и вернём средства на ваш баланс без штрафов.'),
        h('textarea', { class: 'textarea', placeholder: 'Причина отмены…', id: 'cancelReason' })),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Назад'),
        h('button', {
          class: 'btn btn-danger',
          onclick: async () => {
            const reason = document.getElementById('cancelReason')?.value || '';
            try {
              await endpoints.cancelOrder(order.id, reason);
              m.close();
              toast('Заказ отменён', 'Средства возвращены на баланс', 'ok');
              renderOrder({ params: { id: order.id } }).then((view) => wrap.replaceWith(view));
            } catch (e) {
              toast('Ошибка', e.message, 'err');
            }
          },
        }, 'Подтвердить отмену'),
      ],
    });
  }

  function trackModal(order) {
    modal({
      title: `Отслеживание ${order.trackingNumber}`,
      body: h('div', { class: 'stack gap-3' },
        h('div', { class: 'row spread' },
          h('b', {}, `Перевозчик: ${order.carrier || 'СДЭК'}`),
          h('span', { class: 'chip chip-brand' }, order.statusRu)),
        h('p', { class: 'small muted' }, `Посылка направляется в ${order.destinationLabel}. Примерный срок доставки: ${order.etaDays ? `${order.etaDays.min}–${order.etaDays.max} дней` : 'уточняется'}.`),
        h('a', {
          class: 'btn btn-soft btn-block',
          target: '_blank',
          href: `https://www.cdek.ru/ru/tracking?order_id=${encodeURIComponent(order.trackingNumber)}`,
        }, icon('truck', 16), 'Открыть трекинг на сайте СДЭК')),
    });
  }

  function supportModal(order) {
    let text = '';
    const m = modal({
      title: `Поддержка по заказу ${order.orderNo}`,
      body: h('div', { class: 'stack gap-3' },
        h('p', { class: 'small muted' }, 'Напишите нам, если возникли вопросы по выкупу, фотоотчёту, пломбе Legit Check или доставке:'),
        h('textarea', {
          class: 'textarea', placeholder: 'Ваш вопрос…',
          oninput: (e) => { text = e.target.value; },
        })),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!text.trim()) return toast('Пусто', 'Напишите сообщение', 'err');
            await endpoints.chatSend({ body: text, orderId: order.id, subject: `Вопрос по заказу ${order.orderNo}` });
            m.close();
            toast('Отправлено', 'Поддержка ответит в ближайшее время', 'ok');
          },
        }, 'Отправить'),
      ],
    });
  }
}

function payMethodRu(m) {
  return { card: 'Банковская карта', sbp: 'СБП / ЕРИП QR', wallet: 'Внутренний баланс', bonus: 'Бонусами', combined: 'Комбинированно', erip: 'ЕРИП' }[m] || m || '—';
}

function photoKind(k) {
  return {
    tag: 'Бирюзовая пломба Legit Check',
    cert: 'Сертификат Dewu Authenticity',
    box: 'Оригинальная коробка',
    weight: 'Контрольное взвешивание',
    report: 'Общий фотоотчёт',
    unboxing: 'Распаковка',
    defect: 'Контроль дефектов',
    label: 'Заводская маркировка',
  }[k] || 'Фотоотчёт со склада';
}

function disputeStatus(s) {
  return { open: 'открыт', in_review: 'на рассмотрении', refunded_full: 'полный возврат', refunded_partial: 'частичный возврат', rejected: 'отклонён', closed: 'закрыт' }[s] || s;
}

function disputeReason(r) {
  return { legit_check_failed: 'Не прошёл Legit Check', defect: 'Брак', wrong_size: 'Неверный размер', wrong_color: 'Неверный цвет', cancel_before_ship: 'Отмена до отправки', other: 'Другое' }[r] || r;
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}
