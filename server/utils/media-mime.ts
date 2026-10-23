// Magic-byte sniffing for user-uploaded media, shared between the dashboard's
// multipart video/file upload route and the MCP inline media upload path.
// Behavior must stay identical to the dashboard's sniffMimeType — this is the
// single source of truth both paths import from.

export const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm"]);
export const POSTER_IMAGE_MIME_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
export const R2_IMAGE_MIME_TYPES = new Set(["image/avif"]);
// What counts as an image is the contract's answer, not each surface's. The
// dashboard used to accept a different set at a different size from MCP, so the
// same file was allowed through one door and refused at the other.
export const RESOLVED_MEDIA_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/svg+xml"]);

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_POSTER_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MP4_BRANDS = new Set([
  "avc1",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "isom",
  "m4v ",
  "m4vp",
  "mmp4",
  "mp41",
  "mp42",
  "mp4v",
  "msnv",
])

export function sniffMediaMimeType(data: Uint8Array): string {
  if (
    data.byteLength >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) {
    return "image/png";
  }

  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }

  if (data.byteLength >= 6) {
    const gifHeader = String.fromCharCode(data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0, data[4] ?? 0, data[5] ?? 0);
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      return "image/gif";
    }
  }

  if (data.byteLength >= 5 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d) {
    return "application/pdf";
  }

  if (data.byteLength >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return "video/webm";
  }

  if (
    data.byteLength >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    data.byteLength >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x41 && data[9] === 0x56 && data[10] === 0x49 && data[11] === 0x20
  ) {
    return "application/octet-stream";
  }

  if (data.byteLength >= 12 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
    const brand = String.fromCharCode(data[8] ?? 0, data[9] ?? 0, data[10] ?? 0, data[11] ?? 0).toLowerCase();
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
    if (brand.startsWith("qt")) return "application/octet-stream";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
    return "application/octet-stream";
  }

  const sample = new TextDecoder().decode(data.slice(0, Math.min(data.byteLength, 1024))).trimStart().toLowerCase();
  if (sample.startsWith("<svg") || (sample.startsWith("<?xml") && sample.includes("<svg"))) {
    return "image/svg+xml";
  }

  return "application/octet-stream";
}

/**
 * The pixel size an image file declares, or null when its header does not say
 * (a type not listed here, or a header too short or malformed). Read from the
 * bytes alone, so an import can record what it stored: PNG, JPEG, WebP and GIF
 * from their headers, AVIF from its primary item's `ispe` property, SVG from
 * the root element's numeric width and height, else its viewBox.
 */
export function imagePixelSize(data: Uint8Array): { width: number; height: number } | null {
  const type = sniffMediaMimeType(data)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (type === "image/png") return data.byteLength >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null
  if (type === "image/gif") return data.byteLength >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : null
  if (type === "image/jpeg") {
    // Walk the segments to the first start-of-frame marker (C0–CF except C4, C8, CC).
    for (let offset = 2; offset + 9 < data.byteLength;) {
      if (data[offset] !== 0xff) return null
      // A marker may be preceded by any number of 0xFF fill bytes.
      while (data[offset + 1] === 0xff && offset + 10 < data.byteLength) offset++
      const marker = data[offset + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      }
      offset += 2 + view.getUint16(offset + 2)
    }
    return null
  }
  if (type === "image/webp" && data.byteLength >= 30) {
    const chunk = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!)
    if (chunk === "VP8X") return { width: 1 + (data[24]! | data[25]! << 8 | data[26]! << 16), height: 1 + (data[27]! | data[28]! << 8 | data[29]! << 16) }
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  if (type === "image/avif") return avifPixelSize(data, view)
  if (type === "image/svg+xml") return svgPixelSize(data)
  return null
}

/** ISOBMFF boxes in [start, end): their type, where their payload starts, and where they end. */
function boxes(view: DataView, start: number, end: number): Array<{ type: string; body: number; end: number }> {
  const found = []
  for (let offset = start; offset + 8 <= end;) {
    const size = view.getUint32(offset)
    const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7))
    if (size < 8 || offset + size > end) return []
    found.push({ type, body: offset + 8, end: offset + size })
    offset += size
  }
  return found
}

/** An AVIF's size: the `ispe` property the `ipma` table associates with the `pitm` primary item. */
function avifPixelSize(data: Uint8Array, view: DataView): { width: number; height: number } | null {
  const meta = boxes(view, 0, data.byteLength).find(box => box.type === "meta")
  if (!meta) return null
  // meta, pitm and ipma are full boxes: a version byte and three flag bytes first.
  const inner = boxes(view, meta.body + 4, meta.end)
  const pitm = inner.find(box => box.type === "pitm")
  const iprp = inner.find(box => box.type === "iprp")
  const associations = iprp ? boxes(view, iprp.body, iprp.end) : []
  const ipco = associations.find(box => box.type === "ipco")
  const ipma = associations.find(box => box.type === "ipma")
  if (!pitm || !ipco || !ipma) return null
  const primary = view.getUint8(pitm.body) === 0 ? view.getUint16(pitm.body + 4) : view.getUint32(pitm.body + 4)
  const properties = boxes(view, ipco.body, ipco.end)
  const version = view.getUint8(ipma.body)
  const wide = (view.getUint8(ipma.body + 3) & 1) === 1
  let offset = ipma.body + 8
  for (let entry = view.getUint32(ipma.body + 4); entry > 0 && offset < ipma.end; entry--) {
    const item = version < 1 ? view.getUint16(offset) : view.getUint32(offset)
    offset += version < 1 ? 2 : 4
    const count = view.getUint8(offset++)
    for (let index = 0; index < count; index++) {
      const property = (wide ? view.getUint16(offset) & 0x7fff : view.getUint8(offset) & 0x7f) - 1
      offset += wide ? 2 : 1
      const ispe = properties[property]
      if (item === primary && ispe?.type === "ispe") return { width: view.getUint32(ispe.body + 4), height: view.getUint32(ispe.body + 8) }
    }
  }
  return null
}

/** An SVG's size: the root element's width and height when both are plain numbers (or px), else its viewBox. */
function svgPixelSize(data: Uint8Array): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(new TextDecoder().decode(data.slice(0, Math.min(data.byteLength, 4096))))?.[0]
  if (!root) return null
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1]?.trim()
  const length = (value: string | undefined) => value && /^\d+(\.\d+)?(px)?$/.test(value) ? Number.parseFloat(value) : null
  const width = length(attribute("width"))
  const height = length(attribute("height"))
  if (width && height) return { width: Math.round(width), height: Math.round(height) }
  const box = attribute("viewBox")?.split(/[\s,]+/).map(Number)
  if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: Math.round(box[2]!), height: Math.round(box[3]!) }
  return null
}
