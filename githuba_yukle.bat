@echo off
chcp 65001 > nul
title GitHub'a Gönder ve Render'a Bağla
echo ========================================================
echo   ⚓ Marina Tekne Rehberi - GitHub'a Yükleme Aracı
echo ========================================================
echo.
echo 1. GitHub hesabınızda (github.com) yeni bir boş repo oluşturun.
echo    (Örnek repo adı: tekne-rehberi)
echo.
set /p REPO_URL="GitHub Repo URL'nizi buraya yapıştırın (örn: https://github.com/kullanici/tekne-rehberi.git): "

if "%REPO_URL%"=="" (
    echo Repo URL girilmedi, çıkılıyor.
    pause
    exit /b
)

cd /d "%~dp0"
git remote remove origin >nul 2>&1
git remote add origin %REPO_URL%
git branch -M main
git push -u origin main

echo.
echo ========================================================
echo   ✓ Proje GitHub'a başarıyla yüklendi!
echo   Şimdi dashboard.render.com adresine gidip bu repoyu
echo   seçerek web servisinizi canlıya alabilirsiniz.
echo ========================================================
pause
