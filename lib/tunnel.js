// Cloudflare Quick Tunnel (gratis, tanpa akun) -> link https://xxxx.trycloudflare.com
// Termux  : pkg install cloudflared
// Windows : otomatis diunduh ke folder bin/ saat pertama kali .web on
const fs = require('fs')
const path = require('path')
const https = require('https')
const { spawn, spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const BIN_DIR = path.join(ROOT, 'bin')
const IS_WIN = process.platform === 'win32'
const IS_TERMUX = !!(process.env.PREFIX && process.env.PREFIX.includes('com.termux')) || process.platform === 'android'
const EXE = IS_WIN ? 'cloudflared.exe' : 'cloudflared'

function inPath (cmd) {
  const names = IS_WIN && !cmd.endsWith('.exe') ? [cmd + '.exe', cmd] : [cmd]
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    process.env.PREFIX ? path.join(process.env.PREFIX, 'bin') : '',
    '/data/data/com.termux/files/usr/bin',
    '/usr/local/bin',
    '/usr/bin'
  ].filter(Boolean)
  for (const d of dirs) {
    for (const n of names) {
      const full = path.join(d, n)
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full } catch {}
    }
  }
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (r.status === 0) return cmd
  } catch {}
  return null
}

function findCloudflared () {
  if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) return process.env.CLOUDFLARED_PATH
  const local = path.join(BIN_DIR, EXE)
  if (fs.existsSync(local)) return local
  return inPath('cloudflared')
}

function downloadUrl () {
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch]
  if (!arch) return null
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'
  if (IS_WIN) return base + `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe`
  if (process.platform === 'linux') return base + `cloudflared-linux-${arch}`
  return null
}

function download (url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('terlalu banyak redirect'))
    https.get(url, { headers: { 'User-Agent': 'massid-bot' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const tmp = dest + '.part'
      const out = fs.createWriteStream(tmp)
      res.pipe(out)
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, dest)
        if (!IS_WIN) fs.chmodSync(dest, 0o755)
        resolve(dest)
      }))
      out.on('error', reject)
    }).on('error', reject)
  })
}

// cari cloudflared, kalau belum ada coba unduh otomatis (kecuali Termux -> pakai pkg)
async function ensureCloudflared () {
  const found = findCloudflared()
  if (found) return found
  if (IS_TERMUX) {
    throw new Error('cloudflared belum terpasang. Jalankan di Termux:\n  pkg install cloudflared')
  }
  const url = downloadUrl()
  if (!url) throw new Error('cloudflared belum terpasang & tidak bisa diunduh otomatis untuk sistem ini.')
  fs.mkdirSync(BIN_DIR, { recursive: true })
  console.log('[WEB] Mengunduh cloudflared (sekali saja)...')
  await download(url, path.join(BIN_DIR, EXE))
  console.log('[WEB] cloudflared berhasil diunduh.')
  return path.join(BIN_DIR, EXE)
}

// jalankan tunnel, kembalikan { url, stop }
async function startTunnel (port, timeoutMs = 45000) {
  const bin = await ensureCloudflared()
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let done = false
    let tail = ''
    const timer = setTimeout(() => finish(new Error('Waktu habis menunggu link Cloudflare. Cek koneksi internet HP bot.')), timeoutMs)

    function finish (err, url) {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) { try { proc.kill() } catch {} ; return reject(err) }
      resolve({
        url,
        proc,
        stop: () => { try { proc.kill() } catch {} }
      })
    }

    const onData = (d) => {
      const s = d.toString()
      tail = (tail + s).slice(-1500)
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
      if (m) finish(null, m[0])
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', e => finish(new Error('Gagal menjalankan cloudflared: ' + e.message)))
    proc.on('exit', code => {
      if (!done) finish(new Error(`cloudflared berhenti (kode ${code}).\n${tail.split('\n').slice(-4).join('\n')}`))
    })
  })
}

module.exports = { startTunnel, findCloudflared, IS_TERMUX }
