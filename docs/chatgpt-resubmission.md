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
| Reservation proposal | Ember & Slice / Brooklyn: existing regular table reservation for Directory Reviewer, future availability and controlled guest inbox | Original time held until guest acceptance; delivered one-hour-later proposal, one accepted change, reopening the guest link or repeating the proposal without duplicates |
| Finance reads | Ember & Slice's October payment state with an unconfigured Stripe account | Zero returned transactions and zero payouts, the unconfigured account state distinguished from a zero balance, authenticated dashboard setup link and no financial mutation |
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

Use existing app `asdk_app_6a2da16bb89c8191b37484641a83a20c`. The current
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
