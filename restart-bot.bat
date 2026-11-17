@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
if not exist bot.lock (
  echo Bot sedang tidak berjalan.
  pause
  exit /b 0
)
set /p OLDPID=<bot.lock
taskkill /pid !OLDPID! /f
echo [OK] Bot dimatikan dan akan menyala lagi otomatis dalam beberapa detik.
echo      (berlaku kalau autostart atau start.bat sedang aktif)
pause
