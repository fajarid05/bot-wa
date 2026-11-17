// Integrasi Google Gemini AI untuk membaca kartu produk Telegram yang formatnya tidak dikenali parser biasa.
// AI HANYA dipakai sebagai cadangan, dan setiap harga dari AI dicek ulang harus benar-benar tertulis di teks asli
// (supaya AI tidak "mengarang" harga).
const https = require('https')

// Urutan model yang dicoba: gemini-2.5-flash, gemini-2.0-flash, gemini-1.5-flash
const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest']

function callGeminiModel (apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    // Kirim API key baik via query param ?key= maupun header x-goog-api-key untuk kompatibilitas kunci model baru (AQ.)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    })
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-goog-api-key': String(apiKey).trim()
      },
      timeout: 15000
    }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.error) return reject(new Error(json.error.message || `Gemini Error (${res.statusCode})`))
          resolve(json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '')
        } catch (e) {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`))
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini API timeout')) })
    req.write(payload)
    req.end()
  })
}

async function callGeminiApi (apiKey, prompt, preferredModel) {
  const models = [preferredModel, ...DEFAULT_MODELS].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i)
  let lastErr = null
  for (const model of models) {
    try {
      return await callGeminiModel(apiKey, model, prompt)
    } catch (e) {
      lastErr = e
      // kunci salah -> tidak perlu coba model lain
      if (/api key not valid|permission|API_KEY_INVALID/i.test(String(e?.message))) break
    }
  }
  throw lastErr || new Error('Gemini API gagal')
}

function extractJson (s) {
  const t = String(s || '').replace(/```json|```/gi, '').trim()
  try { return JSON.parse(t) } catch {}
  const a = t.indexOf('{'); const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch {} }
  return null
}

// Semua angka harga yang benar-benar tertulis di teks asli (untuk mencegah AI mengarang harga)
function pricesInText (raw) {
  const set = new Set()
  const re = /rp\.?\s*(\d{1,3}(?:[.,]\d{3})+|\d{3,8})/gi
  let m
  while ((m = re.exec(String(raw || '')))) set.add(Number(m[1].replace(/[.,]/g, '')))
  return set
}

async function parseWithAI (rawText, apiKey, storeName = 'MASS.ID STORE', model = '') {
  if (!apiKey || !rawText) return null
  const prompt = `Kamu membaca kartu produk dari bot supplier Telegram untuk toko digital "${storeName}".
Ekstrak data ke JSON. Aturan:
1. Jangan menulis nama/identitas supplier (Febrian, @username, link t.me) di mana pun.
2. Buang kalimat promosi supplier seperti "Beli Di Atas 5 Akun Harga Turun" dan "(BACA DESK)".
3. Ganti "Akun Seller" menjadi "Akun Admin".
4. Abaikan rating, ulasan, stok terjual, total stok, tanggal/jam, jumlah, total harga, dan blok "Harga Grosir"/"Min N".
5. basePrice = harga per 1 akun persis seperti tertulis (angka murni). JANGAN mengarang harga yang tidak tertulis.
6. stock = angka stok varian (di dalam kurung atau "Sisa Stok/Sisa Produk"), null jika tidak ada.
7. desc = poin keterangan/garansi dari baris "Desk", dipisah per koma.

Teks kartu:
"""
${rawText}
"""

Balas HANYA JSON:
{"productName":"","types":[{"name":"","basePrice":0,"stock":null}],"desc":[],"note":""}`

  try {
    const parsed = extractJson(await callGeminiApi(apiKey, prompt, model))
    if (!parsed || !Array.isArray(parsed.types)) return null
    const allowed = pricesInText(rawText)
    const types = parsed.types
      .map(t => ({
        name: String(t.name || '').trim(),
        basePrice: Math.round(Number(t.basePrice) || 0),
        stock: t.stock !== undefined && t.stock !== null && t.stock !== '' ? Number(t.stock) : null
      }))
      .filter(t => t.name && t.basePrice > 0 && allowed.has(t.basePrice))
    if (!types.length) return null
    return {
      productName: String(parsed.productName || ''),
      types,
      desc: Array.isArray(parsed.desc) ? parsed.desc.map(d => String(d).trim()).filter(Boolean) : [],
      note: String(parsed.note || '').trim()
    }
  } catch (err) {
    console.error('[AI PARSE ERROR]', err?.message || err)
    return null
  }
}

// Tes nyata apakah API key Gemini berfungsi (dipakai perintah .cekai / .setai)
async function testApiKey (apiKey, preferredModel = '') {
  if (!apiKey) return { ok: false, error: 'API key kosong' }
  const models = [preferredModel, ...DEFAULT_MODELS].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i)
  let lastErr = null
  for (const model of models) {
    const t0 = Date.now()
    try {
      const txt = await callGeminiModel(apiKey, model, 'Balas JSON {"ok":true}')
      return { ok: true, model, ms: Date.now() - t0, reply: String(txt || '').slice(0, 60) }
    } catch (e) {
      lastErr = e
      if (/api key not valid|API_KEY_INVALID|permission|PERMISSION_DENIED/i.test(String(e?.message))) break
    }
  }
  let msg = String(lastErr?.message || 'Gagal terhubung ke Gemini')
  if (/api key not valid|API_KEY_INVALID/i.test(msg)) msg = 'API key tidak valid / salah ketik'
  else if (/quota|exhausted|429/i.test(msg)) msg = 'Kuota API key habis (coba lagi nanti / buat key baru)'
  else if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|timeout/i.test(msg)) msg = 'Koneksi internet ke Google bermasalah (' + msg + ')'
  return { ok: false, error: msg }
}

module.exports = { parseWithAI, callGeminiApi, testApiKey }
