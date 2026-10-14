import { defineComponent, h, type PropType } from 'vue'
import { ESection, EButton } from '../vue-email'
import { light, layout, font } from '../tokens'
import type { NotificationAction } from '~/server/notifications/messages'

const BASE = `display:block;width:100%;box-sizing:border-box;font-family:${font.body};font-size:16px;font-weight:700;line-height:1;text-decoration:none;text-align:center;padding:16px 24px;border-radius:10px`

/**
 * One primary action, filled; one secondary, outlined. Both full width.
 *
 * The old pair disagreed with itself — the shell's own CTA was left-aligned and
 * EmailAction centred, so two emails put the same button in two places.
 */
export default defineComponent({
  props: {
    primary: { type: Object as PropType<NotificationAction | null>, default: null },
    secondary: { type: Object as PropType<NotificationAction | null>, default: null },
  },
  setup(props) {
    return () => {
      const primary = props.primary
      const secondary = props.secondary
      if (!primary && !secondary) return null
      return h(ESection, { class: 'email-gutter', style: `padding:28px ${layout.gutter} 0` }, () => [
        primary
          ? h(EButton, {
              class: 'email-cta-primary',
              href: primary.url,
              style: `${BASE};background:${light.text};color:${light.surface};border:none`,
            }, () => primary.label)
          : null,
        secondary
          ? h(EButton, {
              class: 'email-cta-secondary',
              href: secondary.url,
              style: `${BASE};background:transparent;color:${light.text};border:1px solid ${light.border};margin-top:12px`,
            }, () => secondary.label)
          : null,
      ])
    }
  },
})
