import { defineComponent, h, type PropType } from 'vue'
import { EHtml, EHead, EBody, EPreview, EContainer, ESection, EText, ELink, EImg, EStyle } from '../vue-email'
import { light, dark, font, layout, type } from '../tokens'
import { platformLocale } from '~/shared/platform-locales'

/**
 * The frame every message renders into.
 *
 * No card. Content runs to the edges of one 600px column and sections divide
 * with hairlines, which is what makes a transactional email read as a page
 * rather than a widget floating on a tinted ground.
 *
 * Dark mode recolours by element, not by class: templates used to forget the
 * class and body copy stayed dark grey on a dark surface at 2.29:1, below the
 * 4.5:1 floor. Matching the element makes a new block correct without anyone
 * remembering anything.
 */
export default defineComponent({
  props: {
    locale: { type: String, default: undefined },
    preheader: { type: String, required: true },
    /** The tenant this is sent for, named in the footer. Null for platform mail. */
    organizationName: { type: String as PropType<string | null>, default: null },
    /** The tenant's logo. A tenant's mail carries its mark, or its name alone. */
    organizationLogoUrl: { type: String as PropType<string | null>, default: null },
    /** Where someone chooses what they receive, rather than switching it all off. */
    preferencesUrl: { type: String as PropType<string | null>, default: null },
    unsubscribeUrl: { type: String as PropType<string | null>, default: null },
    platformDomain: { type: String, required: true },
  },
  setup(props, { slots }) {
    const locale = platformLocale(props.locale ?? 'en')
    if (!locale) throw new Error('Email language is not supported')
    const year = new Date().getFullYear()
    // A domain given with its own scheme keeps it, so a local origin stays
    // reachable over http; a bare domain is https, which is every deployment.
    const trimmedDomain = props.platformDomain.trim().replace(/\/$/, '')
    const origin = /^https?:\/\//.test(trimmedDomain) ? trimmedDomain : `https://${trimmedDomain}`

    return () => {
      const preferencesUrl = props.preferencesUrl
      const unsubscribeUrl = props.unsubscribeUrl
      const orgName = props.organizationName
      const orgLogo = props.organizationLogoUrl

      return h(EHtml, { lang: locale.locale, dir: locale.direction }, () => [
        h(EHead, null, () => [
          h('meta', { name: 'color-scheme', content: 'light dark' }),
          h('meta', { name: 'supported-color-schemes', content: 'light dark' }),
          h(EStyle, null, () => `
            @media (prefers-color-scheme: dark) {
              body, .email-bg { background-color: ${dark.bg} !important; }
              .email-surface { background-color: ${dark.surface} !important; }
              .email-body p, .email-body td, .email-body span { color: ${dark.textMuted} !important; }
              .email-body h1, .email-body h2, .email-body strong, .email-value { color: ${dark.text} !important; }
              .email-body hr, .email-divider { border-color: ${dark.border} !important; }
              .email-markdown h3, .email-markdown h4, .email-markdown a { color: ${dark.text} !important; }
              .email-markdown li, .email-markdown blockquote { color: ${dark.textMuted} !important; }
              .email-markdown blockquote, .email-markdown td { border-color: ${dark.border} !important; }
              .email-markdown code, .email-markdown pre { background-color: ${dark.bg} !important; color: ${dark.textMuted} !important; }
              .email-label, .email-footer { color: ${dark.textDimmed} !important; }
              .email-footer a { color: ${dark.textMuted} !important; }
              .email-body .email-header-name { color: ${dark.text} !important; }
              /* The hero's letterbox is the page behind the picture, so it
                 follows the scheme rather than staying a light band. */
              .email-hero-img { background-color: ${dark.bg} !important; }
              /* The primary button inverts with the scheme, like the
                 product's: navy on light, white on dark. The label lives in a
                 span inside the anchor and the generic span rule above sets
                 that span's colour directly, so the button has to out-specify
                 it: a class plus universal selector loses to a class plus
                 element. */
              .email-body .email-cta-secondary, .email-body .email-cta-secondary span { border-color: ${dark.border} !important; color: ${dark.text} !important; }
              .email-body .email-cta-primary { background-color: ${light.surface} !important; }
              .email-body .email-cta-primary, .email-body .email-cta-primary span { color: ${light.text} !important; }
            }
            @media only screen and (max-width: 600px) {
              .email-gutter { padding-left: 20px !important; padding-right: 20px !important; }
              .email-title { font-size: 26px !important; }
              .email-col { display: block !important; width: 100% !important; }
              .email-col + .email-col { padding-top: 20px !important; }
            }
          `),
        ]),
        h(EPreview, null, () => props.preheader),
        h(EBody, {
          class: 'email-bg',
          style: `margin:0;padding:0;background:${light.bg};font-family:${font.body};-webkit-font-smoothing:antialiased;color-scheme:light dark;`,
        }, () => [
          h(EContainer, {
            class: 'email-surface email-body',
            style: `max-width:${layout.width};margin:0 auto;background:${light.surface};`,
          }, () => [
            h(ESection, { class: 'email-gutter', style: `padding:24px ${layout.gutter} 0` }, () => [
              h('table', { role: 'presentation', cellPadding: '0', cellSpacing: '0', style: 'border-collapse:collapse' }, [
                h('tbody', null, [
                  h('tr', null, [
                    // The mark is whose mail this is: a tenant's logo, or on
                    // KrabiClaw's own mail the crab. A tenant with no logo is
                    // named alone; KrabiClaw's mark never stands in for it.
                    orgName
                      ? (orgLogo
                          ? h('td', { style: 'vertical-align:middle;line-height:0' }, [
                              h(EImg, {
                                src: orgLogo,
                                alt: orgName,
                                width: '36',
                                height: '36',
                                style: 'display:inline-block;vertical-align:middle;width:36px;height:36px;border-radius:50%;object-fit:cover',
                              }),
                            ])
                          : null)
                      : h('td', { style: 'vertical-align:middle;line-height:0' }, [
                          h(EImg, {
                            src: `${origin}/krabi-claw-logo.png`,
                            alt: 'KrabiClaw',
                            width: '32',
                            height: '32',
                            style: 'display:inline-block;vertical-align:middle;width:32px;height:32px',
                          }),
                        ]),
                    orgName
                      ? h('td', { style: `vertical-align:middle;padding-left:${orgLogo ? '12px' : '0'}` }, [
                          h('span', {
                            class: 'email-header-name',
                            style: `font-size:15px;font-weight:700;letter-spacing:-0.2px;color:${light.text};font-family:${font.body};line-height:1`,
                          }, orgName),
                        ])
                      : null,
                  ]),
                ]),
              ]),
            ]),
            slots.default?.(),
            h(ESection, { class: 'email-gutter', style: `padding:40px ${layout.gutter} 40px` }, () => [
              h('div', { class: 'email-divider', style: `border-top:1px solid ${light.border};padding-top:24px` }, [
                h(EText, { class: 'email-footer', style: `margin:0;${type.footer};color:${light.textDimmed}` }, () => [
                  `© ${year} KrabiClaw · `,
                  h(ELink, { href: origin, style: `color:${light.textMuted};text-decoration:underline` }, () => 'krabiclaw.com'),
                ]),
                props.organizationName && !props.locale
                  ? h(EText, { class: 'email-footer', style: `margin:6px 0 0;${type.footer};color:${light.textDimmed}` }, () => `Sent by ${props.organizationName} via KrabiClaw.`)
                  : null,
                // Preferences first: someone who only wants less of one thing
                // should not have to switch the category off to get it.
                preferencesUrl || unsubscribeUrl
                  ? h(EText, { class: 'email-footer', style: `margin:10px 0 0;${type.footer};color:${light.textDimmed}` }, () => [
                      preferencesUrl ? h(ELink, { href: preferencesUrl, style: `color:${light.textMuted};text-decoration:underline` }, () => 'Choose what you receive') : null,
                      preferencesUrl && unsubscribeUrl ? ' · ' : null,
                      unsubscribeUrl ? h(ELink, { href: unsubscribeUrl, style: `color:${light.textMuted};text-decoration:underline` }, () => 'Unsubscribe') : null,
                    ])
                  : null,
              ]),
            ]),
          ]),
        ]),
      ])
    }
  },
})
