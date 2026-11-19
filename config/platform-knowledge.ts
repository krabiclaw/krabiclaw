
export const LODGING_PAGE_SUMMARY = "Manage furnished rentals, direct bookings and turnovers. Eligible connected homes sync reservations and availability through Channex."

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
    title: 'Do I need technical skills to use Blawby?',
    answer: 'No. Blawby is designed for business owners, not developers. You can launch and update your site through guided flows and conversation.',
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
    title: 'Can I use Blawby without Google Places?',
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
    answer: 'Upgrade to a plan that includes custom domains, open the site Domains page, and then add the DNS records Blawby provides.',
    keywords: ['custom domain', 'dns', 'domain setup', 'connect domain'],
  },
  {
    id: 'ssl',
    title: 'Is SSL included?',
    answer: 'Yes. Blawby sites are served over HTTPS with managed SSL.',
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
    title: 'Blawby Home',
    path: '/',
    snippet: 'Run your business from your favorite AI app with Blawby. The business AI agent for restaurants, experiences, lodging, and law firms.',
    body: 'Blawby is the business AI agent. Connect ChatGPT, Claude, and compatible AI apps to business records and supported actions. Manage menus, bookings, classes, consultations, direct stay bookings, listings, and customer messages.',
    icon: 'sparkles',
    section: 'Platform',
    keywords: ['home', 'overview', 'ai agent', 'business ai agent', 'chatgpt', 'claude', 'platform', 'krabiclaw', 'run your business'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'ai-agent-page',
    title: 'AI Agent',
    path: '/plugin',
    snippet: 'Run your business from ChatGPT, Claude, and compatible AI apps with Blawby.',
    body: 'Connect your favorite AI app to Blawby. Blawby connects requests to business records and actions, allowing you to manage menus, reservations, bookings, listings, and client communications through conversation.',
    icon: 'sparkles',
    section: 'Platform',
    keywords: ['ai agent', 'mcp', 'chatgpt', 'claude', 'agent', 'model context protocol', 'plugin', 'run your business'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'integrations-page',
    title: 'Integrations',
    path: '/integrations',
    snippet: 'Connect Google Calendar, Airbnb, Stripe, analytics, and social accounts to your business AI agent.',
    body: 'Blawby connects to business services including Airbnb, Google Calendar, Stripe, social accounts, and analytics. Stays and availability stay in step with Airbnb, and consultations stay in step with your calendar.',
    icon: 'plug',
    section: 'Platform',
    keywords: ['integrations', 'airbnb sync', 'google calendar', 'stripe', 'connectors', 'sync', 'connected services'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'restaurants-page',
    title: 'Restaurants',
    path: '/restaurants',
    snippet: 'Restaurant AI agent and website. Update menus and hours, check reservations, and manage customer messages.',
    body: 'Run your restaurant from your favorite AI app. Update food and drink menus, opening hours, manage table reservations, and reply to customer inquiries with Blawby.',
    icon: 'utensils',
    section: 'Solutions',
    keywords: ['restaurant', 'restaurant ai agent', 'ai agent', 'menu', 'reservations', 'table booking', 'dining', 'food', 'hours'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'experiences-page',
    title: 'Experiences',
    path: '/experiences',
    snippet: 'Experiences AI agent and website. Manage classes, tours, workshops, sessions, bookings, and guest messages.',
    body: 'Run your classes, tours, and workshops from your favorite AI app. Schedule dated sessions, manage ticketed bookings, take prepayments, and answer guest questions with Blawby.',
    icon: 'compass',
    section: 'Solutions',
    keywords: ['experiences', 'ai agent for classes', 'ai agent', 'classes', 'tours', 'workshops', 'sessions', 'ticketed bookings', 'activities'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'legal-page',
    title: 'Law firms',
    path: '/legal',
    snippet: 'Law firm AI agent and website. Update practice areas and attorney profiles, check consultation bookings, and prepare client replies.',
    body: 'Run your law firm from your favorite AI app. Solo practitioners and small law firms update practice areas, attorney profiles, and legal consultation requests against attorney calendars with Blawby.',
    icon: 'scale',
    section: 'Solutions',
    keywords: ['legal', 'law firms', 'ai agent for law firm websites', 'ai agent', 'attorney', 'lawyer', 'practice areas', 'consultation', 'legal services'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'lodging-page',
    title: 'Mid-Term Rental & Host PMS Software',
    path: '/lodging',
    snippet: LODGING_PAGE_SUMMARY,
    body: `Present furnished listings, photos, amenities, and extended stay rate plans on your own website. ${LODGING_PAGE_SUMMARY} Manage guest conversations in Blawby.`,
    icon: 'calendar',
    section: 'Solutions',
    keywords: ['lodging', 'airbnb agent', 'ai agent', 'mid term rental', 'furnished rental', 'mtr', 'pms', 'extended stay', 'airbnb host', 'vrbo', 'direct booking', 'turnover', 'calendar sync', 'listings'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'about-page',
    title: 'About Blawby',
    path: '/about',
    snippet: 'Learn about Blawby, the business AI agent helping owners run restaurants, experiences, lodging, and law firms.',
    body: 'Blawby is the business AI agent built to let business owners run their websites, bookings, listings, and customer communications directly from their favorite AI app.',
    icon: 'info',
    section: 'Platform',
    keywords: ['about', 'company', 'mission', 'blawby', 'team'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'pricing-page',
    title: 'Pricing Plans',
    path: '/pricing',
    snippet: 'Compare tiers, billing, and what each plan unlocks.',
    body: 'Pricing compares Basic, Growth and Business, their capabilities, and billing. Business includes online payments and direct stay booking. Read the current pricing page for setup requirements, additional listings and usage charges.',
    icon: 'credit-card',
    section: 'Platform',
    keywords: ['pricing', 'plan', 'billing', 'upgrade', 'business', 'lodging', 'stays', 'listings'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'features-page',
    title: 'Products',
    path: '/products',
    snippet: 'Learn how Blawby handles content, analytics, SEO, speed, and AI-assisted workflows.',
    body: 'Products cover website building, ChatGPT and Claude management, inbox and messaging, experience bookings, direct stays, listings, content, reviews, local presence and analytics.',
    icon: 'star',
    section: 'Platform',
    keywords: ['features', 'seo', 'analytics', 'performance', 'google places', 'lodging', 'stays', 'listings', 'products'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'templates-page',
    title: 'Templates',
    path: '/templates',
    snippet: 'Explore available presentation styles and platform templates for new sites.',
    body: 'Templates show the design system options and layout directions available when launching a Blawby site.',
    icon: 'layout-template',
    section: 'Platform',
    keywords: ['templates', 'themes', 'design', 'saya', 'blawby', 'layouts'],
    surfaces: ['public', 'docs', 'blog', 'help', 'chowbot'],
  },
  {
    id: 'templates-saya-page',
    title: 'Saya Template',
    path: '/templates/saya',
    snippet: 'Restaurant, experience and lodging websites with menus, bookable experiences and listings.',
    body: 'The Saya template serves restaurants, experience operators and lodging businesses, with menus, experience pages, listings and direct stay booking. The template is included on every plan; online payments require Business and Stripe setup.',
    icon: 'layout-template',
    section: 'Platform',
    keywords: ['saya', 'template', 'theme', 'restaurant', 'experience', 'lodging', 'listings', 'stays', 'free'],
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
