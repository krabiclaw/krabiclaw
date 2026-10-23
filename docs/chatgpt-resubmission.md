# KrabiClaw resubmission — issue #1302

The rejection email identifies tool naming and description quality. The other
changes in this PR address independently found bugs and the owner's submission
scope. The email identifies no individual tool or phrase, usage threshold, or
tool-count limit.

The retained catalog includes booking management and financial reporting. MCP
does not prepare or execute refunds or create Checkout. Required online
collection and paid booking cancellation/rejection return an incomplete
authenticated dashboard handoff before financial writes. Dashboard payment,
approval, refund execution and interrupted-operation recovery remain available.

The proposed catalog retains four explicit Google Ads tools and removes the
combined launcher and partial clone. Page creation describes its additive
behavior and preserves omitted source identity when creating a translation.
Translations inherit page order; the dashboard can author configured draft
languages before publication. Page translation fields now come from the same
block registry as the content contract, including secondary button and accent
text. Empty translated experience catalogs use their existing 404 contract
before checking for branding. Incoming background-sync changes also require
MCP product edits to disclose their Airbnb listing effects. Bulk product tools
now accept the canonical stay settings required to create a home, and private
arrival-guide edits preserve their full channel receipt and Airbnb editor
advisories. Photo-tour and accessibility tools identify their local scope.
These source changes require deployed verification before they count as
production review evidence.

## Prepared reviewer data

Prepare these independently through the existing dashboard and guest workflows
before recording. These names in the submission cases describe required sample
records; generating the submission JSON does not create them or prove they exist.
Keep credentials and the controlled guest inbox in the secure review form.

The copied review database already contains Ember & Slice table reservation
configuration at Brooklyn and West Village, and three published Brooklyn
experiences: Pizza Making Class, Family Pizza Night, and Natural Wine & Pizza
Night. All three use instant confirmation with online payment disabled. They
establish that the restaurant demo supports both workflows, but do not replace
the independent review-confirmation and required-payment samples below. Check
each location's saved timezone before preparing dates; the current Ember & Slice
configuration uses `America/New_York` for both Brooklyn and West Village.
Confirm the intended demo timezone through the dashboard.

| Case | Required independent data | Evidence to capture |
| --- | --- | --- |
| Price edit | Ember & Slice / Brooklyn: Margherita at $18, with West Village remaining at $18 | Before/after product IDs and prices; public menu with Brooklyn at $19 and West Village at $18, while the Brooklyn photo, description and Featured status remain unchanged; separate cleanup restores Brooklyn to $18 |
| Attachment announcement | A real attached photo and a separate website announcement | Correct saved asset, text, working public URL, website-only publication |
| Booking and confirmation | Ember & Slice / Brooklyn: Review Tasting Experience, a future available session, review confirmation, no required online collection, controlled guest inbox | One booking, correct guest/session/capacity, one acknowledgement and one confirmation, retry without duplicates |
| Reservation proposal | Ember & Slice / Brooklyn: actual table policy, future availability and controlled reviewer contact details; create the review reservation through MCP | Original time held until guest acceptance; delivered one-hour-later proposal, one accepted change, reopening the guest link preserves accepted state; cancel after verification |
| Finance reads | Ember & Slice's October payment state with an unconfigured Stripe account | Zero returned transactions, explicitly unavailable balance and payout history, authenticated dashboard setup link and no financial mutation |
| Refund/transfer refusal | Ember & Slice with an unconfigured Stripe account and no matching payment or balance | No invented payment; authenticated setup handoff when applicable; no refund authorization/execution/transfer on retry |
| Required online collection | Ember & Slice / Brooklyn: Review Online Tasting, paid variant, required online collection, future available session | Working dashboard URL; no booking/order/payment/Checkout/hold/authorization/queued write; configuration preserved on retry |
| Foreign record refusal | Existing booking in a separate organization with no reviewer membership | Denial without customer data, mutation or alternate-tenant substitution |

Do not replace missing fixtures with invented financial rows or claim an empty
payment report demonstrates transaction and payout history. Verify reviewer
login without MFA, email/SMS codes, magic links or private-network steps.

## Production walkthrough

After the staging PR is merged and the tested changes are promoted to production:

1. Record the deployed commit, `https://krabiclaw.com/api/mcp`, catalog fingerprint
   and exact discovered tool names. Compare the deployed catalog with the
   committed snapshot.
2. In the installed development plugin, open **Manage**, choose **Refresh
   tools**, and start a new chat. Verify that its calls match the deployed
   schemas. Uninstalling and reinstalling alone did not refresh the tool
   definitions in the live walkthrough. Separately verify normal login and
   the expanded OAuth disclosure through a fresh connection.
3. Run the five positive and three negative cases independently with prepared
   data. Also repeat #1259's uploaded-menu-image price-edit workflow and the
   direct, indirect and negative selection prompts in
   `mcp-metadata-evaluation.md`.
4. Record the real ChatGPT conversation while testing. Use ordinary requests
   such as “Change the large coffee to 85 baht” and “Keep it off Facebook and
   Instagram.” Confirm writes naturally. Verify results in the website,
   dashboard and controlled guest inbox.
5. If an operation fails, discard that take, fix the bug through staging, promote
   the fix, refresh tools and rerun the affected cases. The final walkthrough
   must show the actual submitted behavior. Record its version, tested commit,
   case outcomes and accessible recording URL.

## Existing submission and portal checks

Use the owner's current managed draft
`plugin_asdk_app_6accb97bbe148191a40020f843575141`, associated with app
`asdk_app_6accb97bbe148191a40020f843575141`. The rejected October 1 submission
was app `asdk_app_6a2da16bb89c8191b37484641a83a20c`; do not create another app
or move the configured production endpoint between them. The current
[submission flow](https://developers.openai.com/plugins/deploy/submission)
uses a complete plugin ZIP, tool scans and review details. If the app uses the
previous form, download its existing release ZIP first and preserve all required
components. The generated `chatgpt-app-submission.json` is the repository's
review source; it is not evidence that the portal imported or reviewed it.

Map its five `test_cases` and three `negative_test_cases` to the existing
package's `review.test_cases.positive` and `.negative`, using `prompt` for
`user_prompt` and `expected_behavior` for `expected_output`. Add the accessible
demo recording URL and release notes, update the package version, upload the
complete ZIP to the same plugin, and inspect the imported materials. Enter
reviewer credentials only in the secure dashboard form.

Rescan the existing production server and inspect its actual discovered
definitions, shared instructions and findings. Resolve required issues and
verify the final five positive/three negative cases against the scanned version.
Record the package version, deployed commit, scan result, walkthrough version
and resubmission date. Approval remains pending the review decision.

Production ChatGPT selection, reviewer fixtures, video, paid-booking MCP
handoff/page verification and the portal rescan/resubmission remain pending
until those steps are actually executed. Local D1, browser and scripted MCP
checks support the PR; they do not satisfy these production review gates.

## Current review evidence

On October 23, 2026, authenticated OAuth discovery, PKCE, token exchange,
MCP initialize, 165-tool discovery, workspace context and organization reads
passed against the deployed production commit
`cbb3e59eed7e9eac81700dcce3e951233a1198d6` and staging commit
`d36dac084a65542d5f043f5a171ed194edbed361`. These are baseline checks of the
165-tool catalog, not deployed verification of this PR's 163-tool catalog.
The current Chrome portal draft
is version `0.1.3`, authorized and domain verified. Its fresh production scan
completed and shows ten tool findings. All ten saved definitions were inspected:
nine request further review without identifying a defect, and one questions
`create_site_page`'s non-destructive annotation. Its canonical operation adds a
page or translation and refuses existing document IDs and occupied paths; the
inherited update/move/replacement descriptions are corrected in this PR. Rescan
after that correction reaches production. A scan completion does not establish
approval or test-case success.

The dedicated reviewer credential still signs in without an email code and can
read Ember & Slice. Its saved workspace can point at another demo business:
review instructions must explicitly select Ember & Slice before the cases.
The Review Tasting Experience has review confirmation, no required online
collection and available future sessions. Review Online Tasting retains its
required online collection. Ember's October payment list is empty and its
seller Stripe account is not connected. `get_payments_usage.configured` describes
plan fee pricing, not the seller account connection, and must not be used to
infer payout availability.

The foreign private booking was independently read by its owner, denied to the
reviewer with a 404, and read unchanged by its owner afterward. This read-only
preflight does not establish execution of the negative ChatGPT prompt. Its exact
identifiers belong only in secure reviewer instructions.

The existing [OpenAI walkthrough](https://media.krabiclaw.com/review/2026-10-12/krabiclaw-live-walkthrough-85a20f3afc89.mp4)
and [Google Ads OAuth video](https://youtu.be/-ItMxoHlCus) are separate recordings.
The Google recording demonstrates consent, reporting and campaign changes;
it does not replace the current OpenAI review cases.

Staging also contains the Airbnb import change from
[#1542](https://github.com/krabiclaw/krabiclaw/pull/1542), which records a production
hold until the draft-aware iOS build ships. The owning iOS sessions are handling
that build. Complete MCP source validation independently, then verify the native
release evidence before promoting the combined staging branch.

The integrated staging base `760ba5b2d` also includes
[#1545](https://github.com/krabiclaw/krabiclaw/pull/1545)'s background sync and
listing-settings pushes. This audit found deterministic preflight, unchanged
settings, stop/sync ordering, reconnect and bounded-job completion defects in
those paths. The corrections pass the focused D1/provider cases, including
paid-host Stripe transport cancellation and terminal usage repair, and the
final local browser journeys pass bulk-home creation, arrival-guide schema and
independent readbacks, cleaner scope and photos. The live local catalog has
163 unique tools with exact generated metadata/schema equality. All 333 unit
tests, full typecheck, lint and the canonical build pass. The full current
189-case browser run and deployed verification remain required before promotion. Its staging Worker deployed, but
[run 39927646225](https://github.com/krabiclaw/krabiclaw/actions/runs/39927646225)
failed the published-guide check for two articles; read-only tenant rendering
was skipped. Do not record that run as a completed staging qualification.
