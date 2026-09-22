/**
 * PoizonVanart · views/account.js — личный кабинет клиента:
 * заказы, кошелёк, рефералы, TikTok-баланс, избранное, споры, уведомления, настройки (тема/валюта).
 */
import { h, icon, toast, spinner, emptyState, copyToClipboard, modal, confirmDialog, fmtDate, fmtDateTime, timeAgo } from '../dom.js';
import { endpoints } from '../api.js';
import { state, money, moneyFrom, setCurrency, applyTheme, logout, refreshUser, navigate, symbol } from '../state.js';
import { convertMinor, minorToDecimal } from '../money.js';

const TABS = [
  { id: 'overview', title: 'Обзор', icon: 'user' },
  { id: 'orders', title: 'Мои заказы', icon: 'box' },
  { id: 'wallet', title: 'Кошелёк', icon: 'wallet' },
  { id: 'referral', title: 'Рефералы', icon: 'gift' },
  { id: 'tiktok', title: 'TikTok-баланс', icon: 'tiktok' },
  { id: 'favorites', title: 'Избранное', icon: 'heart' },
  { id: 'disputes', title: 'Споры и возвраты', icon: 'flag' },
  { id: 'notifications', title: 'Уведомления', icon: 'bell' },
  { id: 'settings', title: 'Настройки', icon: 'gear' },
];

export async function renderAccount(route) {
  if (!state.user) { navigate('#/auth'); return h('div'); }
  const tab = TABS.find((t) => t.id === route.params[0]) ? route.params[0] : 'overview';
  const wrap = h('div', { class: 'container' });
  const content = h('div');

  const nav = h('nav', { class: 'side-nav' },
    h('div', { class: 'row gap-3', style: { padding: '10px 12px 14px' } },
      h('span', { class: 'avatar' }, (state.user.firstName?.[0] || 'U').toUpperCase()),
      h('div', { class: 'grow' },
        h('b', { class: 'small' }, `${state.user.firstName || ''} ${state.user.lastName || ''}`.trim() || 'Пользователь'),
        h('div', { class: 'tiny dim mono' }, state.user.publicUid))),
    h('div', { class: 'nav-label' }, 'Кабинет'),
    ...TABS.map((t) => h('a', { href: `#/account/${t.id}`, class: tab === t.id ? 'active' : '' }, icon(t.icon, 16), t.title)),
    h('div', { class: 'nav-sep' }),
    h('button', { onclick: async () => { await logout(); } }, icon('logout', 16), 'Выйти'));

  wrap.appendChild(h('div', { class: 'shell' }, nav, content));
  content.appendChild(spinner());

  const renderers = {
    overview: tabOverview, orders: tabOrders, wallet: tabWallet, referral: tabReferral,
    tiktok: tabTiktok, favorites: tabFavorites, disputes: tabDisputes,
    notifications: tabNotifications, settings: tabSettings,
  };
  try {
    content.innerHTML = '';
    content.appendChild(await renderers[tab](tab));
  } catch (e) {
    content.innerHTML = '';
    content.appendChild(h('div', { class: 'notice notice-warn' }, e.message));
  }
  return wrap;
}

// ── ОБЗОР ──────────────────────────────────────────────────────────────────
async function tabOverview() {
  const u = state.user;
  const orders = await endpoints.orders();
  const active = orders.filter((o) => !['delivered', 'cancelled', 'refunded'].includes(o.status));
  const wrap = h('div', { class: 'stack gap-4' });

  wrap.appendChild(h('div', { class: 'grid grid-4' },
    kpi('Баланс', money(u.wallet.mainView, u.currency), `+ бонусы ${money(u.wallet.bonusView, u.currency)}`, 'wallet'),
    kpi('Уровень', `${u.loyalty.tierName}`, `комиссия ${Math.round(u.loyalty.commissionRate * 100)}%`, 'star'),
    kpi('Заказов', String(orders.length), `в работе: ${active.length}`, 'box'),
    kpi('Потрачено', money(u.loyalty.lifetimeView, u.currency), u.loyalty.nextTier ? `до ${u.loyalty.nextTier.name}: ${money(u.loyalty.nextTier.remainView, u.currency)}` : 'максимальный уровень', 'chart')));

  // прогресс лояльности
  const lp = u.loyalty;
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'row spread gap-3 wrap' },
      h('h3', {}, `Программа лояльности: ${lp.tierName}`),
      lp.nextTier ? h('span', { class: 'chip chip-brand' }, `до ${lp.nextTier.name} осталось ${money(lp.nextTier.remainView, u.currency)}`) : h('span', { class: 'chip chip-ok' }, 'максимальный уровень')),
    h('div', { class: 'bar', style: { margin: '14px 0 8px' } }, h('span', { style: { width: `${Math.round((lp.progress || 0) * 100)}%` } })),
    h('div', { class: 'row spread tiny dim' },
      h('span', {}, `Комиссия сейчас: ${Math.round(lp.commissionRate * 100)}%`),
      h('span', {}, lp.nextTier ? `на уровне ${lp.nextTier.name}: ${Math.round(lp.nextTier.commission * 100)}%` : '')),
    h('div', { class: 'row gap-2 wrap', style: { marginTop: '12px' } }, (lp.perks || []).map((p) => h('span', { class: 'chip' }, icon('check', 13), p)))));

  // активные заказы
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('truck', 20), h('h3', {}, 'Активные заказы'),
      h('a', { class: 'btn btn-ghost btn-sm', style: { marginLeft: 'auto' }, href: '#/account/orders' }, 'Все заказы')),
    active.length ? h('div', { class: 'stack gap-3' }, active.slice(0, 3).map((o) => orderMini(o)))
      : emptyState('Активных заказов нет', 'Самое время собрать корзину на Poizon', h('a', { class: 'btn btn-primary', href: '#/catalog' }, 'В каталог'))));

  // быстрые действия
  wrap.appendChild(h('div', { class: 'grid grid-3' },
    quickAction('gift', 'Пригласить друга', `${state.config.referral?.percent || 3}% с первого оплаченного заказа друга`, '#/account/referral'),
    quickAction('tiktok', 'Заработать на TikTok', `${moneyFrom(state.config.tiktok?.reward_per_1000_views_rub_minor || 1500, 'RUB')} за 1 000 просмотров`, '#/account/tiktok'),
    quickAction('wallet', 'Пополнить баланс', 'Карта, СБП, ЕРИП — мгновенное зачисление', '#/account/wallet')));

  return wrap;
}

const kpi = (label, value, sub, ic) => h('div', { class: 'kpi' },
  h('div', { class: 'row spread' }, h('span', { class: 'k-label' }, label), h('span', { class: 'dim' }, icon(ic, 16))),
  h('div', { class: 'k-value' }, value), h('div', { class: 'k-sub' }, sub));

const quickAction = (ic, title, sub, href) => h('a', { class: 'card card-hover', href },
  h('div', { class: 'row gap-3' }, h('span', { class: 'logo-mark', style: { background: 'var(--brand-soft)', color: 'var(--brand)', boxShadow: 'none' } }, icon(ic, 16)),
    h('div', {}, h('b', { class: 'small' }, title), h('div', { class: 'tiny muted' }, sub))));

function orderMini(o) {
  const p = o.progressIndex || {};
  return h('a', { class: 'card', style: { display: 'block', background: 'var(--card-2)' }, href: `#/orders/${o.id}` },
    h('div', { class: 'row spread gap-3 wrap' },
      h('div', { class: 'row gap-3' },
        h('b', { class: 'mono small' }, o.orderNo),
        h('span', { class: `chip ${['cancelled', 'legit_check_failed'].includes(o.status) ? 'chip-danger' : o.status === 'delivered' ? 'chip-ok' : 'chip-info'}` }, o.statusRu)),
      h('div', { class: 'row gap-3' },
        h('span', { class: 'tiny dim' }, `${o.items.length} позиц. · ${o.weight.estKg} кг`),
        h('b', { class: 'mono' }, money(o.totalMinor, o.currency)))),
    h('div', { class: 'bar', style: { marginTop: '10px' } }, h('span', { style: { width: `${Math.max(4, Math.round(((p.index ?? 0) + 1) / (p.flow?.length || 12) * 100))}%`, background: p.failed ? 'var(--danger)' : undefined } })),
    h('div', { class: 'row spread tiny dim', style: { marginTop: '6px' } },
      h('span', {}, o.trackingNumber ? `трек: ${o.trackingNumber}` : `создан ${fmtDate(o.timeline?.createdAt)}`),
      h('span', {}, o.destinationLabel)));
}

// ── ЗАКАЗЫ ─────────────────────────────────────────────────────────────────
async function tabOrders() {
  const orders = await endpoints.orders();
  const wrap = h('div', { class: 'stack gap-4' });
  let filter = 'all';
  const listBox = h('div', { class: 'stack gap-3' });

  const tabs = h('div', { class: 'pill-tabs' },
    ['all', 'active', 'awaiting_payment', 'delivered', 'cancelled'].map((f) =>
      h('button', { 'aria-pressed': String(filter === f), onclick: (e) => { filter = f; [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); renderList(); } },
        { all: 'Все', active: 'В работе', awaiting_payment: 'Ожидают оплаты', delivered: 'Выданные', cancelled: 'Отменённые' }[f])));

  function renderList() {
    listBox.innerHTML = '';
    let rows = orders;
    if (filter === 'active') rows = orders.filter((o) => !['delivered', 'cancelled', 'refunded', 'awaiting_payment'].includes(o.status));
    else if (filter !== 'all') rows = orders.filter((o) => o.status === filter || (filter === 'cancelled' && o.status === 'refunded'));
    if (!rows.length) return listBox.appendChild(emptyState('Заказов нет', 'Измените фильтр или оформите новый заказ'));
    rows.forEach((o) => listBox.appendChild(orderMini(o)));
  }

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('box', 20), h('h3', {}, `История заказов · ${orders.length}`)),
    tabs, h('div', { style: { marginTop: '14px' } }, listBox)));
  renderList();
  return wrap;
}

// ── КОШЕЛЁК ────────────────────────────────────────────────────────────────
async function tabWallet() {
  const data = await endpoints.wallet();
  const wrap = h('div', { class: 'stack gap-4' });
  const cur = data.currency;
  const rates = state.config.ratesEffective;
  // кошелёк учитывается в RUB → в UI показываем в выбранной валюте
  const rubToView = (rubMinor) => convertMinor(rubMinor, 'RUB', cur, rates);
  const viewToRub = (viewMinor) => convertMinor(viewMinor, cur, 'RUB', rates);

  wrap.appendChild(h('div', { class: 'grid grid-3' },
    kpi('Основной баланс', money(data.mainView, cur), 'можно пополнять и выводить', 'wallet'),
    kpi('Бонусный баланс', money(data.bonusView, cur), 'рефералы и TikTok · тратится первым', 'gift'),
    kpi('Всего доступно', money(data.totalView, cur), data.reconciliation ? 'леджер сверен ✓' : 'требуется сверка', 'chart')));

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('plus', 20), h('h3', {}, 'Пополнение баланса')),
    topupForm(),
    h('div', { class: 'divider' }),
    h('p', { class: 'tiny dim' }, 'Пополнение через эквайринг / СБП / ЕРИП. В демо-режиме платёжный шлюз имитирован: деньги зачисляются мгновенно. Бонусный баланс не выводится и используется только для оплаты заказов. Учёт кошелька ведётся в RUB, отображение — в выбранной вами валюте.'),
    h('div', { class: 'notice notice-info', style: { marginTop: '12px' } }, icon('shield', 15),
      h('div', { class: 'tiny' }, `Вывод основного баланса: ${money(rubToView(10000), cur)} мин. · бонусы не выводятся · срок обработки до 3 рабочих дней`))));

  const txBox = h('div', { class: 'table-wrap' });
  renderTx(txBox, data.transactions);
  wrap.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, icon('chart', 20), h('h3', {}, 'История операций')), txBox));
  return wrap;

  function topupForm() {
    const presetsRub = [1000, 3000, 5000, 10000, 20000];
    let amountViewMinor = rubToView(300000);
    const input = h('input', { class: 'input mono', type: 'number', min: 1, step: '0.01', value: minorToDecimal(amountViewMinor, cur) });
    return h('div', {},
      h('div', { class: 'row gap-2 wrap', style: { marginBottom: '12px' } }, presetsRub.map((rub) =>
        h('button', {
          class: 'btn btn-ghost btn-sm', onclick: () => {
            amountViewMinor = rubToView(rub * 100);
            input.value = minorToDecimal(amountViewMinor, cur);
          },
        }, money(rubToView(rub * 100), cur)))),
      h('div', { class: 'row gap-2 wrap', style: { alignItems: 'flex-end' } },
        h('div', { class: 'field grow', style: { marginBottom: 0 } }, h('label', {}, `Сумма, ${cur}`), input),
        h('button', {
          class: 'btn btn-primary', onclick: async (e) => {
            const viewMinor = Math.round(Number(input.value || 0) * 100);
            const rubMinor = viewToRub(viewMinor);
            if (rubMinor < 100) return toast('Укажите сумму', 'Минимум 1 ₽ в эквиваленте', 'err');
            e.target.disabled = true;
            try {
              await endpoints.topup({ amountRubMinor: rubMinor, provider: 'card' });
              await refreshUser();
              toast('Баланс пополнен', `${money(viewMinor, cur)} зачислено на основной баланс`, 'ok');
              navigate('#/account/wallet');
            } catch (err) { toast('Ошибка', err.message, 'err'); e.target.disabled = false; }
          },
        }, icon('wallet', 17), 'Пополнить')));
  }
}

function renderTx(box, txs) {
  box.innerHTML = '';
  if (!txs.length) { box.appendChild(h('p', { class: 'muted small', style: { padding: '16px' } }, 'Операций пока нет')); return; }
  const names = {
    topup: 'Пополнение', topup_bonus: 'Бонусное пополнение', order_payment: 'Оплата заказа', order_payment_bonus: 'Оплата бонусами',
    refund: 'Возврат', refund_bonus: 'Возврат бонусов', referral_reward: 'Реферальный бонус', tiktok_reward: 'TikTok-бонус',
    loyalty_reward: 'Бонус лояльности', promo: 'Промо-начисление', adjustment: 'Корректировка', withdraw: 'Вывод', clawback: 'Отзыв награды',
  };
  box.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Дата'), h('th', {}, 'Операция'), h('th', {}, 'Комментарий'), h('th', {}, 'Бонусы/осн.'), h('th', { class: 'num' }, 'Сумма'), h('th', { class: 'num' }, 'Баланс после'))),
    h('tbody', {}, txs.map((t) => h('tr', {},
      h('td', { class: 'tiny dim nowrap' }, fmtDateTime(t.at)),
      h('td', {}, h('span', { class: `chip ${t.amountMinor > 0 ? 'chip-ok' : ''}` }, names[t.type] || t.type)),
      h('td', { class: 'small muted' }, t.comment || '—'),
      h('td', { class: 'tiny dim' }, t.walletType === 'bonus' ? 'бонусы' : 'основной'),
      h('td', { class: 'num', style: { color: t.amountMinor > 0 ? 'var(--ok)' : 'var(--text)', fontWeight: 700 } }, `${t.amountMinor > 0 ? '+' : ''}${money(t.amountView, t.currency)}`),
      h('td', { class: 'num dim' }, money(t.balanceAfterView, t.currency))))))));
}

// ── РЕФЕРАЛЫ ───────────────────────────────────────────────────────────────
async function tabReferral() {
  const r = await endpoints.referrals();
  const wrap = h('div', { class: 'stack gap-4' });
  const linkInput = h('input', { class: 'input mono', value: r.link, readonly: true });

  wrap.appendChild(h('div', { class: 'grid grid-3' },
    kpi('Приглашено', String(r.stats.invited), `активировано: ${r.stats.activated}`, 'users'),
    kpi('Заработано', money(r.stats.rewardedSum, r.currency), 'бонусами на счёт', 'gift'),
    kpi('Конверсия', `${Math.round((r.stats.conversion || 0) * 100)}%`, 'награда только за оплаченный заказ', 'chart')));

  wrap.appendChild(h('div', { class: 'card kpi-accent' },
    h('div', { class: 'card-head' }, icon('gift', 20), h('h3', {}, 'Ваш промокод и ссылка')),
    h('div', { class: 'row gap-3 wrap', style: { marginBottom: '14px' } },
      h('div', { class: 'card', style: { padding: '10px 20px', background: 'var(--card)', textAlign: 'center' } },
        h('div', { class: 'tiny dim' }, 'ПРОМОКОД'), h('b', { class: 'mono', style: { fontSize: '22px', letterSpacing: '.08em' } }, r.code)),
      h('div', { class: 'grow field', style: { marginBottom: 0 } }, h('label', {}, 'Реферальная ссылка'), linkInput)),
    h('div', { class: 'btn-group' },
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { copyToClipboard(r.link); toast('Ссылка скопирована', 'Отправьте другу в любой мессенджер', 'ok'); } }, icon('share', 15), 'Копировать ссылку'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { copyToClipboard(r.code); toast('Промокод скопирован', '', 'ok'); } }, icon('share', 15), 'Копировать код'),
      h('a', { class: 'btn btn-soft btn-sm', href: `https://t.me/share/url?url=${encodeURIComponent(r.link)}&text=${encodeURIComponent('Выкупаю оригиналы с Poizon через PoizonVanart — зарегистрируйся по моей ссылке и получи бонус на первый заказ')}`, target: '_blank', rel: 'noopener' }, 'Поделиться в Telegram')),
    h('div', { class: 'divider' }),
    h('div', { class: 'grid grid-3' },
      rule('1', 'Друг регистрируется', `по вашей ссылке или с промокодом ${r.code} — сразу получает ${money(r.config.inviteeBonusView, r.currency)} на бонусный счёт`),
      rule('2', 'Оплачивает первый заказ', 'полностью: картой, СБП или с баланса. Частичная оплата не считается'),
      rule('3', 'Вы получаете бонус', `${r.config.percent || 3}% от суммы его заказа (до ${money(r.config.capView, r.currency)}) на бонусный баланс`))));

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('users', 20), h('h3', {}, 'Приглашённые друзья')),
    r.friends.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Пользователь'), h('th', {}, 'Статус'), h('th', { class: 'num' }, 'Заказов'), h('th', { class: 'num' }, 'Оплачено'), h('th', { class: 'num' }, 'Потрачено'), h('th', { class: 'num' }, 'Вам начислено'), h('th', {}, 'Дата'))),
      h('tbody', {}, r.friends.map((f) => h('tr', {},
        h('td', {}, h('div', { class: 'row gap-2' }, h('span', { class: 'avatar', style: { width: '26px', height: '26px', fontSize: '10px' } }, (f.name || '?')[0]), h('div', {}, h('b', { class: 'small' }, f.name), h('div', { class: 'tiny dim mono' }, f.publicUid)))),
        h('td', {}, h('span', { class: `chip ${f.status === 'rewarded' ? 'chip-ok' : f.status === 'fraud' ? 'chip-danger' : 'chip-warn'}` }, statusRu(f.status))),
        h('td', { class: 'num' }, String(f.ordersCount)),
        h('td', { class: 'num' }, String(f.paidOrders)),
        h('td', { class: 'num' }, money(f.totalSpentView, r.currency)),
        h('td', { class: 'num', style: { color: 'var(--ok)', fontWeight: 700 } }, f.rewardView ? `+${money(f.rewardView, r.currency)}` : '—'),
        h('td', { class: 'tiny dim nowrap' }, fmtDate(f.registeredAt)))))))
      : emptyState('Пока никого', 'Поделитесь ссылкой — бонус придёт автоматически после первого оплаченного заказа друга')));

  wrap.appendChild(h('div', { class: 'notice notice-warn' }, icon('shield', 16),
    h('div', { class: 'small' }, h('b', {}, 'Антифрод: '), 'самореферал запрещён; один аккаунт = одно начисление; при полном возврате первого заказа награда отзывается (clawback); проверяем совпадения по IP, телефону и устройству.')));
  return wrap;
}
const rule = (n, title, text) => h('div', { class: 'row gap-3', style: { alignItems: 'flex-start' } },
  h('span', { class: 'logo-mark', style: { background: 'var(--brand-soft)', color: 'var(--brand)', boxShadow: 'none', flex: 'none' } }, n),
  h('div', {}, h('b', { class: 'small' }, title), h('div', { class: 'tiny muted' }, text)));
function statusRu(s) {
  return { registered: 'зарегистрирован', first_paid: 'оплатил первый', rewarded: 'награда начислена', clawback: 'награда отозвана', fraud: 'подозрение на фрод' }[s] || s;
}

// ── TIKTOK ─────────────────────────────────────────────────────────────────
async function tabTiktok() {
  const data = await endpoints.tiktok();
  const wrap = h('div', { class: 'stack gap-4' });
  const cfg = data.config;

  wrap.appendChild(h('div', { class: 'grid grid-3' },
    kpi('Заработано всего', money(data.totalEarnedView, data.currency), 'на бонусный баланс', 'tiktok'),
    kpi('Ставка', money(cfg.reward_per_1000_view, data.currency), 'за 1 000 просмотров', 'chart'),
    kpi('На проверке', String(data.submissions.filter((s) => s.status === 'pending').length), 'обычно до 24 часов', 'eye')));

  wrap.appendChild(h('div', { class: 'card kpi-accent' },
    h('div', { class: 'card-head' }, icon('tiktok', 20), h('h3', {}, 'Отправить видео на проверку')),
    h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
      h('div', {},
        h('ol', { class: 'checklist', style: { listStyle: 'none' } },
          h('li', {}, 'Снимите распаковку или обзор вещи, выкупленной через PoizonVanart'),
          h('li', {}, `Поставьте хэштег ${cfg.hashtag} и отметьте ${cfg.mention || '@poizonvanart'}`),
          h('li', {}, `Добавьте ссылку на сайт ${cfg.site_url} в описание или в шапку профиля`),
          h('li', {}, 'Скопируйте ссылку на опубликованное видео и вставьте в форму справа'),
          h('li', {}, 'После модерации бонус придёт на баланс автоматически'))),
      submitForm())));

  const listBox = h('div');
  renderList(listBox, data);
  wrap.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, icon('eye', 20), h('h3', {}, 'Мои заявки')), listBox));

  function submitForm() {
    const form = { url: '', description: '', views: '', linkInBio: false };
    return h('div', { class: 'card', style: { background: 'var(--card)' } },
      h('div', { class: 'field' }, h('label', {}, 'Ссылка на видео в TikTok *'),
        h('input', { class: 'input mono', placeholder: 'https://www.tiktok.com/@you/video/74102…', oninput: (e) => { form.url = e.target.value; } })),
      h('div', { class: 'field' }, h('label', {}, 'Текущее количество просмотров'),
        h('input', { class: 'input mono', type: 'number', min: 0, placeholder: '12400', oninput: (e) => { form.views = e.target.value; } }),
        h('span', { class: 'hint' }, 'Админ проверит фактические просмотры — начисление по подтверждённому числу')),
      h('div', { class: 'field' }, h('label', {}, 'Описание видео / что показали'),
        h('textarea', { class: 'textarea', placeholder: 'Распаковка Air Jordan 1 Chicago, проверка пломбы и сертификата…', oninput: (e) => { form.description = e.target.value; } })),
      h('label', { class: 'checkbox', style: { marginBottom: '12px' } },
        h('input', { type: 'checkbox', onchange: (e) => { form.linkInBio = e.target.checked; } }),
        h('span', { class: 'small' }, `Ссылка на ${cfg.site_url} есть в шапке профиля`)),
      h('button', {
        class: 'btn btn-primary btn-block', onclick: async (e) => {
          e.target.disabled = true;
          try {
            await endpoints.tiktokSubmit({ ...form, views: form.views ? Number(form.views) : null, hashtags: (form.description.match(/#\w+/g) || []).concat(cfg.hashtag) });
            toast('Отправлено на модерацию', 'Проверим в течение 24 часов', 'ok');
            navigate('#/account/tiktok');
          } catch (err) { toast('Не отправлено', err.message, 'err'); e.target.disabled = false; }
        },
      }, icon('check', 17), 'Отправить на проверку'));
  }

  function renderList(box, d) {
    box.innerHTML = '';
    if (!d.submissions.length) return box.appendChild(emptyState('Заявок пока нет', 'Опубликуйте видео и отправьте ссылку — начислим бонус за просмотры'));
    box.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Видео'), h('th', {}, 'Статус'), h('th', { class: 'num' }, 'Заявлено'), h('th', { class: 'num' }, 'Подтверждено'), h('th', { class: 'num' }, 'Начислено'), h('th', {}, 'Дата'))),
      h('tbody', {}, d.submissions.map((s) => h('tr', {},
        h('td', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'small' }, s.authorHandle || 'видео'), h('div', { class: 'tiny dim' }, s.hashtagFound ? `хэштег найден ✓` : 'хэштег не найден')),
        h('td', {}, h('span', { class: `chip ${s.status === 'approved' ? 'chip-ok' : s.status === 'pending' ? 'chip-warn' : 'chip-danger'}` }, tiktokStatus(s.status)), s.rejectReason ? h('div', { class: 'tiny dim' }, s.rejectReason) : null),
        h('td', { class: 'num mono' }, s.viewsDeclared ? s.viewsDeclared.toLocaleString('ru-RU') : '—'),
        h('td', { class: 'num mono' }, s.viewsVerified ? s.viewsVerified.toLocaleString('ru-RU') : '—'),
        h('td', { class: 'num mono', style: { color: 'var(--ok)', fontWeight: 700 } }, s.rewardMinor ? `+${money(s.rewardView, d.currency)}` : '—'),
        h('td', { class: 'tiny dim nowrap' }, fmtDate(s.createdAt))))))));
  }
  return wrap;
}
const tiktokStatus = (s) => ({ pending: 'на проверке', approved: 'одобрено', rejected: 'отклонено', duplicate: 'дубликат', blacklisted: 'заблокировано' }[s] || s);

// ── ИЗБРАННОЕ ──────────────────────────────────────────────────────────────
async function tabFavorites() {
  const favs = await endpoints.favorites();
  const wrap = h('div', { class: 'stack gap-4' });
  const dropped = favs.filter((f) => f.dropped);
  if (dropped.length) {
    wrap.appendChild(h('div', { class: 'notice notice-ok' }, icon('bell', 16),
      h('div', { class: 'small' }, h('b', {}, 'Price Drop Alert: '), `${dropped.length} товар(ов) из избранного подешевели. Уведомление также отправлено в Telegram, если аккаунт привязан.`)));
  }
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('heart', 20), h('h3', {}, `Избранное · ${favs.length}`)),
    favs.length ? h('div', { class: 'grid grid-3' }, favs.map((f) =>
      h('div', { class: 'card card-hover', style: { padding: '12px' } },
        h('img', { src: f.image || `/img/p/${encodeURIComponent(f.title)}.svg`, style: { width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 'var(--r-sm)' } }),
        h('b', { class: 'small', style: { display: 'block', margin: '10px 0 4px' } }, f.title),
        h('div', { class: 'tiny dim' }, [f.color, f.size && `EU ${f.size}`].filter(Boolean).join(' · ')),
        h('div', { class: 'row spread', style: { marginTop: '8px' } },
          h('b', { class: 'mono' }, f.priceView ? money(f.priceView, f.currency) : '—'),
          f.dropped ? h('span', { class: 'chip chip-ok' }, 'цена снизилась') : null),
        h('div', { class: 'btn-group', style: { marginTop: '10px' } },
          h('button', { class: 'btn btn-soft btn-sm grow', onclick: () => navigate('#/cart') }, 'В корзину'),
          h('button', { class: 'btn btn-danger btn-sm', onclick: async () => { await endpoints.removeFavorite(f.id); navigate('#/account/favorites'); } }, icon('trash', 14))))))
      : emptyState('В избранном пусто', 'Добавляйте товары — пришлём уведомление при падении цены или курса юаня', h('a', { class: 'btn btn-primary', href: '#/catalog' }, 'В каталог'))));
  return wrap;
}

// ── СПОРЫ ──────────────────────────────────────────────────────────────────
async function tabDisputes() {
  const orders = await endpoints.orders();
  const wrap = h('div', { class: 'stack gap-4' });
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('flag', 20), h('h3', {}, 'Возвраты и споры')),
    h('p', { class: 'small muted' }, 'Запросить возврат можно ', h('b', {}, 'до отправки из Китая'), '. Если товар не прошёл Legit Check — возвращаем 100% стоимости на баланс автоматически.'),
    h('div', { class: 'table-wrap', style: { marginTop: '12px' } }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Заказ'), h('th', {}, 'Статус'), h('th', {}, 'Возврат'), h('th', {})))),
      h('tbody', {}, orders.map((o) => h('tr', {},
        h('td', {}, h('a', { href: `#/orders/${o.id}`, class: 'mono small' }, o.orderNo)),
        h('td', {}, h('span', { class: 'chip' }, o.statusRu)),
        h('td', { class: 'small' }, o.canCancel ? h('button', { class: 'btn btn-danger btn-sm', onclick: () => askDispute(o) }, 'Запросить возврат') : h('span', { class: 'tiny dim' }, 'недоступно')),
        h('td', { class: 'tiny dim' }, o.canDispute ? 'до отправки из Китая' : 'заказ закрыт')))))));
  return wrap;

  function askDispute(o) {
    const form = { reason: 'cancel_before_ship', description: '' };
    const reasons = [
      ['cancel_before_ship', 'Отмена до отправки из Китая'],
      ['legit_check_failed', 'Не прошёл Legit Check → 100% возврат'],
      ['defect', 'Брак / повреждение'],
      ['wrong_size', 'Неверный размер'],
      ['wrong_color', 'Неверный цвет'],
      ['other', 'Другое'],
    ];
    const m = modal({
      title: `Возврат по заказу ${o.orderNo}`,
      body: h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Причина'),
          h('select', { class: 'select', onchange: (e) => { form.reason = e.target.value; } }, reasons.map(([v, t]) => h('option', { value: v }, t)))),
        h('div', { class: 'field' }, h('label', {}, 'Комментарий'),
          h('textarea', { class: 'textarea', oninput: (e) => { form.description = e.target.value; } })),
        h('div', { class: 'notice notice-info' }, icon('shield', 15),
          h('div', { class: 'tiny' }, 'Средства возвращаются на внутренний баланс (основной кошелёк) и доступны для новых заказов. Возврат на карту — по согласованию с менеджером.'))),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', {
          class: 'btn btn-danger', onclick: async () => {
            try {
              await endpoints.createDispute(o.id, form);
              m.close();
              toast('Заявка создана', form.reason === 'legit_check_failed' ? '100% возвращено на баланс' : 'Менеджер ответит в течение 24 часов', 'ok');
              navigate(`#/orders/${o.id}`);
            } catch (e) { toast('Ошибка', e.message, 'err'); }
          },
        }, 'Отправить заявку'),
      ],
    });
  }
}

// ── УВЕДОМЛЕНИЯ ────────────────────────────────────────────────────────────
async function tabNotifications() {
  const list = await endpoints.notifications();
  state.notifications = list;
  const wrap = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('bell', 20), h('h3', {}, 'Уведомления'),
      h('button', { class: 'btn btn-ghost btn-sm', style: { marginLeft: 'auto' }, onclick: async () => { await endpoints.readNotifications(); navigate('#/account/notifications'); } }, 'Прочитать все')),
    list.length ? h('ul', { class: 'list-plain' }, list.map((n) =>
      h('li', { class: 'card', style: { padding: '12px 14px', opacity: n.read ? 0.7 : 1 } },
        h('div', { class: 'row spread gap-3' }, h('b', { class: 'small' }, n.title), h('span', { class: 'tiny dim nowrap' }, timeAgo(n.at))),
        h('div', { class: 'small muted' }, n.body))))
      : emptyState('Уведомлений нет', 'Здесь появятся статусы заказов, фотоотчёты и начисления бонусов'));
  return wrap;
}

// ── НАСТРОЙКИ ──────────────────────────────────────────────────────────────
async function tabSettings() {
  const u = state.user;
  const wrap = h('div', { class: 'stack gap-4' });

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('user', 20), h('h3', {}, 'Профиль'),
      h('span', { class: 'chip', style: { marginLeft: 'auto' } }, `User ID: ${u.publicUid}`)),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'field' }, h('label', {}, 'Имя'), h('input', { class: 'input', id: 'f-first', value: u.firstName || '' })),
      h('div', { class: 'field' }, h('label', {}, 'Фамилия'), h('input', { class: 'input', id: 'f-last', value: u.lastName || '' })),
      h('div', { class: 'field' }, h('label', {}, 'Телефон'), h('input', { class: 'input', id: 'f-phone', value: u.phone || '' })),
      h('div', { class: 'field' }, h('label', {}, 'Telegram'), h('input', { class: 'input', id: 'f-tg', value: u.telegramLinked ? 'привязан' : '', placeholder: '@nickname' }))),
    h('button', {
      class: 'btn btn-primary', onclick: async () => {
        try {
          await endpoints.updateProfile({
            firstName: document.getElementById('f-first').value,
            lastName: document.getElementById('f-last').value,
            phone: document.getElementById('f-phone').value,
            telegram: document.getElementById('f-tg').value,
          });
          await refreshUser();
          toast('Сохранено', 'Профиль обновлён', 'ok');
        } catch (e) { toast('Ошибка', e.message, 'err'); }
      },
    }, 'Сохранить профиль')));

  // тема и валюта
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('gear', 20), h('h3', {}, 'Интерфейс')),
    h('div', { class: 'grid grid-2' },
      h('div', {},
        h('label', { class: 'small muted' }, 'Тема оформления'),
        h('div', { class: 'segmented', style: { marginTop: '8px' } }, [['dark', '🌙 Тёмная'], ['light', '☀️ Светлая'], ['system', 'Системная']].map(([v, t]) =>
          h('button', { 'aria-pressed': String(u.theme === v), onclick: async (e) => { applyTheme(v); await endpoints.updateSettings({ theme: v }); await refreshUser(); [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); toast('Тема сохранена', 'Выбор синхронизирован с профилем', 'info', 2000); } }, t))),
        h('p', { class: 'hint', style: { marginTop: '8px' } }, 'Сохраняется в LocalStorage (мгновенно, без перезагрузки) и в профиле БД (синхронизация между устройствами).')),
      h('div', {},
        h('label', { class: 'small muted' }, 'Валюта отображения цен'),
        h('div', { class: 'segmented', style: { marginTop: '8px' } }, ['RUB', 'BYN', 'USD'].map((c) =>
          h('button', { 'aria-pressed': String(state.currency === c), onclick: async (e) => { setCurrency(c); await refreshUser(); [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); toast('Валюта сохранена', `Все цены пересчитаны в ${c}`, 'ok', 2000); } }, c))),
        h('p', { class: 'hint', style: { marginTop: '8px' } }, `Все цены на сайте пересчитываются мгновенно. Текущий курс CNY: ${state.config.ratesEffective.CNY.toFixed(4)} ₽, USD: ${state.config.ratesEffective.USD.toFixed(2)} ₽, BYN: ${state.config.ratesEffective.BYN.toFixed(3)} ₽.`)))));

  // уведомления
  const s = u.settings;
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('bell', 20), h('h3', {}, 'Уведомления')),
    h('div', { class: 'grid grid-2' },
      toggle('Telegram-бот (статусы, фотоотчёты, бонусы)', s.notifyTelegram, 'notifyTelegram'),
      toggle('E-mail', s.notifyEmail, 'notifyEmail'),
      toggle('Изменение статусов заказа', s.notifyStatus, 'notifyStatus'),
      toggle('Price Drop Alert (падение цены/курса)', s.notifyPriceDrop, 'notifyPriceDrop'))));

  // значения по умолчанию
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('truck', 20), h('h3', {}, 'Значения по умолчанию для заказов')),
    h('div', { class: 'grid grid-3' },
      h('div', { class: 'field' }, h('label', {}, 'Направление'),
        h('select', { class: 'select', id: 'd-dest' }, Object.entries(state.config.tariffs || {}).map(([k, t]) => h('option', { value: k, selected: k === s.defaultDestination }, `${t.label} · $${t.usd_per_kg}/кг`)))),
      h('div', { class: 'field' }, h('label', {}, 'Упаковка'),
        h('select', { class: 'select', id: 'd-pack' }, Object.entries(state.config.packaging || {}).map(([k, v]) => h('option', { value: k, selected: k === s.defaultPackaging }, `${packNameLocal(k)} · $${v}`)))),
      h('div', { class: 'field' }, h('label', {}, 'Страховка'),
        h('select', { class: 'select', id: 'd-ins' }, [['none', 'Без страховки'], ['standard', 'Страховка 2–3%']].map(([k, t]) => h('option', { value: k, selected: k === s.defaultInsurance }, t))))),
    h('button', {
      class: 'btn btn-primary', onclick: async () => {
        await endpoints.updateSettings({
          defaultDestination: document.getElementById('d-dest').value,
          defaultPackaging: document.getElementById('d-pack').value,
          defaultInsurance: document.getElementById('d-ins').value,
        });
        await refreshUser();
        toast('Сохранено', '', 'ok');
      },
    }, 'Сохранить')));

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('lock', 20), h('h3', {}, 'Безопасность и данные')),
    h('ul', { class: 'checklist' },
      h('li', {}, 'Пароль хранится в виде scrypt-хэша с солью'),
      h('li', {}, 'Сессии: access-токен 15 минут + refresh 30 дней, cookie HttpOnly/SameSite'),
      h('li', {}, 'Регистрация, вход и чекаут защищены капчей и rate-limit'),
      h('li', {}, 'Вы можете запросить экспорт или удаление персональных данных (152-ФЗ / GDPR) — напишите в поддержку')),
    h('div', { class: 'btn-group', style: { marginTop: '14px' } },
      h('button', { class: 'btn btn-ghost', onclick: () => navigate('#/account/notifications') }, 'Мои уведомления'),
      h('button', { class: 'btn btn-danger', onclick: async () => { if (await confirmDialog('Выйти из аккаунта?', 'Сессия на этом устройстве будет завершена', 'Выйти', true)) await logout(); } }, icon('logout', 16), 'Выйти'))));

  function toggle(label, value, key) {
    return h('label', { class: 'switch', style: { padding: '8px 0' } },
      h('input', {
        type: 'checkbox', checked: value, onchange: async (e) => {
          await endpoints.updateSettings({ [key]: e.target.checked });
          await refreshUser();
        },
      }), h('span', { class: 'track' }), h('span', { class: 'small' }, label));
  }
  return wrap;
}
function packNameLocal(code) {
  return { none: 'Без упаковки', basic: 'Базовая', corners: 'Картонные уголки', crate: 'Жёсткая обрешётка' }[code] || code;
}

/** Рендереры вкладок личного кабинета — для сквозных тестов. */
export const accountTabRenderers = {
  overview: tabOverview, orders: tabOrders, wallet: tabWallet, referral: tabReferral,
  tiktok: tabTiktok, favorites: tabFavorites, disputes: tabDisputes,
  notifications: tabNotifications, settings: tabSettings,
};
export { TABS as ACCOUNT_TABS };
