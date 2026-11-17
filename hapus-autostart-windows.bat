@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo [x] Klik kanan file ini lalu pilih "Run as administrator".
  pause
  exit /b 1
)
schtasks /end /tn "BotWA-MASSID" >nul 2>&1
schtasks /delete /tn "BotWA-MASSID" /f
if exist bot.lock (
  set /p OLDPID=<bot.lock
  taskkill /pid !OLDPID! /f >nul 2>&1
  del bot.lock >nul 2>&1
)
echo [OK] Autostart dihapus dan bot dimatikan.
pause
