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
