// Pembuat stiker WhatsApp (gambar / video / GIF -> .webp 512x512)
// Butuh ffmpeg:  Termux -> pkg install ffmpeg   |   Windows -> https://ffmpeg.org (taruh di PATH)
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

let ffmpegPath
function findFfmpeg () {
  if (ffmpegPath !== undefined) return ffmpegPath
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'ffmpeg') : null,
    '/data/data/com.termux/files/usr/bin/ffmpeg',
    'ffmpeg'
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { windowsHide: true })
      if (r.status === 0) { ffmpegPath = c; return c }
    } catch {}
  }
  ffmpegPath = null
  return null
}

function run (bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', d => { err = (err + d).slice(-800) })
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg gagal: ' + err.split('\n').slice(-3).join(' '))))
  })
}

async function convert (bin, input, output, animated, opt) {
  const vf = [
    animated ? `fps=${opt.fps}` : null,
    'scale=512:512:force_original_aspect_ratio=decrease',
    'format=rgba',
    'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000'
  ].filter(Boolean).join(',')
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    ...(animated ? ['-t', String(opt.seconds)] : ['-frames:v', '1']),
    '-vf', vf, '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(opt.q),
    '-compression_level', '6', '-loop', '0', '-preset', 'picture', '-an', output]
  await run(bin, args)
  return fs.readFileSync(output)
}

// tambah info pack (nama pack & pembuat) ke stiker
async function addExif (buf, pack, author) {
  let webpmux
  try { webpmux = require('node-webpmux') } catch { return buf }
  try {
    const img = new webpmux.Image()
    const json = {
      'sticker-pack-id': 'massid-' + crypto.randomBytes(6).toString('hex'),
      'sticker-pack-name': pack || '',
      'sticker-pack-publisher': author || '',
      emojis: ['✨']
    }
    const head = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
    const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
    const exif = Buffer.concat([head, jsonBuf])
    exif.writeUIntLE(jsonBuf.length, 14, 4)
    await img.load(buf)
    img.exif = exif
    return await img.save(null)
  } catch { return buf }
}

/**
 * @param {Buffer} buf  isi gambar / video
 * @param {{animated?: boolean, pack?: string, author?: string}} o
 */
async function makeSticker (buf, o = {}) {
  const bin = findFfmpeg()
  if (!bin) throw Object.assign(new Error('ffmpeg belum terpasang'), { code: 'NO_FFMPEG' })
  const id = crypto.randomBytes(6).toString('hex')
  const tmp = os.tmpdir()
  const input = path.join(tmp, `stk_${id}.${o.animated ? 'mp4' : 'img'}`)
  const output = path.join(tmp, `stk_${id}.webp`)
  fs.writeFileSync(input, buf)
  try {
    let out
    if (!o.animated) {
      out = await convert(bin, input, output, false, { q: 75 })
    } else {
      // stiker bergerak harus < 1 MB, turunkan kualitas kalau kebesaran
      const tries = [{ fps: 15, q: 60, seconds: 8 }, { fps: 12, q: 40, seconds: 7 }, { fps: 10, q: 25, seconds: 5 }]
      for (const t of tries) {
        out = await convert(bin, input, output, true, t)
        if (out.length < 1000 * 1024) break
      }
    }
    return await addExif(out, o.pack, o.author)
  } finally {
    for (const f of [input, output]) { try { fs.unlinkSync(f) } catch {} }
  }
}

module.exports = { makeSticker, findFfmpeg }
