/**
 * PoizonVanart · server/util.js — HTTP-утилиты микро-фреймворка (0 зависимостей).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (msg, details) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Требуется авторизация') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Недостаточно прав') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Не найдено') => new HttpError(404, 'not_found', msg);
export const conflict = (msg) => new HttpError(409, 'conflict', msg);

export function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body, null, 0), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function text(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const payload = Buffer.from(String(body), 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': payload.length, ...headers });
  res.end(payload);
}

export function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'payload_too_large', 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = (req.headers['content-type'] || '').toLowerCase();
      try {
        if (ct.includes('application/json')) resolve(raw ? JSON.parse(raw) : {});
        else if (ct.includes('application/x-www-form-urlencoded')) resolve(Object.fromEntries(new URLSearchParams(raw)));
        else resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'invalid_json', 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  parts.push(`Max-Age=${opts.maxAge ?? 60 * 60 * 24 * 30}`);
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  const prev = res.getHeader?.('Set-Cookie');
  const arr = Array.isArray(prev) ? prev : prev ? [prev] : [];
  arr.push(parts.join('; '));
  res.setHeader?.('Set-Cookie', arr);
  return arr;
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** Простейший rate limiter по IP (в продакшене — Redis). */
const buckets = new Map();
/** Тестовый прогон (PV_TEST=1) не ограничиваем: тесты логинятся десятками сессий. */
const TEST_MODE = process.env.PV_TEST === '1';
export function rateLimit(key, limit = 60, windowMs = 60_000) {
  if (TEST_MODE) return true;
  const now = Date.now();
  const b = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count += 1;
  buckets.set(key, b);
  if (buckets.size > 20_000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  return b.count <= limit;
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// ── статика ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.map': 'application/json',
};

export function serveStatic(res, rootDir, urlPath, { spaFallback = 'index.html', immutablePrefixes = ['/img/'] } = {}) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/') p = '/index.html';
  const filePath = path.join(rootDir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(rootDir)) { res.writeHead(403); return res.end('Forbidden'); }
  const send = (file, cache) => {
    const ext = path.extname(file).toLowerCase();
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': cache,
    });
    res.end(body);
  };
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const cache = immutablePrefixes.some((pref) => p.startsWith(pref)) ? 'public, max-age=31536000, immutable' : 'no-cache, no-store, must-revalidate, max-age=0';
    return send(filePath, cache);
  }
  // SPA-фолбэк — только для навигационных запросов (hash-роутер отдаёт один index.html).
  // Для ассетов он вреден: отсутствующий .js/.css/.svg возвращался бы как HTML с кодом 200,
  // из-за чего битый импорт модуля выглядел «успешным», а опечатки в путях не находились.
  const assetExt = ['.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.ico', '.map', '.json', '.woff', '.woff2', '.ttf', '.txt', '.xml', '.webmanifest'];
  const isAssetRequest = assetExt.includes(path.extname(p).toLowerCase());
  if (!isAssetRequest && spaFallback) {
    const fallback = path.join(rootDir, spaFallback);
    if (fs.existsSync(fallback)) return send(fallback, 'no-cache');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

// ── генератор placeholder-изображений (SVG, детерминированный) ─────────────
const PALETTES = [
  ['#1b1f2a', '#ff5a3c'], ['#101820', '#00d1b2'], ['#1a1030', '#a855f7'],
  ['#0f1a2b', '#3b82f6'], ['#22140f', '#f59e0b'], ['#0d1f1a', '#22c55e'],
];
function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h); }

export function placeholderSvg(seed, { label = '', w = 640, h = 480, kind = 'product' } = {}) {
  const n = hashStr(seed);
  const [bg, accent] = PALETTES[n % PALETTES.length];
  const angle = n % 360;
  const sText = String(label || seed).toLowerCase();
  
  if (kind === 'report' || sText.includes('report') || sText.includes('пломб') || sText.includes('сертифик') || sText.includes('вес') || sText.includes('коробк')) {
    // Реалистичные визуальные шаблоны складского фотоотчета
    if (sText.includes('пломб') || sText.includes('tag') || sText.includes('plomb') || sText.includes('legit')) {
      const serial = `PZ-${((n % 900000) + 100000)}`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="#0e131d"/>
        <g transform="translate(140, 60)">
          <!-- Бирюзовая пломба Poizon -->
          <rect x="0" y="40" width="360" height="280" rx="20" fill="#00c8b3" filter="drop-shadow(0 15px 30px rgba(0,200,179,0.3))"/>
          <rect x="25" y="65" width="310" height="230" rx="14" fill="#0a8f81"/>
          <!-- Хвостик пломбы -->
          <rect x="160" y="-30" width="40" height="90" rx="8" fill="#00c8b3"/>
          <circle cx="180" cy="15" r="10" fill="#0e131d"/>
          <!-- Текст и штрихкод -->
          <text x="180" y="115" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="900" font-size="28" fill="#ffffff" text-anchor="middle" letter-spacing="4">POIZON</text>
          <text x="180" y="142" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="700" font-size="13" fill="#d1fbf7" text-anchor="middle" letter-spacing="2">AUTHENTIC VERIFIED</text>
          <!-- Штрихкод -->
          <g transform="translate(60, 165)" fill="#ffffff">
            <rect x="0" y="0" width="4" height="42"/>
            <rect x="8" y="0" width="8" height="42"/>
            <rect x="20" y="0" width="3" height="42"/>
            <rect x="28" y="0" width="6" height="42"/>
            <rect x="40" y="0" width="4" height="42"/>
            <rect x="48" y="0" width="10" height="42"/>
            <rect x="64" y="0" width="5" height="42"/>
            <rect x="74" y="0" width="4" height="42"/>
            <rect x="84" y="0" width="8" height="42"/>
            <rect x="98" y="0" width="3" height="42"/>
            <rect x="106" y="0" width="7" height="42"/>
            <rect x="118" y="0" width="12" height="42"/>
            <rect x="136" y="0" width="4" height="42"/>
            <rect x="144" y="0" width="8" height="42"/>
            <rect x="158" y="0" width="5" height="42"/>
            <rect x="168" y="0" width="10" height="42"/>
            <rect x="184" y="0" width="4" height="42"/>
            <rect x="194" y="0" width="8" height="42"/>
            <rect x="208" y="0" width="6" height="42"/>
            <rect x="220" y="0" width="10" height="42"/>
            <rect x="236" y="0" width="4" height="42"/>
          </g>
          <text x="180" y="235" font-family="ui-monospace, monospace" font-size="16" font-weight="700" fill="#ffffff" text-anchor="middle" letter-spacing="2">${serial}</text>
          <rect x="60" y="255" width="240" height="26" rx="6" fill="#005e54"/>
          <text x="180" y="273" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" font-weight="700" fill="#6dfceb" text-anchor="middle">✓ ПРОВЕРКА ПОДЛИННОСТИ ПРОЙДЕНА</text>
        </g>
        <!-- Штамп склада -->
        <rect x="20" y="420" width="600" height="40" rx="8" fill="#141c2b"/>
        <text x="320" y="445" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">Склад Гуанчжоу (КНР) · Фотоотчёт фиксации пломбы Legit Check</text>
      </svg>`;
    }

    if (sText.includes('сертифик') || sText.includes('cert') || sText.includes('qr')) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="#0d1117"/>
        <g transform="translate(120, 50)">
          <!-- Сертификат карточка -->
          <rect x="0" y="0" width="400" height="340" rx="16" fill="#161b22" stroke="#30363d" stroke-width="2"/>
          <!-- Золотая полоса -->
          <rect x="0" y="0" width="400" height="8" rx="4" fill="#f59e0b"/>
          <text x="200" y="45" font-family="ui-sans-serif, sans-serif" font-weight="900" font-size="20" fill="#ffffff" text-anchor="middle" letter-spacing="2">CERTIFICATE OF AUTHENTICITY</text>
          <text x="200" y="68" font-family="ui-sans-serif, sans-serif" font-size="12" fill="#8b949e" text-anchor="middle">POIZON / DEWU VERIFICATION SERVICE</text>
          <line x1="30" y1="85" x2="370" y2="85" stroke="#30363d" stroke-width="1"/>
          <!-- QR код -->
          <g transform="translate(50, 110)">
            <rect width="120" height="120" rx="8" fill="#ffffff"/>
            <rect x="15" y="15" width="30" height="30" fill="#000000"/>
            <rect x="22" y="22" width="16" height="16" fill="#ffffff"/>
            <rect x="75" y="15" width="30" height="30" fill="#000000"/>
            <rect x="82" y="22" width="16" height="16" fill="#ffffff"/>
            <rect x="15" y="75" width="30" height="30" fill="#000000"/>
            <rect x="22" y="82" width="16" height="16" fill="#ffffff"/>
            <rect x="55" y="55" width="12" height="12" fill="#000000"/>
            <rect x="75" y="75" width="18" height="18" fill="#000000"/>
            <rect x="98" y="60" width="8" height="24" fill="#000000"/>
          </g>
          <!-- Детали проверки -->
          <g transform="translate(190, 120)" font-family="ui-sans-serif, sans-serif" font-size="12" fill="#c9d1d9">
            <text x="0" y="15" font-weight="700" fill="#58a6ff">VERIFIED: ORIGINAL</text>
            <text x="0" y="40">Inspector: #WH-04</text>
            <text x="0" y="65">Material: 100% Pass</text>
            <text x="0" y="90">Stitching: 100% Pass</text>
            <text x="0" y="115">Hologram: Active</text>
          </g>
          <!-- Золотая печать -->
          <circle cx="340" cy="275" r="32" fill="#f59e0b" fill-opacity="0.15" stroke="#f59e0b" stroke-width="2"/>
          <text x="340" y="278" font-family="ui-sans-serif, sans-serif" font-size="10" font-weight="800" fill="#f59e0b" text-anchor="middle">PASSED</text>
          <text x="340" y="290" font-family="ui-sans-serif, sans-serif" font-size="8" fill="#f59e0b" text-anchor="middle">POIZON</text>
        </g>
        <rect x="20" y="420" width="600" height="40" rx="8" fill="#141c2b"/>
        <text x="320" y="445" font-family="ui-sans-serif, sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">Оригинальный сертификат подлинности Poizon с защитной голограммой</text>
      </svg>`;
    }

    if (sText.includes('вес') || sText.includes('weight') || sText.includes('взвешив')) {
      const weight = (1.2 + (n % 8) * 0.1).toFixed(2);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="#0b0f19"/>
        <g transform="translate(120, 60)">
          <!-- Электронные весы платформа -->
          <rect x="0" y="100" width="400" height="220" rx="16" fill="#1e293b" stroke="#334155" stroke-width="2"/>
          <!-- Табло весов -->
          <rect x="80" y="140" width="240" height="90" rx="10" fill="#020617" stroke="#475569" stroke-width="2"/>
          <!-- Цифровой индикатор веса -->
          <text x="200" y="202" font-family="ui-monospace, monospace" font-weight="900" font-size="44" fill="#22c55e" text-anchor="middle" letter-spacing="2">${weight} kg</text>
          <text x="200" y="260" font-family="ui-sans-serif, sans-serif" font-size="13" font-weight="700" fill="#94a3b8" text-anchor="middle">ФАКТИЧЕСКИЙ ВЕС В СБОРКЕ</text>
          <!-- Кнопки весов -->
          <circle cx="100" cy="285" r="8" fill="#3b82f6"/>
          <circle cx="140" cy="285" r="8" fill="#ef4444"/>
          <rect x="250" y="280" width="50" height="10" rx="5" fill="#64748b"/>
        </g>
        <rect x="20" y="420" width="600" height="40" rx="8" fill="#141c2b"/>
        <text x="320" y="445" font-family="ui-sans-serif, sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">Контрольное взвешивание на калиброванных весах склада: ${weight} кг</text>
      </svg>`;
    }

    if (sText.includes('коробк') || sText.includes('box') || sText.includes('упаковк')) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="#0f172a"/>
        <g transform="translate(110, 50)">
          <!-- Коробка Poizon 3D perspective -->
          <polygon points="60,120 200,60 360,120 200,190" fill="#1e293b" stroke="#475569" stroke-width="2"/>
          <polygon points="60,120 200,190 200,320 60,250" fill="#0f172a" stroke="#334155" stroke-width="2"/>
          <polygon points="200,190 360,120 360,250 200,320" fill="#1e293b" stroke="#334155" stroke-width="2"/>
          <!-- Фирменный скотч Poizon -->
          <polygon points="120,95 240,145 240,290 120,225" fill="#00c8b3" fill-opacity="0.25"/>
          <text x="180" y="195" font-family="ui-sans-serif, sans-serif" font-weight="900" font-size="18" fill="#00c8b3" transform="rotate(22 180 195)" letter-spacing="4">POIZON VERIFIED</text>
          <!-- Наклейка склада -->
          <rect x="220" y="190" width="100" height="70" rx="4" fill="#ffffff" transform="rotate(-5 220 190)"/>
          <rect x="230" y="200" width="80" height="8" fill="#000000"/>
          <rect x="230" y="215" width="60" height="5" fill="#475569"/>
          <rect x="230" y="225" width="70" height="20" fill="#00c8b3"/>
        </g>
        <rect x="20" y="420" width="600" height="40" rx="8" fill="#141c2b"/>
        <text x="320" y="445" font-family="ui-sans-serif, sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">Фирменная упаковка Poizon, углы коробки и пломбировочный скотч целы</text>
      </svg>`;
    }
  }

  // Стандартная карточка товара / инспекция
  const initials = String(label || seed).replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toUpperCase() || 'PV';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">
      <stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="${accent}" stop-opacity="0.35"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <rect x="${w / 2 - 96}" y="${h / 2 - 78}" width="192" height="132" rx="14" fill="none" stroke="${accent}" stroke-width="5"/>
    <path d="M${w / 2 - 96} ${h / 2 + 10} l52 -38 40 30 34 -24 66 46" fill="none" stroke="${accent}" stroke-width="5" stroke-linejoin="round"/>
    <text x="${w / 2}" y="${h / 2 + 96}" font-size="42" font-weight="700" fill="#e6e9ef" text-anchor="middle" font-family="ui-sans-serif">${initials}</text>
  </svg>`;
}

export function gzipMaybe(req, body) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (ae.includes('gzip') && body.length > 1024) return { body: zlib.gzipSync(body), encoding: 'gzip' };
  return { body, encoding: null };
}
