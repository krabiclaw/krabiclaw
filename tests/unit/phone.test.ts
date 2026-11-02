import assert from 'node:assert/strict'
import test from 'node:test'
import { dialsSameNumber, parsePhone } from '../../utils/phone.ts'

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
  // Another extension is another line.
  assert.equal(dialsSameNumber('+19847778288;ext=12', '(984) 777-8288'), false)
  assert.equal(dialsSameNumber('+19847778288;ext=12', '+1 984 777 8288 ext. 12'), true)
})

test('parsePhone interprets international and national forms when switching countries', () => {
  // An international number parses and identifies its own country
  const thParsed = parsePhone('+66812345679')
  assert.equal(thParsed.valid, true)
  assert.equal(thParsed.country, 'TH')
  assert.equal(thParsed.e164, '+66812345679')
  assert.equal(thParsed.nationalFormat, '081 234 5679')

  // The national format with TH country parses to the same E.164
  const nationalParsed = parsePhone(thParsed.nationalFormat!, { defaultCountry: thParsed.country! })
  assert.equal(nationalParsed.valid, true)
  assert.equal(nationalParsed.e164, '+66812345679')

  // The same national string evaluated against US default country is invalid
  const usParsed = parsePhone(thParsed.nationalFormat!, { defaultCountry: 'US' })
  assert.equal(usParsed.valid, false)
})
