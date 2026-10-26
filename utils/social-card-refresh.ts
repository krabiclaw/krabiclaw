export type SocialCardRefreshKind = 'generated' | 'reused' | 'skipped' | 'failed'

export interface SocialCardRefreshSummary {
  generated: number
  reused: number
  skipped: number
  failed: number
  total: number
}

export interface SocialCardRefreshNotice {
  message: string
  color: 'success' | 'warning' | 'error'
}

export interface SocialCardRegenerationResponse {
  summary: SocialCardRefreshSummary
  next_cursor: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function summarizeSocialCardRefreshResults(
  results: readonly { kind: SocialCardRefreshKind }[],
): SocialCardRefreshSummary {
  const summary: SocialCardRefreshSummary = {
    generated: 0,
    reused: 0,
    skipped: 0,
    failed: 0,
    total: results.length,
  }
  for (const result of results) summary[result.kind] += 1
  return summary
}

export function isSocialCardRefreshSummary(value: unknown): value is SocialCardRefreshSummary {
  if (!isRecord(value)) return false
  const isCount = (count: unknown): count is number => typeof count === 'number' && Number.isInteger(count) && count >= 0
  if (!isCount(value.generated)
    || !isCount(value.reused)
    || !isCount(value.skipped)
    || !isCount(value.failed)
    || !isCount(value.total)) return false
  return value.total === value.generated + value.reused + value.skipped + value.failed
}

export function isSocialCardRegenerationResponse(value: unknown): value is SocialCardRegenerationResponse {
  return isRecord(value) && isSocialCardRefreshSummary(value.summary) && (value.next_cursor === null || typeof value.next_cursor === 'string')
}

export function socialCardRefreshNotice(summary: SocialCardRefreshSummary): SocialCardRefreshNotice {
  const completed = summary.generated + summary.reused
  const detail = `${summary.generated} generated, ${summary.reused} reused, ${summary.skipped} skipped`
  if (summary.failed === 0 && summary.skipped === 0) {
    return { message: `Social cards regenerated: ${detail}.`, color: 'success' }
  }
  if (completed === 0 && summary.failed > 0) {
    return { message: `Social card regeneration failed: ${summary.failed} failed, ${summary.skipped} skipped.`, color: 'error' }
  }
  return {
    message: `Social cards partially regenerated: ${completed} completed, ${summary.failed} failed, ${summary.skipped} skipped.`,
    color: 'warning',
  }
}
