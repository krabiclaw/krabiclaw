import { refreshWorkingWindows } from '~/server/domain/member-scheduling'
import type { CloudflareEnv } from '~/server/utils/auth'
import { queryAll } from '~/server/db'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { materializeSessions, PUBLIC_BOOKING_WINDOW_DAYS, type MaterializeSessionsResult } from '~/server/utils/availability'
import { addLocalDays, localDateAt } from '~/utils/timezone'

/**
 * Keep the booking calendar full.
 *
 * A rule is a repeating intention; a session is the occurrence a guest claims a
 * seat on. Only a person pressing "generate" in the CMS ever materialized them,
 * so a product's calendar ran dry as the generated horizon passed — and after a
 * transferred database export, which carries rules but materializes nothing, every
 * bookable product read "no sessions scheduled" until someone noticed.
 *
 * Generation is idempotent: it inserts the occurrences the rules name inside
 * the public booking window and leaves the rest alone. A bounded page per run,
 * with the cursor in KV, keeps one tenant's catalogue from starving another's.
 *
 * Every edit to a product's times materializes its whole window as it is
 * written, so this run only carries the window's far edge forward as each
 * local day begins and fills what an import left out. It runs hourly: a page
 * of 50 reaches 1,200 products a day, and the edge moves once a day.
 */
const PRODUCTS_PER_RUN = 50
const CURSOR_KEY = 'sessions-materialize:cursor'

interface BookableProduct {
  product_id: string
  organization_id: string
}

export default defineScheduledTask({
  meta: { name: 'sessions-materialize', description: 'Materialize booking sessions inside the public window' },
  async run({ context }) {
    const env = (context as { cloudflare?: { env?: CloudflareEnv } } | undefined)?.cloudflare?.env
    if (!env?.DB || !env.ORGANIZATION_CACHE) throw new Error('DB and ORGANIZATION_CACHE are required')
    await refreshWorkingWindows(env.DB)
    const after = await env.ORGANIZATION_CACHE.get(CURSOR_KEY)
    const products = await queryAll<BookableProduct>(env.DB, `
      SELECT product_id, organization_id FROM product_booking_configs
       WHERE product_id > ? ORDER BY product_id LIMIT ?
    `, [after ?? '', PRODUCTS_PER_RUN + 1])

    // The window the public page asks for, in UTC calendar days: each rule
    // clamps this to its own local calendar and to the generator's own ceiling.
    const through = addLocalDays(localDateAt(new Date(), 'UTC'), PUBLIC_BOOKING_WINDOW_DAYS)
    let created = 0
    let existing = 0
    const skipped: MaterializeSessionsResult['skipped'] = []
    const failures: Array<{ product_id: string; error: string }> = []

    for (const product of products.slice(0, PRODUCTS_PER_RUN)) {
      try {
        const result = await materializeSessions(env.DB, {
          organizationId: product.organization_id, productId: product.product_id,
          throughDate: through, actorId: 'system',
        })
        created += result.created
        existing += result.existing
        skipped.push(...result.skipped)
      } catch (error) {
        // One product's broken rule — an invalid timezone, a cadence with no
        // anchor — does not stop the others from being generated.
        failures.push({ product_id: product.product_id, error: error instanceof Error ? error.message : String(error) })
      }
      await env.ORGANIZATION_CACHE.put(CURSOR_KEY, product.product_id)
    }

    const hasMore = products.length > PRODUCTS_PER_RUN
    if (!hasMore) await env.ORGANIZATION_CACHE.delete(CURSOR_KEY)
    return { result: { products: Math.min(products.length, PRODUCTS_PER_RUN), created, existing, skipped, failures, hasMore, through } }
  },
})
