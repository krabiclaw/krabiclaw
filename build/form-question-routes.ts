// A form's questions are edited by one set of screens, written once under
// Website › Inquiry form. The booking of a product (a class, a consultation, a
// table) and a home hold questions of the same shape, so the same files are mounted
// beneath each of those records as `questions`. The `formQuestions` meta names
// the record a mount edits; useFormQuestionsOwner reads it.
import { nodeAt, renamed, type PageNode } from './booking-routes'

const SOURCE_PATH = '/dashboard/:orgSlug()/website/inquiry-form'
const SOURCE_NAME = 'dashboard-orgSlug-website-inquiry-form'
const MOUNTS = [
  { owner: 'booking', parent: '/dashboard/:orgSlug()/products/:productId()/booking', name: 'dashboard-orgSlug-products-productId-booking-questions' },
  { owner: 'stay', parent: '/dashboard/:orgSlug()/products/:productId()', name: 'dashboard-orgSlug-products-productId-questions' },
] as const

function owned(node: PageNode, owner: string): PageNode {
  return { ...node, meta: { ...node.meta, formQuestions: owner }, children: node.children?.map(child => owned(child, owner)) }
}

export function mountFormQuestionRoutes(pages: PageNode[]): void {
  const source = nodeAt(pages, SOURCE_PATH)
  if (!source) throw new Error('Website › Inquiry form was not found; form questions cannot be mounted beneath their records')
  Object.assign(source, owned(source, 'inquiry'))
  for (const mount of MOUNTS) {
    const parent = nodeAt(pages, mount.parent)
    if (!parent) throw new Error(`${mount.parent} was not found; its questions cannot be mounted`)
    const clone = owned(renamed(source, SOURCE_NAME, mount.name), mount.owner)
    clone.path = 'questions'
    parent.children = [...(parent.children ?? []), clone]
  }
}
