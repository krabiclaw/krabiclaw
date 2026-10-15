
export type PlatformKnowledgeResultType =
  | 'doc'
  | 'blog'
  | 'faq'
  | 'route'
  | 'platform_page'
  // A business's own records, indexed for its dashboard's search and scoped
  // to it by `organization_id` at query time.
  | 'product'
  | 'collection'
  | 'location'
  | 'qa'
  | 'post'
  | 'page'
  | 'thread'
  | 'member'
  | 'media'

export type PlatformKnowledgeSurface =
  | 'public'
  | 'docs'
  | 'blog'
  | 'dashboard'
  | 'help'
  | 'chowbot'
  | 'tenant_blog'

export interface PlatformKnowledgeFaqEntry {
  id: string
  title: string
  answer: string
  keywords: string[]
}

export interface PlatformKnowledgeRouteEntry {
  id: string
  title: string
  path: string
  snippet: string
  icon: string
  section: string
  keywords: string[]
  surfaces: PlatformKnowledgeSurface[]
}

export interface PlatformKnowledgePageEntry {
  id: string
  title: string
  path: string
  snippet: string
  body: string
  icon: string
  section: string
  keywords: string[]
  surfaces: PlatformKnowledgeSurface[]
}

export const PLATFORM_KNOWLEDGE_FAQ_ENTRIES: PlatformKnowledgeFaqEntry[] = [
  {
    id: 'getting-started-no-tech-skills',
    title: 'Do I need technical skills to use Krabiclaw?',
    answer: 'No. Krabiclaw is designed for business owners, not developers. You can launch and update your site through guided flows and conversation.',
    keywords: ['technical skills', 'developer', 'beginner', 'easy', 'setup'],
  },
  {
    id: 'create-first-website',
    title: 'How do I create my first website?',
    answer: 'Create an account, choose your site name and subdomain, and then use the dashboard or ChatGPT to add locations, offerings, photos, and content.',
    keywords: ['first website', 'create site', 'signup', 'subdomain', 'launch'],
  },
  {
    id: 'google-places-optional',
    title: 'Can I use Krabiclaw without Google Places?',
    answer: 'Yes. Google Places is optional. You can add your hours, offerings, photos, and content manually, then import public location details from Google Maps later.',
    keywords: ['google places', 'google maps', 'optional', 'manual setup', 'without google'],
  },
  {
    id: 'menu-updates',
    title: 'How do I add or update menu items?',
    answer: 'Use the dashboard Offerings area or the ChatGPT connector to add items, adjust prices, or rewrite descriptions. Provide the product details you want to save.',
    keywords: ['menu', 'offerings', 'menu items', 'prices', 'import menu'],
  },
  {
    id: 'hours-updates',
    title: 'How do I update opening hours?',
    answer: 'Go to the dashboard location settings to edit hours manually, or import the public hours from Google Places and re-sync when needed.',
    keywords: ['hours', 'opening hours', 'business hours', 'location settings', 'google places'],
  },
  {
    id: 'custom-domain',
    title: 'How do I connect my own domain?',
    answer: 'Upgrade to a plan that includes custom domains, open the site Domains page, and then add the DNS records Krabiclaw provides.',
    keywords: ['custom domain', 'dns', 'domain setup', 'connect domain'],
  },
  {
    id: 'ssl',
    title: 'Is SSL included?',
    answer: 'Yes. Krabiclaw sites are served over HTTPS with managed SSL.',
    keywords: ['ssl', 'https', 'security certificate'],
  },
  {
    id: 'google-reviews',
    title: 'Will my Google reviews show on my site?',
    answer: 'Yes. Google Places can import the public reviews available for a location onto your site.',
    keywords: ['google reviews', 'google places', 'reviews', 'sync reviews'],
  },
  {
    id: 'plans-change',
    title: 'Can I change plans anytime?',
    answer: 'Yes. You can upgrade or downgrade from the dashboard billing area, and each site keeps its own plan.',
    keywords: ['plans', 'upgrade', 'downgrade', 'billing'],
  },
]

export const PLATFORM_KNOWLEDGE_ROUTE_ENTRIES: PlatformKnowledgeRouteEntry[] = [
  {
    id: 'docs',
    title: 'Documentation',
    path: '/docs',
    snippet: 'Guides for setup, content editing, integrations, billing, analytics, and launch workflows.',
    icon: 'book',
    section: 'Docs',
    keywords: ['docs', 'documentation', 'guide', 'setup', 'help'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'blog',
    title: 'Blog',
    path: '/blog',
    snippet: 'Product updates, strategic articles, launch notes, and deeper platform guidance.',
    icon: 'newspaper',
    section: 'Blog',
    keywords: ['blog', 'articles', 'updates', 'announcements', 'seo'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'help',
    title: 'Support',
    path: '/help',
    snippet: 'Talk to support, browse docs, and send a support case if you are blocked.',
    icon: 'circle-help',
    section: 'Support',
    keywords: ['support', 'help', 'contact support', 'agent'],
    surfaces: ['public', 'docs', 'blog', 'help'],
  },
  {
    id: 'pricing',
    title: 'Pricing',
    path: '/pricing',
    snippet: 'Plan comparison, billing details, and what each paid tier unlocks.',
    icon: 'credit-card',
    section: 'Platform',
    keywords: ['pricing', 'plans', 'billing', 'cost', 'subscription'],
    surfaces: ['public', 'docs', 'blog', 'help'],
  },
  {
    id: 'login',
    title: 'Login',
    path: '/login',
    snippet: 'Sign in to access the dashboard, billing, and site settings.',
    icon: 'log-in',
    section: 'Platform',
    keywords: ['login', 'sign in', 'account', 'dashboard access'],
    surfaces: ['public', 'help'],
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    path: '/dashboard',
    snippet: 'Manage sites, billing, members, analytics, settings, and support workflows.',
    icon: 'layout-dashboard',
    section: 'Dashboard',
    keywords: ['dashboard', 'workspace', 'manage site', 'admin'],
    surfaces: ['dashboard', 'help'],
  },
]

export const PLATFORM_KNOWLEDGE_PAGE_ENTRIES: PlatformKnowledgePageEntry[] = [
  {
    id: 'home',
    title: 'Krabiclaw Home',
    path: '/',
    snippet: 'Overview of the AI website platform for restaurants, experiences, and local businesses.',
    body: 'Krabiclaw helps local businesses launch fast websites, manage content through ChatGPT and the dashboard, and convert organic traffic directly on their own site.',
    icon: 'sparkles',
    section: 'Platform',
    keywords: ['home', 'overview', 'krabiclaw', 'platform', 'what is krabiclaw'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'pricing-page',
    title: 'Pricing Plans',
    path: '/pricing',
    snippet: 'Compare tiers, billing, and what each plan unlocks.',
    body: 'Pricing explains the differences between free and paid plans, billing expectations, Growth priority support, and which features are available at each tier.',
    icon: 'credit-card',
    section: 'Platform',
    keywords: ['pricing', 'plan', 'billing', 'upgrade'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'features-page',
    title: 'Products',
    path: '/products',
    snippet: 'Learn how Krabiclaw handles content, analytics, SEO, speed, and AI-assisted workflows.',
    body: 'Products cover website building, ChatGPT and Claude management through MCP, inbox and messaging, bookings, content, reviews, local presence and analytics.',
    icon: 'star',
    section: 'Platform',
    keywords: ['features', 'seo', 'analytics', 'performance', 'google places'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'templates-page',
    title: 'Templates',
    path: '/templates',
    snippet: 'Explore available presentation styles and platform templates for new sites.',
    body: 'Templates show the design system options and layout directions available when launching a Krabiclaw site.',
    icon: 'layout-template',
    section: 'Platform',
    keywords: ['templates', 'themes', 'design', 'saya', 'blawby', 'layouts'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'templates-saya-page',
    title: 'Saya Template',
    path: '/templates/saya',
    snippet: 'Editorial restaurant and experience websites with Google Places imports.',
    body: 'The Saya template is the flagship Krabiclaw theme for restaurants and experiences — editorial typography, location-centric navigation, and Google Places imports. Free on all plans.',
    icon: 'layout-template',
    section: 'Platform',
    keywords: ['saya', 'template', 'theme', 'restaurant', 'experience', 'free'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'templates-blawby-page',
    title: 'Blawby Template for Law Firms',
    path: '/templates/blawby',
    snippet: 'Websites for solo lawyers and small law firms, with practice-area pages and clear consultation steps.',
    body: 'The Blawby template helps solo lawyers and small law firms present their practice areas, introduce their people, publish firm news, and guide visitors toward a consultation. See the live North Carolina Legal Services website.',
    icon: 'layout-template',
    section: 'Platform',
    keywords: ['blawby', 'template', 'theme', 'legal', 'lawyer', 'solo lawyer', 'law firm', 'small law firm', 'practice area', 'consultation', 'ncls'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
]
