# Business progress foundation

This contract records owner intent and useful work. The dashboard's Today and
Upcoming views read stored tasks (`server/domain/tasks.ts`) and, for a manager,
the setup the business has not finished and the welcome each booked guest is due
(`server/domain/opportunities.ts`; see Today and Upcoming in `DESIGN.md`). Booky
Boo can consume the same domain operations when its presentation reaches
parity; none of these records require lodging.

## Canonical records

`organization_goals` stores what an owner or administrator explicitly says they
want, their constraints, an optional target date and an optional explicit
strategy. Strategy names the chosen marketing channels (`blog`, `social`,
`google_ads`) and whether payment setup or availability are part of the goal.
Intent and constraints remain authored text; the selector never infers channel
choices by matching their words. Goals are active or archived. A saved article
or a sent message does not establish that a goal was achieved.

`activity_entries` remains the record of work. The progress API derives outcomes
from its durable occurrence IDs rather than copying completion into another
table. Article creation, meaningful edits and publication transitions record the
authenticated actor in the same D1 batch as the change. Equivalent saves preserve
the document revision and produce no additional article outcome. Historical
actor attribution is reported only when it was recorded.

Today's suggestions are read from the business's own rows each time Today is
read: setup not yet finished (a Stripe account that is not ready, a custom
domain while the site is private, a first offering of the business's kind,
Google Ads, a price for an experience, taking payment for a priced experience
or consultation once payments are ready, a social account or the plan for
social publishing) and a booked guest who has not heard from the business since
booking. Each goes away when the write that finishes it lands. Nothing is
recorded about them and they cannot be accepted or dismissed. The
`opportunities` table holds the decisions made under the earlier selector and is
no longer written; its one remaining reader presents and closes an accepted
"take payment" task. `tasks` is work someone has to do, with an assignee, a window
and who closed it; completing and skipping are audit entries here, so they count
as business activity.

Article activity is recorded by ordinary CMS/MCP writes; reply evidence comes
from the existing conversation activity and delivery receipts. Goals and
decisions are collected only through explicit submissions to their APIs. No
recommendation impression, exposure, usefulness, effort saved or achieved
business goal is established by these records.

## API

All paths begin with `/api/organizations/:organizationId`. The organization is
explicit and authorization uses the authenticated Better Auth membership. This
first organization-wide slice is available to owners and administrators; it
does not expose organization-wide conversations to assigned staff. Domain
functions enforce the same access rules as the HTTP routes.

| Method and suffix | Behavior |
| --- | --- |
| `POST /goals` | Create with `idempotencyKey`, `intent`, optional `constraints`, `targetAt` and `strategy`. Returns `{goal}` and 201, including an identical retry. Reusing the key for another request returns 409. |
| `PATCH /goals/:goalId` | Edit authored fields or `status`, supplying the current `revision`. Returns `{goal}`. A stale edit returns 409. |
| `GET /progress?limit=50&offset=0` | Read goals and a page of canonical outcomes. Limit is 1–100. |
| `GET /progress/reference?operation=article.publish&subjectId=...` | Read `{reference}` for an explicit operation and canonical subject ID. Returns 404 for an absent or foreign subject. |
| `GET /tasks`, `POST /tasks`, `PATCH /tasks/:id`, `POST /tasks/:id/complete`, `/skip`, `/reopen`, `/read` | Stored work; see `server/domain/tasks.ts`. |

Reference operations name canonical capabilities: `article.publish`,
`article.create`, `post.create`, `post.publish`, `article.distribute`,
`social.connect`, `google_ads.connect`, `payments.connect`, `domain.connect`,
`product.create`, `product.payment`, `product.readiness`, `stay.gap` and
`booking.welcome`. Organization-level setup operations reference the exact
organization, content operations reference their article or post, and product
operations reference their exact product. The exceptions: `article.create`
references the organization; `post.create` references the organization, or a
session as `["session", productId, sessionId]`; `stay.gap` references the
interval as `[productId, from, to]`; `booking.welcome` references the guest
conversation. References authorize the source and derive their evidence
revision from its real state.

Successful editor and MCP writes publish a content-free `business.changed`
invalidation after their normal cache refresh; open dashboards re-read Today.

All dates and revisions use UTC ISO instants with milliseconds. `null` means an
optional authored value is absent. Actor identity comes from the authenticated
session, never the request body.

## What progress proves

Each outcome exposes its canonical activity ID, event, subject, actor, occurrence
time and verification basis:

- Articles prove a persisted change, including a persisted publication state.
  They do not prove that every public cache, index or derived asset converged.
- Web replies prove a stored message. Recipient notification is separate.
- External replies expose exact provider receipts. Provider acceptance is not
  recipient delivery, reading or conversation resolution. Missing receipts are
  unconfirmed; failed delivery stays failed. `log_only` is unconfirmed even
  when a local test records a synthetic sent receipt.

`coverage` makes those limits part of the response. There is no aggregate
business-success score, currency, reward eligibility, wallet or redemption
policy. Exposure measurement, owner validation of Today's selection and
economic policy remain separate decisions under issues
[#1606](https://github.com/krabiclaw/krabiclaw/issues/1606),
[#1607](https://github.com/krabiclaw/krabiclaw/issues/1607) and
[#1608](https://github.com/krabiclaw/krabiclaw/issues/1608).
