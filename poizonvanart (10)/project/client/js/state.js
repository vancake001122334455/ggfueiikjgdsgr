/**
 * PoizonVanart · client/js/state.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Реактивный стор + переключатель ТЕМЫ и ВАЛЮТЫ.
 *
 * Тема:   data-theme на <html> → CSS-переменные → мгновенная перерисовка.
 *         Дублируется в LocalStorage (рендер до загрузки API, без "мигания")
 *         и в профиле БД (user_settings.theme) — синхронизация между устройствами.
 *
 * Валюта: хранится в LocalStorage + user_settings.currency. При смене:
 *         1) мгновенный локальный пересчёт уже отрисованных сумм (0 мс, без запроса);
 *         2) параллельно — авторитетный пересчёт на сервере (?currency=XXX);
 *         3) сохранение выбора в профиль.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { api, endpoints } from './api.js';
import { convertMinor, formatMoney, VIEW_CURRENCIES } from './money.js';

const LS_THEME = 'pv_theme';
const LS_CURRENCY = 'pv_currency';
const LS_LAST_ROUTE = 'pv_last_route';

export const state = {
  config: null,
  user: null,
  cart: null,
  currency: localStorage.getItem(LS_CURRENCY) || 'RUB',
  theme: localStorage.getItem(LS_THEME) || 'dark',
  route: { name: 'home', params: {}, query: {} },
  loading: false,
  notifications: [],
  captcha: null,
  chat: null,
  chatOpen: false,
  get rates() {
    return effectiveRates();
  },
  // кэш данных для мгновенного пересчёта валюты без повторных запросов
  cache: {},
  // хук перерисовки переключателя валюты в шапке — устанавливается в app.js (buildCurrencySwitch)
  __renderCurrency: null,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let renderQueued = false;
export function emit(reason = 'change') {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    for (const fn of listeners) {
      try { fn(state, reason); } catch (e) { console.error('[render]', e); }
    }
  });
}
export function setState(patch, reason) { Object.assign(state, patch); emit(reason); }

// ── ТЕМА: Фиксированный премиальный Sand & Dark Luxury ─────────────────────
export function applyTheme() {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.documentElement.style.colorScheme = 'dark';
  state.theme = 'dark';
  localStorage.setItem(LS_THEME, 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#0b0c10');
}
export function toggleTheme() {
  applyTheme();
  return 'dark';
}
export function setTheme(t) { applyTheme(t); persistSettings({ theme: t }); emit('theme'); }

// ── ВАЛЮТА ─────────────────────────────────────────────────────────────────
export function effectiveRates() {
  return state.config?.ratesEffective || { RUB: 1, BYN: 33.698, USD: 94.248, CNY: 13.2355 };
}
export function setCurrency(code, { persist = true } = {}) {
  if (!VIEW_CURRENCIES.includes(code)) return;
  const prev = state.currency;
  state.currency = code;
  localStorage.setItem(LS_CURRENCY, code);
  api.setCurrency(code);
  if (persist) persistSettings({ currency: code });
  emit('currency');
  // авторитетный пересчёт на сервере — данные, зависящие от валюты, перезапрашиваем
  if (prev !== code) {
    const evt = new CustomEvent('pv:currency-changed', { detail: { from: prev, to: code } });
    document.dispatchEvent(evt);
    window.dispatchEvent(evt);
  }
  return code;
}
/** Конвертация «на лету» уже полученных сумм (используется для мгновенного UX). */
export function conv(minor, from = state.currency) {
  return convertMinor(minor, from, state.currency, effectiveRates());
}
export function money(minor, currency = state.currency) {
  return formatMoney(minor, currency);
}
export function moneyFrom(minor, from) {
  return formatMoney(convertMinor(minor, from, state.currency, effectiveRates()), state.currency);
}
export function symbol(currency = state.currency) {
  return ({ RUB: '₽', BYN: 'Br', USD: '$', CNY: '¥' })[currency] || currency;
}

let persistTimer = null;
function persistSettings(patch) {
  if (!state.user) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const updated = await endpoints.updateSettings(patch);
      if (updated) { state.user = updated; emit('user'); }
    } catch (e) { /* оффлайн — выбор всё равно сохранён в LocalStorage */ }
  }, 400);
}

// ── ЗАГРУЗКА КОНТЕКСТА ─────────────────────────────────────────────────────
export async function bootstrap() {
  applyTheme(state.theme);
  api.setCurrency(state.currency);
  try { state.config = await endpoints.config(); } catch (e) { console.error('config', e); }
  if (api.getToken()) {
    try {
      state.user = await endpoints.me();
      // серверный профиль — источник правды для темы/валюты
      if (state.user.theme && state.user.theme !== state.theme) applyTheme(state.user.theme);
      if (state.user.currency && state.user.currency !== state.currency) {
        state.currency = state.user.currency;
        localStorage.setItem(LS_CURRENCY, state.currency);
        api.setCurrency(state.currency);
      }
      state.notifications = await endpoints.notifications().catch(() => []);
    } catch (e) {
      if (e.status === 401) { api.setToken(null); state.user = null; }
    }
  }
  emit('bootstrap');
  await refreshCart();
}

export async function refreshCart() {
  try { state.cart = await endpoints.cart(); } catch { state.cart = null; }
  emit('cart');
}

export async function refreshUser() {
  if (!api.getToken()) { state.user = null; return emit('user'); }
  try { state.user = await endpoints.me(); } catch { state.user = null; }
  emit('user');
}

export function login(token, user) {
  api.setToken(token);
  state.user = user;
  if (user?.currency && user.currency !== state.currency) setCurrency(user.currency, { persist: false });
  if (user?.theme) applyTheme(user.theme);
  emit('auth');
}
export async function logout() {
  try { await endpoints.logout(); } catch { /* noop */ }
  api.setToken(null);
  state.user = null; state.cart = null; state.notifications = [];
  emit('auth');
  location.hash = '#/';
}

export function can(permission) {
  const perms = state.user?.permissions || [];
  if (!state.user) return false;
  return perms.includes('*') || perms.includes(permission) || perms.includes(`${String(permission).split('.')[0]}.*`);
}
export function isAdmin() {
  return ['owner', 'admin', 'finance', 'support'].includes(state.user?.role);
}
export function isWarehouse() { return state.user?.role === 'warehouse'; }

export function cartCount() {
  return state.cart?.items?.reduce((a, i) => a + (i.qty || 1), 0) || 0;
}

// ── навигация ──────────────────────────────────────────────────────────────
// Роутер живёт в app.js; вьюхи импортируют navigate отсюда, чтобы не создавать
// циклическую зависимость views → app → views. app.js регистрирует обработчик при старте.
let navigateHandler = null;
export function setNavigateHandler(fn) { navigateHandler = fn; }
export function navigate(hash) {
  const target = String(hash).startsWith('#') ? String(hash) : `#${hash}`;
  if (location.hash === target) {
    if (navigateHandler) navigateHandler();
    return;
  }
  location.hash = target;
}

export { LS_LAST_ROUTE };
export { fmtDate, fmtDateTime } from './dom.js';
