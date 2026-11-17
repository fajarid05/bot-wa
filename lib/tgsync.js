// =============================================
//  SINKRONISASI OTOMATIS PRODUK DARI BOT TELEGRAM
//  Target default: @FebrianStore1_Bot
//  - Login akun Telegram sekali saja (lewat Web Dashboard / perintah WA)
//  - Ambil daftar produk, varian, harga modal & stok dari bot Telegram
//  - Otomatis tambahkan untung reseller (default +Rp 5.000/produk)
//  - Bersihkan semua nama toko sumber / link Telegram agar pembeli tidak tahu reseller
//  - Harga/deskripsi/gambar yang sudah dikunci manual oleh Admin tetap aman
// =============================================
const fs = require('fs')
const path = require('path')
const { normKey } = require('./db')
const { INFO_KEYS } = require('./product')
const ai = require('./ai')

const SESSION_FILE = path.join(__dirname, '..', 'session', 'telegram.session')

// API ID & Hash bawaan aplikasi resmi Telegram Desktop (open-source), jadi admin tidak perlu daftar my.telegram.org
const DEFAULT_API_ID = 2040
const DEFAULT_API_HASH = 'b18441a1ff607e10a989891a5462e627'

// Pemetaan pintar nama produk dari @FebrianStore1_Bot -> kode pendek yang enak diketik pembeli di WA
const KNOWN_KEY_MAP = {
  'ai chatgpt': { key: 'chatgpt', title: 'CHATGPT AI' },
  'chatgpt': { key: 'chatgpt', title: 'CHATGPT AI' },
  'alight motion': { key: 'alight motion', title: 'ALIGHT MOTION' },
  'amazon prime': { key: 'amazon prime', title: 'AMAZON PRIME' },
  'apple music': { key: 'apple music', title: 'APPLE MUSIC' },
  'apple tv': { key: 'apple tv', title: 'APPLE TV' },
  'avira vpn': { key: 'avira vpn', title: 'AVIRA VPN' },
  'canva premium': { key: 'canva', title: 'CANVA PREMIUM' },
  'canva': { key: 'canva', title: 'CANVA EDU MEMBER' },
  'capcut pro': { key: 'capcut', title: 'CAPCUT PRO' },
  'capcut': { key: 'capcut', title: 'CAPCUT PRO' },
  'crunchyroll': { key: 'crunchyroll', title: 'CRUNCHYROLL PRIVATE' },
  'disney+': { key: 'disney+', title: 'DISNEY+ HOTSTAR' },
  'disney': { key: 'disney+', title: 'DISNEY+ HOTSTAR' },
  'duolingo': { key: 'duolingo', title: 'DUOLINGO SUPER' },
  'gemini': { key: 'gemini', title: 'GEMINI AI PRO' },
  'hbo max': { key: 'hbo max', title: 'HBO MAX' },
  'hma vpn': { key: 'hma vpn', title: 'HMA VPN' },
  'iqiyi': { key: 'iqiyi', title: 'IQIYI PREMIUM' },
  'loklok vip': { key: 'loklok', title: 'LOKLOK VIP' },
  'loklok': { key: 'loklok', title: 'LOKLOK VIP' },
  'meitu vip': { key: 'meitu', title: 'MEITU VIP' },
  'meitu': { key: 'meitu', title: 'MEITU VIP' },
  'microsoft office 365': { key: 'office 365', title: 'MICROSOFT OFFICE 365' },
  'microsoft office': { key: 'office 365', title: 'MICROSOFT OFFICE 365' },
  'muse ai': { key: 'muse', title: 'MUSE AI' },
  'muse': { key: 'muse', title: 'MUSE AI' },
  'netflix premium': { key: 'netflix', title: 'NETFLIX PREMIUM' },
  'netflix': { key: 'netflix', title: 'NETFLIX PREMIUM' },
  'picsart pro': { key: 'picsart', title: 'PICSART PRO' },
  'picsart': { key: 'picsart', title: 'PICSART PRO' },
  'scribd premium': { key: 'scribd', title: 'SCRIBD PREMIUM' },
  'scribd': { key: 'scribd', title: 'SCRIBD PREMIUM' },
  'spotify premium': { key: 'spotify', title: 'SPOTIFY PREMIUM' },
  'spotify': { key: 'spotify', title: 'SPOTIFY PREMIUM' },
  'vidio platinum': { key: 'vidio', title: 'VIDIO PLATINUM' },
  'vidio': { key: 'vidio', title: 'VIDIO PLATINUM' },
  'vision bein + sports': { key: 'vision+', title: 'VISION+ BEIN SPORTS' },
  'vision bein': { key: 'vision+', title: 'VISION+ BEIN SPORTS' },
  'viu premium': { key: 'viu', title: 'VIU PREMIUM' },
  'viu': { key: 'viu', title: 'VIU PREMIUM' },
  'vpn express': { key: 'express vpn', title: 'EXPRESS VPN' },
  'express vpn': { key: 'express vpn', title: 'EXPRESS VPN' },
  'vpn surfshark': { key: 'surfshark', title: 'SURFSHARK VPN' },
  'surfshark': { key: 'surfshark', title: 'SURFSHARK VPN' },
  'wetv premium': { key: 'wetv', title: 'WETV PREMIUM' },
  'wetv': { key: 'wetv', title: 'WETV PREMIUM' },
  'wink': { key: 'wink', title: 'WINK VIP' },
  'youtube premium': { key: 'youtube', title: 'YOUTUBE PREMIUM' },
  'youtube': { key: 'youtube', title: 'YOUTUBE PREMIUM' },
  'zoom meeting pro': { key: 'zoom', title: 'ZOOM MEETING PRO' },
  'zoom meeting': { key: 'zoom', title: 'ZOOM MEETING' }
}

const state = {
  client: null,
  pendingLogin: null, // { client, phone, phoneCodeHash, apiId, apiHash }
  syncing: false,
  syncMode: 'full',
  cancelRequested: false,
  progress: '',
  progressPct: 0,
  lastSyncAt: 0,
  lastSyncResult: null,
  lastError: '',
  autoTimer: null,
  nextAutoSyncAt: 0,
  onAutoSyncDone: null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function normPhone (s) {
  let d = String(s || '').replace(/\D/g, '')
  if (d.startsWith('0')) d = '62' + d.slice(1)
  else if (d.startsWith('8')) d = '62' + d
  return d ? '+' + d : ''
}

function hasSession () {
  try {
    return fs.existsSync(SESSION_FILE) && fs.readFileSync(SESSION_FILE, 'utf8').trim().length > 10
  } catch { return false }
}

function loadSessionString () {
  try {
    if (fs.existsSync(SESSION_FILE)) return fs.readFileSync(SESSION_FILE, 'utf8').trim()
  } catch {}
  return ''
}

function saveSessionString (str) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
  fs.writeFileSync(SESSION_FILE, String(str || '').trim(), 'utf8')
}

// ---------------- pembersih teks & pengurai harga ----------------

const LEADING_BULLET_RE = /^[•●∙◦▪▫‣⁃▸►▹✦✧◆◇❖*-]+\s*/

// Hapus karakter tak terlihat (zero-width space U+200B dll. yang sering dipakai bot Telegram) & rapikan spasi
function stripInvisible (s) {
  return String(s || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u115F\u1160\u180E\u2800\u3164\uFFA0]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
}

function cleanVariantLabel (raw, storeName = 'Toko Kami') {
  return sanitizeSupplierText(raw, storeName)
    .replace(/^[^\p{L}\p{N}([+]+/u, '')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s*[-:,]+\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Hapus semua jejak nama toko supplier / link telegram / pesan promosi supplier
function sanitizeSupplierText (raw, storeName = 'Toko Kami') {
  if (!raw) return ''
  return stripInvisible(raw)
    .split(/\r?\n/)
    .map(l => l.replace(/`/g, '').trim())
    .filter(l => {
      if (!l) return false
      if (/febrian|@\w+|t\.me\/|telegram|order manual|tanpa fee|tidak mau ada fee|berikan rating|halaman\s+\d+\s*(?:\/|dari)\s*\d+|terlalu cepat|current\s*date\s*:/i.test(l)) return false
      if (/^(📅|📄|💳|💰\s*saldo|saldo\s*:)/i.test(l)) return false
      return true
    })
    .map(l => l
      .replace(/febrian\s*store(\s*bot\s*auto\s*order)?/gi, storeName)
      .replace(/,?\s*beli\s+di\s+atas\s+\d+\s+akun\s+harga\s+turun\b/gi, '')
      .replace(/\bakun\s+seller\b/gi, 'Akun Admin')
      .replace(/\s*\(baca\s+desk(?:ripsi)?\)/gi, '')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/\s*,\s*,/g, ',')
      .replace(/^[\s,]+|[\s,]+$/g, '')
    )
    .filter(Boolean)
    .join('\n')
    .trim()
}

// Ubah "Rp 18,500" / "Rp. 1,500" / "700" / "500" / "18K" -> angka
function parseNominal (str) {
  if (!str) return 0
  const s = String(str).trim()
  const mk = s.match(/(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(k|rb|ribu)\b/i)
  if (mk) {
    const n = Math.round(parseFloat(mk[1].replace(',', '.')) * 1000)
    return n >= 100 ? n : 0
  }
  const mn = s.match(/(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{3,8})\b/i)
  if (mn) {
    const n = Number(mn[1].replace(/[.,]/g, ''))
    return n >= 100 && n <= 50000000 ? n : 0
  }
  return 0
}

// Pisahkan nama kategori Telegram menjadi { key, title, embeddedVariant }
// Contoh: "AVIRA VPN 3 BULAN" -> key: "avira vpn", title: "AVIRA VPN", embeddedVariant: "3 Bulan"
// Contoh: "Picsart Pro 7 Hari Private 100 Kredit" -> key: "picsart", title: "PICSART PRO", embeddedVariant: "7 Hari Private 100 Kredit"
function normalizeProductIdentity (rawName, existingList = {}) {
  const clean = stripInvisible(rawName)
    .replace(/^\[\d+\]\.?\s*/, '')
    .replace(/\(\s*\d+\s*\)\s*$/, '')
    .replace(/[╭╮╰╯┊│┃✦•●∙*]+/g, '')
    .trim()
  const lower = clean.toLowerCase().replace(/\s+/g, ' ')

  // 1. Cek apakah sudah ada persis di KNOWN_KEY_MAP
  if (KNOWN_KEY_MAP[lower]) {
    return { ...KNOWN_KEY_MAP[lower], embeddedVariant: '', rawTitle: clean.toUpperCase() }
  }

  // 2. Cek apakah bagian awalnya mengandung durasi (misal: "AVIRA VPN 3 BULAN", "CRUNCHYROLL PRIVATE 1BLN")
  const durMatch = clean.match(/^(.+?)\s+((?:private\s+|indplan\s+|sharing\s+|head\s+|member\s+)?\d+\s*(?:bulan|bln|hari|day|days|tahun|thn|minggu).*)$/i)
  let basePart = durMatch ? durMatch[1].trim() : clean
  let embeddedVariant = durMatch ? durMatch[2].trim() : ''
  const baseLower = basePart.toLowerCase().replace(/\s+/g, ' ')

  if (KNOWN_KEY_MAP[baseLower]) {
    return { ...KNOWN_KEY_MAP[baseLower], embeddedVariant, rawTitle: basePart.toUpperCase() }
  }

  // 3. Cek kecocokan awalan di KNOWN_KEY_MAP
  for (const [k, val] of Object.entries(KNOWN_KEY_MAP)) {
    if (lower.startsWith(k + ' ')) {
      const rest = clean.slice(k.length).trim()
      return { ...val, embeddedVariant: rest || embeddedVariant, rawTitle: val.title }
    }
  }

  // 4. Cek di database produk yang sudah ada
  for (const [k, item] of Object.entries(existingList)) {
    if (INFO_KEYS.includes(k)) continue
    const tLower = String(item.title || item.name || '').toLowerCase()
    if (k === lower || k === baseLower || (tLower && (tLower === lower || tLower === baseLower))) {
      return { key: k, title: item.title || item.name, embeddedVariant, rawTitle: clean.toUpperCase() }
    }
  }

  // 5. Buat key pendek baru (buang kata umum di belakang seperti PREMIUM / PRO / VIP jika lebih dari 1 kata)
  const shortKey = baseLower
    .replace(/\s+(premium|pro|vip|plus|super|platinum|ai)$/i, '')
    .trim() || baseLower

  return {
    key: normKey(shortKey),
    title: basePart.toUpperCase(),
    embeddedVariant,
    rawTitle: clean.toUpperCase()
  }
}

// Urai halaman LIST PRODUCT: "[1]. AI CHATGPT ( 17 )"
function parseCatalogList (text) {
  const items = []
  for (const line of stripInvisible(text).split(/\r?\n/)) {
    const m = line.match(/\[(\d+)\]\.?\s*(.+?)\s*\(\s*(\d+)\s*\)/)
    if (m) {
      items.push({
        num: Number(m[1]),
        rawName: stripInvisible(m[2]).trim(),
        stock: Number(m[3])
      })
    }
  }
  const pageMatch = stripInvisible(text).match(/Halaman\s+(\d+)\s*\/\s*(\d+)/i)
  return {
    items,
    page: pageMatch ? Number(pageMatch[1]) : 1,
    totalPages: pageMatch ? Number(pageMatch[2]) : 1
  }
}

// Pecah daftar keterangan berdasarkan koma/titik koma/baris baru di luar tanda kurung (...)
function splitDescClauses (str) {
  const out = []
  let cur = ''
  let depth = 0
  for (const ch of String(str || '')) {
    if (ch === '(') depth++
    else if (ch === ')' && depth > 0) depth--
    if ((ch === ',' || ch === '\n' || ch === ';') && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// Urai pesan detail produk dari bot Telegram (Format A: Multi-Varian & Format B: Single-Varian @FebrianStore1_Bot)
function parseProductDetail (text, buttons = [], fallbackName = '', fallbackVariant = '') {
  // 1. Buang karakter tak terlihat (U+200B dll.) dan garis pinggir kotak, lalu pecah bila ada beberapa bullet dalam 1 baris
  const expandedLines = []
  for (const l0 of stripInvisible(text).split(/\r?\n/)) {
    const cleanedLine = l0.replace(/^[╭╮╰╯┊│┃─━═\s]+|[╭╮╰╯┊│┃─━═\s]+$/g, '').trim()
    if (!cleanedLine) continue
    // Jika ada 2+ bullet di satu baris (mis. "• Var A: Rp. 3,000 - (73) • Var B: Rp. 9,000 - (16)"), pisah jadi baris sendiri
    const parts = cleanedLine.split(/\s+(?=[•●∙◦▪▫‣⁃▸►▹✦]\s*)/)
    for (const part of parts) {
      const p = part.trim()
      if (p) expandedLines.push(p)
    }
  }

  // 2. Gabungkan baris varian yang terpotong ke baris bawah HANYA jika baris sebelumnya belum punya nominal Rp (atau baris bawah cuma "(stok)")
  const mergedLines = []
  let inVarBlock = false
  for (const line of expandedLines) {
    if (/^variasi\s*,\s*harga/i.test(line)) {
      inVarBlock = true
      mergedLines.push(line)
      continue
    }
    if (/^(current\s*date|───|\[\s*🏷|harga\s*grosir)/i.test(line)) {
      inVarBlock = false
    }
    const isBullet = LEADING_BULLET_RE.test(line) || /^(?:\[\d+\]|\d+[.)])\s+/.test(line)
    const prev = mergedLines.length > 0 ? mergedLines[mergedLines.length - 1] : ''
    const prevIsHeader = /^variasi\s*,\s*harga/i.test(prev)
    const prevHasPrice = /rp\.?\s*\d/i.test(prev)
    const isWrappedStock = /^-?\s*\(\s*\d+\s*\)$/.test(line)
    if (inVarBlock && !isBullet && prev && !prevIsHeader && (!prevHasPrice || isWrappedStock)) {
      mergedLines[mergedLines.length - 1] = prev + ' ' + line
    } else {
      mergedLines.push(line)
    }
  }

  const types = []
  const descChunks = []
  const notes = []

  let currentVar = null
  let inDescSection = false
  let inWholesaleSection = false
  let singlePrice = 0
  let singleStock = null
  let singleVarName = ''
  let productHeaderName = ''
  let taintedPrice = false

  for (let i = 0; i < mergedLines.length; i++) {
    const rawLine = mergedLines[i]
    const startedWithBullet = LEADING_BULLET_RE.test(rawLine)
    const l = rawLine.replace(LEADING_BULLET_RE, '').trim()
    if (!l) continue

    // Hentikan pembacaan harga jika sudah masuk blok "Harga Grosir" (Min 5 : Rp 1,000 dst.)
    if (/harga\s*grosir/i.test(l)) {
      inWholesaleSection = true
      inDescSection = false
      continue
    }
    if (inWholesaleSection) continue

    // Abaikan baris promosi supplier, tanggal, rating, stok terjual, total stok, jumlah, total harga
    if (/febrian|@\w+|t\.me\/|telegram|order manual|tanpa fee|halaman\s+\d+\s*\/\s*\d+|berikan rating|pilih\s+jumlah|masukkan\s+jumlah|ketik\s+jumlah|current\s*date/i.test(l)) {
      inDescSection = false
      continue
    }
    if (/^(rating|stok\s*terjual|total\s*stok|total\s*harga|kode)\s*:/i.test(l)) {
      inDescSection = false
      continue
    }
    const qtyField = l.match(/^jumlah\s*:\s*(\d+)/i)
    if (qtyField) {
      if (Number(qtyField[1]) > 1) taintedPrice = true
      inDescSection = false
      continue
    }
    if (/^variasi\s*,\s*harga/i.test(l)) {
      inDescSection = false
      continue
    }

    // Ambil nama Produk dari baris "Produk : ..."
    const prodField = l.match(/^(?:nama\s*produk|produk)\s*:\s*(.+)$/i)
    if (prodField) {
      productHeaderName = prodField[1].trim()
      inDescSection = false
      continue
    }

    // Format A (@FebrianStore1_Bot): "CHATGPT GO 3 BULAN NOGAR: Rp. 55,000 - (15)" atau "Alight Motion 1 Tahun: Rp. 1,000 - (141)"
    const febrianVar = l.match(/^(.+?)\s*:\s*rp\.?\s*(\d{1,3}(?:[.,]\d{3})+|\d{3,8})(?:\s*-\s*\(\s*(\d+)\s*\))?$/i)
    if (febrianVar && !/^(harga|total\s*harga|min\s*\d+|minimal|saldo|fee)/i.test(febrianVar[1].trim())) {
      const p = parseNominal(febrianVar[2])
      if (p > 0) {
        types.push({
          name: cleanVariantLabel(febrianVar[1]),
          basePrice: p,
          stock: febrianVar[3] !== undefined ? Number(febrianVar[3]) : null
        })
        inDescSection = false
        continue
      }
    }

    // Baris varian bernomor: "[1] 1 Bulan - Rp 15.000 (Stok: 5)" atau "1. 1 Bulan : 15.000"
    const directVar = l.match(/^(?:\[(\d+)\]|(\d+)[.)])\s*(.+?)\s*(?:[-=:»]|—)\s*(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{3,8}|\d+(?:[.,]\d+)?\s*(?:k|rb|ribu))(?:\s*(?:-\s*)?\((?:stok\s*:?\s*)?(\d+)\))?/i)
    if (directVar) {
      const p = parseNominal(directVar[4])
      if (p > 0) {
        types.push({
          name: cleanVariantLabel(directVar[3].replace(/\(\s*\d+\s*\)$/, '')),
          basePrice: p,
          stock: directVar[5] !== undefined ? Number(directVar[5]) : null
        })
        currentVar = types[types.length - 1]
        inDescSection = false
        continue
      }
    }

    // Field Harga (Format B Single Product): "Harga : Rp. 1,500"
    const priceField = l.match(/^(?:💰|💸|🏷️?)?\s*(?:harga|price|biaya)\s*(?:per\s*akun|produk)?\s*[:=-]\s*(.+)$/i)
    if (priceField) {
      if (/grosir/i.test(priceField[1])) taintedPrice = true
      const p = parseNominal(priceField[1])
      if (p > 0) {
        if (currentVar && !currentVar.basePrice) currentVar.basePrice = p
        else singlePrice = p
      }
      inDescSection = false
      continue
    }

    // Field Sisa Stok / Sisa Produk (Format B Single Product): "Sisa Stok : 88" / "Sisa Produk : 7"
    const stockField = l.match(/^(?:📊|📦)?\s*(?:sisa\s*stok|sisa\s*produk|stok\s*tersedia|stok|stock|tersedia)\s*[:=-]\s*(\d+)/i)
    if (stockField) {
      const st = Number(stockField[1])
      if (currentVar && currentVar.stock === null) currentVar.stock = st
      else singleStock = st
      inDescSection = false
      continue
    }

    // Field Variasi / Jenis (Format B Single Product): "Variasi : Picsart Pro 7 Hari Private 100 Kredit"
    const varField = l.match(/^(?:📦|🏷️?)?\s*(?:variasi|varian|jenis|durasi|paket|tipe)\s*[:=-]\s*(.+)$/i)
    if (varField) {
      singleVarName = cleanVariantLabel(varField[1])
      inDescSection = false
      continue
    }

    // Field Deskripsi: "Desk : ..."
    const descField = l.match(/^(?:📝|📌|📋|ℹ️)?\s*(?:desk|deskripsi|keterangan|ket|syarat\s*&?\s*ketentuan|s\s*&\s*k|detail|catatan|note)\s*[:=-]\s*(.*)$/i)
    if (descField) {
      inDescSection = true
      if (descField[1].trim()) descChunks.push(descField[1].trim())
      continue
    }

    // Jika muncul bullet field baru saat di dalam Desk, keluar dari section Desk
    if (inDescSection && startedWithBullet) {
      inDescSection = false
      continue
    }

    // Baris sambungan di dalam Desk (misal: "PRIVATE AKUN & NOGARANSI" di bawah "Desk : DURASI 3 BULAN")
    if (inDescSection && l.length > 1 && !/^(klik|tekan|pilih|ketik|silakan|minimal|maksimal|min\s+\d+)/i.test(l)) {
      descChunks.push(l)
    }
  }

  const joinedDesc = descChunks.length > 1 && descChunks.some(x => /,/.test(x))
    ? descChunks.join(' ')
    : descChunks.join('\n')
  const desc = [...new Set(
    splitDescClauses(joinedDesc)
      .map(c => sanitizeSupplierText(c))
      .filter(Boolean)
      .map(x => x.replace(/^[,\s]+|[,\s]+$/g, ''))
      .filter(Boolean)
  )].slice(0, 8)

  // Bersihkan types yang valid (punya basePrice > 0)
  const validTypes = types.filter(t => t.basePrice > 0)
  if (!validTypes.length && singlePrice > 0 && !taintedPrice) {
    validTypes.push({
      name: cleanVariantLabel(singleVarName || productHeaderName || fallbackName || fallbackVariant || '1 Akun'),
      basePrice: singlePrice,
      stock: singleStock
    })
  }

  return {
    types: validTypes,
    desc,
    note: notes.join('\n'),
    stock: singleStock,
    // Format "Variasi : ..." hanya menampilkan 1 varian -> gabungkan dengan varian lain yang sudah ada
    partial: !types.length && !!singleVarName,
    tainted: taintedPrice
  }
}

function isGenericFallbackDesc (desc) {
  if (!Array.isArray(desc) || !desc.length) return true
  const norm = desc.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)
  if (!norm.length) return true
  return norm.length === 2 && norm[0] === 'full garansi' && norm[1] === 'akun & akses resmi'
}

function isCorruptedType (t) {
  const n = String(t?.name || '')
  return /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/.test(n) ||
    (/rp\.?\s*\d{1,3}(?:[.,]\d{3})+/i.test(n) && /[•●∙◦▪▫]/.test(n))
}

function findBaselineForKey (key) {
  if (!Array.isArray(FEBRIAN_BASELINE_CATALOG)) return null
  for (const b of FEBRIAN_BASELINE_CATALOG) {
    const id = normalizeProductIdentity(b.rawName, {})
    if (id.key === key) return b
  }
  return null
}

// Terapkan hasil produk Telegram ke database bot WA (dengan markup untung reseller + jaga editan manual admin)
function applySyncedProductsToDb (syncedItems, db, config, opts = {}) {
  const s = db.data.settings
  const markup = Math.max(0, Number(opts.markup ?? s.syncMarkup ?? config.syncMarkup ?? 5000) || 0)
  const forceOverwrite = !!opts.forceOverwrite
  const stockMode = opts.stockMode || 'replace' // 'replace' | 'add' | 'keep'
  const storeName = s.storeName || 'MASS.ID STORE'

  let added = 0
  let updated = 0
  let skippedLocked = 0

  for (const raw of syncedItems) {
    const ident = normalizeProductIdentity(raw.rawName || raw.name, db.data.list)
    const key = ident.key
    if (!key || INFO_KEYS.includes(key)) continue

    const existing = db.data.list[key]
    if (existing?.syncLocked && !forceOverwrite) {
      skippedLocked++
      continue
    }

    const keepManualStock = !forceOverwrite && (!!existing?.stockLocked || stockMode === 'keep')
    const addStockMode = stockMode === 'add'

    // Susun daftar jenis & harga (+ markup untung reseller)
    let newTypes = (raw.types || [])
      .filter(t => Number(t.basePrice) > 0)
      .map(t => {
        const base = Math.round(Number(t.basePrice))
        let cleanVarName = cleanVariantLabel(t.name || ident.embeddedVariant || '', storeName)
        if (!cleanVarName) cleanVarName = ident.embeddedVariant || 'Reguler'
        return {
          name: cleanVarName,
          basePrice: base,
          price: String(base + markup),
          stock: t.stock ?? raw.stock ?? null
        }
      })

    // Jika dari Telegram baru dapat nama & stok (belum ada harga detailnya) dan produk sudah ada di DB:
    // cukup update info stok supplier-nya tanpa merusak harga yang sudah ada di DB!
    if (!newTypes.length) {
      if (existing) {
        if (!keepManualStock && raw.stock !== undefined && raw.stock !== null) {
          const incomingSt = Math.max(0, Number(raw.stock) || 0)
          if (addStockMode) {
            existing.supplierStock = Math.max(0, Number(existing.supplierStock) || 0) + incomingSt
            if (Array.isArray(existing.types) && existing.types.length === 1) {
              existing.types[0].stock = Math.max(0, Number(existing.types[0].stock) || 0) + incomingSt
            }
            existing.stockLocked = true
          } else {
            existing.supplierStock = incomingSt
            if (Array.isArray(existing.types)) {
              if (existing.types.length === 1) {
                existing.types[0].stock = incomingSt
              } else if (incomingSt === 0) {
                for (const t of existing.types) t.stock = 0
              }
            }
          }
        }
        existing.tgNum = raw.num ?? existing.tgNum
        existing.lastSyncAt = Date.now()
        updated++
      }
      continue
    }

    const cleanDesc = (raw.desc || [])
      .map(d => sanitizeSupplierText(d, storeName))
      .filter(Boolean)

    // Kartu hanya berisi 1 varian (format "Variasi : ...") ATAU mode tambah stok dari bot lain -> gabungkan dengan varian yang sudah ada
    if ((raw.partial || addStockMode) && existing && Array.isArray(existing.types) && existing.types.length) {
      const cleanOld = existing.types.filter(t => !isCorruptedType(t)).map(t => ({ ...t, name: stripInvisible(t.name).trim() }))
      if (cleanOld.length) {
        const vk = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        const merged = cleanOld
        for (const nt of newTypes) {
          const i = merged.findIndex(t => vk(t.name) === vk(nt.name))
          if (i >= 0) {
            const combinedStock = addStockMode && nt.stock !== null && nt.stock !== undefined
              ? Math.max(0, Number(merged[i].stock) || 0) + Math.max(0, Number(nt.stock) || 0)
              : (keepManualStock && merged[i].stock !== undefined ? merged[i].stock : nt.stock)
            merged[i] = { ...merged[i], ...nt, stock: combinedStock }
          } else {
            merged.push(nt)
          }
        }
        newTypes = merged
      }
    } else if (keepManualStock && existing && Array.isArray(existing.types) && existing.types.length) {
      // Pertahankan stok manual per varian (dan varian tambahan dari bot lain) saat stok dikunci
      const vk = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const oldList = existing.types.filter(t => !isCorruptedType(t))
      newTypes = newTypes.map(nt => {
        const prev = oldList.find(o => vk(o.name) === vk(nt.name))
        return prev && prev.stock !== undefined ? { ...nt, stock: prev.stock } : nt
      })
      for (const oldT of oldList) {
        if (oldT.manualVariant && !newTypes.some(nt => vk(nt.name) === vk(oldT.name))) {
          newTypes.push({ ...oldT })
        }
      }
    }

    const baseline = cleanDesc.length ? null : findBaselineForKey(key)
    const fallbackDesc = baseline?.desc?.length ? baseline.desc : []

    if (existing) {
      // Jika sudah ada di DB:
      // Pertahankan gambar milik admin, note milik admin, judul milik admin.
      // Untuk deskripsi: perbarui dari Telegram jika ada Desk asli (kecuali dikunci/edit manual, dan perbaiki jika masih deskripsi bawaan kosong/lama)
      const existingDescClean = Array.isArray(existing.desc) ? existing.desc.map(d => stripInvisible(d).trim()).filter(Boolean) : []
      const shouldUpdateDesc = cleanDesc.length > 0 && (
        forceOverwrite ||
        isGenericFallbackDesc(existingDescClean) ||
        (existing.fromTelegram && !existing.manualDesc)
      )
      const finalDesc = shouldUpdateDesc
        ? cleanDesc
        : (!isGenericFallbackDesc(existingDescClean) ? existingDescClean : (cleanDesc.length ? cleanDesc : fallbackDesc))
      const finalNote = stripInvisible(existing.note || sanitizeSupplierText(raw.note || '', storeName) || '').trim()
      const trackedSt = newTypes.filter(t => t.stock !== null && t.stock !== undefined && Number.isFinite(Number(t.stock)))
      const calcTotalStock = trackedSt.length
        ? trackedSt.reduce((sum, t) => sum + Math.max(0, Number(t.stock)), 0)
        : (keepManualStock ? (existing.supplierStock ?? null) : (raw.stock ?? null))
      db.data.list[key] = {
        ...existing,
        name: stripInvisible(existing.name || key.toUpperCase()).trim(),
        title: stripInvisible(existing.title || ident.title).trim(),
        types: newTypes,
        desc: finalDesc,
        note: finalNote,
        fromTelegram: true,
        tgNum: raw.num ?? existing.tgNum,
        stockLocked: addStockMode ? true : !!existing.stockLocked,
        supplierStock: calcTotalStock,
        lastSyncAt: Date.now(),
        updatedAt: Date.now()
      }
      updated++
    } else {
      // Produk baru dari Telegram
      db.data.list[key] = {
        name: key.toUpperCase(),
        title: ident.title,
        image: null,
        types: newTypes,
        desc: cleanDesc.length ? cleanDesc : fallbackDesc,
        note: sanitizeSupplierText(raw.note || '', storeName) || 'Tanyakan stok sebelum order',
        fromTelegram: true,
        tgNum: raw.num ?? null,
        supplierStock: raw.stock ?? null,
        lastSyncAt: Date.now(),
        updatedAt: Date.now()
      }
      added++
    }
  }

  s.lastTelegramSync = Date.now()
  db.save()
  return { added, updated, skippedLocked, skipped: skippedLocked, markup }
}

// Data baseline lengkap 32 produk resmi dari @FebrianStore1_Bot (harga modal asli sebelum ditambah markup Rp 5.000)
const FEBRIAN_BASELINE_CATALOG = [
  {
    num: 1,
    rawName: 'AI CHATGPT',
    stock: 14,
    desc: ['Full Garansi Sesuai Durasi', 'Akun & Akses Resmi'],
    types: [
      { name: 'ChatGPT Go 3 Bulan Link / Redem', basePrice: 3000, stock: 0 },
      { name: 'ChatGPT Go 3 Bulan Nogar', basePrice: 55000, stock: 14 }
    ]
  },
  {
    num: 2,
    rawName: 'ALIGHT MOTION',
    stock: 141,
    desc: ['Garansi 11 Bln (Selama Metode Bisa)', 'Khusus Android (Tidak Bisa Di Iphone / Ios)', 'Ada Akses'],
    types: [
      { name: 'Alight Motion 1 Tahun Full Garansi', basePrice: 1000, stock: 141 }
    ]
  },
  {
    num: 3,
    rawName: 'AMAZON PRIME',
    stock: 368,
    desc: ['Private Akun', 'Full Garansi (BF, Lock, Hold)'],
    types: [
      { name: 'Amazon Prime 1 Bln', basePrice: 5000, stock: 336 },
      { name: 'Amazon Prime 1 Bln Share', basePrice: 1500, stock: 32 }
    ]
  },
  {
    num: 4,
    rawName: 'APPLE MUSIC',
    stock: 10,
    desc: ['Region Indo', 'Khusus Android', 'Bisa Invite Member'],
    types: [
      { name: 'Apple Music Famhead 1 Bulan', basePrice: 5000, stock: 10 }
    ]
  },
  {
    num: 5,
    rawName: 'APPLE TV',
    stock: 5,
    desc: ['Full Garansi', 'Private', 'Akun Admin'],
    types: [
      { name: 'Apple TV+ 1 Bln Private', basePrice: 27000, stock: 2 },
      { name: 'Apple TV+ 1 Bln Share', basePrice: 8000, stock: 3 }
    ]
  },
  {
    num: 6,
    rawName: 'AVIRA VPN 3 BULAN',
    stock: 88,
    desc: ['Durasi 3 Bulan', 'Private Akun & No Garansi'],
    types: [
      { name: 'Avira VPN 3 Bulan Private', basePrice: 1500, stock: 88 }
    ]
  },
  {
    num: 7,
    rawName: 'CANVA PREMIUM',
    stock: 118,
    desc: ['Bisa Invite Member', 'Full Fitur Pro'],
    types: [
      { name: 'Canva Head 1 Bln', basePrice: 3000, stock: 100 },
      { name: 'Canva Head 1 Bln Full Garansi', basePrice: 4000, stock: 18 }
    ]
  },
  {
    num: 8,
    rawName: 'CAPCUT PRO',
    stock: 144,
    desc: ['Full Garansi', 'Akun Admin', 'Ada Akses Mail'],
    types: [
      { name: 'CapCut Pro 7 Days', basePrice: 3000, stock: 0 },
      { name: 'CapCut Pro 28 Days', basePrice: 15000, stock: 0 },
      { name: 'CapCut Pro 1 Bln Indplan No Renew', basePrice: 18500, stock: 22 },
      { name: 'CapCut Pro 35 Days', basePrice: 20000, stock: 82 },
      { name: 'CapCut Pro 1 Bln Member No Renew', basePrice: 21000, stock: 0 },
      { name: 'CapCut Pro 42 Days', basePrice: 22000, stock: 37 },
      { name: 'CapCut Pro 6 Bulan', basePrice: 140000, stock: 3 }
    ]
  },
  {
    num: 9,
    rawName: 'CRUNCHYROLL PRIVATE 1BLN',
    stock: 17,
    desc: ['Full Garansi', 'Akun Admin', 'Paket Mega Fan'],
    types: [
      { name: 'Crunchyroll Private 1 Bln', basePrice: 12000, stock: 17 },
      { name: 'Crunchyroll Share 1 Bln', basePrice: 3000, stock: 0 }
    ]
  },
  {
    num: 10,
    rawName: 'DISNEY+',
    stock: 34,
    desc: ['Full Garansi', 'Streaming Kualitas HD/4K'],
    types: [
      { name: 'Disney+ Standard Private 1 Bulan', basePrice: 25000, stock: 34 },
      { name: 'Disney+ Premium 1 Bulan Share', basePrice: 11000, stock: 0 },
      { name: 'Disney+ Premium Private 1 Bulan', basePrice: 75000, stock: 0 }
    ]
  },
  {
    num: 11,
    rawName: 'DUOLINGO',
    stock: 46,
    desc: ['Full Garansi', 'Bebas Iklan & Unlimited Hearts'],
    types: [
      { name: 'Duolingo 2 Bulan Indplan', basePrice: 3500, stock: 20 },
      { name: 'Duolingo 2 Bulan Head', basePrice: 4500, stock: 26 }
    ]
  },
  {
    num: 12,
    rawName: 'GEMINI',
    stock: 0,
    desc: ['Kode Redeem Resmi Google Gemini AI Pro'],
    types: [
      { name: 'AI Gemini Pro Kode Redeem 3 Bln', basePrice: 10000, stock: 0 },
      { name: 'AI Gemini Pro Kode Redeem 18 Bln', basePrice: 20000, stock: 0 }
    ]
  },
  {
    num: 13,
    rawName: 'HBO MAX',
    stock: 52,
    desc: ['Bergaransi', 'Akun Admin'],
    types: [
      { name: 'HBO Standar 1 Bln Private', basePrice: 12000, stock: 41 },
      { name: 'HBO Ultimate / Premium 1 Bln Private', basePrice: 33000, stock: 5 },
      { name: 'HBO Ultimate Share', basePrice: 7000, stock: 6 }
    ]
  },
  {
    num: 14,
    rawName: 'HMA VPN',
    stock: 49,
    desc: ['Full Garansi', 'Koneksi Cepat & Stabil'],
    types: [
      { name: 'HMA VPN 1 Bln', basePrice: 3000, stock: 7 },
      { name: 'HMA VPN 1 Bln Login Via Kode', basePrice: 2000, stock: 42 }
    ]
  },
  {
    num: 15,
    rawName: 'IQIYI',
    stock: 18,
    desc: ['Full Garansi', 'Subtitle Indonesia'],
    types: [
      { name: 'iQIYI Share 1 Bln Region US', basePrice: 4000, stock: 4 },
      { name: 'iQIYI Premium 1 Bln Region US', basePrice: 21000, stock: 0 },
      { name: 'iQIYI Premium 1 Bln Region Indonesia', basePrice: 27000, stock: 14 }
    ]
  },
  {
    num: 16,
    rawName: 'LOKLOK VIP',
    stock: 22,
    desc: ['Full Garansi', 'Bebas Iklan & Kualitas VIP'],
    types: [
      { name: 'Loklok VIP 40 Days Private', basePrice: 36000, stock: 11 },
      { name: 'Loklok VIP Basic 40 Days Share', basePrice: 15000, stock: 6 },
      { name: 'Loklok VIP Standar 30 Day Private', basePrice: 57000, stock: 4 },
      { name: 'Loklok VIP Standar 30 Day Share', basePrice: 22000, stock: 1 }
    ]
  },
  {
    num: 17,
    rawName: 'MEITU VIP',
    stock: 25,
    desc: ['Private', 'Full Garansi', 'Android Only'],
    types: [
      { name: 'Meitu VIP 3 Days Android Only', basePrice: 700, stock: 0 },
      { name: 'Meitu VIP 7 Days Android Only', basePrice: 2000, stock: 24 },
      { name: 'Meitu VIP 14 Days Android Only', basePrice: 4000, stock: 1 }
    ]
  },
  {
    num: 18,
    rawName: 'Microsoft Office 365 1 Bulan Head',
    stock: 1,
    desc: ['Akun Privat', 'Support All Device', 'Garansi Full', 'Head'],
    types: [
      { name: 'Microsoft Office 365 1 Bulan Head', basePrice: 4000, stock: 1 }
    ]
  },
  {
    num: 19,
    rawName: 'MUSE AI',
    stock: 0,
    desc: ['Kuota 1 Miliar Token'],
    types: [
      { name: 'Muse AI 1 Miliar Token Nogar', basePrice: 4000, stock: 0 }
    ]
  },
  {
    num: 20,
    rawName: 'NETFLIX PREMIUM',
    stock: 13,
    desc: ['Kualitas Ultra HD 4K', 'Full Garansi'],
    types: [
      { name: 'Netflix 1U1P (1 User 1 Profile)', basePrice: 32000, stock: 13 },
      { name: 'Netflix Private 1 Bulan', basePrice: 160000, stock: 0 }
    ]
  },
  {
    num: 21,
    rawName: 'Picsart Pro 7 Hari Private 100 Kredit',
    stock: 7,
    desc: ['Private Full Garansi', 'Termasuk 100 Kredit AI'],
    types: [
      { name: 'Picsart Pro 7 Hari Private 100 Kredit', basePrice: 3000, stock: 7 }
    ]
  },
  {
    num: 22,
    rawName: 'SCRIBD PREMIUM',
    stock: 19,
    desc: ['Private Akun', 'Bergaransi', 'Ada Limit Download'],
    types: [
      { name: 'Scribd Premium 1 Bulan', basePrice: 3000, stock: 19 }
    ]
  },
  {
    num: 23,
    rawName: 'SPOTIFY PREMIUM',
    stock: 87,
    desc: ['Bebas Iklan & Bisa Download Lagu', 'Garansi Sesuai Paket'],
    types: [
      { name: 'Spotify 1 Bln Full Garansi', basePrice: 12000, stock: 27 },
      { name: 'Spotify 1 Bln No Garansi', basePrice: 5000, stock: 0 },
      { name: 'Spotify Famplan 1 Bulan Fullgar', basePrice: 14000, stock: 60 },
      { name: 'Spotify Famplan 2 Bulan Fullgar', basePrice: 22000, stock: 0 },
      { name: 'Spotify 2 Bln No Garansi', basePrice: 6500, stock: 0 }
    ]
  },
  {
    num: 24,
    rawName: 'VIDIO PLATINUM',
    stock: 8,
    desc: ['Full Garansi', 'Akun Resmi'],
    types: [
      { name: 'Vidio Platinum Mobile 1 Bln', basePrice: 21000, stock: 8 },
      { name: 'Vidio Platinum All Device 1 Bln Private', basePrice: 38000, stock: 0 }
    ]
  },
  {
    num: 25,
    rawName: 'VISION BEIN + SPORTS',
    stock: 0,
    desc: ['No Iklan', 'Full Garansi', 'Private', 'Bein + Sports [No Ads]'],
    types: [
      { name: 'Vision Bein + Sports 1 Bulan', basePrice: 12000, stock: 0 }
    ]
  },
  {
    num: 26,
    rawName: 'VIU PREMIUM',
    stock: 869,
    desc: ['Login Nomor', 'Anti Limit', 'Private Akun'],
    types: [
      { name: 'Viu Premium 6 Bulan', basePrice: 500, stock: 321 },
      { name: 'Viu Premium 9 Bulan', basePrice: 1000, stock: 219 },
      { name: 'Viu Premium 12 Bulan', basePrice: 1500, stock: 95 },
      { name: 'Viu Premium Lifetime', basePrice: 2500, stock: 234 }
    ]
  },
  {
    num: 27,
    rawName: 'VPN EXPRESS',
    stock: 0,
    desc: ['Koneksi Cepat & Aman', 'Full Garansi'],
    types: [
      { name: 'VPN Express 3 Hari', basePrice: 2000, stock: 0 }
    ]
  },
  {
    num: 28,
    rawName: 'VPN SURFSHARK',
    stock: 10,
    desc: ['Koneksi Cepat & Stabil', 'Full Garansi'],
    types: [
      { name: 'Surfshark VPN 2 Bulan', basePrice: 17000, stock: 10 }
    ]
  },
  {
    num: 29,
    rawName: 'WETV PREMIUM',
    stock: 72,
    desc: ['Login Nomor', 'Full Garansi'],
    types: [
      { name: 'WeTV 1 Bln Private', basePrice: 17000, stock: 68 },
      { name: 'WeTV 1 Bln Share', basePrice: 4000, stock: 4 }
    ]
  },
  {
    num: 30,
    rawName: 'WINK',
    stock: 1,
    desc: ['Private', 'Full Garansi', 'Android Only'],
    types: [
      { name: 'Wink 3 Days Android Only', basePrice: 700, stock: 0 },
      { name: 'Wink 7 Days Android Only', basePrice: 2000, stock: 1 },
      { name: 'Wink 14 Days Android Only', basePrice: 4000, stock: 0 }
    ]
  },
  {
    num: 31,
    rawName: 'YOUTUBE PREMIUM',
    stock: 212,
    desc: ['Bebas Iklan YouTube & YouTube Music', 'Bisa Putar Latar Belakang'],
    types: [
      { name: 'YouTube 28 Hari Renew Nogar', basePrice: 16000, stock: 0 },
      { name: 'YouTube 28 Hari Renew Full Garansi', basePrice: 17000, stock: 0 },
      { name: 'YouTube 40 Hari Renew', basePrice: 12000, stock: 102 },
      { name: 'YouTube 40 Hari Renew Fullgar', basePrice: 14000, stock: 104 },
      { name: 'YouTube 3 Bulan + 14 Hari Indplan No Garansi', basePrice: 14000, stock: 0 },
      { name: 'YouTube 3 Bulan + 14 Hari Indplan Full Garansi', basePrice: 33000, stock: 6 }
    ]
  },
  {
    num: 32,
    rawName: 'ZOOM MEETING PRO',
    stock: 163,
    desc: ['Private Akun', '100 Peserta', 'Full Garansi'],
    types: [
      { name: 'Zoom Meeting Pro 7 Days', basePrice: 1500, stock: 56 },
      { name: 'Zoom Meeting Pro 14 Days', basePrice: 2000, stock: 107 }
    ]
  }
]

// Pastikan produk yang sudah ada di DB memiliki basePrice (harga modal) & terapkan katalog 32 produk + syncMarkup (+Rp 5.000)
function ensureBasePrices (db, config = {}) {
  const s = db.data.settings
  if (s.syncMarkup === undefined) s.syncMarkup = Number(config.syncMarkup ?? 5000)
  const markup = Math.max(0, Math.floor(Number(s.syncMarkup) || 0))
  let changed = false

  if (!s.basePriceMigrated) {
    for (const [k, item] of Object.entries(db.data.list || {})) {
      if (INFO_KEYS.includes(k) || !Array.isArray(item.types)) continue
      for (const t of item.types) {
        if (!t.basePrice) {
          const p = parseNominal(t.price)
          if (p > 0) {
            t.basePrice = p
            t.price = String(p + markup)
            changed = true
          }
        }
      }
    }
    s.basePriceMigrated = true
    changed = true
  }

  // Pastikan ke-32 produk dari @FebrianStore1_Bot sudah masuk lengkap dengan varian & harga modal yang akurat
  if (!s.febrianCatalogV2Migrated) {
    applySyncedProductsToDb(FEBRIAN_BASELINE_CATALOG, db, config, { markup })
    s.febrianCatalogV2Migrated = true
    changed = true
  }

  // Perbaikan otomatis sekali jalan: bersihkan karakter U+200B & varian yang sempat menyatu akibat bug lama
  if (!s.febrianCatalogV3CleanMigrated) {
    const itemsToRepair = []
    for (const [k, item] of Object.entries(db.data.list || {})) {
      if (INFO_KEYS.includes(k)) continue
      if (item.name) item.name = stripInvisible(item.name).trim()
      if (item.title) item.title = stripInvisible(item.title).trim()
      if (item.note) item.note = stripInvisible(item.note).trim()
      if (Array.isArray(item.desc)) item.desc = item.desc.map(d => stripInvisible(d).trim()).filter(Boolean)

      const typesArr = Array.isArray(item.types) ? item.types : []
      const hasCorrupted = typesArr.some(isCorruptedType)
      const hasGenericDesc = item.fromTelegram && isGenericFallbackDesc(item.desc)
      if (!item.syncLocked && hasCorrupted) {
        const baseline = findBaselineForKey(k)
        if (baseline) {
          itemsToRepair.push(baseline)
          changed = true
          continue
        }
      } else if (!item.syncLocked && hasGenericDesc) {
        const baseline = findBaselineForKey(k)
        if (baseline?.desc?.length) {
          item.desc = [...baseline.desc]
          changed = true
        }
      }
      for (const t of typesArr) {
        if (t.name) {
          const clean = stripInvisible(t.name).replace(LEADING_BULLET_RE, '').trim()
          if (clean !== t.name) { t.name = clean; changed = true }
        }
      }
    }
    if (itemsToRepair.length) {
      applySyncedProductsToDb(itemsToRepair, db, config, { markup, forceOverwrite: true })
    }
    s.febrianCatalogV3CleanMigrated = true
    changed = true
  }

  // Setiap bot nyala: rapikan nama variasi yang masih diawali simbol (•, ◦, -, dll.)
  for (const [k, item] of Object.entries(db.data.list || {})) {
    if (INFO_KEYS.includes(k) || !Array.isArray(item.types)) continue
    for (const t of item.types) {
      if (!t.name) continue
      const clean = stripInvisible(t.name).trim().replace(/^[^\p{L}\p{N}([+]+/u, '').replace(/\s{2,}/g, ' ').trim()
      if (clean && clean !== t.name) { t.name = clean; changed = true }
    }
  }

  if (changed) db.save()
}

// Hitung ulang semua harga produk yang punya basePrice saat Admin mengubah nominal untung (.setuntung)
function recalculateMarkupPrices (db, newMarkup) {
  const markup = Math.max(0, Math.floor(Number(newMarkup) || 0))
  db.data.settings.syncMarkup = markup
  let count = 0
  for (const [k, item] of Object.entries(db.data.list || {})) {
    if (INFO_KEYS.includes(k) || item.syncLocked || !Array.isArray(item.types)) continue
    let touched = false
    for (const t of item.types) {
      if (Number(t.basePrice) > 0) {
        t.price = String(Math.round(Number(t.basePrice)) + markup)
        touched = true
      }
    }
    if (touched) {
      item.updatedAt = Date.now()
      count++
    }
  }
  db.save()
  return count
}

// Impor instan dari teks yang di-copy-paste Admin (mendukung teks LIST PRODUCT maupun teks detail harga)
function importFromPastedText (rawText, db, config, opts = {}) {
  const text = String(rawText || '').trim()
  if (!text) throw new Error('Teks masih kosong')

  const items = []
  // 1. Cek apakah teks dibagi per produk dengan header atau blok
  const parsedDetail = parseProductDetail(text, [], opts.productName || '')
  if (opts.productName && parsedDetail.types.length) {
    items.push({
      rawName: opts.productName,
      types: parsedDetail.types,
      desc: parsedDetail.desc,
      note: parsedDetail.note,
      stock: parsedDetail.stock
    })
  } else {
    // 2. Cek pola multi-produk di dalam teks panjang (misal Laporan Stok atau gabungan chat)
    const sections = text.split(/(?=(?:^|\n)\s*(?:\[\d+\]\.?\s*[A-Z0-9]|📦\s*(?:PRODUK|NAMA\s*PRODUK)\s*:|「\s*\*?[A-Z0-9]))/i)
    for (const sec of sections) {
      const sTrim = sec.trim()
      if (!sTrim) continue
      const firstLine = sTrim.split(/\r?\n/)[0].trim()
      const nameMatch = firstLine.match(/^(?:\[(\d+)\]\.?\s*(.+?)(?:\(\s*(\d+)\s*\))?|📦\s*(?:PRODUK|NAMA\s*PRODUK)\s*:\s*(.+)|「\s*\*?([^*」]+)\*?\s*」)$/i)
      const pName = (nameMatch && (nameMatch[2] || nameMatch[4] || nameMatch[5])) ? (nameMatch[2] || nameMatch[4] || nameMatch[5]).trim() : ''
      const pStock = (nameMatch && nameMatch[3]) ? Number(nameMatch[3]) : null
      const ident = pName ? normalizeProductIdentity(pName, db.data.list) : { embeddedVariant: '' }
      const det = parseProductDetail(sTrim, [], pName, ident.embeddedVariant)
      if (pName && det.types.length) {
        items.push({
          num: nameMatch?.[1] ? Number(nameMatch[1]) : null,
          rawName: pName,
          stock: pStock ?? det.stock,
          types: det.types,
          desc: det.desc,
          note: det.note
        })
      }
    }

    // 3. Jika hanya berisi daftar "[1]. NAMA PRODUK ( STOK )"
    if (!items.length) {
      const cat = parseCatalogList(text)
      for (const c of cat.items) {
        items.push({ num: c.num, rawName: c.rawName, stock: c.stock, types: [] })
      }
    }
  }

  if (!items.length) {
    throw new Error('Tidak ditemukan format produk/harga yang dikenali dari teks tersebut.')
  }
  const res = applySyncedProductsToDb(items, db, config, opts)
  return { ...res, parsedCount: items.length }
}

// ---------------- koneksi & login Telegram (GramJS) ----------------
function loadTelegramLib () {
  const tg = require('telegram')
  const { StringSession } = require('telegram/sessions')
  const { computeCheck } = require('telegram/Password')
  return { TelegramClient: tg.TelegramClient, Api: tg.Api, StringSession, computeCheck }
}

async function getConnectedClient (config = {}) {
  const { TelegramClient, StringSession } = loadTelegramLib()
  if (state.client && state.client.connected) return state.client
  const sessStr = loadSessionString()
  if (!sessStr) throw new Error('Akun Telegram belum login. Silakan login dulu di menu Sinkron Telegram.')
  const apiId = Number(config.tgApiId) || DEFAULT_API_ID
  const apiHash = String(config.tgApiHash || DEFAULT_API_HASH)
  const client = new TelegramClient(new StringSession(sessStr), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false
  })
  client.setLogLevel('none')
  await client.connect()
  if (!(await client.isUserAuthorized())) {
    throw new Error('Sesi Telegram sudah kadaluarsa. Silakan login ulang.')
  }
  state.client = client
  return client
}

async function startLogin (rawPhone, config = {}) {
  const phone = normPhone(rawPhone)
  if (!phone || phone.length < 9) throw new Error('Nomor HP Telegram tidak valid (contoh: 08123456789)')
  const { TelegramClient, StringSession } = loadTelegramLib()
  if (state.pendingLogin?.client) {
    try { await state.pendingLogin.client.disconnect() } catch {}
  }
  const apiId = Number(config.tgApiId) || DEFAULT_API_ID
  const apiHash = String(config.tgApiHash || DEFAULT_API_HASH)
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false
  })
  client.setLogLevel('none')
  await client.connect()
  const res = await client.sendCode({ apiId, apiHash }, phone)
  state.pendingLogin = {
    client,
    phone,
    phoneCodeHash: res.phoneCodeHash,
    apiId,
    apiHash,
    createdAt: Date.now()
  }
  return { ok: true, phone, status: 'code_sent' }
}

async function verifyLoginCode (code, password = '') {
  const p = state.pendingLogin
  if (!p || !p.client) throw new Error('Belum ada proses login aktif. Masukkan nomor HP Telegram dulu.')
  const { Api, computeCheck } = loadTelegramLib()
  const cleanCode = String(code || '').replace(/\D/g, '').trim()

  try {
    if (cleanCode && !p.needPasswordOnly) {
      await p.client.invoke(new Api.auth.SignIn({
        phoneNumber: p.phone,
        phoneCodeHash: p.phoneCodeHash,
        phoneCode: cleanCode
      }))
    } else if (p.needPasswordOnly && password) {
      const pwdInfo = await p.client.invoke(new Api.account.GetPassword())
      const pwdCheck = await computeCheck(pwdInfo, String(password))
      await p.client.invoke(new Api.auth.CheckPassword({ password: pwdCheck }))
    } else {
      throw new Error('Kode OTP Telegram belum diisi')
    }
  } catch (e) {
    const msg = String(e?.errorMessage || e?.message || e)
    if (/SESSION_PASSWORD_NEEDED/i.test(msg)) {
      if (!password) {
        p.needPasswordOnly = true
        return { ok: false, needPassword: true, message: 'Akun Telegram ini memakai Verifikasi 2 Langkah (Password). Silakan masukkan password Telegram Anda.' }
      }
      const pwdInfo = await p.client.invoke(new Api.account.GetPassword())
      const pwdCheck = await computeCheck(pwdInfo, String(password))
      await p.client.invoke(new Api.auth.CheckPassword({ password: pwdCheck }))
    } else {
      throw new Error('Gagal verifikasi OTP Telegram: ' + msg)
    }
  }

  const sessStr = p.client.session.save()
  saveSessionString(sessStr)
  state.client = p.client
  state.pendingLogin = null
  const me = await state.client.getMe()
  return {
    ok: true,
    user: {
      id: String(me?.id || ''),
      name: [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.username || p.phone,
      phone: me?.phone || p.phone
    }
  }
}

async function logoutTelegram () {
  if (state.pendingLogin?.client) {
    try { await state.pendingLogin.client.disconnect() } catch {}
    state.pendingLogin = null
  }
  if (state.client) {
    try { await state.client.disconnect() } catch {}
    state.client = null
  }
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE) } catch {}
  return { ok: true }
}

// Ambil teks semua tombol inline dari sebuah pesan GramJS
function extractInlineButtons (msg) {
  const out = []
  const rows = msg?.replyMarkup?.rows || []
  for (const r of rows) {
    for (const b of r.buttons || []) {
      if (b?.text) out.push({ text: String(b.text), data: b.data })
    }
  }
  return out
}

// Hentikan proses sinkronisasi yang sedang berjalan (hasil yang sudah terbaca tetap disimpan)
function stopSync () {
  if (!state.syncing) return false
  state.cancelRequested = true
  state.progress = '⏹️ Menghentikan sinkronisasi & menyimpan data yang sudah terbaca...'
  return true
}

// ---------------- proses sinkron otomatis ke @FebrianStore1_Bot ----------------
async function syncFromTelegram ({ db, config, mode = 'full', onProgress } = {}) {
  if (state.syncing) throw new Error('Sinkronisasi sedang berjalan: ' + (state.progress || 'mohon tunggu...'))
  state.syncing = true
  state.syncMode = mode === 'stock' ? 'stock' : 'full'
  state.cancelRequested = false
  state.progressPct = 2
  state.lastError = ''
  const report = (txt, pct) => {
    state.progress = txt
    if (typeof pct === 'number') state.progressPct = Math.max(0, Math.min(100, Math.round(pct)))
    console.log('[TG-SYNC]', txt)
    if (typeof onProgress === 'function') { try { onProgress(txt, state.progressPct) } catch {} }
  }

  try {
    const s = db.data.settings
    const botUsername = String(s.tgBotUsername || config.tgBotUsername || 'FebrianStore1_Bot').replace(/^@/, '').trim()
    const stepDelay = Math.max(2800, Number(config.tgStepDelayMs) || 3500)

    report(`Menghubungkan ke Telegram & membuka @${botUsername}...`, 5)
    const client = await getConnectedClient(config)
    const entity = await client.getEntity(botUsername)

    // 0. Pastikan bot tidak sedang terjebak di mode "Masukkan jumlah pembelian" sebelum mengirim /start
    const initMsgs = await client.getMessages(entity, { limit: 2 })
    const initBotMsg = initMsgs.find(m => !m.out)
    if (initBotMsg && /masukkan jumlah pembelian/i.test(initBotMsg.message || '')) {
      const initBack = extractInlineButtons(initBotMsg).find(b => /kembali|batal|back|cancel/i.test(b.text))
      if (initBack) {
        try { await initBotMsg.click({ text: initBack.text }); await sleep(1800) } catch {}
      }
    }

    // 1. Kirim /start untuk membuka LIST PRODUCT halaman 1
    report(`Mengambil daftar katalog dari @${botUsername}...`, 10)
    await client.sendMessage(entity, { message: '/start' })
    await sleep(stepDelay)

    let msgs = await client.getMessages(entity, { limit: 6 })
    let listMsg = msgs.find(m => !m.out && /list\s*product|\[\d+\]\./i.test(m.message || ''))

    const catalogMap = new Map() // num -> { num, rawName, stock }
    if (listMsg) {
      let parsed = parseCatalogList(listMsg.message || '')
      for (const it of parsed.items) catalogMap.set(it.num, it)

      // Klik tombol "➡ Selanjutnya" untuk mengambil halaman 2, 3, 4, dst.
      const maxPages = Math.min(10, parsed.totalPages || 4)
      for (let p = 2; p <= maxPages; p++) {
        if (state.cancelRequested) break
        const btns = extractInlineButtons(listMsg)
        const nextBtn = btns.find(b => /selanjutnya|next|➡|▶/i.test(b.text))
        if (!nextBtn) break
        report(`Membuka halaman katalog ${p}/${maxPages}...`, 10 + Math.round((p / maxPages) * (state.syncMode === 'stock' ? 80 : 10)))
        await sleep(stepDelay)
        try {
          await listMsg.click({ text: nextBtn.text })
        } catch {
          try { await listMsg.click(0) } catch {}
        }
        await sleep(2200)
        const refreshed = await client.getMessages(entity, { ids: [listMsg.id] })
        const latestMsgs = await client.getMessages(entity, { limit: 4 })
        listMsg = (refreshed && refreshed[0]) || latestMsgs.find(m => !m.out && /list\s*product|\[\d+\]\./i.test(m.message || '')) || listMsg
        parsed = parseCatalogList(listMsg?.message || '')
        for (const it of parsed.items) catalogMap.set(it.num, it)
      }
    }

    // 2. Siapkan peta produk dari katalog
    const syncedMap = new Map() // num -> item
    for (const it of catalogMap.values()) {
      syncedMap.set(it.num, { ...it, types: [], desc: [], note: '' })
    }

    const nums = [...catalogMap.keys()].sort((a, b) => a - b)
    if (!nums.length) {
      throw new Error(`Bot @${botUsername} tidak merespon daftar produk. Pastikan bot tersebut aktif di Telegram.`)
    }

    // Jika mode = 'stock' (Sinkron Stok Cepat), langsung terapkan stok katalog tanpa buka kartu satu-satu
    if (state.syncMode === 'stock') {
      const result = applySyncedProductsToDb([...syncedMap.values()], db, config)
      state.lastSyncAt = Date.now()
      state.lastSyncResult = { ...result, mode: 'stock', totalCatalog: nums.length, okCount: nums.length, failed: [], botUsername }
      report(`⚡ Sinkron stok cepat selesai! ${result.updated} produk diperbarui stoknya.`, 100)
      return state.lastSyncResult
    }

    // ---- helper: deteksi jenis pesan dari bot pusat ----
    const txt = m => stripInvisible(m?.message || '')
    const isCardMsg = m => /produk\s*:/i.test(txt(m))
    const isQtyPrompt = m => /masukkan\s+jumlah/i.test(txt(m))
    const isFlood = m => /terlalu\s+cepat/i.test(txt(m))
    const hasQtyControls = m => extractInlineButtons(m).some(b => /buy|📝|notif\s*restok/i.test(b.text))
    const cardProductName = t => { const mm = String(t || '').match(/produk\s*:\s*(.+)/i); return mm ? mm[1].trim() : '' }
    const alnum = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const sameProduct = (a, b) => {
      const x = alnum(a); const y = alnum(b)
      if (!x || !y) return false
      return x === y || x.includes(y) || y.includes(x)
    }
    // Kartu tercemar: jumlah beli sudah bukan 1 / harga grosir -> harga tidak boleh dipakai
    const isTaintedCard = t => {
      const j = String(t || '').match(/jumlah\s*:\s*(\d+)/i)
      return (j && Number(j[1]) > 1) || /harga\s*:[^\n]*grosir/i.test(String(t || ''))
    }

    // Keluar dari mode "Masukkan jumlah pembelian" + reset menu bot pusat dengan /start
    const resetBotState = async () => {
      try {
        const recentMsgs = await client.getMessages(entity, { limit: 4 })
        const latestBot = recentMsgs.find(m => !m.out)
        if (latestBot) {
          const btns = extractInlineButtons(latestBot)
          const backBtn = btns.find(x => isQtyPrompt(latestBot)
            ? /kembali|batal|back|cancel/i.test(x.text)
            : /^back$|^kembali$/i.test(x.text.trim()))
          if (backBtn) {
            try { await latestBot.click({ text: backBtn.text }) } catch {}
            await sleep(1500)
          }
        }
      } catch {}
      try { await client.sendMessage(entity, { message: '/start' }) } catch {}
      await sleep(stepDelay)
      try {
        const after = await client.getMessages(entity, { limit: 3 })
        const botReply = after.find(m => !m.out)
        if (botReply && isQtyPrompt(botReply)) {
          const b = extractInlineButtons(botReply).find(x => /kembali|batal|back|cancel/i.test(x.text))
          if (b) { try { await botReply.click({ text: b.text }) } catch {} ; await sleep(1500) }
          try { await client.sendMessage(entity, { message: '/start' }) } catch {}
          await sleep(stepDelay)
        }
      } catch {}
    }

    // Kirim nomor produk lalu tunggu kartu produk yang BENAR (nama produk harus cocok)
    const fetchProductCard = async (num, expectedName) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (state.cancelRequested) return { card: null, needReset: false }
        let sent
        try {
          sent = await client.sendMessage(entity, { message: String(num) })
        } catch (e) {
          const wait = Number(e?.seconds) ? Number(e.seconds) * 1000 + 1000 : 6000
          await sleep(wait)
          continue
        }
        let card = null; let prompt = null; let flood = false
        const deadline = Date.now() + stepDelay + 6000
        await sleep(1500)
        while (Date.now() < deadline) {
          if (state.cancelRequested) break
          const recentMsgs = await client.getMessages(entity, { limit: 8 })
          const fresh = recentMsgs.filter(m => !m.out && m.id > (sent?.id || 0))
          card = fresh.find(isCardMsg) || null
          prompt = fresh.find(isQtyPrompt) || null
          flood = fresh.some(isFlood)
          if (card || prompt || flood) break
          await sleep(1000)
        }
        if (state.cancelRequested) return { card: null, needReset: false }
        // beri jeda sebentar: kadang prompt "Masukkan jumlah" datang sedetik setelah kartu
        if (card && !prompt) {
          await sleep(1200)
          const again = await client.getMessages(entity, { limit: 8 })
          prompt = again.find(m => !m.out && m.id > (sent?.id || 0) && isQtyPrompt(m)) || null
        }

        const okName = card && sameProduct(cardProductName(txt(card)), expectedName)
        if (card && okName && !prompt && !isTaintedCard(txt(card))) return { card, needReset: hasQtyControls(card) }

        const why = !card ? (prompt ? 'bot pusat minta jumlah pembelian' : flood ? 'anti-flood bot pusat' : 'tidak ada balasan')
          : !okName ? `produk tertukar (dapat "${cardProductName(txt(card))}")`
            : prompt ? 'bot pusat minta jumlah pembelian' : 'kartu berisi jumlah/harga grosir'
        report(`   ⚠️ [${num}] ${why} -> reset & ulangi (${attempt}/3)`)
        await sleep(flood ? 6500 : 1500)
        await resetBotState()
        // percobaan terakhir: jika kartu benar tapi tercemar, tetap kembalikan supaya stok/desk terbaca (harga diabaikan parser)
        if (attempt === 3 && card && okName) return { card, needReset: true }
      }
      return { card: null, needReset: true }
    }

    // Mulai dari kondisi bersih
    await resetBotState()

    let okCount = 0
    let failStreak = 0
    const failed = []
    for (let idx = 0; idx < nums.length; idx++) {
      if (state.cancelRequested) {
        report(`⏹️ Sinkronisasi dihentikan oleh Admin pada produk ke-${idx + 1}/${nums.length}. Menyimpan hasil yang sudah didapat...`, 98)
        break
      }
      // Pengaman: jika bot pusat terus macet, hentikan agar akun Telegram tidak dianggap spam
      if (failStreak >= 4) {
        report('⛔ Bot pusat tidak merespon dengan benar 4x berturut-turut. Sinkron dihentikan, hasil yang sudah terbaca tetap disimpan.')
        for (let j = idx; j < nums.length; j++) failed.push(catalogMap.get(nums[j]).rawName)
        break
      }
      const num = nums[idx]
      const catItem = catalogMap.get(num)
      const failsBefore = failed.length
      const pct = 20 + Math.round(((idx + 1) / nums.length) * 78)
      report(`Mengambil harga [${idx + 1}/${nums.length}]: ${catItem.rawName}...`, pct)
      try {
        const { card, needReset } = await fetchProductCard(num, catItem.rawName)
        if (state.cancelRequested) break
        if (!card) {
          failed.push(catItem.rawName)
          report(`   ❌ [${num}] ${catItem.rawName}: gagal dibaca, harga lama dipertahankan`, pct)
          continue
        }

        const ident = normalizeProductIdentity(catItem.rawName, db.data.list)
        let detail = parseProductDetail(txt(card), [], catItem.rawName, ident.embeddedVariant)

        // AI hanya dipakai bila parser biasa gagal (lebih hemat & tidak mengarang harga)
        const aiKey = s.geminiApiKey || config.geminiApiKey
        if (aiKey && !detail.types.length && !isTaintedCard(txt(card))) {
          try {
            report(`   🤖 AI membantu membaca: ${catItem.rawName}...`, pct)
            const aiResult = await ai.parseWithAI(txt(card), aiKey, s.storeName, config.geminiModel)
            if (aiResult?.types?.length) {
              detail = {
                types: aiResult.types,
                desc: aiResult.desc.length ? aiResult.desc : detail.desc,
                note: aiResult.note || detail.note,
                partial: /variasi\s*:/i.test(txt(card))
              }
            }
          } catch (e) {
            console.error('[AI SYNC ERROR]', e?.message || e)
          }
        }

        syncedMap.set(num, {
          ...catItem,
          stock: detail.stock ?? catItem.stock,
          types: detail.types,
          desc: detail.desc,
          note: detail.note,
          partial: !!detail.partial
        })
        if (detail.types.length) {
          okCount++
          report(`   ✅ ${catItem.rawName}: ${detail.types.map(t => `${t.name} = Rp ${t.basePrice.toLocaleString('id-ID')}${t.stock === 0 ? ' (habis)' : ''}`).join(' | ')}`, pct)
        } else {
          failed.push(catItem.rawName)
          report(`   ❌ ${catItem.rawName}: harga tidak terbaca, harga lama dipertahankan`, pct)
        }

        // Kartu dengan tombol beli/jumlah (format satuan) -> reset dulu agar nomor berikutnya tidak dianggap "jumlah beli"
        if (needReset && !state.cancelRequested) await resetBotState()
      } catch (e) {
        failed.push(catItem.rawName)
        console.error(`[TG-SYNC] Error produk [${num}]`, e?.message || e)
        const wait = Number(e?.seconds) ? Number(e.seconds) * 1000 + 1000 : 3000
        await sleep(wait)
        if (!state.cancelRequested) await resetBotState()
      } finally {
        failStreak = failed.length > failsBefore ? failStreak + 1 : 0
      }
    }
    const wasCancelled = state.cancelRequested
    report(`Ringkasan: ${okCount}/${nums.length} produk terbaca akurat${failed.length ? `, gagal: ${failed.join(', ')}` : ''}`, 99)

    const result = applySyncedProductsToDb([...syncedMap.values()], db, config)
    state.lastSyncAt = Date.now()
    state.lastSyncResult = { ...result, mode: 'full', cancelled: wasCancelled, totalCatalog: nums.length, okCount, failed, botUsername }
    report(`Selesai! ${result.added} produk baru ditambahkan, ${result.updated} produk diperbarui (Untung +Rp ${result.markup.toLocaleString('id-ID')}).`, 100)
    return state.lastSyncResult
  } catch (e) {
    state.lastError = e.message || String(e)
    throw e
  } finally {
    state.syncing = false
    state.cancelRequested = false
    state.progress = ''
    state.progressPct = 0
  }
}

// Jadwal sinkronisasi otomatis berkala (bisa dinyalakan/dimatikan kapan saja lewat Web / WA)
function setupAutoSync ({ db, config, onAutoSyncDone } = {}) {
  if (typeof onAutoSyncDone === 'function') state.onAutoSyncDone = onAutoSyncDone
  clearInterval(state.autoTimer)
  state.autoTimer = null
  state.nextAutoSyncAt = 0
  const s = db.data.settings
  const hours = Number(s.tgAutoSyncHours ?? config.tgAutoSyncHours ?? 6)
  const enabled = s.tgAutoSyncEnabled !== undefined ? !!s.tgAutoSyncEnabled : hours > 0
  if (!enabled || !hours || hours <= 0 || !hasSession()) return
  const ms = Math.max(1, hours) * 3600 * 1000
  state.nextAutoSyncAt = Date.now() + ms
  state.autoTimer = setInterval(() => {
    state.nextAutoSyncAt = Date.now() + ms
    if (!state.syncing && hasSession()) {
      syncFromTelegram({ db, config })
        .then(res => {
          if (typeof state.onAutoSyncDone === 'function') {
            try { state.onAutoSyncDone(res) } catch {}
          }
        })
        .catch(e => console.error('[TG AUTO-SYNC GAGAL]', e?.message || e))
    }
  }, ms)
  state.autoTimer.unref?.()
}

function statusInfo (db, config = {}) {
  const s = db?.data?.settings || {}
  const hours = Number(s.tgAutoSyncHours ?? config.tgAutoSyncHours ?? 6) || 6
  const autoSyncEnabled = s.tgAutoSyncEnabled !== undefined ? !!s.tgAutoSyncEnabled : Number(s.tgAutoSyncHours ?? config.tgAutoSyncHours ?? 0) > 0
  return {
    loggedIn: hasSession(),
    pendingPhone: state.pendingLogin?.phone || '',
    needPassword: !!state.pendingLogin?.needPasswordOnly,
    syncing: state.syncing,
    syncMode: state.syncMode,
    progress: state.progress,
    progressPct: state.progressPct,
    lastSyncAt: s.lastTelegramSync || state.lastSyncAt || 0,
    lastSyncResult: state.lastSyncResult,
    lastError: state.lastError,
    botUsername: s.tgBotUsername || config.tgBotUsername || 'FebrianStore1_Bot',
    syncMarkup: Number(s.syncMarkup ?? config.syncMarkup ?? 5000),
    autoSyncEnabled,
    autoSyncHours: hours,
    nextAutoSyncAt: autoSyncEnabled && hasSession() ? state.nextAutoSyncAt : 0
  }
}

module.exports = {
  startLogin,
  verifyLoginCode,
  logoutTelegram,
  syncFromTelegram,
  stopSync,
  importFromPastedText,
  recalculateMarkupPrices,
  ensureBasePrices,
  setupAutoSync,
  statusInfo,
  hasSession,
  sanitizeSupplierText,
  parseNominal
}
