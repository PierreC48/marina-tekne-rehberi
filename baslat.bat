@echo off
chcp 65001 > nul
title Marina Tekne & Mürettebat Rehberi
echo ========================================================
echo   ⚓ Marina Tekne ^& Mürettebat Rehberi Başlatılıyor...
echo ========================================================
echo.
cd /d "%~dp0"
node server.js
pause
