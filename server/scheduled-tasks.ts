import type { TaskEvent } from 'nitro/types'

type ScheduledTaskEnvironment = ApiRecord

interface ScheduledTaskDefinition {
  run(_event: TaskEvent): Promise<unknown> | unknown
}

export type ScheduledTaskName =
  | 'google-calendar-sync'
  | 'public-resource-cache-invalidation'
  | 'domain-reconciliation'
  | 'zaraz-analytics-reconciliation'
  | 'domain-reconciliation-daily'
  | 'analytics-aggregate-daily'
  | 'google-places-sync'
  | 'review-request-automation'
  | 'social-card-backfill'
  | 'social-card-cleanup'
  | 'sessions-materialize'
  | 'stripe-ga4-intent-retention'
  | 'article-broadcast-send'
  | 'stripe-fee-report-request'
  | 'marketing-ad-spend-daily'
  | 'channex-revision-feed'
  | 'scheduled-guest-messages'
  | 'stay-checkout-holds'

type TaskLoader = () => Promise<{ default: ScheduledTaskDefinition }>

/** The single source of truth for cron-to-task dispatch in Nitro's scheduled hook. */
export const SCHEDULED_TASKS: Readonly<Record<string, readonly ScheduledTaskName[]>> = {
  '*/5 * * * *': ['google-calendar-sync', 'social-card-backfill', 'article-broadcast-send', 'scheduled-guest-messages', 'stay-checkout-holds'],
  '*/2 * * * *': ['public-resource-cache-invalidation'],
  '*/10 * * * *': ['domain-reconciliation', 'zaraz-analytics-reconciliation', 'channex-revision-feed'],
  '0 3 * * *': ['domain-reconciliation-daily', 'analytics-aggregate-daily', 'stripe-ga4-intent-retention', 'stripe-fee-report-request', 'marketing-ad-spend-daily'],
  '0 0 * * SUN': ['google-places-sync'],
  '0 * * * *': ['review-request-automation', 'social-card-cleanup', 'sessions-materialize'],
}

const TASK_LOADERS: Readonly<Record<ScheduledTaskName, TaskLoader>> = {
  'google-calendar-sync': async () => import('./tasks/google-calendar-sync'),
  'channex-revision-feed': async () => import('./tasks/channex-revision-feed'),
  'scheduled-guest-messages': async () => import('./tasks/scheduled-guest-messages'),
  'stay-checkout-holds': async () => import('./tasks/stay-checkout-holds'),
  'social-card-backfill': async () => import('./tasks/social-card-backfill'),
  'social-card-cleanup': async () => import('./tasks/social-card-cleanup'),
  'public-resource-cache-invalidation': async () => import('./tasks/public-resource-cache-invalidation'),
  'domain-reconciliation': async () => import('./tasks/domain-reconciliation'),
  'zaraz-analytics-reconciliation': async () => import('./tasks/zaraz-analytics-reconciliation'),
  'domain-reconciliation-daily': async () => import('./tasks/domain-reconciliation-daily'),
  'analytics-aggregate-daily': async () => import('./tasks/analytics-aggregate-daily'),
  'stripe-ga4-intent-retention': async () => import('./tasks/stripe-ga4-intent-retention'),
  'sessions-materialize': async () => import('./tasks/sessions-materialize'),
  'google-places-sync': async () => import('./tasks/google-places-sync'),
  'review-request-automation': async () => import('./tasks/review-request-automation'),
  'stripe-fee-report-request': async () => import('./tasks/stripe-fee-report-request'),
  'article-broadcast-send': async () => import('./tasks/article-broadcast-send'),
  'marketing-ad-spend-daily': async () => import('./tasks/marketing-ad-spend-daily'),
}

export function getScheduledTaskNames(cron: string): readonly ScheduledTaskName[] {
  return SCHEDULED_TASKS[cron] ?? []
}

export interface ScheduledTaskRunOptions {
  loadTask?: (_name: ScheduledTaskName) => Promise<ScheduledTaskDefinition>
  scheduledTime?: number
}

/**
 * Execute all jobs mapped to a Cloudflare cron expression.
 *
 * Each job is isolated so one failing integration does not prevent its peers
 * from running while the native Cloudflare scheduled hook remains the only
 * Worker event entrypoint. Once all have run, any failure fails the invocation,
 * so Cloudflare records the cron run as failed rather than a log line nobody
 * reads being the only trace of it.
 */
export async function runScheduledTasks(
  cron: string,
  env: ScheduledTaskEnvironment,
  options: ScheduledTaskRunOptions = {},
): Promise<void> {
  const names = getScheduledTaskNames(cron)
  const loadTask = options.loadTask ?? (async (name: ScheduledTaskName) => (await TASK_LOADERS[name]()).default)
  const scheduledTime = options.scheduledTime ?? Date.now()

  const outcomes = await Promise.allSettled(names.map(async (name) => {
    const task = await loadTask(name)
    return await task.run({
      name,
      payload: { scheduledTime },
      context: { cloudflare: { env } },
    })
  }))
  const failures = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      const value = outcome.value
      if (typeof value === 'object' && value !== null && 'result' in value) {
        const result = value.result
        if (typeof result === 'object' && result !== null && 'skipped' in result && typeof result.skipped === 'string') {
          console.info('[scheduled-task-skip]', { task: names[index], skipped: result.skipped })
        }
      }
      return []
    }
    return [new Error(`Scheduled task "${names[index]}" failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`, { cause: outcome.reason })]
  })
  if (failures.length) throw new AggregateError(failures, `${failures.length} of ${names.length} scheduled tasks failed for "${cron}": ${failures.map(error => error.message).join('; ')}`)
}
