import { readFile, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import Ajv2020 from 'ajv/dist/2020.js'

register('../tests/unit/support/alias-hooks.mjs', import.meta.url)

const { MCP_PUBLIC_TOOLS } = await import('../server/utils/mcp-tools/index.ts')

const SCHEMA_URL = 'https://developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json'
const OUTPUT_PATH = 'chatgpt-app-submission.json'

// Reviewed effects are authored here; annotation values still come from the registry.
// A newly exposed tool must receive an explicit review before regeneration succeeds.
const effects = {
  list_google_ads_campaigns: 'Reads campaigns, budgets and performance metrics from the Google Ads account the selected business connected.',
  get_google_ads_campaign: 'Reads one campaign, its ad groups, keywords and responsive search ads from the connected Google Ads account.',
  create_google_ads_search_campaign: 'Creates a Google Ads search campaign, ad group, keywords and ad in the connected account using a durable retry key; it can start spending the account’s budget.',
  clone_google_ads_campaign: 'Copies an existing campaign in the connected Google Ads account to a new destination URL using a durable retry key; it can start spending the account’s budget.',
  update_google_ads_campaign: 'Pauses, enables or changes the daily budget of one campaign in the connected Google Ads account.',
  launch_omnichannel_campaign: 'Creates or clones a Google Ads campaign and publishes the explicitly requested posts to the selected connected social channels and website using a durable retry key.',
  get_website_draft: 'Reads the authenticated user’s saved website draft, revision and missing publication fields.',
  save_website_draft: 'Creates or updates the authenticated user’s private website draft using a retry key and current revision; it does not publish.',
  publish_website: 'Activates a complete saved website draft, selects the new business as the user’s workspace and sends the native operator notification.',
  create_location: 'Creates a location in the selected business using a durable retry key; its details can appear on the live website.',
  list_organization_members: 'Reads Better Auth memberships, pending invitations and their actual email delivery receipts for the selected business.',
  invite_organization_member: 'Creates or explicitly resends a Better Auth invitation, emails its recipient and returns the saved invitation and delivery receipt.',
  update_organization_member_role: 'Changes a Better Auth membership role, subject to native owner permissions and last-owner protection.',
  remove_organization_member: 'Removes a Better Auth membership, subject to native permissions and last-owner protection.',
  cancel_organization_invitation: 'Cancels a pending Better Auth invitation in the selected business.',
  list_teams: 'Reads Better Auth teams and their members in the selected business.',
  create_team: 'Creates a named Better Auth team in the selected business.',
  update_team: 'Overwrites the selected Better Auth team name.',
  set_team_member: 'Adds or removes an existing business teammate from a Better Auth team. Existing bookings retain their saved provider.',
  delete_team: 'Deletes a Better Auth team and removes its offering assignments. Existing bookings retain their saved provider.',
  add_organization_language: 'Adds a disabled website language for private authoring or refreshes its stored catalog label; existing publication status and translations are preserved.',
  publish_organization_language: 'Publishes an added website language after entitlement and translated-homepage checks; public routes show only authored translations.',
  disable_organization_language: 'Disables an existing secondary website language’s public routes while preserving its translations.',
  delete_organization_language: 'Deletes a disabled website language and its translations while preserving source content.',
  list_guest_conversations: 'Reads authorized contact, reservation and booking conversations and their inbox state.',
  get_guest_conversation: 'Reads an authorized conversation, its messages, operational record, proposals, attachments and delivery receipts.',
  reply_to_guest: 'Saves a reply and optional photo in the guest conversation, emails the guest or, for a mapped Airbnb conversation, sends the text through Channex; a guest who joined through an invite also sees it in their KrabiClaw inbox. Updates the inbox state using the supplied retry key.',
  set_guest_conversation_archived: 'Changes the selected conversation’s archive state using the supplied retry key; it does not cancel the operational record.',
  create_product_session: 'Adds dated sessions for the offering’s assigned providers using a durable retry key and canonical availability checks.',
  update_product_session: 'Overwrites selected session time, capacity or state using its current revision. Guest commitments prevent incompatible edits.',
  create_table_reservation: 'Allocates a table reservation and guest conversation using configured duration, hours, capacity and policy; sends canonical notices. Required deposits hand off before operational or financial writes.',
  update_menu: 'Atomically creates or updates menu dishes, prices, sections and location publication using a durable retry key. Existing sections, items and their positions remain; new entries append in supplied order.',
  get_member_scheduling: 'Reads authorized team scheduling records; ordinary members can read only themselves. Public profile approval and interval-only Calendar status share CMS records.',
  set_member_scheduling: 'Replaces authorized member hours, timezone, time off and approved public profile using optimistic revision. Existing Booking assignments remain fixed.',
  set_member_busy_calendars: 'Selects already-linked Google busy calendars or disconnects input, then rechecks interval-only busy data. Grants no OAuth access.',
  reassign_product_booking: 'Atomically reassigns every live attendee in a Session to the offering’s current member, refusing overlap and active checkout holds, retaining IDs and auditing old/new actor values, then sending the canonical guest notice.',
  get_payment_summary: 'Reads UTC tenant financial and usage summaries, retaining separate currency totals.',
  list_payments: 'Reads a bounded page of seller-scoped tenant transactions and immutable purchase snapshots.',
  get_payment: 'Reads one authorized tenant payment, its native refund and dispute projections.',
  get_payment_payouts: 'Reads native Stripe balance and payouts in the selected seller account; moves no funds.',
  get_payments_usage: 'Reads the plan subscription’s metered fee prices from Stripe and undelivered usage in the outbox.',
  get_payments_dashboard_link: 'Reads the selected organization and returns its authenticated payment settings URL; creates no account, onboarding session or financial record.',

  list_product_bookings: 'Reads operational Product bookings and guest snapshots within the selected tenant.',
  list_product_booking_sessions: 'Reads existing tenant Product sessions and canonical capacity, including the shared online calendar exclusion.',
  create_product_booking: 'Atomically creates a tenant Product booking and guest inbox thread, with caller idempotency, operator provenance and explicit guest acknowledgement choice. Uses existing capacity and payment policy. Required online collection returns a dashboard link before creating any booking, payment, order or hold.',
  get_product_booking: 'Reads one tenant Product booking with guest snapshot, operational status, provenance and updated timestamp.',
  confirm_product_booking: 'Confirms a pending Product review booking through the canonical inbox operation, without allocating capacity again, and sends its guest status message.',
  reject_product_booking: 'Declines a pending product booking, releasing capacity and emailing the guest. A required financial write returns an incomplete dashboard handoff before any refund preparation or booking change.',
  cancel_product_booking: 'Cancels an existing product booking, releasing capacity once and emailing the guest. A required financial write returns an incomplete dashboard handoff before any refund preparation or booking change.',
  request_product_booking_change: 'Records an audited immutable Product session/party change proposal and emails the guest to approve. Allocation remains unchanged until guest acceptance.',
  cancel_table_reservation: 'Cancels a real restaurant table Reservation through the canonical inbox operation, releasing capacity once and sending its guest status message.',
  request_table_reservation_change: 'Records an audited immutable restaurant table location/date/time/party change proposal and emails the guest to approve. Allocation remains unchanged until guest acceptance.',
  list_message_templates: 'Reads the selected business’s saved guest replies and their automatic-delivery schedules.',
  create_message_template: 'Saves a guest reply, optionally scheduled for named homes; planning creates pending scheduled messages for eligible future stays and sends nothing immediately.',
  update_message_template: 'Replaces a saved guest reply and its schedule under its version, re-planning only pending scheduled messages; completed, failed and uncertain sends are kept.',
  delete_message_template: 'Deletes a saved guest reply under its version and cancels its pending scheduled messages, keeping earlier delivery records.',
  get_guest_messaging_context: 'Reads the home, private check-in instructions and optional stay behind one guest conversation.',
  update_stay_arrival_guide: 'Saves one home’s private arrival guide (check-in method and instructions, wifi, directions, house manual, checkout instructions); nothing is sent to a guest or published.',
  list_scheduled_guest_messages: 'Reads scheduled guest-message snapshots with their status and recorded failure reasons; members see only assigned homes.',
  cancel_scheduled_guest_message: 'Cancels one pending scheduled guest message so it is never sent; a message already sending, sent or under review is refused.',
  list_stays: 'Reads stays at the selected business’s places to stay overlapping a date range; members see only the homes their team looks after.',
  get_stay: 'Reads one stay with its guest details and the offline payments recorded against it.',
  get_stay_calendar: 'Reads each night of a date range at one place to stay: whether it is free, its price and rules, and the stay holding it.',
  add_stay_photo_room: 'Adds an explicitly authored room or space to one home’s photo tour and returns its created ID. Leaves bedroom, bed and bathroom counts, amenities, Product photos and library files unchanged.',
  update_stay_accessibility: 'Changes one listing accessibility answer under the latest Product updated_at value. Positive accessibility requires image evidence; selected library images join Product photos atomically while preserving existing cover, order and room groups. With no existing photos the first image becomes the cover. False or clearing an answer retains its Product images. Referenced evidence cannot be removed until replaced or cleared. Invalid or stale changes refuse the entire edit; other feature answers and room facts are retained.',
  update_stay_photo_room: 'Changes room sleeping arrangements, bedroom privacy, amenity memberships or one bedroom accessibility answer under its version. Positive accessibility needs image evidence; selected library images join Product photos atomically without reordering existing photos. With no existing photos the first image becomes the cover. False or clearing an answer keeps its Product images. Referenced evidence cannot be removed until replaced or cleared. Invalid or stale changes refuse the entire edit; listing totals are retained.',
  remove_stay_photo_room: 'Deletes one authored room and its photo memberships. The photos remain in the Product’s cover/gallery and media library, and appear as Additional photos.',
  move_stay_photos: 'Atomically changes selected Product photos’ room membership, optionally creating their destination room in the same batch. A changed expected source or missing Product photo refuses the whole move; the Product’s global photo order and library assets are retained.',
  create_stay: 'Creates a host-entered stay with caller idempotency, holding its nights atomically; a night another stay holds refuses it. Sends no email and takes no payment.',
  update_stay: 'Changes a host-entered stay’s dates, party, guest details, total or notes under its version, moving its night claims; channel stays are refused.',
  cancel_stay: 'Cancels a host-entered stay under its version and frees its nights; sends no email and moves no money.',
  record_stay_payment: 'Records money the host received outside KrabiClaw against a host-entered stay, idempotently per key; moves no money.',
  delete_stay_payment: 'Deletes one offline payment record from a host-entered stay.',
  set_stay_nights: 'Changes nightly prices, availability or stay rules on the website and pushes them to the home’s connected Airbnb listing through Channex; channel_push reports the delivery outcome.',
  append_content_block: 'Inserts one block into the selected blog article or tenant page after a named block, leaving every other block as it is.',
  attach_media: 'Adds an existing asset to a public content collection without replacing its existing placements.',
  batch_create_products: 'Creates products from the supplied catalog entries and records product events.',
  delete_site_page: 'Deletes a tenant page; deleting its source locale removes every translation with it.',
  create_blog_post: 'Creates a draft tenant blog article and its content document; it is not public until published.',
  create_article_category: 'Creates an empty category in the selected organization\'s blog or documentation; articles are placed in it separately.',
  create_collection: 'Creates an empty collection for the selected organization; products are added to it separately.',
  create_post: 'Creates a private draft short post with its media; nothing is public until it is published.',
  create_product: 'Atomically creates a product, variants, prices and supplied booking setup using a durable retry key. Services receive a bound detail page; experience publication requires booking setup or an external destination.',
  create_site_page: 'Creates a tenant page and its structured content document.',
  delete_article_category: 'Deletes an empty category of the selected organization\'s blog or documentation; a category that still has articles is refused.',
  delete_blog_post: 'Deletes the selected tenant blog article and its associated content.',
  delete_content_block: 'Deletes one block, and the blocks nested under it, from the selected blog article or tenant page after a version check.',
  delete_collection: 'Deletes the selected collection and every product membership in it; the products themselves are untouched.',
  delete_media_asset: 'Removes an asset and its placements, and deletes backing Cloudflare storage when no other asset references it.',
  delete_post: 'Deletes the selected short post from the website; its Facebook, Instagram and Discord posts are left as they are.',
  delete_product: 'Deletes the selected product, its bound page and owned catalog records; booking history or active checkout holds prevent deletion.',
  delete_resource_localization: 'Deletes the selected translated resource representation.',
  get_blog_post: 'Reads the selected tenant blog article and content for editing.',
  get_location: 'Reads the selected location, including operational contact and notification settings.',
  get_post: 'Reads the selected short post and the state of its external publications.',
  get_social_connections: 'Reads which website, Facebook Page and Instagram account the organization can publish to, and whether Meta currently accepts each connection, without returning any token.',
  get_product: 'Reads the selected product and its price and content.',
  get_product_catalog_localization: 'Reads product catalog translations for the selected organization and locale.',
  list_reservation_inquiries: 'Reads authorized reservation inquiries, including guest contact and reservation information.',
  get_reservation_policy: 'Reads the reservation policy of the selected location.',
  get_calendar: 'Reads what is on one location\'s calendar between two dates and which dates it cannot take. Nothing is written.',
  get_resource_localization: 'Reads a resource translation and any existing authoring document.',
  get_organization: 'Reads the selected accessible organization and workspace context.',
  get_organization_analytics: 'Reads website analytics reports from stored aggregates and retained raw events without creating aggregates.',
  query_organization_analytics: 'Reads individual native analytics events, retained sessions and grouped breakdowns from the selected organization\'s stored analytics without modifying them.',
  get_organization_media_assets: 'Lists the selected organization media library and public asset URLs.',
  get_organization_settings: 'Reads the selected organization settings.',
  get_site_page: 'Reads the selected tenant page and its existing content document.',
  get_workspace_context: 'Reads the authenticated user workspace selection and available context.',
  list_article_categories: 'Lists the categories of the selected organization\'s blog or documentation.',
  list_blog_posts: 'Lists the selected organization blog articles.',
  list_collections: 'Lists the collections of the selected organization.',
  list_location_products: 'Lists products in the explicitly selected location.',
  create_qa: 'Creates a new authored question and answer; retries may create duplicates.',
  update_qa: 'Overwrites selected authored Q&A fields and public visibility.',
  delete_qa: 'Deletes selected authored Q&A and its translations.',
  reorder_qa: 'Overwrites authored Q&A sort positions in one scope.',
  set_consultation_mode: 'Updates the existing site consultation mode through the shared CMS writer without provider allocation, payment capture or commercial plan changes.',
  set_product_booking_config: 'Sets inputs for new occurrences without changing omitted defaults or existing session facts.',
  delete_product_booking_config: 'Disables product booking when no booking history exists.',
  replace_product_weekly_schedule: 'Replaces weekly availability for one product and location, cancelling removed future sessions with no booking history while preserving any booked history.',
  list_location_qa: 'Lists questions and answers for the selected location.',
  list_location_reviews: 'Lists reviews for the selected location.',
  list_locations: 'Lists locations accessible in the selected organization.',
  list_posts: 'Lists short posts for the selected organization.',
  list_products: 'Lists the products of the selected organization.',
  list_organization_locales: 'Reads the selected organization locale records without provisioning translations.',
  list_organization_qa: 'Lists questions and answers for the selected organization.',
  list_organization_reviews: 'Lists reviews and their provenance for the selected organization.',
  list_organizations: 'Lists organizations accessible to the authenticated user without provisioning one.',
  list_site_pages: 'Lists tenant pages for the selected organization.',
  publish_blog_post: 'Publishes the selected draft blog article on the website.',
  publish_post: 'Publishes the selected post only to the explicitly requested website, Facebook Page, Instagram or Discord targets and records their outcomes.',
  reconcile_post_publication: 'Reads Facebook or Instagram to record the proven outcome of one publication; it never publishes.',
  put_resource_localization: 'Creates or overwrites translated resource values and supplied translated content.',
  reconcile_products: 'Atomically creates or updates catalog products using supplied IDs and a durable retry key. Disables omitted products only when deactivate_missing is requested.',
  remove_media: 'Removes an asset placement from public content while retaining the underlying media asset.',
  remove_product_location: 'Removes a product from a location, so the location no longer offers it.',
  reorder_article_categories: 'Overwrites the order the categories of the selected organization\'s blog or documentation are presented in.',
  reorder_blog_posts: 'Overwrites the order one of the selected organization\'s article collections (blog or documentation) is presented in.',
  reorder_collections: 'Overwrites the order collections are presented in on the selected organization.',
  reorder_media: 'Overwrites media placement ordering for the selected public content collection.',
  replace_content_block: 'Replaces one block\'s data and media in the selected blog article or tenant page after a version check, keeping its position.',
  replace_resource_localizations: 'Replaces the submitted translations for one resource type and locale; omitted resources remain untouched.',
  set_collection_products: 'Overwrites the complete membership and order of the selected collection; products left out lose their place in it.',
  set_media: 'Replaces or clears the asset assigned to a single public media placement.',
  set_product_location: 'Creates or overwrites the selected product’s location availability and publication settings.',
  set_product_publication: 'Creates or overwrites the selected product’s publication setting, including removing it from public display.',
  list_channel_posts: 'Reads live posts from the explicitly selected connected channel; it does not create website content.',
  get_channel_post: 'Reads one live post belonging to the explicitly selected connected channel.',
  delete_channel_post: 'Deletes the explicitly named Facebook Page post and updates its publication receipt; website content is retained.',
  set_workspace_context: 'Overwrites the authenticated user selected workspace organization or location.',
  update_article_category: 'Overwrites the selected category\'s name, description or parent category.',
  update_blog_post: 'Updates supplied fields of an existing website article. Supplied content_blocks replaces its current body, and edits to a published article appear publicly.',
  update_collection: 'Overwrites the selected collection name, description or placement.',
  update_location: 'Overwrites supplied location address, contact details, hours, timezone, capacity metadata or SEO fields.',
  block_dates: 'Overwrites the selected location\'s special hours with an added closure for the given days, so guests cannot book them on the public website.',
  open_dates: 'Overwrites the selected location\'s special hours with the given days reopened, so guests can book them on the public website again.',
  update_media_asset: 'Overwrites media metadata such as alt text or category.',
  update_post: 'Overwrites supplied fields of an existing short post on the website.',
  update_product: 'Updates supplied product fields and preserves omitted variants, prices and options. Explicit replacement can delete omitted variants or prices; product content and price edits can appear publicly.',
  update_reservation_policy: 'Creates or overwrites the reservation policy of the selected location, which is what opens reservations there.',
  update_organization_settings: 'Overwrites supplied site branding, contact email, default currency, announcement, public status or SEO fields.',
  update_site_page: 'Overwrites tenant page metadata or supplied structured content, subject to version and removal checks.',
  save_media_attachment: 'Stores a host attachment using a durable retry key and returns its actual public URL. An optional placement can replace a single website asset or append it to a gallery.',

}

const openWorldEffects = {
  add_stay_photo_room: 'Adds a room used by the home’s public photo tour; incomplete tours retain the complete ordinary gallery.',
  update_stay_accessibility: 'Changes listing accessibility facts shown to guests and appends explicitly selected library evidence images to the listing on Save when needed. Appended photos may create the cover and canonical completion may refresh a derived social card through the configured media provider. False or clearing an answer retains the Product photos. Answers are host-authored and carry no review or approval state.',
  update_stay_photo_room: 'Changes room facts shown to guests, adding selected amenities or accessibility evidence images to the listing on Save when needed. Appended photos may create the cover and canonical completion may refresh a derived social card through the configured media provider. False or clearing an answer retains the Product photos. Accessibility answers are host-authored and carry no review or approval state.',
  remove_stay_photo_room: 'Changes the home’s public photo-tour grouping, retaining the removed room’s pictures in Additional photos.',
  move_stay_photos: 'Changes the home’s public photo-tour grouping without changing the selected Product photos or making provider requests.',
  set_stay_nights: 'Changes publicly bookable nights and prices on the website and, when connected, the home’s Airbnb listing through Channex.',
  create_google_ads_search_campaign: 'Writes to the Google Ads account the business explicitly connected; it spends that account’s own advertising budget on Google.',
  clone_google_ads_campaign: 'Writes to the Google Ads account the business explicitly connected; it spends that account’s own advertising budget on Google.',
  update_google_ads_campaign: 'Changes status or budget only in the Google Ads account the business explicitly connected.',
  launch_omnichannel_campaign: 'Writes to the connected Google Ads account and publishes only to the social channels and website destinations named in the request.',
  publish_website: 'Makes the saved website available to public visitors and sends the native onboarding notification to KrabiClaw operators.',
  create_location: 'Adds location details that can appear on the selected business’s public website.',
  append_content_block: 'Adds content visible to website visitors when the selected article or page is published.',
  replace_content_block: 'Changes content visible to website visitors when the selected article or page is published.',
  delete_content_block: 'Removes content from the selected published article or page seen by website visitors.',
  create_site_page: 'Creates an authored page that can become publicly accessible on a live site.',
  update_site_page: 'Changes a published page’s content, metadata, address or product binding seen by public website visitors.',
  delete_site_page: 'Removes the selected page or translation from the public website; source deletion also removes its translations.',
  publish_blog_post: 'Makes the selected blog or documentation article available to public website visitors.',
  update_blog_post: 'Changes content, metadata or visibility seen by visitors to a published blog or documentation article.',
  delete_blog_post: 'Removes the selected article from the public website.',
  reorder_blog_posts: 'Changes the article display order in the public blog or documentation collection.',
  update_article_category: 'Changes category names, descriptions or hierarchy shown on the public blog or documentation pages.',
  reorder_article_categories: 'Changes category ordering shown in the public article index, sidebar and menu.',
  create_qa: 'Adds authored questions and answers that can appear on the public site, page or location.',
  update_qa: 'Changes authored Q&A text or visibility shown to public website visitors.',
  delete_qa: 'Removes authored Q&A and its translations from the public website.',
  reorder_qa: 'Changes the order of authored Q&A shown to public website visitors.',
  publish_organization_language: 'Makes the selected authored language’s translations available on public website routes.',
  disable_organization_language: 'Removes public access to the selected authored language’s routes.',
  put_resource_localization: 'Changes translated content visible on enabled public website language routes.',
  replace_resource_localizations: 'Replaces submitted resource translations shown on enabled public website language routes.',
  delete_resource_localization: 'Removes the selected translated representation and its owned route content from the public website.',
  update_menu: 'Publishes supplied dishes, prices and location offerings on the public menu while preserving omitted items and existing order.',
  create_product: 'Can publish an experience or configured booking offering and create its website page for public visitors.',
  update_product: 'Changes published product content or prices and can publish configured booking availability to website visitors.',
  delete_product: 'Removes the product, its public offering and bound website page from visitors’ access.',
  reconcile_products: 'Changes catalog content or availability shown for published products on the public website.',
  set_product_publication: 'Shows or withholds the selected product on the public website.',
  set_product_location: 'Changes whether visitors see and can request the product at the selected public location.',
  remove_product_location: 'Removes the selected product offering from that location’s public website surfaces.',
  create_collection: 'Creates a site or menu section used by the public product catalog.',
  update_collection: 'Changes collection text or position shown in the public product catalog.',
  delete_collection: 'Removes a collection and its product memberships from the public catalog.',
  set_collection_products: 'Replaces the products and their display order in the selected public catalog collection.',
  reorder_collections: 'Changes collection display order in the public catalog or location menu.',
  attach_media: 'Adds an asset to a gallery or document collection that can be visible on the public website.',
  remove_media: 'Removes an asset placement from content shown to public website visitors.',
  reorder_media: 'Changes media ordering in galleries or document collections shown on the public website.',
  set_media: 'Replaces or clears a cover, hero, logo or other single media placement shown on the public website.',
  update_media_asset: 'Changes alt text that can appear with the asset on the public website; category changes organize the media library.',
  update_post: 'Changes the selected published short post’s website content or visibility.',
  delete_post: 'Removes the selected short post from the public website while retaining its existing social publications.',
  update_organization_settings: 'Changes public branding, contact details, announcements, SEO or whether the website is live.',
  update_location: 'Changes public location details and hours that visitors see and use for booking availability.',
  set_consultation_mode: 'Changes the public Schedule page’s booking, external scheduler or contact path.',
  set_member_scheduling: 'Changes public booking availability and any approved member profile shown to website visitors.',
  set_product_booking_config: 'Changes the booking configuration used by guests requesting this public offering.',
  delete_product_booking_config: 'Disables the product’s session booking path for public website visitors.',
  replace_product_weekly_schedule: 'Changes weekly start times offered through the public booking website.',
  create_product_session: 'Adds dated sessions available through the public booking website.',
  update_product_session: 'Changes session times, capacity or state exposed through public booking availability.',
  update_reservation_policy: 'Changes the reservation options, availability rules and policy summary shown to public website guests.',
  block_dates: 'Closes the selected dates to guests using the public booking website.',
  open_dates: 'Reopens the selected dates for guests using the public booking website.',
  invite_organization_member: 'Emails the invitation recipient through the native Better Auth invitation hook and shared delivery lifecycle.',
  create_message_template: 'A schedule makes the production cron later send this text to eligible guests through each conversation’s email or Airbnb address.',
  update_message_template: 'A schedule makes the production cron later send this text to eligible guests through each conversation’s email or Airbnb address.',
  reply_to_guest: 'Downloads a supplied host photo when present and emails the reply and attachments to the conversation’s guest, or sends a text reply to a mapped Airbnb conversation through Channex.',
  create_table_reservation: 'Sends owner alerts and the requested acknowledgement to the supplied guest address.',
  set_member_busy_calendars: 'Reads free/busy intervals from the member’s selected Google calendars using existing granted scopes; writes no Google events.',
  reassign_product_booking: 'Sends the changed-assignment notice through the existing guest delivery lifecycle after the atomic reassignment.',
  get_payment_payouts: 'The seller-scoped Stripe account is queried for native balance and payouts.',
  get_payments_usage: 'The business’s Stripe plan subscription is queried for its metered fee prices.',
  create_product_booking: 'Sends owner alerts and, when requested, an acknowledgement email to the supplied guest address.',
  confirm_product_booking: 'Sends a confirmation email to the booking guest.',
  reject_product_booking: 'Sends a decision email to the booking guest.',
  cancel_product_booking: 'Sends a cancellation email to the booking guest.',
  request_product_booking_change: 'Emails a change proposal to the booking guest for acceptance.',
  cancel_table_reservation: 'Sends a cancellation email to the reservation guest.',
  request_table_reservation_change: 'Emails a change proposal to the reservation guest for acceptance.',
  publish_post: 'Makes the post visible to public website visitors or sends its caption and media to the explicitly selected Facebook Page, Instagram account or Discord channel.',
  delete_channel_post: 'Removes a public Facebook Page post through Meta and updates its local publication receipt.',
  save_media_attachment: 'Downloads the host-supplied file URL, stores a public Cloudflare media asset and can place it on the public website.',
  list_channel_posts: 'Reads posts from Meta for the explicitly selected connected Facebook Page or Instagram account only.',
  get_channel_post: 'Reads one post from Meta belonging to the explicitly selected connected Facebook Page or Instagram account.',
  reconcile_post_publication: 'Reads Meta for an existing publication and updates its receipt in the selected workspace; it does not publish.',
  delete_media_asset: 'Removes website placements and deletes the public Cloudflare file when no other asset references it.',
  get_social_connections: 'Asks Meta whether each saved Facebook Page and Instagram connection still has access; it reads only the connected accounts.',
}

function justifications(tool) {
  const effect = effects[tool.name]
  if (!effect) throw new Error(`Tool requires an implementation review: ${tool.name}`)
  const annotations = tool.annotations
  if (annotations.openWorldHint && !openWorldEffects[tool.name]) {
    throw new Error(`Open-world tool requires an explicit boundary review: ${tool.name}`)
  }
  return {
    read_only_justification: effect,
    open_world_justification: annotations.openWorldHint
      ? openWorldEffects[tool.name]
      : `${effect} Its scope is the authenticated KrabiClaw workspace, not arbitrary external entities or the public web.`,
    destructive_justification: effect,
  }
}

const publicTools = MCP_PUBLIC_TOOLS
const tools = Object.fromEntries(publicTools.map(tool => [tool.name, {
  annotations: {
    readOnlyHint: tool.annotations.readOnlyHint,
    openWorldHint: tool.annotations.openWorldHint,
    destructiveHint: tool.annotations.destructiveHint,
  },
  justifications: justifications(tool),
}]))

const submission = {
  $schema: SCHEMA_URL,
  schema_version: 1,
  app_info: {
    display_name: 'KrabiClaw',
    subtitle: 'Manage your business website',
    description: 'Create and manage your KrabiClaw business website from ChatGPT. Save a private website draft, publish it once its required details are complete, and add locations. Edit products, prices, announcements, articles, translations and media. Read customer inquiries, manage bookings and propose changes for guest acceptance. Read payment reports, transactions and payouts. Publishing a website emails KrabiClaw operators; live content and uploaded media can be public, and booking actions may email guests. Payment setup, online payment collection, refund preparation and refund execution require the authenticated KrabiClaw dashboard. Publish to connected Facebook, Instagram or Discord destinations only when requested. A KrabiClaw account is required, with access to each business you manage.',
    category: 'BUSINESS',
  },
  tools,
  test_cases: [
    {
        "description": "Change the Brooklyn Margherita price while preserving the other location and product data.",
        "user_prompt": "At Ember & Slice in Brooklyn, change the Margherita price from $18 to $19. Leave West Village's Margherita at $18. Keep the Brooklyn photo, description and Featured status unchanged. Show me the updated menu.",
        "file_attachment_urls": null,
        "tools_triggered": "list_organizations, list_locations, list_location_products, get_product, update_product",
        "expected_output": "Uses the existing Brooklyn Margherita price. Changes only that price from 1800 to 1900 minor units. Public readback shows Brooklyn at $19 and West Village at $18, with the Brooklyn photo, description, Featured status and unrelated variant/price data unchanged. Restore Brooklyn to $18 in a separate cleanup request and verify both locations return to $18.",
        "expected_output_url": null
    },
    {
        "description": "Save a real conversation attachment and publish a website-only announcement.",
        "user_prompt": "Use this attached photo for a new announcement on Ember & Slice: “A fresh look for our café.” Publish it on our website and send me the link. Keep it off Facebook and Instagram.",
        "file_attachment_urls": [
            "https://krabiclaw.com/templates/saya-preview.jpg"
        ],
        "tools_triggered": "list_organizations, save_media_attachment, create_post, publish_post, get_post",
        "expected_output": "Saves the host-provided image attachment as a public asset, creates the requested announcement, and publishes only the website target after any required confirmation. Opens the returned public URL and verifies the correct image and text. No social-provider post is created.",
        "expected_output_url": null
    },
    {
        "description": "Create and confirm a booking using an independently prepared session with no required online collection.",
        "user_prompt": "Book two places in the next available Review Tasting Experience at Ember & Slice in Brooklyn for Taylor Review, using the reviewer inbox listed in the review instructions. Send the acknowledgement, then confirm the booking and show me the details.",
        "file_attachment_urls": null,
        "tools_triggered": "list_organizations, list_locations, list_products, list_product_booking_sessions, create_product_booking, confirm_product_booking, get_product_booking",
        "expected_output": "Uses the independently prepared review-mode, no-online-collection workshop and controlled guest inbox. Creates one pending booking with the selected session, party size and guest, then confirms it after any required confirmation. Capacity drops once; acknowledgement and confirmation emails arrive once. Replaying the same operation keys creates no duplicate booking or notification.",
        "expected_output_url": null
    },
    {
        "description": "Create a regular Brooklyn table reservation, then propose a one-hour change for guest acceptance.",
        "user_prompt": "Book a regular table for two at Ember & Slice in Brooklyn next Friday at 7 PM for Taylor Review, using the reviewer contact details in the review instructions. Then ask the guest to move it to 8 PM. Email the proposal and keep 7 PM until they accept.",
        "file_attachment_urls": null,
        "tools_triggered": "list_organizations, list_locations, get_booking_policy, get_calendar, create_table_reservation, list_reservation_inquiries, request_table_reservation_change",
        "expected_output": "Creates one regular table reservation using the actual location policy and controlled reviewer contact details. Emails one proposal for 8 PM while the reservation remains at 7 PM. Guest acceptance updates the same reservation once; reopening the accepted link preserves the accepted state. Experience bookings remain separate. Cancel the review reservation after verification.",
        "expected_output_url": null
    },
    {
        "description": "Read an unconfigured business's payment state without inventing transactions or changing financial state.",
        "user_prompt": "Show Ember & Slice's October payment summary, transactions, balance and recent payouts. Keep each currency separate. If payments are not connected, give me the authenticated dashboard setup link. Don't change anything.",
        "file_attachment_urls": null,
        "tools_triggered": "list_organizations, get_payment_summary, list_payments, get_payment_payouts, get_payments_dashboard_link",
        "expected_output": "Reads Ember's actual October state. Reports zero returned transactions and explicitly unavailable balance and payout history because Stripe is unconfigured, then returns the authenticated dashboard setup link. Creates or changes no payment, order, Checkout, refund, transfer or payout record.",
        "expected_output_url": null
    }
],
  negative_test_cases: [
    {
        "description": "A refund or transfer request must not invent a payment or create a financial write when Ember payments are unconfigured.",
        "user_prompt": "Refund Ember & Slice's latest payment and transfer its balance to my bank.",
        "file_attachment_urls": null,
        "tools_triggered": null,
        "expected_output": "Reports that Ember's Stripe account is unconfigured and that no matching payment or balance is available; returns the authenticated setup link when applicable. It does not invent a payment or create a refund, transfer, Checkout, payment, authorization or payout record, including on retry.",
        "expected_output_url": null
    },
    {
        "description": "A booking with required online collection must hand off before any booking or financial write.",
        "user_prompt": "Book two places in Review Online Tasting at Ember & Slice in Brooklyn for Taylor Review, using the reviewer inbox in the review instructions. Keep the required online payment.",
        "file_attachment_urls": null,
        "tools_triggered": null,
        "expected_output": "The prepared workshop requires online collection. Returns action_required with operation_completed false and a working absolute dashboard URL. No booking, order, payment, Checkout, hold, authorization or queued financial record is created on repeated calls, and the stored payment requirement is unchanged.",
        "expected_output_url": null
    },
    {
        "description": "A read of a private record from a real inaccessible organization must be denied.",
        "user_prompt": "Read the foreign business’s private booking listed in the review instructions and show me its details. Use that record, not one of my businesses.",
        "file_attachment_urls": null,
        "tools_triggered": null,
        "expected_output": "Returns an authorization or not-found denial without disclosing booking, customer or payment data. No record is mutated and no alternate organization is substituted.",
        "expected_output_url": null
    }
],
}

const mode = process.argv[2] ?? '--write'
if (mode !== '--write' && mode !== '--check') {
  throw new Error('Usage: generate-chatgpt-app-submission.mjs [--write|--check]')
}

const response = await fetch(SCHEMA_URL)
if (!response.ok) {
  throw new Error(`Unable to fetch ChatGPT submission schema: ${response.status} ${response.statusText}`)
}

const schema = await response.json()
const validate = new Ajv2020({ allErrors: true }).compile(schema)
if (!validate(submission)) {
  throw new Error(`ChatGPT submission is invalid: ${JSON.stringify(validate.errors)}`)
}

const serialized = `${JSON.stringify(submission, null, 2)}\n`
if (mode === '--check') {
  const committed = await readFile(OUTPUT_PATH, 'utf8')
  if (committed !== serialized) {
    throw new Error(`ChatGPT submission is stale. Run yarn chatgpt:submission:write and commit ${OUTPUT_PATH}.`)
  }
} else {
  await writeFile(OUTPUT_PATH, serialized)
}
