import english from '~/i18n/locales/en'

export const ZARAZ_ANALYTICS_PURPOSE_ID = 'kc_analytics'

// Zaraz owns this cookie: it holds the visitor's answer for every purpose. Its
// presence means the visitor has answered, so the notice runs only when absent.
export const ZARAZ_CONSENT_COOKIE_NAME = 'kc_analytics_consent'

// The one optional tool Zaraz loads is Google Analytics; this purpose is its
// only switch. KrabiClaw's first-party measurement (/api/analytics/track) is
// not a Zaraz tool and does not read this consent.
export const ZARAZ_ANALYTICS_PURPOSE = {
  name: 'Google Analytics',
  description: `${english.legal.analytics_notice} ${english.legal.analytics_notice_link}.`,
}

export const ZARAZ_CONSENT_MODAL_INTRO_HTML = `${english.legal.analytics_notice} <a href="https://krabiclaw.com/policies/privacy">${english.legal.analytics_notice_link}</a>.`

/**
 * The event name the collector sends to Zaraz once the native pageview is accepted. The GA4
 * pageview action fires on a trigger that matches exactly this event and on nothing else, so Google
 * Analytics never records a page view the native record did not accept.
 */
export const NATIVE_PAGEVIEW_ZARAZ_EVENT = 'krabiclaw_native_pageview'
