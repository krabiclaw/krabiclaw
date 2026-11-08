# Business progress foundation

This contract records owner intent and useful work. The dashboard's Today and
Upcoming views read stored tasks and opportunities (`server/domain/tasks.ts`,
`server/domain/opportunities.ts`; see Today and Upcoming in `DESIGN.md`). The
opportunities come from `readBusinessRecommendations`. Booky
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

`opportunities` records each thing the selector found at its evidence revision
and the business's decision about it: accepted (with its one task), dismissed
(with the owner's note) or deferred (`available_at`). New evidence is a new
opportunity. Listing shows opportunities backed by current evidence and keeps
earlier decisions. `tasks` is work someone has to do, with an assignee, a window
and who closed it; completing, skipping and
accepting are audit entries here, so they count as business activity.

Article activity is recorded by ordinary CMS/MCP writes; reply evidence comes
from the existing conversation activity and delivery receipts. Goals and
decisions are collected only through explicit submissions to their APIs:
Today's priority disclosure creates and archives goals, and an opportunity's
Accept and Not now record the decision against the evidence it was found on. No
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
| `GET /progress/reference?operation=article.update&subjectId=...` | Read `{reference}` for an explicit operation and canonical subject ID. Returns 404 for an absent or foreign subject. |
| `GET /opportunities`, `POST /opportunities/:id/accept`, `/dismiss`, `/defer` | Read open opportunities and decide one; see `server/domain/opportunities.ts`. Accept returns the new `{task}`. |
| `GET /tasks`, `POST /tasks`, `PATCH /tasks/:id`, `POST /tasks/:id/complete`, `/skip`, `/reopen`, `/read` | Stored work; see `server/domain/tasks.ts`. |

The experimental `POST /api/organizations/:organizationId/recommendations/preview`
endpoint has been removed and returns 404. `readBusinessRecommendations` reads
current canonical facts on each request. It uses explicit strategy, vertical,
content already in progress, native performance, connected provider evidence
and current availability. A business without an authored strategy still has
ordinary marketing opportunities. No model call or game economy is introduced.

Feedback operations name canonical capabilities: `article.update`,
`article.publish`, `article.create`, `post.create`, `post.publish`,
`article.distribute`, `social.connect`, `google_ads.connect`, `payments.connect`, `product.payment`,
`stay.gap` and `guest_thread.reply`. Organization-level creation/setup operations
reference the exact organization, existing content operations reference their
article/post, and product payment operations reference their exact product. Availability work
references its recorded session, location/slot, or home/date interval. Echo the
opaque `subjectId` returned by the server with each opportunity; it names that
source opportunity, never a fabricated future article or post. References authorize
the source and derive their evidence revision from its real state.

Google Ads setup reuses the existing Integrations flow. Its opportunity operation
is needed because selecting an unconnected Ads strategy previously produced no
related action; a social or payment opportunity cannot describe a Google Ads connection.

Recommendations are continuously eligible, not a daily assignment batch. A
publication can remove its publishing action and make distribution available
in the same session; a successful reply removes the waiting response action.
A draft change is progress, not proof of publication or goal achievement.
Social distribution requires a real matching provider publication; a website
post alone does not establish an external send. Payment setup uses Stripe's
actual readiness. Calendar recommendations use effective nightly policy,
including overrides, and disappear when that interval is no longer applicable.
There is no midnight completion reset.

Today displays provider/analytics failures through `recommendationIssues`,
while retaining baseline opportunities with an honest evidence limit. Missing
measurement is never replaced with measured zero demand or full capacity.
Successful editor and MCP writes publish a content-free `business.changed`
invalidation after their normal cache refresh. Existing conversation events
cannot signal an article or post completion; without this signal the open
dashboard can keep recommending work already published in another window.
Open dashboards reread their
authorized scope; payments and connection status also reconcile on return/focus
and the existing visible-page timer.

All dates and revisions use UTC ISO instants with milliseconds. `null` means an
optional authored value is absent. Actor identity comes from the authenticated
session, never the request body.

## Evidence and decisions

An opportunity is recorded against the `evidenceRevision` of its reference
(`GET /progress/reference`). Article evidence includes current document content,
categories and attributed activity. Conversation evidence includes the latest
actual guest activity and member reply, canonical commitment state and reply
receipts. A decision applies to that revision only: when the evidence changes,
the selector records a new opportunity and stops listing the old one. A partial
read reports the unavailable evidence alongside any current opportunities.
Accepting re-reads the selector and is refused with 409 when the evidence has
moved on. Whether the business owes a guest a reply is an open `guest_reply`
task, opened and closed by the conversation's own writes.

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
