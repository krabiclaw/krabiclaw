// Invite-link tokens are random, shown once, and stored only as their SHA-256.

export const INVITE_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
export const INVITE_LINK_ROLES = ['admin', 'member'] as const

export function newInviteLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function inviteLinkTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
