import { createFile, MP4BoxBuffer, type Movie } from 'mp4box'

export interface VideoMetadata {
  /** Seconds, preserving the file header's precision. */
  duration: number
  width: number
  height: number
}

/**
 * Duration and display size from an MP4/MOV file's own header, read with
 * mp4box. A file without a readable header or a video track is refused: an
 * asset whose length is unknown cannot be published to Instagram or Facebook.
 */
export function readMp4Metadata(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): VideoMetadata {
  // A view over its whole buffer is parsed in place; only a partial view is
  // copied, so a large upload is not held twice.
  const arrayBuffer = !(bytes instanceof Uint8Array) ? bytes
    : bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const file = createFile()
  const read: { movie?: Movie; failure?: string } = {}
  file.onReady = (movie) => { read.movie = movie }
  file.onError = (module, message) => { read.failure = `${module}: ${message}` }
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0), true)
  file.flush()
  if (read.failure) throw new Error(`The video file could not be read: ${read.failure}`)
  const movie = read.movie
  if (!movie) throw new Error('The video file has no MP4 header (moov box)')
  const track = movie.videoTracks[0]
  if (!track) throw new Error('The video file has no video track')
  const seconds = movie.fragment_duration
    ? movie.fragment_duration.num / movie.fragment_duration.den
    : movie.duration / movie.timescale
  // The track header holds the display size (pixel aspect applied); the
  // sample entry's coded size is the fallback. A quarter-turn in the track's
  // matrix (a = d = 0) means the picture is shown rotated: swap them.
  const storedWidth = track.track_width || track.video?.width
  const storedHeight = track.track_height || track.video?.height
  const quarterTurn = track.matrix[0] === 0 && track.matrix[4] === 0
  const [width, height] = quarterTurn ? [storedHeight, storedWidth] : [storedWidth, storedHeight]
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('The video file does not state its duration')
  if (!width || !height) throw new Error('The video file does not state its dimensions')
  return { duration: seconds, width, height }
}

// Boxes on the path from moov to a track's chunk offset table.
const CHUNK_OFFSET_PATH = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

interface TopLevelBox { type: string; start: number; end: number }

function readBoxes(view: DataView, start: number, end: number): TopLevelBox[] {
  const boxes: TopLevelBox[] = []
  let position = start
  while (position < end) {
    if (position + 8 > end) throw new Error(`The video file has a truncated box header at byte ${position}`)
    let size = view.getUint32(position)
    let header = 8
    if (size === 1) {
      size = Number(view.getBigUint64(position + 8))
      header = 16
    } else if (size === 0) {
      size = end - position
    }
    if (size < header || position + size > end) throw new Error(`The video file has a box whose size runs past its container at byte ${position}`)
    const type = String.fromCharCode(view.getUint8(position + 4), view.getUint8(position + 5), view.getUint8(position + 6), view.getUint8(position + 7))
    boxes.push({ type, start: position, end: position + size })
    position += size
  }
  return boxes
}

function headerSize(view: DataView, box: TopLevelBox): number {
  return view.getUint32(box.start) === 1 ? 16 : 8
}

/** Adds `shift` to every chunk offset in `moov` that points into [from, to). */
function shiftChunkOffsets(view: DataView, container: TopLevelBox, from: number, to: number, shift: number) {
  for (const box of readBoxes(view, container.start + headerSize(view, container), container.end)) {
    if (CHUNK_OFFSET_PATH.has(box.type)) {
      shiftChunkOffsets(view, box, from, to, shift)
      continue
    }
    if (box.type !== 'stco' && box.type !== 'co64') continue
    const table = box.start + headerSize(view, box) + 4
    const count = view.getUint32(table)
    const wide = box.type === 'co64'
    for (let i = 0; i < count; i++) {
      const at = table + 4 + i * (wide ? 8 : 4)
      const offset = wide ? Number(view.getBigUint64(at)) : view.getUint32(at)
      if (offset < from || offset >= to) continue
      if (wide) view.setBigUint64(at, BigInt(offset + shift))
      else if (offset + shift > 0xffffffff) throw new Error('The video file is too large to move its header before its media data')
      else view.setUint32(at, offset + shift)
    }
  }
}

/**
 * The same MP4 with its `moov` header before its first `mdat`, so a player
 * reads duration and size from the first bytes instead of after the whole
 * file (`qt-faststart`). No sample is re-encoded or moved relative to another;
 * each chunk offset that the move displaces is shifted by the header's size.
 */
export function fastStartMp4(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength)
  const boxes = readBoxes(view, 0, source.byteLength)
  const moov = boxes.find(box => box.type === 'moov')
  if (!moov) throw new Error('The video file has no MP4 header (moov box)')
  const firstMdat = boxes.find(box => box.type === 'mdat')
  if (!firstMdat || moov.start < firstMdat.start) return source

  const output = new Uint8Array(source.byteLength)
  let written = 0
  for (const box of boxes) {
    if (box === moov) continue
    if (box === firstMdat) {
      output.set(source.subarray(moov.start, moov.end), written)
      written += moov.end - moov.start
    }
    output.set(source.subarray(box.start, box.end), written)
    written += box.end - box.start
  }
  const movedMoov: TopLevelBox = { type: 'moov', start: firstMdat.start, end: firstMdat.start + moov.end - moov.start }
  shiftChunkOffsets(new DataView(output.buffer), movedMoov, firstMdat.start, moov.start, moov.end - moov.start)
  return output
}
