import { defineHandler } from 'nitro'
import { getCookie, getQuery, sendRedirect } from 'nitro/h3'

export default defineHandler((event) => {
  const query = getQuery(event)
  if (typeof query.error === 'string' && query.error) {
    return sendRedirect(event, `krabiclaw://auth-callback?error=${encodeURIComponent(query.error)}`, 302)
  }
  const sessionToken = getCookie(event, 'better-auth.session_token')
  if (!sessionToken) {
    return sendRedirect(event, 'krabiclaw://auth-callback?error=session_not_found', 302)
  }
  return sendRedirect(event, `krabiclaw://auth-callback?token=${encodeURIComponent(sessionToken)}`, 302)
})
