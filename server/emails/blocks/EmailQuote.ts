import { defineComponent, h, type PropType } from 'vue'
import { ESection, EText, EImg } from '../vue-email'
import { light, layout, type } from '../tokens'
import type { NotificationQuote } from '~/server/notifications/messages'

/**
 * Someone's own words, as a bordered card: their initial and name, the words as
 * written, and any photos they sent.
 * Used where the message *is* the content — a guest's message, a business's
 * reply — so it leads and nothing is added around it.
 */
export default defineComponent({
  props: {
    quote: { type: Object as PropType<NotificationQuote>, required: true },
  },
  setup(props) {
    return () => {
      const quote = props.quote
      const initial = Array.from(quote.author.trim())[0]?.toUpperCase()
      if (!initial) throw new Error('A quoted message needs its author')
      return h(ESection, { class: 'email-gutter', style: `padding:24px ${layout.gutter} 0` }, () => [
        h('div', { class: 'email-divider', style: `border:1px solid ${light.border};border-radius:12px;padding:18px` }, [
          h('table', { role: 'presentation', cellPadding: '0', cellSpacing: '0', style: 'border-collapse:collapse' }, [
            h('tbody', null, [h('tr', null, [
              h('td', { style: 'vertical-align:middle;padding:0 12px 0 0' }, [
                h('div', { class: 'email-avatar', style: `width:40px;height:40px;border-radius:20px;background:${light.bg};text-align:center;${type.value};line-height:40px` }, [
                  h('strong', { style: `color:${light.text}` }, initial),
                ]),
              ]),
              h('td', { style: 'vertical-align:middle' }, [h('strong', { style: `${type.value};color:${light.text}` }, quote.author)]),
            ])]),
          ]),
          quote.body
            ? h(EText, { style: `margin:12px 0 0;${type.body};color:${light.text};white-space:pre-wrap` }, () => quote.body)
            : null,
          ...quote.photos.map(photo =>
            h(EImg, { src: photo.imageUrl, alt: photo.alt, width: '514', style: `display:block;width:100%;max-width:100%;height:auto;margin-top:12px;border-radius:8px;background:${light.bg}` }),
          ),
        ]),
      ])
    }
  },
})
