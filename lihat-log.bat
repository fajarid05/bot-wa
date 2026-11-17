@echo off
title Log Bot WA - MASS.ID STORE (menutup jendela ini TIDAK mematikan bot)
cd /d "%~dp0"
if not exist bot.log (
  echo Belum ada bot.log. Log hanya ada kalau bot jalan lewat autostart.
  pause
  exit /b 0
)
powershell -NoProfile -Command "Get-Content -Path 'bot.log' -Wait -Tail 40 -Encoding UTF8"
