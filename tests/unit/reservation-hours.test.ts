import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOpeningHours, parseSpecialHours, normalizeGoogleOpeningHours, getDateIntervals, isOpenNow, closeDates, openDates, closureOnDate } from '../../shared/reservation-hours.ts'

test('weekly hours retain close weekdays, Sunday rollover and exact 23:59 endpoints', () => {
  const hours = parseOpeningHours({ periods: [{ open: { day: 6, hour: 22, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } }] })
  assert.deepEqual(getDateIntervals(hours, null, '2099-01-04'), [{ start: -120, end: 120 }])
  assert.equal(isOpenNow(hours, 'Asia/Bangkok', new Date('2099-01-03T18:00:00Z')), true)
  const exact = normalizeGoogleOpeningHours([{ open: { day: 1, hour: 12 }, close: { day: 1, hour: 23, minute: 59 } }])
  assert.deepEqual(exact?.periods[0]?.close, { day: 1, hour: 23, minute: 59 })
})

test('unknown, explicitly closed, and always open remain distinct', () => {
  assert.equal(getDateIntervals(null, null, '2099-01-05'), null)
  assert.deepEqual(getDateIntervals({ periods: [] }, null, '2099-01-05'), [])
  const always = normalizeGoogleOpeningHours([{ open: { day: 0 } }])
  assert.deepEqual(getDateIntervals(always, null, '2099-01-05'), [{ start: 0, end: 2880 }])
  assert.equal(isOpenNow(null, 'Asia/Bangkok'), undefined)
  assert.equal(isOpenNow(always, null), undefined)
})

test('dated exceptions replace incoming overnight hours and closures have inclusive and indefinite bounds', () => {
  const hours = parseOpeningHours({ periods: [{ open: { day: 1, hour: 22, minute: 0 }, close: { day: 2, hour: 2, minute: 0 } }] })
  const closedTuesday = parseSpecialHours([{ kind: 'hours', date: '2099-01-06', periods: [], note: null }])
  assert.deepEqual(getDateIntervals(hours, closedTuesday, '2099-01-06'), [])
  assert.deepEqual(getDateIntervals(hours, closedTuesday, '2099-01-05'), [{ start: 1320, end: 1440 }])
  const indefinite = parseSpecialHours([{ kind: 'closure', starts_on: '2099-01-01', ends_on: null, note: null }])
  assert.deepEqual(getDateIntervals(hours, indefinite, '2100-01-01'), [])
  const dated = parseSpecialHours([{ kind: 'hours', date: '2099-01-05', periods: [{ open_time: '23:00', close_time: '03:00', close_day_offset: 1 }], note: null }])
  assert.deepEqual(getDateIntervals(hours, dated, '2099-01-06'), [{ start: -60, end: 180 }])
})

test('boundaries reject ambiguous hours instead of interpreting them', () => {
  for (const hours of ['Monday: 9-5', [], { weekdayDescriptions: ['Monday: 9-5'] }, { periods: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 9, minute: 0 } }] }]) assert.throws(() => parseOpeningHours(hours))
  assert.throws(() => parseOpeningHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }, { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 10, minute: 0 } }] }))
  assert.throws(() => parseSpecialHours([{ kind: 'closure', starts_on: '2099-02-30', ends_on: null, note: null }]))
})

test('overnight starts retain the opening minute and short closures do not erase later continuous days', () => {
  const hours = parseOpeningHours({ periods: [{ open: { day: 1, hour: 22, minute: 15 }, close: { day: 2, hour: 2, minute: 15 } }] })
  assert.deepEqual(getDateIntervals(hours, null, '2099-01-06'), [{ start: -105, end: 135 }])
  const continuous = parseOpeningHours({ periods: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 5, hour: 17, minute: 0 } }] })
  const closure = parseSpecialHours([{ kind: 'closure', starts_on: '2099-01-06', ends_on: '2099-01-06', note: null }])
  assert.deepEqual(getDateIntervals(continuous, closure, '2099-01-07'), [{ start: -2340, end: 3900 }])
})

test('closing dates adds one closure and opening them cuts every covering closure around the range', () => {
  const closed = closeDates(null, '2099-03-10', '2099-03-12')
  assert.deepEqual(closed, [{ kind: 'closure', starts_on: '2099-03-10', ends_on: '2099-03-12', note: null }])
  assert.equal(openDates(closed, '2099-03-10', '2099-03-12'), null)

  const noted = parseSpecialHours([{ kind: 'closure', starts_on: '2099-03-01', ends_on: '2099-03-31', note: 'Renovation' }])
  const reopened = openDates(noted, '2099-03-10', '2099-03-12')
  assert.deepEqual(reopened, [
    { kind: 'closure', starts_on: '2099-03-01', ends_on: '2099-03-09', note: 'Renovation' },
    { kind: 'closure', starts_on: '2099-03-13', ends_on: '2099-03-31', note: 'Renovation' },
  ])
  assert.equal(closureOnDate(reopened, '2099-03-11'), undefined)
  assert.equal(closureOnDate(reopened, '2099-03-09')?.note, 'Renovation')

  const indefinite = parseSpecialHours([{ kind: 'closure', starts_on: '2099-01-01', ends_on: null, note: null }])
  assert.deepEqual(openDates(indefinite, '2099-01-01', '2099-01-01'), [{ kind: 'closure', starts_on: '2099-01-02', ends_on: null, note: null }])

  const emptyDay = parseSpecialHours([{ kind: 'hours', date: '2099-03-11', periods: [], note: null }, { kind: 'hours', date: '2099-03-20', periods: [], note: null }, { kind: 'closure', starts_on: '2099-04-01', ends_on: '2099-04-02', note: null }])
  assert.deepEqual(openDates(emptyDay, '2099-03-10', '2099-03-12'), emptyDay!.slice(1))
  const untouched = parseSpecialHours([{ kind: 'hours', date: '2099-03-11', periods: [{ open_time: '18:00', close_time: '22:00', close_day_offset: 0 }], note: null }, { kind: 'closure', starts_on: '2099-04-01', ends_on: '2099-04-02', note: null }])
  assert.deepEqual(openDates(untouched, '2099-03-10', '2099-03-12'), untouched)
  assert.throws(() => closeDates(null, '2099-03-12', '2099-03-10'))

  // 2099-03-01 is a Sunday. Weekdays narrow the range: the Mondays and Tuesdays of two weeks are two closures, and opening the Mondays cuts each out of a month-long closure.
  assert.deepEqual(closeDates(null, '2099-03-01', '2099-03-14', [1, 2]), [
    { kind: 'closure', starts_on: '2099-03-02', ends_on: '2099-03-03', note: null },
    { kind: 'closure', starts_on: '2099-03-09', ends_on: '2099-03-10', note: null },
  ])
  assert.deepEqual(openDates(noted, '2099-03-01', '2099-03-14', [1]), [
    { kind: 'closure', starts_on: '2099-03-01', ends_on: '2099-03-01', note: 'Renovation' },
    { kind: 'closure', starts_on: '2099-03-03', ends_on: '2099-03-08', note: 'Renovation' },
    { kind: 'closure', starts_on: '2099-03-10', ends_on: '2099-03-31', note: 'Renovation' },
  ])
  assert.throws(() => closeDates(null, '2099-03-02', '2099-03-02', [5]))
  assert.throws(() => openDates(noted, '2099-03-01', '2099-03-14', []))
  assert.throws(() => openDates(noted, '2099-03-01', '2099-03-14', [7]))
})
