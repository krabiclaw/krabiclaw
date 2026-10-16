# Member scheduling and Calendar

One existing Better Auth organization member may deliver each offering. Organization
availability is used when no member is assigned. Member hours, timezone, time off
and optional personal Google busy times feed the shared session allocator.

Existing bookings retain their member assignment. Whole-session reassignment checks
member availability and overlap atomically, audits the change and notifies guests
through the existing inbox workflow. Approved member profiles appear on public
product pages as “Who you’ll meet with”.

Better Auth owns identity, membership, linked Google accounts, scopes and tokens.
The application stores only scheduling and selected-calendar domain state.
The automatically managed business booking calendar is separate from each
member’s optional primary-calendar busy input. Calendar → Settings → Availability
uses focused shared dashboard indices and leaves for calendar connection, member
hours, time off, and public profile.

Calendar and member scheduling use the additive `0001_calendar_member_scheduling`
migration over the consultation/catalog foundation. Payment holds, Checkout, buyer
accounts, refunds and usage billing are added by the separate Payments PR.

## Staging integration review

The current Calendar branch includes staging through #1252, including the
consolidation of MCP definitions and handlers into their owning `mcp-tools`
domain modules. Local CodeRabbit
review identified five issues. Required reassignment fields and Calendar actions
are validated before mutation, notification receipts match the exact reassignment
key and operational booking ID within the targeted tenant, and the migration test
populates baseline data before applying the Calendar migration. A failed initial
member-settings read keeps the form unloaded and offers Retry loading availability;
unknown scheduling data cannot be saved as an empty schedule.

The HTTP/MCP booking assertions include explicit organization scheduling and null
member assignment. The native browser flow checks that malformed Calendar and
reassignment requests return 400 and leave the persisted schedule/booking unchanged.
The shared Better Auth callback also includes organization Calendar and member
availability screens; its return URL preserves the explicitly selected business.
The owner authorized and saved `http://localhost:3113/api/auth/callback/google`
on the existing OAuth client. Live Better Auth consent, callback routing, event
creation/update/cancellation, disconnect cleanup and member busy-calendar reads across the 94-day horizon
were exercised on October 4, 2026 against the built local Worker and the separate
private verification calendar. Those test events and connections were removed.
The redesigned CMS subsequently created the business's KrabiClaw calendar through
real consent, without calendar or export-policy choices. Desktop/mobile hours,
time-off sheets, profile edits and the personal Avoid double bookings switch were
exercised against the built Worker and read back through D1. The empty business
calendar remains for review; temporary member data was removed. The earlier
consent flow showed an unverified-app notice because Cloud Console retained an
unused sensitive `calendar.events` scope. On October 4 that scope was removed and
`calendar.app.created` declared to match the implementation. Console reports
branding and data access verified; all three Calendar scopes are non-sensitive.
No new Calendar verification video is required for this scope set. Exact evidence and
verification limits, including complete-cache preservation after a failed read,
are recorded in [Google Calendar](../integrations/google-calendar.md#review-and-validation).
