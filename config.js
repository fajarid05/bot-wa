// =============================================
//  KONFIGURASI BOT - MASS.ID STORE
//  Ubah sesuai kebutuhan, lalu restart bot.
// =============================================
module.exports = {
  // Nomor WA ADMIN / OWNER (boleh format 08xx / 62xx)
  owner: ['081280843039'],

  // Nomor WA yang dipakai BOT (nomor lain, bukan nomor admin).
  // Boleh dikosongkan -> nanti ditanya saat pertama kali login.
  botNumber: '',

  // Nama toko (bisa diubah juga lewat perintah .settoko)
  storeName: 'MASS.ID STORE',

  // Awalan perintah admin. Contoh: .addlist  /addlist  #addlist  !addlist
  prefixes: ['.', '/', '#', '!'],

  // Zona waktu untuk salam (Pagi/Siang/Sore/Malam) & tanggal transaksi
  timezone: 'Asia/Jakarta',

  // Kirim pesan "Bot aktif" ke admin saat bot tersambung (maks. 1x per 6 jam)
  notifyOwnerOnConnect: true,

  // ===== ANTI BLOKIR / ANTI SPAM WHATSAPP =====
  // Jeda minimal (detik) antar balasan ke orang yang sama
  cooldownSeconds: 5,
  // Bot "mengetik..." dulu selama sekian detik (acak) sebelum membalas, biar mirip manusia
  typingDelaySeconds: [1.5, 3.5],
  // Jeda minimal antar pesan keluar (detik), untuk semua chat
  minGapSeconds: 1.5,
  // Maksimal pesan keluar per menit (kalau lebih, pesan antre)
  maxRepliesPerMinute: 15,
  // Di grup: kalau balasan yang sama (mis. menu) baru dikirim, jangan kirim lagi dalam sekian detik
  sameReplyInGroupSeconds: 30,
  // Abaikan pesan yang umurnya lebih dari sekian detik (mis. pesan numpuk saat bot offline)
  ignoreOlderThanSeconds: 120,

  // Di chat pribadi: berapa jam sekali bot boleh membalas pesan
  // yang tidak dikenal dengan petunjuk "ketik menu"
  autoReplyEveryHours: 6,

  // Pengingat ke admin (berapa jam sekali) jika pesanan belum selesai (belum mendapat perintah d)
  orderReminderHours: 1,

  // ===== WEB DASHBOARD (khusus admin: .web on / .web off) =====
  // Port web lokal (kalau dipakai aplikasi lain, otomatis pakai port berikutnya)
  webPort: 3000,
  // Web mati otomatis setelah sekian menit (bisa juga: .web on 120)
  webAutoOffMinutes: 60,
  // Buat link online gratis lewat Cloudflare (bisa dibuka dari HP/jaringan mana pun)
  webTunnel: true,

  // ===== STIKER (fitur gratis untuk pembeli) =====
  // Jatah bikin stiker per orang per hari (bisa diubah lewat .limitstiker atau web)
  stickerDailyLimit: 5,

  // ===== SINKRONISASI BOT TELEGRAM & UNTUNG RESELLER =====
  // Username bot Telegram sumber produk (tanpa @)
  tgBotUsername: 'FebrianStore1_Bot',
  // Untung reseller per produk (Rupiah) — otomatis ditambahkan ke harga modal dari bot Telegram
  syncMarkup: 5000,
  // Aktifkan sinkronisasi otomatis berkala (true = otomatis jalan sesuai jam di bawah, false = hanya manual saat klik tombol / .sync)
  tgAutoSyncEnabled: true,
  // Sinkron otomatis setiap berapa jam sekali (mis. 6 = setiap 6 jam sekali)
  tgAutoSyncHours: 6,

  // ===== KECERDASAN BUATAN (GOOGLE GEMINI AI) =====
  // Otomatis menganalisis pesan produk Telegram yang rumit/ngaco agar rapi & bersih
  // Dapatkan gratis di: https://aistudio.google.com/app/apikey
  geminiApiKey: '',

  // ===== HARGA TAMBAHAN KHUSUS LUAR GRUP (OPSIONAL) =====
  // Isi 0 jika harga di grup & luar grup sama (karena sudah ditambah syncMarkup Rp 5.000 di atas).
  privateMarkup: 0
}
