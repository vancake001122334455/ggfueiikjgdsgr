#!/usr/bin/env bash
# PoizonVanart · 1-click startup script for Linux and macOS

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "===================================================="
echo "    PoizonVanart · Запуск платформы в 1 клик        "
echo "===================================================="

# Проверяем наличие Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "ОШИБКА: Node.js не установлен."
  echo "Установите Node.js 18+ с официального сайта: https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v)
echo "Обнаружен Node.js: $NODE_VERSION"

export PORT=${PORT:-8080}

# Запускаем кроссплатформенный лаунчер run.js
exec node run.js
