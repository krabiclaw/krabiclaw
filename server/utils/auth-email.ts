import { renderNotificationEmail, type RenderedNotificationEmail } from '~/server/emails/render'
import { sendEmail, hashEmail } from '~/server/utils/email-delivery'
import { resetPasswordMessage, signInCodeMessage, verifyEmailMessage } from '~/server/notifications/guest-events'

export interface AuthEmailEnv {
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  EMAIL_DELIVERY_MODE?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
}

function platformDomain(env: AuthEmailEnv): string {
  const configured = env.NUXT_PUBLIC_PLATFORM_DOMAIN?.trim()
  if (!configured) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required')
  return configured
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
}

async function sendAuthEmail(
  env: AuthEmailEnv,
  opts: RenderedNotificationEmail & {
    to: string
    subject: string
  },
) {
  const result = await sendEmail(env, opts)
  if (result.status !== 'sent') {
    throw new Error(`Auth email ${result.status}: ${result.error}`)
  }
  console.info(result.messageId?.startsWith('log-only:') ? 'auth_email_log_only' : 'auth_email_provider_accepted', {
    recipientHash: hashEmail(opts.to),
    subject: opts.subject,
    providerMessageId: result.messageId,
  })
}

export async function sendPasswordResetEmail(
  env: AuthEmailEnv,
  opts: { email: string, resetUrl: string },
) {
  const currentPlatformDomain = platformDomain(env)
  const email = await renderNotificationEmail(resetPasswordMessage({ resetUrl: opts.resetUrl }), { platformDomain: currentPlatformDomain })

  await sendAuthEmail(env, {
    to: opts.email,
    subject: 'Reset your KrabiClaw password',
    ...email,
  })
}

export async function sendVerificationEmail(
  env: AuthEmailEnv,
  opts: { email: string, verificationUrl: string },
) {
  const currentPlatformDomain = platformDomain(env)
  const email = await renderNotificationEmail(verifyEmailMessage({ verificationUrl: opts.verificationUrl }), { platformDomain: currentPlatformDomain })

  await sendAuthEmail(env, {
    to: opts.email,
    subject: 'Verify your KrabiClaw email',
    ...email,
  })
}

export async function sendSignInCodeEmail(
  env: AuthEmailEnv,
  opts: { email: string, code: string },
) {
  const email = await renderNotificationEmail(signInCodeMessage({ code: opts.code }), { platformDomain: platformDomain(env) })

  await sendAuthEmail(env, {
    to: opts.email,
    // The subject is logged with every send, so the code stays out of it.
    subject: 'Your KrabiClaw sign-in code',
    ...email,
  })
}
