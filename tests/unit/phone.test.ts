import assert from 'node:assert/strict'
import test from 'node:test'
import { dialsSameNumber } from '../../utils/phone.ts'

test('a phone link matches the location number it dials, however each is written', () => {
  // A location stored nationally, linked from the header as stored and from a page in E.164.
  assert.equal(dialsSameNumber('(984) 777-8288', '(984) 777-8288'), true)
  assert.equal(dialsSameNumber('(984) 777-8288', '+19847778288'), true)
  assert.equal(dialsSameNumber('+1 984-777-8288', '(984) 777-8288'), true)
  // A trunk prefix is dropped once the other number supplies the country.
  assert.equal(dialsSameNumber('+66812345678', '081 234 5678'), true)
  // Someone else's number, or a fragment, is not the location's.
  assert.equal(dialsSameNumber('(984) 777-8288', '+19195550123'), false)
  assert.equal(dialsSameNumber('(984) 777-8288', '(919) 555-0123'), false)
  assert.equal(dialsSameNumber('911', '911'), false)
})
