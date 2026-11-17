/*
 * Bot WhatsApp List Store — MASS.ID STORE
 * Jalan di Termux, VPS (Linux) dan RDP (Windows).
 */
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const pino = require('pino')
const config = require('./config')
const { DB } = require('./lib/db')
const { createHandler, normPhone } = require('./lib/handler')

// Baileys versi baru berformat ESM -> dimuat dengan import() (cocok juga untuk versi lama)
let baileys, makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers

function patchBaileysFiles () {
  const bDir = path.join(__dirname, 'node_modules', '@whiskeysockets', 'baileys', 'lib')
  // 1. messages-send.js: perbaiki encoding @lid, retry participant LID, dan simpan msgStore sebelum relayMessage
  try {
    const sendFile = path.join(bDir, 'Socket', 'messages-send.js')
    if (fs.existsSync(sendFile)) {
      let src = fs.readFileSync(sendFile, 'utf8')
      let changed = false
      const oldPatch = "const jid = jidEncode(user, isMe ? 's.whatsapp.net' : (isLid ? 'lid' : 's.whatsapp.net'), device);"
      const origLine = "const jid = jidEncode(isMe && isLid ? authState.creds?.me?.lid.split(':')[0] || user : user, isLid ? 'lid' : 's.whatsapp.net', device);"
      const safeLine = "const jid = jidEncode(isMe && isLid ? authState.creds?.me?.lid?.split(':')[0] || user : user, isLid ? 'lid' : 's.whatsapp.net', device);"
      if (src.includes(oldPatch)) { src = src.replace(oldPatch, safeLine); changed = true }
      if (src.includes(origLine)) { src = src.replace(origLine, safeLine); changed = true }

      const origMeCheck = 'else if (areJidsSameUser(participant.jid, meId)) {'
      const fixedMeCheck = 'else if (areJidsSameUser(participant.jid, meId) || areJidsSameUser(participant.jid, authState.creds.me?.lid)) {'
      if (src.includes(origMeCheck)) { src = src.replace(origMeCheck, fixedMeCheck); changed = true }

      const relayAnchor = 'await relayMessage(jid, fullMsg.message, {\n                    messageId: fullMsg.key.id,'
      const relayWithStore = 'if (config.msgStore && fullMsg?.key?.id && fullMsg?.message) {\n                    config.msgStore.set(fullMsg.key.id, fullMsg.message);\n                }\n                ' + relayAnchor
      if (!src.includes('config.msgStore.set(fullMsg.key.id') && src.includes(relayAnchor)) {
        src = src.replace(relayAnchor, relayWithStore)
        changed = true
      }
      if (changed) fs.writeFileSync(sendFile, src)
    }
  } catch {}

  // 2. messages-recv.js: saat retry, hanya kirim ke participant yang meminta (jangan reset ratchet perangkat lain)
  try {
    const recvFile = path.join(bDir, 'Socket', 'messages-recv.js')
    if (fs.existsSync(recvFile)) {
      const src = fs.readFileSync(recvFile, 'utf8')
      const origSendToAll = 'const sendToAll = !jidDecode(participant)?.device;'
      if (src.includes(origSendToAll)) {
        fs.writeFileSync(recvFile, src.replace(origSendToAll, 'const sendToAll = false;'))
      }
    }
  } catch {}

  // 3. Signal/libsignal.js: tambahkan migrateSession untuk sinkronisasi sesi PN <-> LID
  try {
    const sigFile = path.join(bDir, 'Signal', 'libsignal.js')
    if (fs.existsSync(sigFile)) {
      const src = fs.readFileSync(sigFile, 'utf8')
      const anchor = '        async injectE2ESession({ jid, session }) {\n            const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid));\n            await cipher.initOutgoing(session);\n        },'
      const withMigrate = anchor + '\n        async migrateSession(fromJid, toJid) {\n            const fromId = jidToSignalProtocolAddress(fromJid).toString();\n            const toId = jidToSignalProtocolAddress(toJid).toString();\n            if (fromId === toId) return;\n            const { [fromId]: sess } = await auth.keys.get(\'session\', [fromId]);\n            if (sess) {\n                await auth.keys.set({ session: { [toId]: sess } });\n            }\n        },'
      if (!src.includes('migrateSession(fromJid, toJid)') && src.includes(anchor)) {
        fs.writeFileSync(sigFile, src.replace(anchor, withMigrate))
      }
    }
  } catch {}

  // 4. Utils/decode-wa-message.js: fallback dekripsi ke senderPn / senderLid jika sesi berada di JID alternatif
  try {
    const decFile = path.join(bDir, 'Utils', 'decode-wa-message.js')
    if (fs.existsSync(decFile)) {
      const src = fs.readFileSync(decFile, 'utf8')
      const origBlock = `                            case 'pkmsg':
                            case 'msg':
                                const user = isJidUser(sender) ? sender : author;
                                msgBuffer = await repository.decryptMessage({
                                    jid: user,
                                    type: e2eType,
                                    ciphertext: content
                                });
                                break;`
      const newBlock = `                            case 'pkmsg':
                            case 'msg':
                                const user = isJidUser(sender) ? sender : author;
                                try {
                                    msgBuffer = await repository.decryptMessage({
                                        jid: user,
                                        type: e2eType,
                                        ciphertext: content
                                    });
                                }
                                catch (primaryErr) {
                                    const altRaw = fullMessage.key.senderPn || fullMessage.key.participantPn || fullMessage.key.senderLid || fullMessage.key.participantLid;
                                    const devPart = author && author.includes(':') ? ':' + author.split(':')[1].split('@')[0] : '';
                                    const altJid = altRaw ? altRaw.split('@')[0].split(':')[0] + devPart + '@' + altRaw.split('@')[1] : '';
                                    if (altJid && altJid !== user) {
                                        msgBuffer = await repository.decryptMessage({
                                            jid: altJid,
                                            type: e2eType,
                                            ciphertext: content
                                        });
                                        await repository.migrateSession?.(altJid, user);
                                    }
                                    else {
                                        throw primaryErr;
                                    }
                                }
                                break;`
      if (!src.includes('repository.migrateSession') && src.includes(origBlock)) {
        fs.writeFileSync(decFile, src.replace(origBlock, newBlock))
      }
    }
  } catch {}

  // 5. Utils/auth-utils.js: hindari race condition transactionCache saat decrypt & relayMessage berjalan bersamaan
  try {
    const authFile = path.join(bDir, 'Utils', 'auth-utils.js')
    if (fs.existsSync(authFile)) {
      const src = fs.readFileSync(authFile, 'utf8')
      if (src.includes('let transactionsInProgress = 0;')) {
        const replaced = src.replace(
          /export const addTransactionCapability = \(state, logger, \{ maxCommitRetries, delayBetweenTriesMs \}\) => \{[\s\S]*?function isInTransaction\(\) \{\s*return transactionsInProgress > 0;\s*\}\s*\};/,
          `export const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs }) => {\n    return {\n        get: (type, ids) => state.get(type, ids),\n        set: data => state.set(data),\n        isInTransaction: () => false,\n        transaction: async (work) => work()\n    };\n};`
        )
        if (replaced !== src) fs.writeFileSync(authFile, replaced)
      }
    }
  } catch {}
}

async function loadBaileys () {
  patchBaileysFiles()
  const mod = await import('@whiskeysockets/baileys')
  const lib = { ...(mod.default && typeof mod.default === 'object' ? mod.default : {}), ...mod }
  baileys = lib
  makeWASocket = [mod.makeWASocket, mod.default?.makeWASocket, mod.default?.default, mod.default]
    .find(f => typeof f === 'function')
  ;({ useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = lib)
  if (!makeWASocket) throw new Error('makeWASocket tidak ditemukan di paket Baileys')
}

const SESSION_DIR = path.join(__dirname, 'session')
const USE_QR = process.argv.includes('--qr')
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })
const db = new DB(path.join(__dirname, 'database', 'db.json'), config)

// cache metadata grup (mengurangi request ke server WA)
const groupCache = new Map()

// cache sederhana (dipakai Baileys untuk kirim ulang pesan yang gagal dibuka)
function makeCache (max = 1000) {
  const map = new Map()
  return {
    map,
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); if (map.size > max) map.delete(map.keys().next().value); return true },
    del: (k) => map.delete(k),
    flushAll: () => map.clear()
  }
}
const msgRetryCounterCache = makeCache(2000)
const msgStore = makeCache(1000) // pesan yang dikirim bot, untuk permintaan kirim ulang

// ---------- cegah bot jalan dobel (penyebab utama error Bad MAC) ----------
const LOCK_FILE = path.join(__dirname, 'bot.lock')
function isBotProcessAlive (pid) {
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    // Di Linux/Termux, pastikan PID tersebut benar-benar proses node index.js milik kita
    if (fs.existsSync(`/proc/${pid}/cmdline`)) {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!/node/i.test(cmd) || !/index\.js/i.test(cmd)) return false
    }
    return true
  } catch {
    // Jika ESRCH (proses mati) atau EPERM (di Android/Termux milik proses sistem lain), berarti bukan bot kita
    return false
  }
}
function acquireLock () {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
    if (isBotProcessAlive(pid)) {
      console.log(`[x] Bot SUDAH berjalan (PID ${pid}) — di jendela lain atau di autostart.`)
      console.log('    Untuk menghentikan bot lama di Termux, jalankan: kill -9 ' + pid + ' && rm -f bot.lock')
      process.exit(2)
    }
  } catch {}
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)) } catch {}
  const release = () => { try { if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE) } catch {} }
  process.on('exit', release)
  process.on('SIGINT', () => { release(); process.exit(0) })
  process.on('SIGTERM', () => { release(); process.exit(0) })
  process.on('SIGHUP', () => { release(); process.exit(0) })
}

// ---------- rapikan log internal dari libsignal ----------
let decryptFails = 0
let lastDecryptNotice = 0
const origErr = console.error
const origLog = console.log
const origInfo = console.info
const origWarn = console.warn
function isSignalLifecycleLog (args) {
  const t = args.map(a => (a && a.stack) || String(a)).join(' ')
  return /Closing open session|Closing session|Opening session|Removing old closed session|Session already closed|Session already open|SessionEntry|Decrypted message with closed session|Migrating session to/i.test(t)
}
function isSignalDecryptError (args) {
  const t = args.map(a => (a && a.stack) || String(a)).join(' ')
  return /Bad MAC|Failed to decrypt message|Session error|No matching sessions|No session record|MessageCounterError|Invalid PreKey ID|Missing SignedPreKey/i.test(t)
}
function noise (orig) {
  return (...args) => {
    if (isSignalLifecycleLog(args)) return
    if (!isSignalDecryptError(args)) return orig(...args)
    decryptFails++
    if (Date.now() - lastDecryptNotice > 60000) {
      lastDecryptNotice = Date.now()
      origLog(`[!] Sedang menyinkronkan ulang enkripsi pesan otomatis (${decryptFails})...`)
    }
  }
}
console.error = noise(origErr)
console.log = noise(origLog)
console.info = noise(origInfo)
console.warn = noise(origWarn)

let retry = 0
let pairingRequested = false
let botNumberCache = ''
let authState = null
let saveCredsFn = null
let cachedKeyStore = null
let activeSock = null

function ask (q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(q, a => { rl.close(); resolve(a.trim()) }))
}

// ---------- perbaikan "Menunggu pesan ini" (sesi enkripsi rusak dengan nomor tertentu) ----------
// Menghapus sesi Signal milik nomor tertentu (PN + LID, semua perangkat) dan memori sender-key grup,
// sehingga pesan berikutnya dari bot otomatis membuat kunci enkripsi baru yang bisa dibuka HP tujuan.
function signalUsersFor (phones = []) {
  const users = new Set()
  for (const p of phones) {
    const d = normPhone(String(p || '').split('@')[0].split(':')[0])
    if (d) users.add(d)
    const raw = String(p || '').split('@')[0].split(':')[0].replace(/\D/g, '')
    if (raw) users.add(raw)
  }
  for (const [lid, pn] of Object.entries(db.data.lidToPn || {})) {
    if (users.has(String(pn))) users.add(String(lid).split('@')[0].split(':')[0])
  }
  for (const [pn, chatJid] of Object.entries(db.data.pnToChatJid || {})) {
    if (users.has(String(pn)) && String(chatJid).endsWith('@lid')) users.add(String(chatJid).split('@')[0].split(':')[0])
  }
  return users
}

async function resetSignalSessions ({ phones = [], groups = true, groupJid = null } = {}) {
  const users = signalUsersFor(phones)
  const files = fs.existsSync(SESSION_DIR) ? fs.readdirSync(SESSION_DIR) : []
  const sessionFiles = []
  const skmFiles = []
  for (const f of files) {
    let m = f.match(/^session-(.+)\.json$/)
    if (m) {
      const user = m[1].split('.')[0].split('_')[0]
      if (users.has(user)) sessionFiles.push({ f, id: m[1] })
      continue
    }
    m = f.match(/^sender-key-memory-(.+)\.json$/)
    if (m && groups) {
      const id = m[1].replace(/__/g, '/')
      if (!groupJid || id === groupJid) skmFiles.push({ f, id })
    }
  }
  // hapus dari cache memori (kalau bot sedang jalan) lalu dari file
  if (cachedKeyStore) {
    const data = {}
    if (sessionFiles.length) data.session = Object.fromEntries(sessionFiles.map(x => [x.id, null]))
    if (skmFiles.length) data['sender-key-memory'] = Object.fromEntries(skmFiles.map(x => [x.id, null]))
    if (groupJid && groups && !skmFiles.some(x => x.id === groupJid)) {
      data['sender-key-memory'] = { ...(data['sender-key-memory'] || {}), [groupJid]: null }
    }
    try { if (Object.keys(data).length) await cachedKeyStore.set(data) } catch {}
  }
  for (const x of [...sessionFiles, ...skmFiles]) {
    try { fs.unlinkSync(path.join(SESSION_DIR, x.f)) } catch {}
  }
  return { sessions: sessionFiles.length, groups: skmFiles.length, users: [...users] }
}

// Sekali jalan setelah update: segarkan sesi enkripsi owner/admin + memori sender-key semua grup
function oneTimeSignalRefresh () {
  try {
    if (db.data.settings.signalFixV1) return
    const phones = [...(config.owner || []), ...(db.data.admins || [])]
    const users = signalUsersFor(phones)
    const files = fs.existsSync(SESSION_DIR) ? fs.readdirSync(SESSION_DIR) : []
    let s = 0; let g = 0
    for (const f of files) {
      const m = f.match(/^session-(.+)\.json$/)
      if (m && users.has(m[1].split('.')[0].split('_')[0])) { try { fs.unlinkSync(path.join(SESSION_DIR, f)); s++ } catch {} }
      if (/^sender-key-memory-.+\.json$/.test(f)) { try { fs.unlinkSync(path.join(SESSION_DIR, f)); g++ } catch {} }
    }
    db.data.settings.signalFixV1 = true
    db.save()
    if (s || g) console.log(`[✓] Enkripsi owner/admin disegarkan (${s} sesi, ${g} grup) agar pesan bot tidak "Menunggu pesan ini".`)
  } catch {}
}

function banner () {
  console.log(`
==========================================
   BOT WHATSAPP  •  ${db.data.settings.storeName}
==========================================`)
}

async function start () {
  if (activeSock) {
    try { activeSock.ev.removeAllListeners() } catch {}
    try { activeSock.ws?.close() } catch {}
    activeSock = null
  }

  if (!authState || !saveCredsFn || !cachedKeyStore) {
    const loaded = await useMultiFileAuthState(SESSION_DIR)
    authState = loaded.state
    saveCredsFn = loaded.saveCreds
    cachedKeyStore = makeCacheableSignalKeyStore(authState.keys, logger)
  }

  let version
  try {
    const latest = await fetchLatestBaileysVersion()
    version = latest.version
  } catch {}

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    auth: {
      creds: authState.creds,
      keys: cachedKeyStore
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    cachedGroupMetadata: async jid => groupCache.get(jid),
    msgRetryCounterCache,
    msgStore,
    getMessage: async (key) => msgStore.get(key.id)
  })
  activeSock = sock

  sock.ev.on('creds.update', saveCredsFn)

  const handler = createHandler({ sock, getSock: () => activeSock, db, config, baileys, logger, groupCache, msgStore, resetSignal: resetSignalSessions })

  // ---------- login dengan kode pairing ----------
  const isRegistered = !!(sock.authState.creds.registered || sock.authState.creds.me?.id)
  if (!USE_QR && !isRegistered && !pairingRequested) {
    pairingRequested = true
    let number = botNumberCache || normPhone(process.env.BOT_NUMBER || config.botNumber)
    if (!number) {
      if (!process.stdin.isTTY) {
        console.log('[!] Nomor bot belum diisi. Isi botNumber di config.js atau jalankan "npm start" langsung untuk login pertama. Web Dashboard tetap aktif.')
        pairingRequested = false
        return
      }
      number = normPhone(await ask('\nMasukkan nomor WhatsApp untuk BOT (contoh 08123456789): '))
    }
    botNumberCache = number
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(number)
        console.log(`
------------------------------------------
  KODE PAIRING : ${code?.match(/.{1,4}/g)?.join('-') || code}
------------------------------------------
Buka WhatsApp di HP nomor bot (${number}):
  ⋮ / Setelan > Perangkat tertaut > Tautkan perangkat
  > "Tautkan dengan nomor telepon saja" > masukkan kode di atas.
`)
      } catch (e) {
        console.log('[!] Gagal meminta kode pairing:', e?.message || e)
        console.log('    Coba jalankan ulang bot, atau pakai: npm run qr')
        pairingRequested = false
      }
    }, 3000)
  }

  // ---------- status koneksi ----------
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr && USE_QR) {
      require('qrcode-terminal').generate(qr, { small: true })
      console.log('Scan QR di atas dari WhatsApp nomor bot > Perangkat tertaut.')
    }
    if (connection === 'open') {
      retry = 0
      const me = sock.user?.id?.split(':')[0]?.split('@')[0]
      console.log(`[✓] Bot tersambung sebagai ${me}. Bot siap menerima pesan.`)
      const lastNotify = db.data.settings.lastOwnerNotify || 0
      if (config.notifyOwnerOnConnect && config.owner?.[0] && Date.now() - lastNotify > 6 * 3600 * 1000) {
        db.data.settings.lastOwnerNotify = Date.now(); db.save()
        const ownerPhone = normPhone(config.owner[0])
        const ownerJid = db.data.pnToChatJid?.[ownerPhone] || (ownerPhone + '@s.whatsapp.net')
        try {
          await sock.sendMessage(ownerJid, { text: `✅ Bot *${db.data.settings.storeName}* aktif.\nKetik *.admin* untuk melihat menu admin.` })
        } catch {}
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('[x] Sesi keluar (logout dari HP). Menghapus sesi... jalankan bot lagi untuk login ulang.')
        fs.rmSync(SESSION_DIR, { recursive: true, force: true })
        process.exit(1)
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.log('[x] Sesi dipakai di tempat lain (bot dijalankan dobel?). Bot berhenti.')
        process.exit(1)
      }
      if (!sock.authState.creds.registered && !sock.authState.creds.me?.id) pairingRequested = false
      retry++
      const wait = code === DisconnectReason.restartRequired ? 500 : Math.min(30000, 2000 * retry)
      console.log(`[!] Koneksi terputus (kode ${code ?? '-'}). Menyambung ulang dalam ${Math.round(wait / 1000)} detik...`)
      setTimeout(() => start().catch(err => { console.error('[ERROR start]', err?.message || err); process.exit(1) }), wait)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      const jid = m.key?.remoteJid || ''
      if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue
      if (m.key?.fromMe && m.key?.id && m.message) {
        msgStore.set(m.key.id, m.message)
      }
      if (!m.message) continue
      if (type !== 'notify') continue
      try { await handler.onMessage(m) } catch (e) { console.error('[ERROR pesan]', e?.message || e) }
    }
  })

  sock.ev.on('group-participants.update', async (upd) => {
    groupCache.delete(upd.id)
    try { await handler.onParticipants(upd) } catch (e) { console.error('[ERROR welcome]', e?.message || e) }
  })

  sock.ev.on('groups.update', (ups) => {
    for (const g of ups) if (g.id) groupCache.delete(g.id)
  })
}

banner()
acquireLock()
oneTimeSignalRefresh()
loadBaileys().then(start).catch(err => {
  console.error('[ERROR]', err)
  process.exit(1)
})

process.on('uncaughtException', e => console.error('[uncaughtException]', e?.message || e))
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e))
