import { chromium, devices } from '@playwright/test'
import type { SeedManifest } from './manifest.ts'
import { SEED_SUBDOMAINS } from './manifest.ts'

// Each business gets the visits a guest makes: its home and an offering page,
// opened in a real browser so the site itself records the pageviews and
// offering views, then starts a booking or consultation and sends one message
// through the public contact form. Insights
// and the Today feed read these as they read any guest's.
export async function seedTraffic(baseURL: string, manifest: SeedManifest) {
  const browser = await chromium.launch()
  try {
    for (const [key, tenant] of Object.entries(manifest.tenants) as Array<[keyof SeedManifest['tenants'], SeedManifest['tenants'][keyof SeedManifest['tenants']]]>) {
      const headers = { 'x-preview-tenant': SEED_SUBDOMAINS[key] }
      const offering = key === 'restaurant'
        ? `/locations/${tenant.locations.brooklyn!.slug}/menu/${tenant.products.margherita!.slug}`
        : key === 'experience' ? `/experiences/${tenant.products['wheel-class']!.slug}` : '/services/family'
      // A guest's own browser: the suite's desktop Chrome profile, not a headless agent the site filters out.
      const context = await browser.newContext({ ...devices['Desktop Chrome'], baseURL, extraHTTPHeaders: headers })
      try {
        const page = await context.newPage()
        for (const path of ['/', offering]) {
          const response = await page.goto(path, { waitUntil: 'networkidle' })
          if (response?.status() !== 200) throw new Error(`Visiting ${tenant.name} ${path} answered ${response?.status()}`)
        }
        // The guest then starts what the business offers: a table, a class, a consultation.
        const intent = key === 'restaurant'
          ? { event_name: 'checkout_start', location_id: tenant.locations.brooklyn!.id }
          : key === 'experience'
            ? { event_name: 'checkout_start', product_id: tenant.products['wheel-class']!.id, location_id: tenant.locations['ao-nang']!.id }
            : { event_name: 'consultation_cta_click', stage: 'schedule_navigation', page_path: '/services/family' }
        const started = await context.request.post('/api/public/conversion-events', { data: { ...intent, event_id: crypto.randomUUID() } })
        if (started.status() !== 201) throw new Error(`Recording ${tenant.name}'s ${intent.event_name} answered ${started.status()} ${await started.text()}`)
        const sent = await context.request.post('/api/public/contact', {
          data: { name: 'Seed Guest', email: `seed-guest+${key}@playwright.example`, message: `A question for ${tenant.name} about visiting.`, consent: true },
        })
        if (sent.status() !== 201) throw new Error(`The ${tenant.name} contact form answered ${sent.status()} ${await sent.text()}`)
        // Two guests book the studio's wheel class.
        if (key === 'experience') {
          const slug = tenant.products['wheel-class']!.slug
          const listed = await context.request.get(`/api/public/products/${slug}/sessions`)
          if (listed.status() !== 200) throw new Error(`${tenant.name}'s class times answered ${listed.status()} ${await listed.text()}`)
          const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
          const open = (await listed.json() as { sessions: Array<{ id: string; is_full: boolean; starts_at: string }> }).sessions
            .filter(session => !session.is_full && session.starts_at > tomorrow)
          if (open.length < 2) throw new Error(`${tenant.name} has fewer than two bookable class times`)
          for (const [index, session] of open.slice(0, 2).entries()) {
            const booked = await context.request.post(`/api/public/products/${slug}/book`, {
              data: { session_id: session.id, guest_name: `Seed Guest ${index + 1}`, guest_email: `seed-booking-${index + 1}@playwright.example`, party_size: 1, idempotency_key: crypto.randomUUID() },
            })
            if (booked.status() !== 201) throw new Error(`Booking ${tenant.name}'s class answered ${booked.status()} ${await booked.text()}`)
          }
        }
      } finally { await context.close() }
    }
  } finally { await browser.close() }
}
