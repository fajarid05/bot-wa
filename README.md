# 🤖 Bot WhatsApp List Store — MASS.ID STORE

Bot auto-respon untuk grup & chat pribadi:

- Pembeli ketik **menu** → muncul LIST STORE (dengan salam Pagi/Siang/Sore/Malam + tag)
- Pembeli ketik **nama produk** (mis. `capcut`) → bot balas harga & keterangan
- Pembeli ketik **bayar** → bot kirim gambar QRIS + metode pembayaran + petunjuk perintah `.beli`
- Pembeli kirim **screenshot bukti pembayaran** dengan caption **`.beli <nama produk & detail pesanan>`** (mis. `.beli canva` atau `.beli canva email@gmail.com`) → bot otomatis membuat **Resi Pesanan** (`#ORD-001`) untuk pembeli dan **meneruskan bukti bayar + pesanan ke Admin** (berlaku di grup maupun di luar grup)
- Admin memproses pesanan lewat bot:
  - Reply pesanan dengan **`p`** (atau `.p`) → status jadi **Sedang Diproses** & resi pembeli diperbarui
  - Reply pesanan dengan **`d <isi pesanan/akun>`** (atau `.d <isi pesanan>`) → bot **mengirimkan pesanan + Resi Selesai** ke pembeli & menandai pesanan **Done (Selesai)**
  - Jika dalam **1 jam** pesanan belum ditandai **`d` (Done)** oleh Admin, bot otomatis mengirim **pengingat setiap 1 jam sekali** ke Admin sampai pesanan selesai (`d`)
- Pembeli ketik **owner** → bot kirim kontak admin (wa.me/6281280843039)
- Chat pribadi yang tidak dikenali → dibalas petunjuk "ketik menu" (maks. 1x per 6 jam per orang)
- **🎨 Pembuat Stiker WA Gratis** → tampil sebagai fitur pemanis di bawah menu produk. Pembeli cukup kirim gambar/video (maks 10 dtk) dengan caption **`sticker`** (dibatasi **5x per orang per hari** agar tidak spam; Admin bebas tanpa batas)
- **🔄 Sinkronisasi Otomatis Telegram & Untung Reseller** → menyinkronkan produk, harga modal, dan varian secara otomatis (atau manual via tombol Web Dashboard & chat WA) lengkap dengan tambahan untung reseller otomatis.
- **📦 Manajemen Stok Fleksibel** → bisa mengatur stok sendiri, menambah stok dari bot lain (`.setstok`, `.tambahstok`, `.habis`, `.ready`), atau mempertahankan stok manual agar tidak tertimpa sinkronisasi bot pusat.
- **🛡️ Manajemen Grup (Khusus Admin)** → perintah **`.kick`** untuk mengeluarkan member yang melanggar & **`.add`** untuk menambahkan member baru ke grup.
- **🌐 Web Dashboard (On-Demand + Cloudflare Tunnel Gratis)** → semua produk, harga, gambar, pembayaran, dan pengaturan bisa diatur lewat **Prompt WA** maupun lewat **Web Browser** (HP/PC beda jaringan sekalipun). Web **mati secara default** dan hanya menyala saat Admin mengetik **`.web on`** di WA (lengkap dengan PIN sekali pakai) dan bisa dimatikan kapan saja dengan **`.web off`**

Admin/owner: **081280843039** (sudah diisi di `config.js`).
Bot memakai **nomor lain** yang ditautkan sebagai "perangkat tertaut".

---

## 1. Pasang di TERMUX (Android)

> Pakai Termux dari **F-Droid / GitHub**, bukan Play Store (versi Play Store sudah usang).

```bash
pkg update && pkg upgrade -y
pkg install nodejs-lts git ffmpeg cloudflared -y
termux-setup-storage
```
*(Keterangan: `ffmpeg` dipakai untuk fitur pembuat stiker, dan `cloudflared` dipakai untuk membuat link Web Dashboard online gratis).*

Salin folder bot ke HP (mis. ke `Download`), lalu:

```bash
cp -r /sdcard/Download/massid-wa-bot ~/
cd ~/massid-wa-bot
npm install
npm start
```

Masukkan nomor bot → muncul **KODE PAIRING** → lanjut ke bagian *Login* di bawah.

Supaya tetap jalan 24 jam di Termux:
```bash
termux-wake-lock          # cegah Termux ditidurkan
bash start.sh             # bot auto-restart kalau mati
```
Matikan juga **optimasi baterai** untuk Termux di Setelan HP (Aplikasi > Termux > Baterai > Tidak dibatasi).

## 2. Pasang di VPS (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
cd massid-wa-bot
npm install
npm start                 # login pertama (masukkan nomor, pakai kode pairing)
```

Setelah tersambung, tekan `Ctrl+C`, lalu jalankan 24 jam dengan **pm2**:

```bash
sudo npm install -g pm2
pm2 start index.js --name botwa
pm2 save
pm2 startup               # ikuti perintah yang muncul, agar bot nyala lagi setelah VPS reboot
pm2 logs botwa            # lihat log
```

## 3. Pasang di RDP (Windows)

1. Install **Node.js LTS** (nodejs.org) dan **Git** (git-scm.com) — keduanya wajib.
2. Buka folder bot, klik kanan di ruang kosong > *Open in Terminal* (atau CMD), lalu:
   ```
   npm install
   npm start
   ```
3. Setelah login berhasil, tutup jendela dan jalankan **`start.bat`** (klik 2x). Bot auto-restart kalau mati.
4. Agar jalan otomatis saat RDP restart: tekan `Win+R` → `shell:startup` → taruh *shortcut* `start.bat` di situ.

---

## 🔑 Login (kode pairing)

1. Jalankan `npm start`, masukkan nomor **bot** (contoh `08123456789`).
2. Muncul kode seperti `ABCD-EFGH`.
3. Di HP nomor bot: WhatsApp → ⋮ → **Perangkat tertaut** → **Tautkan perangkat** →
   **Tautkan dengan nomor telepon saja** → masukkan kode.
4. Terminal menulis `Bot tersambung`, dan nomor admin menerima pesan "Bot aktif".

Kalau kode pairing gagal, pakai QR: `npm run qr` (scan dari HP nomor bot).
Login cukup sekali — sesi tersimpan di folder `session/`. Jangan jalankan bot dobel dengan sesi yang sama.

Setelah login: **masukkan nomor bot ke grup** kamu. Jadikan bot **admin grup** kalau ingin pakai `.open` / `.close`.

---

## 🛠️ Perintah Admin

Ketik di grup atau chat pribadi ke nomor bot (dari nomor admin). Ketik **`.admin`** untuk melihat daftar ini di WA.

| Perintah | Fungsi |
|---|---|
| `.addlist kode` | Tambah produk lewat **tanya-jawab** (judul → jenis & harga → keterangan → note → gambar) |
| `.setjudul kode\|JUDUL` | Ganti judul produk |
| `.addlist nama\|jenis=harga; ...\|keterangan\|note` | Tambah produk **cepat** dalam 1 pesan |
| `.updatelist nama` | Isi ulang produk lewat tanya-jawab |
| `.setharga nama\|jenis=harga; ...` | Ganti semua jenis & harga |
| `.addjenis nama\|jenis=harga` | Tambah / ubah 1 jenis |
| `.deljenis nama\|nomor` | Hapus 1 jenis |
| `.setket nama\|ket1; ket2` | Ganti keterangan (`-` hapus) |
| `.setnote nama\|teks` | Ganti note (`-` hapus) |
| `.setgambar nama` | Ganti gambar (kirim/reply gambar) |
| `.delgambar nama` | Hapus gambar produk |
| `.dellist nama` | Hapus produk |
| `.renamelist lama\|baru` | Ganti nama produk |
| `.getlist nama` | Salin data produk (tinggal edit & kirim lagi) |
| `.addlistraw nama\|teks` | Produk teks bebas, tanpa format otomatis |
| `.batal` | Batalkan tanya-jawab |
| `.setfooter teks` | Teks di bawah tiap produk (`off` hilangkan, `reset` bawaan) |
| `.setbayar teks` | Atur pesan BAYAR. **Kirim bersama gambar QRIS** (atau reply gambar QRIS) |
| `.settoko nama` | Ganti nama toko |
| `.setmenu teks` / `.resetmenu` | Ubah / kembalikan teks menu |
| `.setproses teks` / `.setdone teks` | Ubah teks transaksi |
| `.setauto teks` / `.autoreply on/off` | Balasan otomatis chat pribadi |
| `p` / `.p` (reply pesanan / `.p ORD-001`) | Tandai pesanan **sedang diproses** & kirim update resi ke pembeli |
| `d <isi pesanan>` / `.d <isi pesanan>` (reply pesanan / `.d ORD-001 <isi>`) | **Kirim pesanan ke pembeli** + kirim **Resi Selesai** + hentikan pengingat 1 jam |
| `d` / `.d` (reply pesanan / `.d ORD-001`) | Tandai pesanan **selesai (Done)** & kirim Resi Selesai |
| `.kirim <isi pesanan>` | Kirim detail pesanan/akun ke pembeli & tandai selesai |
| `.pesanan` / `.listorder` | Lihat daftar pesanan yang belum selesai (`pending` / `diproses`) |
| `.cekorder ORD-001` | Lihat detail pesanan & foto bukti pembayaran |
| `.batalorder ORD-001\|alasan` | Batalkan pesanan & hentikan pengingat 1 jam |
| `.setstok nama\|jumlah` | Atur stok produk (mis. `.setstok netflix 20` atau per jenis `.setstok netflix\|1=10; 2=5`) |
| `.tambahstok nama\|jumlah` | Tambah (+) stok produk dari bot lain (mis. `.tambahstok canva 15`) |
| `.habis nama` | Tandai produk sedang habis (stok = `0`) |
| `.ready nama [jumlah]` | Tandai produk tersedia kembali |
| `.kuncistok nama` | Kunci/buka stok agar tidak tertimpa sinkron otomatis bot pusat |
| `.sync` / `.sync stok` | Sinkronisasi produk, harga & stok dari bot Telegram (`.sync stok` untuk mode cepat ±15 dtk) |
| `.stopsync` | Hentikan proses sinkronisasi yang sedang berjalan |
| `.autosync on [jam] / off` | Aktifkan/matikan jadwal sinkronisasi otomatis |
| `.setuntung 5000` | Atur untung reseller otomatis per produk (otomatis dihitung ke harga jual) |
| `.kick @member` / reply | **Keluarkan member** dari grup (khusus admin grup) |
| `.add 0812xxxx` / reply | **Tambahkan member** ke grup (khusus admin grup) |
| `.open` / `.close` | Buka / tutup grup |
| `.h teks` | Hidetag (tag semua member) |
| `.welcome on/off` / `.setwelcome teks` | Sambutan member baru |
| `.bot on/off` | Nyalakan / matikan bot di chat itu |
| `.addadmin 08xx` / `.deladmin 08xx` / `.listadmin` | Kelola admin tambahan (khusus owner) |
| `.backup` | Kirim file database |
| `.status` | Info bot |
| `.myid` | Lihat ID WA (kalau perintah admin tidak jalan di grup) |
| `.web on` | **Nyalakan Web Dashboard** + buat link Cloudflare gratis & PIN login (dikirim ke chat pribadi Admin) |
| `.web on 120` | Nyalakan Web Dashboard selama 120 menit |
| `.web off` | **Matikan Web Dashboard** & tutup link publik |
| `.web status` | Cek status Web Dashboard, link aktif & sisa waktu |
| `.sticker on/off` | Nyalakan / matikan fitur pembuat stiker WA |
| `.limitstiker 5` | Ubah batas harian bikin stiker per orang (default: `5`) |

Awalan `.` bisa diganti `/`, `#`, atau `!`.

### Cara tambah produk

Satu produk bisa punya **banyak jenis** (misal durasi berbeda), masing-masing dengan harganya.

Setiap produk punya **kode** (misal `youtube`) dan **judul** (misal `YOUTUBE PREMIUM`).
Kode = yang tampil di menu & diketik pembeli. Judul = yang tampil paling atas di detail produk.

Waktu pembeli ketik `menu`:
```
Selamat Sore kak @pembeli 👋
Selamat datang di MASS.ID STORE 🛍️

Ketik nama produk di bawah untuk
melihat harga & detailnya 👇

╭───「 LIST PRODUK 」───
│ ✦ gemini
│ ✦ youtube
╰─────── 2 produk ───

💳 Ketik bayar » metode pembayaran
📋 Ketik cara order » panduan order
📞 Ketik owner » hubungi admin
```

**1. Tanya-jawab (paling gampang)** — ketik `.addlist youtube`, lalu bot bertanya 5 hal:

1. **Judul** → `YOUTUBE PREMIUM` (atau `-` untuk pakai kode)
2. **Jenis & harga** (1 baris 1 jenis):
   ```
   1 Bulan = 15000
   3 Bulan = 40000
   Jaspay 1 Bulan = 5000
   Jaspay 3 Bulan = 30000
   ```
   Kalau cuma 1 jenis, cukup kirim harganya: `35000`
3. **Keterangan** (1 baris 1 poin) → atau `-`
4. **Note** (boleh beberapa baris) → atau `-`
5. **Gambar** → kirim foto, atau `-`

Waktu pembeli ketik `youtube`:
```
「 YOUTUBE PREMIUM 」

📦 Pilih Jenis :
1. 1 Bulan » Rp 15.000
2. 3 Bulan » Rp 40.000
3. Jaspay 1 Bulan » Rp 5.000
4. Jaspay 3 Bulan » Rp 30.000

📝 Keterangan :
✅ 1 Bulan = 15000 akun seller
...

📌 Note :
1 Bulan = Garansi 1x
...
```
Ganti judul kapan saja: `.setjudul youtube|YOUTUBE PREMIUM`

**2. Cara cepat (1 pesan)** — urutan `nama|jenis=harga; jenis=harga|keterangan|note`
```
.addlist gemini|1 Bulan=10000; 3 Bulan=25000; 18 Bulan=50000|Akun pribadi; Garansi full|-
.addlist express vpn|35000
```

**Ubah jenis / harga**
- Tambah 1 jenis: `.addjenis gemini|6 Bulan=35000`
- Hapus jenis ke-2: `.deljenis gemini|2`
- Ganti semua harga: `.setharga gemini|1 Bulan=12000; 3 Bulan=28000`
- Ganti keterangan: `.setket gemini|Garansi full; Akun pribadi`
- Ganti note: `.setnote gemini|Proses cepat` (`-` untuk hapus)

### Kode yang bisa dipakai di teks
`{salam}` Pagi/Siang/Sore/Malam · `@user` tag orangnya · `{toko}` nama toko · `{list}` daftar produk (khusus menu) · `{grup}` nama grup (welcome) · `{tanggal}` `{jam}` (proses/done)

---

## ♾️ Agar bot ON terus 24 jam

**Yang sudah otomatis:**
- Internet putus → bot menyambung ulang sendiri terus-menerus sampai online lagi.
- Bot crash / error → `start.bat`, `start.sh`, atau autostart menyalakannya lagi dalam 5 detik.
- Setiap bot tersambung lagi, nomor admin dapat pesan *"Bot aktif"*.

### RDP Windows — nyala sendiri waktu RDP restart
1. Pastikan bot sudah login (`npm start` sampai tersambung), lalu tutup jendelanya.
2. Klik kanan **`autostart-windows.bat`** → **Run as administrator**.
3. Selesai. Bot jalan di background, nyala sendiri tiap Windows restart walaupun belum login RDP.

| File | Fungsi |
|---|---|
| `lihat-log.bat` | Lihat aktivitas bot (menutup jendela ini tidak mematikan bot) |
| `restart-bot.bat` | Restart bot (pakai setelah update file bot) |
| `hapus-autostart-windows.bat` | Matikan autostart (Run as administrator) |

Selama autostart aktif, **jangan jalankan `start.bat`** (bot akan menolak jalan dobel).
Menutup jendela RDP (klik X / disconnect) aman. Yang mematikan bot hanya *Shut down* / matikan server.

### Termux (Android)
```bash
cd ~/massid-wa-bot
bash autostart-termux.sh
```
Lalu: install **Termux:Boot** (F-Droid) dan buka sekali, set baterai Termux & Termux:Boot ke **Tidak dibatasi**,
dan jangan swipe-close Termux dari daftar aplikasi terbaru. Log: `tail -f bot.log`.

### VPS Linux
Pakai pm2 (lihat bagian VPS di atas): `pm2 start index.js --name botwa && pm2 save && pm2 startup`.

### Yang di luar kendali bot
- **HP nomor bot**: buka WhatsApp di HP itu minimal 1x tiap ~2 minggu. Kalau lama tidak dibuka, WhatsApp bisa melepas perangkat tertaut, dan bot harus pairing ulang.
- **Nomor bot** harus tetap aktif (masa aktif kartu).
- **Server/RDP mati total** (listrik/provider) → bot nyala lagi sendiri begitu server hidup (kalau autostart sudah dipasang).

---

## 🛡️ Supaya nomor bot tidak dibatasi / diblokir WhatsApp

Bot sudah dibuat agar balasannya mirip manusia (atur di `config.js`):
- Muncul *"sedang mengetik..."* 1,5–3,5 detik sebelum membalas
- Jeda 5 detik untuk orang yang sama, jeda 1,5 detik antar pesan
- Maksimal 15 pesan keluar per menit (sisanya antre, tidak dibuang)
- Di grup, `menu`/produk yang sama tidak dikirim ulang dalam 30 detik
- Pesan lama yang numpuk saat bot offline tidak dibalas beruntun
- Pesan "Bot aktif" ke admin maksimal 1x per 6 jam

Yang harus dijaga sendiri:
- **Nomor baru jangan langsung dipakai ramai.** Pakai dulu seperti WA biasa beberapa hari (pasang foto profil & nama, chat dengan teman).
- **Jangan pakai `.h` (tag semua) terlalu sering**, apalagi di grup besar.
- **Jangan memasukkan bot ke banyak grup sekaligus.** Tambah pelan-pelan.
- Kalau muncul *"Saat ini akun Anda dibatasi"*: **jangan logout/pairing ulang**, biarkan bot tetap jalan
  (bot masih boleh *membalas* chat & grup), tunggu sampai waktu pembatasan habis.

---

## ❓ Masalah umum

- **Perintah admin tidak dibalas di grup** → ketik `.myid` di grup. Kalau ID-mu berakhiran `@lid`, minta owner reply pesanmu lalu ketik `.addadmin`, atau gunakan perintah lewat chat pribadi ke bot.
- **`npm install` gagal (git not found)** → install git dulu (`pkg install git` / `apt install git` / git-scm.com).
- **Bot logout sendiri** → jalankan `npm start` lagi untuk login ulang.
- **Data produk** tersimpan di `database/db.json`, gambar di `media/`. Backup kedua folder itu (atau pakai `.backup`) sebelum pindah server.

> ⚠️ Bot ini memakai WhatsApp Web tidak resmi (Baileys). Hindari kirim pesan massal / spam ke orang yang tidak dikenal agar nomor bot tidak diblokir WhatsApp.
