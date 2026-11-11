import { execute, queryAll, type BatchQuery, type DbClient } from '~/server/db'

export type UsageResource =
  | 'mcp_operation'
  | 'scheduled_task'
  | 'maps_api'
  | 'messaging'
  | 'suggested_replies'

export interface UsageEventInput {
  organizationId: string
  resource: UsageResource | string
  source: string
  provider?: string | null
  channel?: string | null
  sessionId?: string | null
  quantity: number
  unit: string
  metadata?: Record<string, unknown> | null
  idempotencyKey: string
  createdAt?: string
}

const MAX_SAFE_INTEGER_SQL = String(Number.MAX_SAFE_INTEGER)

export function parseLedgerQuantity(value: unknown, label = 'Ledger quantity'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`)
  }
  return value
}

/** A recorded quantity, optionally queued for delivery to a Stripe meter in the same batch as its source write. */
export function usageEventInsert(input: UsageEventInput, meter?: {
  paymentId?: string | null; billingBasis?: unknown; occurredAt: string
}, guard?: BatchQuery): BatchQuery {
  if (meter) {
    if (!Number.isSafeInteger(input.quantity)) throw new Error('Stripe meter usage must be in whole currency minor units')
  } else parseLedgerQuantity(input.quantity, 'Usage quantity')
  if (!input.organizationId || !input.source || !input.resource || !input.unit || !input.idempotencyKey) {
    throw new Error('Usage events require organization, resource, source, unit, and idempotency key.')
  }
  return {
    query: `INSERT INTO usage_events
      (id, organization_id, resource, source, provider, channel, session_id, quantity, unit, metadata_json, idempotency_key, created_at,
       payment_id, billing_basis_json, provider_occurred_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard ? `EXISTS (${guard.query})` : 'true'}
      ON CONFLICT DO NOTHING`,
    params: [
      crypto.randomUUID(), input.organizationId, input.resource, input.source, input.provider ?? null, input.channel ?? null,
      input.sessionId ?? null, input.quantity, input.unit, input.metadata ? JSON.stringify(input.metadata) : null,
      input.idempotencyKey, input.createdAt ?? new Date().toISOString(), meter?.paymentId ?? null,
      meter?.billingBasis == null ? null : JSON.stringify(meter.billingBasis), meter?.occurredAt ?? null,
      ...(guard?.params ?? []),
    ],
  }
}

export async function recordUsageEvent(db: DbClient, input: UsageEventInput): Promise<boolean> {
  const write = usageEventInsert(input)
  return (await execute(db, write.query, write.params)).meta.changes === 1
}

export interface UsageSummaryRow {
  resource: string
  source: string
  provider: string | null
  channel: string | null
  quantity: number
  unit: string
  events: number
}

interface UsageSummaryAggregateRow extends UsageSummaryRow {
  invalid_count: number
}

export async function getUsageSummary(
  db: DbClient,
  organizationId: string,
  since?: string,
): Promise<UsageSummaryRow[]> {
  const rows = await queryAll<UsageSummaryAggregateRow>(db, `
    SELECT resource, source, provider, channel,
           TOTAL(CASE
             WHEN typeof(quantity) = 'integer'
               AND quantity >= 0
               AND quantity <= ${MAX_SAFE_INTEGER_SQL}
             THEN quantity ELSE 0 END) AS quantity,
           SUM(CASE
             WHEN typeof(quantity) = 'integer'
               AND quantity >= 0
               AND quantity <= ${MAX_SAFE_INTEGER_SQL}
             THEN 0 ELSE 1 END) AS invalid_count,
           unit, COUNT(*) AS events
    FROM usage_events
    WHERE organization_id = ? AND provider_occurred_at IS NULL ${since ? 'AND created_at >= ?' : ''}
    GROUP BY resource, source, provider, channel, unit
    ORDER BY quantity DESC, resource ASC
  `, since ? [organizationId, since] : [organizationId])
  return rows.map(({ invalid_count: invalidCountValue, ...row }) => {
    const invalidCount = parseLedgerQuantity(invalidCountValue, 'Usage summary invalid row count')
    if (invalidCount > 0) {
      throw new Error('Usage summary contains malformed ledger quantities.')
    }
    return {
      ...row,
      quantity: parseLedgerQuantity(row.quantity, 'Usage summary quantity'),
      events: parseLedgerQuantity(row.events, 'Usage summary event count'),
    }
  })
}
