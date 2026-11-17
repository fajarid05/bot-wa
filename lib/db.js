const fs = require('fs')
const path = require('path')

const OLD_MENU_V1 = `{salam} @user
Di bawah ini adalah list Store
*{toko}*

Untuk melihat List
Ketik *Tulisan* di bawah ini
━━━━━━ *LIST STORE* ━━━━━━

{list}`

const OLD_MENU_V2 = `Selamat {salam} kak @user 👋
Selamat datang di *{toko}* 🛍️

Ketik *nama produk* di bawah untuk
melihat harga & detailnya 👇

╭───「 *LIST PRODUK* 」───
{list}
╰─────── {total} produk ───

💳 Ketik *bayar* » metode pembayaran
📋 Ketik *cara order* » panduan order
📞 Ketik *owner* » hubungi admin`

const OLD_MENU_V3 = `*LIST PRODUK {toko}* 🛍️

{list}

Ketik *nama produk* di atas untuk lihat harga & detail
Ketik *bayar* untuk pembayaran`

const OLD_MENU_V5 = `Selamat {salam} kak @user 👋
Selamat datang di *{toko}* 🛍️

Ketik *nama produk* atau *nomor urut* di bawah
untuk melihat harga & detailnya 👇

╭───「 *LIST PRODUK* 」───
{list}
╰─────── {total} produk ───

📦 Ketik *stok* » lihat produk ready & harga
💳 Ketik *bayar* » metode pembayaran (QRIS)
📋 Ketik *cara order* » panduan pembelian
📞 Ketik *owner* » hubungi admin`

const DEFAULT_MENU_V6 = `Selamat {salam} kak @user 👋
Selamat datang di *{toko}* 🛍️

Ketik *nama produk* di bawah untuk
melihat harga & detailnya 👇

╭───「 *LIST PRODUK* 」───
{list}
╰─────── {total} produk ───

📦 Ketik *stok* » lihat produk ready & harga
💳 Ketik *bayar* » metode pembayaran (QRIS)
📋 Ketik *cara order* » panduan pembelian
📞 Ketik *owner* » hubungi admin`

const DEFAULT_MENU = DEFAULT_MENU_V6

const DEFAULT_FOOTER = `━━━━━━━━━━━━━━━
🛒 *Cara Order Cepat:*
1️⃣ Ketik *bayar* untuk melihat QRIS pembayaran
2️⃣ Kirim *screenshot bukti bayar* dengan caption:
   *.beli <nama produk>*  _(contoh: .beli canva)_`

const MENU_VERSION = 6

const DEFAULT_PROSES = `「 *TRANSAKSI PENDING* 」

📆 Tanggal : {tanggal}
⏰ Jam : {jam} WIB
✨ Status : Pending

Pesanan @user sedang diproses, mohon ditunggu ya kak 🙏`

const DEFAULT_DONE = `「 *TRANSAKSI BERHASIL* 」

📆 Tanggal : {tanggal}
⏰ Jam : {jam} WIB
✨ Status : Berhasil

Terima kasih @user sudah order di *{toko}* 🙏
Ditunggu next order-nya ya kak!`

const DEFAULT_WELCOME = `Halo @user, selamat datang di *{grup}* 👋

Ketik *menu* untuk melihat produk yang dijual di *{toko}*.`

const DEFAULT_AUTOREPLY = `Halo kak 👋 ini bot otomatis *{toko}*.

Ketik *menu* untuk melihat daftar produk & harga.
Ketik *bayar* untuk melihat metode pembayaran.
Ketik *owner* untuk menghubungi admin.`

// bagian "fitur tambahan" yang tampil di bawah menu produk ({limit} = jatah per hari)
const DEFAULT_STICKER_MENU = `╭───「 *FITUR GRATIS* 」───
│ 🎨 *Bikin Stiker WA*
│ Kirim gambar / video (maks 10 dtk)
│ dengan caption *sticker*
│ _(maks {limit}x per hari)_
╰──────────────────`

function normKey (s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Singkatan & kata kunci populer yang sering diketik pembeli di WhatsApp
const PRODUCT_ALIASES = {
  'yt': 'youtube',
  'ytb': 'youtube',
  'yt prem': 'youtube',
  'youtube prem': 'youtube',
  'youtube music': 'youtube',
  'nf': 'netflix',
  'netflik': 'netflix',
  'netflx': 'netflix',
  'spoti': 'spotify',
  'spotifi': 'spotify',
  'spotfy': 'spotify',
  'cc': 'capcut',
  'cap cut': 'capcut',
  'capcut pro': 'capcut',
  'am': 'alight motion',
  'alight': 'alight motion',
  'alightmotion': 'alight motion',
  'gpt': 'chatgpt',
  'chat gpt': 'chatgpt',
  'openai': 'chatgpt',
  'ai chatgpt': 'chatgpt',
  'canva pro': 'canva',
  'canva edu': 'canva',
  'canva premium': 'canva',
  'disney': 'disney+',
  'disney plus': 'disney+',
  'disney hotstar': 'disney+',
  'hotstar': 'disney+',
  'prime': 'amazon prime',
  'amazon': 'amazon prime',
  'prime video': 'amazon prime',
  'office': 'office 365',
  'ms office': 'office 365',
  'microsoft office': 'office 365',
  'microsoft 365': 'office 365',
  'bein': 'vision+',
  'bein sport': 'vision+',
  'beinsports': 'vision+',
  'vision': 'vision+',
  'vision plus': 'vision+',
  'express': 'express vpn',
  'expressvpn': 'express vpn',
  'vpn express': 'express vpn',
  'surfshark vpn': 'surfshark',
  'vpn surfshark': 'surfshark',
  'hma': 'hma vpn',
  'avira': 'avira vpn',
  'hbo': 'hbo max',
  'hbomax': 'hbo max',
  'crunchy': 'crunchyroll',
  'crunchyrol': 'crunchyroll',
  'duolinggo': 'duolingo',
  'duo lingo': 'duolingo',
  'lok lok': 'loklok',
  'we tv': 'wetv',
  'zoom meeting': 'zoom',
  'zoom pro': 'zoom',
  'google gemini': 'gemini',
  'gemini ai': 'gemini',
  'gemini pro': 'gemini',
  'qris': 'bayar',
  'payment': 'bayar',
  'pembayaran': 'bayar',
  'rekening': 'bayar',
  'order': 'cara order',
  'panduan': 'cara order',
  'cara beli': 'cara order'
}

function editDistance (a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const v0 = new Array(b.length + 1)
  const v1 = new Array(b.length + 1)
  for (let i = 0; i <= b.length; i++) v0[i] = i
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost)
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j]
  }
  return v0[b.length]
}

function defaults (config) {
  const now = Date.now()
  return {
    settings: {
      storeName: config.storeName || 'MASS.ID STORE',
      menuTemplate: DEFAULT_MENU,
      menuVersion: MENU_VERSION,
      itemFooter: DEFAULT_FOOTER,
      prosesText: DEFAULT_PROSES,
      doneText: DEFAULT_DONE,
      defaultWelcome: DEFAULT_WELCOME,
      autoReply: true,
      autoReplyText: DEFAULT_AUTOREPLY,
      stickerEnabled: true,
      stickerLimit: config.stickerDailyLimit ?? 5,
      stickerPack: '',
      stickerAuthor: '',
      stickerMenuText: DEFAULT_STICKER_MENU,
      tgBotUsername: config.tgBotUsername || 'FebrianStore1_Bot',
      syncMarkup: config.syncMarkup ?? 5000,
      tgAutoSyncEnabled: config.tgAutoSyncEnabled !== undefined ? !!config.tgAutoSyncEnabled : Number(config.tgAutoSyncHours ?? 6) > 0,
      tgAutoSyncHours: config.tgAutoSyncHours ?? 6,
      privateMarkup: config.privateMarkup ?? 0
    },
    admins: [], // nomor tambahan (digit saja)
    adminIds: [], // id lain (mis. xxx@lid) milik admin
    list: {
      'bayar': {
        name: 'BAYAR',
        text: `*Metode Pembayaran:*

QRIS : scan gambar QRIS di atas

Silakan lakukan pembayaran.
Setelah bayar, kirim *screenshot bukti pembayaran* dengan caption:
*.beli <barang yang dibeli & detail pesanan>*
Contoh: *.beli canva*

_(Admin: ubah teks & gambar ini dengan perintah .setbayar)_`,
        image: null,
        updatedAt: now
      },
      'cara order': {
        name: 'CARA ORDER',
        text: `*Cara Order di {toko}:*

1. Ketik *menu* untuk melihat list produk
2. Ketik *nama produk* untuk melihat harga & detail
3. Ketik *bayar* lalu lakukan pembayaran
4. Kirim *screenshot bukti pembayaran* dengan caption:
   *.beli <barang yang dibeli & pesanan>*
   Contoh: *.beli canva*
5. Bot otomatis membuat *Resi Pesanan* & meneruskan ke Admin
6. Tunggu Admin memproses & mengirim pesanan kakak lewat bot 🙏`,
        image: null,
        updatedAt: now
      }
    },
    chats: {}, // jid -> { botOff, welcome, welcomeText }
    lidMap: {}, // xxx@lid -> 628xxx@s.whatsapp.net
    orders: {}, // id -> data pesanan
    orderSeq: 0
  }
}

class DB {
  constructor (file, config) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const base = defaults(config)
    let data = base
    this._loadedMenuVersion = MENU_VERSION
    if (fs.existsSync(file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
        this._loadedMenuVersion = loaded.settings?.menuVersion || 1
        data = {
          ...base,
          ...loaded,
          settings: { ...base.settings, ...(loaded.settings || {}) },
          list: loaded.list || base.list,
          chats: loaded.chats || {},
          lidMap: loaded.lidMap || {},
          orders: loaded.orders || {},
          orderSeq: Number(loaded.orderSeq || 0)
        }
      } catch (e) {
        const bak = file + '.rusak-' + Date.now()
        fs.copyFileSync(file, bak)
        console.error('[DB] database rusak, disalin ke', bak, '- memakai database baru')
      }
    }
    // pembaruan tampilan menu: ganti menu lama bawaan (kalau belum diubah admin)
    const st = data.settings
    if ((this._loadedMenuVersion || 1) < MENU_VERSION) {
      if (!st.menuTemplate || [OLD_MENU_V1, OLD_MENU_V2, OLD_MENU_V3, OLD_MENU_V5].includes(st.menuTemplate)) st.menuTemplate = DEFAULT_MENU
      st.menuVersion = MENU_VERSION
    }
    if (st.tgAutoSyncEnabled === undefined) {
      st.tgAutoSyncEnabled = Number(st.tgAutoSyncHours ?? config.tgAutoSyncHours ?? 6) > 0
    }
    // Pastikan selisih luar grup tidak menumpuk dobel (+5000 + 5000 = +10000) bagi database versi lama
    if (!st.singleMarkupV1) {
      if (!st.privateMarkupCustom) st.privateMarkup = Number(config.privateMarkup ?? 0)
      st.singleMarkupV1 = true
    }
    this.data = data
    this.save()
  }

  save () {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  // ---------- list produk ----------
  productEntries () {
    return Object.entries(this.data.list || {})
      .filter(([k]) => !['bayar', 'cara order'].includes(k))
      .map(([key, item]) => ({ key, ...item }))
      .sort((a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key), 'id'))
  }

  findItem (name, opts = {}) {
    const raw = normKey(name)
    if (!raw) return null
    const k = PRODUCT_ALIASES[raw] || raw
    if (this.data.list[k]) return { key: k, ...this.data.list[k] }
    if (this.data.list[raw]) return { key: raw, ...this.data.list[raw] }

    // Pilih berdasarkan nomor urut di menu (mis. ketik "1", "2", "15")
    if (opts.allowNumber && /^\d{1,3}$/.test(raw)) {
      const idx = Number(raw) - 1
      const prods = this.productEntries()
      if (idx >= 0 && idx < prods.length) return prods[idx]
    }

    const compact = k.replace(/ /g, '')
    for (const [key, item] of Object.entries(this.data.list)) {
      if (key.replace(/ /g, '') === compact) return { key, ...item }
    }
    // cocokkan tanpa simbol, mis. "disney" -> "disney+", "vision" -> "vision+"
    const alnum = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const a = alnum(k)
    if (a.length >= 2) {
      for (const [key, item] of Object.entries(this.data.list)) {
        if (alnum(key) === a || (item.title && alnum(item.title) === a)) return { key, ...item }
      }
    }
    // cocokkan awalan kata / typo tipis (jika allowFuzzy aktif)
    if (opts.allowFuzzy && a.length >= 3) {
      const prods = this.productEntries()
      // 1. Jika hanya 1 produk yang diawali / mengandung kata tersebut
      const starts = prods.filter(p => alnum(p.key).startsWith(a) || alnum(p.title).startsWith(a))
      if (starts.length === 1) return starts[0]
      const contains = prods.filter(p => alnum(p.key).includes(a) || alnum(p.title).includes(a))
      if (contains.length === 1) return contains[0]
      // 2. Typo jarak edit <= 1 (untuk kata >= 4 huruf) atau <= 2 (untuk kata >= 7 huruf)
      if (a.length >= 4) {
        const maxDist = a.length >= 7 ? 2 : 1
        let best = null
        let bestDist = 99
        for (const p of prods) {
          const pk = alnum(p.key)
          const d = editDistance(a, pk)
          if (d <= maxDist && d < bestDist) {
            best = p
            bestDist = d
          }
        }
        if (best) return best
      }
    }
    return null
  }

  // Cari beberapa produk yang mirip/cocok untuk saran ke pembeli atau fitur .cari
  searchItems (query) {
    const q = normKey(query)
    if (!q || q.length < 2) return []
    const aliased = PRODUCT_ALIASES[q] || q
    const alnum = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const aq = alnum(aliased)
    const words = q.split(/\s+/).filter(w => w.length >= 2)
    const scored = []
    for (const p of this.productEntries()) {
      const pk = alnum(p.key)
      const pt = alnum(p.title)
      const descStr = (p.desc || []).join(' ').toLowerCase()
      const typesStr = (p.types || []).map(t => t.name || '').join(' ').toLowerCase()
      let score = 0
      if (pk === aq || pt === aq) score = 100
      else if (pk.startsWith(aq) || pt.startsWith(aq)) score = 85
      else if (pk.includes(aq) || pt.includes(aq) || aq.includes(pk)) score = 70
      else if (words.some(w => p.key.includes(w) || String(p.title || '').toLowerCase().includes(w))) score = 60
      else if (aq.length >= 4 && editDistance(aq, pk) <= (aq.length >= 6 ? 2 : 1)) score = 55
      else if (words.some(w => typesStr.includes(w) || descStr.includes(w))) score = 40
      if (score > 0) scored.push({ item: p, score })
    }
    return scored.sort((a, b) => b.score - a.score).map(x => x.item).slice(0, 6)
  }

  setItem (name, patch) {
    const k = normKey(name)
    const old = this.data.list[k] || { name: String(name).trim().toUpperCase(), text: '', image: null }
    this.data.list[k] = { ...old, ...patch, updatedAt: Date.now() }
    this.save()
    return this.data.list[k]
  }

  deleteItem (name) {
    const found = this.findItem(name)
    if (!found) return null
    delete this.data.list[found.key]
    this.save()
    return found
  }

  listNames () {
    return Object.values(this.data.list)
      .map(i => i.name)
      .sort((a, b) => a.localeCompare(b, 'id'))
  }

  // ---------- pengaturan per chat ----------
  chat (jid) {
    if (!this.data.chats[jid]) this.data.chats[jid] = {}
    return this.data.chats[jid]
  }
}

module.exports = { DB, normKey, DEFAULT_MENU, DEFAULT_FOOTER, DEFAULT_PROSES, DEFAULT_DONE, DEFAULT_WELCOME, DEFAULT_AUTOREPLY, DEFAULT_STICKER_MENU }
