// =============================================
//  WEB DASHBOARD (dinyalakan admin lewat WA: .web on / .web off)
//  - Server hanya hidup saat dibutuhkan, mati otomatis setelah X menit
//  - Login pakai PIN acak (dibuat ulang setiap .web on)
//  - Akses dari mana saja lewat Cloudflare Quick Tunnel (gratis)
// =============================================
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { normKey } = require('./db')
const { INFO_KEYS, render, totalItemStock } = require('./product')
const { startTunnel } = require('./tunnel')
const tgsync = require('./tgsync')
const ai = require('./ai')

const ROOT = path.join(__dirname, '..')
const MEDIA_DIR = path.join(ROOT, 'media')
const HTML_FILE = path.join(ROOT, 'web', 'index.html')
const MAX_BODY = 12 * 1024 * 1024
const SESSION_MS = 12 * 3600 * 1000

// state disimpan di level modul supaya tetap ada walau bot reconnect
const state = {
  server: null,
  port: 0,
  pin: '',
  sessions: new Map(), // token -> expires
  fails: new Map(), // ip -> { n, until }
  tunnel: null,
  publicUrl: '',
  tunnelError: '',
  startedAt: 0,
  expiresAt: 0,
  offTimer: null,
  starting: null,
  ctx: null // { db, config }
}
let bridge = {} // diisi handler: { notify, fill, buildMenu, status }

function attach (b) { bridge = { ...bridge, ...b } }
function isRunning () { return !!state.server }

function info () {
  return {
    running: isRunning(),
    localUrl: state.port ? `http://localhost:${state.port}` : '',
    publicUrl: state.publicUrl,
    tunnelError: state.tunnelError,
    pin: state.pin,
    expiresAt: state.expiresAt,
    startedAt: state.startedAt
  }
}

// ---------------- helper http ----------------
function send (res, code, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  })
  res.end(body)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('Data terlalu besar (maks 12 MB)')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('Format data salah')) }
    })
    req.on('error', reject)
  })
}

function parseCookies (req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function clientIp (req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
}

function isAuthed (req) {
  const tok = parseCookies(req).sid
  if (!tok) return false
  const exp = state.sessions.get(tok)
  if (!exp || exp < Date.now()) { state.sessions.delete(tok); return false }
  return true
}

function safeEqual (a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

// ---------------- data ----------------
function S () { return state.ctx.db.data.settings }

function productView (key, it) {
  return {
    key,
    name: it.name,
    title: it.title || '',
    mode: it.types || it.variants ? 'auto' : 'raw',
    types: (it.types || []).map(t => ({
      name: t.name || '',
      price: t.price || '',
      basePrice: t.basePrice !== undefined ? Number(t.basePrice) : null,
      stock: t.stock !== undefined && t.stock !== null ? Number(t.stock) : null
    })),
    desc: it.desc || [],
    note: it.note || '',
    text: it.text || '',
    image: it.image || null,
    info: INFO_KEYS.includes(key),
    syncLocked: !!it.syncLocked,
    stockLocked: !!it.stockLocked,
    supplierStock: it.supplierStock !== undefined && it.supplierStock !== null ? Number(it.supplierStock) : null,
    totalStock: totalItemStock(it),
    lastSyncedAt: it.lastSyncedAt || 0,
    updatedAt: it.updatedAt || 0
  }
}

function settingsView () {
  const s = S(); const cfg = state.ctx.config
  const hours = Number(s.tgAutoSyncHours ?? cfg.tgAutoSyncHours ?? 6)
  return {
    storeName: s.storeName,
    menuTemplate: s.menuTemplate || '',
    itemFooter: s.itemFooter || '',
    autoReply: !!s.autoReply,
    autoReplyText: s.autoReplyText || '',
    defaultWelcome: s.defaultWelcome || '',
    stickerEnabled: s.stickerEnabled !== false,
    stickerLimit: Number(s.stickerLimit ?? cfg.stickerDailyLimit ?? 5),
    stickerPack: s.stickerPack || '',
    stickerAuthor: s.stickerAuthor || '',
    stickerMenuText: s.stickerMenuText || '',
    privateMarkup: Number(s.privateMarkup ?? cfg.privateMarkup ?? 0),
    syncMarkup: Number(s.syncMarkup ?? cfg.syncMarkup ?? 5000),
    tgBotUsername: s.tgBotUsername || cfg.tgBotUsername || 'FebrianStore1_Bot',
    tgAutoSyncEnabled: s.tgAutoSyncEnabled !== undefined ? !!s.tgAutoSyncEnabled : hours > 0,
    tgAutoSyncHours: hours > 0 ? hours : 6,
    geminiApiKey: s.geminiApiKey || cfg.geminiApiKey || ''
  }
}

function stateView () {
  const db = state.ctx.db
  const list = db.data.list || {}
  const products = []; const infos = []
  for (const [k, it] of Object.entries(list)) (INFO_KEYS.includes(k) ? infos : products).push(productView(k, it))
  products.sort((a, b) => a.name.localeCompare(b.name, 'id'))
  const orders = Object.values(db.data.orders || {})
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const usage = db.data.stickerUsage || {}
  return {
    settings: settingsView(),
    products,
    infos,
    tgsync: tgsync.statusInfo(db, state.ctx.config),
    stats: {
      products: products.length,
      pending: orders.filter(o => o.status === 'pending').length,
      processing: orders.filter(o => o.status === 'processing').length,
      doneToday: orders.filter(o => o.status === 'done' && (o.doneAt || 0) >= today.getTime()).length,
      totalOrders: orders.length,
      stickersToday: Object.values(usage.counts || {}).reduce((a, b) => a + b, 0)
    },
    admins: {
      owner: (state.ctx.config.owner || []),
      extra: db.data.admins || []
    },
    bot: typeof bridge.status === 'function' ? bridge.status() : {},
    web: { expiresAt: state.expiresAt, publicUrl: state.publicUrl }
  }
}

function saveDataUrlImage (name, dataUrl, oldFile) {
  const m = String(dataUrl).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i)
  if (!m) throw new Error('Format gambar tidak didukung (pakai JPG/PNG)')
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 8 * 1024 * 1024) throw new Error('Gambar terlalu besar (maks 8 MB)')
  const safe = normKey(name).replace(/[^a-z0-9]+/g, '_').slice(0, 40) || 'item'
  const file = `${safe}_${Date.now()}.${m[1].toLowerCase() === 'png' ? 'png' : 'jpg'}`
  fs.mkdirSync(MEDIA_DIR, { recursive: true })
  fs.writeFileSync(path.join(MEDIA_DIR, file), buf)
  if (oldFile) removeImage(oldFile)
  return file
}

function removeImage (file) {
  try { if (file && !file.includes('..')) fs.unlinkSync(path.join(MEDIA_DIR, file)) } catch {}
}

function cleanLines (v) {
  return (Array.isArray(v) ? v : String(v || '').split('\n')).map(s => String(s).trim()).filter(Boolean)
}

function buildItem (body, old = {}) {
  const item = { ...old }
  delete item.variants
  if (body.mode === 'raw') {
    item.text = String(body.text || '').trim()
    if (!item.text) throw new Error('Isi teks produk belum diisi')
    delete item.types; delete item.desc; delete item.note
  } else {
    const markup = Number(S().syncMarkup ?? state.ctx.config.syncMarkup ?? 5000)
    const oldTypes = Array.isArray(old.types) ? old.types : []
    let stockChanged = false
    const types = (Array.isArray(body.types) ? body.types : [])
      .map(t => {
        const name = String(t.name || '').trim()
        const price = String(t.price || '').trim()
        const prev = oldTypes.find(o => normKey(o.name) === normKey(name))
        let basePrice = t.basePrice !== undefined && t.basePrice !== null && t.basePrice !== ''
          ? Number(String(t.basePrice).replace(/\D/g, ''))
          : (prev?.basePrice !== undefined ? Number(prev.basePrice) : undefined)
        const numPrice = tgsync.parseNominal(price)
        if (!basePrice && numPrice > markup) basePrice = numPrice - markup
        const out = { name, price }
        if (basePrice && basePrice > 0) out.basePrice = basePrice
        if (!prev && oldTypes.length) out.manualVariant = true
        else if (prev?.manualVariant) out.manualVariant = true
        if (t.stock === '' || t.stock === null) {
          // sengaja dikosongkan -> tanpa batas stok
          if (prev?.stock !== undefined && prev?.stock !== null) stockChanged = true
        } else if (t.stock !== undefined) {
          const st = Math.floor(Number(t.stock))
          if (Number.isFinite(st) && st >= 0) {
            out.stock = st
            if (prev && Number(prev.stock) !== st) stockChanged = true
            if (!prev) stockChanged = true
          }
        } else if (prev?.stock !== undefined && prev?.stock !== null) {
          out.stock = prev.stock
        }
        return out
      })
      .filter(t => t.name || t.price)
    if (!types.length) throw new Error('Minimal isi 1 jenis & harga')
    const noPrice = types.filter(t => !t.price)
    if (noPrice.length) throw new Error('Harga belum diisi untuk: ' + noPrice.map(t => t.name).join(', '))
    item.types = types
    const tracked = types.filter(t => t.stock !== undefined && t.stock !== null && Number.isFinite(Number(t.stock)))
    item.supplierStock = tracked.length
      ? tracked.reduce((sum, t) => sum + Math.max(0, Number(t.stock)), 0)
      : null
    if (typeof body.stockLocked === 'boolean') item.stockLocked = body.stockLocked
    else if (stockChanged) item.stockLocked = true
    const nextDesc = cleanLines(body.desc)
    if (old && JSON.stringify(nextDesc) !== JSON.stringify(old.desc || [])) {
      item.manualDesc = true
    }
    item.desc = nextDesc
    item.note = String(body.note || '').trim()
    delete item.text
  }
  if (typeof body.syncLocked === 'boolean') item.syncLocked = body.syncLocked
  const title = String(body.title || '').trim()
  if (title) item.title = title.toUpperCase(); else delete item.title
  return item
}

// ---------------- API ----------------
async function api (req, res, url) {
  const db = state.ctx.db
  const method = req.method
  const p = url.pathname

  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req)
    const f = state.fails.get(ip) || { n: 0, until: 0 }
    if (f.until > Date.now()) return send(res, 429, { error: `Terlalu banyak percobaan salah. Coba lagi ${Math.ceil((f.until - Date.now()) / 60000)} menit lagi.` })
    const body = await readBody(req)
    if (!state.pin || !safeEqual(String(body.pin || '').trim(), state.pin)) {
      f.n++
      if (f.n >= 5) { f.until = Date.now() + 10 * 60000; f.n = 0 }
      state.fails.set(ip, f)
      return send(res, 401, { error: 'PIN salah' })
    }
    state.fails.delete(ip)
    const tok = crypto.randomBytes(24).toString('hex')
    state.sessions.set(tok, Date.now() + SESSION_MS)
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || !!req.headers['cf-ray']
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`
    })
  }

  if (p === '/api/public' && method === 'GET') {
    return send(res, 200, { storeName: S().storeName, authed: isAuthed(req) })
  }

  if (!isAuthed(req)) return send(res, 401, { error: 'Silakan login dulu' })

  // cegah request lintas situs untuk aksi yang mengubah data
  if (method !== 'GET') {
    const origin = req.headers.origin
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Ditolak' })
  }

  if (p === '/api/logout' && method === 'POST') {
    state.sessions.delete(parseCookies(req).sid)
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' })
  }

  if (p === '/api/state' && method === 'GET') return send(res, 200, stateView())

  if (p === '/api/preview' && method === 'POST') {
    const body = await readBody(req)
    const item = body.mode === 'raw'
      ? { text: String(body.text || '') }
      : {
          types: (Array.isArray(body.types) ? body.types : [])
            .map(t => ({
              name: String(t.name || '').trim(),
              price: String(t.price || '').trim(),
              stock: t.stock !== undefined && t.stock !== null && t.stock !== '' ? Number(t.stock) : null
            }))
            .filter(t => t.name || t.price),
          desc: cleanLines(body.desc),
          note: String(body.note || '').trim()
        }
    if (String(body.title || '').trim()) item.title = String(body.title).trim().toUpperCase()
    item.name = String(body.name || '').toUpperCase()
    const extraPrice = body.outsideGroup ? Number(S().privateMarkup ?? state.ctx.config.privateMarkup ?? 0) : 0
    let text = render(item, S(), { extraPrice })
    if (typeof bridge.fill === 'function') text = bridge.fill(text)
    return send(res, 200, { text })
  }

  if (p === '/api/menu-preview' && (method === 'GET' || method === 'POST')) {
    const ov = method === 'POST' ? await readBody(req) : {}
    const text = typeof bridge.buildMenu === 'function' ? bridge.buildMenu('62812xxxx@s.whatsapp.net', ov) : ''
    return send(res, 200, { text })
  }

  if (p === '/api/product' && method === 'POST') {
    const body = await readBody(req)
    const origKey = body.originalKey ? String(body.originalKey) : null
    const old = origKey ? db.data.list[origKey] : null
    if (origKey && !old) return send(res, 404, { error: 'Produk tidak ditemukan (mungkin sudah dihapus)' })
    const isInfo = origKey && INFO_KEYS.includes(origKey)
    const name = isInfo ? old.name : String(body.name || '').trim()
    if (!name) return send(res, 400, { error: 'Nama produk belum diisi' })
    const newKey = isInfo ? origKey : normKey(name)
    if (INFO_KEYS.includes(newKey) && !isInfo) return send(res, 400, { error: `Nama "${name}" dipakai sistem, pilih nama lain` })
    if (newKey !== origKey && db.data.list[newKey]) return send(res, 409, { error: `Produk "${name.toUpperCase()}" sudah ada` })
    let item
    try { item = buildItem(isInfo ? { ...body, mode: 'raw' } : body, old || {}) } catch (e) { return send(res, 400, { error: e.message }) }
    item.name = isInfo ? old.name : name.toUpperCase()
    try {
      if (body.image) item.image = saveDataUrlImage(newKey, body.image, old?.image)
      else if (body.removeImage) { removeImage(old?.image); item.image = null }
    } catch (e) { return send(res, 400, { error: e.message }) }
    if (origKey && origKey !== newKey) delete db.data.list[origKey]
    db.data.list[newKey] = { ...item, updatedAt: Date.now() }
    db.save()
    return send(res, 200, { ok: true, product: productView(newKey, db.data.list[newKey]) })
  }

  if (p === '/api/product' && method === 'DELETE') {
    const key = url.searchParams.get('key')
    if (!key || !db.data.list[key]) return send(res, 404, { error: 'Produk tidak ditemukan' })
    if (INFO_KEYS.includes(key)) return send(res, 400, { error: 'Info ini tidak boleh dihapus' })
    removeImage(db.data.list[key].image)
    delete db.data.list[key]
    db.save()
    return send(res, 200, { ok: true })
  }

  if (p === '/api/product/lock' && method === 'POST') {
    const body = await readBody(req)
    const key = String(body.key || '')
    if (body.all === true) {
      const lock = !!body.syncLocked
      for (const [k, it] of Object.entries(db.data.list || {})) {
        if (!INFO_KEYS.includes(k)) it.syncLocked = lock
      }
      db.save()
      return send(res, 200, { ok: true, state: stateView() })
    }
    const it = db.data.list[key]
    if (!it || INFO_KEYS.includes(key)) return send(res, 404, { error: 'Produk tidak ditemukan' })
    it.syncLocked = typeof body.syncLocked === 'boolean' ? body.syncLocked : !it.syncLocked
    it.updatedAt = Date.now()
    db.save()
    return send(res, 200, { ok: true, product: productView(key, it), state: stateView() })
  }

  if (p === '/api/product/stock' && method === 'POST') {
    const body = await readBody(req)
    const key = String(body.key || '')
    const it = db.data.list[key]
    if (!it || INFO_KEYS.includes(key)) return send(res, 404, { error: 'Produk tidak ditemukan' })
    const types = Array.isArray(it.types) ? it.types : []

    if (Array.isArray(body.stocks)) {
      types.forEach((t, i) => {
        if (i >= body.stocks.length) return
        const val = body.stocks[i]
        if (val === null || val === '' || val === undefined) {
          delete t.stock
        } else {
          const st = Math.max(0, Math.floor(Number(val) || 0))
          t.stock = st
        }
      })
    } else if (body.uniformStock !== undefined) {
      if (body.uniformStock === null || body.uniformStock === '') {
        types.forEach(t => { delete t.stock })
        it.supplierStock = null
      } else {
        const st = Math.max(0, Math.floor(Number(body.uniformStock) || 0))
        types.forEach(t => { t.stock = st })
      }
    } else if (body.deltaStock !== undefined) {
      const d = Math.floor(Number(body.deltaStock) || 0)
      types.forEach(t => {
        const cur = Number.isFinite(Number(t.stock)) ? Number(t.stock) : 0
        t.stock = Math.max(0, cur + d)
      })
    }

    const tracked = types.filter(t => t.stock !== undefined && t.stock !== null && Number.isFinite(Number(t.stock)))
    it.supplierStock = tracked.length
      ? tracked.reduce((sum, t) => sum + Math.max(0, Number(t.stock)), 0)
      : null
    it.stockLocked = typeof body.stockLocked === 'boolean' ? body.stockLocked : true
    it.updatedAt = Date.now()
    db.save()
    return send(res, 200, { ok: true, product: productView(key, it), state: stateView() })
  }

  if (p === '/api/settings' && method === 'POST') {
    const body = await readBody(req)
    const s = S()
    const str = (k, max = 4000) => { if (typeof body[k] === 'string') s[k] = body[k].slice(0, max) }
    if (typeof body.storeName === 'string') {
      if (!body.storeName.trim()) return send(res, 400, { error: 'Nama toko tidak boleh kosong' })
      s.storeName = body.storeName.trim().slice(0, 80)
    }
    str('menuTemplate'); str('itemFooter'); str('autoReplyText'); str('defaultWelcome')
    str('stickerPack', 60); str('stickerAuthor', 60); str('stickerMenuText', 1000)
    if (typeof body.autoReply === 'boolean') s.autoReply = body.autoReply
    if (typeof body.stickerEnabled === 'boolean') s.stickerEnabled = body.stickerEnabled
    if (body.stickerLimit !== undefined) {
      const n = Math.floor(Number(body.stickerLimit))
      if (!(n >= 0 && n <= 100)) return send(res, 400, { error: 'Limit stiker harus 0 - 100' })
      s.stickerLimit = n
    }
    if (body.privateMarkup !== undefined) {
      const n = Math.floor(Number(body.privateMarkup))
      if (!(n >= 0 && n <= 10000000)) return send(res, 400, { error: 'Selisih harga harus 0 - 10.000.000' })
      if (n !== Number(s.privateMarkup ?? 0)) s.privateMarkupCustom = true
      s.privateMarkup = n
    }
    if (body.syncMarkup !== undefined) {
      const n = Math.floor(Number(body.syncMarkup))
      if (!(n >= 0 && n <= 10000000)) return send(res, 400, { error: 'Untung reseller harus 0 - 10.000.000' })
      const prevMarkup = Number(s.syncMarkup ?? state.ctx.config.syncMarkup ?? 5000)
      s.syncMarkup = n
      if (n !== prevMarkup && body.recalcPrices !== false) {
        tgsync.recalculateMarkupPrices(db, n)
      }
    }
    if (typeof body.tgBotUsername === 'string' && body.tgBotUsername.trim()) {
      s.tgBotUsername = body.tgBotUsername.replace(/^@|^https?:\/\/t\.me\//i, '').trim().slice(0, 64)
    }
    if (typeof body.tgAutoSyncEnabled === 'boolean') {
      s.tgAutoSyncEnabled = body.tgAutoSyncEnabled
    }
    if (body.tgAutoSyncHours !== undefined) {
      const h = Math.max(0, Math.min(168, Math.floor(Number(body.tgAutoSyncHours) || 0)))
      if (h === 0) {
        s.tgAutoSyncEnabled = false
      } else {
        s.tgAutoSyncHours = h
        if (body.tgAutoSyncEnabled === undefined) s.tgAutoSyncEnabled = true
      }
    }
    tgsync.setupAutoSync({ db, config: state.ctx.config })
    if (typeof body.geminiApiKey === 'string') {
      s.geminiApiKey = body.geminiApiKey.trim().slice(0, 200)
    }
    db.save()
    return send(res, 200, { ok: true, settings: settingsView(), state: stateView() })
  }

  // -------- API Sinkronisasi Otomatis Telegram & Untung Reseller --------
  if (p === '/api/tg/status' && method === 'GET') {
    return send(res, 200, {
      tgsync: tgsync.statusInfo(db, state.ctx.config),
      productsCount: Object.keys(db.data.list || {}).filter(k => !INFO_KEYS.includes(k)).length
    })
  }

  if (p === '/api/tg/autosync' && method === 'POST') {
    const body = await readBody(req)
    const s = S()
    if (typeof body.enabled === 'boolean') {
      s.tgAutoSyncEnabled = body.enabled
    } else {
      s.tgAutoSyncEnabled = !(s.tgAutoSyncEnabled !== false && Number(s.tgAutoSyncHours ?? 6) > 0)
    }
    if (body.hours !== undefined) {
      const h = Math.max(1, Math.min(168, Math.floor(Number(body.hours) || 6)))
      s.tgAutoSyncHours = h
    } else if (s.tgAutoSyncEnabled && (!s.tgAutoSyncHours || Number(s.tgAutoSyncHours) <= 0)) {
      s.tgAutoSyncHours = Number(state.ctx.config.tgAutoSyncHours) || 6
    }
    db.save()
    tgsync.setupAutoSync({ db, config: state.ctx.config })
    return send(res, 200, {
      ok: true,
      tgsync: tgsync.statusInfo(db, state.ctx.config),
      settings: settingsView(),
      state: stateView()
    })
  }

  if (p === '/api/tg/stop' && method === 'POST') {
    const stopped = tgsync.stopSync()
    return send(res, 200, { ok: true, stopped, tgsync: tgsync.statusInfo(db, state.ctx.config) })
  }

  if (p === '/api/tg/login' && method === 'POST') {
    const body = await readBody(req)
    try {
      const r = await tgsync.startLogin(body.phone, state.ctx.config)
      return send(res, 200, { ...r, tgsync: tgsync.statusInfo(db, state.ctx.config) })
    } catch (e) {
      return send(res, 400, { error: e.message || 'Gagal mengirim OTP Telegram' })
    }
  }

  if (p === '/api/tg/verify' && method === 'POST') {
    const body = await readBody(req)
    try {
      const r = await tgsync.verifyLoginCode(body.code, body.password)
      if (!r.needPassword) tgsync.setupAutoSync({ db, config: state.ctx.config })
      return send(res, 200, { ...r, tgsync: tgsync.statusInfo(db, state.ctx.config) })
    } catch (e) {
      return send(res, 400, { error: e.message || 'Gagal verifikasi OTP Telegram' })
    }
  }

  if (p === '/api/tg/logout' && method === 'POST') {
    await tgsync.logoutTelegram()
    tgsync.setupAutoSync({ db, config: state.ctx.config })
    return send(res, 200, { ok: true, tgsync: tgsync.statusInfo(db, state.ctx.config) })
  }

  if (p === '/api/tg/sync' && method === 'POST') {
    const body = await readBody(req)
    const s = S()
    if (body.syncMarkup !== undefined) {
      const m = Math.floor(Number(body.syncMarkup))
      if (m >= 0 && m <= 10000000) s.syncMarkup = m
    }
    if (typeof body.tgBotUsername === 'string' && body.tgBotUsername.trim()) {
      s.tgBotUsername = body.tgBotUsername.replace(/^@|^https?:\/\/t\.me\//i, '').trim().slice(0, 64)
    }
    db.save()
    const st = tgsync.statusInfo(db, state.ctx.config)
    if (st.syncing) return send(res, 200, { ok: true, started: false, tgsync: st })
    if (!st.loggedIn) return send(res, 400, { error: 'Silakan login akun Telegram terlebih dahulu di kartu Sinkron Telegram.' })

    const syncMode = body.mode === 'stock' ? 'stock' : 'full'
    // Jalankan di background agar browser tidak timeout, web dapat memantau progres lewat /api/tg/status
    tgsync.syncFromTelegram({ db, config: state.ctx.config, mode: syncMode }).then((resSync) => {
      if (typeof bridge.notify === 'function') {
        const title = resSync.cancelled
          ? '⏹️ *SINKRONISASI DIHENTIKAN (SEBAGIAN TERSIMPAN)*'
          : syncMode === 'stock'
            ? '⚡ *SINKRON STOK CEPAT SELESAI!*'
            : '✅ *SINKRONISASI TELEGRAM SELESAI!*'
        bridge.notify(`${title}\n➕ Produk baru: *${resSync.added}*\n🔄 Diperbarui: *${resSync.updated}*\n💰 Untung Reseller: *+Rp ${resSync.markup.toLocaleString('id-ID')}/produk*`)
      }
    }).catch(e => {
      console.error('[WEB TG-SYNC GAGAL]', e?.message || e)
    })

    return send(res, 200, { ok: true, started: true, tgsync: tgsync.statusInfo(db, state.ctx.config) })
  }

  if (p === '/api/tg/import' && method === 'POST') {
    const body = await readBody(req)
    try {
      if (body.syncMarkup !== undefined) {
        const m = Math.floor(Number(body.syncMarkup))
        if (m >= 0 && m <= 10000000) S().syncMarkup = m
      }
      const resImp = tgsync.importFromPastedText(body.text, db, state.ctx.config, {
        productName: body.productName || '',
        forceOverwrite: !!body.forceOverwrite,
        stockMode: body.stockMode || 'replace'
      })
      return send(res, 200, { ok: true, result: resImp, state: stateView() })
    } catch (e) {
      return send(res, 400, { error: e.message || 'Gagal mengimpor teks produk' })
    }
  }

  if (p === '/api/tg/markup' && method === 'POST') {
    const body = await readBody(req)
    const n = Math.floor(Number(body.syncMarkup))
    if (!(n >= 0 && n <= 10000000)) return send(res, 400, { error: 'Nominal untung tidak valid' })
    const updatedCount = tgsync.recalculateMarkupPrices(db, n)
    return send(res, 200, { ok: true, updatedCount, state: stateView() })
  }
  if (p === '/api/ai/test' && method === 'POST') {
    const body = await readBody(req)
    const apiKey = String(body.apiKey || S().geminiApiKey || state.ctx.config.geminiApiKey || '').trim()
    if (!apiKey) return send(res, 400, { error: 'API Key Gemini belum diisi.' })
    const result = await ai.testApiKey(apiKey, state.ctx.config.geminiModel)
    return send(res, result.ok ? 200 : 400, result)
  }

  if (p === '/api/orders' && method === 'GET') {
    const orders = Object.values(db.data.orders || {})
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 200)
      .map(o => ({
        id: o.id,
        buyerName: o.buyerName,
        buyerPhone: o.buyerPhone,
        itemText: o.itemText,
        status: o.status,
        createdAt: o.createdAt,
        doneAt: o.doneAt,
        isGroup: o.isGroup,
        groupName: o.groupName,
        proofImage: o.proofImage,
        deliveryText: o.deliveryText || '',
        cancelReason: o.cancelReason || ''
      }))
    return send(res, 200, { orders })
  }

  if (p === '/api/order-action' && method === 'POST') {
    if (typeof bridge.orderAction !== 'function') return send(res, 503, { error: 'Bot belum siap' })
    const body = await readBody(req)
    let imageBuf = null
    if (body.image) {
      const m = String(body.image).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i)
      if (!m) return send(res, 400, { error: 'Format gambar tidak didukung' })
      imageBuf = Buffer.from(m[2], 'base64')
    }
    try {
      const resOrd = await bridge.orderAction({
        id: String(body.id || ''),
        action: String(body.action || ''),
        text: String(body.text || ''),
        imageBuf
      })
      return send(res, 200, { ok: true, result: resOrd })
    } catch (e) {
      return send(res, 400, { error: e.message || 'Gagal memproses pesanan' })
    }
  }

  if (p === '/api/admin' && method === 'POST') {
    const body = await readBody(req)
    let num = String(body.number || '').replace(/\D/g, '')
    if (num.startsWith('0')) num = '62' + num.slice(1)
    else if (num.startsWith('8')) num = '62' + num
    if (!/^\d{9,15}$/.test(num)) return send(res, 400, { error: 'Nomor WhatsApp tidak valid (contoh: 08123456789)' })
    db.data.admins = db.data.admins || []
    if (!db.data.admins.includes(num)) db.data.admins.push(num)
    db.save()
    return send(res, 200, { ok: true, admins: db.data.admins })
  }

  if (p === '/api/admin' && method === 'DELETE') {
    const num = String(url.searchParams.get('number') || '').replace(/\D/g, '')
    db.data.admins = (db.data.admins || []).filter(x => x !== num)
    db.save()
    return send(res, 200, { ok: true, admins: db.data.admins })
  }

  if (p === '/api/backup' && method === 'GET') {
    const fn = `backup-db-${new Date().toISOString().slice(0, 10)}.json`
    return send(res, 200, fs.readFileSync(db.file), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fn}"`
    })
  }

  if (p === '/api/web/extend' && method === 'POST') {
    scheduleOff(state.ctx.minutes || 60)
    return send(res, 200, { ok: true, expiresAt: state.expiresAt })
  }

  return send(res, 404, { error: 'Tidak ditemukan' })
}

async function onRequest (req, res) {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)

    if (url.pathname.startsWith('/media/')) {
      if (!isAuthed(req)) return send(res, 401, 'Silakan login dulu')
      const file = path.basename(decodeURIComponent(url.pathname.slice(7)))
      const full = path.join(MEDIA_DIR, file)
      if (!fs.existsSync(full)) return send(res, 404, 'Tidak ada')
      const ext = path.extname(file).toLowerCase()
      return send(res, 200, fs.readFileSync(full), {
        'Content-Type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
        'Cache-Control': 'private, max-age=3600'
      })
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(HTML_FILE), {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY'
      })
    }
    if (url.pathname === '/manifest.json') {
      return send(res, 200, {
        name: S().storeName + ' Admin', short_name: 'Bot Admin', start_url: '/', display: 'standalone',
        background_color: '#0f172a', theme_color: '#10b981'
      })
    }
    return send(res, 404, 'Tidak ditemukan')
  } catch (e) {
    return send(res, 500, { error: e.message || 'Terjadi kesalahan' })
  }
}

// ---------------- nyala / mati ----------------
function listen (server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e) }
    const onOk = () => { server.removeListener('error', onErr); resolve(port) }
    server.once('error', onErr)
    server.once('listening', onOk)
    server.listen(port, host)
  })
}

function scheduleOff (minutes) {
  clearTimeout(state.offTimer)
  state.expiresAt = Date.now() + minutes * 60000
  state.offTimer = setTimeout(() => {
    stop('timeout')
    if (typeof bridge.notify === 'function') {
      bridge.notify('⏰ *Web Dashboard dimatikan otomatis* (waktu habis).\nKetik *.web on* untuk menyalakan lagi.')
    }
  }, minutes * 60000)
}

async function connectTunnel () {
  if (state.publicUrl || !state.server || state.ctx?.config?.webTunnel === false) return
  try {
    state.tunnelError = ''
    const t = await startTunnel(state.port)
    if (!state.server) { t.stop(); return }
    state.tunnel = t
    state.publicUrl = t.url
    console.log(`[WEB] Link online: ${t.url}`)
    t.proc.on('exit', () => {
      if (state.tunnel === t) { state.tunnel = null; state.publicUrl = ''; state.tunnelError = 'Tunnel terputus' }
    })
  } catch (e) {
    state.tunnelError = e.message
    console.log('[WEB] Tunnel gagal:', e.message)
  }
}

async function start ({ db, config, minutes }) {
  if (state.starting) return state.starting
  if (isRunning()) {
    scheduleOff(minutes)
    if (!state.publicUrl && config.webTunnel !== false) await connectTunnel()
    return info()
  }
  state.starting = (async () => {
    state.ctx = { db, config, minutes }
    const server = http.createServer(onRequest)
    server.requestTimeout = 60000
    const host = config.webHost || '127.0.0.1'
    let port = Number(config.webPort || 3000)
    for (let i = 0; i < 10; i++) {
      try { await listen(server, port, host); break } catch (e) {
        if (e.code !== 'EADDRINUSE' || i === 9) throw e
        port++
      }
    }
    state.server = server
    state.port = port
    state.pin = String(crypto.randomInt(100000, 1000000))
    state.sessions.clear()
    state.fails.clear()
    state.startedAt = Date.now()
    state.publicUrl = ''
    state.tunnelError = ''
    scheduleOff(minutes)
    console.log(`[WEB] Dashboard aktif di http://localhost:${port}`)

    await connectTunnel()
    return info()
  })()
  try { return await state.starting } catch (e) { stop('error'); throw e } finally { state.starting = null }
}

function stop (reason = 'manual') {
  clearTimeout(state.offTimer)
  state.offTimer = null
  if (state.tunnel) { state.tunnel.stop(); state.tunnel = null }
  if (state.server) {
    try { state.server.close() } catch {}
    try { state.server.closeAllConnections?.() } catch {}
    console.log(`[WEB] Dashboard dimatikan (${reason}).`)
  }
  const wasRunning = !!state.server
  state.server = null
  state.port = 0
  state.pin = ''
  state.publicUrl = ''
  state.expiresAt = 0
  state.sessions.clear()
  return wasRunning
}

process.on('exit', () => { try { state.tunnel?.stop() } catch {} })

module.exports = { start, stop, info, isRunning, attach }
