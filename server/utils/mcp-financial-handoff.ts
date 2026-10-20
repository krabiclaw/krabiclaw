import { mcpErrorRecoveryDetails } from '~/server/utils/mcp-protocol'

/** Preserve only known authenticated dashboard destinations and explicit incomplete financial state. */
export function mcpFinancialApprovalErrorResult(error: unknown, platformOrigin: string | undefined, message: string) {
  if (!error || typeof error !== 'object' || !('statusCode' in error) || ![403, 409, 503].includes(Number(error.statusCode))
    || !('data' in error) || !error.data || typeof error.data !== 'object') return null
  const approvalPath = 'financial_approval_url' in error.data ? error.data.financial_approval_url : null
  const dashboardPath = 'code' in error.data && error.data.code === 'financial_action_required' && 'dashboard_url' in error.data ? error.data.dashboard_url : null
  const approval = typeof approvalPath === 'string' && /^\/dashboard\/[^/?#]+\/earnings\/refunds\/approve\?id=[a-f0-9-]{36}$/iu.test(approvalPath)
  const dashboard = typeof dashboardPath === 'string' && /^\/dashboard\/[^/?#]+\/(?:payments|bookings\/booking\/[^/?#]+|products\/[^/?#]+\/booking)$/u.test(dashboardPath)
  const path = dashboard ? dashboardPath : approval ? approvalPath : null
  if (typeof path !== 'string') return null
  let url: URL
  try { url = new URL(path, platformOrigin) } catch { return null }
  if (!['https:', 'http:'].includes(url.protocol)) return null
  const action = {
    ...mcpErrorRecoveryDetails(error.data),
    status: Number(error.statusCode), message,
    success: false, operation_completed: false, action_required: true,
    code: dashboard ? 'financial_action_required' : 'financial_approval_required', dashboard_url: url.toString(),
    ...(approval ? { confirmation_required: true, financial_approval_url: url.toString() } : {}),
  }
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(action) }] }
}
