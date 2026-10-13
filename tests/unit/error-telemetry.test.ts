import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_ERROR_LIMITS, errorChainForTelemetry, redactErrorText, serializeBrowserErrorReport,
} from '../../shared/error-telemetry.ts'

test('error telemetry removes credentials, customer email, signed URLs and database parameters before transport', () => {
  const privateMessage = 'Detail lookup failed for guest@example.test: Bearer bearer-secret, sk_live_keySecret '
    + 'password=password-secret; token: "field-secret"; cookie=session-secret; '
    + 'https://signed.example.test/file?token=absolute-secret '
    + '/api/public/products/item?access_token=relative-secret\nparams: parameter-secret'
  const error = Object.assign(new Error(privateMessage), {
    code: 'Bearer code-secret',
    statusCode: 500,
    requestId: 'source-request-123',
    stack: privateMessage,
  })

  const chain = errorChainForTelemetry(error)
  const transported = JSON.stringify(chain)

  assert.doesNotMatch(transported, /guest@example|bearer-secret|keySecret|password-secret|field-secret|session-secret|absolute-secret|relative-secret|parameter-secret|code-secret/)
  assert.match(chain[0]!.message, /Detail lookup failed/)
  assert.equal(chain[0]!.status, 500)
  assert.equal(chain[0]!.request_id, 'source-request-123')
  assert.match(chain[0]!.message, /\[email redacted\]/)
  assert.match(chain[0]!.message, /\[url redacted\]/)
})

test('error telemetry preserves failure correlation while rejecting untrusted request identifiers', () => {
  const cause = Object.assign(new Error('D1_ERROR: internal error'), {
    request_id: 'db-request-456',
    ray_id: 'aabbccdd-KUL',
  })
  const error = Object.assign(new Error('Product could not be loaded', { cause }), {
    statusCode: 500,
    requestId: '/private?token=identifier-secret',
  })

  const chain = errorChainForTelemetry(error)

  assert.equal(chain[0]!.status, 500)
  assert.equal(chain[0]!.request_id, undefined)
  assert.equal(chain[1]!.message, 'D1_ERROR: internal error')
  assert.equal(chain[1]!.request_id, 'db-request-456')
  assert.equal(chain[1]!.ray_id, 'aabbccdd-KUL')
  assert.doesNotMatch(JSON.stringify(chain), /identifier-secret/)
})

test('empty rejection reasons are represented and oversized cyclic error chains stay bounded', () => {
  const error = Object.assign(new Error('Failure '.repeat(1000)), {
    name: 'Error'.repeat(100),
    code: 'DATABASE_FAILURE'.repeat(100),
    stack: 'at public detail\n'.repeat(1000),
    cause: undefined as unknown,
  })
  let tail: Error & { cause?: unknown } = error
  for (let index = 0; index < 20; index++) {
    const cause = new Error(`Cause ${index}`) as Error & { cause?: unknown }
    tail.cause = cause
    tail = cause
  }
  tail.cause = error

  const chain = errorChainForTelemetry(error)

  assert.equal(chain.length, 4)
  assert.ok(chain[0]!.name.length <= 100)
  assert.ok(chain[0]!.message.length <= 1000)
  assert.ok(chain[0]!.code!.length <= 100)
  assert.ok(chain[0]!.stack!.length <= 4000)
  assert.match(chain[0]!.message, /\[truncated\]$/)
  assert.match(chain[0]!.stack!, /\[truncated\]$/)
  const selfCause = new Error('Self cause')
  selfCause.cause = selfCause
  assert.deepEqual(errorChainForTelemetry(selfCause).map(entry => entry.message), ['Self cause'])
  assert.equal(redactErrorText('Short failure', 1000), 'Short failure')
  assert.deepEqual(errorChainForTelemetry(undefined), [{ name: 'undefined', message: 'undefined' }])
  assert.deepEqual(errorChainForTelemetry(null), [{ name: 'object', message: 'null' }])
})

test('browser reports fit the collector byte limit for quoted Unicode causes without losing failure correlation', () => {
  let error: Error | undefined
  for (let index = 3; index >= 0; index--) {
    error = Object.assign(new Error(`Unicode failure ${index} ${'ข้อมูล😀"\\\n\r\t\u0001'.repeat(1000)}`, { cause: error }), {
      name: `UnicodeFailure${index}`,
      code: `UNICODE_FAILURE_${index}`,
      statusCode: 500,
      requestId: `unicode-request-${index}`,
      ray_id: `unicode-ray-${index}`,
    })
  }

  const body = serializeBrowserErrorReport({
    event_id: 'unicode-report-event',
    source: 'unhandled_rejection',
    page_path: '/experiences',
    error_chain: errorChainForTelemetry(error),
  })
  const report = JSON.parse(body)

  assert.ok(new TextEncoder().encode(body).byteLength <= BROWSER_ERROR_LIMITS.bodyBytes)
  assert.equal(report.error_chain.length, 4)
  for (const [index, entry] of report.error_chain.entries()) {
    assert.equal(entry.name, `UnicodeFailure${index}`)
    assert.equal(entry.code, `UNICODE_FAILURE_${index}`)
    assert.equal(entry.status, 500)
    assert.equal(entry.request_id, `unicode-request-${index}`)
    assert.equal(entry.ray_id, `unicode-ray-${index}`)
    assert.match(entry.message, new RegExp(`^Unicode failure ${index} `))
    assert.match(entry.message, /\[truncated\]$/)
    assert.match(entry.stack, /\[truncated\]$/)
  }
})
