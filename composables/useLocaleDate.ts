import { CALENDAR_DATE_PATTERN, formatCalendarDate, formatTimestamp } from '~/utils/timezone'

// Public publication/review dates use UTC; civil dates retain their authored day.
export function useLocaleDate() {
  const { locale, t } = useI18n()
  const formatDate = (value: string | number | Date | null | undefined) => {
    if (value === null || value === undefined || value === '') return t('dates.date_unavailable')
    if (typeof value === 'string' && CALENDAR_DATE_PATTERN.test(value)) return formatCalendarDate(value, locale.value)
    return formatTimestamp(typeof value === 'number' ? new Date(value) : value, locale.value, 'UTC', { dateStyle: 'medium' })
  }
  return { formatDate }
}
