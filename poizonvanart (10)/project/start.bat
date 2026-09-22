@echo off
title PoizonVanart Launcher
chcp 65001 >nul
cls

echo ====================================================
echo     PoizonVanart · Запуск платформы в 1 клик
echo ====================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ОШИБКА] Node.js не найден в системе!
    echo Пожалуйста, установите Node.js с официального сайта: https://nodejs.org
    echo После установки перезапустите этот файл.
    echo.
    pause
    exit /b 1
)

echo [1/3] Освобождение порта 8080 от старых процессов...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8080" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>nul
)

echo [2/3] Запуск локального сервера PoizonVanart...
echo [3/3] Браузер откроется автоматически: http://127.0.0.1:8080
echo.
echo ====================================================
echo * ССЫЛКИ ДЛЯ ВХОДА В БРАУЗЕРЕ:
echo   1. Основная: http://127.0.0.1:8080
echo   2. Запасная: http://localhost:8080
echo * ЕСЛИ В БРАУЗЕРЕ ЗАСТЫЛА СТАРАЯ ВЕРСИЯ:
echo   Нажмите Ctrl + F5 или откройте в Инкогнито (Ctrl + Shift + N)
echo ====================================================
echo.

node run.js

pause
