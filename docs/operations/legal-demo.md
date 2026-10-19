# Cedar Legal Demo

**Cedar Legal** is a legal services demo organization on KrabiClaw demonstrating
and smoke-testing the legal practice vertical (the Blawby template, modeled on
authentic legal practice standards). It lives at:
- `https://cedar-legal.krabiclaw.com` (with redirect from `cedar-legal-demo.krabiclaw.com`)

It is registered as a demo organization in `shared/demo.ts` under subdomain
`cedar-legal-demo` with production ID `5WebMejsoVLyZLHC29wHH5GbQx1jlvCd`. Only
platform admins manage its site settings and domains.

## Domain Boundaries & Canonical MCP Management

Per `AGENTS.md`, the `service` vertical is specifically and canonically **Legal Services**:
- Offerings are **Practice Areas & Consultations**;
- Practitioners and operators are **Attorneys / Legal Team**;
- Counterparties and prospective clients are **Clients**;
- The booking flow is a **Legal Consultation Request** (`CONSULTATION`);
- Physical and remote contact points are **Offices** / **Practice Locations**.

No ad-hoc provisioning scripts bypass the application boundary. All demo sites,
content updates, branding, and practice setups are managed using KrabiClaw's
canonical MCP tools (`/api/mcp`), ensuring real client-facing MCP tools and
contracts are exercised and verified.

## Primary Office & Offerings

- **Office**: Downtown Raleigh Office (`loc-abce1341-c462-4e8d-ab8c-f4f6657f07cf`),
  420 Fayetteville St, Suite 1100, Raleigh, NC 27601.
- **Operating Hours**: Monday through Friday, 8:30 AM to 5:30 PM (Google Places-compatible periods).
- **Initial Consultation**: 45-minute confidential intake booking slot.
- **Practice Areas**:
  1. Business Formation & Corporate Counsel (`business-counsel`)
  2. Estate Planning, Wills & Trusts (`estate-planning`)
  3. Employment & Labor Advisory (`employment-law`)
  4. Real Estate & Commercial Transactions (`real-estate`)
  5. Civil Litigation & Dispute Resolution (`civil-litigation`)

## Canonical Legal Pages

The demo site renders 5 canonical legal routes configured via `update_site_page`:
- `/`: Firm overview, feature grid ("Why Clients Choose Cedar Legal"), practice area cards, partner roster, testimonials, and consultation CTA.
- `/about`: Firm philosophy, trial and deal record stats, and attorney bios.
- `/services`: Practice area catalog and consultation booking links.
- `/contact`: Office location grid with interactive details, hours, and intake contact form.
- `/schedule`: Consultation request flow with conflict-check instructions, privilege callout, and intake slot booking.

## Verifying and Running MCP Dry Run

Run the MCP dry run against the live MCP server:

```bash
MCP_CREDENTIAL_LOGIN=1 MCP_BASE_URL=https://krabiclaw.com node --env-file=.env scripts/check-mcp-legal-demo.mjs
```

## Customer Documentation

The verified end-to-end flow is published on KrabiClaw's customer documentation:
- Live article: `https://krabiclaw.com/docs/how-to-set-up-a-lawyer-website-using-chatgpt-claude-and-mcp`
- Publisher script: `scripts/publish-lawyer-setup-doc-mcp.mjs`
