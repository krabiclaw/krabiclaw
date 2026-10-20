# Staging lodging demo

**Saltleaf Stays** is a fictional vacation-rental business on staging for
demonstrating and smoke-testing direct stay booking and the native app. It
lives at `https://saltleaf-stays-demo-staging.krabiclaw.com` and is a demo
organization in `shared/demo.ts` (named by subdomain `saltleaf-stays-demo`):
never indexed, and only platform admins change its site settings and languages.
Its homes, calendars and stays are edited as in any other organization.

It has four homes, each with its own location and time zone:

| Home | Where | Time zone | Sleeps | Minimum | Nightly (weekend, holidays) |
| --- | --- | --- | ---: | ---: | --- |
| Saltleaf Ocean Avenue Studio | 100 Ocean Avenue, Santa Monica, US | America/Los_Angeles | 2 | 2 | $120 ($145, $175) |
| Saltleaf Ao Nang Pool Villa | Ao Nang Beach Road, Krabi, TH | Asia/Bangkok | 6 | 2 | $185 ($220, $265) |
| Saltleaf Canggu Rice-Field Loft | Jalan Pantai Batu Bolong, Canggu, ID | Asia/Makassar | 2 | 3 | $95 ($115, $140) |
| Saltleaf Tulum Jungle Casita | Avenida Tulum, Tulum, MX | America/Cancun | 4 | 2 | $140 ($165, $210) |

Each home also has a description, property type, bedrooms, beds, bathrooms,
amenities, cancellation policy, check-in method and instructions, and checkout
instructions. Each home's location carries the home's name; guests reach a home
at `/stays/<slug>`. The site's own location, made with the organization, holds
no home and is inactive, so it takes no plan location and stays off the public
site.

The staging post-deploy stay test (`tests/e2e/tenant-rendering.spec.ts`) books
Saltleaf Ocean Avenue Studio at `/stays/saltleaf-ocean-avenue-studio`, and
checks the homepage links to it. Keep the subdomain, that home's name (its
slug), its online payments and its open nights, and keep it published and
featured on the homepage.

The homepage and About copy are authored on the site, through the dashboard or
the KrabiClaw MCP tools, not by the script.

Friday and Saturday nights carry the weekend price for 26 weeks, December 20 to
January 2 the holiday price with a five-night minimum on arrival, and every
home but the studio has a few blocked nights a month or two out. The staging development owner (the
account the iOS simulator signs in with) owns the organization.

Staging has no Cloudflare Images credentials by design, so photo uploads there
return 503 and the homes have no photos.

## Create or reset

```bash
node --env-file=<file with KRABICLAW_DEV_EMAIL and KRABICLAW_DEV_PASSWORD> \
  --experimental-strip-types scripts/provision-lodging-demo.ts --staging
```

The script signs in as the development owner and uses the dashboard's own
endpoints. It creates the organization if it is missing (after a staging
database epoch replacement it is, because staging is rebuilt from production),
sets the site's own location inactive, then puts every home back to the table
above: address, location title, listing details, arrival guide, prices, rules
and blocked nights for the next 500 days. Every stay on the demo
homes is cancelled; a stay paid on the site is cancelled without a refund,
which in Stripe test mode moves no money. Lapsed checkout holds need no reset:
holds last 60 minutes, the calendar reads a lapsed one as free, and the next
hold on those nights clears it. Staging runs no cron, so nothing else does.

## Payments setup (once per organization)

Financial approvals are same-origin browser actions, so the script stops before
publishing until an owner of the organization has done both of these in the
staging dashboard:

1. **Plan** (`/dashboard/saltleaf-stays-demo/payments?tab=plan`): choose Business and pay with
   Stripe's test card. Business grants the `payments` entitlement and its subscription carries the
   metered fee prices that accepting payments requires; the four homes are rental units billed at
   the end of the period. On Basic the script stops at the third home with `LOCATION_LIMIT`.
2. **Payouts** (`/dashboard/saltleaf-stays-demo/payments?tab=payouts`): connect Stripe and finish the Stripe-hosted onboarding with
   [Stripe's test values](https://docs.stripe.com/connect/testing). Staging uses
   the Stripe test-mode key, so the account is test-mode. Stripe Tax stays off.

Then run the script again: it publishes the four homes. Guests book them on the
site and pay with Stripe's test card; the paid stay appears confirmed in the
dashboard calendar and the native app.
