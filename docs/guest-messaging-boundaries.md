# Guest Messaging Boundaries

**Status: Contract**

This note exists so future sessions do not collapse three different systems into one. References to future sessions are for clarity, not authorization to implement changes.

- **WhatsApp OTP** verifies a signed-in member's own phone number from their profile, so notifications can reach them on WhatsApp. It is not a way to sign in.
- **Notifications** are system-generated owner/guest sends from `server/utils/notifications.ts`.
- **Guest messaging** is the contact/reservation/booking/stay reply flow backed by canonical `requests`, `activity_entries` and the guest-thread operation service.

## Current product truth

- A member answers a guest from their alert. Replying to the alert email, or quoting the WhatsApp alert, runs the inbox's own reply operation as that member. It sends at once, with no confirmation, menu or follow-up prompt. The member must still belong to the business and pass the inbox's reply permission check. The member is told the outcome: sent, refused with the reason, or that it may have reached the guest. An owner WhatsApp message that quotes no alert gets one line saying to reply to the guest's message.
- Direct guest replies use email. A mapped Airbnb conversation uses Channex's Messages API, including inquiries whose guest contact is withheld.
- A direct stay whose guest has no email is reached in their KrabiClaw account inbox when the stay is theirs (a stay they bought), and emailed too when that account has a verified email. A guest with neither cannot be written to: the conversation shows no composer and a reply is refused with `GUEST_UNREACHABLE`.
- Guest replies can be ingested back into the thread ledger from email, and from WhatsApp only when an inbound message can already be matched to an authorized guest thread by phone.
- The dashboard inbox is the canonical thread UI for guest work. It renders the opening source submission with persisted message, operation, assignment, and resolution entries from one append-only history.

## Cleanup direction now

- A verified WhatsApp number lets a member answer by quoting an alert. It does not make WhatsApp a channel to the guest: the reply goes where `guestReplyDestination` says, by email, Airbnb or the guest's account inbox.
- Guests still write in on WhatsApp only when their phone matches an authorized guest thread, as above.
- Keep notification CTAs pointing owners into the dashboard inbox. Its canonical operation endpoint selects the conversation's address: email for direct conversations or Channex for mapped Airbnb conversations. A channel stay without a mapped thread fails explicitly instead of sending to a recorded email address.

## Canonical thread model

- `requests` is the conversation aggregate; booking and stay rows link to it through `request_id`.
- `activity_entries` is the sole guest-conversation timeline/history store. Entries are facts and corrections are represented by later entries, not rewrites.
- A direct submission has a persisted opening `submission` entry. A provider conversation imports its actual messages, including system and attachment-only messages. Its provider title is a participant label, never a fabricated guest name. An inquiry can have no booking or guest contacts.
- `channel_threads` holds provider addressing and the home mapping, not a second inbox. Booking assignment adopts the same request without moving its entries, receipts or reads. Conflicting existing timelines require explicit review.
- Channex message timestamps are retained exactly. A timezone-free provider timestamp is not converted into an absolute instant; `channel.message_mirrored` records the local mirroring time and the UI labels it Recorded.
- Channel text replies retain the actual provider message ID in their canonical delivery receipt. A sending or uncertain attempt is never blindly resent. Provider attachment links are displayed as links; outgoing channel attachments are explicitly unsupported until that write contract is qualified.
- Human replies, operational transitions, delivery attempts/results, assignment changes, and resolution/reopen actions are persisted as typed ledger entries.
- Conversation state is separate from source lifecycle state. Conversation state is limited to `needs_attention`, `waiting_on_guest`, and `resolved`; operational status remains owned by the source adapter.
- Per-member read state lives outside the thread aggregate so one manager reading a thread does not mark it read for every other manager.
- Conversations have no independently stored inbox owner. The canonical booked provider and current location, offering or home responsibility grant access through the shared scope used by lists, reads, writes, realtime, agenda and notification recipients. A resource names one Better Auth membership or Team; the booked individual remains historical attribution. Team-chat seats define participation. Changing responsibility does not silently enroll someone in a team conversation.
- Canonical assignment and Better Auth member/team writes publish the content-free `access.changed` invalidation. Current members re-read their authorized inbox and open conversation. Denied reads clear the old transcript, draft and attachments instead of retaining revoked customer data. This applies to restaurant, experience, Legal Services and lodging workflows.
- Booking change proposals, decisions, direct moves and financial operations remain in their original conversation. Buyer-visible history includes `booking_change.moved`; native and dashboard timelines render those recorded facts alongside messages. No second sender or review-only timeline is introduced.
- The inbox renders server-authorized actions from the guest-thread source adapter registry. Dashboard UI must not infer confirm/cancel/complete policy from raw source status or call source-specific editor mutation endpoints.
- Reuse the shared conversation shell where it helps the UX, but never back guest threads with assistant/tool-call history.
- Signed-in buyers use the same ledger through their authorized account messages. Provider threads are addressed through their mapped channel rather than attached to a local buyer by provider user ID.

## Member reply address

A member's alert about a conversation carries the reply-to
`rm<32-hex entry UUID><24-hex-HMAC>@reply.<platform-domain>`. The entry is the
conversation event the alert is about, so it names one conversation. Booking and
reservation conversation ids are 64-character hashes, which cannot fit the
64-character local part. The HMAC uses the guest address's secret and signs
`member:<entry id>:<user id>`. The user id is not in the address. Inbound email names the member by the envelope sender,
which must be a verified account email, and the signature must match that
member and conversation. The reply is the inbox's quoted-history and signature
stripped text, with the email's files as the reply's photos. A wrong sender, a
forged or foreign signature, a member who left or lost access, and any reply the
operation refuses bounce with the reason. A reply that may have reached the guest
bounces saying so, and its failure is reported. A failure the member cannot act
on fails the delivery and is reported. The email's Message-ID keys the reply, so a
redelivered email sends nothing twice. No table records these addresses.

## Epoch 5 reply-address contract

The current supported address is
`r<type-code><32-hex-UUID><24-hex-HMAC>@reply.<platform-domain>`. Inbound email
and the development ingress both validate this address and pass its signature
through the canonical guest-thread receiver. The 32-hex token and
`reply+<type>-<id>-<token>` address are retired with Epoch 5. Existing compact
addresses retain their exact signature algorithm and continue to work; stored
submissions, messages and delivery evidence are preserved.

This implements the owner's explicit requirement that no backward compatibility
is required. Retirement applies to the staging build now and to production only
when the owner performs the later production cutover. Previously sent emails
cannot be rewritten. Fresh production evidence includes four pre-compact
reservations and one contact still marked new; their reservation service dates
are past, but there is no evidence that every conversation was resolved. The
retirement decision does not mark them complete or discard them. Retained Resend
history contained seven delivered compact reply addresses and no old-format
address; the provider's retention window does not prove that older addresses
were never issued. After production cutover, replies to the retired format are
rejected instead of appended to guest threads.
