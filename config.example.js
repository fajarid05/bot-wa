// =============================================
//  CONTOH KONFIGURASI BOT WHATSAPP STORE
//  Salin file ini menjadi "config.js" lalu ubah nilainya.
// =============================================
module.exports = {
  // Nomor WA ADMIN / OWNER (format 08xx / 62xx)
  owner: ['081234567890'],

  // Nomor WA yang dipakai BOT (nomor lain, bukan nomor admin).
  // Boleh dikosongkan -> nanti ditanya saat pertama kali login.
  botNumber: '',

  // Nama toko
  storeName: 'NAMA STORE ANDA',

  // Awalan perintah admin. Contoh: .addlist  /addlist  #addlist  !addlist
  prefixes: ['.', '/', '#', '!'],

  // Zona waktu untuk salam & tanggal transaksi
  timezone: 'Asia/Jakarta',

  // Kirim pesan "Bot aktif" ke admin saat bot tersambung
  notifyOwnerOnConnect: true,

  // ===== ANTI BLOKIR / ANTI SPAM WHATSAPP =====
  cooldownSeconds: 5,
  typingDelaySeconds: [1.5, 3.5],
  minGapSeconds: 1.5,
  maxRepliesPerMinute: 15,
  sameReplyInGroupSeconds: 30,
  ignoreOlderThanSeconds: 120,

  autoReplyEveryHours: 6,
  orderReminderHours: 1,

  // ===== WEB DASHBOARD (khusus admin: .web on / .web off) =====
  webPort: 3000,
  webAutoOffMinutes: 60,
  webTunnel: true,

  // ===== FITUR STIKER =====
  stickerDailyLimit: 5,

  // ===== SINKRONISASI BOT TELEGRAM & UNTUNG RESELLER =====
  tgBotUsername: 'FebrianStore1_Bot',
  syncMarkup: 5000,
  tgAutoSyncEnabled: true,
  tgAutoSyncHours: 6,

  // ===== KECERDASAN BUATAN (GOOGLE GEMINI AI) =====
  geminiApiKey: '',

  // ===== SELISIH HARGA KHUSUS LUAR GRUP =====
  privateMarkup: 0
}
