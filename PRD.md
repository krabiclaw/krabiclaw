# KrabiClaw requirements

Requirements the product must keep meeting. `PRODUCT.md` explains the product;
`AGENTS.md` holds the rules for working on it.

## Notifications

1. Every event is one `NotificationMessage`, rendered to email, WhatsApp and
   push by the same delivery path, with one receipt per channel and recipient.
   There is no second notification system, preference gate or fallback.
2. Every alert to a member has a destination of its own (`primaryAction`), and
   push opens it. An alert whose destination cannot be resolved fails with
   `NOTIFICATION_DESTINATION_UNAVAILABLE` and the field that could not be
   resolved; it is never sent pointing somewhere generic.
3. A booking change states the current and the requested dates, nights, guests,
   location, assignee and booking total where the booking has them; what
   differs; who requested or decided it; and whether it is proposed or
   confirmed. A change awaiting the host opens its conversation with
   "Review requested changes".
4. Live Airbnb guest messages, new Airbnb stays, changes, cancellations and
   overlapping stays alert the owners. A home's import, a conversation
   backfill, a webhook replay and a revision that changes nothing alert no one.
5. An event is alerted once: retries and redelivered webhooks resolve to the
   same entry and its existing receipts.
6. Members who are not owners or admins never receive money or guest contact
   details in an alert they were not already allowed to read.
7. Missing required facts fail the alert with a machine-readable code and the
   field; nothing stands in for them.
8. Every lead fact reaches WhatsApp's approved template
   (`yarn lint:notification-parity`), and every message renders with its
   delivery reason (`yarn lint:email-previews`).
