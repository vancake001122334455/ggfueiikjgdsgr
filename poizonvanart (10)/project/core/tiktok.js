/**
 * PoizonVanart · core/tiktok.js
 * ─────────────────────────────────────────────────────────────────────────────
 * «Баланс за просмотры»: пользователь публикует распаковку/обзор в TikTok
 * с фирменным хэштегом и ссылкой на сайт, отправляет ссылку на модерацию.
 * Админ подтверждает фактические просмотры → начисление на бонусный баланс.
 *
 *   reward = floor(views_verified / 1000) × reward_per_1000
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEFAULT_TIKTOK_CONFIG = {
  hashtag: '#poizonvanart',
  mention: '@poizonvanart',
  site_url: 'poizonvanart.com',
  reward_per_1000_views_rub_minor: 1_500,   // 15 ₽ / 0.50 BYN за 1 000 просмотров
  min_views: 1_000,
  max_submissions_per_day: 5,
  wallet_type: 'bonus',
  require_moderation: true,
};

/**
 * Нормализация ссылки и извлечение video id.
 * Поддерживает: tiktok.com/@user/video/123, vm.tiktok.com/XXXX, vt.tiktok.com/XXXX,
 * tiktok.com/t/XXXX, а также голый id.
 */
export function parseTikTokUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, error: 'empty_url' };

  const patterns = [
    /tiktok\.com\/@([\w.\-]+)\/video\/(\d+)/i,
    /tiktok\.com\/@([\w.\-]+)/i,
    /(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)/i,
    /tiktok\.com\/t\/([A-Za-z0-9]+)/i,
  ];

  let handle = null;
  let videoId = null;

  const m1 = url.match(patterns[0]);
  if (m1) { handle = m1[1]; videoId = m1[2]; }
  else {
    const m2 = url.match(patterns[1]);
    if (m2) { handle = m2[1]; }
    const m3 = url.match(patterns[2]) || url.match(patterns[3]);
    if (m3) videoId = m3[1];
  }

  if (!videoId && /^\d{10,25}$/.test(url)) videoId = url;

  if (!videoId) {
    return { ok: false, error: 'unrecognized_url', handle, videoId: null };
  }
  return {
    ok: true,
    videoId,
    handle,
    normalizedUrl: url.split('?')[0],
    authorHandle: handle ? `@${handle}` : null,
  };
}

/** Проверка обязательных атрибутов видео (хэштег, упоминание, ссылка на сайт). */
export function checkRequirements({ description = '', hashtags = [], linkInBio = false }, config = {}) {
  const c = { ...DEFAULT_TIKTOK_CONFIG, ...config };
  const text = `${description} ${hashtags.join(' ')}`.toLowerCase();
  const hashtagFound = text.includes(String(c.hashtag).toLowerCase().replace('#', ''));
  const mentionFound = text.includes(String(c.mention).toLowerCase().replace('@', ''));
  const linkFound = linkInBio || text.includes(String(c.site_url).toLowerCase());
  const missing = [];
  if (!hashtagFound) missing.push(`хэштег ${c.hashtag}`);
  if (!linkFound && !mentionFound) missing.push(`ссылка/упоминание ${c.site_url}`);
  return { ok: missing.length === 0, hashtagFound, mentionFound, linkFound, missing };
}

/** Начисление за просмотры. Возвращает сумму в минорных единицах RUB (валюта учёта кошелька). */
export function calcTikTokReward(viewsVerified, config = {}) {
  const c = { ...DEFAULT_TIKTOK_CONFIG, ...config };
  const views = Math.max(0, Math.floor(Number(viewsVerified || 0)));
  if (views < Number(c.min_views || 0)) {
    return { rewardRubMinor: 0, units: 0, views, reason: 'below_min_views', minViews: c.min_views };
  }
  const units = Math.floor(views / 1000);
  const reward = units * Math.round(Number(c.reward_per_1000_views_rub_minor || 0));
  return { rewardRubMinor: reward, units, views, reason: null, per1000: Number(c.reward_per_1000_views_rub_minor || 0) };
}

/**
 * Валидация подачи заявки (до записи в БД).
 * @param {Object} ctx { user, parsed, existingByVideoId, submissionsToday, config }
 */
export function validateSubmission({ parsed, existingByVideoId, submissionsToday = 0, requirements, config = {} }) {
  const c = { ...DEFAULT_TIKTOK_CONFIG, ...config };
  const errors = [];
  if (!parsed?.ok) errors.push(parsed?.error === 'unrecognized_url' ? 'Не распознана ссылка на видео TikTok' : 'Укажите ссылку на видео');
  if (existingByVideoId) errors.push('Это видео уже отправлялось на проверку');
  if (submissionsToday >= Number(c.max_submissions_per_day || 5)) errors.push('Дневной лимит заявок исчерпан');
  if (requirements && !requirements.ok) errors.push(`Не хватает: ${requirements.missing.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/** Решение модератора → итог. */
export function resolveModeration({ decision, viewsVerified, submission, config = {} }) {
  const c = { ...DEFAULT_TIKTOK_CONFIG, ...config };
  if (decision === 'reject') {
    return { status: 'rejected', rewardRubMinor: 0, viewsVerified: Number(viewsVerified || 0), requiresCredit: false };
  }
  const views = Math.max(0, Math.floor(Number(viewsVerified ?? submission?.views_declared ?? 0)));
  const { rewardRubMinor, units } = calcTikTokReward(views, c);
  return {
    status: rewardRubMinor > 0 ? 'approved' : 'rejected',
    viewsVerified: views,
    rewardRubMinor,
    units,
    requiresCredit: rewardRubMinor > 0,
    walletType: c.wallet_type || 'bonus',
  };
}

/** Человекочитаемый текст для уведомления клиента. */
export function rewardDescription(units, per1000Minor, currencyLabel = 'RUB') {
  return `${units} × 1 000 просмотров → ${units * per1000Minor / 100} ${currencyLabel}`;
}
