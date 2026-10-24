import { mcpProtocolError, MCP_ERROR } from "./mcp-protocol.ts";

export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
}

export const MCP_PROMPTS: McpPromptDefinition[] = [
  {
    name: "set_up_products",
    description: "Build out Products from a free-text description of names, collections, and prices.",
    arguments: [
      { name: "items_description", description: "Free text describing the Products, collections, and prices to add.", required: true },
    ],
  },
  {
    name: "create_and_publish_post",
    description: "Create a short post, review its draft, and publish it to the destinations the user names.",
    arguments: [
      { name: "body", description: "The caption, as the user wants it read. Event dates, offers and codes are part of it.", required: true },
      { name: "destinations", description: "Where to publish, in the user's words: website, Facebook, Instagram, Discord, or several. Nothing is assumed.", required: true },
    ],
  },
  {
    name: "set_up_bookable_product",
    description: "Create a new bookable Product from a description.",
    arguments: [
      { name: "description", description: "What it is, including price/duration/capacity if known.", required: true },
    ],
  },
  {
    name: "triage_inbox",
    description: "Summarize guest and team conversations, pending bookings and reviews awaiting a reply.",
    arguments: [],
  },
  {
    name: "improve_my_homepage",
    description: "Review the homepage and suggest the highest-impact changes to make it look better and more inviting.",
    arguments: [],
  },
  {
    name: "add_photos_to_organization",
    description: "Add the user's own photos to the right places on the site (homepage, location, Products, or posts).",
    arguments: [],
  },
  {
    name: "finish_my_organization_setup",
    description: "Identify missing business facts and finish the requested site setup.",
    arguments: [],
  },
  {
    name: "make_organization_more_bookable",
    description: "Review calls-to-action, contact info, and reservation/booking setup, and suggest changes to get more bookings.",
    arguments: [],
  },
  {
    name: "make_my_organization_look_better",
    description: "Review the website and recommend concrete visual and content improvements.",
    arguments: [],
  },
  {
    name: "grow_my_bookings",
    description: "Look at traffic, listing completeness, and booking/reservation demand together, and suggest the highest-impact next move to get more bookings this week.",
    arguments: [],
  },
];

// Prompt prose uses the same operation-name convention as the tool registry.
// Include previous names when checking a release so a removed operation prefix
// cannot hide a stale reference. Arguments are rendered as placeholders by the
// catalog check; user-supplied text is never inspected by this function at runtime.
export function referencedMcpTools(text: string, toolNames: string[], previousToolNames: string[] = []): string[] {
  const current = new Set(toolNames);
  const operations = new Set([...toolNames, ...previousToolNames].map(name => name.split('_')[0]));
  const references = new Set<string>();
  for (const [name] of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    if (!operations.has(name.split('_')[0])) continue;
    if (!current.has(name)) throw new Error(`Unknown MCP tool reference: ${name}`);
    references.add(name);
  }
  return [...references].sort();
}

export function renderMcpPrompt(name: string, args: Record<string, string>): { description: string; text: string } {
  switch (name) {
    case "set_up_products": {
      const itemsDescription = args.items_description!;
      return {
        description: "Build out Products from a description",
        text: [
          `Update the catalog from: ${itemsDescription}`,
          'Use get_workspace_context, list_organizations and list_locations to resolve the business and explicit location. Read every relevant list_location_products and list_collections page before matching existing IDs.',
          'For a restaurant menu, use update_menu with a stable idempotency_key, the stated sections and prices. Match existing product, variant, price and collection IDs. Omitted items and order remain; use set_collection_products or reorder_collections only when the user requests a complete new order.',
          'For other products, use create_product for new entries or update_product for partial edits. Use reconcile_products only when the user requests complete replacement of the supplied entries.',
          'Ask for missing prices or booking facts. Use get_product and list_location_products to read back the result, then open the returned public URL before reporting completion.',
        ].join(' '),
      };
    }
    case "create_and_publish_post": {
      const body = args.body!;
      const destinations = args.destinations!;
      return {
        description: "Create and publish a post",
        text: [
          `Call create_post with a new idempotency_key and this body: ${body}`,
          "If the user supplied or approved media, pass it as create_post media in the order they want it shown: the cover first, then the gallery.",
          `Publish only to: ${destinations}. For Facebook, Instagram or Discord, call get_social_connections and use the exact target_id and connection_revision it returns; if the destination is not connected or has a problem, say so instead of publishing elsewhere.`,
          "Show the user the draft's preview_url, then call publish_post with the post's updated_at as expected_updated_at and one target per named destination.",
          "Report each outcome exactly as returned. processing means call publish_post again later to finish the same post; unknown means use reconcile_post_publication, never publish again.",
        ].join(" "),
      };
    }
    case "set_up_bookable_product": {
      const description = args.description!;
      return {
        description: "Create a new bookable Product",
        text: [
          `Create a bookable offering from: ${description}`,
          'Use get_workspace_context, list_locations and list_products to resolve the business, existing offerings and explicit location or online scope. Ask for missing price, duration, capacity, actual start times, confirmation and payment choices.',
          'Use create_product with booking setup and one idempotency key. Preserve the supplied facts and attach supplied media to the returned product ID.',
          'Use get_product to read booking_readiness and list_product_booking_sessions with a concrete date range to verify actual availability. Use save_media_attachment for supplied files or attach_media for existing assets. Open the returned public URL before reporting completion.',
        ].join(' '),
      };
    }
    case "triage_inbox": {
      return {
        description: "Summarize guest and team conversations, pending bookings, and unreplied reviews",
        text: [
          'Use get_workspace_context to resolve the requested business. Read all relevant list_guest_conversations pages and get_guest_conversation for full contact messages, table reservation and product booking details, proposals and delivery receipts.',
          'For internal team messages use list_team_conversations and get_team_conversation. Select actual teammates with list_team_conversation_recipients; start_team_conversation reuses the same participants and explicit stay or location context. Use send_team_message only for the requested internal message, then read it back. Reading does not mark a thread read; mark_team_conversation_read changes only the caller’s read position. Team chat is separate from guest replies and Better Auth Team/group management.',
          'Summarize unanswered messages and pending bookings. Use reply_to_guest with a stable idempotency_key only for the message or photo the user requests. Use get_product_booking before confirm_product_booking, reject_product_booking, cancel_product_booking or request_product_booking_change; use cancel_table_reservation or request_table_reservation_change for an explicitly requested table reservation action.',
          'Booking changes email a proposal and leave the existing allocation unchanged until guest acceptance. Financial actions requiring the dashboard remain incomplete; report the returned handoff instead of claiming completion.',
          'Use list_locations and list_location_reviews to read reviews separately; provider reviews and imported Google Q&A remain managed in Google.',
          'Report failed deliveries and actions awaiting guest acceptance accurately.',
        ].join(' '),
      };
    }
    case "improve_my_homepage": {
      return {
        description: "Review the homepage",
        text: "Use get_workspace_context, list_site_pages and get_site_page to read the selected business's homepage, and get_organization_media_assets for its media. Open its public preview and recommend the most useful improvements in plain language. Apply requested copy changes with update_site_page; use set_media for one image or attach_media, remove_media and reorder_media for a gallery. Read back the page and public result.",
      };
    }
    case "add_photos_to_organization": {
      return {
        description: "Place supplied photos",
        text: "Inspect the supplied photos and use get_workspace_context plus the relevant get_site_page, get_location, get_product or get_post read to resolve the intended owner and placement. Ask only about an ambiguous destination. Use save_media_attachment with a stable idempotency_key and the intended placement for each attachment; retries reuse that key. For an existing asset use set_media or attach_media. Read back the owner and open the public result before reporting placement.",
      };
    }
    case "finish_my_organization_setup": {
      return {
        description: "Finish business setup",
        text: "Use get_workspace_context and list_organizations to resolve the business. For an unfinished website use get_website_draft, save_website_draft and publish_website with the returned draft ID and revision. For an existing website use get_organization, list_locations, list_site_pages, get_site_page and list_products to identify the missing facts. Ask for those facts, use update_organization_settings, update_site_page, update_menu or create_product for the requested setup, and read back its public result.",
      };
    }
    case "make_organization_more_bookable": {
      return {
        description: "Review guest booking",
        text: "Use get_workspace_context, list_products, get_product and list_product_booking_sessions to read the public offering, booking readiness and actual availability. Use list_locations, get_location and get_reservation_policy for location hours and table reservation setup. Identify what prevents guests from booking and ask for missing business facts. Use update_product with booking setup, set_product_booking_config, replace_product_weekly_schedule or update_reservation_policy for the changes the user requests. Read back readiness, available times and the public result.",
      };
    }
    case "make_my_organization_look_better": {
      return {
        description: "Review the website",
        text: "Use get_workspace_context, list_site_pages, get_site_page, get_organization_media_assets and list_products to read the actual public pages, media and catalog. Recommend specific improvements in plain language. Apply the requested copy with update_site_page or update_product, and media with set_media or attach_media. Read back the changed record and verify the public result.",
      };
    }
    case "grow_my_bookings": {
      return {
        description: "Review booking demand",
        text: "Use get_workspace_context and get_organization_analytics to read recent traffic. Use list_products, get_product and list_product_booking_sessions for bookable offerings and availability, and list_guest_conversations plus get_guest_conversation for current guest demand. Recommend the most useful action supported by those records. Use reply_to_guest, update_product or create_post and publish_post for the action the user requests, then read back its actual outcome and report any incomplete delivery or dashboard handoff.",
      };
    }
    default:
      throw mcpProtocolError(MCP_ERROR.invalidParams, `Unknown prompt: ${name}`);
  }
}
