#!/usr/bin/env node
/**
 * PoizonVanart · Cross-platform 1-click Launcher
 * Запускает сервер и автоматически открывает браузер.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const URL = `http://127.0.0.1:${PORT}`;

console.log('====================================================');
console.log('   PoizonVanart · Запуск платформы в 1 клик         ');
console.log('====================================================');

let srv = null;

function spawnServer() {
  srv = spawn(process.execPath, [path.join(__dirname, 'project', 'server', 'index.js')], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT) }
  });

  srv.on('exit', (code) => {
    if (code === 42) {
      console.log('\n====================================================');
      console.log('>>> [Система] Перезагрузка сайта по запросу владельца...');
      console.log('====================================================\n');
      setTimeout(spawnServer, 400);
    } else if (code !== 0 && code !== null) {
      clearInterval(checkInterval);
      process.exit(code);
    }
  });
}

spawnServer();

// Проверяем доступность порта и открываем браузер
let opened = false;
const checkInterval = setInterval(() => {
  const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
    if (res.statusCode === 200 && !opened) {
      opened = true;
      clearInterval(checkInterval);
      console.log(`\n>>> Сервер готов: ${URL}`);
      console.log('>>> Открываем браузер...\n');
      openBrowser(URL);
    }
  });
  req.on('error', () => { /* ждём старта */ });
  req.end();
}, 400);

function openBrowser(targetUrl) {
  const platform = os.platform();
  // Открытие браузера выполняется ТОЛЬКО на Windows по требованию
  if (platform === 'win32') {
    try {
      spawn('cmd', ['/c', 'start', targetUrl], { detached: true, stdio: 'ignore' });
      console.log('>>> Браузер открыт.');
    } catch (err) {
      console.log(`Перейдите в браузере по адресу: ${targetUrl}`);
    }
  } else {
    console.log(`>>> Сервер запущен. Откройте в браузере: ${targetUrl}`);
  }
}

process.on('SIGINT', () => {
  srv.kill('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  srv.kill('SIGTERM');
  process.exit(0);
});
