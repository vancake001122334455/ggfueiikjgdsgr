/**
 * PoizonVanart · views/admin.js — админ-панель и RBAC.
 * Разделы: Обзор, Заказы (массовые операции, экспорт, стикеры), Склад (Warehouse Mode),
 * TikTok-модерация, Рефералы, Курсы и тарифы, P&L, Пользователи и blacklist, Задачи, Споры, Аудит.
 */
import { h, icon, toast, spinner, emptyState, modal, fmtDate, fmtDateTime, timeAgo } from '../dom.js';
import { endpoints, api } from '../api.js';
import { state, money, can, isWarehouse, navigate, setCurrency } from '../state.js';
import { convertMinor } from '../money.js';

const ALL_TABS = [
  { id: 'overview', title: 'Обзор', icon: 'chart', perm: 'orders.read' },
  { id: 'orders', title: 'Заказы', icon: 'box', perm: 'orders.read' },
  { id: 'warehouse', title: 'Склад (Китай)', icon: 'camera', perm: 'orders.read' },
  { id: 'tiktok', title: 'TikTok-модерация', icon: 'tiktok', perm: 'tiktok.read' },
  { id: 'referrals', title: 'Рефералы', icon: 'gift', perm: 'referrals.read' },
  { id: 'rates', title: 'Курсы и тарифы', icon: 'gear', perm: 'rates.write' },
  { id: 'pnl', title: 'P&L и аналитика', icon: 'chart', perm: 'finance.read' },
  { id: 'users', title: 'Пользователи', icon: 'users', perm: 'users.read' },
  { id: 'disputes', title: 'Споры', icon: 'flag', perm: 'disputes.read' },
  { id: 'tasks', title: 'Задачи', icon: 'check', perm: 'tasks.read' },
  { id: 'audit', title: 'Аудит', icon: 'lock', perm: 'users.read' },
];

export async function renderAdmin(route) {
  const wrap = h('div', { class: 'container' });
  const warehouseOnly = isWarehouse();
  const tabs = ALL_TABS.filter((t) => can(t.perm));
  const tabId = tabs.find((t) => t.id === route.params[0])?.id || tabs[0]?.id || 'overview';
  const isOwner = state.user?.role === 'owner' || state.user?.role === 'admin';
  const content = h('div', { class: 'stack gap-4' });

  const restartBtn = isOwner
    ? h('button', {
        class: 'btn btn-primary btn-sm nowrap',
        style: { fontWeight: 700, gap: '6px' },
        title: 'Перезагрузить сайт (для владельца)',
        onclick: () => restartSiteAction(),
      }, icon('refresh', 14), '⚡ Перезагрузить сайт')
    : null;

  wrap.appendChild(h('div', { class: 'section-head' },
    h('div', {},
      h('h1', {}, warehouseOnly ? 'Складской режим' : 'Админ-панель'),
      h('p', { class: 'muted' },
        warehouseOnly
          ? 'Урезанный интерфейс: фотоотчёты, взвешивание, статусы. Финансовые данные скрыты.'
          : `${state.user.roleName} · ${state.user.publicUid} · прав: ${(state.user.permissions || []).length}`)),
    h('div', { class: 'row gap-2' },
      restartBtn,
      h('div', { class: 'segmented' }, ['RUB', 'BYN', 'USD'].map((c) =>
        h('button', { 'aria-pressed': String(state.currency === c), onclick: () => setCurrency(c) }, c))))));

  wrap.appendChild(h('div', { class: 'shell' },
    h('nav', { class: 'side-nav' },
      h('div', { class: 'nav-label' }, warehouseOnly ? 'Склад' : 'Управление'),
      ...tabs.map((t) => h('a', { href: `#/admin/${t.id}`, class: tabId === t.id ? 'active' : '' }, icon(t.icon, 16), t.title)),
      isOwner ? h('div', { class: 'nav-sep' }) : null,
      isOwner ? h('button', {
        class: 'side-nav-item',
        type: 'button',
        style: {
          background: 'rgba(255, 77, 45, 0.12)', border: '1px solid rgba(255, 77, 45, 0.3)',
          borderRadius: 'var(--r-md)', width: '100%', textAlign: 'left', cursor: 'pointer',
          color: 'var(--brand)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '8px',
          fontSize: '13px', fontWeight: 750, marginTop: '4px',
        },
        title: 'Перезагрузить сервер и сайт',
        onclick: () => restartSiteAction(),
      }, icon('refresh', 16), '⚡ Перезагрузка сайта') : null,
      h('div', { class: 'nav-sep' }),
      h('a', { href: '#/account' }, icon('user', 16), 'Личный кабинет')),
    content));

  content.appendChild(spinner());
  const renderers = { overview: tOverview, orders: tOrders, warehouse: tWarehouse, tiktok: tTiktok, referrals: tReferrals, rates: tRates, pnl: tPnl, users: tUsers, disputes: tDisputes, tasks: tTasks, audit: tAudit };
  try {
    content.innerHTML = '';
    content.appendChild(await renderers[tabId]());
  } catch (e) {
    content.innerHTML = '';
    content.appendChild(h('div', { class: 'notice notice-warn' }, icon('x', 16), h('div', {}, h('b', {}, 'Ошибка раздела'), h('div', { class: 'small' }, e.message))));
  }
  return wrap;
}

function restartSiteAction() {
  const m = modal({
    title: '⚡ Перезагрузка сайта',
    body: h('div', { class: 'stack gap-3' },
      h('p', {}, 'Вы действительно хотите перезагрузить сайт PoizonVanart?'),
      h('div', { class: 'notice notice-info' }, icon('shield', 18),
        h('div', { class: 'small' },
          h('b', {}, 'Безопасный перезапуск: '),
          'Сервер сохранит базу данных на диск, завершит активные транзакции и перезапустит сервис. Браузер обновится через 3 секунды.'))),
    footer: [
      h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
      h('button', {
        class: 'btn btn-primary',
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Перезагрузка…';
          try {
            await endpoints.admin.restartSystem();
            m.close();
            toast('Сервер перезагружается', 'Обновление страницы через 3 секунды…', 'ok', 4000);
            const overlay = h('div', {
              style: {
                position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(10, 12, 17, 0.95)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                color: '#fff', textAlign: 'center', padding: '20px',
              },
            },
              spinner(36),
              h('h3', { style: { marginTop: '20px', marginBottom: '8px' } }, '⚡ Перезагрузка сайта…'),
              h('p', { class: 'muted' }, 'Применение обновлений и перезапуск служб. Пожалуйста, подождите...'));
            document.body.appendChild(overlay);
            setTimeout(() => { location.reload(); }, 2800);
          } catch (err) {
            toast('Ошибка перезагрузки', err.message, 'err');
            e.target.disabled = false;
            e.target.textContent = '⚡ Подтвердить перезагрузку';
          }
        },
      }, icon('refresh', 16), '⚡ Подтвердить перезагрузку'),
    ],
  });
}

const kpi = (label, value, sub, ic, accent) => h('div', { class: `kpi ${accent ? 'kpi-accent' : ''}` },
  h('div', { class: 'row spread' }, h('span', { class: 'k-label' }, label), h('span', { class: 'dim' }, icon(ic, 16))),
  h('div', { class: 'k-value' }, value), sub ? h('div', { class: 'k-sub' }, sub) : null);

// ── ОБЗОР ──────────────────────────────────────────────────────────────────
async function tOverview() {
  const d = await endpoints.admin.overview();
  const wrap = h('div', { class: 'stack gap-4' });
  const k = d.kpi;
  wrap.appendChild(h('div', { class: 'grid grid-4' },
    kpi('Заказов всего', String(k.ordersTotal), `оплачено: ${k.ordersPaid}`, 'box'),
    kpi('В работе', String(k.inWork), `ожидают оплаты: ${k.awaitingPayment}`, 'refresh'),
    kpi('В пути', String(k.inTransit), `выдано: ${k.delivered}`, 'truck'),
    kpi('Клиентов', String(k.clientsTotal), k.avgCheckRub != null ? `средний чек ${money(k.avgCheckRub, 'RUB')}` : '', 'users')));

  if (d.pnl && !d.warehouseMode) {
    wrap.appendChild(h('div', { class: 'grid grid-3' },
      kpi('Приход', money(d.pnl.revenue, 'RUB'), 'по оплаченным заказам', 'wallet', true),
      kpi('Валовая маржа', money(d.pnl.gross, 'RUB'), `${(d.pnl.marginPct * 100).toFixed(1)}% от прихода`, 'chart', true),
      kpi('Чистая прибыль', money(d.pnl.net, 'RUB'), 'после OPEX', 'star', true)));
  }

  wrap.appendChild(h('div', { class: 'grid grid-2' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, icon('refresh', 20), h('h3', {}, 'Требует внимания')),
      h('div', { class: 'stack gap-2' },
        queueRow('tiktok', 'TikTok-заявки на модерации', d.pendingTiktok, '#/admin/tiktok'),
        queueRow('flag', 'Открытые споры', d.openDisputes, '#/admin/disputes'),
        queueRow('check', 'Задачи в работе', d.openTasks, '#/admin/tasks'),
        queueRow('camera', 'Склад: очередь выкупа', k.inWork, '#/admin/warehouse'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, icon('box', 20), h('h3', {}, 'Заказы по статусам')),
      h('div', { class: 'row gap-2 wrap' }, Object.entries(d.byStatus).map(([s, n]) =>
        h('span', { class: 'chip' }, (state.config.statuses || {})[s] || s, h('b', { style: { marginLeft: '4px' } }, String(n))))))));

  if (state.user?.role === 'owner' || state.user?.role === 'admin') {
    wrap.appendChild(h('div', { class: 'card', style: { border: '1px solid var(--brand)', background: 'linear-gradient(135deg, var(--card), var(--card-2))' } },
      h('div', { class: 'row spread wrap gap-3', style: { alignItems: 'center' } },
        h('div', {},
          h('div', { class: 'row gap-2', style: { alignItems: 'center', marginBottom: '4px' } },
            h('span', { class: 'chip chip-brand chip-sm' }, '👑 Только для владельца'),
            h('h4', { style: { margin: 0 } }, 'Управление сервером и платформой')),
          h('p', { class: 'small muted', style: { margin: 0 } },
            'Принудительный перезапуск серверных процессов с сохранением базы данных и автоматическим обновлением у клиентов.')),
        h('div', { class: 'row gap-2' },
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            onclick: () => restartSiteAction(),
          }, icon('refresh', 16), '⚡ Перезагрузить сайт')))));
  }

  return wrap;
}
const queueRow = (ic, title, count, href) => h('a', { class: 'card row gap-3', href, style: { padding: '12px 14px', background: 'var(--card-2)' } },
  icon(ic, 18), h('span', { class: 'small grow' }, title), h('b', { class: 'mono', style: { color: count ? 'var(--brand)' : 'var(--text-3)' } }, String(count || 0)));

// ── ЗАКАЗЫ ─────────────────────────────────────────────────────────────────
async function tOrders() {
  const wrap = h('div', { class: 'stack gap-4' });
  let orders = await endpoints.admin.orders();
  const selected = new Set();
  const filters = { status: '', destination: '', q: '' };
  const listBox = h('div', { class: 'table-wrap' });

  const search = h('input', { class: 'input', placeholder: 'Поиск: номер, User ID, трек, телефон…', style: { maxWidth: '320px' }, oninput: debounce(async (e) => { filters.q = e.target.value; await load(); }, 350) });
  const statusSel = h('select', { class: 'select', style: { maxWidth: '220px' }, onchange: async (e) => { filters.status = e.target.value; await load(); } },
    [h('option', { value: '' }, 'Все статусы'), ...Object.entries(state.config.statuses || {}).map(([k, v]) => h('option', { value: k }, v))]);
  const destSel = h('select', { class: 'select', style: { maxWidth: '190px' }, onchange: async (e) => { filters.destination = e.target.value; await load(); } },
    [h('option', { value: '' }, 'Все направления'), ...Object.entries(state.config.tariffs || {}).map(([k, t]) => h('option', { value: k }, t.label))]);

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head wrap' }, icon('box', 20), h('h3', {}, 'Заказы'),
      h('div', { class: 'row gap-2 wrap', style: { marginLeft: 'auto' } }, search, statusSel, destSel)),
    h('div', { class: 'row gap-2 wrap', style: { marginBottom: '12px' } },
      h('span', { class: 'chip', id: 'sel-count' }, 'выбрано: 0'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: bulkStatus }, icon('refresh', 15), 'Массовая смена статуса'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: printLabels }, icon('print', 15), 'Печать стикеров'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => endpoints.admin.labels([...selected]).then((l) => showLabels(l)) }, icon('box', 15), 'Предпросмотр маркировки'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: exportCsv }, icon('download', 15), 'Экспорт CSV/Excel')),
    listBox));

  async function load() {
    listBox.innerHTML = ''; listBox.appendChild(spinner());
    orders = await endpoints.admin.orders(filters);
    render();
  }

  function render() {
    listBox.innerHTML = '';
    if (!orders.length) { listBox.appendChild(emptyState('Заказов нет', 'Измените фильтры')); return; }
    listBox.appendChild(h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', {}, h('input', { type: 'checkbox', onchange: (e) => { selected.clear(); if (e.target.checked) orders.forEach((o) => selected.add(o.id)); render(); } })),
        h('th', {}, 'Заказ'), h('th', {}, 'Клиент'), h('th', {}, 'Статус'), h('th', {}, 'Направление'),
        isWarehouse() ? null : h('th', { class: 'num' }, 'Сумма'),
        h('th', { class: 'num' }, 'Вес'), h('th', {}, 'Трек'), h('th', {}, ''))),
      h('tbody', {}, orders.map((o) => h('tr', { class: selected.has(o.id) ? 'selected' : '' },
        h('td', {}, h('input', { type: 'checkbox', checked: selected.has(o.id), onchange: (e) => { e.target.checked ? selected.add(o.id) : selected.delete(o.id); render(); } })),
        h('td', {}, h('a', { class: 'mono small', href: `#/admin/orders/${o.id}` }, o.orderNo), h('div', { class: 'tiny dim' }, fmtDate(o.timeline?.createdAt))),
        h('td', {}, h('div', { class: 'small' }, o.user?.name || '—'), h('div', { class: 'tiny dim mono' }, o.user?.publicUid)),
        h('td', {}, h('span', { class: `chip ${['cancelled', 'legit_check_failed', 'refunded'].includes(o.status) ? 'chip-danger' : o.status === 'delivered' ? 'chip-ok' : 'chip-info'}` }, o.statusRu)),
        h('td', { class: 'small' }, o.destinationLabel),
        isWarehouse() ? null : h('td', { class: 'num mono' }, money(o.totalMinor, o.currency)),
        h('td', { class: 'num mono small' }, `${o.weight.estKg}${o.weight.factKg ? ` / ${o.weight.factKg}` : ''}`),
        h('td', { class: 'mono small' }, o.trackingNumber || h('button', { class: 'btn btn-ghost btn-sm', onclick: () => trackingModal(o) }, 'добавить')),
        h('td', {}, h('a', { class: 'btn btn-ghost btn-sm', href: `#/admin/orders/${o.id}` }, 'Открыть')))))));
    const c = listBox.closest('.card')?.querySelector('#sel-count');
    if (c) c.textContent = `выбрано: ${selected.size}`;
  }

  async function bulkStatus() {
    if (!selected.size) return toast('Ничего не выбрано', 'Отметьте заказы в таблице', 'err');
    const allowed = Object.keys(state.config.statuses || {});
    let status = 'purchasing';
    let comment = '';
    const m = modal({
      title: `Массовая смена статуса (${selected.size})`,
      body: h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Новый статус'),
          h('select', { class: 'select', onchange: (e) => { status = e.target.value; } }, allowed.map((s) => h('option', { value: s, selected: s === status }, `${(state.config.statuses || {})[s]} (${s})`)))),
        h('div', { class: 'field' }, h('label', {}, 'Комментарий (попадёт в историю)'),
          h('input', { class: 'input', oninput: (e) => { comment = e.target.value; } })),
        h('div', { class: 'notice notice-warn' }, icon('shield', 15), h('div', { class: 'tiny' }, 'Недопустимые переходы будут пропущены с ошибкой — система соблюдает статусную модель.'))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const res = await endpoints.admin.bulkStatus([...selected], status, comment);
            m.close();
            toast('Готово', `Обновлено: ${res.ok.length}, ошибок: ${res.failed.length}`, res.failed.length ? 'err' : 'ok');
            if (res.failed.length) console.table(res.failed);
            selected.clear();
            await load();
          },
        }, 'Применить'),
      ],
    });
  }

  async function printLabels() {
    if (!selected.size) return toast('Ничего не выбрано', 'Отметьте заказы', 'err');
    const labels = await endpoints.admin.labels([...selected]);
    showLabels(labels, true);
  }

  async function exportCsv() {
    try {
      await api.downloadCsv('/admin/orders/export.csv', `poizonvanart-orders-${new Date().toISOString().slice(0, 10)}.csv`);
      toast('Экспорт готов', 'CSV открылся в загрузках (совместим с Excel)', 'ok');
    } catch (e) { toast('Ошибка экспорта', e.message, 'err'); }
  }

  await load();
  return wrap;
}

function showLabels(labels, doPrint = false) {
  const body = h('div', { class: 'stack gap-3' },
    h('p', { class: 'small muted' }, 'Маркировочный стикер: User ID, номер заказа, направление, адрес, количество мест и вес. Штрихкод — внутренний формат PV.'),
    ...labels.map((l) => h('div', { class: 'sticker' },
      h('div', { class: 'row spread' }, h('b', {}, 'PoizonVanart'), h('span', {}, l.orderNo)),
      h('div', {}, `User ID: ${l.userPublicUid}`),
      h('div', {}, `${l.recipient || '—'} · ${l.phone || ''}`),
      h('div', {}, `${l.destination === 'BY_MSQ' ? 'Беларусь, Минск' : 'Россия, Москва'} · ${l.address || 'уточняется'}`),
      h('div', {}, `Мест: ${l.places} · Вес: ${l.weightKg ?? '—'} кг`),
      barcode(l.barcode),
      h('div', { class: 'mono', style: { letterSpacing: '.2em', fontSize: '11px' } }, l.barcode))));
  const m = modal({
    title: `Стикеры · ${labels.length}`, wide: true, body,
    footer: [
      h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Закрыть'),
      h('button', { class: 'btn btn-primary', onclick: () => window.print() }, icon('print', 16), 'Печать'),
    ],
  });
  if (doPrint) setTimeout(() => window.print(), 350);
}
function barcode(code) {
  const bars = [];
  for (let i = 0; i < 58; i++) {
    const c = code.charCodeAt(i % code.length) || 65;
    bars.push(h('i', { style: { width: `${(c % 3) + 1}px` } }));
  }
  return h('div', { class: 'barcode' }, bars);
}

function trackingModal(o) {
  let tracking = '', carrier = o.carrier || 'VanCargo';
  const m = modal({
    title: `Трек-номер · ${o.orderNo}`,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', {}, 'Трек-номер'), h('input', { class: 'input mono', oninput: (e) => { tracking = e.target.value; } })),
      h('div', { class: 'field' }, h('label', {}, 'Перевозчик'), h('input', { class: 'input', value: carrier, oninput: (e) => { carrier = e.target.value; } }))),
    footer: [
      h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
      h('button', {
        class: 'btn btn-primary', onclick: async () => {
          try {
            await endpoints.admin.tracking(o.id, { trackingNumber: tracking, carrier });
            m.close(); toast('Трек-номер сохранён', 'Клиент получил уведомление', 'ok');
            navigate('#/admin/orders');
          } catch (e) { toast('Ошибка', e.message, 'err'); }
        },
      }, 'Сохранить'),
    ],
  });
}

// ── СКЛАД (Warehouse Mode) ─────────────────────────────────────────────────
async function tWarehouse() {
  const wrap = h('div', { class: 'stack gap-4' });
  const queue = await endpoints.admin.warehouseQueue();

  wrap.appendChild(h('div', { class: 'notice notice-info' }, icon('lock', 16),
    h('div', { class: 'small' }, h('b', {}, 'Warehouse Mode: '),
      'сотрудники склада видят только состав заказа, вес, габариты и фото. Цены клиента, курсы, комиссии и прибыль скрыты на уровне API (не только в UI).')));

  if (!queue.length) wrap.appendChild(emptyState('Очередь пуста', 'Все заказы обработаны'));

  queue.forEach((o) => {
    const card = h('div', { class: 'card' },
      h('div', { class: 'row spread gap-3 wrap' },
        h('div', { class: 'row gap-3' },
          h('b', { class: 'mono' }, o.orderNo),
          h('span', { class: 'chip chip-info' }, o.statusRu),
          h('span', { class: 'chip' }, o.destination === 'BY_MSQ' ? '🇧🇾 Минск' : '🇷🇺 Москва'),
          h('span', { class: 'chip' }, `User ID: ${o.userPublicUid}`),
          h('span', { class: 'chip' }, `вес расч.: ${o.weightEstKg} кг`)),
        h('div', { class: 'tiny dim' }, `оплачен ${fmtDate(o.paidAt)} · фото: ${o.photosCount}`)),
      h('div', { class: 'divider' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Товар'), h('th', {}, 'Цвет / размер'), h('th', { class: 'num' }, 'Кол-во'), h('th', {}, 'Legit Check'))),
        h('tbody', {}, o.items.map((it) => h('tr', {},
          h('td', {}, h('div', { class: 'row gap-2' }, h('img', { src: it.imageUrl || '/img/p/item.svg', style: { width: '36px', height: '34px', objectFit: 'cover', borderRadius: '6px' } }), h('span', { class: 'small' }, it.title))),
          h('td', { class: 'small muted' }, [it.color, it.size].filter(Boolean).join(' / ')),
          h('td', { class: 'num' }, String(it.qty)),
          h('td', {}, it.legitCheck ? h('span', { class: `chip ${it.legitCheck === 'pass' ? 'chip-ok' : 'chip-danger'}` }, it.legitCheck === 'pass' ? 'пройден' : 'НЕ пройден') : h('button', { class: 'btn btn-ghost btn-sm', onclick: () => legitModal(o, it) }, 'Проверить'))))))),
      h('div', { class: 'row gap-3 wrap', style: { marginTop: '12px' } }, factsForm(o), actionsRow(o)));
    wrap.appendChild(card);
  });

  function factsForm(o) {
    const w = h('input', { class: 'input', style: { width: '110px' }, type: 'number', step: '0.01', value: o.weightFactKg ?? '', placeholder: String(o.weightEstKg) });
    const v = h('input', { class: 'input', style: { width: '110px' }, type: 'number', step: '0.001', placeholder: '0.012' });
    const places = h('input', { class: 'input', style: { width: '80px' }, type: 'number', min: 1, value: o.places ?? 1 });
    return h('div', { class: 'row gap-2 wrap' },
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Вес факт, кг'), w),
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Объём, м³'), v),
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Мест'), places),
      h('button', {
        class: 'btn btn-ghost', style: { alignSelf: 'flex-end' }, onclick: async () => {
          try {
            await endpoints.admin.warehouseUpdate(o.id, { weightFactKg: w.value ? Number(w.value) : undefined, volumeM3: v.value ? Number(v.value) : undefined, places: Number(places.value) });
            toast('Сохранено', 'При расхождении веса > 5% создан перерасчёт', 'ok');
            navigate('#/admin/warehouse');
          } catch (e) { toast('Ошибка', e.message, 'err'); }
        },
      }, icon('check', 16), 'Сохранить факты'));
  }

  function actionsRow(o) {
    return h('div', { class: 'row gap-2 wrap', style: { marginLeft: 'auto' } },
      h('button', { class: 'btn btn-soft btn-sm', onclick: () => photosModal(o) }, icon('camera', 15), 'Фотоотчёт'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => nextStatus(o) }, icon('arrow', 15), 'Следующий статус'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { const l = await endpoints.admin.labels([o.id]); showLabels(l, true); } }, icon('print', 15), 'Стикер'));
  }

  function nextStatus(o) {
    const next = { paid: 'purchasing', purchasing: 'purchased', purchased: 'photo_report', photo_report: 'packed', packed: 'sent_to_ru' }[o.status];
    if (!next) return toast('Статус конечный', 'Дальнейшие шаги выполняет логистика', 'info');
    endpoints.admin.bulkStatus([o.id], next, 'Склад Китай')
      .then((r) => { toast('Статус обновлён', `${o.orderNo} → ${(state.config.statuses || {})[next]}`, r.failed.length ? 'err' : 'ok'); navigate('#/admin/warehouse'); });
  }

  function photosModal(o) {
    const captions = h('textarea', { class: 'textarea', placeholder: 'Каждая строка — подпись к отдельному фото\nКоробка Poizon, пломба цела\nСертификат Legit Check + QR\nБирки и швы\nВзвешивание: 1.42 кг' });
    let kind = 'report';
    const m = modal({
      title: `Фотоотчёт · ${o.orderNo}`,
      body: h('div', {},
        h('p', { class: 'small muted' }, 'Демо: фото генерируются как заглушки. В продакшене — загрузка в S3/R2 с пресайнед-URL и автоматическим ресайзом (thumbnail).'),
        h('div', { class: 'field' }, h('label', {}, 'Тип фото'),
          h('select', { class: 'select', onchange: (e) => { kind = e.target.value; } },
            [['report', 'Фотоотчёт'], ['unboxing', 'Распаковка'], ['weight', 'Взвешивание'], ['label', 'Маркировка'], ['defect', 'Дефект (клиенту не показывать)']].map(([v, t]) => h('option', { value: v }, t)))),
        h('div', { class: 'field' }, h('label', {}, 'Подписи к фото (по строке на фото)'), captions)),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            const lines = captions.value.split('\n').map((x) => x.trim()).filter(Boolean);
            if (!lines.length) return toast('Добавьте подписи', 'Минимум одно фото', 'err');
            await endpoints.admin.warehousePhotos(o.id, { captions: lines, kind });
            m.close();
            toast('Фотоотчёт загружен', `${lines.length} фото · клиент уведомлён`, 'ok');
            navigate('#/admin/warehouse');
          },
        }, 'Загрузить фото'),
      ],
    });
  }

  function legitModal(o, it) {
    const m = modal({
      title: `Legit Check · ${it.title}`,
      body: h('div', {},
        h('ul', { class: 'checklist' },
          h('li', {}, 'Пломба и сертификат Poizon на месте'),
          h('li', {}, 'QR-код сертификата считывается и ведёт на карточку'),
          h('li', {}, 'Швы, фурнитура, логотипы соответствуют оригиналу'),
          h('li', {}, 'Упаковка и бирки без следов замены')),
        h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Комментарий'), h('textarea', { class: 'textarea', id: 'lc-comment', placeholder: 'Что заметили…' })),
        h('div', { class: 'notice notice-warn' }, icon('shield', 15), h('div', { class: 'tiny' }, 'При отметке «НЕ пройден» система автоматически вернёт клиенту 100% на баланс и закроет заказ.'))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-danger', onclick: async () => {
            await endpoints.admin.legitCheck(o.id, { pass: false, itemId: it.id, comment: document.getElementById('lc-comment').value });
            m.close(); toast('Legit Check не пройден', '100% возврат на баланс клиента выполнен', 'ok');
            navigate('#/admin/warehouse');
          },
        }, 'НЕ пройден'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            await endpoints.admin.legitCheck(o.id, { pass: true, itemId: it.id });
            m.close(); toast('Legit Check пройден', '', 'ok');
            navigate('#/admin/warehouse');
          },
        }, 'Пройден'),
      ],
    });
  }

  return wrap;
}

// ── TIKTOK-МОДЕРАЦИЯ ───────────────────────────────────────────────────────
async function tTiktok() {
  const wrap = h('div', { class: 'stack gap-4' });
  let status = 'pending';
  const listBox = h('div');

  const tabs = h('div', { class: 'pill-tabs' }, ['pending', 'approved', 'rejected', ''].map((s) =>
    h('button', {
      'aria-pressed': String(status === s), onclick: async (e) => {
        status = s; [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true');
        await load();
      },
    }, { pending: 'На проверке', approved: 'Одобренные', rejected: 'Отклонённые', '': 'Все' }[s])));

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('tiktok', 20), h('h3', {}, 'Модерация TikTok-заявок'),
      h('span', { class: 'chip', style: { marginLeft: 'auto' } }, `ставка ${money(state.config.tiktok.reward_per_1000_views_rub_minor, 'RUB')} / 1000 просмотров`)),
    tabs, h('div', { style: { marginTop: '14px' } }, listBox)));

  async function load() {
    listBox.innerHTML = ''; listBox.appendChild(spinner());
    const rows = await endpoints.admin.tiktok(status || undefined);
    listBox.innerHTML = '';
    if (!rows.length) { listBox.appendChild(emptyState('Заявок нет', status === 'pending' ? 'Очередь модерации пуста' : 'Нет заявок с этим статусом')); return; }
    rows.forEach((r) => listBox.appendChild(row(r)));
  }

  function row(r) {
    const viewsInput = h('input', { class: 'input mono', type: 'number', min: 0, style: { width: '130px' }, value: r.viewsVerified ?? r.viewsDeclared ?? '' });
    const est = Math.floor((r.viewsDeclared || 0) / 1000) * (state.config.tiktok.reward_per_1000_views_rub_minor || 1500);
    return h('div', { class: 'card', style: { marginBottom: '12px', background: 'var(--card-2)' } },
      h('div', { class: 'row spread gap-3 wrap' },
        h('div', { class: 'row gap-3' },
          h('span', { class: 'avatar' }, (r.user?.name || '?')[0]),
          h('div', {},
            h('b', { class: 'small' }, r.user?.name || '—'),
            h('div', { class: 'tiny dim mono' }, `${r.user?.publicUid} · ${r.authorHandle || 'без ника'}`)),
          h('a', { class: 'small', href: r.url, target: '_blank', rel: 'noopener', style: { color: 'var(--brand)' } }, 'открыть видео ↗')),
        h('div', { class: 'row gap-2' },
          h('span', { class: `chip ${r.status === 'approved' ? 'chip-ok' : r.status === 'pending' ? 'chip-warn' : 'chip-danger'}` }, tiktokStatus(r.status)),
          h('span', { class: 'tiny dim' }, timeAgo(r.createdAt)))),
      h('div', { class: 'row gap-2 wrap', style: { margin: '10px 0' } },
        h('span', { class: `chip ${r.hashtagFound ? 'chip-ok' : 'chip-danger'}` }, r.hashtagFound ? 'хэштег найден' : 'хэштега нет'),
        h('span', { class: `chip ${r.linkFound ? 'chip-ok' : 'chip-warn'}` }, r.linkFound ? 'ссылка на сайт есть' : 'ссылки нет'),
        h('span', { class: 'chip' }, `заявлено: ${(r.viewsDeclared || 0).toLocaleString('ru-RU')} просмотров`),
        h('span', { class: 'chip chip-info' }, `расчётно: ${money(est, 'RUB')}`)),
      h('div', { class: 'row gap-2 wrap', style: { alignItems: 'flex-end' } },
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Фактические просмотры'), viewsInput),
        r.status === 'pending' ? h('div', { class: 'btn-group' },
          h('button', {
            class: 'btn btn-primary btn-sm', onclick: async (e) => {
              e.target.disabled = true;
              try {
                const res = await endpoints.admin.tiktokReview(r.id, { decision: 'approve', viewsVerified: Number(viewsInput.value) });
                toast('Одобрено', `Начислено ${money(res.rewardRubMinor, 'RUB')} за ${res.viewsVerified?.toLocaleString('ru-RU')} просмотров`, 'ok');
                await load();
              } catch (err) { toast('Ошибка', err.message, 'err'); e.target.disabled = false; }
            },
          }, icon('check', 15), 'Одобрить и начислить'),
          h('button', { class: 'btn btn-danger btn-sm', onclick: () => rejectModal(r) }, icon('x', 15), 'Отклонить'))
          : h('div', { class: 'tiny dim' }, r.reviewedAt ? `проверено ${fmtDateTime(r.reviewedAt)} · начислено ${money(r.rewardMinor, r.rewardCurrency)}` : '')));
  }

  function rejectModal(r) {
    let reason = '';
    const m = modal({
      title: 'Отклонить заявку',
      body: h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Причина (увидит пользователь)'),
          h('select', { class: 'select', onchange: (e) => { reason = e.target.value; } },
            ['Нет фирменного хэштега', 'Нет ссылки на сайт', 'Видео не про выкупленный товар', 'Накрутка просмотров', 'Видео уже участвовало в конкурсе', 'Другое'].map((x) => h('option', { value: x }, x))))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-danger', onclick: async () => {
            await endpoints.admin.tiktokReview(r.id, { decision: 'reject', reason });
            m.close(); toast('Отклонено', 'Пользователь получил уведомление', 'ok'); await load();
          },
        }, 'Отклонить'),
      ],
    });
  }

  await load();
  return wrap;
}
const tiktokStatus = (s) => ({ pending: 'на проверке', approved: 'одобрено', rejected: 'отклонено', duplicate: 'дубликат', blacklisted: 'заблокировано' }[s] || s);

// ── РЕФЕРАЛЫ (АДМИН) ───────────────────────────────────────────────────────
async function tReferrals() {
  const rows = await endpoints.admin.referrals();
  const data = Array.isArray(rows) ? rows : [];
  const stats = rows?.__payload?.stats || { invited: data.length, activated: 0, conversion: 0, rewardedSum: 0, invitedOrders: 0, pending: 0 };
  const wrap = h('div', { class: 'stack gap-4' });
  const cur = state.currency;
  const rates = state.config.ratesEffective;
  wrap.appendChild(h('div', { class: 'grid grid-4' },
    kpi('Приглашено', String(stats.invited), 'всего привязок', 'users'),
    kpi('Активировано', String(stats.activated), `конверсия ${Math.round((stats.conversion || 0) * 100)}%`, 'check'),
    kpi('Начислено', money(convertMinor(stats.rewardedSum, 'RUB', cur, rates), cur), 'бонусами', 'gift'),
    kpi('Заказов у приглашённых', String(stats.invitedOrders), `ожидают первого: ${stats.pending}`, 'box')));
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('users', 20), h('h3', {}, 'Реферальные связи')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Реферер'), h('th', {}, 'Приглашённый'), h('th', {}, 'Статус'), h('th', {}, 'Первый заказ'), h('th', { class: 'num' }, 'Награда'), h('th', { class: 'num' }, 'Заказов'), h('th', {}, 'Дата'))),
      h('tbody', {}, data.map((r) => h('tr', {},
        h('td', {}, h('div', { class: 'small' }, r.referrer?.name), h('div', { class: 'tiny dim mono' }, r.referrer?.publicUid)),
        h('td', {}, h('div', { class: 'small' }, r.referee?.name), h('div', { class: 'tiny dim mono' }, `${r.referee?.publicUid} · ${r.referee?.phone || ''}`)),
        h('td', {}, h('span', { class: `chip ${r.status === 'rewarded' ? 'chip-ok' : r.status === 'fraud' || r.status === 'clawback' ? 'chip-danger' : 'chip-warn'}` }, r.status)),
        h('td', { class: 'mono small' }, r.firstOrder?.orderNo ? `${r.firstOrder.orderNo} · ${money(convertMinor(r.firstOrder.totalMinor, r.firstOrder.currency, cur, rates), cur)}` : '—'),
        h('td', { class: 'num mono', style: { color: 'var(--ok)' } }, r.rewardMinor ? money(convertMinor(r.rewardMinor, 'RUB', cur, rates), cur) : '—'),
        h('td', { class: 'num' }, `${r.refereePaidOrders}/${r.refereeOrders}`),
        h('td', { class: 'tiny dim nowrap' }, fmtDate(r.createdAt)))))))));
  return wrap;
}

// ── КУРСЫ И ТАРИФЫ ─────────────────────────────────────────────────────────
async function tRates() {
  const settingsRows = await endpoints.admin.settings();
  const settingsList = Array.isArray(settingsRows) ? settingsRows : [];
  const settings = { data: settingsList, rateHistory: settingsRows?.__payload?.rateHistory || [] };
  const byKey = Object.fromEntries(settingsList.map((s) => [s.key, s]));
  const wrap = h('div', { class: 'stack gap-4' });

  const rates = byKey['rates.currency_rates']?.value || {};
  const tariffs = byKey['logistics.tariffs']?.value || {};
  const packaging = byKey['logistics.packaging']?.value || {};
  const loyalty = byKey['loyalty.tiers']?.value || [];
  const insurance = byKey['insurance.tiers']?.value || [];
  const referral = byKey['referral.config']?.value || {};
  const tiktok = byKey['tiktok.config']?.value || {};
  let commission = byKey['commission.base_rate']?.value ?? 0.1;

  const valueOf = (key) => byKey[key]?.value;
  const reload = async () => { state.config = await endpoints.config(); };
  const save = async (key, value, title, note = '') => {
    await endpoints.admin.updateSetting(key, value);
    await reload();
    toast(title, note, 'ok');
  };
  const CURRENCY_HINT = { CNY: 'юань — закупка товара', USD: 'доллар — карго, упаковка, страховка', BYN: 'бел. рубль — приём платежей' };

  // ── курсы валют ──────────────────────────────────────────────────────────
  const ratesRows = ['CNY', 'USD', 'BYN'].map((code) => {
    const r = rates[code] || {};
    const base = h('input', { class: 'input mono', type: 'number', step: '0.0001', value: r.base, style: { width: '120px' } });
    const markup = h('input', { class: 'input mono', type: 'number', step: '0.1', value: r.markup, style: { width: '100px' } });
    const eff = h('b', { class: 'mono' }, (Number(r.base) * (1 + Number(r.markup) / 100)).toFixed(4));
    const recalc = () => { eff.textContent = (Number(base.value) * (1 + Number(markup.value) / 100)).toFixed(4); };
    base.addEventListener('input', recalc);
    markup.addEventListener('input', recalc);
    const saveBtn = h('button', {
      class: 'btn btn-soft btn-sm',
      onclick: async () => {
        const next = { ...rates, [code]: { ...r, base: Number(base.value), markup: Number(markup.value) } };
        await save('rates.currency_rates', next, 'Курс обновлён', `${code}: ${base.value} + ${markup.value}% → все цены пересчитаны`);
        navigate('#/admin/rates');
      },
    }, 'Сохранить');
    return h('tr', {},
      h('td', {}, h('b', {}, code), h('div', { class: 'tiny dim' }, CURRENCY_HINT[code] || '')),
      h('td', { class: 'num' }, base),
      h('td', { class: 'num' }, markup),
      h('td', { class: 'num' }, eff),
      h('td', {}, saveBtn));
  });

  const ratesTable = h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Валюта'), h('th', { class: 'num' }, 'Курс ЦБ (к RUB)'),
      h('th', { class: 'num' }, 'Наценка, %'), h('th', { class: 'num' }, 'Эффективный'), h('th', {}, ''))),
    h('tbody', {}, ratesRows)));

  const ratesCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('gear', 20), h('h3', {}, 'Курсы валют'),
      h('span', { class: 'chip', style: { marginLeft: 'auto' } }, `источник: ${valueOf('rates.auto_source') || 'manual'}`)),
    h('p', { class: 'small muted' }, 'Эффективный курс = базовый курс ЦБ × (1 + наценка %). Все цены на сайте пересчитываются мгновенно.'),
    ratesTable,
    h('div', { class: 'row gap-2 wrap', style: { marginTop: '12px' } },
      h('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: async () => { await save('rates.auto_source', 'cbr', 'Режим', 'Автозагрузка курса ЦБ (в проде — воркер по cron)'); navigate('#/admin/rates'); },
      }, 'Включить авто-курс ЦБ'),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: async () => { await save('rates.auto_source', 'manual', 'Режим', 'Курсы задаются вручную'); navigate('#/admin/rates'); },
      }, 'Ручной режим')));

  // ── логистика: тарифы, упаковка, страховка ───────────────────────────────
  const tariffBlocks = Object.entries(tariffs).map(([code, t]) => h('div', { class: 'card', style: { background: 'var(--card-2)', marginBottom: '10px', padding: '12px' } },
    h('b', { class: 'small' }, t.label),
    h('div', { class: 'row gap-2 wrap', style: { marginTop: '8px' } },
      numField('$ / кг', t.usd_per_kg, 0.1, (v) => { t.usd_per_kg = v; }),
      numField('дней от', t.days_min, 1, (v) => { t.days_min = v; }),
      numField('дней до', t.days_max, 1, (v) => { t.days_max = v; })),
    h('div', { class: 'tiny dim', style: { marginTop: '6px' } }, `код направления: ${code}`)));

  const packagingBlock = h('div', { class: 'card', style: { background: 'var(--card-2)', padding: '12px', marginBottom: '10px' } },
    h('b', { class: 'small' }, 'Упаковка (USD за место)'),
    h('div', { class: 'row gap-2 wrap', style: { marginTop: '8px' } },
      Object.entries(packaging).map(([k, v]) => numField(k, v, 0.5, (nv) => { packaging[k] = nv; }))));

  const insuranceBlock = h('div', { class: 'card', style: { background: 'var(--card-2)', padding: '12px', marginBottom: '12px' } },
    h('b', { class: 'small' }, 'Страховка (тиры)'),
    h('div', { class: 'stack gap-2', style: { marginTop: '8px' } },
      insurance.map((t, i) => h('div', { class: 'row gap-2' },
        h('span', { class: 'tiny dim', style: { width: '90px' } }, t.max_usd ? `до $${t.max_usd}` : 'свыше'),
        numField('ставка %', (t.rate * 100).toFixed(1), 0.1, (v) => { insurance[i].rate = v / 100; })))));

  const logisticsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('truck', 20), h('h3', {}, 'Тарифы логистики')),
    ...tariffBlocks,
    packagingBlock,
    insuranceBlock,
    h('button', {
      class: 'btn btn-primary btn-block',
      onclick: async () => {
        await endpoints.admin.updateSetting('logistics.tariffs', tariffs);
        await endpoints.admin.updateSetting('logistics.packaging', packaging);
        await endpoints.admin.updateSetting('insurance.tiers', insurance);
        await reload();
        toast('Тарифы сохранены', 'Пересчёт применяется к новым заказам; старые сохраняют снапшот', 'ok');
      },
    }, 'Сохранить тарифы'));

  // ── комиссия и уровни лояльности ─────────────────────────────────────────
  const loyaltyRows = loyalty.map((t, i) => h('tr', {},
    h('td', {}, h('b', {}, t.name), h('div', { class: 'tiny dim' }, t.code)),
    h('td', { class: 'num' }, h('input', {
      class: 'input mono', type: 'number', style: { width: '120px' },
      value: (t.threshold_rub_minor / 100).toFixed(0),
      oninput: (e) => { loyalty[i].threshold_rub_minor = Math.round(Number(e.target.value) * 100); },
    })),
    h('td', { class: 'num' }, h('input', {
      class: 'input mono', type: 'number', step: '0.5', style: { width: '90px' },
      value: (t.commission * 100).toFixed(1),
      oninput: (e) => { loyalty[i].commission = Number(e.target.value) / 100; },
    }))));

  const loyaltyCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('star', 20), h('h3', {}, 'Комиссия и лояльность')),
    h('div', { class: 'row gap-2 wrap', style: { marginBottom: '10px' } },
      numField('Базовая комиссия, %', (commission * 100).toFixed(1), 0.5, (v) => { commission = v / 100; })),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Уровень'), h('th', { class: 'num' }, 'Порог, ₽'), h('th', { class: 'num' }, 'Комиссия'))),
      h('tbody', {}, loyaltyRows))),
    h('button', {
      class: 'btn btn-primary btn-block', style: { marginTop: '12px' },
      onclick: async () => {
        await endpoints.admin.updateSetting('loyalty.tiers', loyalty);
        await endpoints.admin.updateSetting('commission.base_rate', commission);
        await reload();
        toast('Комиссия и уровни сохранены', 'Новые расчёты используют обновлённые ставки', 'ok');
      },
    }, 'Сохранить уровни'));

  // ── реферальная программа ────────────────────────────────────────────────
  const referralCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('gift', 20), h('h3', {}, 'Реферальная программа')),
    h('div', { class: 'row gap-2 wrap' },
      numField('% от первого заказа', referral.percent, 0.5, (v) => { referral.percent = v; }),
      numField('Потолок, ₽', (referral.cap_rub_minor / 100).toFixed(0), 50, (v) => { referral.cap_rub_minor = Math.round(v * 100); }),
      numField('Бонус приглашённому, ₽', (referral.invitee_bonus_rub_minor / 100).toFixed(0), 10, (v) => { referral.invitee_bonus_rub_minor = Math.round(v * 100); })),
    h('label', { class: 'checkbox', style: { margin: '10px 0' } },
      h('input', { type: 'checkbox', checked: !!referral.clawback_on_refund, onchange: (e) => { referral.clawback_on_refund = e.target.checked; } }),
      h('span', { class: 'small' }, 'Отзывать награду при полном возврате первого заказа (clawback)')),
    h('p', { class: 'hint' }, 'Награда начисляется только после полной оплаты первого заказа приглашённым.'),
    h('button', { class: 'btn btn-primary btn-block', onclick: () => save('referral.config', referral, 'Сохранено') }, 'Сохранить'));

  // ── TikTok-конкурс ───────────────────────────────────────────────────────
  const tiktokCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('tiktok', 20), h('h3', {}, 'TikTok-конкурс')),
    h('div', { class: 'row gap-2 wrap' },
      numField('₽ за 1000 просмотров', (tiktok.reward_per_1000_views_rub_minor / 100).toFixed(2), 1, (v) => { tiktok.reward_per_1000_views_rub_minor = Math.round(v * 100); }),
      numField('Мин. просмотров', tiktok.min_views, 100, (v) => { tiktok.min_views = v; }),
      numField('Лимит заявок/день', tiktok.max_submissions_per_day, 1, (v) => { tiktok.max_submissions_per_day = v; })),
    h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', {}, 'Хэштег'),
      h('input', { class: 'input', value: tiktok.hashtag, oninput: (e) => { tiktok.hashtag = e.target.value; } })),
    h('button', { class: 'btn btn-primary btn-block', onclick: () => save('tiktok.config', tiktok, 'Сохранено') }, 'Сохранить'));

  // ── история изменения курсов ─────────────────────────────────────────────
  const historyRows = (settings.rateHistory || []).slice(0, 15).map((r) => h('tr', {},
    h('td', { class: 'tiny dim nowrap' }, fmtDateTime(r.valid_from)),
    h('td', {}, r.currency),
    h('td', { class: 'small' }, r.source)));

  const historyCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('refresh', 20), h('h3', {}, 'История изменений курсов')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Когда'), h('th', {}, 'Валюта/ключ'), h('th', {}, 'Источник'))),
      h('tbody', {}, historyRows))));

  wrap.appendChild(ratesCard);
  wrap.appendChild(h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
    logisticsCard,
    h('div', { class: 'stack gap-4' }, loyaltyCard, referralCard, tiktokCard)));
  wrap.appendChild(historyCard);

  return wrap;
}

function numField(label, value, step, onchange) {
  return h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, label),
    h('input', { class: 'input mono', type: 'number', step, value, style: { width: '150px' }, oninput: (e) => onchange(Number(e.target.value)) }));
}

// ── P&L ────────────────────────────────────────────────────────────────────
async function tPnl() {
  const wrap = h('div', { class: 'stack gap-4' });
  let reportCur = state.currency === 'CNY' ? 'RUB' : state.currency;
  const body = h('div', { class: 'stack gap-4' });

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head wrap' }, icon('chart', 20), h('h3', {}, 'Отчёт P&L'),
      h('div', { class: 'segmented', style: { marginLeft: 'auto' } }, ['RUB', 'BYN', 'USD'].map((c) =>
        h('button', { 'aria-pressed': String(reportCur === c), onclick: (e) => { reportCur = c; [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); load(); } }, c))),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { try { await api.downloadCsv('/admin/pnl/export.csv', `poizonvanart-pnl-${reportCur}-${new Date().toISOString().slice(0, 10)}.csv`, { currency: reportCur }); toast('Экспорт', `CSV выгружен в ${reportCur}`, 'ok'); } catch (e) { toast('Ошибка', e.message, 'err'); } } }, icon('download', 15), 'CSV')),
    h('div', { class: 'notice notice-info' }, icon('eye', 16),
      h('div', { class: 'small' }, 'Приход учитывается в RUB/BYN по факту платежей, закупка — в CNY, карго и упаковка — в USD. Всё приводится к валюте отчёта по курсу на дату операции.')),
    body));

  async function load() {
    body.innerHTML = '';
    body.appendChild(spinner('Считаем P&L…'));
    const d = await endpoints.admin.pnl({ currency: reportCur });
    const t = d.totals;
    body.innerHTML = '';
    body.appendChild(kpiRow(t));
    body.appendChild(structureRow(t, d));
    body.appendChild(dayCard(d));
    body.appendChild(perOrderCard(d));
  }

  function kpiRow(t) {
    const grid = h('div', { class: 'grid grid-4' });
    grid.appendChild(kpi('Приход', money(t.revenue, reportCur), `${t.orders} оплаченных заказов`, 'wallet', true));
    grid.appendChild(kpi('Закупка CNY', money(-t.cogs, reportCur), 'оплата товара на Poizon', 'box'));
    grid.appendChild(kpi('Карго + прочее', money(-(t.cargo + t.extra), reportCur), `эквайринг ${money(-t.acquiring, reportCur)}`, 'truck'));
    grid.appendChild(kpi('Чистая прибыль', money(t.net, reportCur), `маржа ${(t.marginPct * 100).toFixed(1)}% · net ${(t.netPct * 100).toFixed(1)}%`, 'star', true));
    return grid;
  }

  function totalRow(label, value, colored = false) {
    const valueStyle = colored ? { color: value >= 0 ? 'var(--ok)' : 'var(--danger)' } : undefined;
    return h('div', { class: 'brow total' },
      h('span', { class: 'b-label' }, label),
      h('span', { class: 'b-value', style: valueStyle }, money(value, reportCur)));
  }

  function structureCard(t) {
    const breakdown = h('div', { class: 'breakdown' });
    breakdown.appendChild(prow('Приход от клиентов', t.revenue, reportCur));
    breakdown.appendChild(prow('− Закупка товара (CNY)', -t.cogs, reportCur));
    breakdown.appendChild(prow('− Карго (USD)', -t.cargo, reportCur));
    breakdown.appendChild(prow('− Упаковка / страховка / разгрузка', -t.extra, reportCur));
    breakdown.appendChild(prow('− Эквайринг', -t.acquiring, reportCur));
    breakdown.appendChild(h('div', { class: 'brow total' },
      h('span', { class: 'b-label' }, 'Валовая маржа'),
      h('span', { class: 'b-value' }, `${money(t.gross, reportCur)} · ${(t.marginPct * 100).toFixed(1)}%`)));
    breakdown.appendChild(prow('− OPEX (ФОТ, маркетинг, аренда)', -t.opex, reportCur));
    breakdown.appendChild(totalRow('Чистая прибыль', t.net, true));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h4', {}, 'Структура P&L')),
      breakdown);
  }

  function destinationCard(d) {
    const rows = d.byDestination.map((x) => {
      const grossStyle = { color: x.gross >= 0 ? 'var(--ok)' : 'var(--danger)' };
      return h('tr', {},
        h('td', {}, x.label),
        h('td', { class: 'num' }, String(x.orders)),
        h('td', { class: 'num mono' }, money(x.revenue, reportCur)),
        h('td', { class: 'num mono', style: grossStyle }, money(x.gross, reportCur)));
    });
    const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Направление'), h('th', { class: 'num' }, 'Заказов'),
        h('th', { class: 'num' }, 'Приход'), h('th', { class: 'num' }, 'Маржа'))),
      h('tbody', {}, rows)));
    const rateChips = Object.entries(d.rates).map(([c, r]) =>
      h('span', { class: 'chip mono' }, `${c}: ${Number(r).toFixed(4)} ₽`));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h4', {}, 'По направлениям')),
      table,
      h('div', { class: 'divider' }),
      h('h4', {}, 'Курсы на дату отчёта'),
      h('div', { class: 'row gap-2 wrap', style: { marginTop: '8px' } }, rateChips));
  }

  function structureRow(t, d) {
    return h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
      structureCard(t), destinationCard(d));
  }

  function dayCard(d) {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h4', {}, 'Динамика по дням')),
      dayChart(d.byDay, reportCur));
  }

  function perOrderCard(d) {
    const rows = d.orders.map((o) => {
      const grossStyle = { color: o.gross >= 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 700 };
      return h('tr', {},
        h('td', { class: 'mono small' }, o.orderNo),
        h('td', { class: 'small' }, o.destination === 'BY_MSQ' ? '🇧🇾 Минск' : '🇷🇺 Москва'),
        h('td', { class: 'num mono' }, money(o.revenue, reportCur)),
        h('td', { class: 'num mono dim' }, money(-o.cogs, reportCur)),
        h('td', { class: 'num mono dim' }, money(-o.cargo, reportCur)),
        h('td', { class: 'num mono dim' }, money(-o.extra, reportCur)),
        h('td', { class: 'num mono dim' }, money(-o.acquiring, reportCur)),
        h('td', { class: 'num mono', style: grossStyle }, `${money(o.gross, reportCur)} (${(o.marginPct * 100).toFixed(0)}%)`));
    });
    const head = h('tr', {},
      h('th', {}, 'Заказ'), h('th', {}, 'Направление'), h('th', { class: 'num' }, 'Приход'),
      h('th', { class: 'num' }, 'Закупка'), h('th', { class: 'num' }, 'Карго'),
      h('th', { class: 'num' }, 'Прочее'), h('th', { class: 'num' }, 'Эквайринг'),
      h('th', { class: 'num' }, 'Маржа'));
    const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, head), h('tbody', {}, rows)));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h4', {}, 'P&L по заказам')),
      table);
  }

  await load();
  return wrap;
}
const prow = (label, value, cur) => h('div', { class: 'brow' }, h('span', { class: 'b-label' }, label),
  h('span', { class: 'b-value', style: { color: value < 0 ? 'var(--text-2)' : undefined } }, money(value, cur)));

function dayChart(days, cur) {
  if (!days?.length) return h('p', { class: 'muted small' }, 'Нет данных');
  const max = Math.max(...days.map((d) => Math.abs(d.revenue) || 1), 1);
  return h('div', { class: 'stack gap-2' }, days.map((d) =>
    h('div', { class: 'row gap-3' },
      h('span', { class: 'tiny dim mono', style: { width: '86px' } }, d.day),
      h('div', { class: 'bar grow' }, h('span', { style: { width: `${Math.max(2, Math.round((d.revenue / max) * 100))}%` } })),
      h('span', { class: 'tiny mono nowrap', style: { width: '150px', textAlign: 'right' } }, money(d.revenue, cur)),
      h('span', { class: 'tiny mono nowrap', style: { width: '130px', textAlign: 'right', color: d.gross >= 0 ? 'var(--ok)' : 'var(--danger)' } }, money(d.gross, cur)))));
}

// ── ПОЛЬЗОВАТЕЛИ / BLACKLIST ───────────────────────────────────────────────
async function tUsers() {
  const wrap = h('div', { class: 'stack gap-4' });
  const listBox = h('div', { class: 'table-wrap' });
  const blBox = h('div');
  const search = h('input', { class: 'input', placeholder: 'Поиск: User ID, телефон, e-mail, промокод…', style: { maxWidth: '340px' }, oninput: debounce((e) => load(e.target.value), 350) });

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head wrap' }, icon('users', 20), h('h3', {}, 'Пользователи и роли'), search),
    listBox));
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('lock', 20), h('h3', {}, 'Чёрный список'),
      h('button', { class: 'btn btn-soft btn-sm', style: { marginLeft: 'auto' }, onclick: addBlacklist }, icon('plus', 15), 'Добавить')),
    blBox));

  async function load(q) {
    listBox.innerHTML = ''; listBox.appendChild(spinner());
    const rows = await endpoints.admin.users(q);
    const data = Array.isArray(rows) ? rows : [];
    const roles = rows?.__payload?.roles || [];
    listBox.innerHTML = '';
    listBox.appendChild(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'User ID'), h('th', {}, 'Имя'), h('th', {}, 'Контакты'), h('th', {}, 'Роль'), h('th', {}, 'Уровень'), h('th', { class: 'num' }, 'LTV'), h('th', { class: 'num' }, 'Баланс'), h('th', { class: 'num' }, 'Заказов'), h('th', {}, ''))),
      h('tbody', {}, data.map((u) => h('tr', {},
        h('td', { class: 'mono small' }, u.publicUid),
        h('td', {}, h('div', { class: 'small' }, u.name || '—'), u.referredBy ? h('div', { class: 'tiny dim' }, `от ${u.referredBy}`) : null),
        h('td', { class: 'tiny' }, h('div', { class: 'mono' }, u.phone || '—'), h('div', { class: 'dim' }, u.email || '')),
        h('td', {}, can('users.write') ? h('select', {
          class: 'select', style: { padding: '5px 8px', fontSize: '12px' }, onchange: async (e) => { await endpoints.admin.updateUser(u.id, { role: e.target.value }); toast('Роль изменена', `${u.publicUid} → ${e.target.value}`, 'ok'); },
        }, roles.map((r) => h('option', { value: r.code, selected: r.code === u.role }, r.name))) : h('span', { class: 'chip' }, u.role)),
        h('td', {}, h('span', { class: 'chip chip-brand' }, u.tier)),
        h('td', { class: 'num mono small' }, money(u.lifetimeRubMinor, 'RUB')),
        h('td', { class: 'num mono small' }, `${money(u.mainRubMinor, 'RUB')}`, h('div', { class: 'tiny dim' }, `+${money(u.bonusRubMinor, 'RUB')} бонусов`)),
        h('td', { class: 'num' }, `${u.paidOrdersCount}/${u.ordersCount}`),
        h('td', {}, h('div', { class: 'row gap-1' },
          can('wallet.adjust') ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => adjustModal(u) }, icon('wallet', 14)) : null,
          u.blacklisted ? h('span', { class: 'chip chip-danger' }, 'blacklist') : null,
          can('users.write') ? h('button', {
            class: 'btn btn-ghost btn-sm', title: u.blacklisted ? 'Разблокировать' : 'Заблокировать', onclick: async () => { await endpoints.admin.updateUser(u.id, { blacklisted: !u.blacklisted }); toast(u.blacklisted ? 'Разблокирован' : 'Заблокирован', u.publicUid, 'ok'); load(); },
          }, icon('lock', 14)) : null)))))));

    // blacklist
    const bl = await endpoints.admin.blacklist();
    blBox.innerHTML = '';
    blBox.appendChild(bl.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Тип'), h('th', {}, 'Значение'), h('th', {}, 'Причина'), h('th', {}, 'Добавил'), h('th', {}, 'Когда'), h('th', {}, ''))),
      h('tbody', {}, bl.map((b) => h('tr', {},
        h('td', {}, h('span', { class: 'chip chip-danger' }, b.kind)), h('td', { class: 'mono small' }, b.value),
        h('td', { class: 'small muted' }, b.reason || '—'),
        h('td', { class: 'tiny dim' }, b.created_by ? 'админ' : 'система'),
        h('td', { class: 'tiny dim nowrap' }, fmtDate(b.created_at)),
        h('td', {}, h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { await endpoints.admin.removeBlacklist(b.id); toast('Удалено', '', 'ok'); load(); } }, icon('trash', 14))))))))
      : h('p', { class: 'small muted' }, 'Чёрный список пуст'));
  }

  function adjustModal(u) {
    let amount = 0, walletType = 'main', comment = '';
    const m = modal({
      title: `Корректировка баланса · ${u.publicUid}`,
      body: h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Сумма в ₽ (отрицательная = списание)'),
          h('input', { class: 'input mono', type: 'number', oninput: (e) => { amount = Math.round(Number(e.target.value) * 100); } })),
        h('div', { class: 'field' }, h('label', {}, 'Кошелёк'),
          h('select', { class: 'select', onchange: (e) => { walletType = e.target.value; } }, [['main', 'Основной'], ['bonus', 'Бонусный']].map(([v, t]) => h('option', { value: v }, t)))),
        h('div', { class: 'field' }, h('label', {}, 'Комментарий (виден клиенту)'),
          h('input', { class: 'input', oninput: (e) => { comment = e.target.value; } })),
        h('div', { class: 'notice notice-warn' }, icon('lock', 15), h('div', { class: 'tiny' }, 'Операция пишется в аудит и в неизменяемый леджер кошелька.'))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            if (!amount) return toast('Укажите сумму', '', 'err');
            try { await endpoints.admin.adjustBalance(u.id, { amountRubMinor: amount, walletType, comment }); m.close(); toast('Проведено', money(amount, 'RUB'), 'ok'); load(); }
            catch (e) { toast('Ошибка', e.message, 'err'); }
          },
        }, 'Провести'),
      ],
    });
  }

  function addBlacklist() {
    let kind = 'phone', value = '', reason = '';
    const m = modal({
      title: 'Добавить в чёрный список',
      body: h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Тип'),
          h('select', { class: 'select', onchange: (e) => { kind = e.target.value; } }, [['phone', 'Телефон'], ['email', 'E-mail'], ['ip', 'IP-адрес'], ['user', 'User ID'], ['device', 'Устройство']].map(([v, t]) => h('option', { value: v }, t)))),
        h('div', { class: 'field' }, h('label', {}, 'Значение'), h('input', { class: 'input mono', oninput: (e) => { value = e.target.value; } })),
        h('div', { class: 'field' }, h('label', {}, 'Причина'), h('input', { class: 'input', oninput: (e) => { reason = e.target.value; } }))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-danger', onclick: async () => {
            if (!value) return toast('Укажите значение', '', 'err');
            await endpoints.admin.addBlacklist({ kind, value, reason });
            m.close(); toast('Добавлено', 'Регистрация и оплата заблокированы', 'ok'); load();
          },
        }, 'Заблокировать'),
      ],
    });
  }

  await load();
  return wrap;
}

// ── СПОРЫ (АДМИН) ──────────────────────────────────────────────────────────
async function tDisputes() {
  const rows = await endpoints.admin.disputes();
  const wrap = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('flag', 20), h('h3', {}, `Споры и возвраты · ${rows.length}`)),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Заказ'), h('th', {}, 'Клиент'), h('th', {}, 'Причина'), h('th', {}, 'Статус'), h('th', { class: 'num' }, 'Сумма заказа'), h('th', {}, 'Решение'))),
      h('tbody', {}, rows.map((d) => h('tr', {},
        h('td', { class: 'mono small' }, d.orderNo), h('td', { class: 'mono small' }, d.user),
        h('td', { class: 'small' }, disputeReason(d.reason), d.description ? h('div', { class: 'tiny dim' }, d.description.slice(0, 90)) : null),
        h('td', {}, h('span', { class: `chip ${d.status.startsWith('refunded') ? 'chip-ok' : d.status === 'rejected' ? 'chip-danger' : 'chip-warn'}` }, d.status)),
        h('td', { class: 'num mono small' }, d.totalMinor ? money(d.totalMinor, d.currency) : '—'),
        h('td', {}, ['open', 'in_review'].includes(d.status)
          ? h('div', { class: 'btn-group' },
            h('button', { class: 'btn btn-primary btn-sm', onclick: () => resolve(d, 'refunded_full') }, '100% возврат'),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => resolve(d, 'refunded_partial') }, 'Частично'),
            h('button', { class: 'btn btn-danger btn-sm', onclick: () => resolve(d, 'rejected') }, 'Отказать'))
          : h('span', { class: 'tiny dim' }, d.resolution || '—')))))))
      : emptyState('Споров нет', 'Все клиенты довольны'));

  async function resolve(d, decision) {
    let refundMinor = Math.round((d.totalMinor || 0) / 2);
    let resolution = '';
    const m = modal({
      title: `Решение по спору ${d.orderNo}`,
      body: h('div', {},
        h('p', { class: 'small muted' }, `Причина: ${disputeReason(d.reason)}. Решение: ${decision}`),
        decision === 'refunded_partial' ? h('div', { class: 'field' }, h('label', {}, `Сумма возврата, ${d.currency}`),
          h('input', { class: 'input mono', type: 'number', value: (refundMinor / 100).toFixed(2), oninput: (e) => { refundMinor = Math.round(Number(e.target.value) * 100); } })) : null,
        h('div', { class: 'field' }, h('label', {}, 'Комментарий клиенту'),
          h('textarea', { class: 'textarea', oninput: (e) => { resolution = e.target.value; } }))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-primary', onclick: async () => {
            await endpoints.admin.resolveDispute(d.id, { decision, refundMinor, resolution });
            m.close(); toast('Решение сохранено', 'Клиент уведомлён, деньги проведены по леджеру', 'ok');
            navigate('#/admin/disputes');
          },
        }, 'Применить'),
      ],
    });
  }
  return wrap;
}

// ── ЗАДАЧИ ─────────────────────────────────────────────────────────────────
async function tTasks() {
  const rows = await endpoints.admin.tasks();
  const data = Array.isArray(rows) ? rows : [];
  const users = rows?.__payload?.users || [];
  const wrap = h('div', { class: 'stack gap-4' });
  const cols = [['todo', 'К выполнению'], ['in_progress', 'В работе'], ['done', 'Готово']];

  const priorityChip = (t) => {
    const cls = t.priority === 'urgent' ? 'chip-danger' : t.priority === 'high' ? 'chip-warn' : '';
    return h('span', { class: `chip ${cls}` }, t.priority);
  };

  const moveBtn = (t, status) => {
    if (status === 'done') return null;
    const next = status === 'todo' ? 'in_progress' : 'done';
    const label = status === 'todo' ? 'В работу' : 'Готово';
    return h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: async () => { await endpoints.admin.updateTask(t.id, { status: next }); navigate('#/admin/tasks'); },
    }, label);
  };

  const taskCard = (t, status) => {
    const head = h('div', { class: 'row gap-2', style: { marginBottom: '6px' } },
      priorityChip(t),
      t.orderNo ? h('span', { class: 'chip chip-info mono' }, t.orderNo) : null);
    const assignee = t.assignee ? `${t.assignee.name} · ${t.assignee.publicUid}` : 'не назначено';
    const actions = h('div', { class: 'btn-group' },
      moveBtn(t, status),
      can('tasks.write') ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => assignModal(t, users) }, icon('user', 13)) : null);
    const footer = h('div', { class: 'row spread', style: { marginTop: '10px' } },
      h('span', { class: 'tiny dim' }, assignee),
      actions);
    return h('div', { class: 'card', style: { padding: '12px', background: 'var(--card)' } },
      head,
      h('b', { class: 'small' }, t.title),
      t.description ? h('div', { class: 'tiny muted' }, t.description) : null,
      footer);
  };

  const column = (status, title) => {
    const tasks = data.filter((t) => t.status === status);
    const head = h('div', { class: 'row spread', style: { marginBottom: '12px' } },
      h('b', { class: 'small' }, title),
      h('span', { class: 'chip' }, String(tasks.length)));
    const list = h('div', { class: 'stack gap-2' }, tasks.map((t) => taskCard(t, status)));
    return h('div', { class: 'card', style: { background: 'var(--bg-3)' } }, head, list);
  };

  wrap.appendChild(h('div', { class: 'row spread' },
    h('h3', {}, 'Внутренний таск-менеджер'),
    h('button', { class: 'btn btn-primary btn-sm', onclick: () => createModal() }, icon('plus', 15), 'Новая задача')));
  wrap.appendChild(h('div', { class: 'grid grid-3' }, cols.map(([status, title]) => column(status, title))));

  function createModal() {
    let title = '', description = '', priority = 'normal', assigneeId = '';
    const m = modal({
      title: 'Новая задача',
      body: h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Заголовок'), h('input', { class: 'input', oninput: (e) => { title = e.target.value; } })),
        h('div', { class: 'field' }, h('label', {}, 'Описание'), h('textarea', { class: 'textarea', oninput: (e) => { description = e.target.value; } })),
        h('div', { class: 'grid grid-2' },
          h('div', { class: 'field' }, h('label', {}, 'Приоритет'), h('select', { class: 'select', onchange: (e) => { priority = e.target.value; } }, ['low', 'normal', 'high', 'urgent'].map((p) => h('option', { value: p }, p)))),
          h('div', { class: 'field' }, h('label', {}, 'Исполнитель'), h('select', { class: 'select', onchange: (e) => { assigneeId = e.target.value; } }, [h('option', { value: '' }, '—'), ...users.map((u) => h('option', { value: u.id }, `${u.name} (${u.publicUid})`))])))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', { class: 'btn btn-primary', onclick: async () => { if (!title) return toast('Нужен заголовок', '', 'err'); await endpoints.admin.createTask({ title, description, priority, assigneeId }); m.close(); navigate('#/admin/tasks'); } }, 'Создать'),
      ],
    });
  }
  function assignModal(t, users) {
    const m = modal({
      title: 'Назначить исполнителя',
      body: h('div', { class: 'field' }, h('select', { class: 'select', id: 'assign-sel' }, [h('option', { value: '' }, '— не назначен —'), ...users.map((u) => h('option', { value: u.id, selected: u.id === t.assignee?.id }, `${u.name} · ${u.publicUid} · ${u.role}`))])),
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', { class: 'btn btn-primary', onclick: async () => { await endpoints.admin.updateTask(t.id, { assigneeId: document.getElementById('assign-sel').value || null }); m.close(); navigate('#/admin/tasks'); } }, 'Сохранить')],
    });
  }
  return wrap;
}

// ── АУДИТ ──────────────────────────────────────────────────────────────────
async function tAudit() {
  const rows = await endpoints.admin.audit();
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('lock', 20), h('h3', {}, 'Журнал аудита'),
      h('span', { class: 'chip', style: { marginLeft: 'auto' } }, `${rows.length} записей`)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Когда'), h('th', {}, 'Кто'), h('th', {}, 'Действие'), h('th', {}, 'Объект'), h('th', {}, 'IP'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'tiny dim nowrap' }, fmtDateTime(r.at)),
        h('td', { class: 'mono small' }, r.actor || 'system'),
        h('td', {}, h('span', { class: 'chip' }, r.action)),
        h('td', { class: 'tiny dim' }, `${r.entity || ''} ${r.entityId ? String(r.entityId).slice(0, 10) : ''}`),
        h('td', { class: 'tiny dim mono' }, r.ip || '—')))))));
}

// ── утилиты ────────────────────────────────────────────────────────────────
function disputeReason(r) {
  return { legit_check_failed: 'Не прошёл Legit Check', defect: 'Брак', wrong_size: 'Неверный размер', wrong_color: 'Неверный цвет', cancel_before_ship: 'Отмена до отправки', other: 'Другое' }[r] || r;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** Рендереры вкладок — экспортированы, чтобы сквозные тесты могли прогнать каждый раздел. */
export const adminTabRenderers = {
  overview: tOverview, orders: tOrders, warehouse: tWarehouse, tiktok: tTiktok,
  referrals: tReferrals, rates: tRates, pnl: tPnl, users: tUsers,
  disputes: tDisputes, tasks: tTasks, audit: tAudit,
};
export { ALL_TABS };
