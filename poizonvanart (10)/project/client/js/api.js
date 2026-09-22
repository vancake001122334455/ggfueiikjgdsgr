/**
 * PoizonVanart · client/js/api.js — HTTP-клиент.
 * Все суммы сервер возвращает в минорных единицах ВЫБРАННОЙ валюты (?currency=).
 */
const LS_TOKEN = 'pv_token';

let token = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_TOKEN) : null;
let currency = typeof localStorage !== 'undefined' ? (localStorage.getItem('pv_currency') || 'RUB') : 'RUB';
let onError = () => {};

export const api = {
  setToken(t) { token = t || null; if (typeof localStorage !== 'undefined') { if (t) localStorage.setItem(LS_TOKEN, t); else localStorage.removeItem(LS_TOKEN); } },
  getToken: () => token,
  setCurrency(c) { currency = c; if (typeof localStorage !== 'undefined') localStorage.setItem('pv_currency', c); },
  getCurrency: () => currency,
  onError(fn) { onError = fn; },

  async request(method, path, body, { raw = false, skipCurrency = false } = {}) {
    // ВАЖНО: path может уже содержать query-строку (endpoints.catalog({…}),
    // endpoints.admin.orders(filters), endpoints.admin.tiktok(status) и т.д.).
    // Раньше валюта дописывалась отдельным «?», из-за чего URL получался вида
    // /api/admin/tiktok?currency=RUB?status=pending и фильтры молча терялись.
    const qIndex = path.indexOf('?');
    const basePath = qIndex === -1 ? path : path.slice(0, qIndex);
    const qs = new URLSearchParams(qIndex === -1 ? '' : path.slice(qIndex + 1));
    if (!skipCurrency && currency) qs.set('currency', currency);
    const qsStr = qs.toString();
    const url = `/api${basePath}${qsStr ? `?${qsStr}` : ''}`;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });

    if (raw) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    }
    let data = null;
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok || data?.ok === false) {
      const msg = data?.error?.message || `Ошибка ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data?.error?.code;
      err.details = data?.error?.details;
      onError(err, method, path);
      throw err;
    }
    const out = data?.data !== undefined ? data.data : data;
    // Полный ответ сервера сохраняется в неперечислимом поле: сервер отдаёт полезные
    // поля РЯДОМ с data (meta, stats, roles, users, rateHistory), а разворачивание
    // data их теряло — из-за этого разделы рендерились пустыми или падали.
    if (out && typeof out === 'object') {
      try { Object.defineProperty(out, '__payload', { value: data ?? out, enumerable: false, writable: true }); } catch { /* frozen */ }
    }
    return out;
  },

  get: (p, o) => api.request('GET', p, undefined, o),
  post: (p, b, o) => api.request('POST', p, b ?? {}, o),
  patch: (p, b, o) => api.request('PATCH', p, b ?? {}, o),
  del: (p, b, o) => api.request('DELETE', p, b, o),

  downloadCsv(path, filename, params) {
    // params позволяет переопределить валюту (например, экспортировать P&L
    // в валюте отчёта, а не в валюте отображения интерфейса)
    const qs = new URLSearchParams(params || {});
    if (!qs.has('currency') && currency) qs.set('currency', currency);
    const q = qs.toString();
    const url = `/api${path}${q ? `?${q}` : ''}`;
    return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      });
  },
};

// ── типизированные вызовы ──────────────────────────────────────────────────
export const endpoints = {
  config: () => api.get('/config', { skipCurrency: true }),
  captcha: () => api.get('/auth/captcha', { skipCurrency: true }),
  login: (b) => api.post('/auth/login', b, { skipCurrency: true }),
  register: (b) => api.post('/auth/register', b, { skipCurrency: true }),
  logout: () => api.post('/auth/logout', {}),
  me: () => api.get('/me'),
  updateSettings: (b) => api.patch('/me/settings', b),
  updateProfile: (b) => api.patch('/me/profile', b),
  notifications: () => api.get('/me/notifications'),
  readNotifications: () => api.post('/me/notifications/read', {}),

  catalog: (params = {}) => api.get(`/catalog${query(params)}`),
  product: (slug) => api.get(`/catalog/${slug}`),
  sizeGuide: (params = {}) => api.get(`/size-guide${query(params)}`),
  parsePoizonLink: (b) => api.post('/catalog/parse-link', b),
  reviews: () => api.get('/reviews'),
  cdekCities: () => api.get('/cdek/cities'),
  cdekPvz: (city) => api.get(`/cdek/pvz${query({ city })}`),

  cart: () => api.get('/cart'),
  cartAdd: (b) => api.post('/cart/items', b),
  cartUpdate: (b) => api.patch('/cart', b),
  cartItemUpdate: (id, b) => api.patch(`/cart/items/${id}`, b),
  cartItemRemove: (id) => api.del(`/cart/items/${id}`),
  cartClear: () => api.del('/cart'),
  cartShare: (enabled) => api.post('/cart/share', { enabled }),
  sharedCart: (token) => api.get(`/cart/shared/${token}`),
  importSharedCart: (token) => api.post(`/cart/shared/${token}/import`, {}),

  quote: (b) => api.post('/calc/quote', b),

  orders: () => api.get('/orders'),
  order: (id) => api.get(`/orders/${id}`),
  createOrder: (b) => api.post('/orders', b),
  payOrder: (id, b) => api.post(`/orders/${id}/pay`, b),
  paymentPlan: (id) => api.post(`/orders/${id}/payment-plan`, {}),
  cancelOrder: (id, reason) => api.post(`/orders/${id}/cancel`, { reason }),
  createDispute: (id, b) => api.post(`/orders/${id}/disputes`, b),

  wallet: () => api.get('/wallet'),
  topup: (b) => api.post('/wallet/topup', b),
  withdraw: (b) => api.post('/wallet/withdraw', b),

  favorites: () => api.get('/favorites'),
  addFavorite: (b) => api.post('/favorites', b),
  removeFavorite: (id) => api.del(`/favorites/${id}`),

  referrals: () => api.get('/referrals'),
  tiktok: () => api.get('/tiktok'),
  tiktokSubmit: (b) => api.post('/tiktok/submissions', b),

  chat: () => api.get('/chat'),
  chatSend: (b) => api.post('/chat', b),
  chatAll: () => api.get('/chat?scope=all'),

  admin: {
    overview: () => api.get('/admin/overview'),
    orders: (params = {}) => api.get(`/admin/orders${query(params)}`),
    order: (id) => api.get(`/admin/orders/${id}`),
    bulkStatus: (ids, status, comment) => api.post('/admin/orders/bulk-status', { ids, status, comment }),
    tracking: (id, b) => api.post(`/admin/orders/${id}/tracking`, b),
    labels: (ids) => api.post('/admin/labels', { ids }),
    warehouseQueue: () => api.get('/admin/warehouse/queue'),
    warehouseUpdate: (id, b) => api.patch(`/admin/warehouse/orders/${id}`, b),
    warehousePhotos: (id, b) => api.post(`/admin/warehouse/orders/${id}/photos`, b),
    legitCheck: (id, b) => api.post(`/admin/warehouse/orders/${id}/legit-check`, b),
    settings: () => api.get('/admin/settings'),
    updateSetting: (key, value) => api.patch(`/admin/settings/${key}`, { value }),
    tiktok: (status) => api.get(`/admin/tiktok${query({ status })}`),
    tiktokReview: (id, b) => api.post(`/admin/tiktok/${id}/review`, b),
    referrals: () => api.get('/admin/referrals'),
    users: (q) => api.get(`/admin/users${query({ q })}`),
    updateUser: (id, b) => api.patch(`/admin/users/${id}`, b),
    adjustBalance: (id, b) => api.post(`/admin/users/${id}/adjust-balance`, b),
    blacklist: () => api.get('/admin/blacklist'),
    addBlacklist: (b) => api.post('/admin/blacklist', b),
    removeBlacklist: (id) => api.del(`/admin/blacklist/${id}`),
    disputes: () => api.get('/admin/disputes'),
    resolveDispute: (id, b) => api.post(`/admin/disputes/${id}/resolve`, b),
    tasks: () => api.get('/admin/tasks'),
    createTask: (b) => api.post('/admin/tasks', b),
    updateTask: (id, b) => api.patch(`/admin/tasks/${id}`, b),
    pnl: (params = {}) => api.get(`/admin/pnl${query(params)}`),
    audit: () => api.get('/admin/audit'),
    restartSystem: () => api.post('/admin/system/restart', {}),
  },
};

// Защитные алиасы на случай прямого вызова через api.*
api.me = endpoints.me;
api.cart = endpoints.cart;
api.notifications = endpoints.notifications;
api.updateSettings = endpoints.updateSettings;
api.logout = endpoints.logout;

function query(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') usp.set(k, v);
  const s = usp.toString();
  return s ? `?${s}` : '';
}
