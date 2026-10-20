import { defineComponent, h, type CSSProperties, type PropType } from 'vue'
import { EImg, EMarkdown, ESection, EText } from './vue-email'
import { renderEmail, type RenderedEmail } from './vue-email'
import EmailFrame from './blocks/EmailFrame'
import EmailHero from './blocks/EmailHero'
import EmailFactGrid from './blocks/EmailFactGrid'
import EmailSection from './blocks/EmailSection'
import EmailActions from './blocks/EmailActions'
import { light, layout, type } from './tokens'
import type { NotificationMessage } from '~/server/notifications/messages'

const heading: CSSProperties = { color: light.text, fontWeight: '700', margin: '28px 0 0' }
const text: CSSProperties = { color: light.text, fontSize: '16px', lineHeight: '1.6', margin: '16px 0 0' }

/** The markdown renderer's defaults are a web page's; these are the email's own scale and palette. */
const bodyMarkdownStyles: Record<string, CSSProperties> = {
  h1: { ...heading, fontSize: '24px', lineHeight: '1.25' },
  h2: { ...heading, fontSize: '20px', lineHeight: '1.3' },
  h3: { ...heading, fontSize: '18px', lineHeight: '1.35' },
  h4: { ...heading, fontSize: '16px', lineHeight: '1.4' },
  p: text,
  ul: { ...text, paddingLeft: '24px' },
  ol: { ...text, paddingLeft: '24px' },
  li: { margin: '6px 0 0' },
  link: { color: light.text, textDecoration: 'underline' },
  blockQuote: { margin: '16px 0 0', padding: '0 0 0 16px', borderLeft: `3px solid ${light.border}`, color: light.textMuted },
  codeInline: { fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace', fontSize: '14px', background: light.bg },
  codeBlock: { fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace', fontSize: '14px', background: light.bg, padding: '12px', margin: '16px 0 0', whiteSpace: 'pre-wrap', wordWrap: 'break-word' },
  image: { maxWidth: '100%', height: 'auto' },
  hr: { border: 'none', borderTop: `1px solid ${light.border}`, margin: '28px 0 0' },
  table: { ...text, borderCollapse: 'collapse' },
  td: { padding: '6px 12px 6px 0', borderBottom: `1px solid ${light.border}` },
}

/**
 * The one email component. Every notification is this layout with different
 * content, which is why a new one is a data entry rather than 55 lines of
 * inline CSS.
 */
export const NotificationEmail = defineComponent({
  props: {
    message: { type: Object as PropType<NotificationMessage>, required: true },
    preferencesUrl: { type: String as PropType<string | null>, default: null },
    unsubscribeUrl: { type: String as PropType<string | null>, default: null },
    platformDomain: { type: String, required: true },
  },
  setup(props) {
    return () => {
      const message = props.message
      const hero = message.hero
      return h(EmailFrame, {
        locale: message.locale,
        preheader: message.preheader,
        organizationName: message.organizationName ?? null,
        organizationLogoUrl: message.organizationLogoUrl ?? null,
        preferencesUrl: props.preferencesUrl,
        unsubscribeUrl: props.unsubscribeUrl,
        platformDomain: props.platformDomain,
      }, () => [
        hero ? h(EmailHero, { src: hero.imageUrl, alt: hero.alt }) : null,

        h(ESection, { class: 'email-gutter', style: `padding:28px ${layout.gutter} 0` }, () => [
          // The subject is the headline. Nothing below restates it.
          h('h1', { class: 'email-title', style: `margin:0;${type.title};font-family:var(--x,inherit);color:${light.text}` }, message.title),
          message.intro
            ? h(EText, { style: `margin:12px 0 0;${type.body};color:${light.textMuted};white-space:pre-line` }, () => message.intro)
            : null,
          message.body
            ? h(EMarkdown, { class: 'email-markdown', source: message.body, markdownCustomStyles: bodyMarkdownStyles, markdownContainerStyles: { marginTop: '20px' } })
            : null,
        ]),

        h(EmailFactGrid, { facts: message.facts, columns: 2 }),
        h(EmailActions, { primary: message.primaryAction ?? null, secondary: message.secondaryAction ?? null }),

        ...(message.sections ?? []).map(section =>
          h(EmailSection, { title: section.title, body: section.body ?? null, facts: section.facts ?? [] }),
        ),

        ...(message.photos ?? []).map(photo =>
          h(ESection, { class: 'email-gutter', style: `padding:16px ${layout.gutter} 0` }, () => [
            h(EImg, { src: photo.imageUrl, alt: photo.alt, width: '552', style: `display:block;width:100%;max-width:100%;height:auto;border-radius:12px;background:${light.bg}` }),
          ]),
        ),

        message.finePrint
          ? h(ESection, { class: 'email-gutter', style: `padding:24px ${layout.gutter} 0` }, () => [
              h(EText, { class: 'email-footer', style: `margin:0;${type.footer};color:${light.textDimmed};white-space:pre-line` }, () => message.finePrint),
            ])
          : null,
      ])
    }
  },
})

export interface RenderOptions {
  platformDomain: string
  preferencesUrl?: string | null
  unsubscribeUrl?: string | null
}

export async function renderNotificationEmail(message: NotificationMessage, options: RenderOptions): Promise<RenderedEmail> {
  return renderEmail(NotificationEmail, {
    message,
    platformDomain: options.platformDomain,
    preferencesUrl: options.preferencesUrl ?? null,
    unsubscribeUrl: options.unsubscribeUrl ?? null,
  })
}
