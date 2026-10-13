import { getPersistedSourceLocale } from '~/server/utils/localization'
import { platformLocale } from '~/shared/platform-locales'
// Seed only structural records for a newly created organization. Customer-facing
// copy must be supplied by the owner or an approved import.
// All records use source='template' so ChowBot can identify and reference them.

import { getVerticalCopy, type OrganizationVertical } from "~/utils/vertical-copy";
import { executeBatch, queryAll, type BatchQuery, type DbClient } from "~/server/db";
import { createTenantPagesBatch } from "~/server/utils/content/pages";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function seedNewOrganization(
  db: DbClient,
  params: {
    env: CloudflareEnv;
    organizationId: string;
    name: string;
    vertical: OrganizationVertical;
    writeGuard?: BatchQuery;
  },
): Promise<string> {
  if (!db) throw new Error("Database not configured");

  const { env, organizationId, name, vertical, writeGuard } = params;
  const source = await getPersistedSourceLocale(db, organizationId)
  const catalog = platformLocale(source.locale)
  if (!catalog) throw new Error('Website language catalog is unavailable')
  const pageTitle = (key: string) => {
    const title = catalog.messages[`site_pages.${key}`]
    if (!title) throw new Error(`Website page label ${key} is unavailable`)
    return title
  }

  // Reuse existing location on resume (provisioning may have failed mid-seed)
  const locations = await queryAll<{ id: string }>(
    db,
    "SELECT id FROM business_locations WHERE organization_id = ? LIMIT 2",
    [organizationId],
  );
  if (locations.length > 1) throw new Error('Onboarding requires exactly one location')
  const locationId = locations[0]?.id ?? uid("loc");

  const statements: BatchQuery[] = [];

  if (!locations.length) statements.push({
    query: `
    INSERT OR IGNORE INTO business_locations
      (id, organization_id, slug, title, rating, review_count, status, timezone)
    SELECT ?, id, 'main', ?, 0, 0, 'active', timezone FROM organization WHERE id = ?
  `,
    // The first location starts on the clock the owner gave the business.
    params: [locationId, name, organizationId],
  });


  // ── Canonical tenant pages (structural records only) ──────────────────────
  if (statements.length) await executeBatch(db, [...(writeGuard ? [writeGuard] : []), ...statements]);

  // `title` is the page's name as a person reads it — its document title and,
  // for every page but the home page, its heading. The key beside it is an
  // identifier, and using it as the title is what wrote 'about' and 'contact'
  // into the title column and rendered them as h1s.
  const templatePages = new Map<string, { path: string; title: string; pageType: 'system' | 'recipe' | 'legal'; recipe: string }>([
    ['home', { path: '/', title: pageTitle('home'), pageType: 'system', recipe: 'home' }],
    ['about', { path: '/about', title: pageTitle('about'), pageType: 'system', recipe: 'about' }],
    ['contact', { path: '/contact', title: pageTitle('contact'), pageType: 'system', recipe: 'contact' }],
    // There is no '/locations/main' page. A location detail route renders the
    // business_locations row and its datasets: usePublicPageRequest gives it the
    // page key 'location', canonicalTenantPagePath() has no entry for that, and
    // ROUTE_PAGE_PATHS has no 'locations' recipe. The page document this used to
    // create was never read by anything.
  ]);
  if (vertical === 'service') {
    for (const [page, path, title, pageType] of [
      ['services', '/services', pageTitle('services'), 'system'],
      ['schedule', '/schedule', pageTitle('schedule'), 'system'],
      ['privacy', '/policies/privacy', pageTitle('privacy'), 'legal'],
      ['terms', '/policies/terms', pageTitle('terms'), 'legal'],
      ['third-party-notices', '/third-party-notices', pageTitle('third_party_notices'), 'legal'],
    ] as const) templatePages.set(page, { path, title, pageType, recipe: page });
  }
  const pagesToCreate: Array<{
    data: {
      locale: string
      path: string
      title: string
      pageType: 'system' | 'recipe' | 'legal'
      recipe: string
      blocks: Array<{ id: string; type: string; position: number; data: Record<string, unknown> }>
    }
    trustedSystemPage: boolean
  }> = []
  const existingPages = await queryAll<{ path: string }>(db, "SELECT path FROM content_documents WHERE organization_id = ? AND kind = 'page' AND row_role = 'root'", [organizationId])
  const existingPaths = new Set(existingPages.map(page => page.path))
  for (const definition of templatePages.values()) {
    if (existingPaths.has(definition.path)) continue
    const blocks: Array<{ id: string; type: string; position: number; data: Record<string, unknown> }> = [
      {
        id: uid('block'),
        type: 'hero',
        position: 0,
        data: {
          title: definition.path === '/' ? name : definition.title,
          subtitle: null,
        },
      },
    ];
    pagesToCreate.push({
      trustedSystemPage: definition.pageType === 'system',
      data: {
        locale: source.locale, path: definition.path, title: definition.title,
        pageType: definition.pageType, recipe: definition.recipe, blocks,
      },
    })
  }
  if (pagesToCreate.length) await createTenantPagesBatch(db, { env, organizationId, pages: pagesToCreate, writeGuard })

  // ── Consultation settings (professional services only) ────────────────────
  // Service sites start with native booking. Initialization preserves any
  // consultation settings the organization already chose.
  if (vertical === "service") {
    const { initializePublicConsultationSettings } = await import('~/server/utils/professional-services')
    await initializePublicConsultationSettings(db, organizationId, {
      mode: 'native',
      cta_label: getVerticalCopy(vertical, source.locale).reservationRequestButton,
      external_url: null,
      schedule_path: '/schedule',
      confirmation_path: '/contact/confirmed',
      tracking_enabled: false,
      metadata_json: { contact_form_enabled: true },
    }, writeGuard)
  }

  return locationId
}
