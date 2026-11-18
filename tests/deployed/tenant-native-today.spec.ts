import { expect, test } from '@playwright/test'
import { z } from 'zod'

const text = z.string()
const nullableText = text.nullable()
const assignee = z.object({ type: z.literal('member'), id: text, name: text, initial: text, you: z.boolean() })
const feed = z.object({ assignees: z.array(assignee), resolved_at: text })

// TodayWork in App Store build 39 (iOS commit d0d572b148e3c18f28b8e0422873ed85b3e88644).
const website = z.object({
  address: text, preview_url: text, preview_label: text, status_label: text,
  action: z.object({ label: text, to: text, type: z.enum(['publish', 'visit']) }),
})
const side = z.object({ label: text, time: text, guest: nullableText })
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('complete'), label: text }),
  z.object({ type: z.literal('open'), label: text, path: text }),
  z.object({ type: z.literal('reopen'), label: text }),
])
const task = z.object({
  id: text, kind: text, status: z.enum(['open', 'done', 'skipped', 'cancelled']), version: z.number().int(),
  face: z.enum(['photo', 'compact']), title: text,
  tag: nullableText, image_url: nullableText, status_line: nullableText, when: nullableText,
  detail: nullableText, error: nullableText, note: nullableText, notes: nullableText, booking_id: nullableText,
  avatar: z.object({ initial: text, tone: z.enum(['warm', 'cool']) }).nullable(),
  person: assignee.nullable(), assignee: assignee.nullable(), action: action.nullable(),
  sheet: z.object({ heading: text, title: text, date: nullableText, checkout: side.nullable(), checkin: side.nullable() }),
  outcome: z.object({
    note: nullableText, photos: z.array(z.object({ id: text, url: text, thumbnail_url: text })),
    closed_at: text, closed_by: nullableText,
  }).nullable(),
  can: z.object({ complete: z.boolean(), skip: z.boolean(), reopen: z.boolean(), assign: z.boolean(), edit: z.boolean() }),
  dismiss: z.object({ label: text }).nullish(),
})
const shipped = feed.extend({
  website: website.nullable(),
  tasks: z.array(z.object({ id: text, title: nullableText, subtitle: nullableText, tasks: z.array(task) })),
  opportunities: z.array(z.object({ id: text, status_line: text, title: text, detail: text, path: text })),
  opportunity_issues: z.array(text),
})

// BusinessToday in TestFlight build 44 (iOS commit 3eb33e5c387ac1df13f95cad2f95b4f19a09b56a).
const candidate = feed.extend({
  title: text,
  cards: z.array(z.object({
    id: text, when: nullableText, image_url: nullableText, headline: text, line: nullableText,
    icon: z.enum(['i-lucide-house', 'i-lucide-ticket', 'i-lucide-scale', 'i-lucide-utensils',
      'i-lucide-calendar-check', 'i-lucide-list-checks', 'i-lucide-credit-card']),
    action: z.object({ title: text, detail: text }), to: nullableText, draft: nullableText,
    done: z.object({ path: text }).nullable(),
    claim: z.object({ path: text, version: z.number().int(), label: text }).nullish(),
  })),
  claim_options: z.object({
    roles: z.array(z.object({ value: text, label: text })),
    listings: z.array(z.object({ listing_id: text, label: text })),
  }).nullish(),
})

test('native Today and Upcoming support the shipped and candidate iOS builds', async ({ baseURL }) => {
  if (!baseURL) throw new Error('Set PLAYWRIGHT_PREVIEW_URL for the deployed environment')
  const origin = new URL(baseURL).hostname === 'blawby.com' ? 'https://krabiclaw.com' : new URL(baseURL).origin
  const email = process.env.CANARY_LOGIN_EMAIL
  const password = process.env.CANARY_LOGIN_PASSWORD
  if (!email || !password) throw new Error('Configure the deployed canary login')

  // Native clients take the token from the sign-in response and send no browser cookies.
  const signIn = await fetch(new URL('/api/auth/sign-in/email', origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: origin },
    body: JSON.stringify({ email, password, rememberMe: false }), redirect: 'error', signal: AbortSignal.timeout(12_000),
  })
  expect(signIn.status, 'Native canary sign-in').toBe(200)
  const token = signIn.headers.get('set-auth-token')
  if (!token) throw new Error('Better Auth did not issue a native bearer token')

  await Promise.all(['today', 'upcoming'].map(async (range) => {
    const url = new URL('/api/dashboard/today', origin)
    url.search = new URLSearchParams({ org: 'saltleaf-stays-demo', range }).toString()
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(12_000),
    })
    expect(response.status, `Native ${range} response`).toBe(200)
    const body: unknown = await response.json()
    for (const [build, schema] of [[39, shipped], [44, candidate]] as const) {
      const result = schema.safeParse(body)
      const invalidFields = result.success ? [] : result.error.issues.map(issue => issue.path.join('.') || '(response)')
      expect.soft(invalidFields, `iOS build ${build} cannot decode ${range}`).toEqual([])
    }
  }))
})
