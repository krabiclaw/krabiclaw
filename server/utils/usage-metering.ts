import { execute, queryAll, type DbClient } from '~/server/db'

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

export async function recordUsageEvent(db: DbClient, input: UsageEventInput): Promise<boolean> {
  parseLedgerQuantity(input.quantity, 'Usage quantity')
  if (!input.organizationId || !input.source || !input.resource || !input.unit || !input.idempotencyKey) {
    throw new Error('Usage events require organization, resource, source, unit, and idempotency key.')
  }

  const result = await execute(db, `
    INSERT OR IGNORE INTO usage_events
      (id, organization_id, resource, source, provider, channel,
       session_id, quantity, unit, metadata_json, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    crypto.randomUUID(),
    input.organizationId,
    input.resource,
    input.source,
    input.provider ?? null,
    input.channel ?? null,
    input.sessionId ?? null,
    input.quantity,
    input.unit,
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.idempotencyKey,
    input.createdAt ?? new Date().toISOString(),
  ])

  return Number(result?.meta.changes ?? 0) > 0
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
    WHERE organization_id = ? ${since ? 'AND created_at >= ?' : ''}
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
