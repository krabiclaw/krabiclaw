import { Resend, type Response as ResendResponse } from 'resend'

export interface ResendEnv {
  RESEND_API_KEY?: string
}

/**
 * The one Resend client. Every Resend API operation in the repository goes
 * through the official SDK built here; a hand-written request to
 * api.resend.com is a second client with its own idea of errors and headers.
 */
export function getResendClient(env: ResendEnv): Resend {
  const apiKey = env.RESEND_API_KEY?.trim()
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured')
  return new Resend(apiKey)
}

const RATE_LIMIT_ATTEMPTS = 5

/**
 * The data of one SDK call, or a thrown error naming the operation.
 *
 * The SDK returns failures instead of throwing them, so a caller that reads
 * `data` without looking at `error` treats a rejected request as an empty
 * success. A 429 is waited out for the `retry-after` the response names and
 * attempted again; after RATE_LIMIT_ATTEMPTS the rate limit is the error.
 *
 * `not_found` resolves to null only when the caller says a missing resource is
 * an answer (a Contact that does not exist yet), never otherwise.
 */
export async function resendData<T>(
  operation: string,
  call: () => Promise<ResendResponse<T>>,
  options: { notFound: 'null' },
): Promise<T | null>
export async function resendData<T>(operation: string, call: () => Promise<ResendResponse<T>>): Promise<T>
export async function resendData<T>(
  operation: string,
  call: () => Promise<ResendResponse<T>>,
  options?: { notFound: 'null' },
): Promise<T | null> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await call()
    if (!result.error) return result.data
    if (result.error.name === 'not_found' && options?.notFound === 'null') return null
    if (result.error.name === 'rate_limit_exceeded' && attempt < RATE_LIMIT_ATTEMPTS) {
      const retryAfterSeconds = Number(result.headers?.['retry-after'] ?? 1)
      await new Promise(resolve => setTimeout(resolve, Math.max(1, retryAfterSeconds) * 1000))
      continue
    }
    throw new Error(`Resend ${operation} failed (${result.error.statusCode ?? 'no response'} ${result.error.name}): ${result.error.message}`)
  }
}
