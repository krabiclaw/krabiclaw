import type { OrganizationSettings } from '../../shared/organization-settings'
import { INTEGRATION_PROVIDERS, NONPROFIT_STATUS_CANONICAL } from '../../shared/organization-settings'
import type { MediaCategory } from '~/shared/media-placement-contract'
import { sql } from "drizzle-orm"
import { sqliteTable, integer, text, real, unique, uniqueIndex, index, check, foreignKey, primaryKey } from "drizzle-orm/sqlite-core"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import type { CONTENT_DOCUMENT_KINDS } from "../../shared/content-registries"
import { NOTIFICATION_CATEGORIES, PUSH_ONLY_CATEGORIES, type NotificationCategory } from "../../shared/notification-categories"

export const account = sqliteTable("account", {
	id: text().primaryKey(),
	accountId: text().notNull(),
	providerId: text().notNull(),
	userId: text().notNull().references(() => user.id, { onDelete: "cascade" } ),
	accessToken: text(),
	refreshToken: text(),
	idToken: text(),
	accessTokenExpiresAt: integer({ mode: "timestamp" }),
	refreshTokenExpiresAt: integer({ mode: "timestamp" }),
	scope: text(),
	password: text(),
	createdAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
	updatedAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
}, (table) => [
	index("account_userId_idx").on(table.userId),
]);

export const business_locations = sqliteTable("business_locations", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	slug: text().notNull(),
	title: text().notNull(),
	address: text(),
	phone: text(),
	website_url: text(),
	maps_url: text(),
	latitude: real(),
	longitude: real(),
	opening_hours: text(),
	categories: text(),
	rating: real(),
	review_count: integer(),
	status: text().default("active").notNull(),
	last_synced_at: text(),
	description: text(),
	short_description: text(),
	special_hours: text(),
	price_level: text(),
	email: text(),
	google_place_id: text(),
	google_review_url: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	// The listing's own clock: every in-person session and reservation here is
	// offered and shown in it, whatever the guest's device says.
	timezone: text().notNull(),
	max_capacity: integer(),
	seo_title: text(),
	seo_description: text(),
	canonical_url: text(),
}, (table) => [
	check("business_locations_instants_check", sql`(last_synced_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at, '+0 days') IS last_synced_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	check("business_locations_address_check", sql`address IS NULL OR (json_valid(address) AND json_type(address) IS 'object' AND json_type(address, '$.regionCode') IS 'text' AND trim(address ->> '$.regionCode') <> '' AND json_type(address, '$.addressLines') IS 'array' AND json_array_length(address, '$.addressLines') > 0 AND (json_type(address, '$.languageCode') IS NULL OR json_type(address, '$.languageCode') IS 'text') AND (json_type(address, '$.locality') IS NULL OR json_type(address, '$.locality') IS 'text') AND (json_type(address, '$.sublocality') IS NULL OR json_type(address, '$.sublocality') IS 'text') AND (json_type(address, '$.administrativeArea') IS NULL OR json_type(address, '$.administrativeArea') IS 'text') AND (json_type(address, '$.postalCode') IS NULL OR json_type(address, '$.postalCode') IS 'text'))`),
	check("business_locations_categories_check", sql`categories IS NULL OR (json_valid(categories) AND json_type(categories) IS 'array')`),
	unique("business_locations_organization_id_slug_unique").on(table.organization_id, table.slug),
	// Parent key for the organization-scoped catalog relations (prices,
	// product_locations, availability rules, sessions, inventory levels,
	// reservation configuration) which scope by organization + location without
	// restating the site.
	unique("business_locations_organization_id_id_unique").on(table.organization_id, table.id),
	check("business_locations_opening_hours_check", sql`opening_hours IS NULL OR (json_valid(opening_hours) AND json_type(opening_hours) IS 'object' AND json_type(opening_hours, '$.periods') IS 'array')`),
	check("business_locations_special_hours_check", sql`special_hours IS NULL OR (json_valid(special_hours) AND json_type(special_hours) IS 'array')`),
	check("business_locations_timezone_check", sql`timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'`),
]);


// The inbox: one conversation thread with a guest, and its workflow state.
// Row meaning: someone contacted this site, and this is the thread.
// Owner/scope: organization + site; location_id routes the thread to a branch.
// This table does NOT own booking truth. It used to carry
//   (product_id, booking_date, time_slot, party_size, status) as an
//   independently writable copy of an occurrence; the occurrence is now a
//   product_sessions row, the seat claim a bookings row, and a table
//   reservation a reservations row. Each links back here through request_id.
//   A contact thread has neither and is not forced into the booking model.
// Null semantics: user_id NULL is a guest with no Better Auth user. review_id NULL means
//   no review was solicited from this thread. location_id NULL means the
//   thread is site-wide.
// Deletion: cascades from site; bookings and reservations survive with
//   request_id set to NULL, because losing an inbox thread must not lose a
//   seat allocation.
// Read/write: server/domain/requests.ts.
export const requests = sqliteTable("requests", {
 id: text().primaryKey(),
 // The inbox thread type. The OPERATIONAL record for a booking or a
 // reservation is the bookings / reservations row that links back here; this
 // column only says which kind of thread the inbox is showing. A contact
 // thread is not a degenerate booking and carries no booking columns.
 kind: text({ enum: ["contact", "booking", "reservation", "work"] }).notNull(),
 organization_id: text().references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
 location_id: text().references((): AnySQLiteColumn => business_locations.id, { onDelete: "set null" }),
 user_id: text().references((): AnySQLiteColumn => user.id, { onDelete: "set null" }),
 review_id: text().references((): AnySQLiteColumn => reviews.id, { onDelete: "set null" }),
 conversation_state: text({ enum: ["needs_attention", "waiting_on_guest", "resolved"] }),
 resolved_at: text(),
 // The tenant's explicit archive action, and who took it. Past/Current is
 // derived from the linked reservation or session's ends_at at runtime and is
 // never stored. Archiving is not conversation activity: it does not move
 // updated_at.
 archived_at: text(),
 archived_by_user_id: text().references((): AnySQLiteColumn => user.id, { onDelete: "set null" }),
 payload_json: text().notNull(),
 created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
 updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, table => [
	check("requests_instants_check", sql`(resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+0 days') IS resolved_at) AND (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at, '+0 days') IS archived_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
 foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "requests_location_scope_fk" }),
 check("requests_payload_check", sql`json_valid(payload_json) AND json_type(payload_json) = 'object'`),
	check("requests_guest_payload_check", sql`(
    (json_type(payload_json, '$.participant') IS NULL AND json_type(payload_json, '$.guest.name') IS 'text'
      AND (json_type(payload_json, '$.guest.email') IS 'text' OR (kind = 'stay' AND json_type(payload_json, '$.guest.email') IS 'null'))
      AND (json_type(payload_json, '$.guest.phone') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'null')
      AND (json_type(payload_json, '$.guest.email') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'text'))
    OR (kind = 'stay' AND json_type(payload_json, '$.participant') IS 'object'
      AND json_extract(payload_json, '$.participant.kind') IS 'channel'
      AND json_type(payload_json, '$.participant.title') IS 'text' AND trim(json_extract(payload_json, '$.participant.title')) <> ''
      AND json_type(payload_json, '$.guest') IS 'object'
      AND (json_type(payload_json, '$.guest.name') IS 'text' OR json_type(payload_json, '$.guest.name') IS 'null')
      AND (json_type(payload_json, '$.guest.email') IS 'text' OR json_type(payload_json, '$.guest.email') IS 'null')
      AND (json_type(payload_json, '$.guest.phone') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'null'))
  )`),
 check("requests_message_payload_check", sql`kind <> 'contact' OR json_type(payload_json, '$.message') IS 'text'`),
 check("requests_scope_check", sql`organization_id IS NOT NULL`),
 check("requests_state_check", sql`conversation_state IS NOT NULL`),
 uniqueIndex("requests_review_owner_unique").on(table.organization_id, table.id, table.kind),
 uniqueIndex("requests_scope_id_unique").on(table.organization_id, table.id),
 index("requests_org_activity_idx").on(table.conversation_state, table.updated_at),
 index("requests_org_kind_idx").on(table.kind, table.location_id, table.updated_at),
 index("requests_org_user_idx").on(table.organization_id, table.user_id),
 index("requests_org_archive_activity_idx").on(table.organization_id, table.archived_at, table.updated_at),
 index("requests_org_created_idx").on(table.organization_id, table.created_at),
 // Guest requests join the account whose verified email they were made with (#1282).
 index("requests_guest_email_idx").on(sql`lower(payload_json ->> '$.guest.email')`)
]);



export const activity_entries = sqliteTable("activity_entries", {
 id: text().primaryKey(),
 kind: text({ enum: ["submission", "message", "operation", "assignment", "resolution", "notification", "acknowledgement", "audit"] }).notNull(),
 scope_kind: text({ enum: ["request", "organization", "global"] }).notNull(),
 organization_id: text().references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
 location_id: text().references((): AnySQLiteColumn => business_locations.id, { onDelete: "set null" }),
 request_id: text().references((): AnySQLiteColumn => requests.id, { onDelete: "cascade" }),
 parent_id: text().references((): AnySQLiteColumn => activity_entries.id, { onDelete: "cascade" }),
 actor_kind: text({ enum: ["guest", "member", "system", "cloudflare"] }).notNull(),
 actor_user_id: text().references((): AnySQLiteColumn => user.id, { onDelete: "set null" }),
 target_user_id: text().references((): AnySQLiteColumn => user.id, { onDelete: "set null" }),
 channel: text({ enum: ["web", "email", "whatsapp", "airbnb", "system"] }),
 body: text(),
 event_name: text(),
 payload_json: text().default("{}").notNull(),
 dedupe_key: text().notNull().unique(),
 sequence: integer(),
 occurred_at: text().notNull(),
 created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, table => [
	check("activity_entries_instants_check", sql`(occurred_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') IS occurred_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)`),
 check("activity_entries_scope_check", sql`(scope_kind = 'request' AND request_id IS NOT NULL AND organization_id IS NULL AND location_id IS NULL) OR (scope_kind = 'organization' AND organization_id IS NOT NULL AND request_id IS NULL) OR (scope_kind = 'global' AND organization_id IS NULL AND request_id IS NULL)`),
 check("activity_entries_payload_check", sql`json_valid(payload_json) AND json_type(payload_json) = 'object'`),
 check("activity_entries_timeline_check", sql`(kind IN ('submission', 'message', 'operation', 'assignment', 'resolution') AND request_id IS NOT NULL AND sequence IS NOT NULL AND sequence > 0 AND scope_kind = 'request') OR (kind NOT IN ('submission', 'message', 'operation', 'assignment', 'resolution') AND sequence IS NULL)`),
 uniqueIndex("activity_entries_request_sequence_unique").on(table.request_id, table.sequence),
 uniqueIndex("activity_entries_notification_source_unique").on(table.parent_id).where(sql`kind = 'notification' AND parent_id IS NOT NULL`),
 index("activity_entries_request_occurred_idx").on(table.request_id, table.occurred_at),
 index("activity_entries_parent_actor_idx").on(table.parent_id, table.actor_user_id, table.occurred_at),
 index("activity_entries_context_organization_created_idx").on(table.kind, table.organization_id, table.created_at),
 index("activity_entries_kind_org_created_idx").on(table.kind, table.created_at),
 index("activity_entries_org_created_idx").on(table.kind, table.organization_id, table.created_at),
 index("activity_entries_target_created_idx").on(table.kind, table.target_user_id, table.created_at)
]);


export const guest_thread_deliveries = sqliteTable("guest_thread_deliveries", {
	id: text().primaryKey(),
	entry_id: text().notNull().references(() => activity_entries.id, { onDelete: "cascade" } ),
	channel: text().notNull(),
	provider: text().notNull(),
	purpose: text().notNull(),
	status: text().default("pending").notNull(),
	provider_message_id: text(),
	error: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("guest_thread_deliveries_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	uniqueIndex("guest_thread_deliveries_provider_message_unique").on(table.provider, table.provider_message_id).where(sql`provider_message_id IS NOT NULL`),
	index("guest_thread_deliveries_entry_status_idx").on(table.entry_id, table.status),
	check("guest_thread_deliveries_provider_check", sql`(channel = 'email' AND provider IN ('resend', 'log_only')) OR (channel = 'whatsapp' AND provider IN ('meta', 'log_only')) OR (channel = 'airbnb' AND provider = 'channex') OR (channel = 'push' AND provider = 'apns')`),
]);

// A host's single-use link that hands one guest conversation to whoever opens it
// and signs in. Only the token's SHA-256 is stored; a newer link revokes an open one.
export const guest_thread_invites = sqliteTable("guest_thread_invites", {
	id: text().primaryKey(),
	request_id: text().notNull().references(() => requests.id, { onDelete: "cascade" } ),
	token_hash: text().notNull(),
	created_by_user_id: text().references(() => user.id, { onDelete: "set null" } ),
	expires_at: text().notNull(),
	claimed_at: text(),
	claimed_user_id: text().references(() => user.id, { onDelete: "set null" } ),
	revoked_at: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("guest_thread_invites_instants_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at AND (claimed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS claimed_at) AND (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') IS revoked_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
	check("guest_thread_invites_state_check", sql`(claimed_at IS NULL OR revoked_at IS NULL) AND (claimed_user_id IS NULL OR claimed_at IS NOT NULL)`),
	uniqueIndex("guest_thread_invites_token_hash_unique").on(table.token_hash),
	uniqueIndex("guest_thread_invites_open_request_unique").on(table.request_id).where(sql`claimed_at IS NULL AND revoked_at IS NULL`),
]);




export const invitation = sqliteTable("invitation", {
	id: text().primaryKey(),
	organizationId: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	email: text().notNull(),
	role: text(),
	status: text().default("pending").notNull(),
	expiresAt: integer({ mode: "timestamp" }).notNull(),
	inviterId: text().notNull().references(() => user.id, { onDelete: "cascade" } ),
	teamId: text(),
	createdAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
}, (table) => [
	index("invitation_organizationId_idx").on(table.organizationId),
	uniqueIndex("idx_invitation_org_pending_owner").on(table.organizationId).where(sql`role = 'owner' AND status = 'pending'`),
	uniqueIndex("idx_invitation_org_email_pending_unique").on(table.organizationId, sql`lower(${table.email})`).where(sql`status = 'pending'`),
]);

export const jwks = sqliteTable("jwks", {
	id: text().primaryKey(),
	publicKey: text().notNull(),
	privateKey: text().notNull(),
	alg: text(),
	crv: text(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
	expiresAt: integer({ mode: "timestamp" }),
});

export const media_assets = sqliteTable("media_assets", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	kind: text().$type<'image' | 'video' | 'file'>().notNull(),
	provider: text().$type<'cloudflare_images' | 'cloudflare_r2'>().notNull(),
	source: text().$type<'uploaded' | 'generated' | 'external'>().notNull(),
	cloudflare_image_id: text(),
	r2_key: text(),
	public_url: text(),
	// google_media_name intentionally removed 2026-08-27: confirmed zero rows
	// (local + staging) and zero code references before dropping.
	thumbnail_url: text(),
	mime_type: text(),
	file_name: text(),
	file_size: integer(),
	width: integer(),
	height: integer(),
	duration: integer(),
	alt_text: text(),
	generation_key: text(),
	category: text().$type<MediaCategory>(),
	status: text().$type<'pending' | 'active' | 'deleted' | 'failed'>().default("active").notNull(),
	created_by_user_id: text().references(() => user.id, { onDelete: "set null" } ),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("media_assets_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	check("media_assets_video_thumbnail_check", sql`kind <> 'video' OR (thumbnail_url IS NOT NULL AND length(trim(thumbnail_url)) > 0)`),
	// The subject vocabulary lived only in this file's `$type` and in the MCP
	// tool's JSON schema, so the column itself accepted any string a writer
	// invented. Which of these a business is offered is the dashboard's business
	// — a law firm is not shown Food — but what may be stored is this table's.
	check("media_assets_category_check", sql`category IS NULL OR category IN ('exterior', 'interior', 'food', 'menu', 'team', 'other', 'logo', 'blog')`),
	uniqueIndex("media_assets_org_id_unique").on(table.organization_id, table.id),
]);

export const media_placements = sqliteTable("media_placements", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	owner_type: text().notNull(),
	owner_id: text().notNull(),
	slot: text().notNull(),
	asset_id: text().notNull(),
	sort_order: integer().default(0).notNull(),
	status: text().default("active").notNull(),
	// How this placement presents its asset (a logo's shape and focal point).
	// It belongs to the placement, never the shared asset.
	presentation_json: text({ mode: "json" }).$type<import('~/shared/media-placement-contract').LogoPresentation>(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("media_placements_presentation_check", sql`presentation_json IS NULL OR (json_valid(presentation_json) AND json_extract(presentation_json, '$.shape') IN ('original', 'square', 'circle') AND json_type(presentation_json, '$.focus.x') IN ('integer', 'real') AND json_type(presentation_json, '$.focus.y') IN ('integer', 'real')) IS TRUE`),
	check("media_placements_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({
		columns: [table.organization_id, table.asset_id],
		foreignColumns: [media_assets.organization_id, media_assets.id],
		name: "media_placements_asset_scope_fk",
	}).onDelete("cascade"),
	check("media_placements_owner_type_check", sql`owner_type IN ('organization', 'business_location', 'product', 'collection', 'content_document', 'content_block', 'review', 'review_request', 'activity_entry', 'team_message')`),
	check("media_placements_sort_order_check", sql`sort_order >= 0`),
	unique("media_placements_org_owner_slot_asset_unique").on(table.owner_type, table.owner_id, table.slot, table.asset_id),
	unique("media_placements_org_owner_slot_order_unique").on(table.owner_type, table.owner_id, table.slot, table.sort_order),
	index("media_placements_asset_idx").on(table.organization_id, table.asset_id),
]);

export const member = sqliteTable("member", {
	id: text().primaryKey(),
	organizationId: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	userId: text().notNull().references(() => user.id, { onDelete: "cascade" } ),
	role: text().default("member").notNull(),
	createdAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
}, (table) => [
	// Better Auth's organization adapter resolves membership by userId and organizationId.
	index("member_userId_organizationId_idx").on(table.userId, table.organizationId),
	index("member_organizationId_idx").on(table.organizationId),
	uniqueIndex("member_id_organizationId_unique").on(table.id, table.organizationId),
]);

export const team = sqliteTable("team", {
	id: text().primaryKey(),
	name: text().notNull(),
	organizationId: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	memberCount: integer().default(0).notNull(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
	updatedAt: integer({ mode: "timestamp" }),
}, table => [index("team_organizationId_idx").on(table.organizationId), unique("team_org_id_unique").on(table.organizationId, table.id)]);

export const teamMember = sqliteTable("teamMember", {
	id: text().primaryKey(),
	teamId: text().notNull().references(() => team.id, { onDelete: "cascade" }),
	userId: text().notNull().references(() => user.id, { onDelete: "cascade" }),
	membershipKey: text().unique(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
}, table => [index("teamMember_teamId_idx").on(table.teamId), index("teamMember_userId_idx").on(table.userId)]);

// ---------------------------------------------------------------------------
// Catalog: products, variants, options, prices, publication, collections.
//
// One catalog for every vertical. A restaurant dish, a pottery class, and a
// consultation are all Products; nothing about their storage differs. There is
// one explicit kind for customer-facing facts; pricing and booking still
// share the same model. Capabilities compose: a Product gains booking by having a product_booking_configs row,
// stock by having an inventory_items row, a page by being referenced from a
// content_documents root. Absence of a capability row is the absence of the
// capability, never a NULL to be interpreted.
//
// Value sets (price `type`, session/booking `status`, product `kind`)
// are NOT encoded as CHECK constraints. D1 enforces foreign keys on every
// statement and cannot alter a CHECK in place, so a closed value set on a
// referenced parent makes adding one value an impossible table rebuild. Value
// sets live in the registries under `shared/` and `utils/` and are enforced by
// the validators there. Every CHECK below is structural: JSON shape, canonical
// instants, or a cross-column rule.
// ---------------------------------------------------------------------------

// A Product is catalog identity, owned by the organization and nothing else.
// Row meaning: one thing a merchant sells, once, however many sites publish it
//   or locations offer it. Another location or another site does not create
//   another Product.
// Owner/scope: organization. Deliberately NOT site, location, or category —
//   those are relationships (product_publications, product_locations,
//   collection_products), because a shared catalog is the point.
// Keys: id; (organization_id, id) for children; (organization_id, slug) so a
//   slug identifies one Product per tenant.
// Null semantics: order_url NULL means no ordering destination is configured,
//   never "use the site's". unit_label NULL means amounts are per unsuffixed
//   unit. tax_code NULL means no declared code, not a default one.
// Deletion: cascades to variants, options, publication/location rows,
//   collection membership, named details, booking config, rules and
//   sessions. A canonical page pointing at the product REFUSES the delete
//   (content_documents_product_scope_fk), and so does a booking:
//   the domain checks both and says which, because the cascade would otherwise
//   take seat allocations with it.
// Read/write: server/utils/product-management.ts (writes),
//   server/utils/product-validation.ts (validators),
//   server/utils/public-products.ts (public reads).
export const products = sqliteTable("products", {
	kind: text().notNull(),
	details_json: text().default("{}").notNull(),
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	name: text().notNull(),
	slug: text().notNull(),
	description: text().default("").notNull(),
	// Merchant sale-enable control. Not visibility, not stock, not a counter.
	// Site visibility is product_publications.published; location visibility is
	// product_locations.published; stock is inventory_levels; seats are
	// product_sessions.capacity. A product with active = 0 is not sold out.
	active: integer({ mode: "boolean" }).default(true).notNull(),
	// Narrow ordering destination (a delivery partner, a booking host). NOT the
	// public product page: that is resolved from an explicit publication/site
	// context. Stripe's Product `url` is the page, not this.
	order_url: text(),
	// Stripe Product `unit_label`: a unit noun such as 'person' or 'night'.
	// Pricing prose is block content, never this column.
	unit_label: text(),
	// Stripe Product `marketing_features`: generic selling bullets. Not a merge
	// of inclusions, preparation instructions, policies and features — those are
	// named fields for the product kind.
	marketing_features: text().default("[]").notNull(),
	// Validated string-to-string annotation/integration escape hatch. The object
	// shape is enforced here; string-valued entries are enforced by the shared
	// validator, since a CHECK cannot iterate JSON. No pricing, scheduling,
	// stock, permission, routing or filtering behavior may read this.
	metadata: text().default("{}").notNull(),
	tax_code: text(),
	// Provenance of the row, retained with an explicit owner.
	source: text().default("manual").notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("products_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	unique("products_org_id_unique").on(table.organization_id, table.id),
	unique("products_org_slug_unique").on(table.organization_id, table.slug),
	check("products_name_not_blank_check", sql`trim(name) <> ''`),
	check("products_slug_check", sql`slug <> '' AND slug = lower(slug) AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'`),
	check("products_kind_check", sql`kind IN ('dish', 'experience', 'service', 'item', 'stay')`),
	check("products_active_check", sql`active IN (0, 1)`),
	check("products_marketing_features_check", sql`json_valid(marketing_features) AND json_type(marketing_features) = 'array'`),
	check("products_details_json_check", sql`json_valid(details_json) AND json_type(details_json) = 'object'`),
	check("products_metadata_check", sql`json_valid(metadata) AND json_type(metadata) = 'object'`),
	check("products_order_url_check", sql`order_url IS NULL OR (order_url LIKE 'https://_%' AND instr(order_url, '@') = 0 AND instr(order_url, char(10)) = 0 AND instr(order_url, char(13)) = 0)`),
]);

// The purchasable unit. Every Product has at least one — a Product with no
// customer-selectable options has one real default variant, not a special
// product-only purchase path. "At least one" is an application invariant with
// real-boundary coverage: SQL cannot express it without making inserts
// circular.
// Row meaning: one buyable configuration of a Product.
// Owner/scope: organization, through product_id.
// Keys: id; (organization_id, id) for prices/inventory/bookings;
//   (organization_id, product_id, id) so option selections can prove
//   same-product membership.
// Null semantics: sku NULL means unstocked/untracked identity, not empty.
// Deletion: cascades to prices, option-value selections, inventory items.
//   Deleting the last variant of a Product is refused by the domain layer.
// Do NOT create a variant for a currency, a location, a price revision, or
// another scheduled class date. Those are prices, product_locations, price
// validity periods and product_sessions respectively.
// Read/write: server/utils/product-management.ts.
export const product_variants = sqliteTable("product_variants", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	name: text().notNull(),
	sku: text(),
	active: integer({ mode: "boolean" }).default(true).notNull(),
	sort_order: integer().default(0).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("product_variants_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [products.organization_id, products.id], name: "product_variants_product_scope_fk" }).onDelete("cascade"),
	unique("product_variants_org_id_unique").on(table.organization_id, table.id),
	unique("product_variants_product_id_unique").on(table.organization_id, table.product_id, table.id),
	uniqueIndex("product_variants_org_sku_unique").on(table.organization_id, table.sku).where(sql`sku IS NOT NULL`),
	index("product_variants_product_sort_idx").on(table.product_id, table.sort_order),
	check("product_variants_name_not_blank_check", sql`trim(name) <> ''`),
	check("product_variants_active_check", sql`active IN (0, 1)`),
	check("product_variants_sort_order_check", sql`sort_order >= 0`),
]);

// A selectable dimension of a Product ("Size", "Noodle"). Options and their
// values are Product-owned so a variant's selections can be proved to belong
// to the same Product in SQL rather than in a validator's memory.
// Keys: (organization_id, product_id, id) is the parent key every selection
//   row matches on.
// Deletion: cascades to values and to the selections referencing them.
// Read/write: server/utils/product-management.ts.
export const product_options = sqliteTable("product_options", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	name: text().notNull(),
	sort_order: integer().default(0).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("product_options_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [products.organization_id, products.id], name: "product_options_product_scope_fk" }).onDelete("cascade"),
	unique("product_options_product_id_unique").on(table.organization_id, table.product_id, table.id),
	unique("product_options_product_name_unique").on(table.organization_id, table.product_id, table.name),
	index("product_options_product_sort_idx").on(table.product_id, table.sort_order),
	check("product_options_name_not_blank_check", sql`trim(name) <> ''`),
	check("product_options_sort_order_check", sql`sort_order >= 0`),
]);

// One allowed value of one option. `product_id` is carried so the selection
// table can match option, value and variant against a single Product key.
// Keys: (organization_id, product_id, product_option_id, id).
// Read/write: server/utils/product-management.ts.
export const product_option_values = sqliteTable("product_option_values", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	product_option_id: text().notNull(),
	value: text().notNull(),
	sort_order: integer().default(0).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("product_option_values_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id, table.product_option_id], foreignColumns: [product_options.organization_id, product_options.product_id, product_options.id], name: "product_option_values_option_scope_fk" }).onDelete("cascade"),
	unique("product_option_values_option_id_unique").on(table.organization_id, table.product_id, table.product_option_id, table.id),
	unique("product_option_values_option_value_unique").on(table.organization_id, table.product_option_id, table.value),
	index("product_option_values_option_sort_idx").on(table.product_option_id, table.sort_order),
	check("product_option_values_value_not_blank_check", sql`trim(value) <> ''`),
	check("product_option_values_sort_order_check", sql`sort_order >= 0`),
]);

// Which option value each variant selects.
// Row meaning: variant X answers option Y with value Z.
// Enforced in SQL: value, option and variant all belong to the same Product
//   (every foreign key below matches on product_id), and a variant selects at
//   most ONE value per option (the composite primary key).
// Enforced by the domain layer, with real-boundary coverage: required
//   selections are complete, and two variants of one Product cannot select the
//   same combination. Neither is expressible as a SQLite constraint.
// Read/write: server/utils/product-management.ts.
export const product_variant_option_values = sqliteTable("product_variant_option_values", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	product_variant_id: text().notNull(),
	product_option_id: text().notNull(),
	product_option_value_id: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.product_variant_id, table.product_option_id], name: "product_variant_option_values_pk" }),
	foreignKey({ columns: [table.organization_id, table.product_id, table.product_variant_id], foreignColumns: [product_variants.organization_id, product_variants.product_id, product_variants.id], name: "product_variant_option_values_variant_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.product_id, table.product_option_id], foreignColumns: [product_options.organization_id, product_options.product_id, product_options.id], name: "product_variant_option_values_option_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.product_id, table.product_option_id, table.product_option_value_id], foreignColumns: [product_option_values.organization_id, product_option_values.product_id, product_option_values.product_option_id, product_option_values.id], name: "product_variant_option_values_value_scope_fk" }).onDelete("cascade"),
	index("product_variant_option_values_variant_idx").on(table.product_variant_id),
]);

// A monetary offer on one variant.
// Row meaning: this variant costs this much, in this currency, under these
//   billing terms, optionally only at this location, optionally only during
//   this period.
// Owner/scope: organization, through the variant. There is NO product_id
//   column: the Product is resolved through product_variant_id. Two writable
//   parents that can disagree is the defect this replaces.
// Null semantics: location_id NULL is a DECLARED location-neutral scope, not a
//   missing association and not a wildcard to fall back to. valid_from_at NULL
//   means "since always"; valid_until_at NULL means "until further notice".
//   compare_at_unit_amount NULL means no strike-through. A variant with no
//   price row is not free — it is not purchasable, and the surface says so.
//   unit_amount = 0 is an explicit free offer.
// Deletion: cascades from the variant. Historical purchase amounts are
//   snapshots elsewhere and are never rewritten by editing a price.
// Read/write: shared/prices.ts owns the one deterministic selection contract
//   over (variant, currency, location, effective instant, billing terms). It
//   REFUSES an ambiguous selection rather than ordering rows and taking the
//   first. No caller re-implements precedence.
export const prices = sqliteTable("prices", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_variant_id: text().notNull(),
	location_id: text(),
	active: integer({ mode: "boolean" }).default(true).notNull(),
	// Normalized ISO 4217 code, uppercase.
	currency: text().notNull(),
	// Integer amount in the currency's smallest unit. Never floating point.
	unit_amount: integer().notNull(),
	// Billing recurrence: 'one_time' | 'recurring' (shared/prices.ts). This is
	// BILLING, not class dates. A weekly class is product_availability_rules,
	// never a weekly recurring price.
	type: text().$type<'one_time' | 'recurring'>().default("one_time").notNull(),
	recurring_interval: text().$type<'day' | 'week' | 'month' | 'year'>(),
	recurring_interval_count: integer(),
	tax_behavior: text().$type<'unspecified' | 'inclusive' | 'exclusive'>().default("unspecified").notNull(),
	compare_at_unit_amount: integer(),
	valid_from_at: text(),
	valid_until_at: text(),
	source: text().default("manual").notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("prices_instants_check", sql`(valid_from_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', valid_from_at, '+0 days') IS valid_from_at) AND (valid_until_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', valid_until_at, '+0 days') IS valid_until_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_variant_id], foreignColumns: [product_variants.organization_id, product_variants.id], name: "prices_variant_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "prices_location_scope_fk" }).onDelete("cascade"),
	index("prices_variant_validity_idx").on(table.organization_id, table.product_variant_id, table.active, table.valid_from_at, table.valid_until_at),
	index("prices_location_idx").on(table.organization_id, table.location_id),
	check("prices_active_check", sql`active IN (0, 1)`),
	check("prices_currency_check", sql`length(currency) = 3 AND currency = upper(currency) AND currency NOT GLOB '*[^A-Z]*'`),
	check("prices_unit_amount_check", sql`unit_amount >= 0`),
	check("prices_compare_at_check", sql`compare_at_unit_amount IS NULL OR compare_at_unit_amount > unit_amount`),
	check("prices_validity_check", sql`valid_until_at IS NULL OR valid_from_at IS NULL OR valid_until_at > valid_from_at`),
	// Cross-column rule, not a value set: recurrence fields exist exactly when
	// the price recurs. An unsupported billing mode is rejected by the
	// validator in shared/prices.ts, loudly.
	check("prices_recurring_check", sql`(type = 'recurring' AND recurring_interval IS NOT NULL AND recurring_interval_count IS NOT NULL AND recurring_interval_count > 0) OR (type <> 'recurring' AND recurring_interval IS NULL AND recurring_interval_count IS NULL)`),
]);

// Which organizations publish a Product.
// Row meaning: this organization carries this Product in its catalog, published or not.
// Organization publication is independent of products.active and of
//   product_locations.published. All three are distinct, separately tested
//   states; none implies another.
// Null semantics: no row means the site does not carry the Product at all —
//   distinct from a row with published = 0, which means "carried, withheld".
// Deletion: cascades from Product and from site.
// Read/write: server/utils/product-management.ts;
//   server/utils/public-products.ts for site projections. A publication change
//   enqueues public_resource_cache_invalidations for every affected site, so a
//   Product in several documents cannot leave independently stale copies.
export const product_publications = sqliteTable("product_publications", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	published: integer({ mode: "boolean" }).default(false).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.product_id, table.organization_id], name: "product_publications_pk" }),
	check("product_publications_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [products.organization_id, products.id], name: "product_publications_product_scope_fk" }).onDelete("cascade"),
	index("product_publications_org_idx").on(table.published),
	check("product_publications_published_check", sql`published IN (0, 1)`),
]);

// Where a Product is offered.
// Row meaning: this location offers this Product. Membership exists
//   independently of prices and of stock — a price does not establish where a
//   Product is sold, and a location with no price row still offers it (at a
//   location-neutral price, or not purchasably, which the surface states).
// `active` enables sale at that location; `published` includes it on that
//   location's surfaces. Both are independent of products.active and of site
//   publication.
// Authorization: a location-scoped editor may write THIS row and that
//   location's prices, sessions and reservation configuration. It does not
//   grant them edit rights on the organization-wide Product or on another
//   location's rows — enforced by server/utils/organization-access.ts, not by
//   this table.
// Deletion: cascades from Product and from location.
// Read/write: server/utils/product-management.ts.
export const product_locations = sqliteTable("product_locations", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	location_id: text().notNull(),
	active: integer({ mode: "boolean" }).default(true).notNull(),
	published: integer({ mode: "boolean" }).default(false).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.product_id, table.location_id], name: "product_locations_pk" }),
	check("product_locations_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [products.organization_id, products.id], name: "product_locations_product_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "product_locations_location_scope_fk" }).onDelete("cascade"),
	index("product_locations_location_idx").on(table.location_id, table.published, table.active),
	// Parent key for product_stay_configs: a home names its one location relationship.
	uniqueIndex("product_locations_org_product_location_unique").on(table.organization_id, table.product_id, table.location_id),
	check("product_locations_active_check", sql`active IN (0, 1) AND published IN (0, 1)`),
]);

// Merchant merchandising: a named, ordered grouping a site presents.
// This replaces `product_categories` and the `featured` / `featured_sort_order`
// columns. A curated "Featured" grouping is a Collection whose membership is
// explicit; there is no second featured-product truth on products. This is
// merchandising, not a taxonomy — no unused classification system is
// introduced to preserve the old table's name.
// Row meaning: one grouping on one site, optionally narrowed to one location
//   (a menu section that exists only at one branch).
// Null semantics: location_id NULL means the grouping applies site-wide.
// Deletion: cascades from site and location; cascades to membership. Deleting
//   a Collection never deletes its Products.
// Read/write: server/utils/product-management.ts;
//   server/utils/public-products.ts.
export const collections = sqliteTable("collections", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	location_id: text(),
	name: text().notNull(),
	slug: text().notNull(),
	description: text(),
	sort_order: integer().default(0).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("collections_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "collections_location_scope_fk" }).onDelete("cascade"),
	unique("collections_org_id_unique").on(table.organization_id, table.id),
	uniqueIndex("collections_org_slug_unique").on(table.organization_id, table.slug).where(sql`location_id IS NULL`),
	uniqueIndex("collections_location_slug_unique").on(table.organization_id, table.location_id, table.slug).where(sql`location_id IS NOT NULL`),
	index("collections_org_sort_idx").on(table.organization_id, table.location_id, table.sort_order),
	check("collections_name_not_blank_check", sql`trim(name) <> ''`),
	check("collections_slug_check", sql`slug <> '' AND slug = lower(slug) AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'`),
	check("collections_sort_order_check", sql`sort_order >= 0`),
]);

// Collection membership, and the position of a Product WITHIN that collection.
// Position lives here, not on products: the same Product can sit third on one
// site's menu and first in another location's grouping without being copied.
// Deletion: cascades from Collection and from Product.
// Read/write: server/utils/product-management.ts.
export const collection_products = sqliteTable("collection_products", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	collection_id: text().notNull(),
	product_id: text().notNull(),
	sort_order: integer().default(0).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.collection_id, table.product_id], name: "collection_products_pk" }),
	check("collection_products_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.collection_id], foreignColumns: [collections.organization_id, collections.id], name: "collection_products_collection_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [products.organization_id, products.id], name: "collection_products_product_scope_fk" }).onDelete("cascade"),
	// Ordering is (sort_order, product_id) — fully deterministic without a
	// uniqueness constraint, which would turn every menu reorder into a
	// two-phase update over hundreds of rows.
	index("collection_products_order_idx").on(table.collection_id, table.sort_order, table.product_id),
	index("collection_products_product_idx").on(table.product_id),
	check("collection_products_sort_order_check", sql`sort_order >= 0`),
]);

// ---------------------------------------------------------------------------
// Typed descriptive extensions.
//
export const product_booking_configs = sqliteTable("product_booking_configs", {
	product_id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	duration_minutes: integer(),
	default_capacity: integer(),
	confirmation_mode: text().default("instant").notNull(),
	online_payment_required: integer({ mode: "boolean" }).default(false).notNull(),
	// Held online: its sessions come from each provider's working hours, in
	// that provider's timezone, rather than from weekly slots at a location.
	held_online: integer({ mode: "boolean" }).default(false).notNull(),
	scheduling_mode: text().default("legacy").notNull(),
	assigned_member_id: text(),
	assigned_team_id: text().references(() => team.id, { onDelete: "set null" }),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("product_booking_configs_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [products.organization_id, products.id], name: "product_booking_configs_product_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.assigned_team_id], foreignColumns: [team.organizationId, team.id], name: "product_booking_configs_team_scope_fk" }).onDelete("no action"),
	// Parent key for rules and sessions: they scope by (organization, product)
	// so a rule can never attach to another tenant's Product.
	unique("product_booking_configs_org_product_unique").on(table.organization_id, table.product_id),
	check("product_booking_configs_duration_check", sql`duration_minutes IS NULL OR duration_minutes > 0`),
	check("product_booking_configs_capacity_check", sql`default_capacity IS NULL OR default_capacity >= 0`),
	check("product_booking_configs_confirmation_check", sql`confirmation_mode IN ('instant', 'review')`),
	check("product_booking_configs_payment_check", sql`online_payment_required IN (0, 1)`),
	check("product_booking_configs_held_online_check", sql`held_online IN (0, 1) AND (held_online = 0 OR (scheduling_mode = 'provider' AND (assigned_member_id IS NOT NULL OR assigned_team_id IS NOT NULL)))`),
]);

// Typed weekly recurrence. This replaces the `recurring_slots` JSON map; it is
// not that map relocated into another ungoverned column.
// Row meaning: sessions of this Product should exist on this weekday at this
//   local start time, every `interval_weeks` weeks, within the effective dates.
// Recurrence is defined in LOCAL WALL TIME plus an IANA timezone — an offset
//   alone is not a recurrence timezone, because offsets move and wall clocks
//   do not. Session instants are stored in UTC. Nonexistent and ambiguous
//   local times (spring-forward gaps, fall-back repeats) have defined
//   behavior in server/utils/availability.ts with real coverage.
// A rule is always at a location, in that location's timezone. An online
//   offering has no rules: its sessions come from its providers' hours.
// Null semantics: duration_minutes / capacity NULL defer to product_booking_configs.
//   effective_from_date / effective_until_date NULL mean open-ended.
// Deletion: cascades from Product and location. Sessions already generated
//   keep their own times and capacity — deleting a rule does not delete or
//   move them, and editing one does not silently reschedule existing bookings.
//   Series edits are explicit, scoped operations in the domain layer.
// Read/write: server/utils/availability.ts.
export const product_availability_rules = sqliteTable("product_availability_rules", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	location_id: text().notNull(),
	// IANA zone name, e.g. 'Asia/Bangkok'.
	timezone: text().notNull(),
	// 0 = Sunday .. 6 = Saturday.
	weekday: integer().notNull(),
	// Local wall-clock 'HH:MM'.
	start_time: text().notNull(),
	// A repeating slot: start_time, then every interval_minutes until the last
	// start at or before end_time. Both null is a single start time, which is
	// what a class is. A restaurant service is one row per weekday instead of
	// one per seating.
	end_time: text(),
	interval_minutes: integer(),
	interval_weeks: integer().default(1).notNull(),
	effective_from_date: text(),
	effective_until_date: text(),
	duration_minutes: integer(),
	capacity: integer(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("product_availability_rules_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [product_booking_configs.organization_id, product_booking_configs.product_id], name: "product_availability_rules_config_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "product_availability_rules_location_scope_fk" }).onDelete("cascade"),
	unique("product_availability_rules_org_id_unique").on(table.organization_id, table.id),
	// effective_from_date is deliberately NOT part of the key: two rules for the
	// same weekday and time differing only by effective window are an ambiguity
	// about which one governs, not two distinct slots.
	uniqueIndex("product_availability_rules_slot_unique").on(table.product_id, table.location_id, table.weekday, table.start_time, table.interval_weeks),
	index("product_availability_rules_product_idx").on(table.product_id, table.weekday, table.start_time),
	check("product_availability_rules_weekday_check", sql`weekday BETWEEN 0 AND 6`),
	check("product_availability_rules_start_time_check", sql`start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time < '24:00'`),
	// end_time and interval_minutes are one feature: neither means anything
	// alone, and a repeat that ends before it starts has no occurrences.
	check("product_availability_rules_repeat_check", sql`(end_time IS NULL) = (interval_minutes IS NULL) AND (end_time IS NULL OR (end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time < '24:00' AND end_time > start_time)) AND (interval_minutes IS NULL OR interval_minutes > 0)`),
	check("product_availability_rules_interval_check", sql`interval_weeks >= 1`),
	// A cadence longer than a week has to say from when, or "every other
	// Saturday" means a different Saturday depending on the day generation
	// happens to run. The anchor is the rule's own effective start.
	check("product_availability_rules_anchor_check", sql`interval_weeks = 1 OR effective_from_date IS NOT NULL`),
	check("product_availability_rules_dates_check", sql`(effective_from_date IS NULL OR date(effective_from_date, '+0 days') IS effective_from_date) AND (effective_until_date IS NULL OR date(effective_until_date, '+0 days') IS effective_until_date) AND (effective_from_date IS NULL OR effective_until_date IS NULL OR effective_until_date >= effective_from_date)`),
	check("product_availability_rules_duration_check", sql`duration_minutes IS NULL OR duration_minutes > 0`),
	check("product_availability_rules_capacity_check", sql`capacity IS NULL OR capacity >= 0`),
	check("product_availability_rules_timezone_check", sql`timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'`),
]);

// A concrete occurrence. Sessions own actual times, capacity and state — the
// rule that generated one is provenance, not authority.
// Row meaning: this Product runs at this instant, seating this many.
// Null semantics: availability_rule_id NULL is a legitimate one-off session,
//   not an orphan. location_id NULL means it is held online, by its assigned member.
//   capacity NULL means unlimited; capacity = 0 means no seats. These are
//   different and both are tested.
// `source_occurrence_key` is the stable generation identity (rule + intended
//   local occurrence), NOT the mutable start time. It is what makes
//   materialization idempotent: re-running generation cannot duplicate a
//   session, resurrect a cancelled one, overwrite an edited one, or recreate a
//   rescheduled one under its old start. NULL for one-off sessions.
// Deletion: cascades from Product; cascades to bookings. Cancelling is a
//   status change, not a delete — a deleted session loses its booking history.
// Read/write: server/utils/availability.ts owns generation and the single
//   protected capacity-allocation operation. Session identity alone is not the
//   concurrency control; that operation is.
export const product_sessions = sqliteTable("product_sessions", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	assigned_member_id: text(),
	location_id: text(),
	availability_rule_id: text(),
	source_occurrence_key: text(),
	timezone: text().notNull(),
	starts_at: text().notNull(),
	ends_at: text().notNull(),
	capacity: integer(),
	// 'scheduled' | 'cancelled' | 'completed' (registry in shared/). Which
	// statuses consume capacity is declared there, not inferred here.
	status: text().default("scheduled").notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("product_sessions_instants_check", sql`(strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at, '+0 days') IS ends_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [product_booking_configs.organization_id, product_booking_configs.product_id], name: "product_sessions_config_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "product_sessions_location_scope_fk" }).onDelete("cascade"),
	// Not SET NULL, for the same composite-key reason as above. Deleting a rule
	// must not delete or move the sessions it generated, so the domain operation
	// clears availability_rule_id on those sessions first — dropping provenance
	// deliberately — and only then deletes the rule. NO ACTION rather than
	// RESTRICT, so a product or organization delete that cascades away both the
	// rule and its sessions in one statement is not refused halfway.
	foreignKey({ columns: [table.organization_id, table.availability_rule_id], foreignColumns: [product_availability_rules.organization_id, product_availability_rules.id], name: "product_sessions_rule_scope_fk" }).onDelete("no action"),
	unique("product_sessions_org_id_unique").on(table.organization_id, table.id),
	// Parent key for bookings: a booking matches on product_id too, so a ticket
	// variant from another Product cannot be booked onto this session.
	unique("product_sessions_org_product_id_unique").on(table.organization_id, table.product_id, table.id),
	// Idempotent materialization: one session per generated occurrence.
	uniqueIndex("product_sessions_occurrence_unique").on(table.product_id, table.source_occurrence_key).where(sql`source_occurrence_key IS NOT NULL`),
	// One session per product, location and instant. Ticket tiers are variants
	// sharing this session, never a session each. Partial indexes again, because
	// location_id is nullable and NULLs are distinct under UNIQUE.
	uniqueIndex("product_sessions_location_instant_unique").on(table.product_id, table.location_id, table.starts_at).where(sql`location_id IS NOT NULL AND assigned_member_id IS NULL`),
	uniqueIndex("product_sessions_provider_location_instant_unique").on(table.product_id, table.location_id, table.starts_at, table.assigned_member_id).where(sql`location_id IS NOT NULL AND assigned_member_id IS NOT NULL`),
	uniqueIndex("product_sessions_provider_neutral_instant_unique").on(table.product_id, table.starts_at, table.assigned_member_id).where(sql`location_id IS NULL AND assigned_member_id IS NOT NULL`),
	index("product_sessions_product_start_idx").on(table.product_id, table.starts_at, table.status),
	index("product_sessions_location_start_idx").on(table.location_id, table.starts_at, table.status),
	check("product_sessions_interval_check", sql`ends_at > starts_at`),
	check("product_sessions_status_check", sql`status IN ('scheduled', 'cancelled')`),
	check("product_sessions_capacity_check", sql`capacity IS NULL OR capacity >= 0`),
	check("product_sessions_timezone_check", sql`timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'`),
	// An online session is a provider's: it is held in their hours and their timezone.
	check("product_sessions_online_provider_check", sql`location_id IS NOT NULL OR assigned_member_id IS NOT NULL`),
]);

// A claim on seats of one session.
// Row meaning: this party holds this many seats on this session, in this
//   variant, in this state.
// Enforced in SQL: the variant belongs to the session's Product (the composite
//   foreign key matches on product_id), so a ticket type from another class
//   cannot be booked onto this one. party_size is positive.
// Ticket variants SHARE the session's capacity — each price does not create
//   its own seat pool. Capacity is claimed through the one protected operation
//   in server/utils/availability.ts, which declares which statuses consume
//   capacity, how cancellation releases it, how a pending hold expires, and
//   the idempotency key. Concurrent claims cannot exceed capacity; that is a
//   tested property, not an assumption about row locking.
// Null semantics: user_id NULL is a guest booking with contact details on
//   the linked request. request_id NULL is a booking made without an inbox
//   thread (dashboard, MCP) — the booking is still the operational truth.
// Deletion: cascades from the organization; user_id becomes NULL if the
//   person's account goes. An inbox thread cannot be deleted while a booking links to
//   it, so a seat record can never be lost by tidying the inbox.
// A confirmed booking is NOT a successful payment. Money is not represented
//   here, and no column may be widened to represent it.
export const bookings = sqliteTable("bookings", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	product_session_id: text().notNull(),
	product_variant_id: text().notNull(),
	assigned_member_id: text(),
	user_id: text().references((): AnySQLiteColumn => user.id, { onDelete: "set null" }),
	request_id: text(),
	party_size: integer().notNull(),
	// 'pending' | 'confirmed' | 'cancelled' | 'completed' (registry in shared/).
	status: text().default("confirmed").notNull(),
	// Hold expiry for a pending claim. NULL means the claim does not expire.
	cancelled_at: text(),
	cancellation_reason: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	// The status set lives here now. It never did: `status` was plain text with
	// a comment pointing somewhere else, which is how `pending` survived after
	// nothing wrote it on purpose.
	check("bookings_status_check", sql`status IN ('pending', 'confirmed', 'cancelled')`),
	check("bookings_instants_check", sql`(cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	// A booking pins what it holds. Deleting the session or the variant it
	// names is refused while the booking exists — a guest's seat is not
	// something an edit, a capability change or a product deletion may erase as
	// a side effect. The domain checks first so the merchant reads a sentence
	// instead of a constraint name; this is what makes the check true under a
	// booking that arrives between the check and the write.
	//
	// NO ACTION, not RESTRICT: SQLite checks NO ACTION when the statement
	// completes, so deleting the session alone is still refused while this row
	// exists, but deleting the organization succeeds because its cascade removes
	// the booking in the same statement. RESTRICT fires at the parent row and
	// would refuse the organization's own cascade.
	foreignKey({ columns: [table.organization_id, table.product_id, table.product_session_id], foreignColumns: [product_sessions.organization_id, product_sessions.product_id, product_sessions.id], name: "bookings_session_scope_fk" }).onDelete("no action"),
	foreignKey({ columns: [table.organization_id, table.product_id, table.product_variant_id], foreignColumns: [product_variants.organization_id, product_variants.product_id, product_variants.id], name: "bookings_variant_scope_fk" }).onDelete("no action"),
	// Not SET NULL: that would null organization_id too, because this is a
	// composite key. Deleting an inbox thread must not delete a seat allocation,
	// so the domain operation unlinks the booking first. Deleting the
	// organization cascades both away together.
	foreignKey({ columns: [table.organization_id, table.request_id], foreignColumns: [requests.organization_id, requests.id], name: "bookings_request_scope_fk" }).onDelete("no action"),
	uniqueIndex("bookings_request_unique").on(table.request_id).where(sql`request_id IS NOT NULL`),
	index("bookings_session_status_idx").on(table.product_session_id, table.status),
	index("bookings_org_created_idx").on(table.created_at),
	index("bookings_org_user_idx").on(table.organization_id, table.user_id),
	check("bookings_party_size_check", sql`party_size > 0`),
]);

// ---------------------------------------------------------------------------
// Location reservations.
//
// A restaurant table reservation is not a product session and the restaurant
// is not selling a catalog item by taking it. This capability is location-owned
// and stays that way; it replaces `business_locations.booking_json` with typed
// columns and is NOT a second experience-booking implementation wearing the
// reservation name.
//
// Opening hours and special hours remain on business_locations as the declared
// hours source. They are not copied into a product schedule.
// ---------------------------------------------------------------------------

// Reservation policy for one location, typed. This replaces the eleven keys
// that lived under booking_json.$.reservation.policy.
// Row meaning: this location takes reservations, under this policy. The
//   existence of the row is the capability; there is no enabled flag and no
//   operational JSON reader.
// Capacity contract: capacity is per START-TIME SLOT, not per overlapping
//   interval. That choice is preserved consistently by
//   server/utils/reservations.ts and is not re-decided per caller.
// Null semantics: every policy field NULL means the policy does not constrain
//   that dimension — not that a platform default applies.
// Deletion: cascades from location; cascades to overrides. Reservations keep
//   their own records.
// Read/write: server/utils/reservations.ts.
export const location_reservation_configs = sqliteTable("location_reservation_configs", {
	duration_minutes: integer(),
	location_id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	slot_capacity: integer(),
	advance_notice_minutes: integer(),
	minimum_guest_age: integer(),
	deposit_required: integer({ mode: "boolean" }).default(false).notNull(),
	deposit_amount: integer(),
	deposit_currency: text(),
	deposit_tax_behavior: text().$type<'inclusive' | 'exclusive'>(),
	deposit_trigger_party_size: integer(),
	free_cancellation_until_minutes: integer(),
	reschedule_allowed: integer({ mode: "boolean" }).default(true).notNull(),
	reschedule_cutoff_minutes: integer(),
	accessibility_contact_required: integer({ mode: "boolean" }).default(false).notNull(),
	additional_notes_html: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("location_reservation_configs_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "location_reservation_configs_location_scope_fk" }).onDelete("cascade"),
	// Parent key for overrides.
	unique("location_reservation_configs_org_location_unique").on(table.organization_id, table.location_id),
	check("location_reservation_configs_booleans_check", sql`deposit_required IN (0, 1) AND reschedule_allowed IN (0, 1) AND accessibility_contact_required IN (0, 1)`),
	check("location_reservation_configs_duration_check", sql`duration_minutes IS NULL OR duration_minutes > 0`),
	check("location_reservation_configs_slot_capacity_check", sql`slot_capacity IS NULL OR slot_capacity >= 0`),
	check("location_reservation_configs_minutes_check", sql`(advance_notice_minutes IS NULL OR advance_notice_minutes >= 0) AND (free_cancellation_until_minutes IS NULL OR free_cancellation_until_minutes >= 0) AND (reschedule_cutoff_minutes IS NULL OR reschedule_cutoff_minutes >= 0)`),
	check("location_reservation_configs_party_check", sql`deposit_trigger_party_size IS NULL OR deposit_trigger_party_size > 0`),
	check("location_reservation_configs_deposit_check", sql`(deposit_amount IS NULL OR deposit_amount > 0) AND (deposit_currency IS NULL OR (length(deposit_currency) = 3 AND deposit_currency = upper(deposit_currency))) AND (deposit_tax_behavior IS NULL OR deposit_tax_behavior IN ('inclusive', 'exclusive'))`),
	check("location_reservation_configs_age_check", sql`minimum_guest_age IS NULL OR minimum_guest_age >= 0`),
]);

// A deliberate exception to a location's normal reservation availability.
// Row meaning: on this date at this local slot, this location is closed, or
//   seats a different number than the policy implies.
// Null semantics: capacity NULL with status 'closed' means no seats at all;
//   capacity set with status 'open' overrides the slot capacity. time_slot
//   NULL applies to the whole date.
// This is the location-side counterpart of editing a session directly. It does
//   NOT exist on the product side: an experience override is a change to the
//   actual product_sessions row.
// Deletion: cascades from the config.
// Read/write: server/utils/reservations.ts.
export const reservations = sqliteTable("reservations", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	location_id: text().notNull(),
	user_id: text().references((): AnySQLiteColumn => user.id, { onDelete: "set null" }),
	request_id: text(),
	timezone: text().notNull(),
	starts_at: text().notNull(),
	ends_at: text().notNull(),
	party_size: integer().notNull(),
	// The guest's agreement at creation, not the location's mutable policy.
	policy_json: text(),
	// 'pending' | 'confirmed' | 'cancelled' | 'completed' (registry in shared/).
	status: text().default("confirmed").notNull(),
	cancelled_at: text(),
	cancellation_reason: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("reservations_status_check", sql`status IN ('confirmed', 'cancelled')`),
	check("reservations_policy_check", sql`policy_json IS NULL OR (json_valid(policy_json) AND json_type(policy_json) = 'object' AND json_type(policy_json, '$.reschedule_allowed') IN ('true', 'false') AND json_type(policy_json, '$.free_cancellation_until_minutes') IN ('null', 'integer') AND json_type(policy_json, '$.reschedule_cutoff_minutes') IN ('null', 'integer')) IS 1`),
	check("reservations_instants_check", sql`(strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at, '+0 days') IS ends_at) AND (cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "reservations_location_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.request_id], foreignColumns: [requests.organization_id, requests.id], name: "reservations_request_scope_fk" }).onDelete("no action"),
	uniqueIndex("reservations_request_unique").on(table.request_id).where(sql`request_id IS NOT NULL`),
	index("reservations_location_start_idx").on(table.location_id, table.starts_at, table.status),
	index("reservations_org_created_idx").on(table.created_at),
	index("reservations_org_user_idx").on(table.organization_id, table.user_id),
	check("reservations_interval_check", sql`ends_at > starts_at`),
	check("reservations_party_size_check", sql`party_size > 0`),
	check("reservations_timezone_check", sql`timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'`),
]);

// ---------------------------------------------------------------------------
// Places to stay.
//
// A home is a Product of kind `stay` at exactly one location: the location is
// the place (address, timezone, team), the Product is what a guest books, and
// its default variant's price is the base nightly rate. Nights are calendar
// dates in the location's timezone; a stay holds the half-open range
// [check_in_date, check_out_date). Overnight stays are not product_sessions:
// a session is one instant range with seats, a stay is a run of whole nights.
// Read/write: server/domain/stays.ts, and nothing else.
// ---------------------------------------------------------------------------

// Row meaning: this Product is a home at this location, with these stay settings.
// The composite key to product_locations is what makes "exactly one location"
//   true in SQL: the config names the one relationship, and the relationship
//   cannot be removed while the config names it.
// Times are local wall-clock HH:MM in the location's timezone.
// Assignment: the member or team who look after the home (cleaning,
//   turnovers). Members with assigned-operations access read this home's stays
//   and nothing else; NULL means only organization-wide roles do.
// Deletion: cascades from Product; refused while stays exist (see stays).
export const product_stay_configs = sqliteTable("product_stay_configs", {
	product_id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	location_id: text().notNull(),
	check_in_time: text().notNull(),
	check_out_time: text().notNull(),
	max_guests: integer().notNull(),
	min_nights: integer().default(1).notNull(),
	check_in_instructions: text(),
	assigned_member_id: text(),
	assigned_team_id: text().references(() => team.id, { onDelete: "set null" }),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("product_stay_configs_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [products.organization_id, products.id], name: "product_stay_configs_product_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.product_id, table.location_id], foreignColumns: [product_locations.organization_id, product_locations.product_id, product_locations.location_id], name: "product_stay_configs_location_scope_fk" }).onDelete("no action"),
	foreignKey({ columns: [table.organization_id, table.assigned_team_id], foreignColumns: [team.organizationId, team.id], name: "product_stay_configs_team_scope_fk" }).onDelete("no action"),
	unique("product_stay_configs_org_product_unique").on(table.organization_id, table.product_id),
	check("product_stay_configs_times_check", sql`check_in_time GLOB '[0-2][0-9]:[0-5][0-9]' AND check_in_time < '24:00' AND check_out_time GLOB '[0-2][0-9]:[0-5][0-9]' AND check_out_time < '24:00'`),
	check("product_stay_configs_guests_check", sql`max_guests >= 1`),
	check("product_stay_configs_min_nights_check", sql`min_nights >= 1`),
	check("product_stay_configs_instructions_check", sql`check_in_instructions IS NULL OR (length(trim(check_in_instructions)) BETWEEN 1 AND 5000)`),
]);

// Workspace-owned reply text, optionally scheduled for explicitly named homes.
// A schedule's activation time is a local receipt baseline, never a provider
// creation timestamp. Edits increase version so stale planners cannot win.
export const message_templates = sqliteTable("message_templates", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	title: text().notNull(),
	body: text().notNull(),
	schedule_json: text(),
	schedule_enabled_at: text(),
	version: integer().notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	unique("message_templates_org_id_unique").on(table.organization_id, table.id),
	index("message_templates_org_updated_idx").on(table.organization_id, table.updated_at, table.id),
	check("message_templates_text_check", sql`length(trim(title)) BETWEEN 1 AND 100 AND length(trim(body)) BETWEEN 1 AND 5000`),
	check("message_templates_version_check", sql`version >= 1`),
	check("message_templates_schedule_check", sql`(schedule_json IS NULL AND schedule_enabled_at IS NULL) OR (schedule_json IS NOT NULL AND schedule_enabled_at IS NOT NULL AND json_valid(schedule_json) AND json_type(schedule_json) IS 'object' AND json_type(schedule_json, '$.productIds') IS 'array' AND json_array_length(schedule_json, '$.productIds') BETWEEN 1 AND 100 AND ((json_extract(schedule_json, '$.trigger') = 'booking_received' AND json_extract(schedule_json, '$.delayMinutes') = 5) OR (json_extract(schedule_json, '$.trigger') IN ('check_in', 'check_out') AND json_type(schedule_json, '$.offsetDays') IS 'integer' AND json_extract(schedule_json, '$.offsetDays') BETWEEN -7 AND 7 AND json_extract(schedule_json, '$.localTime') GLOB '[0-2][0-9]:[0-5][0-9]' AND json_extract(schedule_json, '$.localTime') < '24:00'))) IS TRUE`),
	check("message_templates_instants_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (schedule_enabled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', schedule_enabled_at, '+0 days') IS schedule_enabled_at)`),
]);

// Row meaning: the host (or an imported channel calendar) set this night apart
//   from the home's defaults. Absence of a row is the default: open, at the
//   base nightly price, with the home's minimum stay.
// A night is bookable when it is not closed and no stay_nights row claims it;
//   occupancy is never stored here. These rules are what guests and channels
//   are offered; a stay the host enters themselves is not refused by them.
// price_minor NULL means the base nightly price applies.
// `source`: 'host' (edited in KrabiClaw) or 'import' (read from a channel when
//   the home was connected).
// Deletion: cascades from the home.
export const product_nights = sqliteTable("product_nights", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	date: text().notNull(),
	closed: integer({ mode: "boolean" }).default(false).notNull(),
	price_minor: integer(),
	min_stay_arrival: integer(),
	min_stay_through: integer(),
	max_stay: integer(),
	closed_to_arrival: integer({ mode: "boolean" }).default(false).notNull(),
	closed_to_departure: integer({ mode: "boolean" }).default(false).notNull(),
	source: text().$type<'host' | 'import'>().notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_by: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.product_id, table.date], name: "product_nights_pk" }),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [product_stay_configs.organization_id, product_stay_configs.product_id], name: "product_nights_home_scope_fk" }).onDelete("cascade"),
	check("product_nights_date_check", sql`date(date, '+0 days') IS date`),
	check("product_nights_flags_check", sql`closed IN (0, 1) AND closed_to_arrival IN (0, 1) AND closed_to_departure IN (0, 1)`),
	check("product_nights_price_check", sql`price_minor IS NULL OR price_minor >= 0`),
	check("product_nights_stay_rules_check", sql`(min_stay_arrival IS NULL OR min_stay_arrival >= 1) AND (min_stay_through IS NULL OR min_stay_through >= 1) AND (max_stay IS NULL OR max_stay >= 1)`),
	check("product_nights_source_check", sql`source IN ('host', 'import')`),
	check("product_nights_updated_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at`),
]);

// Row meaning: a guest stays at this home for the nights
//   [check_in_date, check_out_date).
// `owner`: 'app' stays are created and edited in KrabiClaw; 'channel' stays
//   arrive from a connected channel and are read-only here — they change only
//   through that channel's revision feed.
// `overbooked`: a channel stay the channel had already confirmed when it
//   arrived, overlapping nights another stay holds. It is stored, holds no
//   night claims, and stays flagged until a person cancels one of the stays.
//   Only a channel stay can be overbooked; an app stay is refused instead.
// Money: total_minor is what the stay costs in `currency`. It is not a payment;
//   offline receipts are stay_payments, and channel-collected money is the
//   channel's.
// Null semantics: guest contact fields are NULL when the channel withholds
//   them. user_id is the guest's KrabiClaw account when known. provider and
//   its references are NULL for app stays.
// Deletion: a stay is cancelled, not deleted. Deleting the home is refused
//   while it has stays (NO ACTION); the organization's cascade removes both in
//   one statement.
export const stays = sqliteTable("stays", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	channel: text().$type<'airbnb' | 'vrbo' | 'direct'>().notNull(),
	owner: text().$type<'app' | 'channel'>().notNull(),
	status: text().$type<'pending' | 'confirmed' | 'cancelled'>().notNull(),
	overbooked: integer({ mode: "boolean" }).default(false).notNull(),
	check_in_date: text().notNull(),
	check_out_date: text().notNull(),
	arrival_time: text(),
	adults: integer().notNull(),
	children: integer().default(0).notNull(),
	infants: integer().default(0).notNull(),
	guest_name: text(),
	guest_surname: text(),
	guest_email: text(),
	guest_phone: text(),
	user_id: text().references((): AnySQLiteColumn => user.id, { onDelete: "set null" }),
	// The guest conversation about this stay, in the one inbox. NULL when the
	// stay has no guest email or phone to converse with. Losing the thread does not
	// lose the stay. Its writer keeps it in the stay's organization; a
	// composite FK here would rebuild stays and cascade its nights and payments.
	request_id: text().references((): AnySQLiteColumn => requests.id, { onDelete: "set null" }),
	total_minor: integer().notNull(),
	currency: text().notNull(),
	notes: text(),
	provider: text().$type<'channex'>(),
	external_booking_id: text(),
	channel_booking_id: text(),
	revision_id: text(),
	provider_updated_at: text(),
	idempotency_key: text(),
	booking_received_at: text(),
	cancelled_at: text(),
	cancellation_reason: text(),
	version: integer().default(1).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text(),
	updated_by: text(),
}, (table) => [
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [product_stay_configs.organization_id, product_stay_configs.product_id], name: "stays_home_scope_fk" }).onDelete("no action"),
	unique("stays_org_product_id_unique").on(table.organization_id, table.product_id, table.id),
	unique("stays_org_id_unique").on(table.organization_id, table.id),
	uniqueIndex("stays_idempotency_unique").on(table.organization_id, table.idempotency_key).where(sql`idempotency_key IS NOT NULL`),
	uniqueIndex("stays_provider_booking_unique").on(table.provider, table.external_booking_id).where(sql`external_booking_id IS NOT NULL`),
	uniqueIndex("stays_request_unique").on(table.request_id).where(sql`request_id IS NOT NULL`),
	index("stays_product_dates_idx").on(table.product_id, table.check_in_date, table.check_out_date),
	index("stays_org_dates_idx").on(table.organization_id, table.check_in_date, table.status),
	check("stays_dates_check", sql`date(check_in_date, '+0 days') IS check_in_date AND date(check_out_date, '+0 days') IS check_out_date AND check_out_date > check_in_date`),
	check("stays_arrival_time_check", sql`arrival_time IS NULL OR (arrival_time GLOB '[0-2][0-9]:[0-5][0-9]' AND arrival_time < '24:00')`),
	check("stays_party_check", sql`adults >= 1 AND children >= 0 AND infants >= 0`),
	check("stays_channel_check", sql`channel IN ('airbnb', 'vrbo', 'direct')`),
	check("stays_owner_check", sql`owner IN ('app', 'channel') AND (owner = 'channel') = (provider IS NOT NULL AND external_booking_id IS NOT NULL)`),
	check("stays_status_check", sql`status IN ('pending', 'confirmed', 'cancelled') AND (status = 'cancelled') = (cancelled_at IS NOT NULL)`),
	check("stays_overbooked_check", sql`overbooked IN (0, 1) AND (overbooked = 0 OR owner = 'channel')`),
	check("stays_app_guest_check", sql`owner = 'channel' OR (guest_name IS NOT NULL AND trim(guest_name) <> '')`),
	check("stays_money_check", sql`total_minor >= 0 AND length(currency) = 3 AND currency = upper(currency)`),
	check("stays_provider_check", sql`provider IS NULL OR provider = 'channex'`),
	check("stays_version_check", sql`version >= 1`),
	check("stays_booking_received_at_check", sql`booking_received_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', booking_received_at, '+0 days') IS booking_received_at`),
	check("stays_instants_check", sql`(cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
]);

// Row meaning: this stay holds this night at this home.
// The primary key is the overlap guard: a night is held by at most one stay,
//   so two concurrent writes for the same night cannot both commit. Claims are
//   written in the same batch as the stay and deleted when it is cancelled.
//   An overbooked or cancelled stay holds none.
// Deletion: cascades from the stay.
export const stay_nights = sqliteTable("stay_nights", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	date: text().notNull(),
	stay_id: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.product_id, table.date], name: "stay_nights_pk" }),
	foreignKey({ columns: [table.organization_id, table.product_id, table.stay_id], foreignColumns: [stays.organization_id, stays.product_id, stays.id], name: "stay_nights_stay_scope_fk" }).onDelete("cascade"),
	index("stay_nights_stay_idx").on(table.stay_id),
	check("stay_nights_date_check", sql`date(date, '+0 days') IS date`),
]);

// Row meaning: the host recorded receiving (or, negative, refunding) this
//   amount for an app stay outside Stripe. Not KrabiClaw-processed volume.
// `idempotency_key` makes a retried record the same row, never a second payment.
// Deletion: cascades from the stay. A mistaken entry is deleted by the host.
export const stay_payments = sqliteTable("stay_payments", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	stay_id: text().notNull(),
	amount_minor: integer().notNull(),
	currency: text().notNull(),
	method: text().$type<'cash' | 'bank_transfer' | 'card_external' | 'other'>().notNull(),
	paid_on: text().notNull(),
	reference: text(),
	note: text(),
	idempotency_key: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
}, (table) => [
	foreignKey({ columns: [table.organization_id, table.stay_id], foreignColumns: [stays.organization_id, stays.id], name: "stay_payments_stay_scope_fk" }).onDelete("cascade"),
	unique("stay_payments_idempotency_unique").on(table.organization_id, table.idempotency_key),
	index("stay_payments_stay_idx").on(table.stay_id, table.paid_on),
	check("stay_payments_amount_check", sql`amount_minor <> 0 AND length(currency) = 3 AND currency = upper(currency)`),
	check("stay_payments_method_check", sql`method IN ('cash', 'bank_transfer', 'card_external', 'other')`),
	check("stay_payments_paid_on_check", sql`date(paid_on, '+0 days') IS paid_on`),
	check("stay_payments_created_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
]);

// One plan snapshot per actual stay and template. The outbound activity entry
// links to the canonical guest_thread_deliveries receipt; provider IDs and send
// outcomes are never copied into a second receipt ledger here.
export const scheduled_guest_messages = sqliteTable("scheduled_guest_messages", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	stay_id: text().notNull(),
	request_id: text(),
	template_id: text(),
	template_title: text().notNull(),
	template_version: integer().notNull(),
	stay_version: integer().notNull(),
	body: text().notNull(),
	due_at: text(),
	timezone: text().notNull(),
	status: text().$type<'pending' | 'sending' | 'sent' | 'failed' | 'needs_review' | 'cancelled' | 'skipped'>().notNull(),
	reason: text(),
	error_code: text(),
	error_field: text(),
	entry_id: text().references(() => activity_entries.id, { onDelete: "no action" }),
	started_at: text(),
	sent_at: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	foreignKey({ columns: [table.organization_id, table.product_id, table.stay_id], foreignColumns: [stays.organization_id, stays.product_id, stays.id], name: "scheduled_guest_messages_stay_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.request_id], foreignColumns: [requests.organization_id, requests.id], name: "scheduled_guest_messages_request_scope_fk" }).onDelete("no action"),
	foreignKey({ columns: [table.organization_id, table.template_id], foreignColumns: [message_templates.organization_id, message_templates.id], name: "scheduled_guest_messages_template_scope_fk" }).onDelete("no action"),
	uniqueIndex("scheduled_guest_messages_template_stay_unique").on(table.template_id, table.stay_id),
	index("scheduled_guest_messages_due_idx").on(table.status, table.due_at),
	index("scheduled_guest_messages_org_created_idx").on(table.organization_id, table.created_at, table.id),
	check("scheduled_guest_messages_status_check", sql`status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped')`),
	check("scheduled_guest_messages_due_check", sql`due_at IS NOT NULL OR status IN ('failed', 'skipped')`),
	check("scheduled_guest_messages_error_check", sql`status NOT IN ('failed', 'needs_review') OR (length(trim(reason)) > 0 AND length(trim(error_code)) > 0 AND length(trim(error_field)) > 0)`),
	check("scheduled_guest_messages_sent_check", sql`status <> 'sent' OR (entry_id IS NOT NULL AND sent_at IS NOT NULL)`),
	check("scheduled_guest_messages_sending_check", sql`status <> 'sending' OR started_at IS NOT NULL`),
	check("scheduled_guest_messages_text_check", sql`length(trim(template_title)) BETWEEN 1 AND 100 AND length(trim(body)) BETWEEN 1 AND 5000 AND template_version >= 1 AND stay_version >= 1`),
	check("scheduled_guest_messages_instants_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS started_at) AND (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at, '+0 days') IS sent_at)`),
]);

// A place to stay as Channex and Airbnb know it, and how far its import got.
// The Airbnb listing and channel are known from the start; the Channex
// property, room type and rate plan are filled in as the import creates them,
// stage by stage. import_property holds the listing details the host approved
// (what the Channex property, room type and rate plan are created from), and
// import_calendar the Airbnb calendar the inventory stage writes and verifies;
// both are cleared when the import completes. Deleting the home deletes the mapping.
export const product_channel_mappings = sqliteTable("product_channel_mappings", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	provider: text().$type<'channex'>().notNull(),
	listing_id: text().notNull(),
	channel_id: text().notNull(),
	property_id: text(),
	room_type_id: text(),
	rate_plan_id: text(),
	import_stage: text().$type<'property' | 'room' | 'rate' | 'inventory' | 'verify_inventory' | 'mapping' | 'activate' | 'reservations' | 'messages' | 'complete'>().notNull(),
	import_property: text(),
	import_calendar: text(),
	enabled: integer({ mode: "boolean" }).default(false).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	primaryKey({ columns: [table.product_id, table.provider], name: "product_channel_mappings_pk" }),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [product_stay_configs.organization_id, product_stay_configs.product_id], name: "product_channel_mappings_home_scope_fk" }).onDelete("cascade"),
	uniqueIndex("product_channel_mappings_listing_unique").on(table.provider, table.listing_id),
	uniqueIndex("product_channel_mappings_property_unique").on(table.provider, table.property_id).where(sql`property_id IS NOT NULL`),
	uniqueIndex("product_channel_mappings_room_type_unique").on(table.provider, table.room_type_id).where(sql`room_type_id IS NOT NULL`),
	uniqueIndex("product_channel_mappings_rate_plan_unique").on(table.provider, table.rate_plan_id).where(sql`rate_plan_id IS NOT NULL`),
	index("product_channel_mappings_org_idx").on(table.organization_id),
	check("product_channel_mappings_provider_check", sql`provider = 'channex'`),
	check("product_channel_mappings_stage_check", sql`import_stage IN ('property', 'room', 'rate', 'inventory', 'verify_inventory', 'mapping', 'activate', 'reservations', 'messages', 'complete')`),
	check("product_channel_mappings_ids_check", sql`(import_stage = 'property' OR property_id IS NOT NULL) AND (import_stage IN ('property', 'room') OR room_type_id IS NOT NULL) AND (import_stage IN ('property', 'room', 'rate') OR rate_plan_id IS NOT NULL)`),
	check("product_channel_mappings_calendar_check", sql`import_calendar IS NULL OR (json_valid(import_calendar) AND json_type(import_calendar) = 'array')`),
	check("product_channel_mappings_property_json_check", sql`import_property IS NULL OR (json_valid(import_property) AND json_type(import_property) = 'object')`),
	check("product_channel_mappings_enabled_check", sql`enabled IN (0, 1) AND (enabled = 0 OR import_stage IN ('reservations', 'messages', 'complete'))`),
	check("product_channel_mappings_instants_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at`),
]);

// Every exchange with a channel that changed or refused something: a booking
// revision applied (then acknowledged once Channex confirms it), one ignored because its home is not
// connected, one that failed and will come back through the feed, an ARI push
// and its warnings. It records ids and outcomes, never guest names or
// messages. A revision for a home nobody connected has no organization.
export const channel_sync_log = sqliteTable("channel_sync_log", {
	id: text().primaryKey(),
	organization_id: text().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text(),
	provider: text().$type<'channex'>().notNull(),
	direction: text().$type<'inbound' | 'outbound'>().notNull(),
	kind: text().$type<'booking_revision' | 'availability' | 'restrictions'>().notNull(),
	external_id: text().notNull(),
	status: text().$type<'applied' | 'acknowledged' | 'ignored_disconnected' | 'failed' | 'needs_review' | 'pushed'>().notNull(),
	detail: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	index("channel_sync_log_external_idx").on(table.provider, table.kind, table.external_id),
	index("channel_sync_log_product_idx").on(table.product_id, table.created_at),
	index("channel_sync_log_org_idx").on(table.organization_id, table.created_at),
	check("channel_sync_log_provider_check", sql`provider = 'channex'`),
	check("channel_sync_log_direction_check", sql`direction IN ('inbound', 'outbound')`),
	check("channel_sync_log_kind_check", sql`kind IN ('booking_revision', 'availability', 'restrictions')`),
	check("channel_sync_log_status_check", sql`status IN ('applied', 'acknowledged', 'ignored_disconnected', 'failed', 'needs_review', 'pushed')`),
	check("channel_sync_log_failed_check", sql`status NOT IN ('failed', 'needs_review') OR detail IS NOT NULL`),
	check("channel_sync_log_created_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
]);

// What a channel was last told about one night of one connected home. A push
// marks its nights pending, then pushed or needs_review with the reason; a
// pending night whose request never returned stays pending. The calendar
// shows it, so a night the channel did not take is never silently out of date.
export const channel_night_pushes = sqliteTable("channel_night_pushes", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_id: text().notNull(),
	provider: text().$type<'channex'>().notNull(),
	date: text().notNull(),
	state: text().$type<'pending' | 'pushed' | 'needs_review'>().notNull(),
	detail: text(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	primaryKey({ columns: [table.product_id, table.provider, table.date], name: "channel_night_pushes_pk" }),
	foreignKey({ columns: [table.product_id, table.provider], foreignColumns: [product_channel_mappings.product_id, product_channel_mappings.provider], name: "channel_night_pushes_mapping_fk" }).onDelete("cascade"),
	index("channel_night_pushes_state_idx").on(table.organization_id, table.state),
	check("channel_night_pushes_provider_check", sql`provider = 'channex'`),
	check("channel_night_pushes_state_check", sql`state IN ('pending', 'pushed', 'needs_review')`),
	check("channel_night_pushes_detail_check", sql`state <> 'needs_review' OR detail IS NOT NULL`),
	check("channel_night_pushes_date_check", sql`date(date) IS date`),
	check("channel_night_pushes_updated_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at`),
]);

// ---------------------------------------------------------------------------
// Inventory.
//
// Optional capability: a service has no inventory row and that is correct, not
// missing data. Stock is variant-and-location identity. It is NOT a price
// attribute and NOT a boolean on products — the old `products.available`
// column conflated a merchant control with a stock count, and both are gone.
//
// Available stock derives from ONE authoritative quantity model: on_hand minus
// reserved, per level. No second counter is maintained anywhere.
// ---------------------------------------------------------------------------

// Row meaning: this variant's stock is tracked.
// Keys: one item per variant.
// Deletion: cascades from variant; cascades to levels.
// Read/write: server/utils/product-management.ts.
export const inventory_items = sqliteTable("inventory_items", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	product_variant_id: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("inventory_items_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.product_variant_id], foreignColumns: [product_variants.organization_id, product_variants.id], name: "inventory_items_variant_scope_fk" }).onDelete("cascade"),
	unique("inventory_items_org_id_unique").on(table.organization_id, table.id),
	unique("inventory_items_variant_unique").on(table.product_variant_id),
]);

// Row meaning: how much of this item is held at this location.
// `on_hand` is physical quantity; `reserved` is the part already allocated.
//   Available is on_hand - reserved, computed, never stored.
// Deletion: cascades from item and from location.
// Read/write: server/utils/product-management.ts.
export const inventory_levels = sqliteTable("inventory_levels", {
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	inventory_item_id: text().notNull(),
	location_id: text().notNull(),
	on_hand: integer().default(0).notNull(),
	reserved: integer().default(0).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	primaryKey({ columns: [table.inventory_item_id, table.location_id], name: "inventory_levels_pk" }),
	check("inventory_levels_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.inventory_item_id], foreignColumns: [inventory_items.organization_id, inventory_items.id], name: "inventory_levels_item_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "inventory_levels_location_scope_fk" }).onDelete("cascade"),
	index("inventory_levels_location_idx").on(table.location_id),
	check("inventory_levels_quantities_check", sql`on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand`),
]);

// ---------------------------------------------------------------------------
// What an organization connected: one per provider, and each provider resource
// (Page, professional account, Discord channel, GA4 property, Search Console site) on at most
// one organization. The credential is the connecting person's Better Auth
// linked account, named by `account_id`; no token is stored here. Unlinking
// that account does not remove the row: a release has work of its own (Zaraz
// stops serving a measurement id), so it goes through releaseIntegration.
// Read/write: server/utils/organization-integrations.ts.
// ---------------------------------------------------------------------------
export const organization_integrations = sqliteTable("organization_integrations", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	provider: text().$type<typeof INTEGRATION_PROVIDERS[number]>().notNull(),
	account_id: text().notNull(),
	// Page id, Instagram professional account id, Discord channel id, GA4 property id or Search Console site URL.
	target_id: text().notNull(),
	// Page name, Instagram username, Discord channel name, GA4 property name or Search Console site URL.
	target_name: text().notNull(),
	// Google Analytics only: the property's web stream, which Zaraz serves.
	measurement_id: text(),
	// Search Console only: whether Google confirmed ownership, and the meta tag
	// KrabiClaw serves while Google still requires it.
	verified: integer({ mode: "boolean" }),
	verification_token: text(),
	status: text({ enum: ["active", "disabled", "error"] }),
	last_error: text(),
	// A new selection writes a new revision, so a caller holding the old one is refused.
	revision: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	unique("organization_integrations_provider_unique").on(table.organization_id, table.provider),
	unique("organization_integrations_target_unique").on(table.provider, table.target_id),
	index("organization_integrations_account_idx").on(table.provider, table.account_id),
	check("organization_integrations_provider_check", sql`provider IN (${sql.raw(INTEGRATION_PROVIDERS.map(value => `'${value}'`).join(', '))})`),
	check("organization_integrations_values_check", sql`trim(account_id) <> '' AND trim(target_id) <> '' AND trim(target_name) <> '' AND trim(revision) <> ''`),
	check("organization_integrations_measurement_check", sql`(provider = 'google_analytics') = (measurement_id IS NOT NULL)`),
	check("organization_integrations_verification_check", sql`(provider = 'google_search_console') = (verified IS NOT NULL) AND (verification_token IS NULL OR provider = 'google_search_console') AND (verified IS NULL OR verified IN (0, 1))`),
	check("organization_integrations_calendar_check", sql`(provider = 'google_calendar') = (status IS NOT NULL) AND (status IS NULL OR status IN ('active', 'disabled', 'error')) AND (provider = 'google_calendar' OR (status IS NULL AND last_error IS NULL))`),
	check("organization_integrations_instants_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at`),
]);

// An organization's Airbnb account, connected through Channex. It is one row
// per organization with its own lifecycle: a Channex group and a temporary
// setup property, a single-use sign-in bound to the person who started it,
// then the connected channel. operation_id is the lock one setup step holds;
// pending_step names a provider write that was sent and may have applied, so
// a failure there is held for review instead of being repeated.
export const channex_connections = sqliteTable("channex_connections", {
	organization_id: text().primaryKey().references(() => organization.id, { onDelete: "cascade" }),
	status: text().$type<'not_connected' | 'authorizing' | 'connected' | 'disconnecting' | 'needs_review'>().notNull(),
	operation_id: text(),
	pending_step: text(),
	group_id: text(),
	setup_property_id: text(),
	state_hash: text(),
	authorization_url: text(),
	authorization_user_id: text().references(() => user.id, { onDelete: "set null" }),
	authorization_title: text(),
	authorization_expires_at: text(),
	channel_id: text(),
	connected_at: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	uniqueIndex("channex_connections_group_unique").on(table.group_id).where(sql`group_id IS NOT NULL`),
	uniqueIndex("channex_connections_channel_unique").on(table.channel_id).where(sql`channel_id IS NOT NULL`),
	check("channex_connections_status_check", sql`status IN ('not_connected', 'authorizing', 'connected', 'disconnecting', 'needs_review')`),
	check("channex_connections_connected_check", sql`status <> 'connected' OR (channel_id IS NOT NULL AND group_id IS NOT NULL AND connected_at IS NOT NULL)`),
	check("channex_connections_authorizing_check", sql`status <> 'authorizing' OR (authorization_url IS NOT NULL AND state_hash IS NOT NULL AND authorization_expires_at IS NOT NULL AND authorization_title IS NOT NULL)`),
	check("channex_connections_instants_check", sql`(authorization_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', authorization_expires_at, '+0 days') IS authorization_expires_at) AND (connected_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', connected_at, '+0 days') IS connected_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at`),
]);

// ---------------------------------------------------------------------------
// Stripe identity mapping.
//
// Local ids are local identity. Stripe ids live here, keyed by local entity,
// Stripe account and livemode — never in a metadata key, and a local id is
// never reused as a provider id.
//
// The adapter: Stripe Price references a Stripe Product; locally a price
// references a VARIANT, whose parent identifies the product. So a variant maps
// to a Stripe Product when it is exported. Stripe has no native variant and no
// class-session concept; nothing here pretends otherwise.
//
// An exported default price must belong to the mapped product. It is not a
// universal selector across local variants, currencies or locations — price
// selection is shared/prices.ts, always.
//
// Platform subscription billing (Better Auth's `subscription` table) is the
// PLATFORM's billing, not a merchant's catalog. These mappings never join to it.
// Read/write: server/utils/stripe-catalog.ts.
// ---------------------------------------------------------------------------
export const stripe_connected_accounts = sqliteTable("stripe_connected_accounts", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	stripe_account_id: text().unique(),
	// The country Stripe reports for the account. Stripe's hosted onboarding has
	// the owner choose it, so it is null until Stripe has one.
	country: text(),
	livemode: integer({ mode: "boolean" }).notNull(),
	// 'creating' | 'creation_failed' | 'action_required' | 'pending_review' |
	// 'restricted' | 'ready'. Derived only from an Accounts v2 retrieval.
	status: text().default("creating").notNull(),
	// Accounts v2 merchant.card_payments capability status.
	card_payments_status: text(),
	/** Pass on credit card fees: the surcharge rate in basis points, bounded by Stripe's maximum per card; NULL is off. */
	surcharge_basis_points: integer(),
	// Normalized requirements needed by the dashboard. Stripe remains the
	// authority; KrabiClaw never collects or stores the requested KYC values.
	requirements_json: text().default("[]").notNull(),
	stripe_refreshed_at: text(),
	last_error: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	unique("stripe_connected_accounts_org_unique").on(table.organization_id),
	index("stripe_connected_accounts_status_idx").on(table.status, table.updated_at),
	check("stripe_connected_accounts_country_check", sql`country IS NULL OR (length(country) = 2 AND country = upper(country) AND country NOT GLOB '*[^A-Z]*')`),
	check("stripe_connected_accounts_livemode_check", sql`livemode IN (0, 1)`),
	check("stripe_connected_accounts_status_check", sql`status IN ('creating', 'creation_failed', 'action_required', 'pending_review', 'restricted', 'ready')`),
	check("stripe_connected_accounts_capability_check", sql`card_payments_status IS NULL OR card_payments_status IN ('active', 'pending', 'restricted', 'unsupported')`),
	check("stripe_connected_accounts_requirements_check", sql`json_valid(requirements_json) AND json_type(requirements_json) = 'array'`),
	check("stripe_connected_accounts_identity_check", sql`(stripe_account_id IS NULL AND status IN ('creating', 'creation_failed')) OR (trim(stripe_account_id) <> '' AND status IN ('action_required', 'pending_review', 'restricted', 'ready'))`),
	check("stripe_connected_accounts_instants_check", sql`(stripe_refreshed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', stripe_refreshed_at, '+0 days') IS stripe_refreshed_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
]);





export const oauthAccessToken = sqliteTable("oauthAccessToken", {
	id: text().primaryKey(),
	clientId: text().notNull(),
	userId: text(),
	token: text().notNull().unique(),
	scopes: text().default("[]").notNull(),
	authorizationCodeId: text(),
	resources: text(),
	requestedUserInfoClaims: text(),
	expiresAt: integer({ mode: "timestamp" }).notNull(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
	sessionId: text(),
	referenceId: text(),
	refreshId: text(),
	revoked: integer({ mode: "timestamp" }),
	confirmation: text(),
});

// The provider address of one conversation in the canonical requests/activity ledger.
// A channel inquiry has no stay yet; external_booking_id records a later provider
// association without inventing an operational booking or guest contact.
export const channel_threads = sqliteTable("channel_threads", {
	provider: text().$type<'channex'>().notNull(),
	external_thread_id: text().notNull(),
	organization_id: text().notNull(),
	product_id: text().notNull(),
	request_id: text().notNull(),
	external_booking_id: text(),
	provider_updated_at: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, table => [
	primaryKey({ columns: [table.provider, table.external_thread_id], name: "channel_threads_pk" }),
	foreignKey({ columns: [table.organization_id, table.request_id], foreignColumns: [requests.organization_id, requests.id], name: "channel_threads_request_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [product_stay_configs.organization_id, product_stay_configs.product_id], name: "channel_threads_home_scope_fk" }).onDelete("no action"),
	foreignKey({ columns: [table.product_id, table.provider], foreignColumns: [product_channel_mappings.product_id, product_channel_mappings.provider], name: "channel_threads_mapping_fk" }).onDelete("no action"),
	uniqueIndex("channel_threads_request_unique").on(table.request_id),
	uniqueIndex("channel_threads_booking_unique").on(table.provider, table.external_booking_id).where(sql`external_booking_id IS NOT NULL`),
	index("channel_threads_org_idx").on(table.organization_id),
	check("channel_threads_provider_check", sql`provider = 'channex'`),
	check("channel_threads_instants_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at`),
]);

export const oauthClient = sqliteTable("oauthClient", {
	id: text().primaryKey(),
	clientId: text().notNull().unique(),
	clientSecret: text(),
	name: text().notNull(),
	redirectUris: text().notNull(),
	scopes: text().default("[]").notNull(),
	clientCredentialsScopes: text().default("[]").notNull(),
	clientDiscoveryId: text(),
	applicationType: text(),
	requirePKCE: integer({ mode: "boolean" }).default(true).notNull(),
	skipConsent: integer({ mode: "boolean" }).default(false).notNull(),
	userId: text(),
	metadata: text(),
	disabled: integer({ mode: "boolean" }).default(false).notNull(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
	updatedAt: integer({ mode: "timestamp" }).notNull(),
	enableEndSession: integer({ mode: "boolean" }),
	subjectType: text(),
	uri: text(),
	icon: text(),
	contacts: text(),
	tos: text(),
	policy: text(),
	softwareId: text(),
	softwareVersion: text(),
	softwareStatement: text(),
	postLogoutRedirectUris: text(),
	backchannelLogoutUri: text(),
	backchannelLogoutSessionRequired: integer({ mode: "boolean" }).default(false).notNull(),
	tokenEndpointAuthMethod: text(),
	jwks: text(),
	jwksUri: text(),
	grantTypes: text(),
	responseTypes: text(),
	type: text(),
	dpopBoundAccessTokens: integer({ mode: "boolean" }).default(false).notNull(),
	referenceId: text(),
});

export const oauthClientAssertion = sqliteTable("oauthClientAssertion", {
	id: text().primaryKey(),
	expiresAt: integer({ mode: "timestamp" }).notNull(),
});

export const oauthResource = sqliteTable("oauthResource", {
	id: text().primaryKey(),
	identifier: text().notNull().unique(),
	name: text().notNull(),
	accessTokenTtl: integer(),
	refreshTokenTtl: integer(),
	signingAlgorithm: text(),
	signingKeyId: text(),
	allowedScopes: text(),
	customClaims: text(),
	dpopBoundAccessTokensRequired: integer({ mode: "boolean" }).default(false).notNull(),
	disabled: integer({ mode: "boolean" }).default(false).notNull(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
	updatedAt: integer({ mode: "timestamp" }).notNull(),
	policyVersion: integer().default(1).notNull(),
	metadata: text(),
});

export const oauthClientResource = sqliteTable("oauthClientResource", {
	id: text().primaryKey(),
	clientId: text().notNull().references(() => oauthClient.id, { onDelete: "cascade" }),
	resourceId: text().notNull().references(() => oauthResource.id, { onDelete: "cascade" }),
	metadata: text(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
});

export const oauthConsent = sqliteTable("oauthConsent", {
	id: text().primaryKey(),
	clientId: text().notNull(),
	userId: text().notNull(),
	scopes: text().default("").notNull(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
	updatedAt: integer({ mode: "timestamp" }).notNull(),
	referenceId: text(),
	resources: text(),
	requestedUserInfoClaims: text(),
}, (table) => [
	unique("oauthConsent_clientId_userId_unique").on(table.clientId, table.userId),
]);

export const oauthRefreshToken = sqliteTable("oauthRefreshToken", {
	id: text().primaryKey(),
	clientId: text().notNull(),
	userId: text(),
	token: text().notNull().unique(),
	scopes: text().default("").notNull(),
	authorizationCodeId: text(),
	resources: text(),
	requestedUserInfoClaims: text(),
	expiresAt: integer({ mode: "timestamp" }).notNull(),
	createdAt: integer({ mode: "timestamp" }).notNull(),
	sessionId: text(),
	referenceId: text(),
	revoked: integer({ mode: "timestamp" }),
	rotatedAt: integer({ mode: "timestamp" }),
	rotationReplayResponse: text(),
	rotationReplayExpiresAt: integer({ mode: "timestamp" }),
	authTime: integer({ mode: "timestamp" }),
	confirmation: text(),
});

/**
 * The business. One record, one name, one handle, one mark.
 *
 * This used to be two: an `organization` holding identity and membership, and a
 * `organizations` row beside it holding everything the business actually is. The two
 * disagreed — `organization.name` read "Pottery House Owner" while the site
 * rendered "Pottery House Krabi" — and the handle lived in three columns across
 * them. `organizations` is gone and its configuration is here, as Better Auth
 * `additionalFields` (see organizationOptions in server/utils/auth.ts), which is
 * the plugin's own extension point rather than a table bolted alongside it.
 *
 * `name` carries what `organization.brand_name` carried: the name the business's own
 * website renders in `og:site_name`. There is no separate brand name.
 */
export const organization = sqliteTable("organization", {
	id: text().primaryKey(),
	name: text().notNull(),
	slug: text().notNull().unique(),
	metadata: text(),
	// Better Auth Stripe plugin organization customer field.
	stripeCustomerId: text().unique(),
	createdAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),

	// Better Auth's organization plugin declares this column and validates its
	// own schema at runtime, so the table must carry it whether or not anything
	// writes it: without it every organization call — sign-in included — fails
	// with "Drizzle schema mismatch". The brand mark itself is the `logo` media
	// placement, which is why this stays NULL.
	logo: text(),

	// ── Formerly `organizations`. ────────────────────────────────────────────────────
	consultation_settings_json: text({ mode: "json" }).$type<OrganizationSettings["consultation"]>(),
	settings_json: text({ mode: "json" }).$type<OrganizationSettings>().default({}).notNull(),
	theme_id: text().default("saya-theme-v1").notNull(),
	subdomain: text().unique(),
	brand_description: text(),
	contact_email: text(),
	contact_phone: text(),
	// Better Auth additional fields (server/utils/auth.ts): required at creation.
	default_currency: text().notNull(),
	// The business's reporting clock — analytics days. Bookings use their
	// location's timezone or their provider's, never this.
	timezone: text().notNull(),
	status: text().default("active").notNull(),
	onboarding_status: text().default("pending").notNull(),
	url_structure: text().default("location_subdirectories").notNull(),
	vertical: text().default("restaurant").notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_by: text(),
	seo_title: text(),
	seo_description: text(),
	canonical_url: text(),
	// JSON { enabled?: ProductFeature[]; disabled?: ProductFeature[] } delta (config/cms-registry.ts)
	// layered additively/subtractively on top of the vertical's own module defaults — NULL means
	// "use vertical defaults as-is." Only real business modules (products/ordering/reservations/
	// experiences/services) are ever stored here; content managers (blog/qa/reviews/posts/photos/
	// media) are always-on and never appear in this column.
	analytics_data_start_at: text(),
}, (table) => [
	check("organization_slug_required_check", sql`trim(slug) <> ''`),
	// `createdAt` is Better Auth's integer unixepoch, not a text instant, so it
	// is not checked here. `last_published_at` was, and is gone: `updated_at` is
	// the row's modification time and nothing else recorded a publish.
	check("organization_instants_check", sql`(updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at) AND (analytics_data_start_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', analytics_data_start_at, '+0 days') IS analytics_data_start_at)`),
	check("organization_settings_json_check", sql`json_valid(settings_json) AND json_type(settings_json) IS 'object'`),
	check("organization_consultation_settings_check", sql`consultation_settings_json IS NULL OR (json_valid(consultation_settings_json) AND json_type(consultation_settings_json) IS 'object' AND json_extract(consultation_settings_json, '$.mode') IN ('external_url', 'native_disabled', 'native') AND json_type(consultation_settings_json, '$.cta_label') IS 'text' AND json_type(consultation_settings_json, '$.schedule_path') IS 'text' AND json_extract(consultation_settings_json, '$.schedule_path') LIKE '/%' AND json_type(consultation_settings_json, '$.confirmation_path') IS 'text' AND json_extract(consultation_settings_json, '$.confirmation_path') LIKE '/%' AND json_type(consultation_settings_json, '$.tracking_enabled') IN ('true', 'false') AND (json_type(consultation_settings_json, '$.metadata_json') IS NULL OR json_type(consultation_settings_json, '$.metadata_json') IN ('null', 'object')) AND (json_type(consultation_settings_json, '$.external_url') IS NULL OR json_type(consultation_settings_json, '$.external_url') IN ('null', 'text'))) IS TRUE`),
	check("organization_config_palette_check", sql`json_type(settings_json, '$.config.palette') IS NULL OR (json_type(settings_json, '$.config.palette.light') IS 'object' AND json_type(settings_json, '$.config.palette.dark') IS 'object') IS TRUE`),
	check("organization_config_font_preset_check", sql`json_type(settings_json, '$.config.font_preset') IS NULL OR json_type(settings_json, '$.config.font_preset') IS 'text'`),
	check("organization_config_press_email_check", sql`json_type(settings_json, '$.config.press_email') IS NULL OR json_type(settings_json, '$.config.press_email') IS 'text'`),
	check("organization_config_partnerships_email_check", sql`json_type(settings_json, '$.config.partnerships_email') IS NULL OR json_type(settings_json, '$.config.partnerships_email') IS 'text'`),
	check("organization_config_catering_email_check", sql`json_type(settings_json, '$.config.catering_email') IS NULL OR json_type(settings_json, '$.config.catering_email') IS 'text'`),
	check("organization_config_careers_email_check", sql`json_type(settings_json, '$.config.careers_email') IS NULL OR json_type(settings_json, '$.config.careers_email') IS 'text'`),
	check("organization_default_currency_check", sql`length(default_currency) = 3 AND default_currency = upper(default_currency) AND default_currency NOT GLOB '*[^A-Z]*'`),
	check("organization_timezone_check", sql`timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'`),
	check("organization_compliance_metadata_check", sql`json_type(settings_json, '$.compliance.metadata_json') IS NULL OR json_type(settings_json, '$.compliance.metadata_json') IN ('null', 'object')`),
	check("organization_config_object_check", sql`json_type(settings_json, '$.config') IS NULL OR json_type(settings_json, '$.config') IS 'object'`),
	check("organization_compliance_object_check", sql`json_type(settings_json, '$.compliance') IS NULL OR json_type(settings_json, '$.compliance') IS 'object'`),
	check("organization_compliance_check", sql`json_type(settings_json, '$.compliance') IS NULL OR (json_extract(settings_json, '$.compliance.address_visibility') IN ('visible', 'hidden') AND (json_extract(settings_json, '$.compliance.service_area_type') IS NULL OR json_extract(settings_json, '$.compliance.service_area_type') IN ('AdministrativeArea', 'City', 'Country', 'Place', 'State')) AND json_type(settings_json, '$.compliance.same_as') IN ('array', 'null') AND json_type(settings_json, '$.compliance.contact_points') IN ('array', 'null')) IS TRUE`),
	check("organization_compliance_nonprofit_check", sql`json_extract(settings_json, '$.compliance.nonprofit_status') IS NULL OR json_extract(settings_json, '$.compliance.nonprofit_status') IN (${sql.raw([...NONPROFIT_STATUS_CANONICAL].map(value => `'${value}'`).join(', '))})`),
	index("organization_created_at_idx").on(table.createdAt),
]);

export const subscription = sqliteTable("subscription", {
	id: text().primaryKey(),
	plan: text().notNull(),
	referenceId: text().notNull(),
	stripeCustomerId: text(),
	stripeSubscriptionId: text().unique(),
	status: text().default("incomplete").notNull(),
	periodStart: integer({ mode: "timestamp" }),
	periodEnd: integer({ mode: "timestamp" }),
	trialStart: integer({ mode: "timestamp" }),
	trialEnd: integer({ mode: "timestamp" }),
	cancelAtPeriodEnd: integer({ mode: "boolean" }).default(false).notNull(),
	cancelAt: integer({ mode: "timestamp" }),
	canceledAt: integer({ mode: "timestamp" }),
	endedAt: integer({ mode: "timestamp" }),
	seats: integer(),
	billingInterval: text(),
	stripeScheduleId: text(),
}, (table) => [
	index("subscription_referenceId_idx").on(table.referenceId),
	index("subscription_status_idx").on(table.status),
]);

export const onboarding_drafts = sqliteTable("onboarding_drafts", {
	id: text().primaryKey(),
	user_id: text().notNull().references(() => user.id, { onDelete: "cascade" } ),
	organization_id: text().references(() => organization.id, { onDelete: "cascade" } ),
	name: text().notNull(),
	vertical: text().notNull(),
	subdomain_candidate: text(),
	source_type: text().notNull(),
	status: text().default("active").notNull(),
	payload_json: text().notNull(),
	committed_at: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("onboarding_drafts_instants_check", sql`(committed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', committed_at, '+0 days') IS committed_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	check("onboarding_drafts_payload_json_check", sql`payload_json IS NULL OR (json_valid(payload_json) AND json_type(payload_json) IS 'object')`),
	uniqueIndex("idx_onboarding_drafts_active_user_unique").on(table.user_id).where(sql`status = 'active'`),
	index("onboarding_drafts_user_id_idx").on(table.user_id),
]);

// A single-use link that adds whoever opens it to an organization. Better Auth
// invitations are bound to an email address, which an inviter cannot know for
// a person who signs in with Apple's private relay; the link carries the role
// instead, and accepting it adds the member through Better Auth's addMember.
// Only the token's SHA-256 is stored.
export const organization_invite_links = sqliteTable("organization_invite_links", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	role: text().notNull(),
	token_hash: text().notNull(),
	inviter_id: text().notNull().references(() => user.id, { onDelete: "cascade" } ),
	expires_at: text().notNull(),
	used_at: text(),
	used_by_user_id: text().references(() => user.id, { onDelete: "set null" } ),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("organization_invite_links_instants_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at AND (used_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', used_at, '+0 days') IS used_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
	check("organization_invite_links_role_check", sql`role IN ('admin', 'member')`),
	uniqueIndex("organization_invite_links_token_hash_unique").on(table.token_hash),
	index("organization_invite_links_organization_id_idx").on(table.organization_id),
]);

export const rate_limits = sqliteTable("rate_limits", {
	key: text().primaryKey(),
	count: integer().default(0).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	expires_at: text(),
}, (table) => [
	check("rate_limits_instants_check", sql`(updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at) AND (expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at)`),
	index("idx_rate_limits_expires").on(table.expires_at),
]);



export const review_requests = sqliteTable("review_requests", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	location_id: text().references(() => business_locations.id, { onDelete: "set null" } ),
	booking_type: text().notNull(),
	booking_id: text().notNull(),
	token_hash: text().notNull().unique(),
	expires_at: text().notNull(),
	first_sent_at: text(),
	reminder_sent_at: text(),
	submitted_at: text(),
	clicked_at: text(),
	revoked_at: text(),
	send_count: integer().default(0).notNull(),
	last_error: text(),
	user_id: text().references(() => user.id, { onDelete: "set null" } ),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("review_requests_instants_check", sql`(expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at) AND (first_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', first_sent_at, '+0 days') IS first_sent_at) AND (reminder_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', reminder_sent_at, '+0 days') IS reminder_sent_at) AND (submitted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at, '+0 days') IS submitted_at) AND (clicked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', clicked_at, '+0 days') IS clicked_at) AND (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') IS revoked_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
 foreignKey({ columns: [table.organization_id, table.booking_id, table.booking_type], foreignColumns: [requests.organization_id, requests.id, requests.kind], name: "review_requests_booking_scope_fk" }).onDelete("cascade"),
	uniqueIndex("idx_review_requests_active_booking_unique")
		.on(table.booking_type, table.booking_id)
		.where(sql`revoked_at IS NULL AND submitted_at IS NULL`),
	index("idx_review_requests_send_due").on(table.organization_id, table.first_sent_at, table.reminder_sent_at, table.submitted_at, table.expires_at),
	index("review_requests_organization_id_idx").on(table.organization_id),
]);


export const reviews = sqliteTable("reviews", {
	id: text().primaryKey(),
	organization_id: text().references(() => organization.id, { onDelete: "cascade" } ),
	location_id: text().references(() => business_locations.id, { onDelete: "cascade" } ),
	booking_id: text(),
	booking_type: text(),
	review_request_id: text().references(() => review_requests.id, { onDelete: "set null" } ),
	user_id: text().references(() => user.id, { onDelete: "set null" } ),
	product_id: text(),
	author_name: text(),
	rating: integer().notNull(),
	title: text(),
	content: text(),
	google_review_id: text(),
	google_review_metadata: text(),
	owner_reply: text(),
	owner_reply_at: text(),
	helpful_count: integer().default(0).notNull(),
	status: text().default("pending").notNull(),
	source: text().default("direct").notNull(),
	entered_by_user_id: text().references(() => user.id, { onDelete: "set null" } ),
	collection_method: text(),
	original_review_date: text(),
	original_reference: text(),
	publication_authorized: integer().default(0).notNull(),
	ip_hash: text(),
	user_agent: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("reviews_instants_check", sql`(owner_reply_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', owner_reply_at, '+0 days') IS owner_reply_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	check("reviews_google_review_metadata_check", sql`google_review_metadata IS NULL OR (json_valid(google_review_metadata) AND json_type(google_review_metadata) IS 'object')`),
	uniqueIndex("reviews_google_review_scope_unique").on(table.organization_id, table.location_id, table.google_review_id),
	// The catalog is organization-owned, so a product review scopes to
	// (organization, product). The review's own site/location remain its
	// display scope and are unrelated to where the Product is offered. NO
	// ACTION: deleting the product alone is refused while a review names it,
	// and deleting the organization removes both in one statement.
	foreignKey({
		columns: [table.organization_id, table.product_id],
		foreignColumns: [products.organization_id, products.id],
		name: "reviews_product_scope_fk",
	}).onDelete("no action"),
	index("idx_reviews_request_id").on(table.review_request_id),
	index("reviews_org_user_idx").on(table.organization_id, table.user_id),
	index("idx_reviews_location_status").on(table.location_id, table.status, table.created_at),
	index("idx_reviews_org_status").on(table.status, table.created_at).where(sql`location_id IS NULL`),
	index("idx_reviews_product_status_created").on(table.product_id, table.status, table.created_at),
	check("reviews_rating_check", sql`rating BETWEEN 1 AND 5`),
	check("reviews_product_scope_check", sql`product_id IS NULL OR organization_id IS NOT NULL`),
	check("reviews_owner_entered_provenance_check", sql`source != 'owner_entered' OR (organization_id IS NOT NULL AND location_id IS NULL AND entered_by_user_id IS NOT NULL AND collection_method IS NOT NULL AND publication_authorized = 1)`),
	index("reviews_organization_id_idx").on(table.organization_id),
]);

export const session = sqliteTable("session", {
	id: text().primaryKey(),
	expiresAt: integer({ mode: "timestamp" }).notNull(),
	token: text().notNull().unique(),
	createdAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
	updatedAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
	ipAddress: text(),
	userAgent: text(),
	activeOrganizationId: text(),
	activeTeamId: text(),
	impersonatedBy: text(),
	userId: text().notNull().references(() => user.id, { onDelete: "cascade" } ),
}, (table) => [
	index("session_userId_idx").on(table.userId),
]);

export const device_tokens = sqliteTable("device_tokens", {
	token: text().primaryKey(),
	user_id: text().notNull().references(() => user.id, { onDelete: "cascade" }),
	session_id: text().notNull().references(() => session.id, { onDelete: "cascade" }),
	environment: text().$type<'sandbox' | 'production'>().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	index("device_tokens_user_idx").on(table.user_id),
	index("device_tokens_session_idx").on(table.session_id),
	check("device_tokens_token_check", sql`length(token) > 0 AND length(token) % 2 = 0 AND token NOT GLOB '*[^0123456789abcdef]*'`),
	check("device_tokens_environment_check", sql`environment IN ('sandbox', 'production')`),
	check("device_tokens_created_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
	check("device_tokens_updated_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at`),
]);

// ---------------------------------------------------------------------------
// Team conversations: members of one organization talking to each other, for
// example a cleaner and the host about one stay. Guests are never in them.
//
// A seat is a Better Auth member row, so removing someone from the
// organization removes their seats; their messages stay, sent by their user.
// The thread may be about one stay (stay_id); that stay cannot be deleted
// while a conversation names it.
// ---------------------------------------------------------------------------
export const team_threads = sqliteTable("team_threads", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	stay_id: text(),
	created_by_user_id: text().references(() => user.id, { onDelete: "set null" }),
	// SHA-256 of the stay and the sorted member ids the conversation was started
	// with: starting the same conversation again, or twice at once, finds this one.
	participants_key: text().notNull(),
	// The newest message's time, or the creation time before the first message.
	last_message_at: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	foreignKey({ columns: [table.organization_id, table.stay_id], foreignColumns: [stays.organization_id, stays.id], name: "team_threads_stay_scope_fk" }).onDelete("no action"),
	unique("team_threads_org_id_unique").on(table.organization_id, table.id),
	uniqueIndex("team_threads_participants_unique").on(table.organization_id, table.participants_key),
	index("team_threads_org_activity_idx").on(table.organization_id, table.last_message_at),
	index("team_threads_org_stay_idx").on(table.organization_id, table.stay_id),
	check("team_threads_instants_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', last_message_at, '+0 days') IS last_message_at AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
]);

// One seat per member, with how far that member has read.
export const team_thread_members = sqliteTable("team_thread_members", {
	thread_id: text().notNull(),
	organization_id: text().notNull(),
	member_id: text().notNull(),
	last_read_at: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	primaryKey({ columns: [table.thread_id, table.member_id] }),
	foreignKey({ columns: [table.organization_id, table.thread_id], foreignColumns: [team_threads.organization_id, team_threads.id], name: "team_thread_members_thread_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.member_id, table.organization_id], foreignColumns: [member.id, member.organizationId], name: "team_thread_members_member_scope_fk" }).onDelete("cascade"),
	index("team_thread_members_member_idx").on(table.member_id),
	check("team_thread_members_instants_check", sql`(last_read_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_read_at, '+0 days') IS last_read_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
]);

// A message's photos are media placements (team_message / attachments).
// sender_user_id is NULL only once the sender's account has been deleted.
// The sender's idempotency key replays the same message instead of a second one.
export const team_messages = sqliteTable("team_messages", {
	id: text().primaryKey(),
	organization_id: text().notNull(),
	thread_id: text().notNull(),
	sender_user_id: text().references(() => user.id, { onDelete: "set null" }),
	body: text().notNull(),
	idempotency_key: text().notNull(),
	request_hash: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	foreignKey({ columns: [table.organization_id, table.thread_id], foreignColumns: [team_threads.organization_id, team_threads.id], name: "team_messages_thread_scope_fk" }).onDelete("cascade"),
	unique("team_messages_org_id_unique").on(table.organization_id, table.id),
	uniqueIndex("team_messages_thread_idempotency_unique").on(table.thread_id, table.idempotency_key),
	index("team_messages_thread_created_idx").on(table.thread_id, table.created_at, table.id),
	check("team_messages_body_check", sql`length(body) <= 5000 AND body = trim(body)`),
	check("team_messages_idempotency_check", sql`length(idempotency_key) BETWEEN 1 AND 200`),
	check("team_messages_created_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
]);



export const organization_redirects = sqliteTable("organization_redirects", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	locale: text().notNull(),
	owner_type: text(),
	owner_id: text(),
	from_path: text().notNull(),
	to_path: text(),
	status_code: integer().default(301).notNull(),
	behavior: text().default("redirect").notNull(),
	reason: text(),
	source: text().default("manual").notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("organization_redirects_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	unique("organization_redirects_org_locale_from_path_unique").on(table.organization_id, table.locale, table.from_path),
	check("organization_redirects_from_path_check", sql`from_path LIKE '/%'`),
	check("organization_redirects_redirect_to_path_check", sql`behavior != 'redirect' OR to_path IS NOT NULL`),
	check("organization_redirects_owner_check", sql`(owner_type IS NULL AND owner_id IS NULL) OR (owner_type IS NOT NULL AND owner_id IS NOT NULL)`),
	index("organization_redirects_organization_id_idx").on(table.organization_id),
	index("organization_redirects_owner_idx").on(table.owner_type, table.owner_id),
]);


export const organization_domains = sqliteTable("organization_domains", {
	id: text().primaryKey(),
	organization_id: text().references(() => organization.id, { onDelete: "cascade" } ),
	former_organization_id: text(),
	successor_domain: text(),
	retired_at: text(),
	reconciliation_token: text(),
	reconciliation_expires_at: text(),
	desired_state: text({ enum: ["active", "deleted"] }).default("active").notNull(),
	domain: text().notNull().unique(),
	type: text().notNull(),
	role: text().default("secondary").notNull(),
	status: text().default("pending").notNull(),
	cloudflare_hostname_id: text().unique(),
	cloudflare_hostname_status: text(),
	cloudflare_ssl_status: text(),
	ownership_validation_name: text(),
	ownership_validation_type: text(),
	ownership_validation_value: text(),
	ssl_validation_name: text(),
	ssl_validation_type: text(),
	ssl_validation_value: text(),
	ssl_validation_name_2: text(),
	ssl_validation_type_2: text(),
	ssl_validation_value_2: text(),
	validation_strategy: text().default("http_auto").notNull(),
	dcv_delegation_name: text(),
	dcv_delegation_type: text(),
	dcv_delegation_value: text(),
	dns_target: text(),
	dns_status: text().default("pending").notNull(),
	dns_last_resolved_at: text(),
	dns_resolved_target: text(),
	last_synced_at: text(),
	next_check_at: text(),
	retry_count: integer().default(0).notNull(),
	activated_at: text(),
	certificate_last_active_at: text(),
	renewal_issue_started_at: text(),
	renewal_notification_sent_at: text(),
	certificate_expires_at: text(),
	error_message: text(),
	metadata: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("organization_domains_instants_check", sql`(retired_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', retired_at, '+0 days') IS retired_at) AND (reconciliation_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', reconciliation_expires_at, '+0 days') IS reconciliation_expires_at) AND (dns_last_resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', dns_last_resolved_at, '+0 days') IS dns_last_resolved_at) AND (last_synced_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at, '+0 days') IS last_synced_at) AND (next_check_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', next_check_at, '+0 days') IS next_check_at) AND (activated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', activated_at, '+0 days') IS activated_at) AND (certificate_last_active_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', certificate_last_active_at, '+0 days') IS certificate_last_active_at) AND (renewal_issue_started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', renewal_issue_started_at, '+0 days') IS renewal_issue_started_at) AND (renewal_notification_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', renewal_notification_sent_at, '+0 days') IS renewal_notification_sent_at) AND (certificate_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', certificate_expires_at, '+0 days') IS certificate_expires_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	check("organization_domains_owner_check", sql`(status = 'retired' AND type = 'subdomain' AND role = 'secondary' AND organization_id IS NULL AND former_organization_id IS NOT NULL AND retired_at IS NOT NULL) OR (status <> 'retired' AND organization_id IS NOT NULL AND former_organization_id IS NULL AND retired_at IS NULL AND successor_domain IS NULL)`),
	check("organization_domains_desired_state_check", sql`desired_state IN ('active', 'deleted') AND (desired_state <> 'deleted' OR type = 'custom')`),
	check("organization_domains_lease_check", sql`(reconciliation_token IS NULL) = (reconciliation_expires_at IS NULL)`),
	check("organization_domains_metadata_check", sql`metadata IS NULL OR (json_valid(metadata))`),
	index("organization_domains_org_idx").on(table.organization_id),
	uniqueIndex("idx_organization_domains_one_canonical").on(table.organization_id).where(sql`role = 'canonical' AND status = 'active'`),
	uniqueIndex("organization_domains_one_active_subdomain").on(table.organization_id).where(sql`type = 'subdomain' AND status = 'active'`),
	index("idx_organization_domains_reconcile").on(table.status, table.next_check_at),
]);



export const organization_locales = sqliteTable("organization_locales", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	locale: text().notNull(),
	label: text(),
	is_source: integer({ mode: "boolean" }).default(false).notNull(),
	document_role: text().generatedAlwaysAs(sql`CASE WHEN is_source = 1 THEN 'root' ELSE 'representation' END`),
	status: text().default("disabled").notNull(),
	activated_at: text(),
	disabled_at: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("organization_locales_instants_check", sql`(activated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', activated_at, '+0 days') IS activated_at) AND (disabled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', disabled_at, '+0 days') IS disabled_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	unique("organization_locales_organization_id_locale_unique").on(table.organization_id, table.locale),
	unique("organization_locales_locale_role_unique").on(table.organization_id, table.locale, table.document_role),
	uniqueIndex("idx_organization_locales_one_source_per_org").on(table.organization_id).where(sql`is_source = 1`),
	check("organization_locales_status_check", sql`status IN ('published', 'disabled') AND (is_source = 0 OR status = 'published')`),
]);

export const mcp_tool_call_events = sqliteTable("mcp_tool_call_events", {
	id: text().primaryKey(),
	organization_id: text().references(() => organization.id, { onDelete: "set null" } ),
	location_id: text().references(() => business_locations.id, { onDelete: "set null" } ),
	user_id: text().references(() => user.id, { onDelete: "set null" } ),
	mcp_surface: text().default("client").notNull(),
	request_id: text(),
	method: text().notNull(),
	tool_name: text(),
	tool_domain: text(),
	is_mutating: integer(),
	arguments_summary_json: text(),
	result_summary_json: text(),
	status: text().notNull(),
	error_code: text(),
	error_message: text(),
	http_status: integer(),
	jsonrpc_error_code: integer(),
	jsonrpc_error_message: text(),
	protocol_version: text(),
	session_id_hash: text(),
	oauth_client_id_hash: text(),
	user_agent: text(),
	cf_ray_id: text(),
	catalog_fingerprint: text(),
	unknown_tool_name: text(),
	duration_ms: integer(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("mcp_tool_call_events_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)`),
	check("mcp_tool_call_events_arguments_summary_json_check", sql`arguments_summary_json IS NULL OR (json_valid(arguments_summary_json))`),
	check("mcp_tool_call_events_result_summary_json_check", sql`result_summary_json IS NULL OR (json_valid(result_summary_json))`),
	check("mcp_tool_call_events_duration_check", sql`duration_ms >= 0`),
	index("idx_mcp_tool_call_events_created_at").on(table.created_at),
	index("idx_mcp_tool_call_events_tool_status").on(table.tool_name, table.status),
	index("idx_mcp_tool_call_events_org").on(table.created_at),
	index("idx_mcp_tool_call_events_org").on(table.organization_id, table.created_at),
	index("idx_mcp_tool_call_events_method_created").on(table.method, table.created_at),
	index("idx_mcp_tool_call_events_session").on(table.session_id_hash, table.created_at),
	index("idx_mcp_tool_call_events_unknown").on(table.unknown_tool_name, table.created_at),
]);


export const stripe_webhook_events = sqliteTable("stripe_webhook_events", {
	id: text().primaryKey(),
	stripe_event_id: text().notNull().unique(),
	event_type: text(),
	// Platform subscriptions remain owned by Better Auth. Connect and one-time
	// payment handlers use this receipt only for concurrent delivery deduplication.
	processor: text().notNull(),
	status: text().default("pending").notNull(),
	payload: text(),
	error: text(),
	claimed_at: text(),
	lease_expires_at: text(),
	claim_token: text(),
	attempt_count: integer().default(0).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, () => [
	check("stripe_webhook_events_instants_check", sql`(claimed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS claimed_at) AND (lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at, '+0 days') IS lease_expires_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)`),
	check("stripe_webhook_events_payload_check", sql`payload IS NULL OR (json_valid(payload))`),
]);


export const stripe_ga4_subscription_intents = sqliteTable("stripe_ga4_subscription_intents", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	user_id: text().notNull().references(() => user.id, { onDelete: "cascade" } ),
	stripe_subscription_id: text(),
	action: text().notNull(),
	// The visitor's native attribution snapshot when checkout began (JSON), so revenue
	// recorded later by a webhook can carry the campaign that produced it.
	attribution_json: text(),
	client_id: text(),
	session_id: text(),
	session_captured_at: integer(),
	previous_price_id: text(),
	new_price_id: text(),
	effective_timing: text().default("immediate").notNull(),
	source: text().default("browser").notNull(),
	status: text().default("pending").notNull(),
	lifecycle_sent_at: text(),
	consumed_at: text(),
	consumed_event_id: text(),
	expires_at: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("stripe_ga4_subscription_intents_attribution_check", sql`attribution_json IS NULL OR (json_valid(attribution_json) AND json_type(attribution_json) IS 'object')`),
	check("stripe_ga4_subscription_intents_instants_check", sql`(lifecycle_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lifecycle_sent_at, '+0 days') IS lifecycle_sent_at) AND (consumed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at, '+0 days') IS consumed_at) AND (expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	index("stripe_ga4_subscription_intents_subscription_idx").on(table.stripe_subscription_id, table.status, table.created_at),
	index("stripe_ga4_subscription_intents_organization_idx").on(table.organization_id, table.status, table.created_at),
	index("stripe_ga4_subscription_intents_expiry_idx").on(table.status, table.expires_at),
]);

export const usage_events = sqliteTable("usage_events", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	resource: text().notNull(),
	source: text().notNull(),
	provider: text(),
	channel: text(),
	session_id: text(),
	quantity: integer().notNull(),
	unit: text().notNull(),
	metadata_json: text(),
	idempotency_key: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("usage_events_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)`),
	check("usage_events_metadata_json_check", sql`metadata_json IS NULL OR (json_valid(metadata_json))`),
	unique("usage_events_organization_id_idempotency_key_unique").on(table.organization_id, table.idempotency_key),
	index("usage_events_organization_resource_created_idx").on(table.organization_id, table.resource, table.created_at),
	index("usage_events_org_created_idx").on(table.created_at),
]);

export const user = sqliteTable("user", {
	id: text().primaryKey(),
	name: text().notNull(),
	email: text().notNull().unique(),
	emailVerified: integer({ mode: "boolean" }).default(false).notNull(),
	image: text(),
	phoneNumber: text().unique(),
	phoneNumberVerified: integer({ mode: "boolean" }).default(false).notNull(),
	role: text().default("user"),
	banned: integer({ mode: "boolean" }).default(false),
	banReason: text(),
	banExpires: integer({ mode: "timestamp" }),
	isAnonymous: integer({ mode: "boolean" }).default(false).notNull(),
	// Better Auth Stripe plugin user customer field. Organization subscriptions
	// use organization.stripeCustomerId instead.
	stripeCustomerId: text(),
	createdAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
	updatedAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
});

export const verification = sqliteTable("verification", {
	id: text().primaryKey(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: integer({ mode: "timestamp" }).notNull(),
	createdAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
	updatedAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
});




export const user_workspace_state = sqliteTable("user_workspace_state", {
	user_id: text().primaryKey().references(() => user.id, { onDelete: "cascade" } ),
	organization_id: text().references(() => organization.id, { onDelete: "set null" } ),
	location_id: text().references(() => business_locations.id, { onDelete: "set null" } ),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	whatsapp_pending_confirmation: text(),
	whatsapp_last_inbound_id: text(),
	whatsapp_updated_at: text(),
}, () => [
	check("user_workspace_state_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at) AND (whatsapp_updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', whatsapp_updated_at, '+0 days') IS whatsapp_updated_at)`),
	check("user_workspace_state_whatsapp_pending_check", sql`whatsapp_pending_confirmation IS NULL OR (json_valid(whatsapp_pending_confirmation) AND json_type(whatsapp_pending_confirmation) IS 'object')`),
]);



export const content_documents = sqliteTable("content_documents", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	kind: text().$type<typeof CONTENT_DOCUMENT_KINDS[number]>().notNull(),
	row_role: text().$type<'root' | 'representation'>().notNull(),
	root_id: text(),
	root_role: text().$type<'root'>(),
	locale: text(),
	location_id: text().references(() => business_locations.id, { onDelete: "cascade" }),
	// The canonical product page binding, on ROOT rows only. Localized
	// representations inherit it through root_id and must not duplicate it.
	// A product slug and a document route have different owners: this foreign
	// key is the relationship, never a '/menu/<slug>' string convention. Other
	// documents may display the same Product through block references without
	// becoming additional canonical pages. Deleting or unpublishing the document
	// never touches the Product; deleting a Product that still has a canonical
	// page is refused until the page is explicitly unbound or deleted.
	product_id: text(),
	scope_path: text(),
	title: text(),
	slug: text(),
	path: text(),
	summary: text(),
	status: text(),
	visibility: text(),
	sort_order: integer().default(0).notNull(),
	source: text(),
	author_id: text().references(() => user.id, { onDelete: "set null" }),
	created_by: text(),
	updated_by: text(),
	published_at: text(),
	first_published_at: text(),
	seo_keywords: text(),
	metadata_json: text().default('{}').notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("content_documents_instants_check", sql`(published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 days') IS published_at) AND (first_published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', first_published_at, '+0 days') IS first_published_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.location_id], foreignColumns: [business_locations.organization_id, business_locations.id], name: "content_documents_location_scope_fk" }).onDelete("cascade"),
	// NO ACTION, not SET NULL: this is a composite key, and SQLite's SET NULL
	// would null organization_id too, which is NOT NULL — the delete would fail
	// with a confusing constraint error instead of unlinking. Deleting a Product
	// that still has a canonical page is refused; the domain operation unbinds
	// or deletes the page first, explicitly. Not RESTRICT either: that fires at
	// the product row and refuses the organization's own cascade, which removes
	// the page in the same statement.
	foreignKey({ columns: [table.organization_id, table.product_id], foreignColumns: [products.organization_id, products.id], name: "content_documents_product_scope_fk" }).onDelete("no action"),
	// At most one canonical product page per organization per product. Scoped to
	// root rows so locale representations are unaffected, and per organization so
	// two organizations publishing one Product each get their own canonical page.
	uniqueIndex("content_documents_product_root_unique").on(table.organization_id, table.product_id).where(sql`row_role = 'root' AND product_id IS NOT NULL`),
	unique("content_documents_scope_role_unique").on(table.organization_id, table.id, table.row_role, table.kind),
	foreignKey({ columns: [table.organization_id, table.root_id, table.root_role, table.kind], foreignColumns: [table.organization_id, table.id, table.row_role, table.kind], name: "content_documents_root_scope_fk" }).onDelete("cascade"),
	foreignKey({ columns: [table.organization_id, table.locale, table.row_role], foreignColumns: [organization_locales.organization_id, organization_locales.locale, organization_locales.document_role], name: "content_documents_locale_scope_fk" }).onDelete("cascade"),
	uniqueIndex("content_documents_root_locale_unique").on(table.root_id, table.locale).where(sql`row_role = 'representation'`),
	uniqueIndex("content_documents_route_unique").on(table.organization_id, table.locale, table.path).where(sql`row_role IN ('root','representation') AND path IS NOT NULL`),
	uniqueIndex("content_documents_slug_unique").on(table.organization_id, table.kind, table.locale, table.slug).where(sql`row_role IN ('root','representation') AND slug IS NOT NULL`),
	uniqueIndex("content_documents_links_org_unique").on(table.organization_id).where(sql`row_role = 'root' AND kind = 'page' AND json_extract(metadata_json, '$.recipe') = 'links'`),
	index("content_documents_org_kind_status_idx").on(table.kind, table.row_role, table.status, table.sort_order),
	index("content_documents_location_kind_status_idx").on(table.location_id, table.kind, table.row_role, table.status, table.sort_order),
	check("content_documents_metadata_check", sql`json_valid(metadata_json) AND json_type(metadata_json) IS 'object'`),
	check("content_documents_role_check", sql`(row_role = 'root' AND root_id IS NULL AND root_role IS NULL AND locale IS NOT NULL) OR (row_role = 'representation' AND root_id IS NOT NULL AND root_id <> id AND root_role = 'root' AND locale IS NOT NULL AND product_id IS NULL AND location_id IS NULL AND scope_path IS NULL AND status IS NULL AND visibility IS NULL AND source IS NULL AND author_id IS NULL AND published_at IS NULL AND first_published_at IS NULL)`),
	check("content_documents_path_check", sql`path IS NULL OR (path LIKE '/%' AND path NOT LIKE '//%')`),
	check("content_documents_page_copy_check", sql`kind <> 'page' OR (path IS NOT NULL AND title IS NOT NULL)`),
	check("content_documents_qa_scope_check", sql`kind <> 'qa' OR row_role <> 'root' OR ((location_id IS NULL OR scope_path IS NULL) AND (scope_path IS NULL OR scope_path LIKE '/%'))`),
	// 'listed' and 'unlisted' say whether the document appears in its index. The
	// value used to be 'public', which read as a second answer to "is this
	// published" beside `status` — an unlisted document is just as public, it is
	// simply not listed.
	check("content_documents_article_visibility_check", sql`kind NOT IN ('article','social_post') OR row_role <> 'root' OR (visibility IN ('listed','unlisted')) IS 1`),
	check("content_documents_qa_state_check", sql`kind <> 'qa' OR row_role <> 'root' OR ((status IN ('published','hidden')) IS 1 AND (source IN ('manual','import','template')) IS 1)`),
	// Articles and social posts are drafts or published. Nothing publishes on a
	// clock: a client that wants a post out later calls publish then.
	check("content_documents_publication_check", sql`row_role <> 'root' OR kind NOT IN ('article', 'social_post') OR (status IN ('draft','published')) IS 1`),
	// A published post has the instant it was published at, and a draft has
	// none. An article draft may still carry the date it first went out.
	check("content_documents_social_lifecycle_check", sql`kind <> 'social_post' OR row_role <> 'root' OR ((status = 'draft' AND published_at IS NULL) OR (status = 'published' AND published_at IS NOT NULL))`),
	check("content_documents_article_lifecycle_check", sql`kind <> 'article' OR row_role <> 'root' OR status <> 'published' OR published_at IS NOT NULL`),
	// A social post's route is allocated when it is created, so an image-only
	// draft has an address before it has words. The caption itself is optional:
	// an empty draft is a draft, and publication decides what is publishable.
	check("content_documents_copy_required_check", sql`row_role <> 'root' OR ((kind NOT IN ('page','article','qa') OR title IS NOT NULL) AND (kind NOT IN ('article','social_post') OR slug IS NOT NULL))`),
	// Website social posts are explicitly authored by the organization.
	check("content_documents_social_source_check", sql`kind <> 'social_post' OR row_role <> 'root' OR (source IN ('manual','template')) IS 1`),
]);

// One local social post and one actual Facebook, Instagram or Discord object.
// Row meaning: this post was published to this provider
//   target, and this is what the provider has said about it. It is not a job
//   queue and not a delivery log: there is one row per post and channel, and
//   it carries the provider's identifiers, never its credentials. Tokens stay
//   on the Better Auth account that `provider_subject_id` names.
// `state`: `preparing` holds native containers/uploads that are not public;
//   `publishing` is committed immediately before the irreversible final call,
//   so a crash after it reads `unknown`, never a retryable failure; `failed`
//   is a definite non-publication; `removed` is a positively established
//   provider removal, not absence from a feed page.
// `attempt_id` fences one invocation's updates; a preparation claim older
//   than a minute may be taken over by compare-and-set.
// Deletion: a local post's deletion sets `post_id` NULL in the same batch and
//   retains the publication receipt independently of the website document. The organization's cascade removes the rest.
// Read/write: server/utils/social-publication.ts.
export const post_publications = sqliteTable("post_publications", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	post_id: text(),
	// Relational constants for the composite key to the post's root row; not
	// independently editable state.
	post_row_role: text().$type<'root'>().default("root").notNull(),
	post_kind: text().$type<'social_post'>().default("social_post").notNull(),
	channel: text().$type<'facebook' | 'instagram' | 'discord'>().notNull(),
	provider_app_id: text().notNull(),
	provider_subject_id: text().notNull(),
	provider_target_id: text().notNull(),
	state: text().$type<'preparing' | 'publishing' | 'published' | 'failed' | 'unknown' | 'removed'>().notNull(),
	provider_post_id: text(),
	provider_permalink: text(),
	provider_handles_json: text().default("{}").notNull(),
	payload_hash: text().notNull(),
	attempt_id: text(),
	error_code: text(),
	error_message: text(),
	published_at: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("post_publications_instants_check", sql`(published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 days') IS published_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	// NO ACTION, not SET NULL: SQLite would null organization_id too. Canonical
	// post deletion detaches the association first, in the same batch.
	foreignKey({ columns: [table.organization_id, table.post_id, table.post_row_role, table.post_kind], foreignColumns: [content_documents.organization_id, content_documents.id, content_documents.row_role, content_documents.kind], name: "post_publications_post_scope_fk" }).onDelete("no action"),
	unique("post_publications_org_id_unique").on(table.organization_id, table.id),
	uniqueIndex("post_publications_post_channel_unique").on(table.organization_id, table.post_id, table.channel).where(sql`post_id IS NOT NULL`),
	uniqueIndex("post_publications_provider_post_unique").on(table.organization_id, table.channel, table.provider_app_id, table.provider_post_id).where(sql`provider_post_id IS NOT NULL`),
	index("post_publications_subject_idx").on(table.channel, table.provider_app_id, table.provider_subject_id),
	index("post_publications_target_state_idx").on(table.organization_id, table.channel, table.provider_target_id, table.state),
	check("post_publications_constants_check", sql`post_row_role = 'root' AND post_kind = 'social_post'`),
	check("post_publications_channel_check", sql`channel IN ('facebook', 'instagram', 'discord')`),
	check("post_publications_state_check", sql`state IN ('preparing', 'publishing', 'published', 'failed', 'unknown', 'removed')`),
	check("post_publications_identity_check", sql`length(trim(provider_app_id)) > 0 AND length(trim(provider_subject_id)) > 0 AND length(trim(provider_target_id)) > 0 AND (provider_post_id IS NULL OR length(trim(provider_post_id)) > 0)`),
	check("post_publications_handles_check", sql`json_valid(provider_handles_json) AND json_type(provider_handles_json) IS 'object'`),
	check("post_publications_permalink_check", sql`provider_permalink IS NULL OR provider_permalink LIKE 'https://%'`),
	// Published needs provider evidence: the final identity, or an Instagram
	// container whose own status said it was published.
	check("post_publications_published_check", sql`state NOT IN ('published', 'removed') OR (published_at IS NOT NULL AND (provider_post_id IS NOT NULL OR (channel = 'instagram' AND json_type(provider_handles_json, '$.container_id') IS 'text')))`),
	check("post_publications_failed_check", sql`(state IN ('failed', 'unknown')) = (error_code IS NOT NULL)`),
	check("post_publications_attempt_check", sql`attempt_id IS NULL OR state IN ('preparing', 'publishing')`),
]);

export const resource_localizations = sqliteTable("resource_localizations", {
	id: text().primaryKey(),
	organization_id: text().notNull(),
	resource_type: text().notNull(),
	resource_id: text().notNull(),
	locale: text().notNull(),
	document_role: text().generatedAlwaysAs(sql`'representation'`),
	values_json: text().notNull(),
	route_path: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by_user_id: text().notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_by_user_id: text().notNull(),
}, (table) => [
	check("resource_localizations_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({
		columns: [table.organization_id, table.locale, table.document_role],
		foreignColumns: [organization_locales.organization_id, organization_locales.locale, organization_locales.document_role],
		name: "resource_localizations_organization_locale_fk",
	}).onDelete("cascade"),
	unique("resource_localizations_org_resource_locale_unique").on(
		table.organization_id,
		table.resource_type,
		table.resource_id,
		table.locale,
	),
	uniqueIndex("resource_localizations_org_locale_route_unique")
		.on(table.organization_id, table.locale, table.route_path)
		.where(sql`route_path IS NOT NULL`),
	check("resource_localizations_values_json_check", sql`json_valid(values_json) AND json_type(values_json) = 'object'`),
	check("resource_localizations_route_path_check", sql`route_path IS NULL OR (route_path LIKE '/' || locale || '/%' AND route_path NOT LIKE '%?%' AND route_path NOT LIKE '%#%' AND route_path NOT LIKE '%//%')`),
	index("resource_localizations_org_locale_type_idx").on(table.organization_id, table.locale, table.resource_type),
	index("resource_localizations_resource_idx").on(table.resource_type, table.resource_id),
]);

// An article's category: a named, ordered grouping the owner manages within
// one of the site's article collections (the blog or the docs). It is the
// public grouping of the collection's index, sidebar and breadcrumb, and it
// has its own page, so it is a record rather than text typed on each article.
// Row meaning: one category of one collection on one site.
// Deletion: cascades from the site. A category that still has articles is not
//   deleted; the owner moves them first (NO ACTION on the membership FK).
// Read/write: server/utils/content/article-categories.ts.
export const article_categories = sqliteTable("article_categories", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	collection: text().$type<'blog' | 'docs'>().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	description: text(),
	// The category it sits under, in the same collection; NULL at the top.
	// A category with subcategories is not deleted (NO ACTION), like one with
	// articles. Its page's address is its slug alone, so moving it moves no URL.
	parent_id: text().references((): AnySQLiteColumn => article_categories.id),
	// Its place among its siblings.
	sort_order: integer().default(0).notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	created_by: text().notNull(),
	updated_by: text().notNull(),
}, (table) => [
	check("article_categories_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	unique("article_categories_org_id_unique").on(table.organization_id, table.id),
	uniqueIndex("article_categories_slug_unique").on(table.organization_id, table.collection, table.slug),
	uniqueIndex("article_categories_name_unique").on(table.organization_id, table.collection, sql`lower(${table.name})`),
	index("article_categories_org_sort_idx").on(table.organization_id, table.collection, table.sort_order),
	index("article_categories_parent_idx").on(table.parent_id, table.sort_order),
	check("article_categories_collection_check", sql`collection IN ('blog', 'docs')`),
	check("article_categories_name_not_blank_check", sql`trim(name) <> ''`),
	check("article_categories_slug_check", sql`slug <> '' AND slug = lower(slug) AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'`),
	check("article_categories_sort_order_check", sql`sort_order >= 0`),
]);

// Which category an article is in: exactly one, so the article is the key.
// Deletion: cascades from the article; a category with rows here cannot be
//   deleted (NO ACTION), which is what makes the owner move its articles.
// Read/write: server/utils/content/article-categories.ts.
export const article_category_articles = sqliteTable("article_category_articles", {
	article_id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
	category_id: text().notNull(),
	article_row_role: text().$type<'root'>().default("root").notNull(),
	article_kind: text().$type<'article'>().default("article").notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("article_category_articles_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	foreignKey({ columns: [table.organization_id, table.category_id], foreignColumns: [article_categories.organization_id, article_categories.id], name: "article_category_articles_category_scope_fk" }),
	foreignKey({ columns: [table.organization_id, table.article_id, table.article_row_role, table.article_kind], foreignColumns: [content_documents.organization_id, content_documents.id, content_documents.row_role, content_documents.kind], name: "article_category_articles_article_scope_fk" }).onDelete("cascade"),
	index("article_category_articles_category_idx").on(table.category_id),
	check("article_category_articles_constants_check", sql`article_row_role = 'root' AND article_kind = 'article'`),
]);

export const content_blocks = sqliteTable("content_blocks", {
	id: text().primaryKey(),
	source_block_id: text(),
	document_id: text().notNull().references(() => content_documents.id, { onDelete: "cascade" } ),
	parent_block_id: text(),
	type: text().notNull(),
	position: integer().default(0).notNull(),
	level: integer(),
	data_json: text().notNull(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("content_blocks_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
	index("content_blocks_document_position_idx").on(table.document_id, table.position),
	foreignKey({ columns: [table.source_block_id], foreignColumns: [table.id], name: "content_blocks_source_fk" }).onDelete("cascade"),
	uniqueIndex("content_blocks_document_source_unique").on(table.document_id, table.source_block_id).where(sql`source_block_id IS NOT NULL`),
	check("content_blocks_source_check", sql`source_block_id IS NULL OR source_block_id <> id`),
	index("content_blocks_parent_idx").on(table.parent_block_id),
	unique("content_blocks_document_id_unique").on(table.document_id, table.id),
	foreignKey({ columns: [table.document_id, table.parent_block_id], foreignColumns: [table.document_id, table.id], name: "content_blocks_parent_document_fk" }).onDelete("cascade"),
	check("content_blocks_data_json_check", sql`json_valid(data_json) AND json_type(data_json) IS 'object'`),
	check("content_blocks_parent_check", sql`parent_block_id IS NULL OR parent_block_id <> id`),
	check("content_blocks_position_check", sql`position >= 0`),
	check("content_blocks_level_check", sql`level IS NULL OR level BETWEEN 1 AND 6`),
]);

export const public_resource_cache_invalidations = sqliteTable("public_resource_cache_invalidations", {
	id: text().primaryKey(),
	organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" } ),
	reason: text().notNull(),
	status: text().default("pending").notNull(),
	attempt_count: integer().default(0).notNull(),
	claimed_at: text(),
	processed_at: text(),
	last_error: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	check("public_resource_cache_invalidations_instants_check", sql`(claimed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS claimed_at) AND (processed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', processed_at, '+0 days') IS processed_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)`),
	index("public_resource_cache_invalidations_status_idx").on(table.status, table.created_at),
	index("public_resource_cache_invalidations_org_idx").on(table.organization_id, table.status),
	check("public_resource_cache_invalidations_attempt_count_check", sql`attempt_count >= 0`),
]);

export const analytics_events = sqliteTable("analytics_events", {
  id: text().primaryKey(),
  // pageview: a page was visited. conversion: a business outcome (a persisted submission, signup,
  // onboarding, verified payment or refund). interaction: something a visitor or user did that is
  // not an outcome (a handoff click, a product view, a checkout start, a product-usage event).
  kind: text({ enum: ["pageview", "conversion", "interaction"] }).notNull(),
  organization_id: text().references(() => organization.id, { onDelete: "cascade" }),
  location_id: text().references(() => business_locations.id, { onDelete: "set null" }),
  session_id: text(),
  visitor_id: text(),
  page_path: text(),
  duration_seconds: integer(),
  payload_json: text().notNull(),
  // When the event happened, as observed by the browser and bounded by the collector (a deferred
  // delivery keeps its own time). Server outcomes happen when they are recorded.
  created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
  // When the server accepted the event. Ingestion order: a late event has an old created_at and a
  // new received_at, so a paginated read bounded by received_at never skips or repeats it.
  received_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, table => [
	check("analytics_events_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (received_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+0 days') IS received_at)`),
  check("analytics_events_payload_check", sql`json_valid(payload_json) AND json_type(payload_json) IS 'object'`),
  // A conversion with a browser session carries that session's attribution snapshot. One with no
  // session (a server outcome) carries either a snapshot captured earlier through the actual
  // checkout relationship, or none. A server event never borrows a browser session.
  check("analytics_events_shape_check", sql`(kind = 'pageview' AND page_path IS NOT NULL) OR (kind IN ('conversion', 'interaction') AND organization_id IS NOT NULL AND duration_seconds IS NULL
    AND json_type(payload_json, '$.event_name') IS 'text' AND length(payload_json ->> '$.event_name') BETWEEN 1 AND 64
    AND (payload_json ->> '$.event_name') GLOB '[a-z]*' AND (payload_json ->> '$.event_name') NOT GLOB '*[^a-z0-9_]*'
    AND json_type(payload_json, '$.stage') IS 'text' AND (payload_json ->> '$.stage') IN ('schedule_navigation', 'external_booking_handoff', 'submitted', 'external_handoff', 'completed', 'viewed', 'started', 'occurred')
    AND ((session_id IS NULL) = (visitor_id IS NULL))
    AND ((json_type(payload_json, '$.attribution.source') IS 'text' AND json_type(payload_json, '$.attribution.medium') IS 'text' AND json_type(payload_json, '$.attributed_at') IS 'text')
      OR (json_type(payload_json, '$.attribution') IS 'null' AND json_type(payload_json, '$.attributed_at') IS 'null')))`),
  index("analytics_events_org_kind_created_idx").on(table.organization_id, table.kind, table.created_at),
  index("analytics_events_org_received_idx").on(table.organization_id, table.received_at),
  index("analytics_events_org_session_idx").on(table.organization_id, table.kind, table.session_id),
  index("analytics_events_org_visitor_idx").on(table.organization_id, table.kind, table.visitor_id),
  index("analytics_events_conversion_name_idx").on(table.kind, sql`(payload_json ->> '$.event_name')`, table.created_at),
  index("analytics_events_conversion_entity_idx").on(table.organization_id, sql`(payload_json ->> '$.entity_type')`, sql`(payload_json ->> '$.entity_id')`).where(sql`kind IN ('conversion', 'interaction')`),
  uniqueIndex("analytics_events_conversion_entity_unique").on(table.organization_id, sql`(payload_json ->> '$.event_name')`, sql`(payload_json ->> '$.entity_type')`, sql`(payload_json ->> '$.entity_id')`).where(sql`kind = 'conversion' AND (payload_json ->> '$.entity_type') IS NOT NULL AND (payload_json ->> '$.entity_id') IS NOT NULL AND (payload_json ->> '$.event_name') IN ('contact_submit', 'reservation_submit', 'booking_submit', 'sign_up', 'onboarding_complete', 'purchase', 'refund', 'payment_paid', 'payment_refunded', 'booking_confirmed', 'booking_declined', 'booking_cancelled', 'booking_change_accepted', 'booking_change_declined', 'payments_fee_invoice_paid')`),
]);

export const analytics_summaries = sqliteTable("analytics_summaries", {
  id: text().primaryKey(),
  kind: text({ enum: ["session", "organization_day", "page_day", "dimension_day"] }).notNull(),
  organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
  date: text().notNull(),
  key: text().notNull(),
  payload_json: text().notNull(),
  created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
  updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, table => [
	check("analytics_summaries_instants_check", sql`(created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)`),
  check("analytics_summaries_payload_check", sql`json_valid(payload_json) AND json_type(payload_json) IS 'object'`),
  check("analytics_summaries_scope_check", sql`(kind = 'session' AND date = ''
    AND json_type(payload_json, '$.visitor_id') IS 'text' AND json_type(payload_json, '$.started_at') IS 'text'
    AND json_type(payload_json, '$.last_seen_at') IS 'text' AND json_type(payload_json, '$.landing_path') IS 'text'
    AND json_type(payload_json, '$.attribution.source') IS 'text' AND json_type(payload_json, '$.attribution.medium') IS 'text'
    AND json_type(payload_json, '$.duration_seconds') IS 'integer' AND (payload_json ->> '$.duration_seconds') >= 0)
    OR (kind != 'session' AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND json_type(payload_json, '$.page_views') IS 'integer' AND (payload_json ->> '$.page_views') >= 0)`),
  check("analytics_summaries_day_metrics_check", sql`kind != 'organization_day' OR (key = ''
    AND json_type(payload_json, '$.unique_sessions') IS 'integer' AND (payload_json ->> '$.unique_sessions') >= 0
    AND json_type(payload_json, '$.unique_visitors') IS 'integer' AND (payload_json ->> '$.unique_visitors') >= 0
    AND json_type(payload_json, '$.returning_visitors') IS 'integer' AND (payload_json ->> '$.returning_visitors') >= 0
    AND json_type(payload_json, '$.avg_session_duration') IN ('integer', 'real') AND (payload_json ->> '$.avg_session_duration') >= 0
    AND json_type(payload_json, '$.pages_per_session') IN ('integer', 'real') AND (payload_json ->> '$.pages_per_session') >= 0
    AND json_type(payload_json, '$.avg_session_duration') IS NOT NULL AND json_type(payload_json, '$.pages_per_session') IS NOT NULL)`),
  check("analytics_summaries_dimension_key_check", sql`kind != 'dimension_day' OR (json_valid(key) AND json_type(key) IS 'array' AND json_array_length(key) = 3
    AND json_type(key, '$[0]') IS 'text' AND (key ->> '$[0]') IN ('country', 'city', 'device', 'referrer')
    AND json_type(key, '$[1]') IS 'text' AND json_type(key, '$[2]') IS 'text')`),
  uniqueIndex("analytics_summaries_grain_unique").on(table.organization_id, table.kind, table.date, table.key),
  index("analytics_summaries_session_started_idx").on(table.organization_id, sql`(payload_json ->> '$.started_at')`).where(sql`kind = 'session'`),
  index("analytics_summaries_session_seen_idx").on(table.organization_id, sql`(payload_json ->> '$.last_seen_at')`).where(sql`kind = 'session'`),
  index("analytics_summaries_session_visitor_idx").on(table.organization_id, sql`(payload_json ->> '$.visitor_id')`, sql`(payload_json ->> '$.started_at')`).where(sql`kind = 'session'`),
]);


// Which categories of notification a person wants, and over which channel.
//
// Row meaning: this user wants this category on these channels. A user with no
// row for a category takes NOTIFICATION_CATEGORY_DEFAULTS in
// shared/notification-categories.ts, which is the only source of that value —
// there is no backfill, so nothing can drift out of step with it.
//
// Preference is not authorization. A `whatsapp_enabled` row says the person
// wants WhatsApp; isAuthorizedWhatsAppRecipient still decides whether that
// number may receive the message at all.
//
// `push_enabled` reaches every APNs device token the person registered from a
// signed-in KrabiClaw app session (device_tokens).
//
// account_security email is not stored here as a switchable value: the API
// refuses to disable it, because losing a password reset locks a person out of
// their own account.
export const user_notification_preferences = sqliteTable("user_notification_preferences", {
	user_id: text().notNull().references(() => user.id, { onDelete: "cascade" }),
	category: text().$type<NotificationCategory>().notNull(),
	email_enabled: integer({ mode: "boolean" }).notNull(),
	whatsapp_enabled: integer({ mode: "boolean" }).notNull(),
	push_enabled: integer({ mode: "boolean" }).notNull(),
	updated_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	primaryKey({ columns: [table.user_id, table.category] }),
	check("user_notification_preferences_category_check", sql`category IN (${sql.raw([...NOTIFICATION_CATEGORIES].map(value => `'${value}'`).join(', '))})`),
	check("user_notification_preferences_updated_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at`),
	check("user_notification_preferences_account_security_check", sql`category != 'account_security' OR email_enabled = 1`),
	check("user_notification_preferences_push_only_check", sql`category NOT IN (${sql.raw([...PUSH_ONLY_CATEGORIES].map(value => `'${value}'`).join(', '))}) OR (email_enabled = 0 AND whatsapp_enabled = 0)`),
]);

// One article, one broadcast, forever. The unique content_document_id is what
// makes republishing an article not mail everyone a second time.
export const broadcasts = sqliteTable("broadcasts", {
	id: text().primaryKey(),
	content_document_id: text().notNull().unique().references(() => content_documents.id, { onDelete: "cascade" }),
	category: text().$type<NotificationCategory>().notNull(),
	// The Resend broadcast this article was sent as. NULL until the provider
	// has created it; Resend owns per-recipient delivery state.
	provider_broadcast_id: text(),
	created_at: text().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).notNull(),
}, (table) => [
	uniqueIndex("broadcasts_provider_broadcast_id_unique").on(table.provider_broadcast_id).where(sql`provider_broadcast_id IS NOT NULL`),
	check("broadcasts_category_check", sql`category IN (${sql.raw([...NOTIFICATION_CATEGORIES].map(value => `'${value}'`).join(', '))})`),
	check("broadcasts_created_at_check", sql`strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at`),
]);

// Provider identity is allocated before I/O. This table is also the durable
// projection intent: unsynced revisions and cleanup survive Worker restarts.
export const google_calendar_event_links = sqliteTable("google_calendar_event_links", {
 id: text().primaryKey(),
 organization_id: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
 integration_revision: text().notNull(),
 account_id: text().notNull(),
 calendar_id: text().notNull(),
 event_id: text().notNull(),
 booking_kind: text({ enum: ["booking", "reservation"] }).notNull(),
 operational_id: text().notNull(),
 request_id: text(),
 booking_revision: text().notNull(),
 synced_revision: text(),
 state: text({ enum: ["pending", "synced", "cleanup", "deleted", "error"] }).default("pending").notNull(),
 last_error: text(),
 attempts: integer().default(0).notNull(),
 next_attempt_at: text(),
 lease_token: text(),
 lease_until: text(),
 last_synced_at: text(),
 created_at: text().notNull(),
 updated_at: text().notNull(),
}, table => [
 uniqueIndex("google_calendar_subject_unique").on(table.organization_id, table.integration_revision, table.booking_kind, table.operational_id).where(sql`state <> 'deleted'`),
 uniqueIndex("google_calendar_provider_unique").on(table.calendar_id, table.event_id),
 index("google_calendar_due_idx").on(table.organization_id, table.state, table.next_attempt_at),
 check("google_calendar_kind_check", sql`booking_kind IN ('booking', 'reservation')`),
 check("google_calendar_state_check", sql`state IN ('pending', 'synced', 'cleanup', 'deleted', 'error')`),
]);

// Minimal cleanup receipts survive physical organization deletion. They have
// no guest/booking payload and can only remove an already-managed event.
export const google_calendar_cleanup_jobs = sqliteTable("google_calendar_cleanup_jobs", {
 id: text().primaryKey(),
 organization_id: text().notNull(), // original tenant identity, deliberately no cascading FK
 account_id: text().notNull(),
 calendar_id: text().notNull(),
 event_id: text().notNull(),
 state: text({ enum: ["pending", "error", "deleted"] }).default("pending").notNull(),
 attempts: integer().default(0).notNull(),
 last_error: text(),
 next_attempt_at: text(),
 lease_token: text(),
 lease_until: text(),
 completed_at: text(),
 created_at: text().notNull(),
 updated_at: text().notNull(),
}, table => [
 uniqueIndex("google_calendar_cleanup_provider_unique").on(table.calendar_id, table.event_id),
 index("google_calendar_cleanup_due_idx").on(table.state, table.next_attempt_at),
 check("google_calendar_cleanup_state_check", sql`state IN ('pending', 'error', 'deleted')`),
]);
// Financial tenant IDs are immutable historical references. Canonical tenant cleanup
// retains a servicing tombstone; financial parent FKs protect evidence after deletion.
export const payments = sqliteTable("payments", {
 id: text().primaryKey(),
 organization_id: text().notNull(),
 buyer_user_id: text().references(() => user.id, { onDelete: "set null" }),
 stripe_account_id: text().notNull(),
 livemode: integer({ mode: "boolean" }).notNull(),
 subject_type: text().$type<'booking' | 'order' | 'reservation' | 'invoice'>().notNull(),
 subject_id: text(),
 location_id: text(),
 currency: text().notNull(),
 amount: integer().notNull(),
 price_snapshot_json: text().notNull(),
 tax_amount: integer().default(0).notNull(),
 /** The credit-card surcharge Stripe applied, read from the PaymentIntent at settlement. */
 surcharge_amount: integer().default(0).notNull(),
 captured_amount: integer().default(0).notNull(),
 refunded_amount: integer().default(0).notNull(),
 state: text().$type<'pending' | 'captured' | 'failed' | 'recovery' | 'refunded'>().default("pending").notNull(),
 stripe_payment_intent_id: text(),
 stripe_charge_id: text(),
 receipt_url: text(),
 created_at: text().notNull(),
 updated_at: text().notNull(),
}, t => [
 unique("payments_provider_unique").on(t.stripe_account_id, t.livemode, t.stripe_payment_intent_id),
 index("payments_tenant_created_idx").on(t.organization_id, t.created_at),
 index("payments_buyer_idx").on(t.buyer_user_id, t.created_at),
 check("payments_amounts_check", sql`amount >= 0 AND captured_amount >= 0 AND refunded_amount >= 0 AND refunded_amount <= captured_amount`),
 check("payments_currency_check", sql`length(currency) = 3 AND currency = upper(currency)`),
]);

export const payment_attempts = sqliteTable("payment_attempts", {
 id: text().primaryKey(),
 payment_id: text().notNull().references(() => payments.id, { onDelete: "restrict" }),
 idempotency_key: text().notNull().unique(),
 /** Hosted Checkout, before payments moved to the PaymentIntent the buyer confirms on the site. */
 stripe_checkout_id: text(),
 checkout_url: text(),
 stripe_payment_intent_id: text(),
 /** The amount and payment method the buyer was shown and confirmed: `{ payment_method_id, subtotal, surcharge, total, reviewed_at }`. */
 review_json: text(),
 return_token: text().notNull(),
 status: text().default("creating").notNull(),
 expires_at: text().notNull(),
 error: text(),
 created_at: text().notNull(),
 updated_at: text().notNull(),
});

export const payment_checkout_holds = sqliteTable("payment_checkout_holds", {
 id: text().primaryKey(),
 organization_id: text().notNull(),
 product_id: text(),
 variant_id: text(),
 price_id: text(),
 session_id: text(),
 location_id: text(),
 timezone: text(),
 assigned_member_id: text(),
 buyer_user_id: text().references(() => user.id, { onDelete: "set null" }),
 request_id: text(),
 payment_id: text().notNull().unique().references(() => payments.id, { onDelete: "restrict" }),
 quantity: integer().notNull(),
 amount: integer().notNull(),
 currency: text().notNull(),
 starts_at: text().notNull(),
 ends_at: text().notNull(),
 status: text().$type<'active' | 'converted' | 'released'>().default("active").notNull(),
 expires_at: text().notNull(),
 created_at: text().notNull(),
 converted_booking_id: text(),
 converted_reservation_id: text(),
}, t => [
 index("payment_holds_capacity_idx").on(t.session_id, t.status, t.expires_at),
 index("payment_holds_reservation_idx").on(t.organization_id, t.location_id, t.starts_at, t.status, t.expires_at),
 check("payment_holds_quantity_check", sql`quantity > 0 AND amount > 0`),
 check("payment_holds_subject_check", sql`(product_id IS NOT NULL AND variant_id IS NOT NULL AND price_id IS NOT NULL AND session_id IS NOT NULL AND converted_reservation_id IS NULL) OR (product_id IS NULL AND variant_id IS NULL AND price_id IS NULL AND session_id IS NULL AND location_id IS NOT NULL AND timezone IS NOT NULL AND assigned_member_id IS NULL AND converted_booking_id IS NULL)`),
]);

export const payment_orders = sqliteTable("payment_orders", {
 id: text().primaryKey(),
 organization_id: text().notNull(),
 buyer_user_id: text().references(() => user.id, { onDelete: "set null" }),
 payment_id: text().notNull().unique().references(() => payments.id, { onDelete: "restrict" }),
 currency: text().notNull(),
 amount: integer().notNull(),
 created_at: text().notNull(),
});
export const payment_order_lines = sqliteTable("payment_order_lines", {
 id: text().primaryKey(),
 order_id: text().notNull().references(() => payment_orders.id, { onDelete: "restrict" }),
 product_id: text().notNull(),
 variant_id: text().notNull(),
 price_id: text().notNull(),
 title: text().notNull(),
 unit_amount: integer().notNull(),
 quantity: integer().notNull(),
 currency: text().notNull(),
 tax_behavior: text().notNull(),
}, () => [check("payment_order_lines_amount_check", sql`unit_amount >= 0 AND quantity > 0`)]);

export const payment_refunds = sqliteTable("payment_refunds", {
 id: text().primaryKey(),
 payment_id: text().notNull().references(() => payments.id, { onDelete: "restrict" }),
 idempotency_key: text().notNull().unique(),
 stripe_refund_id: text(),
 /** Stripe's refunded amount once it answers; NULL while a full-remaining refund is still with Stripe. */
 amount: integer(),
 reason: text().notNull(),
 /** What the business told the buyer when it sent the money, as Airbnb's refund carries a message. */
 note: text(),
 status: text().notNull(),
 error: text(),
 attempted_at: text(),
 created_by: text().references(() => user.id, { onDelete: "set null" }),
 created_at: text().notNull(),
 updated_at: text().notNull(),
}, t => [unique("payment_refunds_provider_unique").on(t.payment_id,t.stripe_refund_id),check("payment_refunds_amount_check", sql`amount IS NULL OR amount > 0`)]);
export const payment_disputes = sqliteTable("payment_disputes", {
 id: text().primaryKey(),
 payment_id: text().notNull().references(() => payments.id, { onDelete: "restrict" }),
 stripe_dispute_id: text().notNull(),
 amount: integer().notNull(),
 currency: text().notNull(),
 reason: text().notNull(),
 status: text().notNull(),
 evidence_due_at: text(),
 updated_at: text().notNull(),
},t=>[unique('payment_disputes_provider_unique').on(t.payment_id,t.stripe_dispute_id)]);

// Metronome owns rating/invoices. This is only a delivery outbox, not a ledger.
export const payment_usage_events = sqliteTable("payment_usage_events", {
 id: text().primaryKey(),
 organization_id: text().notNull(),
 payment_id: text().references(() => payments.id, { onDelete: "restrict" }),
 kind: text().$type<'captured_volume' | 'stripe_cost' | 'stripe_cost_adjustment' | 'ad_spend'>().notNull(),
 currency: text().notNull(),
 amount: integer().notNull(),
 billing_basis_json: text(),
 source_id: text().notNull().unique(),
 provider_occurred_at: text().notNull(),
 delivery_at: text(),
 error: text(),
 billing_timestamp: text(),
 credit_note_id: text().unique(),
 dead_letter_at: text(),
 created_at: text().notNull(),
});
export const payment_billing_accounts = sqliteTable("payment_billing_accounts", {
 organization_id: text().primaryKey(),
 stripe_billing_customer_id: text().notNull(),
 metronome_customer_id: text(),
 metronome_contract_id: text(),
 contract_start_at: text().notNull(),
 currency: text().notNull(),
 status: text().$type<'provisioning' | 'active' | 'servicing' | 'closing' | 'closed'>().notNull(),
 updated_at: text().notNull(),
});

export const payment_authorizations = sqliteTable("payment_authorizations", {
 id: text().primaryKey(),
 organization_id: text().notNull(),
 user_id: text().references(() => user.id, { onDelete: "set null" }),
 payment_id: text().notNull().references(() => payments.id, { onDelete: "restrict" }),
 action: text().notNull(),
 /** A partial refund's amount; NULL approves whatever Stripe still holds for the payment. */
 amount: integer(),
 note: text(),
 expires_at: text().notNull(),
 approved_at: text(),
 consumed_at: text(),
});

/** The buyer's Stripe Customer on a business's connected account: Stripe keeps the cards, this keeps which customer is theirs. */
export const stripe_connected_customers = sqliteTable("stripe_connected_customers", {
 user_id: text().notNull().references(() => user.id, { onDelete: "cascade" }),
 stripe_account_id: text().notNull(),
 livemode: integer().notNull(),
 stripe_customer_id: text().notNull(),
 created_at: text().notNull(),
}, t => [primaryKey({ columns: [t.user_id, t.stripe_account_id, t.livemode] })]);
export const payment_claims = sqliteTable("payment_claims", {
 token_hash: text().primaryKey(),
 payment_id: text().notNull().references(() => payments.id, { onDelete: "restrict" }),
 expires_at: text().notNull(),
 claimed_at: text(),
 claimed_user_id: text().references(() => user.id, { onDelete: "set null" }),
});

// Provider report progress and attributable cost snapshots support late correction;
// Stripe remains the financial record authority. Unattributed fees are never billed.
export const payment_fee_reports = sqliteTable("payment_fee_reports", {
 id: text().primaryKey(),
 stripe_report_id: text(),
 livemode: integer({mode:"boolean"}).notNull(),
 interval_start: integer().notNull(),
 interval_end: integer().notNull(),
 status: text().notNull(),
 error: text(),
 created_at: text().notNull(),
 updated_at: text().notNull(),
});
export const payment_cost_snapshots = sqliteTable("payment_cost_snapshots", {
 source_id: text().primaryKey(),
 organization_id: text(),
 payment_id: text().references(()=>payments.id,{onDelete:"restrict"}),
 incurred_by: text().notNull(),
 currency: text().notNull(),
 amount: integer().notNull(),
 billing_basis_json: text(),
 incurred_at: text().notNull(),
 revision: integer().default(1).notNull(),
 updated_at: text().notNull(),
});

export const payment_servicing_tenants = sqliteTable("payment_servicing_tenants", {
 organization_id: text().notNull(),
 stripe_account_id: text().notNull(),
 livemode: integer({mode:"boolean"}).notNull(),
 retained_at: text().notNull(),
},t=>[primaryKey({columns:[t.stripe_account_id,t.livemode]})]);

// Domain settings reference existing Better Auth membership. Assignment IDs on
// historical operational records deliberately survive membership deletion.
export const member_scheduling = sqliteTable("member_scheduling", {
 member_id: text().primaryKey(),
 organization_id: text().notNull(),
 timezone: text().notNull(),
 weekly_json: text().notNull(),
 time_off_json: text().notNull(),
 windows_json: text().notNull(),
 windows_until: text().notNull(),
 public_name: text(),
 public_photo_url: text(),
 public_bio: text(),
 public_approved: integer({ mode: "boolean" }).default(false).notNull(),
 calendar_account_id: text(),
 calendar_ids_json: text().default("[]").notNull(),
 calendar_revision: text().notNull(),
 busy_json: text().default("[]").notNull(),
 busy_from: text(),
 busy_until: text(),
 busy_checked_at: text(),
 busy_error: text(),
 updated_at: text().notNull(),
 updated_by: text().notNull(),
}, t => [index("member_scheduling_org_idx").on(t.organization_id),
 foreignKey({ columns: [t.member_id, t.organization_id], foreignColumns: [member.id, member.organizationId] }).onDelete("cascade"),
]);

// A creation attempt survives an ambiguous provider response. Retry discovers
// its exact organization marker before it may issue another calendars.insert.
export const google_calendar_setup = sqliteTable("google_calendar_setup", {
 organization_id: text().primaryKey().references(() => organization.id, { onDelete: "cascade" }),
 account_id: text().notNull(),
 started_at: text().notNull(),
});
