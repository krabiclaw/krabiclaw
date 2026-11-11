import { executeBatch, queryAll, type BatchQuery, type DbClient } from '~/server/db'

/**
 * Moves everything an anonymous guest identity holds onto a named account:
 * the one move both Better Auth's anonymous link (same browser) and the
 * verified-email link below perform.
 */
export function anonymousLinkQueries(from: string, to: string, now: string): BatchQuery[] {
  return [
    // An opt-out on either identity survives the merge.
    {
      query: `INSERT INTO user_notification_preferences (user_id, category, email_enabled, whatsapp_enabled, push_enabled, updated_at)
        SELECT ?, category, email_enabled, whatsapp_enabled, push_enabled, ? FROM user_notification_preferences WHERE user_id = ?
        ON CONFLICT (user_id, category) DO UPDATE SET
          email_enabled = user_notification_preferences.email_enabled AND excluded.email_enabled,
          whatsapp_enabled = user_notification_preferences.whatsapp_enabled AND excluded.whatsapp_enabled,
          push_enabled = user_notification_preferences.push_enabled AND excluded.push_enabled,
          updated_at = excluded.updated_at`,
      params: [to, now, from],
    },
    { query: 'DELETE FROM user_notification_preferences WHERE user_id = ?', params: [from] },
    // Re-pointing who a record belongs to is not activity on it, so
    // updated_at — the version booking changes compare against — stays.
    ...['conversations', 'bookings', 'review_requests', 'reviews'].map(table => ({
      query: `UPDATE ${table} SET user_id = ? WHERE user_id = ?`,
      params: [to, from],
    })),
    ...['payments', 'payment_orders', 'payment_checkout_holds'].map(table => ({
      query: `UPDATE ${table} SET buyer_user_id = ? WHERE buyer_user_id = ?`,
      params: [to, from],
    })),
    { query: 'UPDATE payments SET claimed_user_id = ? WHERE claimed_user_id = ?', params: [to, from] },
    // What the guest wrote is the account's, and so is how far they read: where
    // both identities read one conversation, the account keeps its own position.
    { query: 'UPDATE messages SET author_user_id = ? WHERE author_user_id = ?', params: [to, from] },
    { query: 'UPDATE OR IGNORE conversation_participants SET user_id = ? WHERE user_id = ?', params: [to, from] },
    { query: 'DELETE FROM conversation_participants WHERE user_id = ?', params: [from] },
    { query: 'UPDATE media_assets SET created_by_user_id = ? WHERE created_by_user_id = ?', params: [to, from] },
  ]
}

/**
 * A guest books on a business's own site, on its host, as an anonymous user;
 * the account lives on the platform. Whoever controls a verified inbox already
 * received every confirmation and manage link sent to it, so the anonymous
 * identities whose requests were all made with that email join the account
 * signed in with it. One that used other emails too (a shared device) is
 * nobody's in particular and stays where it is. The identity itself stays too:
 * its cookie still names it on that business's site, and what it books next
 * joins the account at the next sign-in.
 */
export async function linkGuestIdentitiesByVerifiedEmail(db: DbClient, user: { id: string; email: string; emailVerified: boolean; isAnonymous?: boolean | null }): Promise<void> {
  if (!user.emailVerified || user.isAnonymous) return
  const identities = await queryAll<{ user_id: string }>(db, `
    SELECT DISTINCT r.user_id FROM conversations r JOIN user u ON u.id = r.user_id AND u."isAnonymous" = 1
    WHERE lower(r.payload_json ->> '$.guest.email') = lower(?)
      AND NOT EXISTS (SELECT 1 FROM conversations other WHERE other.user_id = r.user_id AND lower(other.payload_json ->> '$.guest.email') IS NOT lower(?))`,
  [user.email, user.email])
  const now = new Date().toISOString()
  for (const { user_id: from } of identities) await executeBatch(db, anonymousLinkQueries(from, user.id, now), { operation: 'verified-email-guest-link' })
}
