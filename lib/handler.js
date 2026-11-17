const fs = require('fs')
const path = require('path')
const { normKey, DEFAULT_MENU, DEFAULT_FOOTER, DEFAULT_PROSES, DEFAULT_DONE, DEFAULT_WELCOME, DEFAULT_AUTOREPLY, DEFAULT_STICKER_MENU } = require('./db')
const { INFO_KEYS, render, parseQuick, parseTypes, toQuick, toTypesItem, splitLines, isItemOutOfStock, minItemPrice, totalItemStock } = require('./product')
const web = require('./web')
const { makeSticker } = require('./sticker')
const tgsync = require('./tgsync')
const ai = require('./ai')

const WIZARD_TIMEOUT = 10 * 60 * 1000

const MEDIA_DIR = path.join(__dirname, '..', 'media')
fs.mkdirSync(MEDIA_DIR, { recursive: true })

// ---------------- util ----------------
function digits (s) {
  return String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

function normPhone (s) {
  let d = String(s || '').replace(/\D/g, '')
  if (d.startsWith('0')) d = '62' + d.slice(1)
  else if (d.startsWith('8')) d = '62' + d
  return d
}

function unwrap (msg) {
  let c = msg
  for (let i = 0; i < 6 && c; i++) {
    if (c.ephemeralMessage) c = c.ephemeralMessage.message
    else if (c.viewOnceMessage) c = c.viewOnceMessage.message
    else if (c.viewOnceMessageV2) c = c.viewOnceMessageV2.message
    else if (c.viewOnceMessageV2Extension) c = c.viewOnceMessageV2Extension.message
    else if (c.documentWithCaptionMessage) c = c.documentWithCaptionMessage.message
    else break
  }
  return c || {}
}

function getText (c) {
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    c.buttonsResponseMessage?.selectedButtonId ||
    c.listResponseMessage?.singleSelectReply?.selectedRowId ||
    c.templateButtonReplyMessage?.selectedId ||
    ''
  )
}

function getContext (c) {
  for (const k of Object.keys(c)) {
    if (c[k] && typeof c[k] === 'object' && c[k].contextInfo) return c[k].contextInfo
  }
  return null
}

function timeParts (tz) {
  const now = new Date()
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now)) % 24
  const tanggal = new Intl.DateTimeFormat('id-ID', { timeZone: tz, day: '2-digit', month: 'long', year: 'numeric' }).format(now)
  const jam = new Intl.DateTimeFormat('id-ID', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace('.', ':')
  let salam = 'Malam'
  if (hour >= 4 && hour < 11) salam = 'Pagi'
  else if (hour >= 11 && hour < 15) salam = 'Siang'
  else if (hour >= 15 && hour < 18) salam = 'Sore'
  return { salam, tanggal, jam, hour }
}

function fmtUptime (ms) {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400); const h = Math.floor(s % 86400 / 3600); const m = Math.floor(s % 3600 / 60)
  return `${d} hari ${h} jam ${m} menit`
}

// ---------------- antrean kirim (anti blokir) ----------------
// dibuat di luar createHandler supaya tetap berlaku walau bot reconnect
const sendQueue = { chain: Promise.resolve(), last: 0, times: [] }
const sentIds = new Set()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const rand = (a, b) => a + Math.random() * (b - a)
let reminderTimer = null

// ---------------- handler ----------------
function createHandler ({ sock, getSock, db, config, baileys, logger, groupCache, msgStore, resetSignal }) {
  const liveSock = () => (typeof getSock === 'function' ? getSock() : null) || sock
  const prefixes = config.prefixes || ['.']
  const ownerNums = (config.owner || []).map(normPhone)
  const ownerJid = ownerNums[0] ? ownerNums[0] + '@s.whatsapp.net' : null
  const tz = config.timezone || 'Asia/Jakarta'
  const startedAt = Date.now()
  const lastReply = new Map()
  const recentGroupReply = new Map()
  const lastAuto = new Map()
  const S = () => db.data.settings

  // Bersihkan & migrasikan data @lid lama (jika sempat tersimpan @lid@lid)
  ;(() => {
    db.data.lidToPn = db.data.lidToPn || {}
    db.data.pnToChatJid = db.data.pnToChatJid || {}
    let dirty = false
    if (db.data.lidMap && typeof db.data.lidMap === 'object') {
      for (const [k, v] of Object.entries(db.data.lidMap)) {
        const lid = normLid(k)
        const pn = normPhone(digits(v))
        if (lid && pn) {
          db.data.lidToPn[lid] = pn
          if (!db.data.pnToChatJid[pn]) db.data.pnToChatJid[pn] = lid
        }
      }
      delete db.data.lidMap
      dirty = true
    }
    for (const [k, v] of Object.entries({ ...db.data.lidToPn })) {
      const cleanK = normLid(k)
      if (cleanK !== k) {
        delete db.data.lidToPn[k]
        db.data.lidToPn[cleanK] = v
        dirty = true
      }
    }
    for (const [k, v] of Object.entries({ ...db.data.pnToChatJid })) {
      if (String(v).includes('@lid')) {
        const cleanV = normLid(v)
        if (cleanV !== v) {
          db.data.pnToChatJid[k] = cleanV
          dirty = true
        }
      }
    }
    for (const ord of Object.values(db.data.orders || {})) {
      for (const field of ['buyerJid', 'buyerMentionJid', 'sourceJid']) {
        if (ord[field] && String(ord[field]).includes('@lid')) {
          const cleanField = normLid(ord[field])
          if (cleanField !== ord[field]) { ord[field] = cleanField; dirty = true }
        }
      }
      if (ord.buyerMsgKey?.remoteJid && String(ord.buyerMsgKey.remoteJid).includes('@lid')) {
        const cleanR = normLid(ord.buyerMsgKey.remoteJid)
        if (cleanR !== ord.buyerMsgKey.remoteJid) { ord.buyerMsgKey.remoteJid = cleanR; dirty = true }
      }
    }
    if (dirty) db.save()
  })()

  // Siapkan harga modal + markup untung reseller (+Rp 5.000) & jadwal sinkron otomatis
  try {
    tgsync.ensureBasePrices(db, config)
    tgsync.setupAutoSync({ db, config })
  } catch (e) {
    console.error('[INIT TG-SYNC]', e?.message || e)
  }

  function fill (tpl, vars = {}) {
    const t = timeParts(tz)
    return String(tpl)
      .replace(/\{salam\}/gi, t.salam)
      .replace(/\{tanggal\}/gi, t.tanggal)
      .replace(/\{jam\}/gi, t.jam)
      .replace(/\{toko\}/gi, S().storeName)
      .replace(/\{grup\}/gi, vars.grup || '')
      .replace(/\{list\}/gi, vars.list || '')
      .replace(/\{total\}/gi, String(vars.total ?? ''))
      .replace(/@user/gi, vars.user ? '@' + vars.user.split('@')[0] : '')
  }

  const typing = config.typingDelaySeconds || [1.5, 3.5]
  const minGap = (config.minGapSeconds ?? 1.5) * 1000
  const perMin = config.maxRepliesPerMinute ?? 15

  // semua pesan keluar lewat antrean: jeda acak + status "mengetik" + batas per menit
  function send (jid, content, opts = {}) {
    const job = sendQueue.chain.then(() => sendNow(jid, content, opts))
    sendQueue.chain = job.catch(() => {})
    return job
  }

function normLid (s) {
  return String(s || '').split('@')[0].split(':')[0] + '@lid'
}

  // Simpan pemetaan nomor telepon <-> @lid tanpa mengubah JID chat asli (agar sesi Signal tidak terbelah)
  function rememberUserIdentity (rawRemoteJid, ids = [], isGroup = false) {
    db.data.lidToPn = db.data.lidToPn || {}
    db.data.pnToChatJid = db.data.pnToChatJid || {}
    let changed = false

    const pnCandidate = ids.find(x => String(x).endsWith('@s.whatsapp.net')) ||
      ids.find(x => /^(62|08)\d{7,13}$/.test(digits(x))) || ''
    const lidCandidate = [isGroup ? null : rawRemoteJid, ...ids].find(x => String(x).endsWith('@lid')) || ''

    const cleanPhone = pnCandidate ? normPhone(digits(pnCandidate)) : ''
    const cleanLid = lidCandidate ? normLid(lidCandidate) : ''

    if (cleanLid && cleanPhone) {
      if (db.data.lidToPn[cleanLid] !== cleanPhone) {
        db.data.lidToPn[cleanLid] = cleanPhone
        changed = true
      }
      if (!isGroup && String(rawRemoteJid).endsWith('@lid')) {
        if (db.data.pnToChatJid[cleanPhone] !== cleanLid) {
          db.data.pnToChatJid[cleanPhone] = cleanLid
          changed = true
        }
      }
    }
    if (!isGroup && String(rawRemoteJid).endsWith('@s.whatsapp.net')) {
      const pn = normPhone(digits(rawRemoteJid))
      const sJid = pn + '@s.whatsapp.net'
      if (pn && db.data.pnToChatJid[pn] && db.data.pnToChatJid[pn] !== sJid) {
        db.data.pnToChatJid[pn] = sJid
        changed = true
      }
    }
    if (changed) db.save()
  }

  function resolvePreferredDirectJid (targetJid) {
    if (!targetJid) return targetJid
    const str = String(targetJid)
    if (str.endsWith('@g.us') || str.endsWith('@newsletter') || str.endsWith('@broadcast')) return str
    if (str.endsWith('@lid')) return normLid(str)
    if (str.endsWith('@s.whatsapp.net')) {
      const pn = normPhone(digits(str))
      if (pn && db.data.pnToChatJid?.[pn]) return db.data.pnToChatJid[pn]
      return pn ? pn + '@s.whatsapp.net' : str
    }
    return str
  }

  async function sendNow (jid, content, opts = {}) {
    try {
      // Gunakan JID sesi aktif pengguna (jangan ubah @lid ke @s.whatsapp.net agar preKey/ratchet tidak bentrok)
      jid = resolvePreferredDirectJid(jid)
      if (opts?.quoted) {
        const qMsg = opts.quoted.message
        const hasValidMsg = qMsg && typeof qMsg === 'object' && Object.keys(qMsg).some(k => k === 'conversation' || k.includes('Message'))
        const fixedKey = (opts.quoted.key?.remoteJid && opts.quoted.key.remoteJid !== jid && !jid.endsWith('@g.us'))
          ? { ...opts.quoted.key, remoteJid: jid }
          : opts.quoted.key
        if (!fixedKey?.id) {
          const { quoted: _omit, ...restOpts } = opts
          opts = restOpts
        } else if (!hasValidMsg || fixedKey !== opts.quoted.key) {
          opts = {
            ...opts,
            quoted: {
              ...opts.quoted,
              key: fixedKey,
              message: hasValidMsg ? qMsg : { conversation: 'Pesanan' }
            }
          }
        }
      }
      // batas per menit
      const now = Date.now()
      sendQueue.times = sendQueue.times.filter(t => now - t < 60000)
      if (sendQueue.times.length >= perMin) {
        const wait = 60000 - (now - sendQueue.times[0]) + 500
        console.log(`   -> antre ${Math.ceil(wait / 1000)} dtk (batas ${perMin} pesan/menit)`)
        await sleep(wait)
      }
      // jeda antar pesan
      const gap = sendQueue.last + minGap - Date.now()
      if (gap > 0) await sleep(gap)
      // pura-pura mengetik
      let active = liveSock()
      try { await active.sendPresenceUpdate?.('composing', jid) } catch {}
      await sleep(rand(typing[0], typing[1]) * 1000)
      try { await active.sendPresenceUpdate?.('paused', jid) } catch {}

      let res
      try {
        active = liveSock()
        res = await active.sendMessage(jid, content, opts)
      } catch (err) {
        const em = String(err?.message || err)
        if (/connection closed|not open|closed|econnreset/i.test(em)) {
          await sleep(4000)
          active = liveSock()
          res = await active.sendMessage(jid, content, opts)
        } else {
          throw err
        }
      }
      sendQueue.last = Date.now()
      sendQueue.times.push(sendQueue.last)
      if (config.logMessages !== false) console.log(`   -> bot membalas ke ${jid.split('@')[0]} (${content.image ? 'gambar+teks' : content.document ? 'file' : 'teks'})`)
      if (res?.key?.id) {
        if (res.message) msgStore?.set(res.key.id, res.message)
        sentIds.add(res.key.id)
        if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value)
      }
      return res
    } catch (e) {
      logger?.error?.({ err: e?.message }, 'gagal kirim pesan')
      console.error('[KIRIM GAGAL]', e?.message || e)
    }
  }

  async function getGroup (jid) {
    let meta = groupCache?.get(jid)
    if (!meta) {
      meta = await liveSock().groupMetadata(jid)
      groupCache?.set(jid, meta)
    }
    return meta
  }

  function senderIds (m, isGroup) {
    const k = m.key || {}
    return [k.participant, k.participantPn, k.participantAlt, k.senderPn, k.remoteJidAlt,
      isGroup ? null : k.remoteJid, m.participant].filter(Boolean)
  }

  function isAdmin (ids, fromMe) {
    if (fromMe) return true
    const extraNums = (db.data.admins || []).map(normPhone)
    const allNums = new Set([...ownerNums, ...extraNums])
    return ids.some(id => {
      if (allNums.has(digits(id)) || (db.data.adminIds || []).includes(id)) return true
      if (String(id).endsWith('@lid')) {
        const mapped = db.data.lidToPn?.[normLid(id)]
        if (mapped && allNums.has(mapped)) return true
      }
      return false
    })
  }

  function isOwner (ids, fromMe) {
    if (fromMe) return true
    return ids.some(id => {
      if (ownerNums.includes(digits(id))) return true
      if (String(id).endsWith('@lid')) {
        const mapped = db.data.lidToPn?.[normLid(id)]
        if (mapped && ownerNums.includes(mapped)) return true
      }
      return false
    })
  }

  async function downloadImage (m, c, ctx) {
    let target = null
    if (c.imageMessage) target = { key: m.key, message: { imageMessage: c.imageMessage } }
    else if (ctx?.quotedMessage) {
      const q = unwrap(ctx.quotedMessage)
      if (q.imageMessage) {
        target = {
          key: { remoteJid: m.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
          message: { imageMessage: q.imageMessage }
        }
      }
    }
    if (!target) return null
    return await baileys.downloadMediaMessage(target, 'buffer', {}, {
      logger, reuploadRequest: liveSock().updateMediaMessage
    })
  }

  function saveImage (name, buf, oldFile) {
    const safe = normKey(name).replace(/[^a-z0-9]+/g, '_').slice(0, 40) || 'item'
    const file = `${safe}_${Date.now()}.jpg`
    fs.writeFileSync(path.join(MEDIA_DIR, file), buf)
    if (oldFile) removeImage(oldFile)
    return file
  }

  function removeImage (file) {
    try { if (file) fs.unlinkSync(path.join(MEDIA_DIR, file)) } catch {}
  }

  function buildMenu (user, ov = {}) {
    const prods = db.productEntries()
    const list = prods.length
      ? prods.map((p) => {
          const out = isItemOutOfStock(p) ? ' _(habis)_' : ''
          return `│ ✦ ${p.name.toLowerCase()}${out}`
        }).join('\n')
      : '│ _(belum ada produk)_'
    let tpl = (typeof ov.menuTemplate === 'string' ? ov.menuTemplate : S().menuTemplate) || DEFAULT_MENU
    if (!/\{list\}/i.test(tpl)) tpl += '\n\n{list}'
    const stkOn = typeof ov.stickerEnabled === 'boolean' ? ov.stickerEnabled : (S().stickerEnabled !== false)
    const stkLim = ov.stickerLimit !== undefined ? Number(ov.stickerLimit) : stickerLimit()
    const stkTpl = typeof ov.stickerMenuText === 'string' ? ov.stickerMenuText : String(S().stickerMenuText ?? DEFAULT_STICKER_MENU)
    let text = fill(tpl, { user, list, total: prods.length })
    // fitur tambahan (stiker) tampil terpisah di bawah menu produk
    if (stkOn) {
      const extra = stkTpl.replace(/\{limit\}/gi, String(stkLim))
      if (extra.trim()) text += '\n\n' + fill(extra)
    }
    if (ov.storeName) text = text.replace(new RegExp(S().storeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ov.storeName)
    return text
  }

  function buildStockSummary (isGroup = true) {
    const prods = db.productEntries()
    if (!prods.length) return `📦 Belum ada produk terdaftar di *${S().storeName}*.`
    const extra = !isGroup ? privateMarkup() : 0
    const avail = []
    const empty = []
    prods.forEach((p) => {
      const minP = minItemPrice(p, extra)
      const priceInfo = minP ? ` — mulai *${minP}*` : ''
      if (isItemOutOfStock(p)) empty.push(`• ~${p.name.toLowerCase()}~ _(habis)_`)
      else avail.push(`✅ *${p.name.toLowerCase()}*${priceInfo}`)
    })
    const lines = [
      `📦 *DAFTAR STOK & HARGA — ${S().storeName}*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `✅ *Tersedia :* ${avail.length} produk`,
      ...avail
    ]
    if (empty.length) {
      lines.push('', `⚠️ *Stok Sedang Habis (${empty.length}) :*`, ...empty)
    }
    lines.push(
      `━━━━━━━━━━━━━━━━━━━━`,
      `💡 Ketik *nama produk* (contoh: *${(avail[0] ? prods.find(p => !isItemOutOfStock(p))?.name : prods[0].name).toLowerCase()}*) untuk melihat variasi lengkap & cara order.`
    )
    return lines.join('\n')
  }

  function privateMarkup () {
    const n = Number(S().privateMarkup ?? config.privateMarkup ?? 0)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }

  async function sendItem (jid, item, m, opts = {}) {
    const isGroup = String(jid || '').endsWith('@g.us')
    const isInfo = INFO_KEYS.includes(item.key || normKey(item.name))
    const extraPrice = (!isGroup && !isInfo && !opts.basePrice) ? privateMarkup() : 0
    let text = fill(render(item, S(), { extraPrice }))
    if ((item.key === 'bayar' || normKey(item.name) === 'bayar') && !/[./#!]?beli\b/i.test(text)) {
      text += `\n\n📌 *Cara Konfirmasi Pembayaran:*\nKirim *screenshot bukti pembayaran* dengan caption:\n*${prefixes[0]}beli <barang yang dibeli & detail pesanan>*\nContoh: *${prefixes[0]}beli canva*`
    }
    const imgPath = item.image ? path.join(MEDIA_DIR, item.image) : null
    if (imgPath && fs.existsSync(imgPath)) {
      return send(jid, { image: fs.readFileSync(imgPath), caption: text }, { quoted: m })
    }
    return send(jid, { text }, { quoted: m })
  }

  // ------------- fitur stiker (pemanis, di luar menu produk) -------------
  function stickerLimit () {
    const n = Number(S().stickerLimit ?? config.stickerDailyLimit ?? 5)
    return Number.isFinite(n) && n >= 0 ? n : 5
  }

  function todayStr () {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  }

  // jatah stiker per orang per hari (reset tiap jam 00:00 sesuai zona waktu)
  function stickerUsage () {
    const day = todayStr()
    if (!db.data.stickerUsage || db.data.stickerUsage.day !== day) db.data.stickerUsage = { day, counts: {} }
    return db.data.stickerUsage
  }

  function stickerUserKey (ids, sender) {
    const pn = ids.find(x => String(x).endsWith('@s.whatsapp.net'))
    if (pn) return normPhone(digits(pn))
    for (const id of ids) {
      if (String(id).endsWith('@lid')) {
        const mapped = db.data.lidToPn?.[normLid(id)]
        if (mapped) return mapped
      }
    }
    return digits(sender) || String(sender)
  }

  // cari gambar/video di pesan atau di pesan yang di-reply
  function findMedia (m, c, ctx) {
    const pick = (msg, key) => {
      if (msg.imageMessage) return { kind: 'image', key, message: { imageMessage: msg.imageMessage } }
      if (msg.videoMessage) return { kind: 'video', key, message: { videoMessage: msg.videoMessage }, seconds: msg.videoMessage.seconds || 0 }
      if (msg.stickerMessage) return { kind: 'sticker', key, message: { stickerMessage: msg.stickerMessage } }
      return null
    }
    const own = pick(c, m.key)
    if (own) return own
    if (ctx?.quotedMessage) {
      return pick(unwrap(ctx.quotedMessage), { remoteJid: m.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false })
    }
    return null
  }

  async function handleSticker (ctxObj, admin) {
    const { jid, m, c, ctx, ids, sender } = ctxObj
    const reply = (text) => send(jid, { text }, { quoted: m })
    if (S().stickerEnabled === false) return reply('🙏 Maaf kak, fitur stiker sedang dimatikan admin.')

    const limit = stickerLimit()
    const usage = stickerUsage()
    const ukey = stickerUserKey(ids, sender)
    const used = usage.counts[ukey] || 0
    const left = Math.max(0, limit - used)

    const media = findMedia(m, c, ctx)
    if (!media) {
      return reply(`🎨 *BIKIN STIKER WA GRATIS*\n\nKirim *gambar* atau *video/GIF* (maks 10 detik) dengan caption:\n*sticker*\n\nAtau *reply* gambar/video lalu ketik *sticker*\n\n🎟️ Jatah kakak hari ini: *${admin ? 'tanpa batas (admin)' : `${left} dari ${limit}`}*`)
    }
    if (media.kind === 'sticker') return reply('Itu sudah stiker kak 😄 Kirim *gambar* atau *video* ya.')
    if (media.kind === 'video' && media.seconds > 10) return reply('⚠️ Video kepanjangan kak, maksimal *10 detik* ya.')
    if (!admin && used >= limit) {
      return reply(`⛔ Jatah bikin stiker kakak hari ini sudah habis (*${limit}x/hari*).\nBisa bikin lagi besok ya kak 🙏`)
    }

    // pesan tempat jatah dulu supaya tidak bisa diakali kirim banyak sekaligus
    if (!admin) { usage.counts[ukey] = used + 1; db.save() }
    try {
      const buf = await baileys.downloadMediaMessage({ key: media.key, message: media.message }, 'buffer', {}, {
        logger, reuploadRequest: liveSock().updateMediaMessage
      })
      if (!buf?.length) throw new Error('media kosong')
      const sticker = await makeSticker(buf, {
        animated: media.kind === 'video',
        pack: S().stickerPack || S().storeName,
        author: S().stickerAuthor || 'Bot ' + S().storeName
      })
      await send(jid, { sticker }, { quoted: m })
      const nowLeft = limit - (usage.counts[ukey] || 0)
      if (!admin && nowLeft <= 0) await reply(`✅ Stiker jadi! Jatah stiker kakak hari ini sudah habis (${limit}x). Sampai besok ya 👋`)
      console.log(`   -> stiker dibuat untuk ${ukey} (${admin ? 'admin' : `${usage.counts[ukey]}/${limit}`})`)
    } catch (e) {
      if (!admin) { usage.counts[ukey] = Math.max(0, (usage.counts[ukey] || 1) - 1); db.save() }
      console.error('[STIKER GAGAL]', e?.message || e)
      if (e?.code === 'NO_FFMPEG') {
        return reply(admin
          ? '⚠️ ffmpeg belum terpasang di HP/PC bot.\nTermux: *pkg install ffmpeg*\nLalu restart bot.'
          : '🙏 Maaf kak, fitur stiker sedang gangguan. Coba lagi nanti ya.')
      }
      return reply('⚠️ Gagal bikin stiker, coba kirim ulang gambar/videonya ya kak (jatah tidak berkurang).')
    }
  }

  // ------------- web dashboard (.web on / off / status) -------------
  function fmtLeft (ms) {
    const mins = Math.max(0, Math.round(ms / 60000))
    return mins >= 60 ? `${Math.floor(mins / 60)} jam ${mins % 60} menit` : `${mins} menit`
  }

  function webInfoText (i) {
    const p = prefixes[0]
    const lines = ['🌐 *WEB DASHBOARD AKTIF*', '━━━━━━━━━━━━━━━━━━━━']
    if (i.publicUrl) lines.push(`🔗 *Link :* ${i.publicUrl}`)
    else {
      lines.push(`🔗 *Link lokal :* ${i.localUrl}`)
      lines.push(`⚠️ Link online belum tersedia: ${i.tunnelError || 'sedang disiapkan'}`)
      lines.push('_(link lokal hanya bisa dibuka di HP/PC bot itu sendiri)_')
    }
    lines.push(`🔑 *PIN :* ${i.pin}`)
    lines.push(`⏳ *Mati otomatis :* ${fmtLeft(i.expiresAt - Date.now())} lagi`)
    lines.push('━━━━━━━━━━━━━━━━━━━━')
    lines.push('⚠️ Jangan bagikan link & PIN ini ke siapa pun.')
    lines.push(`Ketik *${p}web off* untuk mematikan.`)
    return lines.join('\n')
  }

  async function webCommand (args, ctxObj) {
    const { jid, m, isGroup, sender, fromMe } = ctxObj
    const p = prefixes[0]
    const reply = (text) => send(jid, { text }, { quoted: m })
    const [sub, minArg] = args.trim().toLowerCase().split(/\s+/)
    // link & PIN selalu dikirim ke chat pribadi admin (jangan bocor di grup)
    const dm = fromMe ? (ownerJid ? resolvePreferredDirectJid(ownerJid) : jid) : resolvePreferredDirectJid(isGroup ? sender : jid)
    const toDm = async (text) => {
      if (dm === jid) return reply(text)
      await send(dm, { text })
      return reply('🔐 Info web dashboard sudah dikirim ke *chat pribadi* admin.')
    }

    if (sub === 'on') {
      const minutes = Math.min(720, Math.max(5, Number(minArg) || config.webAutoOffMinutes || 60))
      if (web.isRunning()) {
        const i = await web.start({ db, config, minutes })
        return toDm('ℹ️ Web sudah menyala (waktu diperpanjang).\n\n' + webInfoText(i))
      }
      await reply('⏳ Menyalakan web dashboard & membuat link online... (±10-30 detik)')
      web.attach({ notify: (text) => send(dm, { text }) })
      try {
        const i = await web.start({ db, config, minutes })
        return toDm(webInfoText(i))
      } catch (e) {
        return reply('❌ Gagal menyalakan web: ' + (e?.message || e))
      }
    }

    if (sub === 'off') {
      const was = web.stop('dimatikan admin')
      return reply(was ? '🔴 Web dashboard *dimatikan*. Link & PIN lama sudah tidak berlaku.' : 'ℹ️ Web dashboard memang sedang mati.')
    }

    if (sub === 'status') {
      if (!web.isRunning()) return reply(`🔴 Web dashboard sedang *mati*.\nKetik *${p}web on* untuk menyalakan.`)
      return toDm(webInfoText(web.info()))
    }

    return reply(`*🌐 WEB DASHBOARD*\n\n*${p}web on* — nyalakan web + kirim link & PIN\n*${p}web on 120* — nyala selama 120 menit\n*${p}web off* — matikan web\n*${p}web status* — cek status\n\nStatus sekarang: ${web.isRunning() ? '🟢 menyala' : '🔴 mati'}`)
  }

  function adminHelp () {
    const p = prefixes[0]
    return `*🛠️ MENU ADMIN — ${S().storeName}*

*Pesanan & Transaksi*
_(Pembeli order: kirim screenshot bayar + caption *${p}beli nama barang*)_
*p* / *${p}p* (reply order / *${p}p ORD-001*) — tandai pesanan sedang diproses & update resi pembeli
*d <isi pesanan>* / *${p}d <isi pesanan>* (reply order / *${p}d ORD-001 <isi pesanan>*) — kirim pesanan ke pembeli, tandai selesai (done) & kirim resi selesai
*d* / *${p}d* (reply order / *${p}d ORD-001*) — tandai pesanan selesai (done)
${p}kirim <isi pesanan> — kirim detail pesanan ke pembeli (reply order / *${p}kirim ORD-001 <isi>*)
${p}pesanan — lihat daftar pesanan yang belum selesai (pending / diproses)
${p}cekorder ORD-001 — lihat detail & bukti bayar pesanan
${p}batalorder ORD-001|alasan — batalkan pesanan

*Tambah / Ubah Produk & Stok*
${p}setstok nama|jumlah — atur stok manual produk (mis. *${p}setstok netflix|20* atau per jenis *${p}setstok netflix|1=10; 2=5*)
${p}tambahstok nama|jumlah — tambah stok (+) dari bot lain (mis. *${p}tambahstok canva|15*)
${p}habis nama — tandai stok produk sedang habis (0)
${p}ready nama [jumlah] — tandai stok produk tersedia kembali
${p}kuncistok nama — kunci/buka stok agar tidak ditimpa sinkron bot pusat
${p}addlist kode — tambah produk (bot tanya judul, jenis & harga, keterangan, note, gambar)
${p}setjudul kode|JUDUL — ganti judul produk
${p}addlist nama|jenis=harga; jenis=harga|keterangan|note — cara cepat 1 pesan
${p}updatelist nama — isi ulang produk lewat tanya-jawab
${p}setharga nama|jenis=harga; ... — ganti semua jenis & harga
${p}addjenis nama|jenis=harga — tambah / ubah 1 jenis
${p}deljenis nama|nomor — hapus 1 jenis
${p}setket nama|ket1; ket2 — ganti keterangan (- hapus)
${p}setnote nama|teks — ganti note (- hapus)
${p}setgambar nama — kirim/reply gambar produk
${p}delgambar nama — hapus gambar produk
${p}dellist nama — hapus produk
${p}renamelist lama|baru — ganti nama
${p}getlist nama — salin data produk untuk diedit
${p}addlistraw nama|teks — produk teks bebas (tanpa format)
${p}batal — batalkan tanya-jawab

*Pembayaran & Harga*
${p}setbayar teks — atur pesan BAYAR (kirim/reply gambar QRIS)
${p}setuntung 5000 — atur untung reseller otomatis per produk (Rp 5.000)
${p}setselisih 0 — selisih harga tambahan khusus pembeli di luar grup

*🔄 Sinkron Otomatis (Bot Pusat)*
${p}sync — sinkronkan lengkap produk, varian, stok & harga sekarang
${p}sync stok — sinkron stok cepat (±15 detik)
${p}stopsync — hentikan proses sinkron yang sedang berjalan
${p}autosync on [jam] / off — nyalakan/matikan jadwal sinkron otomatis
${p}setai <API_KEY> — aktifkan Gemini AI untuk bantu cerna format rumit
${p}cekai — tes apakah API key Gemini benar-benar berfungsi
${p}fixsesi [08xx] — perbaiki pesan bot yang muncul "Menunggu pesan ini" di HP tertentu
${p}kunciproduk nama — kunci/buka produk agar tidak diubah saat sinkron
${p}impor teks — impor cepat daftar produk & harga dari teks copy-paste
${p}tglogin 08xxxx — hubungkan akun Telegram untuk sinkron otomatis
${p}tgkode 12345 — verifikasi kode OTP login Telegram
${p}tglogout — putuskan sesi akun Telegram

*Tampilan*
${p}settoko nama — ganti nama toko
${p}setfooter teks — teks di bawah tiap produk (off = hilangkan)
${p}setmenu teks — ubah teks menu ({salam} @user {toko} {list})
${p}resetmenu — kembalikan teks menu bawaan
${p}setproses teks / ${p}setdone teks
${p}setauto teks — balasan otomatis chat pribadi
${p}autoreply on/off

*Grup (Khusus Admin)*
${p}kick @member / reply / 08xx — keluarkan member dari grup
${p}add 08xx / reply — tambahkan member ke grup
${p}open / ${p}close — buka/tutup grup
${p}h teks — hidetag (tag semua member)
${p}welcome on/off — sambutan member baru
${p}setwelcome teks — ({grup} @user {toko})
${p}bot on/off — nyalakan/matikan bot di chat ini

*Admin & Sistem*
${p}addadmin 08xx (atau reply) / ${p}deladmin 08xx
${p}listadmin — daftar admin
${p}backup — kirim file database
${p}status — info bot
${p}myid — lihat ID WA kamu

*🌐 Web Dashboard (atur bot lewat browser)*
${p}web on — nyalakan web, link & PIN dikirim ke chat pribadi
${p}web on 120 — nyala selama 120 menit
${p}web off — matikan web
${p}web status — cek status web

*🎨 Stiker (fitur gratis untuk pembeli)*
${p}sticker on/off — nyalakan/matikan fitur stiker
${p}limitstiker 5 — jatah stiker per orang per hari
_(admin bebas bikin stiker tanpa batas)_`
  }

  // ------------- sistem order (.beli), resi & pengingat 1 jam -------------
  function getAdminJids (excludeBuyerPhone = '') {
    const extraNums = (db.data.admins || []).map(normPhone)
    const allNums = [...new Set([...ownerNums, ...extraNums].filter(Boolean))]
    const cleanBuyer = normPhone(excludeBuyerPhone)
    const filtered = cleanBuyer ? allNums.filter(n => n !== cleanBuyer) : allNums
    const finalNums = filtered.length ? filtered : ownerNums
    return finalNums.map(n => resolvePreferredDirectJid(n + '@s.whatsapp.net'))
  }

  function generateRandomOrderId () {
    const orders = db.data.orders || {}
    for (let i = 0; i < 100; i++) {
      const randNum = Math.floor(10000 + Math.random() * 90000)
      const id = `ORD-${randNum}`
      if (!orders[id]) return { id, seq: randNum }
    }
    const fallback = Math.floor(100000 + Math.random() * 900000)
    return { id: `ORD-${fallback}`, seq: fallback }
  }

  function fmtWaitDuration (ms) {
    const mins = Math.max(1, Math.floor(ms / 60000))
    const h = Math.floor(mins / 60)
    const m = mins % 60
    if (h > 0 && m > 0) return `${h} jam ${m} menit`
    if (h > 0) return `${h} jam`
    return `${m} menit`
  }

  function parseOrderInput (rawArgs) {
    const clean = String(rawArgs || '').trim()
    if (!clean) return null
    const keys = Object.keys(db.data.list || {})
      .filter(k => !INFO_KEYS.includes(k))
      .sort((a, b) => b.length - a.length)
    const lower = clean.toLowerCase().replace(/\s+/g, ' ')
    for (const k of keys) {
      if (
        lower === k ||
        lower.startsWith(k + ' ') ||
        lower.startsWith(k + '\n') ||
        lower.startsWith(k + '|') ||
        lower.startsWith(k + ':') ||
        lower.startsWith(k + '-')
      ) {
        const prod = db.data.list[k]
        const restNote = clean.slice(k.length).replace(/^[\s|:\-]+/, '').trim()
        return {
          productKey: k,
          productName: prod.title || prod.name,
          buyerNote: restNote,
          displayItem: restNote ? `${prod.name} — ${restNote}` : prod.name
        }
      }
    }
    return {
      productKey: null,
      productName: clean,
      buyerNote: '',
      displayItem: clean
    }
  }

  async function resolveBuyer (m, isGroup, ids, jid) {
    let phone = ''
    let sNetJid = ids.find(x => String(x).endsWith('@s.whatsapp.net')) || ''
    if (sNetJid) phone = normPhone(digits(sNetJid))
    if (!phone) {
      for (const id of ids) {
        if (String(id).endsWith('@lid')) {
          const mapped = db.data.lidToPn?.[normLid(id)]
          if (mapped) { phone = mapped; break }
        }
        const d = digits(id)
        if (/^(62|08)\d{7,13}$/.test(d)) { phone = normPhone(d); break }
      }
    }
    const rawParticipant = isGroup ? (m.key.participant || ids[0] || '') : jid
    if (isGroup && !phone && rawParticipant) {
      try {
        const meta = await getGroup(jid)
        const p = (meta?.participants || []).find(x => x.id === rawParticipant || x.lid === rawParticipant || x.jid === rawParticipant)
        if (p) {
          const pJid = p.jid || p.phoneNumber || (String(p.id || '').endsWith('@s.whatsapp.net') ? p.id : '')
          if (pJid) {
            phone = normPhone(digits(pJid))
            sNetJid = phone ? phone + '@s.whatsapp.net' : ''
          }
        }
      } catch {}
    }
    let buyerDmJid
    if (!isGroup) {
      buyerDmJid = jid
    } else if (phone && db.data.pnToChatJid?.[phone]) {
      buyerDmJid = db.data.pnToChatJid[phone]
    } else if (String(rawParticipant).endsWith('@lid')) {
      buyerDmJid = normLid(rawParticipant)
    } else {
      buyerDmJid = sNetJid || (phone ? phone + '@s.whatsapp.net' : rawParticipant || jid)
    }
    const buyerMentionJid = rawParticipant || buyerDmJid
    const buyerName = (m.pushName || '').trim() || phone || digits(buyerMentionJid) || 'Pembeli'
    return { buyerPhone: phone || digits(buyerMentionJid), buyerDmJid, buyerMentionJid, buyerName }
  }

  function buildResiText (order, opts = {}) {
    const t = timeParts(tz)
    const displayBuyer = order.isGroup
      ? (order.buyerMentionJid ? '@' + order.buyerMentionJid.split('@')[0] : order.buyerName)
      : (order.buyerName || 'Kak')
    const toko = S().storeName

    if (order.status === 'pending') {
      return `🧾 *RESI PESANAN — ${toko}*
━━━━━━━━━━━━━━━━━━━━
🆔 *No. Resi :* #${order.id}
👤 *Pembeli :* ${displayBuyer}
📦 *Pesanan :* ${order.itemText}
📅 *Waktu :* ${order.createdTimeStr}
📌 *Status :* ⏳ Menunggu Diproses
━━━━━━━━━━━━━━━━━━━━
✅ Bukti pembayaran & pesanan kakak sudah diterima.
Mohon ditunggu ya kak, pesanan akan segera diproses 🙏`
    }

    if (order.status === 'processing') {
      return `🧾 *UPDATE PESANAN — ${toko}*
━━━━━━━━━━━━━━━━━━━━
🆔 *No. Resi :* #${order.id}
👤 *Pembeli :* ${displayBuyer}
📦 *Pesanan :* ${order.itemText}
⏰ *Waktu :* ${t.tanggal}, ${t.jam} WIB
📌 *Status :* 🔄 Sedang Diproses
━━━━━━━━━━━━━━━━━━━━
Pesanan ${displayBuyer} sedang diproses, mohon ditunggu sebentar ya kak 🙏`
    }

    if (order.status === 'done') {
      let infoLine = ''
      if (opts.hideSecretInGroup && (order.deliveryText || opts.hasDeliveryImage || order.itemSent)) {
        infoLine = `\n📬 Item produk pesanan sudah dikirimkan ke *Chat Pribadi (PM)* ${displayBuyer} ya kak.\n━━━━━━━━━━━━━━━━━━━━`
      }
      return `🧾 *RESI PESANAN SELESAI — ${toko}*
━━━━━━━━━━━━━━━━━━━━
🆔 *No. Resi :* #${order.id}
👤 *Pembeli :* ${displayBuyer}
📦 *Pesanan :* ${order.itemText}
✅ *Selesai :* ${t.tanggal}, ${t.jam} WIB
📌 *Status :* ✅ Pesanan Selesai
━━━━━━━━━━━━━━━━━━━━${infoLine}
Terima kasih ${displayBuyer} sudah order di *${toko}* 🙏
Ditunggu next order-nya ya kak!`
    }

    if (order.status === 'cancelled') {
      return `🧾 *UPDATE PESANAN — ${toko}*
━━━━━━━━━━━━━━━━━━━━
🆔 *No. Resi :* #${order.id}
👤 *Pembeli :* ${displayBuyer}
📦 *Pesanan :* ${order.itemText}
📌 *Status :* ❌ Pesanan Dibatalkan${order.cancelReason ? `\n📝 *Keterangan :* ${order.cancelReason}` : ''}
━━━━━━━━━━━━━━━━━━━━
Silakan hubungi Admin jika ada kendala ya kak 🙏`
    }
    return ''
  }

  function rememberAdminMsg (order, msgId) {
    if (!msgId) return
    order.adminMsgIds = order.adminMsgIds || []
    if (!order.adminMsgIds.includes(msgId)) {
      order.adminMsgIds.push(msgId)
      if (order.adminMsgIds.length > 30) order.adminMsgIds.shift()
    }
  }

  // Simpan pesanan .beli yang belum dilampiri foto bukti bayar (tunggu hingga 5 menit)
  const pendingBeli = new Map() // senderKey -> { rawOrder, jid, expires }
  function pendingBeliKey (jid, sender) {
    return `${jid}|${digits(sender) || sender}`
  }

  async function handleBeliCommand (args, ctxObj) {
    const { jid, m, c, ctx, isGroup, ids, sender } = ctxObj
    const p = prefixes[0]
    const rawOrder = String(args || '').trim()

    if (!rawOrder) {
      return send(jid, {
        text: `🛒 *CARA ORDER LEWAT BOT*\n\nKirim *screenshot bukti pembayaran* dengan caption:\n*${p}beli <barang yang dibeli & pesanan>*\n\nContoh:\n• *${p}beli canva*\n• *${p}beli canva emailkamu@gmail.com*\n• *${p}beli netflix 1 bulan*\n\n_(Atau reply gambar bukti pembayaran lalu ketik *${p}beli nama barang*)_`
      }, { quoted: m })
    }

    let buf = null
    try {
      buf = await downloadImage(m, c, ctx)
    } catch (e) {
      return send(jid, { text: '⚠️ Gagal mengunduh gambar bukti pembayaran. Coba kirim ulang gambarnya ya kak.' }, { quoted: m })
    }

    if (!buf) {
      pendingBeli.set(pendingBeliKey(jid, sender), {
        rawOrder,
        jid,
        expires: Date.now() + 5 * 60 * 1000
      })
      return send(jid, {
        text: `📸 *Silakan kirim screenshot bukti pembayarannya ya kak!*\n\n📦 Pesanan dicatat sementara: *${rawOrder}*\n\nKakak cukup *kirim gambar bukti bayar sekarang* (tidak perlu ketik ulang *${p}beli ${rawOrder}*), nanti bot otomatis memprosesnya 🙏`
      }, { quoted: m })
    }
    pendingBeli.delete(pendingBeliKey(jid, sender))

    const parsed = parseOrderInput(rawOrder)
    const { buyerPhone, buyerDmJid, buyerMentionJid, buyerName } = await resolveBuyer(m, isGroup, ids, jid)
    let groupName = ''
    if (isGroup) {
      try { groupName = (await getGroup(jid))?.subject || '' } catch {}
    }

    db.data.orders = db.data.orders || {}
    const { id: orderId, seq } = generateRandomOrderId()
    db.data.orderSeq = Number(db.data.orderSeq || 0) + 1
    const proofFile = saveImage(`bukti_${orderId}`, buf, null)
    const t = timeParts(tz)
    const now = Date.now()

    const order = {
      id: orderId,
      seq,
      buyerJid: buyerDmJid,
      buyerMentionJid,
      buyerPhone,
      buyerName,
      sourceJid: jid,
      isGroup,
      groupName,
      productKey: parsed.productKey,
      productName: parsed.productName,
      buyerNote: parsed.buyerNote,
      itemText: parsed.displayItem,
      proofImage: proofFile,
      status: 'pending',
      createdAt: now,
      createdTimeStr: `${t.tanggal}, ${t.jam} WIB`,
      processedAt: null,
      doneAt: null,
      lastReminderAt: now,
      reminderCount: 0,
      deliveryText: '',
      itemSent: false,
      buyerMsgKey: {
        remoteJid: jid,
        id: m.key.id,
        participant: isGroup ? m.key.participant : undefined,
        fromMe: false
      },
      receiptMsgId: null,
      adminMsgIds: []
    }

    db.data.orders[orderId] = order
    db.save()

    // 1. Kirim Resi Menunggu Diproses ke Pembeli
    const resiText = buildResiText(order)
    const mentions = isGroup ? [buyerMentionJid] : []
    const resReceipt = await send(jid, { text: resiText, ...(mentions.length ? { mentions } : {}) }, { quoted: m })
    if (resReceipt?.key?.id) {
      order.receiptMsgId = resReceipt.key.id
      db.save()
    }

    // 2. Teruskan screenshot pembayaran + detail pesanan HANYA ke Admin (tidak ke pembeli)
    const markup = !isGroup ? privateMarkup() : 0
    const profitPerItem = Number(S().syncMarkup ?? config.syncMarkup ?? 5000)
    const prodObj = parsed.productKey ? db.data.list[parsed.productKey] : null
    let modalLine = ''
    if (prodObj) {
      const stockInfo = prodObj.supplierStock !== undefined ? ` • Stok pusat: *${prodObj.supplierStock}*` : ''
      const baseList = (prodObj.types || []).filter(t => Number(t.basePrice) > 0).slice(0, 4)
        .map(t => `${t.name ? t.name + ': ' : ''}Modal Rp${Number(t.basePrice).toLocaleString('id-ID')} → Jual Rp${Number(t.price).toLocaleString('id-ID')}`)
      modalLine = `\n💰 *Untung Reseller :* +Rp ${profitPerItem.toLocaleString('id-ID')}/produk${stockInfo}` +
        (baseList.length ? `\n📊 *Rincian Modal :* ${baseList.join(' | ')}` : '')
    }
    const asalChat = isGroup
      ? `Grup (${groupName || jid.split('@')[0]}) — Harga Grup`
      : `Chat Pribadi / Luar Grup${markup > 0 ? ` (+Rp ${markup.toLocaleString('id-ID')})` : ''}`
    const waLink = /^\d{8,15}$/.test(buyerPhone) ? `wa.me/${normPhone(buyerPhone)}` : '-'
    const adminCaption = `🔔 *PESANAN BARU MASUK — #${order.id}*
━━━━━━━━━━━━━━━━━━━━
🆔 *No. Resi :* #${order.id}
👤 *Pembeli :* ${buyerName} (${buyerPhone || '-'})
🔗 *Kontak :* ${waLink}
💬 *Asal Chat :* ${asalChat}
📦 *Pesanan :* ${order.itemText}${modalLine}
📅 *Waktu :* ${order.createdTimeStr}
📌 *Status :* ⏳ Menunggu Diproses
━━━━━━━━━━━━━━━━━━━━
*Cara Proses (Reply pesan ini):*
▸ Ketik *p* — tandai pesanan sedang diproses
▸ Reply langsung *item produk/akun* — teruskan item ke pembeli
▸ Ketik *d <item produk>* atau *d* — tandai pesanan selesai`

    for (const adminJid of getAdminJids(buyerPhone)) {
      if (adminJid === jid) continue
      const sentAdmin = await send(adminJid, { image: buf, caption: adminCaption })
      if (sentAdmin?.key?.id) rememberAdminMsg(order, sentAdmin.key.id)
    }
    db.save()
    return true
  }

  function findOrderByIdToken (token) {
    if (!token) return null
    const m = String(token).trim().match(/^#?(?:ord[-_]?)?(\d{1,8})$/i)
    if (!m) return null
    const num = Number(m[1])
    const orders = db.data.orders || {}
    const exactId = `ORD-${m[1]}`
    if (orders[exactId]) return orders[exactId]
    const padId = `ORD-${String(num).padStart(3, '0')}`
    if (orders[padId]) return orders[padId]
    return Object.values(orders).find(o => o.seq === num || o.id.toUpperCase() === String(token).replace(/^#/, '').toUpperCase()) || null
  }

  function findOrderForAdmin (args, ctxObj, allowExplicitNumber = true) {
    const { jid, ctx, isGroup } = ctxObj
    const orders = Object.values(db.data.orders || {})
    const rawArgs = String(args || '').trim()

    // 1. Cek jika argumen pertama adalah ID pesanan (misal: ORD-48291, #ORD-48291)
    if (rawArgs) {
      const firstSpace = rawArgs.search(/\s/)
      const firstToken = firstSpace === -1 ? rawArgs : rawArgs.slice(0, firstSpace)
      const restAfterToken = firstSpace === -1 ? '' : rawArgs.slice(firstSpace + 1).trim()
      const isExplicitOrd = /^#?ord[-_]?\d+$/i.test(firstToken) || (allowExplicitNumber && !ctx?.stanzaId && /^#?\d{3,8}$/.test(firstToken))
      if (isExplicitOrd) {
        const found = findOrderByIdToken(firstToken)
        if (found) return { order: found, restArgs: restAfterToken }
      }
    }

    // 2. Cek dari pesan yang di-reply (ctx.stanzaId atau teks #ORD-xxx di pesan yang di-reply)
    if (ctx?.stanzaId) {
      const stId = ctx.stanzaId
      const byMsgId = orders.find(o =>
        o.buyerMsgKey?.id === stId ||
        o.receiptMsgId === stId ||
        (o.adminMsgIds || []).includes(stId)
      )
      if (byMsgId) return { order: byMsgId, restArgs: rawArgs }

      if (ctx.quotedMessage) {
        const qText = getText(unwrap(ctx.quotedMessage))
        const mOrd = qText.match(/#?(ORD-\d{3,8})\b/i)
        if (mOrd) {
          const byText = findOrderByIdToken(mOrd[1])
          if (byText) return { order: byText, restArgs: rawArgs }
        }
      }

      // Cek apakah pesan yang di-reply adalah milik pembeli yang punya order aktif
      const quotedSender = ctx.participant || (isGroup ? null : jid)
      if (quotedSender) {
        const qDigits = digits(quotedSender)
        const activeBuyerOrders = orders
          .filter(o => o.status !== 'done' && o.status !== 'cancelled' && (
            o.buyerMentionJid === quotedSender ||
            o.buyerJid === quotedSender ||
            (qDigits && o.buyerPhone && digits(o.buyerPhone) === qDigits)
          ))
          .sort((a, b) => b.createdAt - a.createdAt)
        if (activeBuyerOrders.length) return { order: activeBuyerOrders[0], restArgs: rawArgs }
      }
    }

    // 3. Jika di chat pribadi admin dengan bot (tanpa reply & tanpa ID), cek jika hanya ada 1 order aktif
    if (!isGroup && !ctx?.stanzaId) {
      const active = orders.filter(o => o.status !== 'done' && o.status !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt)
      if (active.length === 1) return { order: active[0], restArgs: rawArgs }
      if (active.length > 1) return { order: null, multiple: active, restArgs: rawArgs }
    }

    return { order: null, restArgs: rawArgs }
  }

  function buildBuyerQuoted (order) {
    if (!order?.buyerMsgKey?.id) return undefined
    return {
      key: order.buyerMsgKey,
      message: { conversation: `${prefixes[0]}beli ${order.itemText || ''}`.trim() }
    }
  }

  // Kirim item produk dari admin ke pembeli
  async function sendProductItemToBuyer (order, itemText, itemBuf) {
    const targetJid = order.isGroup ? order.buyerJid : order.sourceJid
    const quoted = !order.isGroup ? buildBuyerQuoted(order) : undefined
    const header = `📦 *DETAIL PESANAN KAKAK — #${order.id}*\n━━━━━━━━━━━━━━━━━━━━\n🛒 *Produk :* ${order.itemText}`
    const fullText = itemText ? `${header}\n\n${itemText}` : header
    if (itemBuf) {
      await send(targetJid, { image: itemBuf, caption: fullText }, quoted ? { quoted } : {})
    } else if (itemText) {
      await send(targetJid, { text: fullText }, quoted ? { quoted } : {})
    }
    order.itemSent = true
    if (itemText) order.deliveryText = itemText
    db.save()
  }

  // Kirim pemberitahuan / resi pesanan selesai ke pembeli
  async function sendDoneNotificationToBuyer (order, hasDeliveryImage = false) {
    const mentions = order.isGroup ? [order.buyerMentionJid] : []
    const resiDone = buildResiText(order, {
      hideSecretInGroup: order.isGroup,
      hasDeliveryImage
    })
    const quoted = buildBuyerQuoted(order)
    await send(order.sourceJid, { text: resiDone, ...(mentions.length ? { mentions } : {}) }, quoted ? { quoted } : {})
  }

  async function handleOrderAdminAction (cmd, args, ctxObj) {
    const { jid, m, c, ctx, isGroup, fromMe } = ctxObj
    const p = prefixes[0]
    const reply = (text, extra = {}) => send(jid, { text, ...extra }, { quoted: m })

    if (['pesanan', 'listorder', 'orders', 'antrean'].includes(cmd)) {
      const active = Object.values(db.data.orders || {})
        .filter(o => o.status !== 'done' && o.status !== 'cancelled')
        .sort((a, b) => a.createdAt - b.createdAt)
      if (!active.length) return reply('✅ Tidak ada pesanan yang tertunda saat ini. Semua pesanan sudah selesai (*Done*).')
      const now = Date.now()
      const lines = active.map((o, i) => {
        const st = o.status === 'processing' ? '🔄 Diproses' : '⏳ Belum Diproses'
        const asal = o.isGroup ? `Grup ${o.groupName || ''}` : 'Chat Pribadi'
        return `${i + 1}. *#${o.id}* — ${o.itemText}\n   👤 ${o.buyerName} (${o.buyerPhone || '-'})\n   💬 ${asal} • ⏱️ ${fmtWaitDuration(now - o.createdAt)} lalu\n   📌 Status: ${st}`
      })
      return reply(`📋 *DAFTAR PESANAN BELUM SELESAI (${active.length})*\n\n${lines.join('\n\n')}\n\n*Cara Proses:*\n• Ketik *p ORD-xxxxx* — tandai diproses\n• Ketik *d ORD-xxxxx <item produk>* — kirim produk ke pembeli & selesai\n• Ketik *${p}cekorder ORD-xxxxx* — lihat bukti bayar`)
    }

    if (['cekorder', 'detailorder'].includes(cmd)) {
      const { order } = findOrderForAdmin(args, ctxObj, true)
      if (!order) return reply(`Format: *${p}cekorder ORD-xxxxx*`)
      const st = order.status === 'done' ? '✅ Selesai (Done)' : order.status === 'processing' ? '🔄 Sedang Diproses' : order.status === 'cancelled' ? '❌ Dibatalkan' : '⏳ Menunggu Diproses'
      const caption = `🔎 *DETAIL PESANAN #${order.id}*
━━━━━━━━━━━━━━━━━━━━
🆔 *No. Resi :* #${order.id}
👤 *Pembeli :* ${order.buyerName} (${order.buyerPhone || '-'})
💬 *Asal Chat :* ${order.isGroup ? `Grup (${order.groupName || '-'})` : 'Chat Pribadi'}
📦 *Pesanan :* ${order.itemText}
📅 *Waktu Order :* ${order.createdTimeStr}
📌 *Status :* ${st}${order.deliveryText ? `\n🎁 *Item Terkirim :*\n${order.deliveryText}` : ''}
━━━━━━━━━━━━━━━━━━━━
Reply pesan ini dengan *p* (proses), kirim item produknya, atau ketik *d <item produk>* (selesai).`
      const imgPath = order.proofImage ? path.join(MEDIA_DIR, order.proofImage) : null
      if (imgPath && fs.existsSync(imgPath)) {
        const sent = await send(jid, { image: fs.readFileSync(imgPath), caption }, { quoted: m })
        if (sent?.key?.id) { rememberAdminMsg(order, sent.key.id); db.save() }
        return sent
      }
      const sent = await reply(caption)
      if (sent?.key?.id) { rememberAdminMsg(order, sent.key.id); db.save() }
      return sent
    }

    if (['batalorder', 'cancelorder', 'tolakorder'].includes(cmd)) {
      const [idPart, ...reasonParts] = String(args || '').split('|')
      const { order, restArgs } = findOrderForAdmin(idPart, ctxObj, true)
      if (!order) return reply(`Format: *${p}batalorder ORD-xxxxx|alasan pembatalan* (atau reply pesan pesanan lalu ketik *${p}batalorder alasan*)`)
      const reason = reasonParts.join('|').trim() || restArgs || ''
      order.status = 'cancelled'
      order.cancelReason = reason
      order.doneAt = Date.now()
      db.save()
      const resiCancel = buildResiText(order)
      const mentions = order.isGroup ? [order.buyerMentionJid] : []
      const quoted = buildBuyerQuoted(order)
      await send(order.sourceJid, { text: resiCancel, ...(mentions.length ? { mentions } : {}) }, quoted ? { quoted } : {})
      return reply(`❌ Pesanan *#${order.id}* telah dibatalkan dan pengingat 1 jam dihentikan.`)
    }

    if (cmd === 'kirim' || cmd === 'kirimpesanan') {
      const { order, multiple, restArgs } = findOrderForAdmin(args, ctxObj, true)
      if (multiple) {
        const listStr = multiple.map(o => `• *#${o.id}* — ${o.itemText} (${o.buyerName})`).join('\n')
        return reply(`⚠️ Ada ${multiple.length} pesanan aktif:\n${listStr}\n\nSilakan *reply* pesan pesanan yang dimaksud atau sertakan No. Resi:\n*${p}kirim ${multiple[0].id} <item produk>*`)
      }
      if (!order) return reply(`Reply pesan pesanan atau gunakan format:\n*${p}kirim ORD-xxxxx <item produk / akun>*`)
      let deliveryBuf = null
      if (c.imageMessage) {
        try { deliveryBuf = await downloadImage(m, c, null) } catch {}
      }
      if (!restArgs && !deliveryBuf) {
        return reply(`Tulis item produk yang ingin dikirim ke pembeli *#${order.id}*.\nContoh:\n*${p}kirim ${order.id} Email: xxx@gmail.com | Pass: 12345*`)
      }
      await sendProductItemToBuyer(order, restArgs, deliveryBuf)
      order.status = 'done'
      order.doneAt = Date.now()
      db.save()
      await sendDoneNotificationToBuyer(order, !!deliveryBuf)
      if (jid !== order.sourceJid) {
        return reply(`✅ Item produk *#${order.id}* (${order.itemText}) telah diteruskan ke pembeli *${order.buyerName}* & pemberitahuan *Pesanan Selesai* telah dikirim!`)
      }
      return true
    }

    // Perintah p (proses) dan d (done / selesai)
    const isDone = ['d', 'done', 'selesai'].includes(cmd)
    const { order, multiple, restArgs } = findOrderForAdmin(args, ctxObj, true)

    if (multiple) {
      const listStr = multiple.map(o => `• *#${o.id}* — ${o.itemText} (${o.buyerName}) [${o.status === 'processing' ? 'Diproses' : 'Pending'}]`).join('\n')
      return reply(`⚠️ Ada ${multiple.length} pesanan yang belum selesai:\n${listStr}\n\nSilakan *reply* pesan pesanan yang ingin diproses, atau tulis No. Resi-nya:\n• *p ${multiple[0].id}* (untuk proses)\n• *d ${multiple[0].id} <item produk>* (untuk kirim produk & selesai)`)
    }

    if (order) {
      if (!isDone) {
        // Tandai p (Sedang Diproses)
        order.status = 'processing'
        order.processedAt = Date.now()
        db.save()

        const resiProses = buildResiText(order)
        const mentions = order.isGroup ? [order.buyerMentionJid] : []
        const quoted = buildBuyerQuoted(order)
        await send(order.sourceJid, { text: resiProses, ...(mentions.length ? { mentions } : {}) }, quoted ? { quoted } : {})

        if (jid !== order.sourceJid) {
          const sent = await reply(`✅ Pesanan *#${order.id}* (${order.itemText}) ditandai *🔄 Sedang Diproses* dan pembeli sudah diberitahu.\n\n💡 _Selanjutnya: reply pesan ini dengan *item produknya* atau ketik *d <item produk>* untuk meneruskan ke pembeli & menyelesaikan pesanan._`)
          if (sent?.key?.id) { rememberAdminMsg(order, sent.key.id); db.save() }
          return sent
        }
        return true
      } else {
        // Tandai d (Done / Selesai): jika ada item produk baru, teruskan dulu itemnya ke pembeli, lalu kirim pemberitahuan selesai
        let deliveryBuf = null
        if (c.imageMessage) {
          try { deliveryBuf = await downloadImage(m, c, null) } catch {}
        }
        if (restArgs || deliveryBuf) {
          await sendProductItemToBuyer(order, restArgs, deliveryBuf)
        }
        order.status = 'done'
        order.doneAt = Date.now()
        db.save()

        await sendDoneNotificationToBuyer(order, !!deliveryBuf)

        if (jid !== order.sourceJid) {
          return reply(`✅ Pesanan *#${order.id}* (${order.itemText}) selesai (*Done*)!${restArgs || deliveryBuf ? '\n📦 Item produk sudah diteruskan ke pembeli & pemberitahuan Pesanan Selesai telah dikirim.' : '\n🧾 Pemberitahuan Pesanan Selesai telah dikirim ke pembeli.'}\n🔕 Pengingat 1 jam dihentikan.`)
        }
        return true
      }
    }

    // Fallback: jika admin me-reply pesan pembeli biasa (tanpa .beli) di grup/chat
    let target = null; let quoted = m
    if (ctx?.stanzaId) {
      target = ctx.participant || (isGroup ? null : jid)
      quoted = {
        key: { remoteJid: jid, id: ctx.stanzaId, participant: isGroup ? ctx.participant : undefined, fromMe: false },
        message: ctx.quotedMessage
      }
    } else if (!isGroup && fromMe) {
      target = jid
    }
    if (!target) {
      return reply(`Tidak ada pesanan aktif yang ditemukan.\n\n• Reply pesan pesanan lalu ketik *${cmd}*\n• Atau sebutkan No. Resi: *${cmd} ORD-xxxxx*\n• Ketik *${p}pesanan* untuk melihat daftar pesanan yang belum selesai.`)
    }
    if (isDone && restArgs) {
      await send(jid, { text: `📦 *DETAIL PESANAN KAKAK*\n━━━━━━━━━━━━━━━━━━━━\n${restArgs}`, mentions: [target] }, { quoted })
    }
    const text = fill(isDone ? S().doneText : S().prosesText, { user: target })
    return send(jid, { text, mentions: [target] }, { quoted })
  }

  // Pengingat otomatis ke Admin setiap 1 jam jika pesanan belum mendapat perintah d (Done)
  async function checkOrderReminders () {
    if (!liveSock()?.user) return
    const orders = Object.values(db.data.orders || {})
    const unresolved = orders.filter(o => o.status !== 'done' && o.status !== 'cancelled')
    if (!unresolved.length) return

    const now = Date.now()
    const reminderIntervalMs = (Number(config.orderReminderHours) || 1) * 3600 * 1000

    for (const order of unresolved) {
      const lastTime = order.lastReminderAt || order.createdAt || 0
      if (now - lastTime < reminderIntervalMs) continue

      const adminJids = getAdminJids(order.buyerPhone)
      if (!adminJids.length) continue

      order.lastReminderAt = now
      order.reminderCount = (order.reminderCount || 0) + 1
      db.save()

      const asalChat = order.isGroup ? `Grup (${order.groupName || order.sourceJid.split('@')[0]})` : 'Chat Pribadi'
      const statusLabel = order.status === 'processing'
        ? '🔄 Sedang Diproses (Belum ditandai *d / Done*)'
        : '⏳ Belum Diproses Admin'
      const reminderText = `⏰ *PENGINGAT PESANAN BELUM SELESAI — #${order.id}*
━━━━━━━━━━━━━━━━━━━━
⚠️ Pesanan ini sudah menunggu *${fmtWaitDuration(now - order.createdAt)}* dan belum mendapat perintah *d (Done)*!

🆔 *No. Resi :* #${order.id}
👤 *Pembeli :* ${order.buyerName} (${order.buyerPhone || '-'})
💬 *Asal Chat :* ${asalChat}
📦 *Pesanan :* ${order.itemText}
📅 *Waktu Order :* ${order.createdTimeStr}
📌 *Status :* ${statusLabel}
🔔 *Pengingat ke-* ${order.reminderCount}
━━━━━━━━━━━━━━━━━━━━
*Reply pesan ini untuk memproses:*
▸ Ketik *p* — tandai sedang diproses
▸ Ketik *d <item produk>* — kirim produk ke pembeli & selesai
▸ Ketik *d* — tandai selesai (Done)
▸ Ketik *${prefixes[0]}batalorder ${order.id}* — batalkan pesanan`

      const imgPath = order.proofImage ? path.join(MEDIA_DIR, order.proofImage) : null
      const hasImg = imgPath && fs.existsSync(imgPath)

      for (const adminJid of adminJids) {
        if (adminJid === order.sourceJid) continue
        try {
          const sent = hasImg
            ? await send(adminJid, { image: fs.readFileSync(imgPath), caption: reminderText })
            : await send(adminJid, { text: reminderText })
          if (sent?.key?.id) rememberAdminMsg(order, sent.key.id)
        } catch {}
      }
      db.save()
    }
  }

  if (reminderTimer) clearInterval(reminderTimer)
  reminderTimer = setInterval(() => {
    checkOrderReminders().catch(e => console.error('[ERROR reminder]', e?.message || e))
  }, 60 * 1000)

  // ------------- tanya-jawab tambah/ubah produk -------------
  const wizards = new Map()
  const wizKey = (jid, ids, fromMe) => `${jid}|${fromMe ? 'me' : digits(ids[0])}`

  const ASK = {
    title: (w) => `📦 *${w.mode === 'add' ? 'TAMBAH' : 'UBAH'} PRODUK*\nKode produk: *${w.name.toLowerCase()}*  _(ini yang tampil di menu & diketik pembeli)_\n\n*Langkah 1/5* — Kirim *judul produk* (tampil paling atas waktu pembeli ketik *${w.name.toLowerCase()}*).\nContoh: YOUTUBE PREMIUM\n\nKetik *-* untuk ${w.existing?.title ? `tetap pakai "${w.existing.title}"` : `pakai "${w.name}"`}.\n_Ketik *${prefixes[0]}batal* untuk membatalkan._`,
    types: () => `📦 *Langkah 2/5* — Kirim *jenis & harga*, 1 baris 1 jenis.\nFormat: *nama jenis = harga*\n\nContoh (banyak jenis):\n1 Bulan = 15000\n3 Bulan = 40000\nJaspay 1 Bulan = 5000\n\nKalau cuma *1 jenis*, cukup kirim harganya:\n25000`,
    desc: () => `📝 *Langkah 3/5* — Kirim *keterangan*, 1 baris 1 poin.\nContoh:\nGaransi 1 bulan\nAkun dari admin\n\nKetik *-* untuk lewati.`,
    note: () => `📌 *Langkah 4/5* — Kirim *note / catatan* (boleh beberapa baris).\nContoh:\n1 Bulan = Garansi 1x\nJaspay 1 Bulan = nogar\n\nKetik *-* untuk lewati.`,
    image: (w) => `🖼️ *Langkah 5/5* — Kirim *gambar produk*.\nKetik *-* untuk ${w.existing?.image ? 'tetap pakai gambar lama' : 'tanpa gambar'}${w.existing?.image ? ', atau *hapus* untuk menghapus gambar' : ''}.`
  }

  async function startWizard (ctxObj, mode, name, existing) {
    const { jid, m, ids, fromMe } = ctxObj
    const w = {
      mode,
      name: existing ? existing.name : String(name).trim().toUpperCase(),
      key: existing ? existing.key : name,
      existing,
      step: 'title',
      data: { title: existing?.title || '', types: [], desc: [], note: '' },
      expires: Date.now() + WIZARD_TIMEOUT
    }
    wizards.set(wizKey(jid, ids, fromMe), w)
    return send(jid, { text: ASK.title(w) }, { quoted: m })
  }

  async function wizardStep (w, wkey, ctxObj, text) {
    const { jid, m, c } = ctxObj
    const ask = (step) => { w.step = step; w.expires = Date.now() + WIZARD_TIMEOUT; return send(jid, { text: ASK[step](w) }, { quoted: m }) }
    const t = text.trim()
    const skip = ['-', 'skip', 'lewati', 'tidak', 'gak', 'no'].includes(t.toLowerCase())

    switch (w.step) {
      case 'title':
        if (!t) return ask('title')
        if (!skip) w.data.title = t.toUpperCase()
        return ask('types')
      case 'types': {
        const types = parseTypes(t)
        if (skip || !types.length) return send(jid, { text: '⚠️ Jenis/harga wajib diisi minimal 1 baris.\nContoh: *1 Bulan = 10000* atau cukup *25000*' }, { quoted: m })
        const noPrice = types.filter(x => !x.price)
        if (noPrice.length) return send(jid, { text: `⚠️ Harga belum ada untuk: *${noPrice.map(x => x.name).join(', ')}*\nTulis dengan format *nama jenis = harga*, contoh:\n${noPrice[0].name} = 25000` }, { quoted: m })
        w.data.types = types
        return ask('desc')
      }
      case 'desc':
        w.data.desc = skip ? [] : splitLines(t)
        return ask('note')
      case 'note':
        w.data.note = skip ? '' : t
        return ask('image')
      case 'image': {
        let image = w.existing?.image || null
        if (c.imageMessage) {
          try {
            const buf = await downloadImage(m, c, null)
            image = saveImage(w.key, buf, w.existing?.image)
          } catch (e) {
            return send(jid, { text: 'Gagal mengunduh gambar, coba kirim lagi atau ketik - untuk lewati.' }, { quoted: m })
          }
        } else if (t.toLowerCase() === 'hapus') {
          removeImage(w.existing?.image); image = null
        } else if (!skip) {
          return ask('image')
        }
        wizards.delete(wkey)
        const patch = { ...w.data, image, text: undefined, variants: undefined }
        if (!w.existing) patch.name = w.name
        const saved = db.setItem(w.key, patch)
        const mkNote = privateMarkup() > 0 ? `\n_(Harga grup. Di luar grup otomatis tampil +Rp ${privateMarkup().toLocaleString('id-ID')})_` : ''
        await send(jid, { text: `✅ Produk *${saved.name.toLowerCase()}* berhasil ${w.mode === 'add' ? 'ditambahkan' : 'diperbarui'}! Begini tampilannya di grup:${mkNote}` }, { quoted: m })
        return sendItem(jid, saved, m, { basePrice: true })
      }
    }
  }

  // ------------- perintah admin -------------
  async function adminCommand (cmd, args, ctxObj) {
    const { jid, m, c, ctx, isGroup, ids, fromMe } = ctxObj
    const reply = (text, extra = {}) => send(jid, { text, ...extra }, { quoted: m })
    const [left, ...rest] = args.split('|')
    const name = (left || '').trim()
    const body = rest.join('|').trim()
    const p = prefixes[0]

    switch (cmd) {
      case 'admin': case 'adminmenu': case 'help': case 'menuadmin':
        return reply(adminHelp())

      case 'addlist': case 'tambahlist': case 'updatelist': case 'editlist': case 'setlist': {
        const isAdd = cmd === 'addlist' || cmd === 'tambahlist'
        if (!name) {
          return reply(`*Cara tambah produk:*\n\n1️⃣ Tanya-jawab (paling gampang):\n*${p}addlist gemini*\nlalu ikuti pertanyaan bot.\n\n2️⃣ Cara cepat 1 pesan:\n*${p}addlist nama|jenis=harga; jenis=harga|keterangan|note*\n\nContoh banyak jenis:\n${p}addlist gemini|1 Bulan=10000; 3 Bulan=25000; 18 Bulan=50000|Garansi full; Akun pribadi|-\n\nContoh 1 jenis:\n${p}addlist express vpn|35000`)
        }
        const existing = db.findItem(name)
        if (isAdd && existing) return reply(`Produk *${existing.name}* sudah ada.\nPakai *${p}updatelist ${existing.name}* untuk mengubah, *${p}addjenis ${existing.name}|jenis=harga* untuk tambah jenis, atau *${p}setharga ${existing.name}|...* untuk ganti harga.`)
        if (!isAdd && !existing) return reply(`Produk *${name.toUpperCase()}* belum ada. Pakai *${p}addlist ${name}* untuk menambah.`)

        // tanpa "|" -> mode tanya-jawab
        if (!rest.length) return startWizard(ctxObj, isAdd ? 'add' : 'update', name, existing)

        // cara cepat
        const data = parseQuick(rest)
        if (!data.types.length) return reply(`Jenis/harga belum diisi.\nFormat: *${p}${cmd} nama|jenis=harga; jenis=harga|keterangan|note*`)
        const noPrice = data.types.filter(x => !x.price)
        if (noPrice.length) return reply(`Harga belum ada untuk: *${noPrice.map(x => x.name).join(', ')}*\nTulis *nama jenis=harga*, contoh: ${noPrice[0].name}=25000`)
        let buf = null
        try { buf = await downloadImage(m, c, ctx) } catch (e) { return reply('Gagal mengunduh gambar: ' + e.message) }
        const patch = { ...data, text: undefined, variants: undefined }
        if (buf) patch.image = saveImage(name, buf, existing?.image)
        if (!existing) patch.name = name.toUpperCase()
        const saved = db.setItem(existing ? existing.key : name, patch)
        const mkNote = privateMarkup() > 0 ? `\n_(Harga grup. Di luar grup otomatis tampil +Rp ${privateMarkup().toLocaleString('id-ID')})_` : ''
        await reply(`✅ Produk *${saved.name}* berhasil ${isAdd ? 'ditambahkan' : 'diperbarui'}${buf ? ' (dengan gambar)' : ''}. Tampilannya di grup:${mkNote}`)
        return sendItem(jid, saved, m, { basePrice: true })
      }

      case 'addlistraw': case 'updatelistraw': {
        if (!name || !body) return reply(`Format: *${p}${cmd} nama|teks bebas*\n(teks dikirim apa adanya, tanpa format otomatis)`)
        const existing = db.findItem(name)
        let buf = null
        try { buf = await downloadImage(m, c, ctx) } catch (e) { return reply('Gagal mengunduh gambar: ' + e.message) }
        const patch = { text: body, variants: undefined, types: undefined, desc: undefined, note: undefined }
        if (buf) patch.image = saveImage(name, buf, existing?.image)
        if (!existing) patch.name = name.toUpperCase()
        const saved = db.setItem(existing ? existing.key : name, patch)
        return reply(`✅ Produk *${saved.name}* disimpan (teks bebas).`)
      }

      case 'setharga': case 'setjenis': case 'addjenis': case 'tambahjenis': case 'deljenis': case 'hapusjenis':
      case 'setket': case 'setketerangan': case 'setdesk': case 'setnote': {
        const kind = ['setharga', 'setjenis'].includes(cmd) ? 'types'
          : ['addjenis', 'tambahjenis'].includes(cmd) ? 'add'
            : ['deljenis', 'hapusjenis'].includes(cmd) ? 'del'
              : cmd === 'setnote' ? 'note' : 'desc'
        const usage = {
          types: `*${p}${cmd} nama|jenis=harga; jenis=harga*\nContoh: ${p}${cmd} gemini|1 Bulan=10000; 3 Bulan=25000`,
          add: `*${p}${cmd} nama|jenis=harga*\nContoh: ${p}${cmd} gemini|6 Bulan=35000`,
          del: `*${p}${cmd} nama|nomor atau nama jenis*\nContoh: ${p}${cmd} gemini|2  atau  ${p}${cmd} gemini|3 Bulan`,
          desc: `*${p}${cmd} nama|ket1; ket2*  (- untuk hapus)\nContoh: ${p}${cmd} gemini|Garansi full; Akun pribadi`,
          note: `*${p}${cmd} nama|teks*  (- untuk hapus)`
        }[kind]
        if (!name || !rest.length || !body) return reply('Format: ' + usage)
        const found = db.findItem(name)
        if (!found) return reply(`Produk *${name.toUpperCase()}* tidak ditemukan.`)
        const it = toTypesItem(found)
        if (!it) return reply(`Produk *${found.name}* memakai teks bebas. Pakai *${p}updatelist ${found.name}* untuk mengubahnya ke format otomatis.`)
        let types = (it.types || []).map(x => ({ ...x }))
        let msgDone = ''
        if (kind === 'types' || kind === 'add') {
          const vals = parseTypes(body)
          if (!vals.length) return reply('Format: ' + usage)
          const noPrice = vals.filter(x => !x.price)
          if (noPrice.length) return reply(`Harga belum ada untuk: *${noPrice.map(x => x.name).join(', ')}*\nFormat: ` + usage)
          if (kind === 'types') { types = vals; msgDone = 'Jenis & harga diperbarui untuk' } else {
            for (const v of vals) {
              const i = types.findIndex(x => normKey(x.name) === normKey(v.name))
              if (i >= 0 && v.name) types[i] = v; else types.push(v)
            }
            msgDone = 'Jenis berhasil ditambahkan ke'
          }
          db.setItem(it.key, { types, desc: it.desc || [], note: it.note || '', variants: undefined })
        } else if (kind === 'del') {
          const q = body.trim()
          const idx = /^\d+$/.test(q) ? Number(q) - 1 : types.findIndex(x => normKey(x.name) === normKey(q))
          if (idx < 0 || idx >= types.length) return reply(`Jenis *${q}* tidak ditemukan. Jenis yang ada:\n${types.map((x, i) => `${i + 1}. ${x.name || x.price}`).join('\n')}`)
          if (types.length === 1) return reply('Ini jenis terakhir. Kalau mau hapus produknya pakai *' + p + 'dellist ' + it.name + '*')
          const [gone] = types.splice(idx, 1)
          db.setItem(it.key, { types, desc: it.desc || [], note: it.note || '', variants: undefined })
          msgDone = `Jenis "${gone.name || gone.price}" dihapus dari`
        } else if (kind === 'note') {
          db.setItem(it.key, { types, desc: it.desc || [], note: body === '-' ? '' : body, variants: undefined })
          msgDone = 'Note diperbarui untuk'
        } else {
          db.setItem(it.key, { types, desc: body === '-' ? [] : splitLines(body), note: it.note || '', manualDesc: true, variants: undefined })
          msgDone = 'Keterangan diperbarui untuk'
        }
        const mkNote = privateMarkup() > 0 ? `\n_(Harga grup. Di luar grup otomatis tampil +Rp ${privateMarkup().toLocaleString('id-ID')})_` : ''
        await reply(`✅ ${msgDone} *${it.name}*. Tampilannya di grup:${mkNote}`)
        return sendItem(jid, db.findItem(it.key), m, { basePrice: true })
      }

      case 'setjudul': case 'judul': {
        if (!name || !rest.length || !body) return reply(`Format: *${p}setjudul kode|JUDUL PRODUK*\nContoh: ${p}setjudul youtube|YOUTUBE PREMIUM\n(*${p}setjudul youtube|-* untuk hapus judul)`)
        const it = db.findItem(name)
        if (!it) return reply(`Produk *${name.toLowerCase()}* tidak ditemukan.`)
        db.setItem(it.key, { title: body === '-' ? undefined : body.toUpperCase() })
        await reply(`✅ Judul produk *${it.name.toLowerCase()}* jadi *${body === '-' ? it.name : body.toUpperCase()}*. Tampilannya:`)
        return sendItem(jid, db.findItem(it.key), m, { basePrice: true })
      }

      case 'setgambar': {
        if (!name) return reply(`Kirim gambar dengan caption *${p}setgambar nama*, atau reply gambar lalu ketik *${p}setgambar nama*`)
        const it = db.findItem(name)
        if (!it) return reply(`Produk *${name.toUpperCase()}* tidak ditemukan.`)
        let buf = null
        try { buf = await downloadImage(m, c, ctx) } catch (e) { return reply('Gagal mengunduh gambar: ' + e.message) }
        if (!buf) return reply(`Gambar tidak ditemukan. Kirim gambar dengan caption *${p}setgambar ${it.name}* atau reply gambarnya.`)
        db.setItem(it.key, { image: saveImage(it.key, buf, it.image) })
        return reply(`✅ Gambar produk *${it.name}* diperbarui.`)
      }

      case 'setfooter': {
        if (!args.trim()) return reply(`Format: *${p}setfooter teks*\n*${p}setfooter off* untuk menghilangkan, *${p}setfooter reset* untuk bawaan.`)
        const v = args.trim()
        S().itemFooter = v.toLowerCase() === 'off' ? '' : v.toLowerCase() === 'reset' ? DEFAULT_FOOTER : v
        db.save()
        return reply('✅ Footer produk diperbarui.')
      }

      case 'batal': case 'cancel':
        return reply('Tidak ada proses yang sedang berjalan.')

      case 'setbayar': case 'setpayment': {
        const existing = db.findItem('bayar')
        let buf = null
        try { buf = await downloadImage(m, c, ctx) } catch (e) { return reply('Gagal mengunduh gambar: ' + e.message) }
        const text = args.trim()
        if (!text && !buf) return reply(`Format: *${p}setbayar teks metode pembayaran*\nKirim bersama gambar QRIS (atau reply gambar QRIS) untuk mengganti gambarnya.`)
        const patch = {}
        if (text) patch.text = text
        if (buf) patch.image = saveImage('bayar', buf, existing?.image)
        if (!existing) patch.name = 'BAYAR'
        db.setItem(existing ? existing.key : 'bayar', patch)
        return reply(`✅ Pesan *BAYAR* berhasil diperbarui${buf ? ' (dengan gambar QRIS)' : ''}.`)
      }

      case 'dellist': case 'hapuslist': case 'deletelist': {
        if (!name) return reply(`Format: *${p}dellist nama*`)
        const del = db.deleteItem(name)
        if (!del) return reply(`Produk *${name.toUpperCase()}* tidak ditemukan.`)
        removeImage(del.image)
        return reply(`🗑️ Produk *${del.name}* dihapus.`)
      }

      case 'renamelist': {
        if (!name || !body) return reply(`Format: *${p}renamelist nama lama|nama baru*`)
        const it = db.findItem(name)
        if (!it) return reply(`Produk *${name.toUpperCase()}* tidak ditemukan.`)
        if (db.findItem(body) && db.findItem(body).key !== it.key) return reply(`Nama *${body.toUpperCase()}* sudah dipakai.`)
        const { key, ...itemData } = it
        delete db.data.list[key]
        db.setItem(body, { ...itemData, name: body.toUpperCase() })
        return reply(`✅ *${it.name}* diganti menjadi *${body.toUpperCase()}*.`)
      }

      case 'getlist': case 'cekisi': case 'cekproduk': {
        if (!name) return reply(`Format: *${p}getlist nama*`)
        const it = db.findItem(name)
        if (!it) return reply(`Produk *${name.toUpperCase()}* tidak ditemukan.`)
        const quick = toQuick(it)
        if (quick) {
          await reply(`Data *${it.name}* (gambar: ${it.image ? 'ada' : 'tidak ada'}). Salin pesan di bawah, edit, lalu kirim lagi:`)
          await send(jid, { text: `${p}updatelist ${quick}` })
          if (it.title) return send(jid, { text: `${p}setjudul ${it.name.toLowerCase()}|${it.title}` })
          return
        }
        await reply(`Teks asli *${it.name}* (gambar: ${it.image ? 'ada' : 'tidak ada'}). Salin pesan di bawah, edit, lalu kirim lagi:`)
        return send(jid, { text: `${p}updatelistraw ${it.name}|${it.text}` })
      }

      case 'delgambar': case 'hapusgambar': {
        if (!name) return reply(`Format: *${p}delgambar nama*`)
        const it = db.findItem(name)
        if (!it) return reply(`Produk *${name.toUpperCase()}* tidak ditemukan.`)
        removeImage(it.image)
        db.setItem(it.key, { image: null })
        return reply(`✅ Gambar produk *${it.name}* dihapus.`)
      }

      case 'settoko': case 'setnamatoko': {
        if (!args.trim()) return reply(`Format: *${p}settoko nama toko*`)
        S().storeName = args.trim(); db.save()
        return reply(`✅ Nama toko diganti menjadi *${S().storeName}*.`)
      }

      case 'setmenu': {
        if (!args.trim()) return reply(`Format: *${p}setmenu teks*\nKode yang bisa dipakai: {salam} @user {toko} {list}`)
        S().menuTemplate = args.trim(); db.save()
        return reply('✅ Teks menu diperbarui. Ketik *menu* untuk mencoba.')
      }
      case 'resetmenu':
        S().menuTemplate = DEFAULT_MENU; db.save()
        return reply('✅ Teks menu dikembalikan ke bawaan.')

      case 'setproses': case 'setdone': case 'setauto': {
        const field = { setproses: 'prosesText', setdone: 'doneText', setauto: 'autoReplyText' }[cmd]
        const def = { setproses: DEFAULT_PROSES, setdone: DEFAULT_DONE, setauto: DEFAULT_AUTOREPLY }[cmd]
        if (!args.trim()) return reply(`Format: *${p}${cmd} teks*  (ketik *${p}${cmd} reset* untuk bawaan)\nKode: {salam} {tanggal} {jam} {toko} @user`)
        S()[field] = args.trim().toLowerCase() === 'reset' ? def : args.trim(); db.save()
        return reply('✅ Teks berhasil diperbarui.')
      }

      case 'autoreply': {
        const v = args.trim().toLowerCase()
        if (!['on', 'off'].includes(v)) return reply(`Format: *${p}autoreply on/off*  (sekarang: ${S().autoReply ? 'on' : 'off'})`)
        S().autoReply = v === 'on'; db.save()
        return reply(`✅ Balasan otomatis chat pribadi: *${v}*`)
      }

      case 'p': case 'proses': case 'd': case 'done': case 'selesai':
      case 'kirim': case 'kirimpesanan':
      case 'pesanan': case 'listorder': case 'orders': case 'antrean':
      case 'cekorder': case 'detailorder':
      case 'batalorder': case 'cancelorder': case 'tolakorder':
        return handleOrderAdminAction(cmd, args, ctxObj)

      case 'open': case 'buka': case 'close': case 'tutup': {
        if (!isGroup) return reply('Perintah ini hanya untuk grup.')
        const close = cmd === 'close' || cmd === 'tutup'
        try {
          await liveSock().groupSettingUpdate(jid, close ? 'announcement' : 'not_announcement')
          return reply(close ? '🔒 Grup ditutup, hanya admin yang bisa kirim pesan.' : '🔓 Grup dibuka, semua member bisa kirim pesan.')
        } catch (e) {
          return reply('Gagal. Pastikan bot sudah dijadikan *admin grup*.')
        }
      }

      case 'kick': case 'keluarkan': case 'tendang': case 'dor': {
        if (!isGroup) return reply('⚠️ Perintah ini hanya bisa digunakan di dalam grup.')
        const targets = new Set()
        if (ctx?.participant) targets.add(ctx.participant)
        if (Array.isArray(ctx?.mentionedJid)) {
          for (const mj of ctx.mentionedJid) if (mj) targets.add(mj)
        }
        let meta = null
        try { meta = await getGroup(jid) } catch {}
        const parts = meta?.participants || []

        if (!targets.size && args.trim()) {
          const rawTokens = args.trim().split(/[\s,;]+/).filter(Boolean)
          for (const tok of rawTokens) {
            const num = normPhone(tok)
            if (!num || num.length < 7) continue
            const found = parts.find(pt => {
              const pId = normPhone(digits(pt.id))
              const pPhone = normPhone(digits(pt.phoneNumber || ''))
              const pLidMap = String(pt.id).endsWith('@lid') ? db.data.lidToPn?.[normLid(pt.id)] : ''
              return pId === num || pPhone === num || pLidMap === num
            })
            if (found?.id) targets.add(found.id)
            else targets.add(num + '@s.whatsapp.net')
          }
        }

        if (!targets.size) {
          return reply(`⚠️ Pilih member yang ingin dikeluarkan:\n• *Reply* pesan member lalu ketik *${p}kick*\n• *Tag* member: *${p}kick @member*\n• Ketik nomornya: *${p}kick 0812xxxx*`)
        }

        const botNum = normPhone(digits(liveSock()?.user?.id || ''))
        const botLid = normLid(liveSock()?.user?.lid || '')
        const validTargets = [...targets].filter(tJid => {
          const tNum = normPhone(digits(tJid))
          if (botNum && tNum === botNum) return false
          if (botLid && normLid(tJid) === botLid) return false
          if (isAdmin([tJid], false)) return false
          return true
        })

        if (!validTargets.length) {
          return reply('⛔ Tidak bisa mengeluarkan nomor Admin/Owner atau nomor Bot sendiri.')
        }

        try {
          await liveSock().groupParticipantsUpdate(jid, validTargets, 'remove')
          groupCache.delete(jid)
          const tagList = validTargets.map(u => '@' + u.split('@')[0].split(':')[0]).join(', ')
          return send(jid, {
            text: `👢 Member ${tagList} telah dikeluarkan dari grup.`,
            mentions: validTargets
          }, { quoted: m })
        } catch (e) {
          return reply('⚠️ Gagal mengeluarkan member. Pastikan nomor Bot sudah dijadikan *Admin Grup* terlebih dahulu.')
        }
      }

      case 'add': case 'tambahmember': case 'undang': case 'invite': {
        if (!isGroup) return reply('⚠️ Perintah ini hanya bisa digunakan di dalam grup.')
        const nums = new Set()
        if (ctx?.participant) {
          const pJid = ctx.participant
          if (pJid.endsWith('@s.whatsapp.net')) {
            const n = normPhone(digits(pJid))
            if (n) nums.add(n)
          } else if (pJid.endsWith('@lid')) {
            const mapped = db.data.lidToPn?.[normLid(pJid)]
            if (mapped) nums.add(mapped)
          }
        }
        if (args.trim()) {
          const tokens = args.replace(/[@+-]/g, ' ').split(/[\s,;]+/).filter(Boolean)
          for (const tok of tokens) {
            const n = normPhone(tok)
            if (n && n.length >= 8 && n.length <= 16) nums.add(n)
          }
        }

        if (!nums.size) {
          return reply(`⚠️ Masukkan nomor WhatsApp yang ingin ditambahkan ke grup:\n• *${p}add 0812xxxxxxxx*\n• *${p}add 62812xxxx 62813xxxx*\n• Atau *reply* pesan orangnya lalu ketik *${p}add*`)
        }

        const targetJids = [...nums].map(n => n + '@s.whatsapp.net')
        try {
          const res = await liveSock().groupParticipantsUpdate(jid, targetJids, 'add')
          groupCache.delete(jid)
          const addedList = []
          const alreadyList = []
          const inviteSentList = []
          const failedList = []

          for (let i = 0; i < targetJids.length; i++) {
            const tJid = targetJids[i]
            const itemRes = Array.isArray(res) ? (res.find(r => r?.jid === tJid) || res[i]) : null
            const st = String(itemRes?.status || '200')
            if (st === '200') {
              addedList.push(tJid)
            } else if (st === '409') {
              alreadyList.push(tJid)
            } else if (st === '403' || st === '408') {
              try {
                const code = await liveSock().groupInviteCode(jid)
                if (code) {
                  let gName = S().storeName
                  try { gName = (await getGroup(jid)).subject || gName } catch {}
                  await send(tJid, {
                    text: `👋 Halo kak! Admin *${S().storeName}* mengundang kakak bergabung ke grup *${gName}*:\nhttps://chat.whatsapp.com/${code}`
                  })
                  inviteSentList.push(tJid)
                } else {
                  failedList.push(`${digits(tJid)} (privasi)`)
                }
              } catch {
                failedList.push(`${digits(tJid)} (privasi/keluar baru saja)`)
              }
            } else {
              failedList.push(`${digits(tJid)} (kode ${st})`)
            }
          }

          const lines = []
          const mentions = []
          if (addedList.length) {
            mentions.push(...addedList)
            lines.push(`✅ Berhasil ditambahkan: ${addedList.map(u => '@' + digits(u)).join(', ')}`)
          }
          if (alreadyList.length) {
            mentions.push(...alreadyList)
            lines.push(`ℹ️ Sudah ada di grup: ${alreadyList.map(u => '@' + digits(u)).join(', ')}`)
          }
          if (inviteSentList.length) {
            lines.push(`📩 Privasi nomor dikunci, link undangan grup otomatis dikirim ke chat pribadi: ${inviteSentList.map(u => digits(u)).join(', ')}`)
          }
          if (failedList.length) {
            lines.push(`⚠️ Gagal ditambahkan: ${failedList.join(', ')}`)
          }
          return send(jid, {
            text: lines.join('\n') || '✅ Selesai memproses penambahan member.',
            ...(mentions.length ? { mentions } : {})
          }, { quoted: m })
        } catch (e) {
          return reply('⚠️ Gagal menambahkan member. Pastikan nomor Bot sudah dijadikan *Admin Grup* terlebih dahulu.')
        }
      }

      case 'h': case 'hidetag': case 'tagall': {
        if (!isGroup) return reply('Perintah ini hanya untuk grup.')
        const meta = await getGroup(jid)
        const mentions = meta.participants.map(x => x.id)
        const qText = ctx?.quotedMessage ? getText(unwrap(ctx.quotedMessage)) : ''
        const text = args.trim() || qText || '📢'
        return send(jid, { text, mentions })
      }

      case 'welcome': {
        if (!isGroup) return reply('Perintah ini hanya untuk grup.')
        const v = args.trim().toLowerCase()
        const ch = db.chat(jid)
        if (!['on', 'off'].includes(v)) return reply(`Format: *${p}welcome on/off*  (sekarang: ${ch.welcome ? 'on' : 'off'})`)
        ch.welcome = v === 'on'; db.save()
        return reply(`✅ Sambutan member baru: *${v}*`)
      }

      case 'setwelcome': {
        if (!isGroup) return reply('Perintah ini hanya untuk grup.')
        if (!args.trim()) return reply(`Format: *${p}setwelcome teks*\nKode: @user {grup} {toko} {salam}`)
        db.chat(jid).welcomeText = args.trim(); db.save()
        return reply('✅ Teks sambutan diperbarui.')
      }

      case 'bot': {
        const v = args.trim().toLowerCase()
        const ch = db.chat(jid)
        if (!['on', 'off'].includes(v)) return reply(`Format: *${p}bot on/off*  (sekarang: ${ch.botOff ? 'off' : 'on'})`)
        ch.botOff = v === 'off'; db.save()
        return reply(v === 'off'
          ? '😴 Bot dimatikan di chat ini (perintah admin tetap jalan).'
          : '✅ Bot aktif lagi di chat ini.')
      }

      case 'addadmin': case 'deladmin': {
        if (!isOwner(ids, fromMe)) return reply('Hanya owner yang bisa mengatur admin.')
        const add = cmd === 'addadmin'
        let num = normPhone(args)
        let extraId = null
        if (!num && ctx?.participant) {
          extraId = ctx.participant
          num = ctx.participant.endsWith('@s.whatsapp.net') ? digits(ctx.participant) : ''
        }
        if (!num && !extraId) return reply(`Format: *${p}${cmd} 08xxxx* atau reply pesan orangnya.`)
        db.data.admins = db.data.admins || []; db.data.adminIds = db.data.adminIds || []
        if (add) {
          if (num && !db.data.admins.includes(num)) db.data.admins.push(num)
          if (extraId && !db.data.adminIds.includes(extraId)) db.data.adminIds.push(extraId)
        } else {
          db.data.admins = db.data.admins.filter(x => x !== num)
          if (extraId) db.data.adminIds = db.data.adminIds.filter(x => x !== extraId)
        }
        db.save()
        return reply(`✅ ${num || extraId.split('@')[0]} ${add ? 'ditambahkan sebagai' : 'dihapus dari'} admin.`)
      }

      case 'listadmin': {
        const lines = [
          ...ownerNums.map(n => `👑 ${n} (owner)`),
          ...(db.data.admins || []).map(n => `🛡️ ${n}`),
          ...(db.data.adminIds || []).map(n => `🛡️ ${n}`)
        ]
        return reply(`*Daftar Admin*\n\n${lines.join('\n')}`)
      }

      case 'backup': {
        const to = fromMe ? jid : (ownerJid && !isGroup ? jid : ownerJid || jid)
        await send(to, {
          document: fs.readFileSync(db.file),
          fileName: `backup-db-${new Date().toISOString().slice(0, 10)}.json`,
          mimetype: 'application/json'
        })
        if (to !== jid) return reply('📦 Backup database dikirim ke chat pribadi owner.')
        return
      }

      case 'web': case 'dashboard':
        return webCommand(args, ctxObj)

      case 'sticker': case 'stiker': {
        const v = args.trim().toLowerCase()
        if (!['on', 'off'].includes(v)) return false // bukan on/off -> lanjut bikin stiker biasa
        S().stickerEnabled = v === 'on'; db.save()
        return reply(v === 'on'
          ? `✅ Fitur stiker *dinyalakan* (jatah ${stickerLimit()}x/orang/hari). Muncul juga di menu.`
          : '😴 Fitur stiker *dimatikan* & disembunyikan dari menu.')
      }

      case 'setuntung': case 'untung': case 'profit': case 'setprofit': {
        const rawVal = args.trim().replace(/[^0-9]/g, '')
        const curProfit = Number(S().syncMarkup ?? config.syncMarkup ?? 5000)
        if (!args.trim() || !rawVal) {
          return reply(`Format: *${p}setuntung 5000*\n\nUntung reseller per produk sekarang: *+Rp ${curProfit.toLocaleString('id-ID')}*\n_(Setiap produk otomatis dijual dengan Harga Modal + Rp ${curProfit.toLocaleString('id-ID')} tanpa sepengetahuan pembeli)_`)
        }
        const n = Math.floor(Number(rawVal))
        if (n > 10000000) return reply('Nominal terlalu besar.')
        const updatedCount = tgsync.recalculateMarkupPrices(db, n)
        return reply(`✅ Untung reseller berhasil diatur ke *+Rp ${n.toLocaleString('id-ID')} / produk*!\n📦 Sebanyak *${updatedCount} produk* telah dihitung ulang harganya secara otomatis (Harga Modal + Rp ${n.toLocaleString('id-ID')}).`)
      }

      case 'kunciproduk': case 'lockproduk': case 'unlockproduk': {
        if (!name) return reply(`Format: *${p}kunciproduk nama produk*\nContoh: *${p}kunciproduk canva*\n_(Produk yang dikunci tidak akan diubah harganya saat sinkron otomatis jalan)_`)
        const it = db.findItem(name)
        if (!it) return reply(`Produk *${name.toUpperCase()}* tidak ditemukan.`)
        const nextLock = cmd === 'unlockproduk' ? false : cmd === 'lockproduk' ? true : !it.syncLocked
        db.setItem(it.key, { syncLocked: nextLock })
        return reply(nextLock
          ? `🔒 Produk *${it.name}* sekarang *DIKUNCI*. Harga & deskripsi produk ini tidak akan tertimpa saat sinkron otomatis.`
          : `🔓 Kunci produk *${it.name}* dibuka. Produk ini akan ikut diperbarui saat sinkron otomatis.`)
      }

      case 'kuncistok': case 'lockstok': case 'unlockstok': {
        if (!name) return reply(`Format: *${p}kuncistok nama produk*\nContoh: *${p}kuncistok netflix*\n_(Stok produk yang dikunci tidak akan tertimpa saat sinkron dari bot pusat, tapi harga tetap bisa ikut update)_`)
        const it = db.findItem(name)
        if (!it) return reply(`Produk *${name.toUpperCase()}* tidak ditemukan.`)
        const nextLock = cmd === 'unlockstok' ? false : cmd === 'lockstok' ? true : !it.stockLocked
        db.setItem(it.key, { stockLocked: nextLock })
        return reply(nextLock
          ? `📌 Stok *${it.name}* sekarang *DIKUNCI (Manual)*. Stok tidak akan tertimpa saat sinkron dari bot pusat.`
          : `🔓 Kunci stok *${it.name}* dibuka. Stok akan ikut diperbarui dari bot pusat saat sinkron.`)
      }

      case 'setstok': case 'aturstok': case 'ubahstok':
      case 'tambahstok': case 'addstok':
      case 'habis': case 'stokhabis':
      case 'ready': case 'stokready': {
        const isAddMode = ['tambahstok', 'addstok'].includes(cmd)
        const isHabisCmd = ['habis', 'stokhabis'].includes(cmd)
        const isReadyCmd = ['ready', 'stokready'].includes(cmd)

        let prodQuery = name
        let valSpec = body
        if (!valSpec && args.trim()) {
          if (isHabisCmd) {
            prodQuery = args.trim()
            valSpec = '0'
          } else {
            const mTail = args.trim().match(/^(.+?)\s+(habis|kosong|ready|unlimited|tanpabatas|-\s*|[+-]?\d+)$/i)
            if (mTail) {
              prodQuery = mTail[1].trim()
              valSpec = mTail[2].trim()
            } else if (isReadyCmd) {
              prodQuery = args.trim()
              valSpec = 'unlimited'
            }
          }
        }

        if (!prodQuery || (!valSpec && !isHabisCmd && !isReadyCmd)) {
          return reply(`📦 *CARA ATUR STOK PRODUK (BISA DARI BOT LAIN)*\n\n1️⃣ *Atur semua varian sekaligus:*\n• *${p}setstok netflix|20* (atau *${p}setstok netflix 20*)\n• *${p}tambahstok netflix|15* — tambah +15 ke stok sekarang\n• *${p}habis netflix* — tandai stok habis (0)\n• *${p}ready netflix 25* — tandai ready stok 25\n• *${p}setstok netflix|unlimited* — tanpa batas stok\n\n2️⃣ *Atur per varian (pakai nomor urut / nama varian):*\n• *${p}setstok netflix|1=10; 2=5*\n• *${p}setstok spotify|indplan=20; famplan=15*\n\n💡 _Setiap stok yang diatur manual otomatis dikunci agar tidak tertimpa saat sinkron dari bot pusat._`)
        }

        const existing = db.findItem(prodQuery, { allowNumber: true, allowFuzzy: true })
        if (!existing) return reply(`❌ Produk *"${prodQuery}"* tidak ditemukan.\nKetik *menu* untuk melihat daftar produk.`)
        const it = toTypesItem(existing)
        if (!it || !Array.isArray(it.types) || !it.types.length) {
          return reply(`⚠️ Produk *${existing.name}* menggunakan format teks bebas.`)
        }

        const types = it.types.map(t => ({ ...t }))
        const specClean = String(valSpec || '').trim()

        // Cek apakah format per-varian: "1=10; 2=5" atau "private=10"
        if (/[=:]/.test(specClean)) {
          const pairs = specClean.split(/;|\n|,/).map(s => s.trim()).filter(Boolean)
          let matchedAny = false
          for (const pair of pairs) {
            const mPair = pair.match(/^(.+?)\s*[=:]\s*(.+)$/)
            if (!mPair) continue
            const kVar = mPair[1].trim().toLowerCase()
            const vRaw = mPair[2].trim().toLowerCase()
            const idxNum = /^\d+$/.test(kVar) ? Number(kVar) - 1 : -1
            const targets = idxNum >= 0 && idxNum < types.length
              ? [types[idxNum]]
              : types.filter(t => String(t.name || '').toLowerCase().includes(kVar))
            for (const target of targets) {
              matchedAny = true
              if (['-', 'unlimited', 'inf', 'tanpabatas'].includes(vRaw)) {
                delete target.stock
              } else {
                const n = Math.max(0, Math.floor(Number(vRaw.replace(/[^\d-]/g, '')) || 0))
                target.stock = isAddMode ? Math.max(0, (Number(target.stock) || 0) + n) : n
              }
            }
          }
          if (!matchedAny) {
            const varList = types.map((t, i) => `${i + 1}. ${t.name || 'Reguler'} (stok: ${t.stock ?? '∞'})`).join('\n')
            return reply(`⚠️ Varian tidak cocok.\nDaftar varian *${it.name}*:\n${varList}\n\nContoh: *${p}setstok ${it.name.toLowerCase()}|1=15; 2=10*`)
          }
        } else {
          const low = specClean.toLowerCase()
          if (['-', 'unlimited', 'inf', 'tanpabatas'].includes(low)) {
            types.forEach(t => { delete t.stock })
          } else if (['habis', 'kosong', '0'].includes(low)) {
            types.forEach(t => { t.stock = 0 })
          } else {
            const n = Math.floor(Number(low.replace(/[^\d-]/g, '')) || 0)
            types.forEach(t => {
              t.stock = isAddMode
                ? Math.max(0, (Number(t.stock) || 0) + n)
                : Math.max(0, n)
            })
          }
        }

        const tracked = types.filter(t => t.stock !== undefined && t.stock !== null && Number.isFinite(Number(t.stock)))
        const newSupplierStock = tracked.length
          ? tracked.reduce((sum, t) => sum + Math.max(0, Number(t.stock)), 0)
          : null

        const saved = db.setItem(it.key, {
          types,
          supplierStock: newSupplierStock,
          stockLocked: true,
          variants: undefined
        })
        const summaryLines = saved.types.map((t, i) => `▸ ${i + 1}. ${t.name || saved.name} : *${t.stock !== undefined && t.stock !== null ? (t.stock === 0 ? 'Habis (0)' : t.stock) : '∞ Tanpa batas'}*`).join('\n')
        return reply(`✅ *STOK BERHASIL DIATUR — ${saved.name}*\n━━━━━━━━━━━━━━━━━━━━\n${summaryLines}\n📊 Total Stok : *${newSupplierStock !== null ? newSupplierStock : '∞ Tanpa batas'}*\n📌 Status Kunci : *Stok Dikunci Manual* _(aman tidak tertimpa sinkron bot pusat)_\n━━━━━━━━━━━━━━━━━━━━\n_Ketik *${p}kuncistok ${saved.name.toLowerCase()}* jika suatu saat ingin mengembalikan stok mengikuti bot pusat._`)
      }

      case 'impor': case 'import': case 'importlist': case 'imporstok': case 'gabungstok': {
        const qText = ctx?.quotedMessage ? getText(unwrap(ctx.quotedMessage)) : ''
        const rawPaste = (args.trim() && qText) ? `${args.trim()}\n${qText}` : (args.trim() || qText)
        const isAddStock = ['imporstok', 'gabungstok'].includes(cmd)
        if (!rawPaste) {
          return reply(`📋 *IMPOR CEPAT DAFTAR PRODUK & STOK (BISA DARI BOT LAIN)*\n\nSalin (copy) teks daftar produk atau detail harga dari bot Telegram mana saja, lalu:\n• *${p}impor <teks>* — perbarui produk, harga & stok\n• *${p}imporstok <teks>* — *tambahkan (+)* stok dari bot lain ke stok yang sudah ada!\n• Atau *reply* pesan teks tersebut dengan *${p}impor* / *${p}imporstok*\n\nHarga otomatis ditambah untung *+Rp ${Number(S().syncMarkup ?? 5000).toLocaleString('id-ID')}* dan nama bot sumber otomatis dibersihkan!`)
        }
        try {
          const res = tgsync.importFromPastedText(rawPaste, db, config, {
            stockMode: isAddStock ? 'add' : 'replace'
          })
          return reply(`✅ *${isAddStock ? 'GABUNG STOK & IMPOR' : 'IMPOR'} BERHASIL!*\n━━━━━━━━━━━━━━━━━━━━\n➕ Produk baru : *${res.added}*\n🔄 Produk diperbarui : *${res.updated}*${isAddStock ? '\n📦 Mode Stok : *Ditambahkan (+) ke stok sekarang & dikunci aman*' : ''}\n🔒 Dilewati (dikunci) : *${res.skippedLocked ?? res.skipped ?? 0}*\n💰 Untung otomatis : *+Rp ${res.markup.toLocaleString('id-ID')}/produk*\n━━━━━━━━━━━━━━━━━━━━\nSemua nama/atribut bot sumber telah dibersihkan otomatis.`)
        } catch (e) {
          return reply('⚠️ Gagal mengimpor teks: ' + (e?.message || e))
        }
      }

      case 'tglogin': case 'logintg': {
        const phone = args.trim()
        if (!phone) {
          return reply(`📲 *LOGIN AKUN TELEGRAM (UNTUK SINKRON OTOMATIS)*\n\nKetik:\n*${p}tglogin 08xxxxxxxxxx*\n_(Gunakan nomor HP akun Telegram Anda. Anda juga bisa login dengan mudah lewat *${p}web on*)_`)
        }
        await reply('⏳ Mengirim kode OTP ke aplikasi Telegram Anda...')
        try {
          const r = await tgsync.startLogin(phone, config)
          return reply(`✅ Kode OTP telah dikirim ke aplikasi *Telegram* di nomor *${r.phone}*.\n\nSilakan balas dengan mengetik:\n*${p}tgkode <kode OTP>*\nContoh: *${p}tgkode 12345*\n_(Jika akun memakai password 2 langkah: *${p}tgkode 12345|passwordAnda*)_`)
        } catch (e) {
          return reply('❌ Gagal mengirim OTP Telegram: ' + (e?.message || e))
        }
      }

      case 'tgkode': case 'tgotp': case 'tgpass': {
        const [codePart, ...passParts] = args.trim().split('|')
        const code = (codePart || '').trim()
        const pass = passParts.join('|').trim()
        if (!code && !pass) return reply(`Format: *${p}tgkode 12345*\n_(Jika diminta password 2FA: *${p}tgkode 12345|passwordAnda*)_`)
        try {
          const r = await tgsync.verifyLoginCode(code, pass)
          if (r.needPassword) {
            return reply(`🔐 ${r.message}\n\nKetik: *${p}tgkode ${code}|passwordTelegramAnda*`)
          }
          tgsync.setupAutoSync({ db, config })
          return reply(`🎉 * Berhasil terhubung ke Telegram (${r.user.name})!*\n\nSekarang Anda bisa ketik *${p}sync* kapan saja untuk menyinkronkan seluruh daftar produk & harga otomatis (+Rp ${Number(S().syncMarkup ?? 5000).toLocaleString('id-ID')}).`)
        } catch (e) {
          return reply('❌ ' + (e?.message || e))
        }
      }

      case 'tglogout': case 'logouttg': {
        await tgsync.logoutTelegram()
        tgsync.setupAutoSync({ db, config })
        return reply('🔴 Sesi akun Telegram telah diputuskan.')
      }

      case 'setai': case 'setgemini': case 'setapikey': {
        const key = args.trim()
        if (!key) {
          const cur = S().geminiApiKey || config.geminiApiKey || ''
          return reply(`🤖 *PENGATURAN AI (GOOGLE GEMINI)*\n━━━━━━━━━━━━━━━━━━━━\nAPI key: *${cur ? '🔑 Sudah diisi (' + cur.slice(0, 6) + '…' + cur.slice(-4) + ')' : '⚪ Belum diatur'}*\n\nKetik *${p}cekai* untuk tes apakah kunci benar-benar berfungsi.\nUntuk mengganti: *${p}setai <API_KEY_GEMINI>*\n\n_(Dapatkan kunci gratis di: https://aistudio.google.com/app/apikey)_`)
        }
        if (key.toLowerCase() === 'off' || key.toLowerCase() === 'hapus') {
          S().geminiApiKey = ''
          db.save()
          return reply('⚪ AI Google Gemini dinonaktifkan.')
        }
        S().geminiApiKey = key
        db.save()
        await reply('🔑 API key disimpan. Sedang mengetes koneksi ke Google Gemini...')
        const t = await ai.testApiKey(key, config.geminiModel)
        return reply(t.ok
          ? `✅ *AI GOOGLE GEMINI BERFUNGSI!*\nModel: *${t.model}* (${t.ms} ms)\n\nAI dipakai otomatis sebagai *cadangan* saat .sync menemukan kartu produk yang formatnya tidak terbaca parser biasa.`
          : `❌ *API key tersimpan, tapi TIDAK BERFUNGSI.*\nAlasan: _${t.error}_\n\nCek lagi kuncinya di https://aistudio.google.com/app/apikey lalu kirim ulang *${p}setai <API_KEY>*.`)
      }

      case 'cekai': case 'tesai': case 'testai': {
        const key = S().geminiApiKey || config.geminiApiKey || ''
        if (!key) return reply(`⚪ API key Gemini belum diisi.\nKetik *${p}setai <API_KEY_GEMINI>*`)
        await reply('⏳ Mengetes API key Gemini...')
        const t = await ai.testApiKey(key, config.geminiModel)
        return reply(t.ok
          ? `✅ *AI GEMINI BERFUNGSI*\nKunci: ${key.slice(0, 6)}…${key.slice(-4)}\nModel: *${t.model}*\nWaktu respon: ${t.ms} ms\n\n_Catatan: AI hanya dipanggil saat .sync menemukan kartu yang gagal dibaca parser biasa. Jika muncul log "🤖 AI membantu membaca" di Termux, berarti AI sedang bekerja._`
          : `❌ *AI GEMINI TIDAK BERFUNGSI*\nKunci: ${key.slice(0, 6)}…${key.slice(-4)}\nAlasan: _${t.error}_`)
      }

      case 'fixsesi': case 'resetsesi': case 'fixenkripsi': case 'perbaikisesi': {
        if (typeof resetSignal !== 'function') return reply('Fitur ini butuh index.js versi terbaru.')
        const targets = []
        const argNum = normPhone(args)
        if (argNum) targets.push(argNum)
        if (ctx?.participant) targets.push(ctx.participant)
        if (!targets.length) {
          targets.push(...ids, ...ownerNums, ...(db.data.admins || []))
        }
        const r = await resetSignal({ phones: targets, groups: true, groupJid: isGroup ? jid : null })
        return reply(`🔐 *Enkripsi diperbarui!*\nSesi direset: ${r.sessions} perangkat\nMemori grup direset: ${r.groups || (isGroup ? 1 : 0)}\n\nJika pesan ini sudah terbaca normal (bukan "Menunggu pesan ini"), berarti masalah sudah beres ✅\n_Kalau masih "menunggu", kirim 1 pesan apa saja dari HP tersebut ke bot lalu ketik *${p}fixsesi* sekali lagi._`)
      }

      case 'sync': case 'sinkron': case 'tgsync': {
        const st = tgsync.statusInfo(db, config)
        if (st.syncing) return reply(`⏳ Sinkronisasi sedang berjalan (${st.progressPct || 0}%):\n_${st.progress || 'mohon tunggu...'}_\n\n💡 Ketik *${p}stopsync* jika ingin menghentikan.`)
        if (!st.loggedIn) {
          return reply(`⚠️ *Akun Telegram belum terhubung!*\n\nUntuk mengambil data otomatis dari *@${st.botUsername}*, hubungkan akun Telegram sekali saja:\n1️⃣ Ketik *${p}tglogin 08xxxx* (nomor Telegram Anda)\n2️⃣ Ketik *${p}tgkode <OTP>*\n\n💡 _Atau buka *${p}web on* untuk login & sinkron lewat tampilan Web Dashboard yang mudah!_`)
        }
        const sub = args.trim().toLowerCase()
        const isStockOnly = ['stok', 'stock', 'cepat', 'fast'].includes(sub)
        if (isStockOnly) {
          await reply(`⚡ *Memulai Sinkron Stok Cepat...*\nMengambil jumlah stok semua produk dari katalog *@${st.botUsername}* (±15 detik).`)
        } else {
          await reply(`🔄 *Memulai Sinkronisasi Lengkap...*\nMengambil daftar produk, varian, stok & harga dari *@${st.botUsername}*.\n💰 Untung otomatis: *+Rp ${st.syncMarkup.toLocaleString('id-ID')}/produk*\n⏳ Proses ini memakan waktu ±3-5 menit (jeda aman anti-spam), hasil akan dikirim setelah selesai.\n💡 Ketik *${p}stopsync* kapan saja untuk membatalkan.`)
        }
        try {
          const res = await tgsync.syncFromTelegram({ db, config, mode: isStockOnly ? 'stock' : 'full' })
          const failTxt = res.failed?.length ? `\n⚠️ Gagal dibaca (harga lama dipertahankan): ${res.failed.join(', ')}` : ''
          return reply(`✅ *${isStockOnly ? 'SINKRON STOK CEPAT' : 'SINKRONISASI'} SELESAI!*${res.cancelled ? ' _(dihentikan sebagian)_' : ''}\n━━━━━━━━━━━━━━━━━━━━\n📦 Katalog terbaca : *${res.totalCatalog} produk*\n🎯 Detail akurat : *${res.okCount ?? '-'} / ${res.totalCatalog} produk*\n➕ Produk baru : *${res.added} produk*\n🔄 Produk diperbarui : *${res.updated} produk*\n🔒 Dilewati (dikunci) : *${res.skippedLocked ?? res.skipped ?? 0} produk*\n💰 Untung Reseller : *+Rp ${res.markup.toLocaleString('id-ID')} / produk*${failTxt}\n━━━━━━━━━━━━━━━━━━━━\n✨ Ketik *menu* atau *stok* untuk melihat hasilnya.`)
        } catch (e) {
          return reply('❌ Gagal sinkronisasi: ' + (e?.message || e))
        }
      }

      case 'stopsync': case 'batalsync': case 'hentikansync': {
        const r = tgsync.stopSync()
        if (!r.stopped) return reply('ℹ️ Saat ini tidak ada proses sinkronisasi yang sedang berjalan.')
        return reply('⏹️ Permintaan hentikan sinkronisasi dikirim. Data produk yang sudah terbaca tetap disimpan dengan aman.')
      }

      case 'autosync': case 'autosinkron': case 'sinkronotomatis': {
        const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const sub = parts[0] || ''
        if (!sub || !['on', 'off', 'aktif', 'mati', '1', '0'].includes(sub)) {
          const st = tgsync.statusInfo(db, config)
          return reply(`🔄 *PENGATURAN SINKRON OTOMATIS*\n\nStatus saat ini : *${st.autoSyncEnabled ? `🟢 AKTIF (setiap ${st.autoSyncHours} jam)` : '⚪ MANUAL / MATI'}*\n\nCara ubah:\n• *${p}autosync on* — Aktifkan sinkron otomatis\n• *${p}autosync on 6* — Aktifkan setiap 6 jam\n• *${p}autosync off* — Matikan (hanya sinkron manual saat klik tombol / ketik ${p}sync)`)
        }
        const enable = ['on', 'aktif', '1'].includes(sub)
        S().tgAutoSyncEnabled = enable
        const h = Number(parts[1])
        if (Number.isFinite(h) && h >= 1 && h <= 168) {
          S().tgAutoSyncHours = Math.floor(h)
        }
        db.save()
        tgsync.setupAutoSync({ db, config })
        const st = tgsync.statusInfo(db, config)
        return reply(enable
          ? `✅ *Sinkronisasi Otomatis DIAKTIFKAN* (setiap *${st.autoSyncHours} jam*).\nBot akan otomatis menyamakan harga & stok dari *@${st.botUsername}*.`
          : `⚪ *Sinkronisasi Otomatis DIMATIKAN (Mode Manual)*.\nBot tidak akan sinkron sendiri. Ketik *${p}sync* atau klik tombol Sinkron di Web Dashboard kapan pun ingin update.`)
      }

      case 'setselisih': case 'setmarkup': case 'hargaluargrup': case 'selisih': {
        const rawVal = args.trim().replace(/[^0-9]/g, '')
        if (!args.trim() || !rawVal) {
          return reply(`Format: *${p}setselisih 5000*\n_(Isi *${p}setselisih 0* jika ingin harga di grup & luar grup sama)_\n\nSelisih luar grup sekarang: *+Rp ${privateMarkup().toLocaleString('id-ID')}*`)
        }
        const n = Math.floor(Number(rawVal))
        if (n > 10000000) return reply('Nominal terlalu besar.')
        S().privateMarkup = n
        S().privateMarkupCustom = true
        db.save()
        return reply(n > 0
          ? `✅ Selisih harga untuk pembeli di *luar grup (chat pribadi)* diatur ke *+Rp ${n.toLocaleString('id-ID')}*.\n_(Pembeli di luar grup otomatis melihat harga yang sudah ditambah Rp ${n.toLocaleString('id-ID')} tanpa tahu ada selisih harga)_`
          : '✅ Selisih harga luar grup dimatikan (*Rp 0*). Harga di grup & luar grup sekarang sama.')
      }

      case 'limitstiker': case 'limitsticker': case 'setlimitstiker': {
        const n = Math.floor(Number(args.trim()))
        if (!args.trim() || !(n >= 0 && n <= 100)) return reply(`Format: *${p}limitstiker 5*  (sekarang: ${stickerLimit()}x/orang/hari)`)
        S().stickerLimit = n; db.save()
        return reply(`✅ Jatah stiker diubah jadi *${n}x per orang per hari*.`)
      }

      case 'status': case 'ping': case 'info': {
        const activeOrders = Object.values(db.data.orders || {}).filter(o => o.status !== 'done' && o.status !== 'cancelled').length
        const tgSt = tgsync.statusInfo(db, config)
        return reply(`*🤖 STATUS BOT*\n\nToko : ${S().storeName}\nProduk : ${db.listNames().length} item\nUntung Reseller : +Rp ${tgSt.syncMarkup.toLocaleString('id-ID')}/produk\nSinkron Telegram : ${tgSt.loggedIn ? `🟢 Terhubung (@${tgSt.botUsername})` : '🔴 Belum login'}\nMode Sinkron : ${tgSt.autoSyncEnabled ? `🟢 Otomatis (tiap ${tgSt.autoSyncHours} jam)` : '⚪ Manual (Mati)'}\nHarga luar grup : ${privateMarkup() > 0 ? `+Rp ${privateMarkup().toLocaleString('id-ID')}` : 'sama dengan grup'}\nPesanan belum selesai : ${activeOrders} pesanan\nAktif : ${fmtUptime(Date.now() - startedAt)}\nAuto reply : ${S().autoReply ? 'on' : 'off'}\nStiker : ${S().stickerEnabled !== false ? `on (${stickerLimit()}x/hari)` : 'off'}\nWeb dashboard : ${web.isRunning() ? 'menyala' : 'mati'}\nRAM : ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`)
      }

      default:
        return false
    }
  }

  // ------------- pesan masuk -------------
  async function onMessage (m) {
    if (!m?.message || !m.key) return
    const rawRemoteJid = m.key.remoteJid
    if (!rawRemoteJid || rawRemoteJid === 'status@broadcast' || rawRemoteJid.endsWith('@newsletter') || rawRemoteJid.endsWith('@broadcast')) return
    if (m.key.fromMe && sentIds.has(m.key.id)) return

    const c = unwrap(m.message)
    const ctx = getContext(c)
    const text = getText(c).trim()
    if (m.key.fromMe && (/^(🔔 \*PESANAN BARU MASUK|🧾 \*RESI PESANAN|🧾 \*UPDATE PESANAN|📦 \*DETAIL PESANAN KAKAK|⏰ \*PENGINGAT PESANAN|✅ Pesanan \*#ORD-|📦 Item produk untuk \*#ORD-)/.test(text) || (!text && c.imageMessage))) return

    const isGroup = rawRemoteJid.endsWith('@g.us')
    const fromMe = !!m.key.fromMe
    const ids = senderIds(m, isGroup)
    rememberUserIdentity(rawRemoteJid, ids, isGroup)
    const jid = rawRemoteJid
    const sender = isGroup ? (m.key.participant || ids[0] || jid) : jid
    const admin = isAdmin(ids, fromMe)

    const usedPrefix = prefixes.find(px => text.startsWith(px))
    const raw = usedPrefix ? text.slice(usedPrefix.length).trim() : text
    const firstLineEnd = raw.search(/\s/)
    const cmd = (firstLineEnd === -1 ? raw : raw.slice(0, firstLineEnd)).toLowerCase()
    const args = firstLineEnd === -1 ? '' : raw.slice(firstLineEnd + 1)
    const ctxObj = { jid, m, c, ctx, isGroup, ids, fromMe, sender }

    // sedang tanya-jawab tambah produk?
    if (admin) {
      const wkey = wizKey(jid, ids, fromMe)
      const w = wizards.get(wkey)
      if (w && Date.now() > w.expires) {
        wizards.delete(wkey)
      } else if (w) {
        if (usedPrefix && ['batal', 'cancel'].includes(cmd)) {
          wizards.delete(wkey)
          return send(jid, { text: `❌ ${w.mode === 'add' ? 'Tambah' : 'Ubah'} produk *${w.name}* dibatalkan.` }, { quoted: m })
        }
        if (!usedPrefix) {
          if (!text && !c.imageMessage) return
          return wizardStep(w, wkey, ctxObj, text)
        }
      }
    }

    if (!text && !c.imageMessage) return

    if (config.logMessages !== false) {
      const where = isGroup ? 'GRUP ' + jid.split('@')[0] : 'PRIBADI'
      console.log(`[PESAN] ${where} | dari ${fromMe ? 'nomor bot sendiri' : (ids.map(digits).join('/') || '?')}${admin ? ' (admin)' : ''} | "${(text || '[gambar]').slice(0, 60).replace(/\n/g, ' ')}"`)
    }

    // perintah semua orang (tanpa / dengan prefix)
    if (usedPrefix && cmd === 'myid') {
      return send(jid, { text: `*ID kamu:*\n${ids.join('\n') || '-'}\n\nAdmin: ${admin ? 'YA' : 'tidak'}` }, { quoted: m })
    }

    // perintah admin (dengan prefix)
    if (usedPrefix && admin) {
      const handled = await adminCommand(cmd, args, ctxObj)
      if (handled !== false) return
    }

    // perintah admin untuk proses (p) / selesai (d) / kirim tanpa prefix
    if (!usedPrefix && admin && ['p', 'proses', 'd', 'done', 'selesai', 'kirim'].includes(cmd)) {
      const hasOrderIdArg = /^#?ord[-_]?\d+\b/i.test(args.trim())
      if (ctx?.stanzaId || hasOrderIdArg || !isGroup) {
        return handleOrderAdminAction(cmd, args, ctxObj)
      }
    }

    // jika admin me-reply pesan pesanan di chat pribadi dengan mengirim item produk/gambar langsung
    if (!usedPrefix && admin && !isGroup && ctx?.stanzaId) {
      const orders = Object.values(db.data.orders || {})
      let matchedOrder = orders.find(o => (o.adminMsgIds || []).includes(ctx.stanzaId))
      if (!matchedOrder && ctx.quotedMessage) {
        const qText = getText(unwrap(ctx.quotedMessage))
        const mOrd = qText.match(/#?(ORD-\d{3,8})\b/i)
        if (mOrd) matchedOrder = findOrderByIdToken(mOrd[1])
      }
      if (matchedOrder && matchedOrder.status !== 'cancelled') {
        let deliveryBuf = null
        if (c.imageMessage) {
          try { deliveryBuf = await downloadImage(m, c, null) } catch {}
        }
        await sendProductItemToBuyer(matchedOrder, text, deliveryBuf)
        const sent = await send(jid, {
          text: `📦 Item produk untuk *#${matchedOrder.id}* berhasil diteruskan ke pembeli (*${matchedOrder.buyerName}*).\n\nKetik *d* (atau reply *d*) untuk mengirim pemberitahuan *Pesanan Selesai* ke pembeli.`
        }, { quoted: m })
        if (sent?.key?.id) { rememberAdminMsg(matchedOrder, sent.key.id); db.save() }
        return
      }
    }

    const chatCfg = db.data.chats[jid] || {}
    if (chatCfg.botOff) { console.log('   -> diabaikan: bot di-off di chat ini (ketik .bot on)'); return }

    // abaikan pesan lama (numpuk waktu bot offline) -> cegah balasan beruntun
    const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) * 1000
    const maxAge = (config.ignoreOlderThanSeconds ?? 120) * 1000
    if (ts && Date.now() - ts > maxAge) { console.log('   -> diabaikan: pesan lama (dikirim saat bot offline)'); return }

    // fitur stiker: caption/ketik "sticker" (atau .s / .stiker) pada gambar/video
    const isStickerCmd = (usedPrefix && ['s', 'sticker', 'stiker', 'stc', 'stik', 'sk'].includes(cmd)) ||
      (!usedPrefix && ['sticker', 'stiker', 'stik'].includes(cmd) && !args.trim())

    // jika pembeli sebelumnya sudah ketik .beli <produk> lalu sekarang mengirim gambar bukti transfer (meski tanpa caption)
    if (c.imageMessage && !isStickerCmd) {
      const pKey = pendingBeliKey(jid, sender)
      const pending = pendingBeli.get(pKey)
      if (pending && Date.now() <= pending.expires) {
        pendingBeli.delete(pKey)
        const queryToUse = (!usedPrefix && text) ? text : pending.itemQuery
        await handleBeliCommand(queryToUse, ctxObj)
        lastReply.set(sender, Date.now())
        return
      }
      // di chat pribadi: jika pembeli kirim gambar + caption nama produk langsung tanpa ketik .beli
      if (!isGroup && !usedPrefix && text && cmd !== 'beli') {
        const directItem = db.findItem(raw, { allowNumber: false, allowFuzzy: false })
        if (directItem && directItem.key !== 'bayar' && directItem.key !== 'cara order') {
          await handleBeliCommand(raw, ctxObj)
          lastReply.set(sender, Date.now())
          return
        }
      }
    }

    if (!text) return

    // perintah pembeli: .beli <barang & pesanan> (berlaku di grup maupun di luar grup)
    const isBeliCmd = (usedPrefix && ['beli', 'order'].includes(cmd)) ||
      (!usedPrefix && ['beli', 'order'].includes(cmd) && (c.imageMessage || ctx?.quotedMessage?.imageMessage || (!isGroup && args.trim())))
    if (isBeliCmd) {
      await handleBeliCommand(args, ctxObj)
      lastReply.set(sender, Date.now())
      return
    }

    if (isStickerCmd) {
      const cdMs = (config.cooldownSeconds ?? 2) * 1000
      if (!admin && Date.now() - (lastReply.get(sender) || 0) < cdMs) { console.log('   -> diabaikan: anti-spam (pesan terlalu cepat)'); return }
      lastReply.set(sender, Date.now())
      await handleSticker(ctxObj, admin)
      lastReply.set(sender, Date.now())
      return
    }

    // anti spam
    const now = Date.now()
    const cdMs = (config.cooldownSeconds ?? 2) * 1000
    if (!admin && now - (lastReply.get(sender) || 0) < cdMs) { console.log('   -> diabaikan: anti-spam (pesan terlalu cepat)'); return }

    const key = normKey(raw)
    let replied = false

    // cek pesanan pembeli: ketik "cek" / "cek ORD-xxxx" / "#ORD-xxxx"
    const isCekOrderCmd = ['cek', 'cekorder', 'cekpesanan', 'cekresi', 'statusorder'].includes(cmd) || /^#?ord-\d{3,8}$/i.test(raw.trim())
    if (isCekOrderCmd && (usedPrefix || !isGroup || /^#?ord-\d{3,8}$/i.test(args.trim() || raw.trim()))) {
      const token = /^#?ord-\d{3,8}$/i.test(raw.trim()) ? raw.trim() : args.trim()
      let ord = token ? findOrderByIdToken(token) : null
      if (!ord && !token) {
        const senderNum = digits(sender)
        const allOrders = Object.values(db.data.orders || {})
        const myOrders = allOrders.filter(o => o.buyerJid === sender || (senderNum && o.buyerNumber === senderNum))
        ord = myOrders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null
      }
      if (!ord) {
        await send(jid, { text: `🔍 *Pesanan tidak ditemukan.*\n\nKetik *cek ORD-xxxx* (sesuai ID di resi pesanan kakak) untuk mengecek status pesanan.` }, { quoted: m })
      } else {
        const statusMap = {
          pending: '⏳ *Menunggu Verifikasi Admin*',
          processing: '⚙️ *Sedang Diproses Admin*',
          done: '✅ *Pesanan Selesai*',
          cancelled: '❌ *Dibatalkan*'
        }
        const stText = statusMap[ord.status] || ord.status
        await send(jid, {
          text: `🧾 *STATUS PESANAN #${ord.id}*\n━━━━━━━━━━━━━━━━━━━━\n📦 *Pesanan :* ${ord.itemQuery}\n👤 *Pembeli :* ${ord.buyerName}\n🕒 *Waktu Order :* ${fmtTime(ord.createdAt)}\n📊 *Status :* ${stText}${ord.deliveredItem ? `\n\n🎁 *Item Terkirim :*\n${ord.deliveredItem}` : ''}\n━━━━━━━━━━━━━━━━━━━━`
        }, { quoted: m })
      }
      lastReply.set(sender, now)
      return
    }

    // pencarian produk: ketik "cari <kata>"
    if (['cari', 'search', 'find'].includes(cmd) && args.trim()) {
      const results = db.searchItems(args.trim())
      if (!results.length) {
        await send(jid, { text: `🔍 Produk dengan kata kunci *"${args.trim()}"* belum ditemukan.\nKetik *menu* untuk melihat semua daftar produk.` }, { quoted: m })
      } else {
        const extra = isGroup ? 0 : privateMarkup()
        const lines = results.map(it => {
          const out = isItemOutOfStock(it)
          const minP = minItemPrice(it, extra)
          const pStr = minP ? ` — _mulai Rp ${minP.toLocaleString('id-ID')}_` : ''
          return `${out ? '❌' : '✅'} *${it.title}*${pStr}${out ? ' _(habis)_' : ''}`
        })
        await send(jid, {
          text: `🔍 *Hasil Pencarian "${args.trim()}" (${results.length} produk):*\n\n${lines.join('\n')}\n\n💡 _Ketik nama produk di atas untuk melihat detail & varian lengkap._`
        }, { quoted: m })
      }
      lastReply.set(sender, now)
      return
    }

    // grup: balasan sama baru saja dikirim -> jangan kirim ulang
    const isMenuKey = ['menu', 'list', 'store', 'liststore', 'list store', 'produk', 'start', 'katalog', 'harga', 'pricelist', 'price list'].includes(key)
    const isStokKey = ['stok', 'stock', 'cekstok', 'cek stok', 'ready', 'stokproduk', 'stok produk'].includes(key)
    const matchedItem = (!isMenuKey && !isStokKey)
      ? db.findItem(raw, { allowNumber: false, allowFuzzy: !isGroup })
      : null
    const replyKey = isMenuKey ? 'menu' : (isStokKey ? 'stok' : (matchedItem?.key || key))
    if (isGroup && !admin) {
      const dupKey = jid + '|' + replyKey
      const sameMs = (config.sameReplyInGroupSeconds ?? 30) * 1000
      if (now - (recentGroupReply.get(dupKey) || 0) < sameMs) {
        console.log(`   -> diabaikan: "${replyKey}" baru saja dikirim di grup ini`)
        return
      }
      recentGroupReply.set(dupKey, now)
      if (recentGroupReply.size > 500) recentGroupReply.delete(recentGroupReply.keys().next().value)
    }

    if (isMenuKey) {
      recentGroupReply.set(jid + '|menu', now)
      await send(jid, { text: buildMenu(sender), mentions: [sender] }, { quoted: m })
      replied = true
    } else if (isStokKey) {
      await send(jid, { text: buildStockSummary(isGroup) }, { quoted: m })
      replied = true
    } else if (matchedItem) {
      await sendItem(jid, matchedItem, m)
      replied = true
    } else if (['owner', 'admin', 'cs', 'kontak'].includes(key)) {
      const num = ownerNums[0]
      await send(jid, { text: `📞 Hubungi admin *${S().storeName}*:\nwa.me/${num}\n\nAdmin akan membalas secepatnya ya kak 🙏` }, { quoted: m })
      replied = true
    } else if (usedPrefix && !admin && ['kick', 'keluarkan', 'tendang', 'dor', 'add', 'tambahmember', 'undang', 'invite', 'open', 'close', 'buka', 'tutup', 'h', 'hidetag', 'tagall'].includes(cmd)) {
      await send(jid, { text: '⛔ Perintah ini khusus Admin.' }, { quoted: m })
      replied = true
    } else if (usedPrefix && !admin && isGroup === false && ['addlist', 'updatelist', 'dellist', 'setbayar', 'p', 'd', 'web', 'sync', 'autosync', 'setstok', 'tambahstok', 'habis'].includes(cmd)) {
      await send(jid, { text: '⛔ Perintah ini khusus Admin.' }, { quoted: m })
      replied = true
    } else if (!isGroup && raw.length >= 2 && raw.length <= 35 && !/^\d+$/.test(raw)) {
      const suggestions = db.searchItems(raw)
      if (suggestions.length === 1) {
        await sendItem(jid, suggestions[0], m)
        replied = true
      } else if (suggestions.length > 1) {
        const extra = privateMarkup()
        const listTxt = suggestions.map(it => {
          const minP = minItemPrice(it, extra)
          return `• *${it.title}*${minP ? ` _(mulai Rp ${minP.toLocaleString('id-ID')})_` : ''}`
        }).join('\n')
        await send(jid, {
          text: `🔍 Produk *"${raw}"* memiliki beberapa pilihan:\n\n${listTxt}\n\n💡 _Ketik salah satu nama produk di atas untuk melihat detail harganya._`
        }, { quoted: m })
        replied = true
      }
    }

    // chat pribadi: pesan tak dikenal -> petunjuk (dibatasi)
    if (!replied && !isGroup && !admin && S().autoReply) {
      const every = (config.autoReplyEveryHours ?? 6) * 3600 * 1000
      if (now - (lastAuto.get(sender) || 0) > every) {
        lastAuto.set(sender, now)
        await send(jid, { text: fill(S().autoReplyText) }, { quoted: m })
        replied = true
      }
    }

    if (replied) lastReply.set(sender, now)
    else if (config.logMessages !== false) console.log('   -> tidak dibalas (bukan "menu"/nama produk yang terdaftar)')
  }

  async function onParticipants (update) {
    const { id, action } = update
    if (action !== 'add') return
    const ch = db.data.chats[id]
    if (!ch?.welcome || ch.botOff) return
    let groupName = ''
    try { groupName = (await getGroup(id)).subject } catch {}
    for (const p of update.participants || []) {
      const pj = typeof p === 'string' ? p : (p.id || p.phoneNumber || p.jid)
      if (!pj) continue
      const text = fill(ch.welcomeText || S().defaultWelcome || DEFAULT_WELCOME, { user: pj, grup: groupName })
      await send(id, { text, mentions: [pj] })
    }
  }

  // aksi pesanan dari web dashboard (proses, selesai + kirim item, batal, hapus)
  async function webOrderAction ({ id, action, text = '', imageBuf = null }) {
    const order = (db.data.orders || {})[id] || findOrderByIdToken(id)
    if (!order) throw new Error('Pesanan tidak ditemukan')
    if (action === 'delete') {
      if (order.proofImage) removeImage(order.proofImage)
      delete db.data.orders[order.id]
      db.save()
      return { deleted: true }
    }
    if (action === 'process') {
      order.status = 'processing'
      order.processedAt = Date.now()
      db.save()
      const resiProses = buildResiText(order)
      const mentions = order.isGroup ? [order.buyerMentionJid] : []
      const quoted = buildBuyerQuoted(order)
      await send(order.sourceJid, { text: resiProses, ...(mentions.length ? { mentions } : {}) }, quoted ? { quoted } : {})
      return order
    }
    if (action === 'done') {
      if (text.trim() || imageBuf) {
        await sendProductItemToBuyer(order, text.trim(), imageBuf)
      }
      order.status = 'done'
      order.doneAt = Date.now()
      db.save()
      await sendDoneNotificationToBuyer(order, !!imageBuf)
      return order
    }
    if (action === 'cancel') {
      order.status = 'cancelled'
      order.cancelReason = text.trim()
      order.doneAt = Date.now()
      db.save()
      const resiCancel = buildResiText(order)
      const mentions = order.isGroup ? [order.buyerMentionJid] : []
      const quoted = buildBuyerQuoted(order)
      await send(order.sourceJid, { text: resiCancel, ...(mentions.length ? { mentions } : {}) }, quoted ? { quoted } : {})
      return order
    }
    throw new Error('Aksi tidak dikenal')
  }

  // sambungkan web dashboard dengan bot (dipanggil ulang setiap reconnect)
  web.attach({
    fill: (t) => fill(t),
    buildMenu,
    orderAction: webOrderAction,
    status: () => ({
      connected: !!liveSock()?.user,
      number: digits(liveSock()?.user?.id || ''),
      uptime: fmtUptime(Date.now() - startedAt)
    })
  })

  return { onMessage, onParticipants, buildMenu }
}

module.exports = { createHandler, normPhone, timeParts }
