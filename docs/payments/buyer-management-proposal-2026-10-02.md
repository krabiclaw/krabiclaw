# Buyer management implementation and verification — 2026-10-02

**Historical verification record.** The no-automatic-refund behavior recorded
below describes the October 2 implementation and its local proof. It is
superseded by the owner's October 16 decision: guest cancellation of a paid table
reservation automatically refunds the remaining deposit unless its saved
cancellation deadline has passed; a saved null cutoff means no deadline. See the
current contract in [payments.md](./payments.md). The observations below do not
verify that later behavior.

Implementation continues `feat/1169-payments` / PR #1213 from d5b90a3347ce416a5b0c937bfcc90f19fb90b761. Parent authorized authenticated cancellation and merchant change-request contact handoff. Final commit is provided in the task handoff.

## Canonical implementation

`/account` now cancels eligible owned bookings/reservations through the existing `cancelBookingRequest` writer and notification pipeline. Better Auth supplies the buyer identity; both request and operational record must belong to that buyer and the same explicit organization/kind. Public guest-token cancellation retains its token hash/expiry checks. No cancellation token is minted, reconstructed or replaced for account access.

Eligibility remains pending/confirmed, not ended/completed, with unspent canonical cancellation state. Stored descriptive cutoff/fee terms are not represented as an executable policy engine. Cancellation releases operational capacity, consumes canonical cancellation state and writes one audit entry atomically. Captured principal and refund authority are preserved. The page explicitly states that cancellation does not automatically refund a payment.

A valid retry returns the same existing cancellation outcome and retries the existing deduplicated notification delivery. Wrong ownership, organization, guest token or expiry still fails. This closes recovery when the cancellation persisted but its notification failed.

Rescheduling uses exact merchant email/phone handoff: an explicitly associated active location supplies its own contact; an online booking uses its owning organization contact. Missing contacts remain visibly unavailable. Existing host change proposals remain host-authorized. Direct buyer slot selection and automatic refunds are not implemented or claimed.

Account visit responses omit internal request payload/token/notes; the authenticated response is private/no-store. The existing standalone application layout supplies Nuxt UI styling; account is excluded from public stylesheet preloads.

## Actual local proof

Built Worker `http://localhost:3210`, existing isolated D1 `.tmp/payments-review-state`, Node 24.18.1. Authenticated existing synthetic users via Better Auth. The local fixture introduces no native provider objects or credentials.

- Focused D1 tests: 2/2 pass. Dual ownership, exact organization, ended eligibility, concurrent cancellation/replay, one audit mutation, captured 10000/refunded 0 and no refund call.
- Browser: ownership rejection 404, missing Origin 403, ended visit 409; exact organization/location email contacts; cancellation confirmation and reservation cancellation through UI; account readback shows both cancelled and payment still captured 10000/refunded 0.
- Initial booking UI request persisted cancellation but returned 500: the fixture had omitted canonical opening activity entries required for owner notification. Fixed the fixture and repaired only those missing entries in local synthetic data. Did not reset/reseed the booking. Explicit recovery run on the same cancelled booking passed, including deduplicated notification delivery and reservation UI cancellation.
- Independent native D1 read: one booking.cancel and one reservation.cancel audit entry; each has exactly one email owner_alert and status_update delivery, all sent via log_only; cancellation used_at set for both while the ended request remains unspent; payment state captured, captured_amount 10000, refunded_amount 0.
- Screenshot review found account had no application layout. Fixed by reusing standalone. A final built Worker read-only browser snapshot checks the application stylesheet, styled heading, persisted cancellation state, exact contact and unchanged principal. Screenshot: `artifacts/payments-buyer-management.png`.
- Final build, scoped ESLint and git diff whitespace checks pass. Metronome response tests 2/2 pass. These local proofs do not qualify native Stripe collection.

The one-time buyer proof spec and bespoke SQL fixture were removed under #1225. Use the canonical local setup and the actual account page for manual verification. Historical observations above remain limited to their recorded synthetic environment.

## Current account presentation correction

/account now preserves existing URLs and Checkout returns while leading to the existing My account → Purchases & bookings leaf. It reuses dashboard navigation and panels, gives truthful empty states, and removes the manual transfer-code UI/API/writer. Purchases follow the authenticated Better Auth user across devices; guest sign-in linking remains Better Auth-owned. Hidden native-verified Checkout-return proofs remain separate from normal account use. The old standalone screenshot above is historical and was insufficient UI qualification.
