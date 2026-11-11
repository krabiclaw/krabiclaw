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
| Shareable invite link (Better Auth invitations are email-bound) | `organization_invite_links` | server/utils/invite-links.ts | KrabiClaw |
| OAuth provider for MCP clients | `oauthClient` `oauthClientAssertion` `oauthResource` `oauthClientResource` `oauthConsent` `oauthAccessToken` `oauthRefreshToken` | Better Auth OAuth provider | Better Auth |
| KrabiClaw subscription | `subscription` | Better Auth Stripe | Better Auth Stripe |
| Onboarding draft | `onboarding_drafts` | server/utils/onboarding-drafts.ts | KrabiClaw |
| Place (a branch or a home's address and clock) | `business_locations` | server/utils/location-management.ts | KrabiClaw |
| Catalog | `products` `product_variants` `product_publications` `product_locations` `collections` `collection_products` | server/utils/product-management.ts | KrabiClaw (Stripe-shaped) |
| Price (offers, table deposits, weekend rates and dated nightly overrides) | `prices` | server/utils/product-management.ts | KrabiClaw |
| How a product is booked, and who handles it (a session's seats, a table's seatings or a home's nights; party limits, guest terms and what online payment is charged for) | `product_booking_configs` | server/utils/availability.ts | KrabiClaw |
| Home description and arrival guide | `product_stay_configs` | server/domain/stays.ts | KrabiClaw |
| When a product can be booked (a class's weekly start times; a table has none, its open time is its location's hours) | `product_availability_rules` | server/utils/availability.ts | KrabiClaw |
| Timed inventory | `product_sessions` | server/utils/availability.ts | KrabiClaw |
| Night inventory | `product_nights` | server/domain/stays.ts | KrabiClaw |
| Night claim (the nights a booking, a checkout hold or a linked calendar holds at a home, as a session's seats are a slot booking's claim) | `stay_nights` | server/domain/stays.ts | KrabiClaw |
| Home rooms and accessibility | `product_stay_photo_rooms` `product_stay_photo_room_memberships` `product_stay_photo_room_amenities` `product_stay_room_accessibility` `product_stay_room_accessibility_photos` `product_stay_accessibility` `product_stay_accessibility_photos` | server/domain/stays.ts | KrabiClaw |
| Booked record (a class seat, a consultation, a table or a stay at a home, with the terms frozen when it was made) | `bookings` | server/domain/product-bookings.ts | KrabiClaw |
| Conversation (a guest's with the business, or the team's: direct, group or a job's), each person's read position and archive, and its messages from people and from KrabiClaw | `conversations` `conversation_participants` `messages` | server/domain/conversations.ts | KrabiClaw |
| Audit log (who changed what in an organization) | `activity_entries` | server/utils/organization-events.ts | KrabiClaw |
| Delivery of a message, an audited event or a task to a person (email, WhatsApp, Airbnb, push) | `guest_thread_deliveries` | server/domain/guest-threads/deliveries.ts | KrabiClaw |
| Guest message template | `message_templates` | server/domain/scheduled-guest-messages.ts | KrabiClaw |
| Future guest message, one outbox (a booking's automatic messages and a member's own send-later replies, one status machine) | `scheduled_guest_messages` | server/domain/scheduled-guest-messages.ts | KrabiClaw |
| Reported content | `content_reports` | server/domain/content-reports.ts | KrabiClaw |
| Work and suggestions | `tasks` `opportunities` `organization_goals` | server/domain/tasks.ts | KrabiClaw |
| Provider working hours | `member_scheduling` | server/domain/member-scheduling.ts | KrabiClaw |
| Media | `media_assets` `media_placements` | server/utils/media-placement.ts | Cloudflare Images |
| Website content | `content_documents` `content_blocks` `article_categories` `article_category_articles` `organization_redirects` | server/utils/content | KrabiClaw |
| Localization | `resource_localizations` `organization_locales` | server/utils/localization.ts | KrabiClaw |
| Custom domain | `organization_domains` | server/utils/domains.ts | Cloudflare |
| Public cache invalidation | `public_resource_cache_invalidations` | server/utils/public-resource-cache.ts | Cloudflare |
| Social post publication | `post_publications` | server/utils/social-publication.ts | Meta |
| Article email | `broadcasts` | server/domain/article-broadcast.ts | Resend |
| Reviews | `reviews` `review_requests` `review_category_ratings` | server/utils/review-requests.ts | KrabiClaw |
| Payments | `payments` `payment_refunds` `payment_disputes` `payment_orders` `payment_order_lines` `payment_authorizations` `payment_checkout_holds` `offline_payments` `payment_fee_reports` `payment_cost_snapshots` `payment_servicing_tenants` `stripe_connected_accounts` `stripe_connected_customers` `stripe_webhook_events` `payment_usage_events` | server/domain/payments | Stripe |
| Channex channel | `channex_connections` `product_channel_mappings` `channel_threads` `channel_night_pushes` `channel_sync_log` `airbnb_sync_jobs` | server/integrations/channex | Channex |
| Imported iCal calendar | `stay_calendar_links` | server/domain/stays.ts | KrabiClaw |
| Google Calendar | `google_calendar_setup` `google_calendar_event_links` `google_calendar_cleanup_jobs` | server/utils/google-calendar.ts | Google |
| Connected service selection | `organization_integrations` `organization_services` | server/utils/organization-integrations.ts | Better Auth linked accounts |
| Push device | `device_tokens` | server/domain/devices.ts | APNs / Web Push |
| Notification preference | `user_notification_preferences` | server/domain/notification-preferences.ts | KrabiClaw |
| Workspace state | `user_workspace_state` | server/utils/mcp-context.ts | KrabiClaw |
| Analytics | `analytics_events` `analytics_summaries` | server/utils/analytics-report.ts | KrabiClaw |
| MCP tool audit | `mcp_tool_call_events` | server/utils/mcp-protocol.ts | KrabiClaw |
| Metered usage | `usage_events` | server/utils/usage-metering.ts | Stripe meters |

## Single-owner columns

Each of these columns exists on its owner table only.

| Column | Owner |
|---|---|
| `assigned_member_id` | `product_booking_configs` `tasks` |
| `party_size` | `bookings` |
| `no_show_at` | `bookings` |
| `cancellation_reason` | `bookings` |
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
| A restaurant's tables | its location's `opening_hours` and `special_hours`, seated every `seating_interval_minutes` while `duration_minutes` still ends by closing (`tableSeatings` in server/utils/availability.ts). Every writer of a location's hours regenerates its seatings in the same batch; booked seatings keep their time |
| An online offering | its provider's working hours (`member_scheduling.weekly_json`) |
| A home | every night, at its nightly price, unless a `product_nights` row says otherwise |

| Blocked time | What it means |
|---|---|
| `business_locations.special_hours` (a closure, or a date's own hours) | The place is shut or keeps other hours that day. No in-person session there is offered outside them, and a table's unbooked seatings are cancelled |
| `product_nights.closed` (and closed to arrival or departure) | A home's night is not offered to guests or channels. It is the home's night inventory, not its location's hours |
| `member_scheduling.time_off_json` | A person is away. No online slot of theirs is generated in that time |
| `product_sessions.status = 'cancelled'` | One occurrence of a class or consultation was cancelled. A table's seating is never cancelled by hand: it is cancelled only when its location's hours stop covering it |
| `stay_nights` with `calendar_link_id` | Another site's calendar holds the night. It is a claim on the night, not a rule about it |
