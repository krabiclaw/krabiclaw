# Notification testing

KrabiClaw has two distinct records:

- `activity_entries` records dashboard notifications and each reader's acknowledgement. A notification is unread for a user until the corresponding acknowledgement exists.
- `guest_thread_deliveries` records external email or WhatsApp outcomes for guest-thread entries. It is not a dashboard feed.

Do not infer an external send from a dashboard notification, or an unread item from a delivery receipt.

## Audience and channel coverage

The following map comes from the event producers and delivery paths. Staff
external delivery follows the person's category preferences, verified contact
details and registered devices. Email and WhatsApp use the same message facts
where the catalog declares an approved template. Push includes iOS APNs and
browser Web Push where a device is registered.

| Event | Staff path | Guest or account path |
| --- | --- | --- |
| Task assigned or starting | Assigned person's Notifications and task detail. Email and push default on. WhatsApp is available by preference. | Staff work only. |
| New bookings and reservations, guest cancellations, and material changes | Notifications, email and push to workspace managers and responsible recipients. WhatsApp for events with templates, including booking changes. Calendar sync exceptions have email and push. The alert opens the booking record. | Guest transaction email to the booked contact. Owned records can appear in account Notifications and Activity. Guest WhatsApp and push are separate from staff preferences. |
| New, changed, cancelled or overlapping channel stays | Managers and responsible home staff receive in-app alerts. Staff receive the turnover view and no financial facts. Email and push are eligible. The change event has a WhatsApp template. Historical imports do not alert. | The originating channel owns its guest notices. Direct stays use the transaction email path. |
| Guest, Airbnb and team messages | Guest and team conversations contribute to the Messages count. Email, approved WhatsApp and push are eligible for responsible recipients. A guest message alert shows the guest's words, photos and translation, the conversation's last messages, then the stay or inquiry and one Reply action. Replying to the alert email, or quoting the WhatsApp alert, answers the guest as that member. | Guest replies use the conversation's delivery route and receipts. An owned conversation has account unread state. |
| Payments, refunds, disputes and payouts | Financial events enter the authorized workspace history and use their configured delivery. Organization and billing email defaults on. | Buyer receipts and refunds are transaction email and account Activity for the authorized buyer. |
| Reviews and review requests | Review alerts use the review preference. Email defaults on. New review has a WhatsApp template. | The opted-in review invitation uses its tracked guest link and email receipt. |
| Invitations and account security | Better Auth owns sign-in and invitation lifecycle. Account security email is required. | Email goes to the invitee or account holder and opens the invite or verification flow. |
| Organization, billing and product news | Organization events use category preferences and their declared destination. Product news uses Resend Broadcast and Topic subscriptions. | Product news follows the subscriber's preference. |

The catalog checks cover 64 email renders and 20 email/WhatsApp template
pairs. They verify content, including required facts and unsubscribe controls.
Staging runs email and WhatsApp in `log_only` mode because its database contains
copied tenant data. A staging receipt cannot qualify provider delivery. Use the
authorized production canary and dedicated test recipients for real Resend and
WhatsApp delivery. For APNs and Web Push, verify receipt on a registered test
device or browser, open the link, and compare the provider receipt with the
actual result.

## Email purpose

Every notification message declares its email purpose and a factual reason for
sending, which appears in both HTML and plain text. Purpose is separate from
the category's channel preferences: an optional booking alert is still a
transactional email. Guest confirmations and payment receipts use their actual
booking, message or billing category and go directly to the transaction's
contact without consulting owner notification preferences.

Transactional messages omit unsubscribe links and mailing-list headers. Guest
transactional messages also omit signup prompts. Authentic booking, property
and location images remain alongside tenant logos, transaction details,
attachments and relevant actions. A message without a supplied image renders
no hero image.
Subscribed review alerts and promotional review requests and product news retain
unsubscribe controls. Product News continues to use Resend's native Broadcast
and Topic unsubscribe lifecycle.

`yarn lint:email-previews` verifies all catalog messages through the canonical
renderer, including the reason in both bodies, purpose-specific footer controls,
and the exact supplied hero image URL without inventing an absent image. The
existing `resend-native-d1.test.ts` and
`guest-delivery-d1.test.ts` integration tests exercise SDK request headers,
required opt-out configuration, and persisted cancellation/replay behavior.
These checks do not establish Gmail inbox-tab placement; that requires
inspection of an actually delivered message.

## Email conversation continuity

Guest confirmations, status updates, scheduled messages and dashboard replies
share the existing receipt-backed email dispatcher. It records the complete
outbound request before dispatch in `guest_thread_deliveries.email_json` and
stores Resend's actual RFC Message-ID in `email_message_id`. The provider API
UUID remains in `provider_message_id`; the two identities are not interchangeable.

A send is sent when Resend answers with the email's id, and failed with
Resend's error when it answers with an error or the call throws. A failed send
is sent again under the receipt's id, which is Resend's idempotency key, so an
email Resend already took is not sent twice. Resend's send answer carries no RFC
Message-ID. The verified `email.sent` or `email.delivered` webhook records it,
and nothing polls Resend for it. A reply threads on the Message-IDs recorded
when it is prepared; an earlier email whose webhook has not arrived is left out
of its references.

Native inbound email records its parsed subject, Message-ID and reply references
on the immutable guest entry. The content hash used to deduplicate email without
a Message-ID is never used as an RFC identity. Malformed provided Message-IDs
are rejected at ingress. Replies select ancestry only within the same request
and recipient; owner copies and another recipient's messages are excluded.
SMTP replies retain the subject with one `Re:` prefix and send `In-Reply-To`
and `References`. Event-specific headings, tenant images and attachments stay
in the body. Retrying a delivery reuses its frozen sender, recipient, subject,
body and references even if another message or a brand edit arrives meanwhile.

The existing Resend integration tests verify exact SDK headers and the full
confirmation/guest/staff sequence against real local D1. The native MIME ingress
journey verifies routing, stored metadata, duplicate protection and staff replies
through the built Worker. The opt-in native transport test uses only Resend's
`delivered@resend.dev` simulation address and independently reads the actual
provider IDs and subjects to verify them. It does not inspect a real Gmail or
Outlook inbox. Its Resend API key must permit retrieving sent email for that
check; the application never retrieves it.

## Message alerts

A guest message alert is built from the conversation's own records. Its photos
are the message's media placements, whether Airbnb's mirrored attachments or a
guest's emailed, web or WhatsApp photos. Each is linked by its public media URL,
which mail clients, browsers and Meta fetch directly. A message with no words
reads "Sent a photo", or "Sent an attachment" for files that are not photos, in
lists, push and WhatsApp. The email shows the photos themselves.

No approved WhatsApp template has an image header. The template alert says what
was sent, and each photo follows as a WhatsApp image message only while the
member's 24-hour service window is open. That window starts at Meta's timestamp
on the member's last WhatsApp message to KrabiClaw. Browser push shows the
first photo. App push carries text only, because APNs shows an image only through
a notification service extension, which the app does not have.

Every email alert about a conversation threads per recipient. It keeps the
subject of the first alert sent to that address. It sends `In-Reply-To` with the
previous alert's Message-ID and `References` with all of them. Alerts therefore
read Resend's assigned RFC Message-ID like guest email does. Alerts to other
recipients and the guest's own emails are never part of that ancestry. A
log-only alert has no RFC identity, so staging alerts share a subject but carry
no threading headers. Each alert's reply-to is that member's signed reply
address (`docs/guest-messaging-boundaries.md`).

`resend-native-d1.test.ts` asserts the exact headers and subject of three alerts
and a member's emailed reply reaching the guest. `channex-messages-d1.test.ts`
asserts an Airbnb photo in the recorded alert HTML and an emailed reply reaching
Channex once. `whatsapp-entitlement-d1.test.ts` asserts a quoted WhatsApp reply,
the single hint for an unquoted message, refusals and Meta redelivery.

## Review invitation retries

An ended visit gets one initial invitation. A retry resumes that invitation;
inbox publication or final success persistence failing after Resend acceptance
must not issue a new link or another email. `first_sent_at`
marks completed application work, not proof that no earlier send was accepted.
`send_count` counts completed initial invitations, not physical provider sends.

The existing receipt owns the frozen email and Resend identity. The request now
also retains its token at creation: the receipt cannot recover a token when work
fails before the email snapshot exists, and its hash cannot be reversed. The
nullable `review_requests.token` column solves that concrete retry gap without a
second invitation store. Existing pending requests recover only a recorded email
token matching their stored hash; an unmailed request can retain a new token.
An inconsistent recorded invitation fails visibly instead of invalidating its
emailed link. The token is private application data, like the existing email
snapshot, and is never returned in review API responses.

Retries preserve the original expiry, token, invitation entry and receipt key,
so Resend's idempotency key sends a failed invitation again without a second
email for one it already took. Failures remain reported and incomplete work
remains eligible for automation retry.

A retry is neither a reminder nor a reissue. The current automation sends one
initial invitation and implements no reminder schedule. This change leaves the
existing cancellation/no-show revocation, submission and 30-day invitation
window intact; it does not add a new resend policy or revive revoked links.

`guest-reviews-d1.test.ts` runs the actual automation, review APIs, dispatcher,
local D1 and a local Durable Object. Its controlled Resend transport proves one
accepted email and a usable original link across preparation failure, acceptance
persistence failure, publication failure, final write failure
and concurrency, plus recovery of rejected sends.
No customer email is sent by these tests.

## Local verification

Local development and preview use log-only delivery modes. A log-only send must still write a terminal `guest_thread_deliveries` receipt with a `log-only:` provider message ID when the send belongs to a guest thread.

Verify a guest submission through the real Worker boundary:

1. Submit a contact message, reservation, or experience booking.
2. Confirm that one guest thread and its opening entry exist.
3. Confirm that the owner dashboard notification references that thread and entry.
4. Confirm that configured owner channels and the guest acknowledgement have delivery receipts with stable idempotency keys.
5. Open the thread as a dashboard user and confirm that `notification_reads` records the acknowledgement for that user only.
6. Confirm that the organization WebSocket emits the typed invalidation and that disconnecting it shows the dashboard failure state.

For inbound guest replies, use the development inbound email or WhatsApp route. Repeating the same provider message ID must return the existing entry instead of appending another one. For a member's reply, send the raw email below to the member reply address from the alert's recorded `email_json`, from the member's own account address.

The development email route does not prove the native MIME entrypoint. Also send
a raw multipart email through Wrangler's `/cdn-cgi/local/email` endpoint, using a
reply address signed with the disposable local `EMAIL_REPLY_SECRET`. Verify
Unicode text decoding, concurrent replay of its `Message-ID`, one persisted
guest entry, and rejection of an invalid reply token. This endpoint is supplied
by [Wrangler's local email runtime](https://developers.cloudflare.com/email-service/local-development/routing/),
not by an application forwarding route.

`yarn test:d1` exercises the committed baseline and delivery claim functions
against real local D1. It proves one concurrent claim, no ambiguous Meta retry,
bounded Resend retry, and protection from stale completion writes. It does not
contact either provider or prove their live webhook configuration.

## Production canary

Production delivery checks are an authorized release operation. Follow [release-and-outage-prevention.md](operations/release-and-outage-prevention.md) and use `yarn canary:notifications` only with the documented production credentials and approval. The canary reads guest delivery outcomes and emits its result as structured command output. Retain that output with the release evidence outside application D1.

Never use a canary to provision resources, change delivery modes, or repair data.
