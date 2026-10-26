# Business progress foundation

This backend contract supports future web and native presentations of owner
intent, useful work and recommendation feedback. Today keeps its current
selector; the recommendation preview below is a separate evaluation surface
until its behavior is accepted. Booky Boo can consume the same domain operations when
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
`defer_elapsed`. Historical feedback stays intact. A future selector must
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

## Recommendation preview

`POST /api/organizations/:organizationId/recommendations/preview` evaluates
current canonical records without executing an action, storing a task, changing
feedback, or recording an owner impression. Owner/admin authorization and the
underlying content/operations permissions apply before context enters reasoning.
Responses are private and not cached.

```json
{
  "goalIds": ["an-explicit-active-goal-id"],
  "availableMinutes": 20,
  "limit": 2
}
```

Omit `goalIds` to consider all active authored goals. Missing or foreign goals
return 404; an explicitly requested archived goal returns 409. Missing intent
produces `needs_context` with a targeted question. Available time remains
unknown when absent or null; zero produces `no_suggestion` without calling a
model. No operation has a manufactured duration, and the preview does not claim
an action fits a finite budget when effort is unknown.

An optional future `asOf` instant evaluates **current records at that clock**.
It does not reconstruct historical state or authorize future execution. Omit it
for the server's current time; past instants are refused. This allows evaluation
of stale inbound messages, expired deferrals and future commitments without
rewriting source timestamps or adding a test clock endpoint.

The response is `{preview}` with:

- A transient `previewId`, input `contextRevision`, `evaluatedAt` and exact
  authored `goals`. A preview is not proof an owner saw a recommendation.
- A decision: `recommendations`, `no_suggestion` or `needs_context`, a summary
  and any targeted questions.
- Recommendations containing a stable `operation:subjectId` identity, canonical
  evidence reference, cited goal IDs, the canonical capability, intended outcome,
  why-now interpretation and uncertainties. Rewording does not change identity.
- All considered references with deterministic eligibility and allowed goal IDs,
  including withheld work. Empty suggestions do not mean the business is done.
- Coverage, unknowns and reasoning metadata: policy version, actual model when
  called, elapsed milliseconds and token usage only when the provider reports it.

### Selection and lifecycle

The first bounded coverage is articles and guest conversations: up to 12 articles
and 24 conversations, with explicit `hasMore` flags. These capabilities apply
across business types. There is no vertical-specific recommendation list.
Article text and messages are bounded excerpts; integrations, other capabilities
and external business outcomes are outside this evidence coverage.

Canonical domain facts decide permissions, publication prerequisites and basic
conversation eligibility. Publication already recorded removes the publication
candidate. A later member reply waits for fresh inbound; failed or unconfirmed
delivery is exposed explicitly and never represented as successful delivery.
Archive, block, resolution and required recipient/invite state are respected.
Airbnb/provider preflight is not executed by a read-only preview and remains
explicitly unavailable for selection in this first slice.

Uncommitted inbound older than 14 days is withheld from autonomous discovery.
This is an **unvalidated preview policy**, not evidence of owner preference or
an assertion that younger messages must be answered. A noncancelled current or
future commitment receives separate consideration. Stays use their actual
checkout date in their timezone, separate from the inbox's mailbox grace.
Nothing deletes, resolves or archives a conversation as it ages out of preview.

Current dismissals and deferrals withhold their exact evidence reference. A
goal-scoped choice removes only that goal from the candidate's allowed goals;
another goal can supply a distinct reason to consider it. Corrections enter
reasoning as authored feedback, without silently modifying the authored goal.
Changed source evidence, a changed/archived goal or elapsed deferral uses the
same applicability function as the progress API.

### Reasoning boundary and failure behavior

The existing Today rules are the comparison baseline: their fixed ordering is
unaffected by authored goals. They remain in use by existing screens while the
preview is evaluated. A new keyword-to-task rule table would introduce an
additional intent taxonomy and mishandle negation or unfamiliar combinations.

The preview therefore uses deterministic eligibility followed by one grounded
Workers AI call to interpret natural-language intent over eligible evidence.
It uses the existing `AI` binding and Cloudflare's native
[JSON-schema response format](https://developers.cloudflare.com/workers-ai/features/json-mode/)
with the documented
[Llama 3.3 model](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/).
There is no agent engine, tool execution loop, generated task persistence or
second completion store. Model text is an interpretation, not owner-confirmed
intent, permission, publication approval or achieved business impact.

The application rejects unknown candidate IDs, ineligible candidates, duplicate
choices, invalid goal citations and schema-inconsistent output. Source content
is untrusted data. The full bounded context, intent and applicable feedback are
read again after inference, including when the decision proposes nothing. A
changed context returns 409 for a new preview. Execution still rechecks canonical
authorization and source revision through the existing operation.

The provider and application use the same discriminated decision schema:
recommendations contain actions and no questions, `no_suggestion` contains
neither, and `needs_context` contains questions and no actions. This prevents a
no-suggestion result from adding an unnecessary readiness question after work
is complete. Candidate action meaning comes only from canonical operations and
their existing MCP descriptions; a second review-oriented label must not turn
publication into a review task. Approval and readiness are prerequisites, while
actual publication requires the recorded published state.

A missing AI binding is 503. Inference errors fail visibly; invalid or
ungrounded model output is 502. No rules fallback manufactures a recommendation
after an inference failure. Oversized reasoning context produces `needs_context`
and reports the limitation without silently dropping evidence. These constraints
bound cost and latency; actual usage and runtime measurements accompany the
technical evaluation rather than being presented as a billing guarantee.

### Evaluation evidence

`tests/e2e/business-progress.spec.ts` compares the current Today baseline and
preview over the same disposable organization. It uses real CMS/MCP edits,
publication, contact, reply, inbound-message and consultation-booking operations,
plus the real AI binding. It records the authored cases, actual decisions,
latency and reported token usage as a Playwright attachment.

The cases exercise opposing natural-language priorities on the same available
work, zero available time, correction and dismissal, changed source evidence,
publication completion, new inbound, deferral expiry, and equally old
uncommitted versus future-commitment conversations. These are technical
behavioral evaluations inspired by the owner-reported active surfaces. They are
not owner/staff validation or evidence that a recommendation improved a business.

On 2026-10-26, the local production Worker and real AI binding passed both
focused tests, including seven model decisions under `recommendation-preview-v8`:

| Technical case | Actual decision | Domain elapsed time | Input/output tokens | Estimated model USD |
| --- | --- | ---: | ---: | ---: |
| Inbox is the only priority; article work can wait | Guest reply | 6.444 s | 2,188 / 131 | 0.000936 |
| Same records; publish the explicitly approved guide and leave inbox alone | Article publication | 6.119 s | 2,206 / 130 | 0.000939 |
| Publication waits for separate authorization; direct client reply is approved | Guest reply; publication withheld | 6.522 s | 2,385 / 135 | 0.001003 |
| New exact-evidence correction requires attorney review first | No suggestion; explains known hold | 2.986 s | 2,413 / 45 | 0.000808 |
| Review status explicitly unknown for the same revision | Needs context; asks whether review happened | 3.245 s | 2,418 / 75 | 0.000877 |
| Requested guide is now published; no other work requested | No suggestion | 3.536 s | 1,975 / 40 | 0.000669 |
| Fresh guest inbound and changed owner intent | Guest reply | 5.723 s | 2,031 / 135 | 0.000899 |

The current Today baseline kept the same attention/draft card IDs across the
goal change, with no model inference. The preview changed selection. The seven-call
median domain latency was 5.723 seconds; these timings include source reads and revalidation, not
network transit or representative production load. This is too little evidence
to claim a general relevance rate or latency distribution.

Token-only model estimates use the model page's published USD rates of 0.293
per million input tokens and 2.253 per million output tokens: approximately
USD 0.00613 for these seven successful calls (16,307 reported tokens). They exclude Worker/D1 charges,
development retries and account billing adjustments; no invoice was verified.

An earlier live prompt repeated the old publication-approval claim despite a
new correction. Other live evaluations exposed redundant questions after
completion, action labels that confused review with publication, and unknown
review status being treated as a known hold. Current corrections are supplied
first and supersede contradictory earlier goal claims. The final contract
distinguishes a known unmet prerequisite from a decision-changing unknown:
explain the former without another question and ask for the latter. Both cases
withhold publication and preserve the authored goal and draft. This demonstrates
why schema-valid output alone is insufficient and why new, withheld cases and
owner judgment remain necessary.

The mixed-action case also exposed early stopping at a blocked publication while
an independently approved reply was supported. Decision selection now evaluates
all candidates before choosing an overall state: supported work takes precedence,
clarification is needed only when no independent work is supported, and a known
hold alone does not suppress other useful actions.

The current owner-reported observations remain Kikuzuki inbox use and NCLS MCP
blog updates. Historical intake and product decisions add constraints, but no
current customer-approved goal, available-time budget or ranked decision episode
was located. Issue #1607 remains open for actual owner judgment, including
disagreement and withheld cases. Issue #1606 remains open for accepting policy,
broader evidence coverage and replacing the current Today selector. Issue #1608
remains open for the economy decision.
