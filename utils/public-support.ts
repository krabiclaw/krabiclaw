import {
  PLATFORM_KNOWLEDGE_FAQ_ENTRIES,
  PLATFORM_KNOWLEDGE_ROUTE_ENTRIES,
  type PlatformKnowledgeFaqEntry,
  type PlatformKnowledgeResultType as PublicSearchType,
} from '~/config/platform-knowledge'
import { KRABICLAW_REPOSITORY_URL } from '~/shared/open-source'

export type { PublicSearchType }

export interface PublicSupportRouteCard {
  title: string
  description: string
  to: string
}

export interface PublicSupportTopic {
  label: string
  value: string
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
    description: 'KrabiClaw is open source. File it on GitHub, or ask your AI assistant to file it for you.',
    to: `${KRABICLAW_REPOSITORY_URL}/issues/new/choose`,
  },
]

export const PUBLIC_SUPPORT_TOPICS: PublicSupportTopic[] = [
  { label: 'KrabiClaw Platform', value: 'platform' },
  { label: 'ChowBot', value: 'chowbot' },
]

export const PUBLIC_SUPPORT_FAQ_ENTRIES: PlatformKnowledgeFaqEntry[] = PLATFORM_KNOWLEDGE_FAQ_ENTRIES

export const PUBLIC_SUPPORT_ROUTE_METADATA = PLATFORM_KNOWLEDGE_ROUTE_ENTRIES
  .filter(route => route.surfaces.includes('public') || route.surfaces.includes('help') || route.surfaces.includes('chowbot'))
  .map(route => ({
    id: route.id,
    title: route.title,
    path: route.path,
    snippet: route.snippet,
    keywords: route.keywords,
  }))

