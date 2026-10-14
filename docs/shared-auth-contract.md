# Shared authentication contract: Krabiclaw identity for the Bookyboo native app

Status: **proposed; D1, D2, D4, D6, D9 agreed by the owner on 2026-10-14; D3, D5, D7, D8, D10 open.** Deliverable for krabiclaw#1370 under krabiclaw#1357 and bookyboo#11. Nothing in this document is implemented.

Revisions inspected: Krabiclaw `staging` @ `1e1c24d`; Bookyboo `main` @ `fc3841d`. Installed Better Auth: Krabiclaw `1.7.5` (type-only patch in `patches/better-auth-npm-1.7.5.patch`), Bookyboo `1.7.2`. Provider docs read on 2026-10-14: Better Auth [Apple](https://better-auth.com/docs/authentication/apple), [Bearer](https://better-auth.com/docs/plugins/bearer), [Session management](https://better-auth.com/docs/concepts/session-management), [Organization](https://better-auth.com/docs/plugins/organization), [Admin](https://better-auth.com/docs/plugins/admin), [API Key](https://better-auth.com/docs/plugins/api-key).

Each statement below is marked **[verified]** (read in source or docs) or **[proposed]** (a design choice for review). Items marked **[decision]** need the owner's answer before krabiclaw#1371 or bookyboo#13 start.

## 1. Boundary

| Concern | Authority after this phase |
|---|---|
| Users, Apple credentials, sessions, profile, account deletion | Krabiclaw Better Auth (`server/utils/auth.ts`) |
| Organizations, membership, roles, invitations, impersonation | Krabiclaw organization + admin plugins |
| Homes, stays, calendar, Channex, guest/team messaging, schedules, device tokens, property assignments, team-thread participation | Bookyboo Worker + D1, unchanged |
| Authorization of a lodging request | Bookyboo, by asking Krabiclaw for the caller's current session and membership on every request |

Bookyboo stops running Better Auth. Its `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` and `rate_limit` tables, `src/lib/auth/*`, `src/api/v1/auth`, `src/api/v1/dev` and `workspace_invites` are deleted at the development switch (bookyboo#13). Bookyboo keeps plain-text `user_id` / `organization_id` columns holding Krabiclaw IDs with no foreign keys and no local membership or session rows.

## 2. Current facts the contract builds on

### Krabiclaw [verified]

- Sessions: `getAuthSession(event, env)` → `auth.api.getSession` (`server/utils/auth.ts:896`). `bearer()` registered with no options (`:535`), so `Authorization: Bearer <session token>` is accepted everywhere `getAuthSession` is used; `set-auth-token` is emitted on sign-in by the plugin. `cookieCache` 5 min (`:354-361`) applies to cookie callers only; a bearer caller sends no `session_data` cookie and reads the DB. Session defaults: `expiresIn` 7 d, `updateAge` 1 d, `freshAge` 1 d.
- Membership is never cached: `resolveMembership` (`server/utils/member-access.ts:205`) reads the `member` row per request. Roles `owner` / `admin` / `member` with statements in `utils/organization-access.ts:4-127`; `isOrganizationWideRole` = owner or admin (`member-access.ts:99`).
- Active organization is resolved from the explicit `org` query param first; `session.activeOrganizationId` is a last resort (`server/utils/dashboard-context.ts:143-178`).
- Organization requires `name`, `slug`, `default_currency`, `timezone` (`auth.ts:75-94`; CHECKs `server/db/schema.ts:1395-1396`). Creating through `POST /api/auth/organization/create` yields a pending, siteless org with `vertical='restaurant'` default, no domain, no Stripe customer (`schema.ts:1356-1369`; `auth.ts:412-416`).
- No Apple provider, no idToken use, no native/mobile code, no `appleid.apple.com` in `trustedOrigins` (`auth.ts:222-246`, `:738-767`). `lastLoginMethod` resolver only knows `/callback/google` and email paths (`shared/auth/login-method.ts:5-9`).
- `account.accountLinking`: enabled, `trustedProviders: ['google','facebook','instagram','discord']`, `allowDifferentEmails: true` (`auth.ts:768-781`).
- `databaseHooks.session.create.after` runs `linkGuestIdentitiesByVerifiedEmail` on every session creation (`auth.ts:379-389`).
- `user.deleteUser.enabled` with no owned-organization or subscription guard; `member.userId` cascades (`schema.ts:286`). Organization deletion runs the Stripe subscription guard, then `cleanupOrganizationBeforeDelete` (`server/utils/tenant-deletion.ts:42-54`). No outbound cross-service notification exists for user delete, member removal or org delete.
- Admin plugin: `adminRoles: ['admin']`, `impersonationSessionDuration: 3600`, `session.impersonatedBy` column (`auth.ts:637-643`; `schema.ts:1553`).
- Service auth that exists: shared-secret internal routes (`server/utils/internal-secret.ts:38-55`, header `x-krabiclaw-search-secret`, SHA-256 constant-time compare) scoped to search reindex; dev-route secret for E2E only; `jwt` plugin JWKS at `/api/auth/jwks` with no membership claims; OAuth provider tokens for MCP only (`server/utils/mcp-auth.ts:66-99`). No API-key plugin, no service principal.
- Email/password sign-in is enabled with verification (`auth.ts:474-513`); local actor accounts are provisioned via `yarn local:actors` (`docs/local-development.md:142-152`).

### Bookyboo [verified]

- Apple native idToken flow against its own Better Auth (`src/lib/auth/index.ts:26`, `src/api/v1/auth/index.ts:8-19`); iOS stores only the signed bearer token in Keychain (`KeychainStore.swift:5,18`), sends `Authorization: Bearer` + `Origin` on every request, ephemeral URLSession, no cookies (`APIClient.swift:9-10,188-190`).
- Active org read from `session.activeOrganizationId` only (`src/middleware/tenancy.ts:7-12`); the live socket also requires `x-organization-id` (`src/api/v1/live/index.ts`).
- Membership checked per request from the local `member` table (`tenancy.ts:9`; DO `fetch`/`publish` `src/realtime/foreground-events.ts:21-63`; `src/modules/airbnb/service.ts:26-27`). The DO stores the raw `Authorization` header in the socket attachment and re-validates on every publish (`:46-63`).
- Push recipients = `device_tokens` ⋈ live `session` ⋈ `member` (`src/db/notification-repository.ts:41-52`); guest-message pushes go to owner/admin only (`webhook.ts:62`).
- Identity writers: `/sign-in/social`, Better Auth passthrough used by iOS for `organization/create`, `organization/set-active`, `organization/remove-member`, `sign-out`, `revoke-other-sessions`, `delete-user`, `admin/impersonate-user`, `admin/stop-impersonating`, `list-accounts`, `admin/list-users`; `PUT /api/v1/me` (name + JPEG data-URL image); `workspace_invites` link invites accepted via `auth.api.addMember` (`src/api/v1/team/invites.ts:16-43`); `POST /api/v1/dev/sign-in` (`DEV_SIGN_IN=enabled` on localhost, `@bookyboo.test`); `beforeAccountDeletion` deleting owned workspaces including Channex groups/properties (`src/lib/auth/delete-account.ts:13-51`, `delete-workspace.ts:9-55`). Standalone org deletion is disabled.
- 15 foreign keys from Bookyboo tables to `user` / `session` / `organization` (`src/db/schema.ts:16-231`), mostly `ON DELETE CASCADE`; `device_tokens.session_id` cascade is how sign-out unregisters devices; `airbnb_connections.authorization_user_id` is cleared by hand.
- Roles: owner, admin (co-host), member (cleaner). Only owner may invite/promote admin (`src/lib/auth/index.ts:57-113`). Members see assigned homes only (`property_assignments`, `src/api/v1/turnovers/index.ts:18-30`).
- Background work (cron feed, queue consumer, webhook, scheduler DO alarms) runs with no user principal, scoped by `organization_id` only.

## 3. Operation map

Principal column: **U** = the end user's Krabiclaw bearer session; **S** = Bookyboo service credential (section 6); **—** = none.

| Native action | Owner | Endpoint (Krabiclaw unless noted) | Principal | Org scope | Notes |
|---|---|---|---|---|---|
| Sign in with Apple (fresh or repeat) | Krabiclaw | `POST /api/auth/sign-in/social` `{provider:"apple", idToken:{token, nonce}}` | — | n/a | Response header `set-auth-token` is the session bearer. **[verified]** mechanism; **[proposed]** config in §4. |
| Existing Krabiclaw account entry | Krabiclaw | `POST /api/auth/sign-in/email` | — | n/a | Native email+password form (already enabled in Krabiclaw). **[decision D3]** |
| Link Apple to existing account | Krabiclaw | `POST /api/auth/link-social` with Apple `idToken` | U | n/a | Verify `link-social` accepts `idToken` in installed 1.7.5 before relying on it; otherwise use the web `linkSocial` redirect flow in an `ASWebAuthenticationSession`. **[verify]** |
| Restore session on launch | Krabiclaw via Bookyboo | any Bookyboo request | U | header | Bookyboo validates (§5); 401 → sign-in. |
| Session renewal | Krabiclaw | implicit (`updateAge`) | U | n/a | Token does not rotate; expiry extends on use. iOS stores any `set-auth-token` it receives. |
| Logout | Krabiclaw + Bookyboo | Bookyboo `DELETE /api/v1/devices` then Krabiclaw `POST /api/auth/sign-out` | U | n/a | Order preserved from today. |
| Revoke other sessions / list sessions | Krabiclaw | `POST /api/auth/revoke-other-sessions`, `GET /api/auth/list-sessions` | U | n/a | |
| Profile read | Krabiclaw | `GET /api/auth/get-session` | U | n/a | `user.name`, `email`, `image`, `role`; `session.impersonatedBy`. |
| Profile edit (name) | Krabiclaw | `POST /api/auth/update-user` | U | n/a | |
| Profile photo | Krabiclaw | Krabiclaw media path (Cloudflare Images) | U | n/a | Bookyboo's JPEG data-URL image is dropped. **[decision D7]** |
| List my organizations with role | Krabiclaw | `GET /api/auth/organization/list` + `GET /api/auth/organization/get-full-organization?organizationId=` | U | explicit | Or one new read, §6. |
| Create organization | Krabiclaw | `POST /api/auth/organization/create` `{name, slug, default_currency, timezone}` | U | n/a | `default_currency` and `timezone` must be collected natively. Result is pending/siteless; no website, Stripe or purchase step. Vertical: **[decision D5]** |
| Select organization | Bookyboo | header `x-organization-id: <orgId>` on every lodging request | U | explicit | Bookyboo no longer reads `activeOrganizationId`. Native may also call `organization/set-active` so the Krabiclaw dashboard agrees, but Bookyboo never trusts it. **[decision D1]** |
| Invite a member (link) | Krabiclaw | new: `POST /api/organizations/:id/invite-links` → `{url}`; `POST /api/invite-links/:token/accept` (server calls `auth.api.addMember`) | U | explicit | Replaces Bookyboo `workspace_invites`. Needed because Better Auth email invitations cannot target an Apple private-relay address the inviter does not know. **[decision D4]** |
| Change role / remove member | Krabiclaw | `POST /api/auth/organization/update-member-role`, `/remove-member` | U | explicit | Permission from `organization-access.ts` (admin may invite/update admin; Bookyboo's owner-only rule is dropped unless D4 says otherwise). |
| Assign homes to a member; team threads | Bookyboo | existing `/api/v1/team/*` | U | explicit | Application rules layered on current membership; participants validated against Krabiclaw membership at write time. |
| Lodging reads/writes | Bookyboo | `/api/v1/properties`, `/channex`, `/messages`, `/turnovers`, `/live` | U | explicit | §5. |
| Push registration | Bookyboo | `POST/DELETE /api/v1/devices` | U | n/a | Row stores Krabiclaw `user_id`, `session_id`, token. |
| Push delivery, scheduled sends, webhook fan-out | Bookyboo | internal, reads Krabiclaw membership via **S** | S | explicit | §6, §7. |
| Support impersonation | Krabiclaw | `POST /api/auth/admin/impersonate-user`, `/stop-impersonating` | U (platform admin) | n/a | Bookyboo surfaces `impersonatedBy` and keeps its 403 restrictions on identity mutations. Duration becomes Krabiclaw's 3600 s unless changed. **[decision D8]** |
| Delete account | Krabiclaw | `POST /api/auth/delete-user` | U | n/a | Krabiclaw `user.delete.before` must (a) revoke the Apple grant, (b) call Bookyboo cleanup via **S**, fail-closed. **[decision D6]** |
| Delete organization | Krabiclaw | `authClient.organization.delete` | U (owner) | explicit | `beforeDeleteOrganization` calls Bookyboo cleanup via **S** (Channex group/properties, R2, local rows), fail-closed. **[decision D6]** |
| Disconnect lodging (Airbnb) | Bookyboo | existing `POST /api/v1/airbnb/connection/disconnect` | U | explicit | Distinct from account/org deletion; unchanged. |
| Developer sign-in (Debug) | Krabiclaw | `POST /api/auth/sign-in/email` with local actor accounts | — | n/a | Replaces `DEV_SIGN_IN` route and `@bookyboo.test`. **[decision D9]** |

## 4. Krabiclaw changes (krabiclaw#1371) [proposed]

1. `socialProviders.apple`: `{ clientId: <web Service ID or bundle id>, clientSecret: <generated ES256>, appBundleIdentifier: 'com.bookyboo.app' }`; `audience`/`clientId` as an array if a web Apple login is added later. Add `https://appleid.apple.com` to `trustedOrigins` only if the web form-post flow is enabled. Env: `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_APP_BUNDLE_ID` in `CloudflareEnv` and `.env.example`. These are also required for token revocation on delete.
2. Extend `loginMethodForPath` for `/sign-in/social` with provider `apple`.
3. Decide `trustedProviders` membership for `apple` (D3). Apple emits email only on first authorization; Krabiclaw must persist it at `user.create` and must not depend on later tokens.
4. New endpoints, server-side only, reusing `getAuthSession` and `resolveOrganizationMembership`:
   - `GET /api/lodging/principal?organizationId=` (principal **U**): returns `{ user:{id,name,email,image}, session:{id,expiresAt,impersonatedBy}, organization:{id,slug,name,default_currency,timezone}, member:{id,role} }`. Errors: 401 no/invalid session; 400 `organizationId` missing; 403 not a member; 404 unknown org. One round trip replaces Bookyboo's `getSession` + `member` read.
   - `POST /api/internal/lodging/members` (principal **S**): body `{organizationId, userIds?}` → `[{userId, memberId, role, sessionIds:[…live ids]}]`. Used only for push/background recipient filtering and socket re-validation. Returns facts, grants nothing.
   - `POST /api/organizations/:id/invite-links` and `POST /api/invite-links/:token/accept` (D4).
5. Lifecycle hooks: `user.delete.before` → Apple token revocation + `DELETE <LODGING_API_URL>/internal/users/:id` (S); `organizationHooks.beforeDeleteOrganization` → `DELETE <LODGING_API_URL>/internal/organizations/:id` (S); `afterRemoveMember` / `afterUpdateMemberRole` → `POST <LODGING_API_URL>/internal/membership-changed` (S) so Bookyboo closes sockets and drops assignments immediately. All fail-closed; a Bookyboo 5xx aborts the Krabiclaw operation and surfaces the error (AGENTS "Failure reporting").
6. Optional: `vertical` value for lodging (D5).
7. No schema change for Apple itself (uses `account` rows). Invite links and the lodging-hook configuration need `LODGING_API_URL` + `LODGING_SERVICE_SECRET` env; invite links need a small table or reuse of `invitation` with a token column — resolve in #1371 against the installed plugin.

## 5. Bookyboo authorization boundary (bookyboo#13) [proposed]

- Middleware chain becomes `authenticate` → `authorizeOrganization` → (`requireManager`): one call to `GET /api/lodging/principal?organizationId=<x-organization-id>` forwarding the caller's `Authorization` header verbatim. Allowed Krabiclaw origin is the configured `KRABICLAW_API_URL` for the environment only; redirects are not followed.
- Freshness: **no caching** in Bookyboo; every HTTP request validates. Sockets: validate on upgrade and on every `publish` (today's semantics) using the stored bearer; additionally close on `membership-changed` (§4.5).
- Error mapping (unchanged codes where they exist today):
  - Krabiclaw 401 → 401 `UNAUTHORIZED` (iOS clears Keychain).
  - Header missing → 409 `WORKSPACE_REQUIRED` (iOS reloads profile and picks an org).
  - Krabiclaw 403/404 → 403 `WORKSPACE_ACCESS_CHANGED` (iOS account-owned recovery).
  - Role not owner/admin → 403 `WORKSPACE_ROLE_REQUIRED`.
  - Krabiclaw unreachable, timeout, 5xx, or malformed body → 503 `IDENTITY_UNAVAILABLE` with `details.upstreamStatus`. Never served from stale data; never falls back to a local table.
- Role mapping: Krabiclaw `owner`/`admin` → Bookyboo manager; `member` → assigned-homes only. Financial/pricing surfaces stay manager-only; nothing is inferred from property assignment.
- Schema: drop all Better Auth tables and FKs; keep `user_id`/`organization_id` text columns. Replace cascades with explicit cleanup endpoints (§4.5) called by Krabiclaw: `/internal/users/:id`, `/internal/organizations/:id`, `/internal/membership-changed`, authenticated by `LODGING_SERVICE_SECRET` (constant-time compare, same pattern as Krabiclaw `internal-secret.ts`).
- Delete identity writers: `src/lib/auth/*`, `src/api/v1/auth`, `src/api/v1/dev`, `PUT /api/v1/me` image path, `workspace_invites` + `/api/v1/invites`, `/api/v1/team/invites`; iOS passthrough calls move to `KRABICLAW_API_URL`.
- Secrets removed from Bookyboo: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APPLE_BUNDLE_ID`, `APPLE_SIGN_IN_*`, `DEV_SIGN_IN`. Added: `KRABICLAW_API_URL`, `LODGING_SERVICE_SECRET`.
- AGENTS.md rule "Local Better Auth organizations and properties own tenancy" is rewritten: Krabiclaw organizations own tenancy; Bookyboo properties own lodging scope.

## 6. Service credential and background work [proposed]

Bookyboo's scheduled sends, webhook fan-out and push delivery have no user. They need current membership facts without a persisted user bearer.

- Mechanism: shared secret `LODGING_SERVICE_SECRET` sent as `x-krabiclaw-lodging-secret` to `POST /api/internal/lodging/members`. This mirrors Krabiclaw's existing documented internal-route pattern and adds no new plugin. The API Key plugin was considered and rejected for this phase: not installed, keys are user- or org-owned, and it would add a second mechanism for one caller. **[decision D2]**
- Recipient rule at delivery time: a device receives a notification only if its `user_id` is a current member returned by Krabiclaw with the required role, and its `session_id` is in that user's live `sessionIds`. Membership removal → immediate. Session revocation → immediate for delivery decisions; notifications already handed to APNs cannot be recalled (recorded limitation).
- Fail-closed: if Krabiclaw is unavailable, delivery is deferred and the scheduled message enters the existing `needs_review`/retry path with a visible failure; no send proceeds on stale data.

## 7. Invalidation bounds

| Event | HTTP | Open socket | Push | Scheduled sends |
|---|---|---|---|---|
| Logout | next request (401) | closed by client; server re-validation on next publish | device row deleted before sign-out | unaffected (organization automation) |
| Session revoked elsewhere | next request | next publish or ≤ 1 event | next delivery (§6) | unaffected |
| Member removed / role changed | next request | immediate via `membership-changed`, else next publish | next delivery | unaffected; removed user no longer receives |
| Org switch in app | immediate (explicit header) | client reconnects with new header | payload carries `organizationId`; client filters | n/a |
| Account deleted | 401 | closed | rows removed by `/internal/users/:id` | user's team photos removed; org automation continues |
| Org deleted | 403 | closed | rows removed | cancelled with the org |

## 8. Native states to preserve (bookyboo#14)

Apple button and system sheet; nonce generation; loading/cancel/retry; restoration on relaunch; sign-out order (unregister devices → sign-out → clear Keychain); 401/409/403 recovery paths and late-response guards; push-payload recipient/org filtering; impersonation bar and in-memory impersonated token. Change only: base URLs (identity vs lodging), the org header, org-creation fields (currency, timezone), the existing-account entry screen, invite-link acceptance target, profile photo path.

## 9. Verification scenarios (bookyboo#15 matrix inputs)

Fresh Apple sign-in; repeat sign-in (no email claim); private-relay user; existing email/password Krabiclaw user linking Apple; org create with currency/timezone; invite-link accept; owner/admin/member access on lodging routes; wrong org header; removed member mid-session (HTTP, socket, push); revoked session; Krabiclaw outage (expect 503 `IDENTITY_UNAVAILABLE`, no stale access); account delete (Apple grant revoked, Bookyboo rows removed, Channex cleanup); org delete; impersonation enter/leave; scheduled message delivery while creator logged out; Krabiclaw web login, MCP and billing regression.

## 10. Decisions required [decision]

- **D1 Organization scope.** **Agreed 2026-10-14:** explicit `x-organization-id` header on every lodging request; `session.activeOrganizationId` is never trusted by the lodging service. (Header and env names are brand-neutral because the native app is being rebranded to Krabiclaw in a separate PR; the socket's existing `x-bookyboo-workspace` header is renamed with it.)
- **D2 Service credential.** **Agreed 2026-10-14:** shared-secret internal routes (existing pattern); no API Key plugin.
- **D3 Existing-account entry and linking.** Native email+password form for existing Krabiclaw users (recommended; already enabled) vs. web sheet for Google. Whether `apple` joins `trustedProviders` (auto-link by matching email). Recommended: **not** trusted; link only explicitly from a signed-in session.
- **D4 Invitations.** **Agreed 2026-10-14:** Krabiclaw-owned invite links, and Krabiclaw's permission model applies unchanged (an admin may invite or promote an admin; Bookyboo's owner-only rule is dropped). Alternatives considered: vs. Better Auth email invitations (breaks for private relay) vs. keeping Bookyboo `workspace_invites` with a service-side `addMember` call (keeps a second membership writer). Also: keep Bookyboo's owner-only admin invites, or adopt Krabiclaw's admin-may-invite-admin.
- **D5 Vertical.** Add a `lodging` vertical in Krabiclaw (schema CHECK may require the D1 replacement procedure) vs. accept default `restaurant` with an org metadata marker.
- **D6 Deletion semantics.** Krabiclaw `deleteUser` has no owned-org guard. Options: (a) add a guard requiring ownership transfer or org deletion first; (b) keep Bookyboo's rule (delete every owned org on account deletion) implemented as a Krabiclaw `user.delete.before` step; (c) allow owner-less orgs. **Agreed 2026-10-14:** Krabiclaw adds the owned-organization guard (a) and Apple token revocation in `user.delete.before`; Bookyboo's native deletion screen explains the prerequisite.
- **D7 Profile photo.** Krabiclaw media (recommended) vs. dropping native photo edit this phase.
- **D8 Support impersonation.** Which Krabiclaw accounts hold the platform `admin` role for Bookyboo support; keep 3600 s or configure 900 s.
- **D9 Local development identity.** **Agreed 2026-10-14:** Debug builds authenticate against Krabiclaw **staging** with local actor accounts (`POST /api/auth/sign-in/email`); the `-local-api` flag switches only the lodging URL. `DEV_SIGN_IN` and `@bookyboo.test` are deleted.
- **D10 Development data.** Inventory dev D1, Channex staging group/properties and Apple configuration before the switch; choose retain vs. reset explicitly. Not authorized by this document.

## 11. Review gate (from krabiclaw#1370)

- [ ] Fresh Apple account and existing Krabiclaw account both reach the intended identity and organization without duplicates or forced website onboarding (§3, D3).
- [ ] Every affected account action and local identity reference has an owner and adaptation (§3, §5).
- [ ] Revocation, background authorization and cleanup specified with credential/storage boundaries and failure outcomes (§6, §7).
- [ ] Native states and verification scenarios recorded (§8, §9).
- [ ] Both implementations cite this document's accepted revision.
