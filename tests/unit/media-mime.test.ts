import assert from 'node:assert/strict'
import test from 'node:test'
import { imagePixelSize } from '../../server/utils/media-mime.ts'

const bytes = (...parts: Array<number[] | string>) => Uint8Array.from(parts.flatMap(part => typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : part))
const u16 = (value: number) => [value >> 8 & 0xff, value & 0xff]
const u32 = (value: number) => [value >>> 24 & 0xff, value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff]
const box = (type: string, ...body: number[][]) => { const payload = body.flat(); return [...u32(8 + payload.length), ...Buffer.from(type, 'latin1'), ...payload] }

test('a JPEG size is read past the fill bytes that may precede a marker', () => {
  const sof = [0xff, 0xff, 0xff, 0xc0, ...u16(17), 8, ...u16(480), ...u16(640), 3, ...Array(9).fill(0)]
  assert.deepEqual(imagePixelSize(bytes([0xff, 0xd8], [0xff, 0xe0, ...u16(4), 0, 0], sof)), { width: 640, height: 480 })
})

test('a GIF size is its logical screen width and height', () => {
  assert.deepEqual(imagePixelSize(bytes('GIF89a', [0x20, 0x03, 0x58, 0x02], [0, 0, 0])), { width: 800, height: 600 })
})

test('an AVIF size is its primary item\'s ispe, not the first one in the file', () => {
  const thumbnail = box('ispe', [0, 0, 0, 0], u32(160), u32(120))
  const primary = box('ispe', [0, 0, 0, 0], u32(2560), u32(1920))
  // Item 1 is the thumbnail (property 1), item 2 the primary image (property 2).
  const ipma = box('ipma', [0, 0, 0, 0], u32(2), u16(1), [1, 0x81], u16(2), [1, 0x82])
  const meta = box('meta', [0, 0, 0, 0], box('pitm', [0, 0, 0, 0], u16(2)), box('iprp', box('ipco', thumbnail, primary), ipma))
  assert.deepEqual(imagePixelSize(bytes(box('ftyp', [...Buffer.from('avif')], u32(0)), meta)), { width: 2560, height: 1920 })
  // Without a size for the primary item the size cannot be read.
  const unsized = box('meta', [0, 0, 0, 0], box('pitm', [0, 0, 0, 0], u16(3)), box('iprp', box('ipco', thumbnail, primary), ipma))
  assert.equal(imagePixelSize(bytes(box('ftyp', [...Buffer.from('avif')], u32(0)), unsized)), null)
})

test('an SVG size is its numeric width and height, else its viewBox, else unread', () => {
  const svg = (attributes: string) => new TextEncoder().encode(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect/></svg>`)
  assert.deepEqual(imagePixelSize(svg('width="1200px" height="800"')), { width: 1200, height: 800 })
  assert.deepEqual(imagePixelSize(svg('width="100%" height="100%" viewBox="0 0 640 360"')), { width: 640, height: 360 })
  assert.equal(imagePixelSize(svg('width="100%"')), null)
})
