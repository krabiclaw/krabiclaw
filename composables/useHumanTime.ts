import { onMounted, onUnmounted, readonly } from 'vue'
import { formatTimestamp, instantDate } from '~/utils/timezone'

let timer: ReturnType<typeof setInterval> | undefined
let subscribers = 0

// Serialized per request; the first browser render shares the server's reference.
export function useHumanTime() {
  const { locale, t } = useI18n()
  const now = useState('human-time-reference', () => Date.now())
  onMounted(() => { subscribers += 1; if (!timer) timer = setInterval(() => { now.value = Date.now() }, 30_000) })
  onUnmounted(() => { subscribers -= 1; if (!subscribers && timer) { clearInterval(timer); timer = undefined } })
  const formatRelativeTime = (value: string | Date | null | undefined) => {
    if (value === null || value === undefined || value === '') return t('dates.time_unavailable')
    const seconds = (instantDate(value).getTime() - now.value) / 1000
    const unit: Intl.RelativeTimeFormatUnit = Math.abs(seconds) < 60 ? 'second' : Math.abs(seconds) < 3600 ? 'minute' : Math.abs(seconds) < 86400 ? 'hour' : 'day'
    const divisor = unit === 'second' ? 1 : unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400
    return new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }).format(Math.trunc(seconds / divisor), unit)
  }
  const formatExactDateTime = (value: string | Date | null | undefined, options: { includeTime?: boolean } = {}) => {
    if (value === null || value === undefined || value === '') return t('dates.date_unavailable')
    return formatTimestamp(value, locale.value, 'UTC', options.includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }) + (options.includeTime ? ' UTC' : '')
  }
  return { now: readonly(now), formatRelativeTime, formatExactDateTime }
}
