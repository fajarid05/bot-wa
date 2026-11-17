#!/usr/bin/env bash
# Menjalankan bot terus-menerus (auto restart kalau mati). Untuk Termux / VPS.
cd "$(dirname "$0")"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
while true; do
  node index.js
  [ $? -eq 2 ] && break   # bot sudah jalan di tempat lain
  echo "[!] Bot berhenti. Restart dalam 5 detik... (Ctrl+C untuk keluar)"
  sleep 5
done
