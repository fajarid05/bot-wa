@echo off
rem Dipakai oleh autostart (Task Scheduler). Output disimpan di bot.log
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>&1 || set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "node_modules\pino" (
  call npm install --no-audit --no-fund >> bot.log 2>&1
)
:loop
for %%A in (bot.log) do if %%~zA GTR 5000000 move /y bot.log bot.old.log >nul
echo ===== %date% %time% bot dinyalakan ===== >> bot.log
"%NODE%" index.js >> bot.log 2>&1
if %errorlevel%==2 goto end
ping -n 6 127.0.0.1 >nul
goto loop
:end
