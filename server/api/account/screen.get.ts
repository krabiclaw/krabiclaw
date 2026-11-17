import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { accountRows, describeDevice, paymentAmountLabel, paymentHeadline, paymentWhenLabel, paymentYearLabel, type AccountRowId } from '~/shared/account-screen'
import type { CatalogScreen } from '~/shared/catalog-screen'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createAuth, getAuthSession } from '~/server/utils/auth'
import { formatTimestamp } from '~/utils/timezone'
import { queryFirst } from '~/server/db'
import { getNotificationPreferences } from '~/server/domain/notification-preferences'
import { buyerPayments } from '~/server/domain/payments/buyer'

/** Where each Account settings row opens in the iPhone app. */
const NATIVE: Record<AccountRowId, string> = {
  personal: 'account-personal',
  login: 'account-login',
  notifications: 'account-notifications',
  calendar: 'account-profile',
  appearance: 'account-appearance',
  payments: 'account-payments',
  organizations: 'account-organizations',
  'log-out': 'sign-out',
}

/**
 * GET /api/account/screen?view=account|account-payments|account-devices — the signed-in
 * account's Account settings for the iPhone app, in the catalog screen shape
 * it already draws. It needs no organization: setup opens it before one exists.
 */
export default defineHandler(async event => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) throw new HTTPError({ statusCode: 401, message: 'Sign in to view your account', data: { code: 'AUTHENTICATION_REQUIRED' } })
  const view = getQuery(event).view
  const userId = session.user.id
  let screen: CatalogScreen
  if (view === 'account') {
    const [preferences, membership] = await Promise.all([
      getNotificationPreferences(env.DB, userId),
      queryFirst<{ count: number }>(env.DB, 'SELECT COUNT(*) AS count FROM member WHERE userId = ?', [userId]),
    ])
    if (!membership) throw new HTTPError({ statusCode: 500, message: 'Your organizations could not be counted' })
    const user = session.user as typeof session.user & { phoneNumber?: string | null }
    screen = {
      title: 'Account settings',
      fields: [],
      rows: accountRows({
        name: user.name || null,
        phoneNumber: user.phoneNumber ?? null,
        email: user.email,
        notifications: Object.values(preferences),
        organizations: membership.count,
      }).map(row => ({ ...row, native: NATIVE[row.id] })),
    }
  } else if (view === 'account-payments') {
    const { entries } = await buyerPayments(env.DB, userId)
    const groups = [...new Set(entries.map(entry => paymentYearLabel(entry)))]
    screen = {
      title: 'Payments',
      fields: [],
      empty_title: 'No payments yet',
      groups: groups.map(label => ({ id: label, label })),
      rows: entries.map(entry => ({
        id: entry.id,
        label: paymentHeadline(entry),
        summary: [entry.organization_name, paymentWhenLabel(entry), paymentAmountLabel(entry)].filter(Boolean).join('\n'),
        image: entry.image_url,
        group: paymentYearLabel(entry),
      })),
    }
  } else if (view === 'account-devices') {
    // Device history: every session Better Auth holds for this account, this one first. The
    // others carry their token so the app can log that device out.
    const timezone = getQuery(event).timezone
    if (typeof timezone !== 'string' || !timezone) throw new HTTPError({ statusCode: 400, message: 'Name the timezone to show times in', data: { code: 'TIMEZONE_REQUIRED' } })
    const sessions = await createAuth(env).api.listSessions({ headers: event.req.headers })
    const current = session.session.token
    screen = {
      title: 'Device history',
      fields: [],
      rows: sessions
        .map(item => ({ ...item, current: item.token === current }))
        .sort((a, b) => Number(b.current) - Number(a.current) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .map(item => ({
          id: item.id,
          label: describeDevice(item.userAgent),
          summary: item.current ? 'Current session' : formatTimestamp(item.updatedAt, 'en', timezone),
          ...(item.current ? {} : { query: { token: item.token } }),
        })),
    }
  } else {
    throw new HTTPError({ statusCode: 404, message: 'Account screen not found', data: { code: 'ACCOUNT_SCREEN_NOT_FOUND' } })
  }
  return jsonResponse(screen, { headers: { 'cache-control': 'private, no-store' } })
})
