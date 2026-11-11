import { getPersistedSourceLocale } from '~/server/utils/localization'
import { platformLocale } from '~/shared/platform-locales'
// Seed only structural records for a newly created organization. Customer-facing
// copy must be supplied by the owner or an approved import.

import { getVerticalCopy, type OrganizationVertical } from "~/utils/vertical-copy";
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from "~/server/db";
import { createTenantPagesBatch } from "~/server/utils/content/pages";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function ensureTenantRecipePages(
  db: DbClient,
  params: {
    env: CloudflareEnv;
    organizationId: string;
    writeGuard?: BatchQuery;
  },
): Promise<void> {
  const { env, organizationId, writeGuard } = params;
  const org = await queryFirst<{ name: string; vertical: OrganizationVertical }>(
    db,
    'SELECT name, vertical FROM organization WHERE id = ? LIMIT 1',
    [organizationId],
  );
  if (!org) return;

  const source = await getPersistedSourceLocale(db, organizationId);
  const catalog = platformLocale(source.locale);
  if (!catalog) return;

  const pageTitle = (key: string) => {
    return catalog.messages[`site_pages.${key}`] || key;
  };

  const { vertical, name } = org;

  const sitePages = new Map<string, { path: string; title: string; pageType: 'system' | 'recipe' | 'legal'; recipe: string }>([
    ['home', { path: '/', title: pageTitle('home'), pageType: 'system', recipe: 'home' }],
    ['about', { path: '/about', title: pageTitle('about'), pageType: 'system', recipe: 'about' }],
    ['contact', { path: '/contact', title: pageTitle('contact'), pageType: 'system', recipe: 'contact' }],
    ['qa', { path: '/qa', title: pageTitle('qa'), pageType: 'recipe', recipe: 'qa' }],
    ['reviews', { path: '/reviews', title: pageTitle('reviews'), pageType: 'recipe', recipe: 'reviews' }],
  ]);

  if (vertical === 'service') {
    for (const [page, path, title, pageType] of [
      ['services', '/services', pageTitle('services'), 'system'],
      ['schedule', '/schedule', pageTitle('schedule'), 'system'],
      ['privacy', '/policies/privacy', pageTitle('privacy'), 'legal'],
      ['terms', '/policies/terms', pageTitle('terms'), 'legal'],
      ['third-party-notices', '/third-party-notices', pageTitle('third_party_notices'), 'legal'],
    ] as const) sitePages.set(page, { path, title, pageType, recipe: page });
  }

  const existingPages = await queryAll<{ path: string }>(
    db,
    "SELECT path FROM content_documents WHERE organization_id = ? AND kind = 'page' AND row_role = 'root'",
    [organizationId],
  );
  const existingPaths = new Set(existingPages.map(page => page.path));

  const pagesToCreate: Array<{
    data: {
      locale: string;
      path: string;
      title: string;
      pageType: 'system' | 'recipe' | 'legal';
      recipe: string;
      blocks: Array<{ id: string; type: string; position: number; data: Record<string, unknown> }>;
    };
    trustedSystemPage: boolean;
  }> = [];

  for (const definition of sitePages.values()) {
    if (existingPaths.has(definition.path)) continue;
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

    if (definition.path === '/qa') {
      blocks.push({
        id: uid('block'),
        type: 'faq',
        position: 1,
        data: { title: 'Q&A' },
      });
    } else if (definition.path === '/reviews') {
      blocks.push({
        id: uid('block'),
        type: 'testimonial_grid',
        position: 1,
        data: { title: 'Reviews' },
      });
    } else if (vertical === 'service' && definition.path === '/contact') {
      const copy = getVerticalCopy(vertical, source.locale);
      const location = await queryFirst<{ id: string }>(
        db,
        "SELECT id FROM business_locations WHERE organization_id = ? LIMIT 1",
        [organizationId],
      );
      const locId = location?.id ?? '';
      blocks.push(
        {
          id: uid('block'),
          type: 'location_grid',
          position: 1,
          data: { title: copy.locationGroupLine(1), description: copy.findUsKicker, location_ids: locId ? [locId] : [] },
        },
        { id: uid('block'), type: 'contact_form', position: 2, data: {} },
      );
    }

    pagesToCreate.push({
      trustedSystemPage: definition.pageType === 'system' || definition.pageType === 'recipe',
      data: {
        locale: source.locale,
        path: definition.path,
        title: definition.title,
        pageType: definition.pageType,
        recipe: definition.recipe,
        blocks,
      },
    });
  }

  if (pagesToCreate.length) {
    await createTenantPagesBatch(db, { env, organizationId, pages: pagesToCreate, writeGuard });
  }
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

  if (statements.length) await executeBatch(db, [...(writeGuard ? [writeGuard] : []), ...statements]);

  // ── Canonical tenant pages (structural records only) ──────────────────────
  await ensureTenantRecipePages(db, { env, organizationId, writeGuard });

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
      metadata_json: null,
    }, writeGuard)
  }

  return locationId
}
