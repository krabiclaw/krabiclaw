# Products link audit

Audited the actual local Worker in the browser on 2026-10-01 after merging staging. The page has 39 link elements including shared header/footer duplicates. All internal destinations below rendered their intended page; all four section anchors were also checked in the browser E2E test for the target heading being in the viewport.

| Products link | Destination | Result |
| --- | --- | --- |
| Start free / Sign in | `/signup`, `/login` | Existing onboarding flow rendered in the current browser session; no form submitted |
| Build / Manage / Connect / Grow | Products section anchors | Correct heading and viewport |
| Explore website builder | `/templates` | Published template gallery |
| Explore AI management | `/docs/mcp-setup` | Published ChatGPT/MCP setup guide |
| Read the inbox guide | `/docs/handle-inquiries-and-reservation-requests` | Published inquiry/reservation guide |
| Explore bookings | `/experiences` | Published experiences page |
| Read the publishing guide | `/docs/publish-a-post` | Published post guide |
| Manage local business details | `/docs/update-locations-and-hours` | Published locations/hours guide |
| Read the analytics guide | `/docs/read-your-site-analytics` | Published analytics guide |
| Logo / home | `/` | Existing homepage |
| Shared navigation/footer | `/restaurants`, `/legal`, `/pricing`, `/plugin`, `/about`, `/blog`, `/docs`, `/help`, `/policies/privacy`, `/policies/terms`, `/products` | Published destination headings verified |
| Legacy Features | `/features?source=legacy` | Redirects to `/products?source=legacy`; canonical remains `https://krabiclaw.com/products` |
| Instagram | `https://www.instagram.com/krabiclaw/` | KrabiClaw profile title and handle verified |
| Facebook | `https://www.facebook.com/1205835975938850` | Facebook login wall preserving the profile destination; profile identity could not be verified without signing in |

The four misleading section destinations were corrected to the existing published guides above. No speculative `/products/:slug` links or detailed product copy were added. The repository already routes future detail documents through its canonical catch-all and the reusable Products recipe; this change does not publish detail documents. An absent future detail page is therefore absent authored content, rather than a separate missing page component.
