# Business progress foundation

This backend contract supports future web and native presentations of owner
intent, useful work and recommendation feedback. Today keeps its current
selector. Booky Boo can consume the same domain operations when
its presentation reaches parity; none of these records require lodging.

## Canonical records

`organization_goals` stores what an owner or administrator explicitly says they
want, their constraints and an optional target date. Intent and constraints are
authored text, not model inferences. Goals are active or archived. A saved article
or a sent message does not establish that a goal was achieved.

`activity_entries` remains the record of work. The progress API derives outcomes
from its durable occurrence IDs rather than copying completion into another
table. Article creation, meaningful edits and publication transitions record the
authenticated actor in the same D1 batch as the change. Equivalent saves preserve
the document revision and produce no additional article outcome. Historical
actor attribution is reported only when it was recorded.

`recommendation_feedback` stores one person's acceptance, dismissal, deferral or
correction of a specified operation against specified evidence. It is not a
task, a completion claim, permission to execute, or a permanent suppression of a
conversation. Audit entries preserve edits to goals and feedback.

Article activity is recorded by ordinary CMS/MCP writes; reply evidence comes
from the existing conversation activity and delivery receipts. Goals and feedback
are collected only through explicit submissions to their APIs. No current UI
submits those goals or feedback, and no recommendation impression, exposure,
usefulness, effort saved or achieved business goal is established by these
records.

## API

All paths begin with `/api/organizations/:organizationId`. The organization is
explicit and authorization uses the authenticated Better Auth membership. This
first organization-wide slice is available to owners and administrators; it
does not expose organization-wide conversations to assigned staff. Domain
functions enforce the same access rules as the HTTP routes.

| Method and suffix | Behavior |
| --- | --- |
| `POST /goals` | Create with `idempotencyKey`, `intent`, optional `constraints` and `targetAt`. Returns `{goal}` and 201, including an identical retry. Reusing the key for another request returns 409. |
| `PATCH /goals/:goalId` | Edit authored fields or `status`, supplying the current `revision`. Returns `{goal}`. A stale edit returns 409. |
| `GET /progress?limit=50&offset=0` | Read goals, the caller's feedback and a page of canonical outcomes. Outcome `pagination` and `feedbackPagination` each describe their own page. Limit is 1–100. |
| `GET /progress/reference?operation=article.update&subjectId=...` | Read `{reference}` for an explicit operation and canonical subject ID. Returns 404 for an absent or foreign subject. |
| `PUT /recommendation-feedback` | Save `{operation, subjectId, evidenceRevision, decision}` with optional `note`, `deferUntil`, `goalId`, `goalRevision`, and edit `revision`. Returns `{feedback}`. |

The experimental `POST /api/organizations/:organizationId/recommendations/preview`
endpoint has been removed and returns 404. The data foundation does not generate
recommendations or invoke a model.

Operations currently supported for feedback are `article.update`,
`article.publish` and `guest_thread.reply`. These name existing canonical
capabilities, not a list of recommended tasks. New capabilities need their own
source authorization and evidence definition before joining this contract.

All dates and revisions use UTC ISO instants with milliseconds. `null` means an
optional authored value is absent. Actor identity comes from the authenticated
session, never the request body.

## Evidence and feedback lifecycle

Read a reference before asking for feedback and send its `evidenceRevision`
back unchanged. Article evidence includes current document content, categories
and attributed activity. Conversation evidence includes the latest actual guest
activity and member reply, canonical commitment state, conversation state and
reply receipts. An old unanswered status alone is not a new obligation. Reading
a reference does not decide whether a reply is appropriate now.

An optional `goalId` and `goalRevision` must be supplied together and name an
active goal in the same organization. This binds the feedback to that particular
goal; editing another goal does not invalidate it. Feedback without a named goal
is independent of goals. A correction requires a note. A new deferral requires
a future `deferUntil`; other decisions cannot carry a deferral date.

Exact feedback retries preserve the same ID and revision. Changing a decision
requires its current revision. Stale evidence or a changed/archived named goal
returns 409 before saving. A source can change concurrently with a feedback
write, so applicability is always evaluated again when progress is read.

The read reports `applicability.current` and explicit reasons:
`evidence_changed`, `subject_missing`, `goal_changed`, `goal_archived` or
`defer_elapsed`. Historical feedback stays intact. Consumers must
reassess changed evidence and interpret the person's decision; this API does
not remove inbox history, hide obligations, or automatically resurface work.

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
policy. Recommendation selection, exposure measurement, owner validation and
economic policy remain separate decisions under issues
[#1606](https://github.com/krabiclaw/krabiclaw/issues/1606),
[#1607](https://github.com/krabiclaw/krabiclaw/issues/1607) and
[#1608](https://github.com/krabiclaw/krabiclaw/issues/1608).
