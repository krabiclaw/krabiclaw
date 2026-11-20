import {
  PLATFORM_KNOWLEDGE_FAQ_ENTRIES,
  type PlatformKnowledgeFaqEntry,
} from '~/config/platform-knowledge'
import { BLAWBY_REPOSITORY_URL } from '~/shared/open-source'

export interface PublicSupportRouteCard {
  title: string
  description: string
  to: string
}

export const PUBLIC_SUPPORT_ROUTE_CARDS: PublicSupportRouteCard[] = [
  {
    title: 'Browse Documentation',
    description: 'Setup guides, billing details, product walkthroughs, and launch help.',
    to: '/docs',
  },
  {
    title: 'Read Product Updates',
    description: 'Launch notes, strategy posts, and deeper product guidance from the blog.',
    to: '/blog',
  },
  {
    title: 'Report a Bug or Request a Feature',
    description: 'Blawby is open source. File it on GitHub, or ask your AI assistant to file it for you.',
    to: `${BLAWBY_REPOSITORY_URL}/issues/new/choose`,
  },
]

export const PUBLIC_SUPPORT_FAQ_ENTRIES: PlatformKnowledgeFaqEntry[] = PLATFORM_KNOWLEDGE_FAQ_ENTRIES
