# Stripe Connect onboarding

KrabiClaw creates one Stripe Accounts v2 merchant account per Better Auth
organization. The account uses Stripe's Express Dashboard and Stripe-hosted
onboarding. Stripe collects and stores verification data; KrabiClaw stores only
the Stripe account ID, capability status, normalized requirements, country, and
mode.

This integration uses the repository's existing Stripe SDK and pinned API
version. Do not add a second Stripe client or override the API version.

## Stripe configuration

Create a thin-event destination for each environment with this endpoint:

```text
https://<environment-host>/api/stripe/connect/webhook
```

Subscribe it to:

- `v2.core.account.updated`
- `v2.core.account[configuration.merchant].capability_status_updated`
- `v2.core.account[configuration.merchant].updated`
- `v2.core.account[identity].updated`
- `v2.core.account[requirements].updated`
- `v2.core.account_link.returned`

Store that destination's signing secret as `STRIPE_CONNECT_WEBHOOK_SECRET`.
It is deliberately separate from `STRIPE_WEBHOOK_SECRET`, which belongs to the
Better Auth platform-billing webhook.

The Stripe key must be able to create and retrieve Accounts v2, create Account
Links v2, retrieve Events v2, and list Country Specs. Keep test and live
destinations, keys, and signing secrets paired with their matching environment.

## Demo organizations take test-mode payments

A demo organization (`shared/demo.ts`) connects its Stripe account in test
mode on every platform, so its site can be booked and paid with Stripe's test
cards while production charges real money everywhere else. The mode is chosen
by `organizationPaymentsLivemode` and is fixed when the account is reserved;
every later Stripe call for that account or its payments uses the keys for the
account's own mode (`paymentsStripe`).

A live platform therefore also holds the same Stripe account's test-mode
values. Staging is already in test mode and needs none of these:

- `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PUBLISHABLE_KEY` and
  `STRIPE_TEST_PAYMENTS_METHOD_CONFIGURATION` — the test-mode counterparts of
  the platform values.
- `STRIPE_TEST_CONNECT_WEBHOOK_SECRET` — a test-mode thin-event destination at
  `https://<environment-host>/api/stripe/connect/webhook?mode=test`, with the
  event types above.
- `STRIPE_TEST_PAYMENTS_WEBHOOK_SECRET` — a test-mode connected-account
  snapshot destination at
  `https://<environment-host>/api/stripe/payments/webhook?mode=test`, with the
  events listed in `.env.example`.

Test-mode destinations receive every test connected account's events,
including staging's; both handlers ignore accounts they do not manage. Payments
fees are billed only in the platform's mode: a demo organization on a live
platform needs no Payments fees contract or card, and its test-mode captures
record no usage.

## Release order

Follow [release-and-outage-prevention.md](release-and-outage-prevention.md) and
[release-and-outage-prevention.md](release-and-outage-prevention.md). The
generated D1 migration must land before code that reads
`stripe_connected_accounts` or `stripe_webhook_events.processor`. Never hand
write or hand-apply that migration.

Before enabling onboarding in an environment:

1. Add `STRIPE_CONNECT_WEBHOOK_SECRET` as a Cloudflare Worker secret.
2. Apply the reviewed generated migration through the canonical release flow.
3. Deploy the Worker.
4. Complete onboarding for a disposable organization and confirm the dashboard
   moves from action required or pending review to ready when Stripe activates
   `card_payments`.
5. Confirm the matching `connect_marketplace` event reaches `processed` in
   `stripe_webhook_events`; inspect failures through the existing dead-letter
   tooling.

## D1 behavior and limitations

D1 has no Postgres advisory locks or transactional outbox. Account creation is
therefore guarded by an organization-unique reservation plus a stable Stripe
idempotency key. Webhook work uses conditional D1 lease claims, bounded retries,
and the existing dead-letter/operator-requeue contract. Stripe remains the
source of truth, so dashboard refreshes retrieve the account again instead of
inferring readiness from the return redirect.

The country and live/test mode are immutable after reservation. A mismatch is a
conflict, not a fallback. Account Links are single-use and short-lived, so every
start or refresh request creates a new link and never stores its URL.

## Buyer Customers on connected accounts

Checkout creates a signed-in buyer's Customer on the business's connected
account, where Stripe saves the cards the buyer chooses to keep with that
business; `stripe_connected_customers` records which Customer is theirs.
Deleting the buyer's account deletes those Customers before the mapping is lost.
The connected account and its payment history are never closed by buyer cleanup.
See Saved cards in `docs/payments/payments.md`.
