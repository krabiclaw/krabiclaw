import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveUserUploadedMediaFile } from '../../server/utils/mcp-tools/execution.ts'

test('ChatGPT attachment downloads refuse a redirect to a private address before fetching it', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string, redirect: RequestRedirect | undefined }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), redirect: init?.redirect })
    return new Response(null, {
      status: 302,
      headers: { location: 'https://10.0.0.1/internal' },
    })
  }

  try {
    await assert.rejects(
      () => resolveUserUploadedMediaFile({
        download_url: 'https://files.example.test/attachment',
        file_id: 'file-1',
      }),
      /Attachment file-1 redirect download URL cannot target a private IPv4 address/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls, [{
    url: 'https://files.example.test/attachment',
    redirect: 'manual',
  }])
})

test('ChatGPT attachment downloads follow a redirect to a public address', async () => {
  const originalFetch = globalThis.fetch
  const video = new Uint8Array(64)
  video.set([0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 4)
  const calls: Array<{ url: string, redirect: RequestRedirect | undefined }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), redirect: init?.redirect })
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: '/signed/video.mp4' } })
      : new Response(video, { headers: { 'content-type': 'video/mp4' } })
  }

  try {
    const resolved = await resolveUserUploadedMediaFile({
      download_url: 'https://files.example.test/attachment',
      file_id: 'file-redirected',
      mime_type: 'video/mp4',
      file_name: 'video.mp4',
    })
    assert.equal(resolved.kind, 'video')
    assert.equal(resolved.buffer.byteLength, video.byteLength)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls, [
    { url: 'https://files.example.test/attachment', redirect: 'manual' },
    { url: 'https://files.example.test/signed/video.mp4', redirect: 'manual' },
  ])
})

test('ChatGPT attachment downloads stop after five redirects', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(null, { status: 302, headers: { location: `https://files.example.test/hop-${calls}` } })
  }

  try {
    await assert.rejects(
      () => resolveUserUploadedMediaFile({
        download_url: 'https://files.example.test/attachment',
        file_id: 'file-loop',
      }),
      /Failed to download attachment file-loop: more than 5 redirects/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls, 6)
})

