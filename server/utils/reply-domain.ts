interface ReplyDomainEnv {
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
}

export function getReplyDomain(env: ReplyDomainEnv): string {
  const rawPlatformDomain = env.NUXT_PUBLIC_PLATFORM_DOMAIN?.trim()
  if (!rawPlatformDomain) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required')
  // This hostname becomes the reply-to address on outgoing mail, so a configured
  // domain that will not parse is a misconfiguration to report, not something to
  // approximate by stripping whatever looked like a port.
  const platformDomainUrl = new URL(/^https?:\/\//i.test(rawPlatformDomain) ? rawPlatformDomain : `https://${rawPlatformDomain}`)
  let platformDomain = platformDomainUrl.hostname

  if (!platformDomain) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is invalid')

  if (platformDomain === 'localhost' || platformDomain === '127.0.0.1' || platformDomain === '[::1]') {
    platformDomain = 'krabiclaw.local'
  }

  return `reply.${platformDomain}`
}
