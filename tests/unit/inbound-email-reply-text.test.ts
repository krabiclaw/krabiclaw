import test from 'node:test'
import assert from 'node:assert/strict'

import { guestReplyText } from '../../server/domain/guest-threads/inbound-email.ts'

// Invariant: an inbound guest email becomes the text the guest newly wrote —
// never the mail client's quoted copy of the thread — for plain-text and
// HTML-only messages alike.

// The reply exactly as Gmail delivered it to production on 2026-09-24: CRLF line
// endings, a narrow no-break space before "PM", a blank line under the header and
// the Blawby email's invisible preheader padding inside the quote.
const gmailQuote = [
  'On Thu, Sep 24, 2026 at 7:16\u202FPM Ember & Slice <hello@krabiclaw.com> wrote:',
  '',
  '> Yo heads up',
  '>',
  `>  ${' \u200C\u200B\u200D\u200E\u200F\uFEFF'.repeat(40)}`,
  '> [image: Blawby]',
  '> Reply from Ember & Slice',
  '>',
  '> Yo heads up',
  '>',
  '> Reply to this email and your message goes straight back to the same',
  '> conversation.',
  '>',
  '> © 2026 Blawby · krabiclaw.com',
  '>',
  '> Sent by Ember & Slice via Blawby.',
  '>',
].join('\r\n')

test('a Gmail plain-text reply keeps only the new text', () => {
  assert.equal(guestReplyText({ text: `Wtf\r\n\r\n${gmailQuote}` }), 'Wtf')
})

test('a multi-line reply keeps its paragraphs and line breaks', () => {
  const authored = 'Hi there,\n\nCan we move it to 8pm?\nWe are now four people.\n\nThanks'
  assert.equal(guestReplyText({ text: `${authored}\n\n${gmailQuote}` }), authored)
})

test('an ordinary plain-text email is unchanged apart from the outer trim', () => {
  const authored = 'Hello,\n\nDo you have a table for two on Friday?\n\n- Alex'
  assert.equal(guestReplyText({ text: `\n  ${authored}\n\n` }), authored)
})

test('an Outlook reply keeps only the new text', () => {
  const text = [
    'Sounds good, see you then.',
    '',
    '________________________________',
    'From: Ember & Slice <hello@krabiclaw.com>',
    'Sent: Thursday, September 24, 2026 7:16 PM',
    'To: guest@example.com',
    'Subject: Re: Your reservation',
    '',
    'Yo heads up',
  ].join('\r\n')
  assert.equal(guestReplyText({ text }), 'Sounds good, see you then.')
})

test('an HTML-only Gmail reply keeps only the new text', () => {
  const html = `<div dir="ltr">Wtf</div><br>
<div class="gmail_quote">
  <div dir="ltr" class="gmail_attr">On Thu, Sep 24, 2026 at 7:16 PM Ember &amp; Slice &lt;hello@krabiclaw.com&gt; wrote:<br></div>
  <blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex">
    <p>Yo heads up</p><img alt="Blawby" src="https://krabiclaw.com/logo.png"><p>Reply from Ember &amp; Slice</p>
  </blockquote>
</div>`
  assert.equal(guestReplyText({ html }), 'Wtf')
})

test('an HTML-only Yahoo reply keeps only the new text', () => {
  const html = '<div>See you at 8.</div><div class="yahoo_quoted"><p>Earlier message that is not part of the reply.</p></div>'
  assert.equal(guestReplyText({ html }), 'See you at 8.')
})

test('an ordinary HTML-only email keeps its paragraphs and line breaks', () => {
  const html = '<html><body><p>Hello,</p><p>Do you have a table for two?<br>Friday at 7pm.</p><div>Alex</div></body></html>'
  assert.equal(guestReplyText({ html }), 'Hello,\n\nDo you have a table for two?\nFriday at 7pm.\n\nAlex')
})

test('a whitespace-only text part yields to the HTML reply', () => {
  assert.equal(guestReplyText({ text: ' \r\n\r\n ', html: '<div dir="ltr">See you at 8.</div><div class="gmail_quote"><blockquote>Earlier</blockquote></div>' }), 'See you at 8.')
})

test('an email with only quoted history and a signature has no new text', () => {
  assert.equal(guestReplyText({ text: `\n\n${gmailQuote}\n\n--\nSent from my iPhone` }), '')
  assert.equal(guestReplyText({ html: '<div class="gmail_quote"><blockquote>Yo heads up</blockquote></div>' }), '')
})

test('non-English text is preserved exactly', () => {
  const authored = 'สวัสดีครับ จองโต๊ะสองที่ได้ไหมครับ\n金曜日の19時は空いていますか？ 🍕'
  assert.equal(guestReplyText({ text: `  ${authored}\n\n${gmailQuote}` }), authored)
})
