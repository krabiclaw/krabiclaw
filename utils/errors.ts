export function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const data = (error as Record<string, unknown>).data
    if (data && typeof data === 'object') {
      const dataError = (data as Record<string, unknown>).error
      if (typeof dataError === 'string' && dataError) return dataError
      const dataMessage = (data as Record<string, unknown>).message
      if (typeof dataMessage === 'string' && dataMessage) return dataMessage
    }
    const errorMessage = (error as Record<string, unknown>).message
    if (typeof errorMessage === 'string' && errorMessage) return errorMessage
  }
  return fallback
}

/** Better Auth owns these codes; state_mismatch includes expiry and verification failures. */
export function oauthErrorMessage(code: unknown, description?: unknown): string {
  if (typeof code !== 'string' || !code) return ''
  let message: string
  switch (code) {
    case 'state_mismatch':
    case 'state_security_mismatch':
    case 'state_not_found':
      message = 'The connection request expired or could not be verified. Start again in the same browser.'
      break
    case 'access_denied':
      message = 'Authorization was cancelled or denied. Start again and approve the requested access.'
      break
    case 'account_already_linked_to_different_user':
      message = 'This provider account is already linked to another KrabiClaw user. Choose a different account or sign in as the user who linked it.'
      break
    case 'unable_to_get_user_info':
      message = 'The provider could not return your account information. Start again; if it still fails, check your provider account access.'
      break
    default:
      message = 'The provider connection failed. Start again.'
  }
  return `${message} (${code})${typeof description === 'string' && description ? ` ${description}` : ''}`
}

/**
 * Whether the thing being edited is absent, as opposed to a request that
 * failed.
 *
 * The two need different answers. A record that is not there is not a page, and
 * `DESIGN.md` says an unsupported route 404s rather than rendering something in
 * its place. A request that failed is a state the surface shows, because the
 * record may well still exist. Rendering "not found" inside the pane for both
 * made a deleted record look like a broken editor.
 */
export function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { statusCode?: unknown, status?: unknown }
  return candidate.statusCode === 404 || candidate.status === 404
}

/**
 * Answers the canonical not-found for a record that is absent.
 *
 * Every level of an editor chain decides whether its record exists by looking
 * into the loaded page, so the answer arrives in a watcher rather than in
 * setup. A `throw` there only reaches Nuxt during the server render: on a
 * client navigation Vue reports it and keeps rendering whatever was underneath,
 * which is how a missing section came to paint itself as a divider. `showError`
 * is what reaches the error page on the client, and on the server it only
 * reaches the payload — answering HTTP 200 with the error page drawn after
 * hydration. Each environment is given the one that answers.
 *
 * It returns the error it raised, so page setup — where nothing after a 404
 * should run — can `throw showNotFound()`: the error page is already up by then.
 */
export function showNotFound(statusMessage = 'Page not found'): ReturnType<typeof showError> {
  const error = createError({ statusCode: 404, statusMessage })
  if (import.meta.server) throw error
  return showError(error)
}
