/**
 * PoizonVanart · client/js/app.js — точка входа: layout, роутер, бутстрап.
 */
import { h, $, icon, toast, timeAgo, modal } from './dom.js';
import { api, endpoints } from './api.js';
import { state, bootstrap, subscribe, setCurrency, toggleTheme, applyTheme, logout, can, cartCount, refreshCart, isAdmin, money, setNavigateHandler } from './state.js';

import { renderHome } from './views/home.js';
import { renderCatalog, renderProduct } from './views/catalog.js';
import { renderCalculator } from './views/calculator.js';
import { renderCart } from './views/cart.js';
import { renderCheckout } from './views/checkout.js';
import { renderAuth } from './views/auth.js';
import { renderAccount } from './views/account.js';
import { renderOrder } from './views/order.js';
import { renderAdmin } from './views/admin.js';
import { renderPage } from './views/pages.js';
import { renderSizeGuide } from './views/sizeguide.js';

api.onError((err, method, path) => {
  if (err.status === 401 && !path.startsWith('/auth/')) {
    toast('Сессия истекла', 'Войдите заново, чтобы продолжить', 'err');
  } else if (err.status >= 500) {
    toast('Ошибка сервера', err.message, 'err');
  }
});

// ── роутер ─────────────────────────────────────────────────────────────────
const ROUTES = [
  { re: /^\/?$/, name: 'home', view: renderHome, public: true },
  { re: /^\/catalog$/, name: 'catalog', view: renderCatalog, public: true },
  { re: /^\/p\/(.+)$/, name: 'product', view: renderProduct, public: true },
  { re: /^\/calc$/, name: 'calculator', view: renderCalculator, public: true },
  { re: /^\/size-guide$/, name: 'sizeguide', view: renderSizeGuide, public: true },
  { re: /^\/cart$/, name: 'cart', view: renderCart, public: true },
  { re: /^\/cart\/s\/([\w-]+)$/, name: 'shared-cart', view: renderCart, public: true },
  { re: /^\/checkout$/, name: 'checkout', view: renderCheckout, auth: true },
  { re: /^\/auth$/, name: 'auth', view: renderAuth, public: true },
  { re: /^\/account(?:\/([\w-]+))?$/, name: 'account', view: renderAccount, auth: true },
  { re: /^\/orders\/([\w-]+)$/, name: 'order', view: renderOrder, auth: true },
  { re: /^\/admin(?:\/([\w-]+))?$/, name: 'admin', view: renderAdmin, auth: true, perm: 'orders.read' },
  { re: /^\/(how|guarantee|reviews|offer|privacy|terms|refund|requisites|contacts)$/, name: 'page', view: renderPage, public: true },
  { re: /^\/r\/([\w-]+)$/, name: 'ref', view: renderHome, public: true },
];

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  for (const r of ROUTES) {
    const m = pathPart.match(r.re);
    if (m) return { ...r, params: m.slice(1), query, path: pathPart };
  }
  return { name: '404', params: [], query, path: pathPart, view: renderPage, public: true };
}

export function navigate(hash) {
  if (location.hash === hash) routeChanged();
  else location.hash = hash;
}

let currentAbort = null;
async function routeChanged() {
  const route = parseHash();
  state.route = route;

  // реферальный deep-link → сохраняем код и показываем главную
  if (route.name === 'ref' && route.params[0]) {
    document.cookie = `pv_ref=${route.params[0]};path=/;max-age=${30 * 86400};SameSite=Lax`;
    localStorage.setItem('pv_ref', route.params[0]);
    navigate('#/');
    toast('Промокод сохранён', `Код ${route.params[0]} применится при регистрации`, 'ok');
    return;
  }

  if (route.auth && !state.user) {
    localStorage.setItem('pv_redirect', location.hash);
    navigate('#/auth');
    return;
  }
  if (route.perm && !can(route.perm)) {
    toast('Нет доступа', 'Раздел доступен сотрудникам с соответствующими правами', 'err');
    navigate('#/account');
    return;
  }
  if (route.name === '404') {
    main().innerHTML = '';
    main().appendChild(renderPage({ name: 'page', params: ['404'], query: {} }));
    window.scrollTo({ top: 0 });
    return;
  }

  const el = main();
  el.innerHTML = '';
  el.appendChild(h('div', { class: 'container' }, h('div', { class: 'skeleton', style: { height: '220px' } })));
  window.scrollTo({ top: 0, behavior: 'instant' });

  try {
    const view = await route.view(route);
    el.innerHTML = '';
    if (view) el.appendChild(view);
  } catch (e) {
    console.error(e);
    el.innerHTML = '';
    el.appendChild(h('div', { class: 'card center' },
      h('h3', {}, 'Не удалось загрузить раздел'),
      h('p', { class: 'muted' }, e.message),
      h('button', { class: 'btn btn-ghost', onclick: () => routeChanged() }, icon('refresh', 16), 'Повторить')));
  }

  // Синхронизация нативной кнопки «Назад» в Telegram WebApp
  if (window.Telegram?.WebApp) {
    try {
      const tg = window.Telegram.WebApp;
      if (route.name !== 'home' && location.hash !== '#/' && location.hash !== '') {
        tg.BackButton.show();
        tg.BackButton.onClick(() => history.back());
      } else {
        tg.BackButton.hide();
      }
      tg.HapticFeedback?.impactOccurred('light');
    } catch (e) {}
  }

  updateNav();
}

const main = () => $('#app-main');

function updateNav() {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const target = a.dataset.nav;
    a.classList.toggle('active', state.route.path === target || (target !== '/' && state.route.path.startsWith(target)));
  });
  document.querySelectorAll('[data-bottom-nav]').forEach((a) => {
    const target = a.dataset.bottomNav;
    const isUserTab = target === '/account';
    const active = isUserTab
      ? (state.route.path.startsWith('/account') || state.route.path.startsWith('/admin') || state.route.path.startsWith('/auth'))
      : (state.route.path === target || (target !== '/' && state.route.path.startsWith(target)));
    a.classList.toggle('active', active);
  });
  const userBtn = $('#bottom-nav-user');
  const userLbl = $('#bottom-nav-user-label');
  if (userBtn && userLbl) {
    userBtn.href = state.user ? (isAdmin() ? '#/admin' : '#/account') : '#/auth';
    userLbl.textContent = state.user ? 'Кабинет' : 'Войти';
  }
  const badge = $('#cart-badge');
  if (badge) {
    const n = cartCount();
    badge.textContent = n;
    badge.classList.toggle('hide', !n);
  }
  const bottomBadge = $('#bottom-cart-badge');
  if (bottomBadge) {
    const n = cartCount();
    bottomBadge.textContent = n;
    bottomBadge.classList.toggle('hide', !n);
  }
  const notifBadge = $('#notif-badge');
  if (notifBadge) {
    const unread = (state.notifications || []).filter((n) => !n.read).length;
    notifBadge.textContent = unread > 9 ? '9+' : unread;
    notifBadge.classList.toggle('hide', !unread);
  }
}

// ── HEADER ─────────────────────────────────────────────────────────────────
function buildHeader() {
  const header = h('header', { class: 'header' },
    h('div', { class: 'container' },
      h('a', { href: '#/', class: 'logo', 'aria-label': 'PoizonVanart — на главную' },
        h('img', { src: '/img/avatar.png', alt: 'PV', class: 'logo-img', width: 34, height: 34 }),
        h('div', { class: 'logo-text' },
          h('span', {}, 'Poizon', h('span', { style: { color: 'var(--brand)' } }, 'Vanart')),
          h('small', {}, 'выкуп из Китая · Legit Check'))),
      h('nav', { class: 'nav', id: 'main-nav' },
        h('a', { href: '#/catalog', 'data-nav': '/catalog' }, 'Каталог'),
        h('a', { href: '#/calc', 'data-nav': '/calc' }, 'Калькулятор'),
        h('a', { href: '#/how', 'data-nav': '/how' }, 'Доставка'),
        h('a', { href: '#/guarantee', 'data-nav': '/guarantee' }, 'Гарантия оригинала')),
      h('div', { class: 'header-actions' },
        h('button', {
          class: 'btn btn-primary btn-sm header-order-btn',
          title: 'Оформить быстрый заказ по ссылке с Poizon',
          onclick: () => openQuickOrderModal(),
        }, '⚡ Заказать'),
        buildCurrencySwitch(),
        h('a', { class: 'icon-btn', href: '#/cart', title: 'Корзина', 'aria-label': 'Корзина' },
          icon('cart', 18), h('span', { class: 'badge-dot hide', id: 'cart-badge' }, '0')),
        h('div', { id: 'auth-slot' })),
    ));
  return header;
}

function buildCurrencySwitch() {
  const box = h('div', { class: 'cur-switch', role: 'group', 'aria-label': 'Валюта отображения' });
  const render = () => {
    box.innerHTML = '';
    for (const c of ['RUB', 'BYN', 'USD']) {
      box.appendChild(h('button', {
        type: 'button', 'aria-pressed': String(state.currency === c), title: { RUB: 'Российский рубль (₽)', BYN: 'Белорусский рубль (Br)', USD: 'Доллар США ($)' }[c],
        onclick: () => { if (state.currency === c) return; setCurrency(c); render(); },
      }, c));
    }
  };
  render();
  document.addEventListener('pv:currency-changed', render);
  state.__renderCurrency = render;
  return box;
}

function renderAuthSlot() {
  const slot = $('#auth-slot');
  if (!slot) return;
  slot.innerHTML = '';
  if (state.user) {
    const u = state.user;
    const unread = (state.notifications || []).filter((n) => !n.read).length;
    slot.appendChild(h('div', { class: 'row gap-2' },
      h('button', { class: 'icon-btn', title: 'Уведомления', 'aria-label': 'Уведомления', onclick: openNotifications },
        icon('bell', 18), unread ? h('span', { class: 'badge-dot', id: 'notif-badge' }, unread > 9 ? '9+' : unread) : null),
      h('a', { class: 'btn btn-ghost btn-sm', href: isAdmin() ? '#/admin' : '#/account' },
        h('span', { class: 'avatar', style: { width: '22px', height: '22px', fontSize: '10px' } }, (u.firstName?.[0] || u.publicUid.slice(-2)).toUpperCase()),
        h('span', {}, u.publicUid))));
  } else {
    slot.appendChild(h('div', { class: 'row gap-2' },
      h('a', { class: 'btn btn-ghost btn-sm', href: '#/auth' }, 'Войти'),
      h('a', { class: 'btn btn-primary btn-sm', href: '#/auth?mode=register' }, 'Регистрация')));
  }
}

function openNotifications() {
  const list = (state.notifications || []);
  const back = h('div', { class: 'modal-backdrop' });
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.appendChild(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, 'Уведомления'),
      h('button', { class: 'icon-btn', onclick: close }, icon('x', 16))),
    list.length ? h('ul', { class: 'list-plain' }, list.map((n) =>
      h('li', { class: 'card', style: { padding: '12px 14px' } },
        h('div', { class: 'row spread gap-3' },
          h('b', { class: 'small' }, n.title),
          h('span', { class: 'tiny dim nowrap' }, timeAgo(n.at))),
        h('div', { class: 'small muted' }, n.body))))
      : h('p', { class: 'muted center' }, 'Пока пусто'),
    h('div', { class: 'btn-group', style: { marginTop: '16px', justifyContent: 'flex-end' } },
      h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { await endpoints.readNotifications(); state.notifications = (state.notifications || []).map((n) => ({ ...n, read: true })); updateNav(); close(); } }, 'Прочитать все'))));
  document.body.appendChild(back);
}

// ── FOOTER ─────────────────────────────────────────────────────────────────
function buildFooter() {
  const contacts = state.config?.contacts || {};
  return h('footer', { class: 'footer' },
    h('div', { class: 'container' },
      h('div', { class: 'footer-grid' },
        h('div', {},
          h('div', { class: 'logo', style: { marginBottom: '12px' } },
            h('img', { src: '/img/avatar.png', alt: 'PV', class: 'logo-img', width: 34, height: 34 }),
            h('span', {}, 'Poizon', h('span', { style: { color: 'var(--brand)' } }, 'Vanart'))),
          h('p', { class: 'small muted', style: { maxWidth: '40ch' } },
            'Премиальный выкуп и доставка оригинальных товаров с Poizon и других площадок Китая в Москву и Беларусь. Legit Check, фотоотчёт со склада, трек-номер и гарантия возврата.'),
          h('div', { class: 'row gap-2', style: { marginTop: '14px' } },
            contacts.telegram ? h('a', { class: 'btn btn-ghost btn-sm', href: contacts.telegram, target: '_blank', rel: 'noopener' }, 'Telegram') : null,
            contacts.whatsapp ? h('a', { class: 'btn btn-ghost btn-sm', href: contacts.whatsapp, target: '_blank', rel: 'noopener' }, 'WhatsApp') : null)),
        h('div', {}, h('h5', {}, 'Сервис'),
          h('ul', {},
            h('li', {}, h('a', { href: '#/catalog' }, 'Каталог')),
            h('li', {}, h('a', { href: '#/calc' }, 'Калькулятор стоимости')),
            h('li', {}, h('a', { href: '#/size-guide' }, 'Размерный гид')),
            h('li', {}, h('a', { href: '#/how' }, 'Как скопировать ссылку в Poizon')),
            h('li', {}, h('a', { href: '#/guarantee' }, 'Гарантия подлинности')),
            h('li', {}, h('a', { href: '#/reviews' }, 'Отзывы и фото')))),
        h('div', {}, h('h5', {}, 'Кабинет'),
          h('ul', {},
            h('li', {}, h('a', { href: '#/account/orders' }, 'Мои заказы')),
            h('li', {}, h('a', { href: '#/account/wallet' }, 'Кошелёк')),
            h('li', {}, h('a', { href: '#/account/referral' }, 'Реферальная программа')),
            h('li', {}, h('a', { href: '#/account/tiktok' }, 'TikTok-баланс')),
            h('li', {}, h('a', { href: '#/account/favorites' }, 'Избранное')),
            h('li', {}, h('a', { href: '#/account/settings' }, 'Настройки')))),
        h('div', {}, h('h5', {}, 'Документы'),
          h('ul', {},
            h('li', {}, h('a', { href: '#/offer' }, 'Публичная оферта')),
            h('li', {}, h('a', { href: '#/privacy' }, 'Политика конфиденциальности')),
            h('li', {}, h('a', { href: '#/refund' }, 'Правила возврата')),
            h('li', {}, h('a', { href: '#/requisites' }, 'Реквизиты')),
            h('li', {}, h('a', { href: '#/contacts' }, 'Контакты')))),
      ),
      h('div', { class: 'footer-bottom' },
        h('span', {}, `© ${new Date().getFullYear()} PoizonVanart. Все права защищены.`),
        h('span', {}, 'УНП 193000000 · ИНН 7700000000 · ООО «ПойзонВанарт» · hello@poizonvanart.com · ',
          contacts.phone_by || '+375 29 123-45-67'),
        h('span', {}, 'Цены указаны с учётом курса ЦБ + наценка сервиса. Не является публичной офертой в значении ст. 407 ГК.'))));
}

// ── ЧАТ ПОДДЕРЖКИ ──────────────────────────────────────────────────────────
function buildChat() {
  const fab = h('button', {
    class: 'chat-fab',
    'aria-label': 'Онлайн-чат поддержки 24/7',
    title: 'Онлайн-чат поддержки: ответим за пару минут',
    onclick: () => toggleChat(),
  },
    h('span', { class: 'chat-fab-pulse' }),
    h('span', { class: 'chat-fab-dot' }),
    icon('chat', 20),
    h('span', { class: 'chat-fab-text' }, 'Чат поддержки'),
    h('span', { class: 'chat-fab-badge' }, '24/7'));
  document.body.appendChild(fab);
}

async function toggleChat() {
  const existing = $('.chat-panel');
  if (existing) { existing.remove(); return; }
  const panel = h('div', { class: 'chat-panel' });
  document.body.appendChild(panel);
  panel.appendChild(h('div', { class: 'card-head', style: { padding: '14px 16px', margin: 0, borderBottom: '1px solid var(--border)' } },
    icon('chat', 18), h('b', {}, 'Служба заботы PoizonVanart'),
    h('span', { class: 'chip chip-ok chip-sm', style: { marginLeft: 'auto' } }, 'онлайн 24/7'),
    h('button', { class: 'icon-btn', onclick: () => panel.remove() }, icon('x', 15))));

  if (!state.user) {
    const tgLink = state.config?.contacts?.telegram || 'https://t.me/poizonvanart';
    panel.appendChild(h('div', { class: 'chat-msgs', style: { padding: '24px 18px', textAlign: 'center', alignItems: 'center', justifyContent: 'center' } },
      h('div', { class: 'avatar', style: { width: '56px', height: '56px', fontSize: '24px', margin: '0 auto', background: 'linear-gradient(135deg, var(--brand), #00c8b3)' } }, '💬'),
      h('h3', { style: { marginTop: '14px', marginBottom: '6px' } }, 'Онлайн-консультация'),
      h('p', { class: 'muted small', style: { margin: '0 0 16px', lineHeight: 1.5 } },
        'Поможем найти нужный товар на Poizon, проверить оригинальность, подобрать размер и рассчитать точную стоимость доставки в Москву или Минск.'),
      h('div', { class: 'stack gap-2', style: { width: '100%', marginBottom: '14px' } },
        h('button', {
          class: 'btn btn-soft btn-sm btn-block',
          style: { textAlign: 'left', justifyContent: 'flex-start' },
          onclick: () => { panel.remove(); openQuickOrderModal(); },
        }, '⚡ Рассчитать стоимость по ссылке'),
        h('button', {
          class: 'btn btn-soft btn-sm btn-block',
          style: { textAlign: 'left', justifyContent: 'flex-start' },
          onclick: () => { panel.remove(); navigate('#/calc'); },
        }, '🧮 Открыть калькулятор доставки')),
      h('div', { class: 'stack gap-2', style: { width: '100%' } },
        h('a', { class: 'btn btn-primary btn-block', href: '#/auth', onclick: () => panel.remove() }, icon('user', 16), 'Войти для чата на сайте'),
        h('a', { class: 'btn btn-ghost btn-block', href: tgLink, target: '_blank', rel: 'noopener' }, 'Написать в Telegram напрямую'))));
    return;
  }

  const msgs = h('div', { class: 'chat-msgs' }, h('div', { class: 'center muted small' }, 'Загрузка сообщений…'));
  panel.appendChild(msgs);

  // Быстрые подсказки
  const quickChips = h('div', { class: 'row gap-2 wrap', style: { padding: '8px 12px', borderTop: '1px solid var(--border)', background: 'var(--card-2)' } },
    ['Где мой заказ?', 'Как подобрать размер?', 'Сроки доставки'].map((q) =>
      h('button', {
        class: 'chip chip-sm', type: 'button',
        onclick: () => { input.value = q; send(); },
      }, q)));
  panel.appendChild(quickChips);

  const input = h('input', { class: 'input', placeholder: 'Напишите сообщение оператору…', maxlength: 1000 });
  const send = async () => {
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    await endpoints.chatSend({ body, threadId: state.chat?.[0]?.id });
    load();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  panel.appendChild(h('div', { class: 'chat-input' }, input, h('button', { class: 'btn btn-primary btn-sm', onclick: send }, 'Отправить')));

  async function load() {
    try {
      const threads = await endpoints.chat();
      state.chat = threads;
      const t = threads[0];
      msgs.innerHTML = '';
      if (!t) {
        msgs.appendChild(h('div', { class: 'msg admin' }, 'Здравствуйте! Это онлайн-чат поддержки PoizonVanart. Задайте любой вопрос по выкупу, размерам или статусу заказа — ответим в течение пары минут.', h('span', { class: 'm-time' }, 'сейчас')));
        return;
      }
      for (const m of t.messages) {
        msgs.appendChild(h('div', { class: `msg ${m.authorType === 'user' ? 'user' : 'admin'}` }, m.body, h('span', { class: 'm-time' }, new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))));
      }
      msgs.scrollTop = msgs.scrollHeight;
    } catch (e) { msgs.textContent = e.message; }
  }
  load();
}

// ── БЫСТРЫЙ ЗАКАЗ ПОД КЛЮЧ (ВСЁ В ОДНОМ) ──────────────────────────────────
export function openQuickOrderModal(initial = {}) {
  const cfg = state.config || {};
  const rates = state.rates || { CNY: 13.5, USD: 92, BYN: 33.7 };
  const weights = cfg.defaultWeightsKg || { sneakers: 1.4 };

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

  const form = {
    url: initial.url || '',
    title: initial.title || '',
    category: initial.category || 'sneakers',
    color: initial.color || '',
    size: initial.size || '',
    priceCny: Number(initial.priceCny) || 899,
    destination: initial.destination || (state.user?.settings?.default_destination || 'RU_MOW'),
    recipientName: state.user ? `${state.user.firstName || ''} ${state.user.lastName || ''}`.trim() : '',
    recipientPhone: state.user?.phone || '',
    telegram: state.user?.telegramUsername || '',
  };

  const linkInput = h('input', {
    class: 'input', placeholder: 'Вставьте ссылку dw4.co / dewu.com или артикул (напр. DD1391-100)', value: form.url,
    oninput: (e) => {
      form.url = e.target.value;
      if (form.url.includes('http') || form.url.includes('-')) {
        debounceParse();
      }
    },
  });

  const parseBtn = h('button', {
    class: 'btn btn-soft btn-sm', type: 'button', title: 'Автоматически определить товар, сетку и цены',
    onclick: () => doParse(),
  }, icon('refresh', 14), '⚡ Распознать');

  const pasteBtn = h('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Вставить из буфера',
    onclick: async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          const match = text.match(/https?:\/\/[^\s"'<>]+/);
          const val = match ? match[0] : text.trim();
          linkInput.value = val;
          form.url = val;
          toast('Ссылка вставлена', val.slice(0, 45) + '…', 'ok');
          doParse();
        }
      } catch (e) { toast('Вставьте ссылку вручную', '', 'info'); }
    },
  }, icon('copy', 14), 'Вставить');

  const sampleChips = h('div', { class: 'row gap-2 wrap', style: { marginTop: '8px', alignItems: 'center' } },
    h('span', { class: 'tiny muted', style: { fontWeight: 600 } }, 'Быстрый пример:'),
    [
      { label: '👟 Dunk Panda', sku: 'DD1391-100', title: 'Nike Dunk Low Panda', cat: 'sneakers', cny: 699, color: 'White/Black', size: '42.5' },
      { label: '👟 Travis Scott J1', sku: 'DM7866-162', title: 'Travis Scott x Air Jordan 1 Low', cat: 'sneakers', cny: 3890, color: 'Reverse Mocha', size: '43' },
      { label: '🧥 Essentials Hoodie', sku: '192BT212000F', title: 'Fear of God Essentials Hoodie', cat: 'hoodie', cny: 550, color: 'Black', size: 'L' },
      { label: '🧥 Arc\'teryx Beta LT', sku: '26844', title: 'Arc\'teryx Beta LT Jacket', cat: 'jacket', cny: 2850, color: 'Black Sapphire', size: 'M' },
    ].map((sample) =>
      h('button', {
        class: 'chip chip-sm', type: 'button',
        title: `Загрузить расчёт для ${sample.title}`,
        onclick: () => {
          linkInput.value = sample.sku;
          form.url = sample.sku;
          form.title = sample.title;
          titleInput.value = sample.title;
          form.category = sample.cat;
          catSelect.value = sample.cat;
          form.priceCny = sample.cny;
          priceInput.value = sample.cny;
          form.color = sample.color;
          colorInput.value = sample.color;
          form.size = sample.size;
          sizeInput.value = sample.size;
          recalc();
          doParse();
        },
      }, sample.label)));

  const parseStatusBox = h('div', { class: 'stack gap-2', style: { display: 'none', marginTop: '8px' } });

  let parseTimer = null;
  function debounceParse() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(doParse, 600);
  }

  async function doParse() {
    const q = form.url || titleInput.value;
    if (!q.trim()) return;
    parseBtn.disabled = true;
    parseBtn.textContent = 'Распознаём…';
    try {
      const res = await endpoints.parsePoizonLink({ url: q, destination: form.destination });
      if (res) {
        if (res.title) { form.title = res.title; titleInput.value = res.title; }
        if (res.category) { form.category = res.category; catSelect.value = res.category; syncPills(); }
        if (res.basePriceCny) { form.priceCny = res.basePriceCny; priceInput.value = res.basePriceCny; }

        renderParsedDetails(res);
        recalc();
        toast('Товар распознан!', `${res.brand || ''} ${res.title}`, 'ok');
      }
    } catch (e) {
      console.warn('Parser note:', e.message);
    } finally {
      parseBtn.disabled = false;
      parseBtn.innerHTML = '';
      parseBtn.appendChild(icon('refresh', 14));
      parseBtn.append(' ⚡ Распознать');
    }
  }

  function renderParsedDetails(res) {
    parseStatusBox.style.display = 'block';
    parseStatusBox.innerHTML = '';

    const cur = state.currency || 'RUB';
    const effectiveR = state.rates || { CNY: 13.2355, USD: 94.248, BYN: 33.698 };
    let retail = res.retailRuRub;
    let turnkey = res.vanartTurnkeyRub;
    let savings = res.savingsRub;

    if (cur === 'BYN') {
      retail = res.retailByByn;
      turnkey = res.vanartTurnkeyByn;
      savings = res.savingsByn;
    } else if (cur === 'USD') {
      const uRate = effectiveR.USD || 94.248;
      retail = Math.round(res.retailRuRub / uRate);
      turnkey = Math.round(res.vanartTurnkeyRub / uRate);
      savings = Math.round(res.savingsRub / uRate);
    }

    // Карточка сравнения цен и выгоды
    const compareCard = h('div', {
      class: 'card',
      style: { background: 'var(--card-2)', border: '1px solid var(--brand)', padding: '14px', borderRadius: 'var(--r-md)' },
    },
      h('div', { class: 'row spread', style: { marginBottom: '8px' } },
        h('b', { class: 'small' }, '🔥 Сравнение цен и ваша выгода:'),
        h('span', { class: 'chip chip-ok' }, `Экономия ${res.savingsPercent}%`)),
      h('div', { class: 'grid grid-3 gap-2 center', style: { margin: '8px 0' } },
        h('div', { class: 'card-3', style: { padding: '8px', borderRadius: '6px' } },
          h('div', { class: 'tiny muted' }, 'В магазинах РФ/РБ'),
          h('div', { class: 'mono small', style: { textDecoration: 'line-through', opacity: 0.7 } }, `${retail.toLocaleString('ru-RU')} ${cur}`)),
        h('div', { class: 'card-3', style: { padding: '8px', borderRadius: '6px', border: '1px solid var(--brand)' } },
          h('div', { class: 'tiny muted' }, 'Poizon под ключ'),
          h('b', { class: 'mono small', style: { color: 'var(--brand)' } }, `${turnkey.toLocaleString('ru-RU')} ${cur}`)),
        h('div', { class: 'card-3', style: { padding: '8px', borderRadius: '6px', background: 'rgba(34, 197, 94, 0.1)' } },
          h('div', { class: 'tiny muted' }, 'Ваша экономия'),
          h('b', { class: 'mono small', style: { color: 'var(--ok)' } }, `-${savings.toLocaleString('ru-RU')} ${cur}`))),
      h('div', { class: 'tiny dim' }, 'Оригинальный товар с официальной пломбой Dewu Legit Check и сертификатом подлинности.'));

    // Размерная сетка Poizon с ценами
    const sizeGridBox = h('div', { style: { marginTop: '10px' } },
      h('div', { class: 'small', style: { fontWeight: 600, marginBottom: '6px' } }, 'Размерная сетка и цены на Poizon (нажмите для выбора):'),
      h('div', { class: 'row gap-2 wrap' },
        (res.sizes || []).map((s) => {
          const isSelected = form.size === s.size;
          return h('button', {
            type: 'button',
            class: `btn ${isSelected ? 'btn-primary' : 'btn-soft'} btn-sm`,
            style: { padding: '4px 10px', fontSize: '12px' },
            onclick: () => {
              form.size = s.size;
              sizeInput.value = s.size;
              form.priceCny = s.priceCny;
              priceInput.value = s.priceCny;
              renderParsedDetails(res);
              recalc();
            },
          }, `${s.size} · ${s.priceCny} ¥`);
        })));

    parseStatusBox.appendChild(compareCard);
    parseStatusBox.appendChild(sizeGridBox);
  }

  const titleInput = h('input', {
    class: 'input', placeholder: 'Например: Nike Dunk Low / Essentials Hoodie', value: form.title,
    oninput: (e) => { form.title = e.target.value; },
  });

  const priceInput = h('input', {
    class: 'input', type: 'number', min: 1, placeholder: '899', value: form.priceCny,
    oninput: (e) => { form.priceCny = Number(e.target.value) || 0; recalc(); },
  });

  const sizeInput = h('input', {
    class: 'input', placeholder: '42 EU / L / M', value: form.size,
    oninput: (e) => { form.size = e.target.value; },
  });

  const colorInput = h('input', {
    class: 'input', placeholder: 'Черный / White / Grey', value: form.color,
    oninput: (e) => { form.color = e.target.value; },
  });

  const nameInput = h('input', {
    class: 'input', placeholder: 'Ваше имя', value: form.recipientName,
    oninput: (e) => { form.recipientName = e.target.value; },
  });

  const phoneInput = h('input', {
    class: 'input', placeholder: '+7 900 123-45-67 или +375 29 …', value: form.recipientPhone,
    oninput: (e) => { form.recipientPhone = e.target.value; },
  });

  const tgInput = h('input', {
    class: 'input', placeholder: '@username', value: form.telegram,
    oninput: (e) => { form.telegram = e.target.value; },
  });

  const catSelect = h('select', {
    class: 'select',
    onchange: (e) => { form.category = e.target.value; syncPills(); recalc(); },
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
          catSelect.value = catKey;
          syncPills();
          recalc();
        },
      }, `${meta.icon} ${meta.name}`);
    }));

  function syncPills() {
    [...catPills.children].forEach((btn, i) => {
      const keys = ['sneakers', 'hoodie', 'tshirt', 'jacket', 'bag'];
      btn.setAttribute('aria-pressed', String(form.category === keys[i]));
    });
  }

  const destTabs = h('div', { class: 'segmented' },
    [['RU_MOW', 'Москва, РФ (~22–28 дн)'], ['BY_MSQ', 'Минск, РБ (~25–32 дн)']].map(([code, label]) => h('button', {
      type: 'button',
      'aria-pressed': String(form.destination === code),
      onclick: (e) => {
        form.destination = code;
        [...destTabs.children].forEach((b) => b.setAttribute('aria-pressed', 'false'));
        e.target.setAttribute('aria-pressed', 'true');
        recalc();
      },
    }, label)));

  const totalSummary = h('div', { class: 'card', style: { background: 'var(--card-2)', padding: '16px', margin: '14px 0' } });

  function recalc() {
    const destTariff = cfg.tariffs?.[form.destination] || { usd_per_kg: form.destination === 'BY_MSQ' ? 4.5 : 3.5 };
    const cur = state.currency || 'RUB';
    const effectiveR = state.rates || { CNY: 13.2355, USD: 94.248, BYN: 33.698 };
    const cnyMinor = Math.round((form.priceCny || 0) * 100);
    const weightKg = weights[form.category] || 1.2;
    
    const goodsRub = Math.round(cnyMinor * (effectiveR.CNY || 13.2355) / 100);
    const commRub = Math.round(goodsRub * 0.1);
    const shipUsd = weightKg * destTariff.usd_per_kg + 3;
    const shipRub = Math.round(shipUsd * (effectiveR.USD || 94.248));
    const totalRub = goodsRub + commRub + shipRub;
    const totalView = cur === 'RUB' ? totalRub : Math.round(totalRub / (effectiveR[cur] || 1));
    const goodsView = cur === 'RUB' ? goodsRub : Math.round(goodsRub / (effectiveR[cur] || 1));

    totalSummary.innerHTML = '';
    totalSummary.appendChild(h('div', { class: 'row spread wrap gap-2', style: { alignItems: 'baseline', marginBottom: '6px' } },
      h('span', { class: 'small' }, 'Итого к оплате «под ключ»:'),
      h('b', { style: { fontSize: '24px', color: 'var(--brand)', letterSpacing: '-.02em' } }, money(totalView * 100, cur))));
    totalSummary.appendChild(h('div', { class: 'tiny muted' },
      `Включает: выкуп ${form.priceCny} ¥ (${money(goodsView * 100, cur)}) + комиссия 10% + карго ${weightKg} кг ($${shipUsd}) + страховка и Legit Check`));
  }
  recalc();

  const body = h('div', { class: 'stack gap-3' },
    h('div', { class: 'field' },
      h('div', { class: 'row spread', style: { marginBottom: '4px' } },
        h('label', {}, '1. Ссылка на товар с Poizon / Dewu или артикул'),
        h('div', { class: 'row gap-2' }, parseBtn, pasteBtn)),
      linkInput,
      sampleChips,
      parseStatusBox),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'field' }, h('label', {}, 'Название или артикул'), titleInput),
      h('div', { class: 'field' }, h('label', {}, 'Категория'), h('div', {}, catPills, catSelect))),
    h('div', { class: 'grid grid-3' },
      h('div', { class: 'field' }, h('label', {}, 'Цена в юанях (¥ CNY) *'), priceInput),
      h('div', { class: 'field' }, h('label', {}, 'Размер (EU/US) *'), sizeInput),
      h('div', { class: 'field' }, h('label', {}, 'Цвет'), colorInput)),
    h('div', { class: 'field' },
      h('label', {}, '2. Куда доставляем'),
      destTabs),
    totalSummary,
    h('div', { class: 'card-head', style: { margin: '8px 0 4px' } }, icon('user', 18), h('h4', {}, '3. Контактные данные получателя')),
    h('div', { class: 'grid grid-3' },
      h('div', { class: 'field' }, h('label', {}, 'Имя *'), nameInput),
      h('div', { class: 'field' }, h('label', {}, 'Телефон *'), phoneInput),
      h('div', { class: 'field' }, h('label', {}, 'Telegram (для фотоотчёта)'), tgInput)));

  let m = null;
  const submitBtn = h('button', {
    class: 'btn btn-primary btn-lg btn-block',
    onclick: async () => {
      if (!form.priceCny || form.priceCny <= 0) return toast('Укажите цену', 'Введите стоимость товара в юанях', 'warn');
      if (!form.recipientPhone.trim()) return toast('Укажите телефон', 'Введите контактный номер для связи', 'warn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Оформляем…';
      try {
        await endpoints.cartAdd({
          source: form.url ? 'link' : 'manual',
          externalUrl: form.url || undefined,
          title: form.title || CAT_PRESETS[form.category]?.name || 'Товар с Poizon',
          category: form.category,
          priceCnyMinor: Math.round(form.priceCny * 100),
          qty: 1,
          color: form.color || undefined,
          size: form.size || undefined,
          notes: form.telegram ? `Telegram: ${form.telegram}` : undefined,
        });
        await refreshCart();
        m?.close();
        toast('Товар добавлен в заказ!', 'Переходим к оформлению…', 'ok');
        location.hash = '#/checkout';
      } catch (err) {
        toast('Ошибка', err.message, 'err');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Оформить заказ';
      }
    },
  }, icon('arrow', 18), 'Оформить заказ');

  m = modal({
    title: 'Быстрый заказ с Poizon под ключ',
    body,
    wide: true,
    footer: [
      h('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Отмена'),
      submitBtn,
    ],
  });
}
window.openQuickOrderModal = openQuickOrderModal;

// ── МОБИЛЬНАЯ НАВИГАЦИЯ И КНОПКА «НАВЕРХ» ─────────────────────────────────
function buildBottomNav() {
  const isAuth = !!state.user;
  const userTarget = isAuth ? (isAdmin() ? '#/admin' : '#/account') : '#/auth';
  const userLabel = isAuth ? 'Кабинет' : 'Войти';
  const nav = h('nav', { class: 'bottom-nav', id: 'bottom-nav', 'aria-label': 'Мобильное меню' },
    h('a', { href: '#/', class: 'bottom-nav-item', 'data-bottom-nav': '/' },
      icon('home', 20),
      h('span', {}, 'Главная')),
    h('a', { href: '#/catalog', class: 'bottom-nav-item', 'data-bottom-nav': '/catalog' },
      icon('grid', 20),
      h('span', {}, 'Каталог')),
    h('button', {
      type: 'button',
      class: 'bottom-nav-action-btn',
      title: 'Быстрый заказ с Poizon под ключ',
      onclick: () => openQuickOrderModal(),
    },
      icon('plus', 20),
      h('span', {}, 'Заказать')),
    h('a', { href: '#/calc', class: 'bottom-nav-item', 'data-bottom-nav': '/calc' },
      icon('calc', 20),
      h('span', {}, 'Расчёт')),
    h('a', { href: '#/cart', class: 'bottom-nav-item', 'data-bottom-nav': '/cart' },
      h('div', { class: 'bottom-nav-icon-wrap' },
        icon('cart', 20),
        h('span', { class: 'badge-dot hide', id: 'bottom-cart-badge' }, '0')),
      h('span', {}, 'Корзина')),
    h('a', { href: userTarget, class: 'bottom-nav-item', 'data-bottom-nav': '/account', id: 'bottom-nav-user' },
      icon('user', 20),
      h('span', { id: 'bottom-nav-user-label' }, userLabel)),
  );
  return nav;
}

function buildScrollTop() {
  const btn = h('button', {
    class: 'scroll-top-btn hide',
    'aria-label': 'Наверх',
    title: 'Наверх',
    onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
  }, icon('arrow', 18));
  window.addEventListener('scroll', () => {
    btn.classList.toggle('hide', window.scrollY < 300);
  }, { passive: true });
  document.body.appendChild(btn);
}

// ── ИНИЦИАЛИЗАЦИЯ ──────────────────────────────────────────────────────────
function buildShell() {
  document.body.innerHTML = '';
  document.body.appendChild(buildHeader());
  document.body.appendChild(h('main', { id: 'app-main', class: 'page' }));
  document.body.appendChild(buildFooter());
  document.body.appendChild(buildBottomNav());
  buildChat();
  buildScrollTop();
  syncThemeIcon();
}

function syncThemeIcon() {
  const el = $('#theme-icon');
  if (!el) return;
  el.innerHTML = '';
  const resolved = document.documentElement.getAttribute('data-theme');
  el.appendChild(icon(resolved === 'light' ? 'moon' : 'sun', 17));
}

async function boot() {
  try {
    setNavigateHandler(routeChanged);
    buildShell();
    await bootstrap();
    syncThemeIcon();
    renderAuthSlot();
    window.addEventListener('hashchange', routeChanged);
    subscribeUi();
    await routeChanged();
    // автообновление уведомлений
    setInterval(async () => {
      if (!state.user) return;
      try {
        const n = await endpoints.notifications();
        const changed = JSON.stringify(n.map((x) => x.id)) !== JSON.stringify((state.notifications || []).map((x) => x.id));
        state.notifications = n;
        if (changed) { updateNav(); renderAuthSlot(); }
      } catch { /* noop */ }
    }, 45000);
  } catch (err) {
    console.error('[boot error]', err);
  }
}

async function rerenderCurrentRoute() {
  const route = state.route || parseHash();
  const el = main();
  if (!el || !route || !route.view) return;
  try {
    const view = await route.view(route);
    el.innerHTML = '';
    if (view) el.appendChild(view);
  } catch (e) {
    console.error('[rerenderCurrentRoute]', e);
  }
}

function subscribeUi() {
  // любой change в сторе → синхронизируем шапку (валюта, тема, корзина, уведомления, auth)
  subscribe(async (st, reason) => {
    renderAuthSlot();
    syncThemeIcon();
    updateNav();
    state.__renderCurrency?.();
    if (reason === 'currency') {
      await refreshCart();
      await rerenderCurrentRoute();
    }
  });
  renderAuthSlot();
  syncThemeIcon();
}

// экспорт для views
export { toast, money };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
