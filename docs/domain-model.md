# Domain model

Every business concept has one model. This page names it. `scripts/check-domain-model.mjs`
reads the tables below and fails CI when:

- a table in `server/db/schema.ts` is not listed under exactly one concept;
- a single-owner column appears on any table other than its owner;
- a `UNION ALL` in `server/` whose branches read two different tables of one concept.

To add a table or column, name its concept here. When a concept already has a model,
extend that model. Never add a second one beside it.

## Concepts

| Concept | Tables | Module | Owner |
|---|---|---|---|
| Identity and sessions | `user` `session` `account` `verification` `jwks` `rate_limits` | Better Auth | Better Auth |
| Organization and membership | `organization` `member` `invitation` | Better Auth organization plugin | Better Auth |
| OAuth provider for MCP clients | `oauthClient` `oauthClientAssertion` `oauthResource` `oauthClientResource` `oauthConsent` `oauthAccessToken` `oauthRefreshToken` | Better Auth OAuth provider | Better Auth |
| KrabiClaw subscription | `subscription` | Better Auth Stripe | Better Auth Stripe |
| Onboarding draft | `onboarding_drafts` | server/utils/onboarding-drafts.ts | KrabiClaw |
| Unfinished home setup | `stay_home_setup_drafts` | server/utils/stay-home-setup-draft.ts | KrabiClaw |
| Place (a branch or a home's address and clock) | `business_locations` | server/utils/location-management.ts | KrabiClaw |
| Catalog | `products` `product_variants` `product_publications` `product_locations` `collections` `collection_products` | server/utils/product-management.ts | KrabiClaw (Stripe-shaped) |
| Price (offers, table deposits, weekend rates and dated nightly overrides) | `prices` | server/utils/product-management.ts | KrabiClaw |
| How a product is booked, and who handles it (a session's seats, a table's seatings or a home's nights; party limits, guest terms and what online payment is charged for) | `product_booking_configs` | server/utils/availability.ts | KrabiClaw |
| Home description and arrival guide | `product_stay_configs` | server/domain/stays.ts | KrabiClaw |
| When a product can be booked (a class's weekly start times; a table has none, its open time is its location's hours) | `product_availability_rules` | server/utils/availability.ts | KrabiClaw |
| Timed inventory (a time someone booked, edited or cancelled; open times are computed) | `product_sessions` | server/utils/availability.ts | KrabiClaw |
| Night inventory | `product_nights` | server/domain/stays.ts | KrabiClaw |
| Night claim (one booking's claim to one night at a home) | `stay_nights` | server/domain/stays.ts | KrabiClaw |
| Home rooms and accessibility | `product_stay_photo_rooms` `product_stay_photo_room_amenities` `product_stay_room_accessibility` `product_stay_accessibility` | server/domain/stays.ts | KrabiClaw |
| Booked record (a class seat, a consultation, a table or a stay at a home, with the terms frozen when it was made) | `bookings` | server/domain/product-bookings.ts | KrabiClaw |
| Conversation, its participant roster, each participant's read position and archive, and its messages from people and from KrabiClaw | `conversations` `conversation_participants` `messages` | server/domain/conversations.ts | KrabiClaw |
| Invitation for a guest account to join one conversation | `conversation_guest_invites` | server/domain/conversation-participants.ts | KrabiClaw |
| Permission for a workspace member to participate in guest conversations for one listing | `listing_message_members` | server/domain/conversation-participants.ts | KrabiClaw |
| Audit log (who changed what in an organization) | `activity_entries` | server/utils/organization-events.ts | KrabiClaw |
| Delivery of a message, an audited event or a task to a person (email, WhatsApp, Airbnb, push) | `guest_thread_deliveries` | server/domain/guest-threads/deliveries.ts | KrabiClaw |
| Guest message template | `message_templates` | server/domain/scheduled-guest-messages.ts | KrabiClaw |
| Future message, one outbox (a booking's automatic messages, a member's own send-later replies, and a job's reminders or a task's start alert by `task_id`; one status machine, one sender) | `scheduled_guest_messages` | server/domain/scheduled-guest-messages.ts | KrabiClaw |
| Reported content | `content_reports` | server/domain/content-reports.ts | KrabiClaw |
| Work (one prep per assigned slot session, one follow-up per booking) | `tasks` | server/domain/tasks.ts | KrabiClaw |
| Provider working hours | `member_scheduling` | server/domain/member-scheduling.ts | KrabiClaw |
| Media and its placements, including a home’s photo rooms and accessibility evidence | `media_assets` `media_placements` | server/utils/media-placement.ts | Cloudflare Images |
| Website content and localized representations | `content_documents` `content_blocks` `article_categories` `article_category_articles` `organization_redirects` | server/utils/content | KrabiClaw |
| Site languages | `organization_locales` | server/utils/organization-languages.ts | KrabiClaw |
| Custom domain | `organization_domains` | server/utils/domains.ts | Cloudflare |
| Public cache invalidation | `public_resource_cache_invalidations` | server/utils/public-resource-cache.ts | Cloudflare |
| Social post publication | `post_publications` | server/utils/social-publication.ts | Meta |
| Article email | `broadcasts` | server/domain/article-broadcast.ts | Resend |
| Reviews | `reviews` `review_requests` `review_category_ratings` | server/utils/review-requests.ts | KrabiClaw |
| Payments | `payments` `payment_refunds` `payment_disputes` `payment_orders` `payment_order_lines` `payment_authorizations` `payment_checkout_holds` `offline_payments` `payment_fee_reports` `payment_cost_snapshots` `payment_servicing_tenants` `stripe_connected_accounts` `stripe_connected_customers` `stripe_webhook_events` | server/domain/payments | Stripe |
| Channex channel | `channex_connections` `product_channel_mappings` `channel_threads` `channel_night_pushes` `channel_sync_log` `airbnb_sync_jobs` | server/integrations/channex | Channex |
| Google Calendar event delivery | `google_calendar_event_links` `google_calendar_cleanup_jobs` | server/utils/google-calendar.ts | Google |
| Connected provider selection | `organization_integrations` | server/utils/organization-integrations.ts | Better Auth linked accounts |
| Service agreement | `organization_services` | server/utils/organization-services.ts | KrabiClaw |
| Push device | `device_tokens` | server/domain/devices.ts | APNs / Web Push |
| Notification preference | `user_notification_preferences` | server/domain/notification-preferences.ts | KrabiClaw |
| Workspace state | `user_workspace_state` | server/utils/mcp-context.ts | KrabiClaw |
| Analytics (visits, conversions, and the day counts the visit write keeps for Insights) | `analytics_events` `analytics_summaries` | server/utils/pageview-tracking.ts | KrabiClaw |
| MCP tool audit | `mcp_tool_call_events` | server/utils/mcp-protocol.ts | KrabiClaw |
| Usage (application activity and quantities billed through Stripe meters) | `usage_events` | server/utils/usage-metering.ts | KrabiClaw and Stripe |

## Single-owner columns

Each of these columns exists on its owner table only.

| Column | Owner |
|---|---|
| `assigned_member_id` | `product_booking_configs` `tasks` |
| `party_size` | `bookings` |
| `no_show_at` | `bookings` |
| `cancellation_reason` | `bookings` |
| `website_source` | `bookings` |
| `duration_minutes` | `product_booking_configs` |
| `seating_interval_minutes` | `product_booking_configs` |
| `advance_notice_minutes` | `product_booking_configs` |
| `questions` | `product_booking_configs` |
| `party_size_min` | `product_booking_configs` |
| `party_size_max` | `product_booking_configs` |
| `minimum_guest_age` | `product_booking_configs` |
| `accessibility_contact_required` | `product_booking_configs` |
| `payment_basis` | `product_booking_configs` |
| `payment_min_party_size` | `product_booking_configs` |
| `policy_json` | `bookings` |
| `check_in_time` | `product_booking_configs` |
| `check_out_time` | `product_booking_configs` |
| `min_nights` | `product_booking_configs` |
| `cancellation_policy` | `product_booking_configs` |
| `last_read_message_id` | `conversation_participants` |
| `blocked_at` | `conversations` |
| `guest_name` | (none) |
| `guest_email` | (none) |
| `guest_phone` | (none) |

## Open and blocked time

Each offering has one source of open time, and each kind of blocked time below
means something the others do not.

| Offering | Its open time |
|---|---|
| A class or an in-person consultation | its weekly start times (`product_availability_rules`) and dated sessions, inside its location's hours |
| A restaurant's tables | its location's `opening_hours` and `special_hours`, seated every `seating_interval_minutes` while `duration_minutes` still ends by closing (`tableSeatings` in server/utils/availability.ts). Open seatings are computed from the hours. A booked seating has a `product_sessions` row and keeps its time. |
| An online offering | its provider's working hours (`member_scheduling.weekly_json`) |
| A home | every night, at its nightly price, unless a `product_nights` row says otherwise |

One reader answers "what is open and how many places are left" for every
offering booked by time: `readSlots` in server/utils/availability.ts. In one D1
batch it reads, for the offerings and the requested window only, the rules and
hours above, the saved sessions and their bookings, and the provider's other
bookings. Places left are capacity less the places used by pending and
confirmed bookings. When the offering's member checks a
Google calendar, Google's freeBusy is asked once per read: Google does not tell
KrabiClaw when that calendar changes. The booking page, the product page, the
host Calendar, the offering editor, the MCP session tools and the move options
all read it. A location's opening hours have one writer, `updateLocation`,
which the Google Maps import also goes through.

| Blocked time | What it means |
|---|---|
| `business_locations.special_hours` (a closure, or a date's own hours) | The place is shut or keeps other hours that day. No in-person session or table seating there is offered outside them |
| `product_nights.closed` (and closed to arrival or departure) | A home's night is not offered to guests or channels. It is the home's night inventory, not its location's hours |
| `member_scheduling.time_off_json` | A person is away. No online slot of theirs is offered in that time |
| `product_sessions.status = 'cancelled'` | One occurrence of a class or consultation was cancelled. A table's seating is never cancelled by hand: it stops being offered when its location's hours stop covering it |
| `stay_nights.booking_id` | A booking claims the night. Only one booking can claim each home and date. |

Paid checkout keeps the conversation, party size, conversion status and the
approved stay's payment lock in `payment_checkout_holds`. At Pay, the batch
that saves the booking claims its nights or places before the payment is
captured. A stay request already owns its nights while the host reviews it and
while the guest has time to pay after approval.
