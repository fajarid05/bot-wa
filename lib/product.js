// Penyusun tampilan produk otomatis (jenis + harga, keterangan, note)

const INFO_KEYS = ['bayar', 'cara order']

const PRICE_RE = /^(?:rp\.?\s*)?\d[\d.,]*\s*(?:k|rb|ribu|jt|juta)?$/i

// Tambah nominal (mis. +5000 untuk chat pribadi/luar grup) secara bersih tanpa terlihat embel-embel "+5000"
function applyExtraPrice (s, extra = 0) {
  const add = Math.max(0, Number(extra) || 0)
  if (!add) return String(s || '')
  const t = String(s || '').trim()
  // Format "25K" / "25rb" / "25 ribu"
  const mk = t.match(/^(rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(k|rb|ribu)\b(.*)$/i)
  if (mk) {
    const val = Math.round(parseFloat(mk[2].replace(',', '.')) * 1000) + add
    if (!mk[1] && /^k$/i.test(mk[3]) && val % 1000 === 0) {
      return `${val / 1000}${mk[3]}${mk[4] || ''}`
    }
    return `Rp ${val.toLocaleString('id-ID')}${mk[4] || ''}`
  }
  // Format "10000" / "Rp 10.000" / "3000"
  const mn = t.match(/^(rp\.?\s*)?(\d{1,3}(?:\.\d{3})+|\d{3,})(.*)$/i)
  if (mn) {
    const rawNum = Number(mn[2].replace(/\./g, ''))
    if (Number.isFinite(rawNum) && rawNum >= 500) {
      return `Rp ${(rawNum + add).toLocaleString('id-ID')}${mn[3] || ''}`
    }
  }
  return t
}

// "30000" -> "Rp 30.000" ; "500" -> "Rp 500" ; "30K" tetap "30K"
function fmtPrice (s, extra = 0) {
  const raw = extra > 0 ? applyExtraPrice(s, extra) : String(s || '')
  const t = String(raw || '').trim().replace(/^rp\.?\s*/i, 'Rp ')
  const m = t.match(/^(?:rp\.?\s*)?(\d{3,})$/i)
  if (m) return 'Rp ' + Number(m[1]).toLocaleString('id-ID')
  return t.replace(/(^|[\s(])(\d{4,})(?=$|[\s),])/g, (_, pre, num) => `${pre}Rp ${Number(num).toLocaleString('id-ID')}`)
}

function stripInvisible (s) {
  return String(s || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u115F\u1160\u180E\u2800\u3164\uFFA0]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
}

// buang simbol/bullet di depan nama variasi (•, ◦, ▸, -, dll.) tanpa merusak nama
function cleanTypeName (s) {
  return stripInvisible(s).trim().replace(/^[^\p{L}\p{N}([+]+/u, '').replace(/\s{2,}/g, ' ').trim()
}

function cleanLine (s) {
  return stripInvisible(s)
    .replace(/^\s*\d{1,2}[.)]\s+/, '') // "1. " di depan
    .replace(/^[\s\-•●∙◦*◦○✦✅☑️💸🏷️▪️►▸>]+/u, '')
    .replace(/^(harga|price)\s*:\s*/i, '')
    .trim()
}

// pisah per baris atau per ";"
function splitLines (s) {
  if (!s) return []
  const t = String(s).trim()
  if (['-', 'skip', 'lewati'].includes(t.toLowerCase())) return []
  return t.split(/\n|;/).map(cleanLine).filter(Boolean)
}

// "3 Bulan = 25000" | "3 Bulan = 25000 (10)" | "3 Bulan : 25K" | "3 Bulan - 25K" | "25000"
function parseType (line) {
  let l = cleanLine(line)
  let stock = null
  const stMatch = l.match(/\s*(?:\(\s*(?:stok\s*[:=]?\s*)?(\d+)\s*\)|\[\s*(?:stok\s*[:=]?\s*)?(\d+)\s*\]|\bstok\s*[:=]\s*(\d+))\s*$/i)
  if (stMatch) {
    stock = Number(stMatch[1] ?? stMatch[2] ?? stMatch[3])
    l = l.slice(0, stMatch.index).trim()
  }
  const withStock = (obj) => (stock !== null && Number.isFinite(stock) ? { ...obj, stock } : obj)
  let m = l.match(/^(.*?)\s*(?:=|:|»|—|–|\s-\s|\s->\s)\s*(.+)$/)
  if (m && /\d/.test(m[2])) return withStock({ name: m[1].trim(), price: m[2].trim() })
  if (PRICE_RE.test(l)) return withStock({ name: '', price: l })
  m = l.match(/^(.*\S)\s+((?:rp\.?\s*)?\d[\d.,]*\s*(?:k|rb|ribu|jt|juta)?(?:\s*\(.*\))?)$/i)
  if (m && !/^\d+$/.test(m[1]) && !/^\d+\s*(bulan|bln|hari|minggu|tahun|thn|jam)?$/i.test(m[2])) {
    return withStock({ name: m[1].trim(), price: m[2].trim() })
  }
  return withStock({ name: l, price: '' })
}

function parseTypes (s) {
  return splitLines(s).map(parseType).filter(t => t.name || t.price)
}

function totalItemStock (item) {
  if (!item) return null
  if (Array.isArray(item.types) && item.types.length) {
    const tracked = item.types.filter(t => t.stock !== null && t.stock !== undefined && t.stock !== '' && Number.isFinite(Number(t.stock)))
    if (tracked.length) {
      return tracked.reduce((sum, t) => sum + Math.max(0, Math.floor(Number(t.stock))), 0)
    }
  }
  if (item.supplierStock !== null && item.supplierStock !== undefined && item.supplierStock !== '' && Number.isFinite(Number(item.supplierStock))) {
    return Math.max(0, Math.floor(Number(item.supplierStock)))
  }
  return null
}

function isItemOutOfStock (item) {
  if (!item) return false
  if (Array.isArray(item.types) && item.types.length) {
    const tracked = item.types.filter(t => t.stock !== null && t.stock !== undefined && t.stock !== '' && Number.isFinite(Number(t.stock)))
    if (tracked.length) {
      if (tracked.some(t => Number(t.stock) > 0)) return false
      if (tracked.length === item.types.length) return true
    }
  }
  if (item.supplierStock !== null && item.supplierStock !== undefined && item.supplierStock !== '' && Number(item.supplierStock) <= 0) return true
  return false
}

function minItemPrice (item, extra = 0) {
  if (!item || !Array.isArray(item.types) || !item.types.length) return ''
  const avail = item.types.filter(t => t.stock === null || t.stock === undefined || t.stock === '' || Number(t.stock) > 0)
  const list = avail.length ? avail : item.types
  let best = null
  let bestVal = Infinity
  for (const t of list) {
    const num = Number(String(t.price || '').replace(/\D/g, ''))
    if (num > 0 && num < bestVal) {
      bestVal = num
      best = t.price
    }
  }
  return fmtPrice(best || list[0].price, extra)
}

function typeLine (t, extra = 0) {
  const cleanName = cleanTypeName(t.name)
  const hasStock = t.stock !== null && t.stock !== undefined && t.stock !== '' && Number.isFinite(Number(t.stock))
  const st = hasStock ? Number(t.stock) : null
  const stockBadge = st === 0 ? ' _(habis)_' : ''
  if (cleanName && t.price) return `${cleanName} » *${fmtPrice(t.price, extra)}*${stockBadge}`
  return (t.price ? `*${fmtPrice(t.price, extra)}*` : cleanName) + stockBadge
}

function render (item, settings = {}, opts = {}) {
  const extra = Math.max(0, Number(opts.extraPrice) || 0)
  const parts = []
  if (item.types) {
    const title = stripInvisible(item.title || item.name).trim()
    const outOfStock = isItemOutOfStock(item)
    const hasAnyStockInfo = (item.supplierStock !== null && item.supplierStock !== undefined) ||
      item.types.some(t => t.stock !== null && t.stock !== undefined && t.stock !== '')
    const statusLine = hasAnyStockInfo
      ? (outOfStock ? '⚠️ *Status :* Stok Sedang Habis' : '✅ *Status :* Stok Tersedia')
      : ''
    const head = [statusLine ? `「 *${title}* 」\n${statusLine}` : `「 *${title}* 」`]
    const types = item.types
    if (types.length === 1 && !cleanTypeName(types[0].name)) {
      head.push(`💸 *Harga :* ${typeLine(types[0], extra)}`)
    } else if (types.length) {
      const label = types.length > 1 ? '📦 *Pilih Variasi :*' : '📦 *Variasi & Harga :*'
      head.push(label + '\n' + types.map(t => `▸ ${typeLine(t, extra)}`).join('\n'))
    }
    parts.push(head.join('\n\n'))
    const cleanDesc = (item.desc || []).map(d => stripInvisible(d).trim()).filter(Boolean)
    if (cleanDesc.length) parts.push('📝 *Deskripsi :*\n' + cleanDesc.map(d => `✅ ${d}`).join('\n'))
  } else if (item.variants) {
    // format lama (versi sebelumnya)
    item.variants.forEach((v, i) => {
      const block = []
      const title = v.name || (i === 0 ? titleCase(item.name) : '')
      if (title) block.push(`「 *${title}* 」`)
      if (v.prices?.length) block.push(v.prices.map(p => `💸 Harga : ${fmtPrice(p, extra)}`).join('\n'))
      if (v.desc?.length) block.push('📝 *Deskripsi :*\n' + v.desc.map(d => `✅ ${d}`).join('\n'))
      if (block.length) parts.push(block.join('\n\n'))
    })
  } else {
    return item.text || ''
  }
  const cleanNote = stripInvisible(item.note).trim()
  if (cleanNote) parts.push('📌 *Note :*\n' + cleanNote)
  if (settings.itemFooter) {
    const code = stripInvisible(item.name || '').toLowerCase().trim()
    const footer = code
      ? String(settings.itemFooter).replace(/<nama produk>/gi, code).replace(/\.beli canva/gi, `.beli ${code}`)
      : settings.itemFooter
    parts.push(footer)
  }
  return parts.join('\n\n')
}

function titleCase (s) {
  return String(s || '').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase())
}

// ".addlist nama|jenis=harga; jenis=harga|keterangan|note"
function parseQuick (segments) {
  const [types, desc, note] = segments
  return {
    types: parseTypes(types),
    desc: splitLines(desc),
    note: note && note.trim() !== '-' ? note.trim() : ''
  }
}

// ubah produk format lama (variants) ke format jenis
function toTypesItem (item) {
  if (item.types) return item
  if (!item.variants) return null
  const types = []; const desc = []
  for (const v of item.variants) {
    for (const p of v.prices || []) {
      const t = parseType(p)
      types.push({ name: [v.name, t.name].filter(Boolean).join(' ') || '', price: t.price || p })
    }
    desc.push(...(v.desc || []))
  }
  return { ...item, types, desc, variants: undefined }
}

// kebalikan parseQuick, untuk .getlist
function toQuick (item) {
  const it = toTypesItem(item)
  if (!it) return null
  const types = it.types.map(t => {
    const base = t.name && t.price ? `${t.name}=${t.price}` : (t.price || t.name)
    const st = t.stock !== null && t.stock !== undefined && t.stock !== '' ? ` (${t.stock})` : ''
    return base + st
  }).join('; ')
  return [it.name, types || '-', (it.desc || []).join('; ') || '-', it.note || '-'].join('|')
}

module.exports = { INFO_KEYS, render, parseQuick, parseTypes, parseType, toQuick, toTypesItem, splitLines, fmtPrice, titleCase, isItemOutOfStock, minItemPrice, totalItemStock }
