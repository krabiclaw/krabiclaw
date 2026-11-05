import { defineComponent, h, type PropType } from 'vue'
import { ESection, EText, EImg } from '../vue-email'
import { light, layout, type } from '../tokens'
import EmailFactGrid from './EmailFactGrid'
import type { NotificationFact } from '~/server/notifications/messages'

/** A titled block, divided from what came before, led by the picture of what it describes when it has one. */
export default defineComponent({
  props: {
    title: { type: String, required: true },
    image: { type: Object as PropType<{ imageUrl: string; alt: string } | null>, default: null },
    body: { type: String as PropType<string | null>, default: null },
    facts: { type: Array as PropType<NotificationFact[]>, default: () => [] },
  },
  setup(props) {
    return () => h(ESection, { style: 'padding:32px 0 0' }, () => [
      h('div', { class: 'email-gutter', style: `padding:0 ${layout.gutter}` }, [
        h('div', { class: 'email-divider', style: `border-top:1px solid ${light.border};padding-top:24px` }, [
          props.image
            ? h(EImg, { class: 'email-section-img', src: props.image.imageUrl, alt: props.image.alt, width: '552', style: `display:block;width:100%;max-width:100%;height:auto;aspect-ratio:20/11;object-fit:cover;border-radius:12px;background:${light.bg};margin:0 0 20px` })
            : null,
          h(EText, { style: `margin:0;${type.sectionTitle};color:${light.text}` }, () => props.title),
          props.body
            ? h(EText, { style: `margin:8px 0 0;${type.body};color:${light.textMuted};white-space:pre-line` }, () => props.body)
            : null,
        ]),
      ]),
      props.facts.length ? h(EmailFactGrid, { facts: props.facts, columns: 2 }) : null,
    ])
  },
})
