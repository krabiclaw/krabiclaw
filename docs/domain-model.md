# Domain model

Every business concept has one model. This page names it. `scripts/check-domain-model.mjs`
reads the tables below and fails CI when:

- a table in `server/db/schema.ts` is not listed under exactly one concept;
- a table under **Retiring** still exists;
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
| Catalog | `products` `product_variants` `prices` `product_publications` `product_locations` `collections` `collection_products` | server/utils/product-management.ts | KrabiClaw (Stripe-shaped) |
| How a product is booked, and who handles it (a session's seats or a home's nights) | `product_booking_configs` | server/utils/availability.ts | KrabiClaw |
| Home description and arrival guide | `product_stay_configs` | server/domain/stays.ts | KrabiClaw |
| When a product can be booked | `product_availability_rules` | server/utils/availability.ts | KrabiClaw |
| Timed inventory | `product_sessions` | server/utils/availability.ts | KrabiClaw |
| Night inventory | `product_nights` | server/domain/stays.ts | KrabiClaw |
| Home rooms and accessibility | `product_stay_photo_rooms` `product_stay_photo_room_memberships` `product_stay_photo_room_amenities` `product_stay_room_accessibility` `product_stay_room_accessibility_photos` `product_stay_accessibility` `product_stay_accessibility_photos` | server/domain/stays.ts | KrabiClaw |
| Booked record | `bookings` | server/domain/product-bookings.ts | KrabiClaw |
| Conversation and its ledger | `requests` `activity_entries` | server/domain/requests.ts | KrabiClaw |
| Guest message delivery | `guest_thread_deliveries` | server/domain/guest-threads/deliveries.ts | KrabiClaw |
| Guest message template | `message_templates` | server/domain/scheduled-guest-messages.ts | KrabiClaw |
| Future guest message | `scheduled_guest_messages` | server/domain/scheduled-guest-messages.ts | KrabiClaw |
| Team conversation | `team_threads` `team_thread_members` `team_messages` | server/domain/team-messages.ts | KrabiClaw |
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
| Payments | `payments` `payment_refunds` `payment_disputes` `payment_orders` `payment_order_lines` `payment_authorizations` `payment_checkout_holds` `payment_fee_reports` `payment_cost_snapshots` `payment_servicing_tenants` `stripe_connected_accounts` `stripe_connected_customers` `stripe_webhook_events` `payment_usage_events` | server/domain/payments | Stripe |
| Channex channel | `channex_connections` `product_channel_mappings` `channel_threads` `channel_night_pushes` `channel_sync_log` `airbnb_sync_jobs` | server/integrations/channex | Channex |
| Imported iCal calendar | `stay_calendar_links` | server/domain/stays.ts | KrabiClaw |
| Google Calendar | `google_calendar_setup` `google_calendar_sync` `google_calendar_event_links` `google_calendar_cleanup_jobs` | server/utils/google-calendar.ts | Google |
| Connected service selection | `organization_integrations` `organization_services` | server/utils/organization-integrations.ts | Better Auth linked accounts |
| Push device | `device_tokens` | server/domain/devices.ts | APNs / Web Push |
| Notification preference | `user_notification_preferences` | server/domain/notification-preferences.ts | KrabiClaw |
| Workspace state | `user_workspace_state` | server/utils/mcp-context.ts | KrabiClaw |
| Analytics | `analytics_events` `analytics_summaries` | server/utils/analytics-report.ts | KrabiClaw |
| MCP tool audit | `mcp_tool_call_events` | server/utils/mcp-protocol.ts | KrabiClaw |
| Metered usage | `usage_events` | server/utils/usage-metering.ts | Stripe meters |

## Retiring

Each of these tables is a second model of a concept above. The check fails until it is gone.

| Table | Concept it duplicates |
|---|---|
| `stays` | Booked record |
| `reservations` | Booked record |
| `stay_nights` | Night inventory |
| `location_reservation_configs` | How a product is booked, and who handles it |
| `stay_payments` | Payments |
| `send_later_messages` | Future guest message |

Two single-owner columns below still name a retiring owner, until it goes:

- `stays.cancellation_policy` is the policy frozen on a booked stay when it was
  taken; it goes with `stays` into the booked record.
- `business_locations.assigned_member_id` is who handles a location's table
  reservations; it goes with `location_reservation_configs`.

## Single-owner columns

Each of these columns exists on its owner table only.

| Column | Owner |
|---|---|
| `assigned_member_id` | `product_booking_configs` `tasks` `business_locations` |
| `party_size` | `bookings` |
| `no_show_at` | `bookings` |
| `cancellation_reason` | `bookings` |
| `duration_minutes` | `product_booking_configs` |
| `advance_notice_minutes` | `product_booking_configs` |
| `questions` | `product_booking_configs` |
| `check_in_time` | `product_booking_configs` |
| `check_out_time` | `product_booking_configs` |
| `min_nights` | `product_booking_configs` |
| `cancellation_policy` | `product_booking_configs` `stays` |
| `guest_name` | (none) |
| `guest_email` | (none) |
| `guest_phone` | (none) |
