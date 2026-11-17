@echo off
title BOT WA - MASS.ID STORE
cd /d "%~dp0"
if not exist "node_modules\pino" (
  echo [*] Menginstal modul Node.js pertama kali...
  call npm install --no-audit --no-fund
)
:loop
node index.js
if %errorlevel%==2 goto end
echo [!] Bot berhenti. Restart dalam 5 detik... (tutup jendela untuk keluar)
ping -n 6 127.0.0.1 >nul
goto loop
:end
pause
