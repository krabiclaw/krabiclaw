export interface ReplyDomainEnv {
  EMAIL_REPLY_DOMAIN?: string
}

export function getReplyDomain(env: ReplyDomainEnv): string {
  const domain = env.EMAIL_REPLY_DOMAIN?.trim().toLowerCase()
  if (!domain) throw new Error('EMAIL_REPLY_DOMAIN is required')
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) {
    throw new Error('EMAIL_REPLY_DOMAIN must be a DNS hostname')
  }
  return domain
}
