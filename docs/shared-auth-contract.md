# Native app contract: KrabiClaw identity and lodging for the KrabiClaw iOS app

The KrabiClaw iOS app (bundle id `com.krabiclaw.app`, source in the bookyboo repository) talks to KrabiClaw and nothing else. KrabiClaw owns identity, organizations, membership and every piece of lodging data: homes, stays, nights, Channex/Airbnb, guest and team messaging, scheduled messages, device tokens and home assignments. The separate lodging Worker that held lodging data until #1381 is retired; KrabiClaw makes no call to it and exposes no route for it.

Decisions D3–D9 were recorded by the owner on 2026-10-14 (krabiclaw#1370); D1, D2 and D10 governed the lodging Worker and ended with it.

## 1. Boundary

| Concern | Authority |
|---|---|
| Users, Apple credentials, sessions, profile, account deletion | KrabiClaw Better Auth (`server/utils/auth.ts`) |
| Organizations, membership, roles, invite links, impersonation | KrabiClaw organization + admin plugins; `organization_invite_links` |
| Homes, stays, nights, Channex/Airbnb, guest and team messaging, scheduled messages, device tokens, home assignments | KrabiClaw D1 through its domain modules (`server/domain/stays.ts`, `server/domain/team-messages.ts`, `server/integrations/channex/*`, …) |

## 2. Authentication

- The app authenticates with a Better Auth bearer session only: `Authorization: Bearer <token>`, no cookies, no `Origin`, ephemeral `URLSession`. The `bearer()` plugin maps the header onto the session; a bearer caller sends no `session_data` cookie, so every request reads the session from D1 and revocation is immediate. `set-auth-token` on a response is the same token with a later expiry; the app stores whatever it receives.
- Membership is never cached: `resolveMembership` reads the `member` row on every request.
- Dashboard routes name their organization explicitly with the `org` query parameter (the organization slug); `session.activeOrganizationId` is a last resort the app does not rely on. The live socket is `GET /api/dashboard/guest-inbox/socket?org=<slug>` and re-reads the session and membership for every event it carries, so a revoked session or removed member is closed at the next event.

## 3. Operation map

| Native action | Endpoint | Notes |
|---|---|---|
| Sign in with Apple | `POST /api/auth/sign-in/social` `{provider:"apple", idToken:{token, nonce}}` | `set-auth-token` is the bearer. |
| Existing account entry (and Debug builds) | `POST /api/auth/sign-in/email` | D3, D9. |
| Link Apple to an existing account | `POST /api/auth/link-social` `{provider:"apple", idToken}` | `apple` stays out of `trustedProviders` (D3). |
| Profile | `GET /api/auth/get-session`, `POST /api/auth/update-user`, `POST /api/user/avatar` | D7. |
| Sessions | `POST /api/auth/revoke-other-sessions`, `POST /api/auth/sign-out` | Sign-out order: `DELETE /api/dashboard/devices` → sign-out → clear Keychain. |
| Organizations | `GET /api/auth/organization/list`, `get-active-member-role`, `list-members`, `set-active` | |
| Create organization | `POST /api/auth/organization/create` `{name, slug, default_currency, timezone}`, then `POST /api/organizations` `{organizationId, name, subdomain, vertical:"lodging", sourceLocale}` | The same two calls web onboarding makes; publishes the Saya site on the system subdomain. |
| Invite a member | `POST /api/organizations/:id/invite-links` `{role}` → 201 `{id, token, role, expiresAt}`; `GET /api/organizations/:id/invite-links`; `DELETE /api/organizations/:id/invite-links/:linkId` → 204 | Single use, seven days, only the token's SHA-256 is stored. The app shares `<KrabiClaw origin>/invite/<token>` (D4). |
| Open an invite | Public page `/invite/:token` reads `GET /api/invite-links/:token` → `{organization:{name}, role, expiresAt}` | No session needed; it names nothing about members. 404 `INVITE_LINK_NOT_FOUND` (unknown or withdrawn), 410 `INVITE_LINK_USED` / `INVITE_LINK_EXPIRED`, each with `field: "token"`. The page lets a signed-in person join, offers Google, email sign-in and sign-up first, and offers `krabiclaw://invite?token=` to the app. KrabiClaw serves no `apple-app-site-association`, so the https link opens the page rather than the app. |
| Accept an invite | `POST /api/invite-links/:token/accept` → 200 `{organization:{id, name}, role, memberId}` | 401 `AUTHENTICATION_REQUIRED`, 404/410 as above, 409 `ALREADY_MEMBER`; membership is written only by `auth.api.addMember`. |
| Change role / remove member / leave | `POST /api/auth/organization/update-member-role`, `/remove-member`, `/leave` | Admin may invite or promote an admin (D4). |
| Team | `/api/dashboard/team/members`, `/api/dashboard/team/threads[/:threadId/messages\|/read]`, `PUT /api/dashboard/team/members/:memberId/homes` | A thread seat is a member row and cascades with it. |
| Homes, stays, nights | `/api/dashboard/stay-homes[/:productId]`, `/api/dashboard/stays[/:stayId]` | |
| Guest messaging | `/api/dashboard/guest-threads`, `/api/dashboard/message-templates`, `/api/dashboard/scheduled-guest-messages` | Airbnb conversations through Channex. |
| Airbnb connection | `/api/organizations/:id/integrations/airbnb/*` | Disconnect is separate from account and organization deletion. |
| Push | `POST/DELETE /api/dashboard/devices`, `/api/user/notification-preferences` | A device token belongs to a Better Auth session and cascades with it. |
| Support impersonation | `POST /api/auth/admin/impersonate-user`, `/stop-impersonating` | Platform `admin` only, 900 s (D8). |
| Delete account | `POST /api/auth/delete-user` with `x-apple-authorization-code` when Apple is linked | §4. |
| Delete organization | `POST /api/auth/organization/delete` | Owner only; §4. |

## 4. Deletion and membership changes

Every step fails the operation visibly; nothing is skipped.

- **Organization deletion** (`beforeDeleteOrganization`, after Better Auth Stripe's subscription guard; `cleanupOrganizationBeforeDelete` in `server/utils/tenant-deletion.ts`): Payments servicing links are retained; the Airbnb connection is released in Channex (`AirbnbConnection.deleteForOrganization`: rate-plan mappings removed one at a time and verified, the channel deactivated and deleted, every property in the organization's dedicated group deleted with `force=true`, then the group, each verified gone by a 404); Google Calendar cleanup is staged; custom domains and Cloudflare Images the organization alone holds (home, guest and team message photos) are deleted. Every lodging row — stays, nights, channel mappings and threads, guest threads, scheduled messages, message templates, team threads, seats and messages — cascades with the organization row.
- **Account deletion** (`user.deleteUser.beforeDelete`; `/api/auth/admin/remove-user` is disabled because it bypassed this): sole-owner guard (400 `SOLE_ORGANIZATION_OWNER`); Apple code exchange and immediate revocation (`APPLE_REAUTHENTICATION_REQUIRED`, `APPLE_ACCOUNT_MISMATCH`, `APPLE_CODE_EXCHANGE_FAILED`, `APPLE_NOT_CONFIGURED`, `APPLE_REVOCATION_FAILED`) (D6). Then, in the user delete hook after Stripe buyer customers are removed, the homes the account's members looked after are released. Sessions, device tokens, member rows and their thread seats cascade with the user; team messages the user sent keep their text with the sender set to null.
- **Member removed or left**: the member's homes become unassigned and the change is published to open views; thread seats cascade with the member row. **Role changed to owner or admin**: the member's homes are released, since owners and admins see every home. `releaseUnassignableHomes` reconciles the whole organization, so a failed release is repaired by the next membership change there.

## 5. Decisions

- **D3 Existing-account entry and linking.** Native email+password for existing accounts, then explicit Apple linking. `apple` is not a trusted provider; no email auto-linking.
- **D4 Invitations.** KrabiClaw invite links under KrabiClaw's permission model, because Better Auth email invitations cannot target an Apple private-relay address the inviter does not know.
- **D5 Vertical and site.** `lodging` is in `ALL_VERTICALS` and the Saya template; `vertical` is written only by `provisionOrganization`.
- **D6 Deletion semantics.** Owned-organization guard and Apple token revocation in `user.deleteUser.beforeDelete`, using a fresh authorization code the app sends; Better Auth's Apple provider has no `revokeToken` and the idToken sign-in stores no Apple tokens.
- **D7 Profile photo.** `POST /api/user/avatar`.
- **D8 Support impersonation.** Platform `admin` only, 900 s.
- **D9 Local development identity.** Debug builds sign in to KrabiClaw staging with email and password using the staging development accounts the owner created; agent sessions do not create accounts or enter passwords.
