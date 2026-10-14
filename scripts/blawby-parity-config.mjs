export const BLAWBY_REFERENCE_COMMIT = 'f9470f44e15f98978b7f866da54782a6da95818d'
export const BLAWBY_REFERENCE_URL = 'https://www.northcarolinalegalservices.org'
export const BLAWBY_REFERENCE_ETAG = '"tssewjfnf43rg6"'

export const NCLS_ARTICLE_SLUGS = [
  '7-common-iep-violations-every-north-carolina-parent-should-recognize-and-how-to-fight-back',
  'disaster-relief-for-north-carolina-homeowners-after-hurricane-helene',
  'divorce-and-children-in-north-carolina',
  'employee-disability-rights-in-north-carolina',
  'equitable-distribution-in-north-carolina-divorces',
  'fairness-is-not-a-zero-sum-game-why-dei-benefits-everyone',
  'getting-a-divorce-in-north-carolina',
  'hurricane-disaster-relief-for-north-carolina-renters',
  'iep-violations-in-north-carolina-how-to-recognize-them-and-protect-your-childs-rights',
  'know-your-rights-what-to-do-if-you-witness-an-ice-arrest',
  'pet-custody-in-nc-divorce-how-equitable-distribution-affects-your-dog-or-cat',
  'preparing-for-your-consultation-with-north-carolina-legal-services',
  'property-division-in-north-carolina-divorce-protecting-whats-yours',
  'protecting-your-freelance-business-in-north-carolina-contracts-compliance-and-best-practices',
  'the-legal-needs-of-small-businesses-in-north-carolina',
  'understanding-the-legal-process-preparing-for-court-without-a-lawyer',
  'when-schools-fail-to-follow-the-iep-what-north-carolina-parents-can-do',
  'writing-your-own-will-how-it-works',
  'your-landlord-cannot-evict-you-without-a-court-order-heres-what-to-do-when-they-try',
]

export const BLAWBY_PARITY_VIEWPORTS = {
  mobile: { width: 390, height: 1200 },
  tablet: { width: 768, height: 1200 },
  desktop: { width: 1440, height: 1200 },
  wide: { width: 1920, height: 1200 },
}

export const BLAWBY_PARITY_ROUTES = {
  home: {
    path: '/',
    sections: ['hero', 'services', 'approach', 'qa', 'reviews', 'articles', 'articles-more', 'consultation'],
  },
  services: {
    path: '/services',
    sections: ['services', 'qa', 'consultation'],
  },
  'service-detail': {
    path: '/services/family',
    sections: ['service-overview', 'features', 'reviews', 'qa', 'related-services', 'consultation'],
  },
  about: {
    path: '/about',
    sections: ['page-hero', 'team', 'shield-divider', 'impact', 'services', 'qa', 'reviews', 'consultation'],
  },
  pricing: {
    path: '/pricing',
    sections: ['page-hero', 'shield-divider', 'pricing', 'qa', 'services', 'consultation'],
  },
  contact: {
    path: '/contact',
    sections: ['page-hero', 'shield-divider', 'contact', 'qa', 'reviews', 'consultation'],
  },
  schedule: {
    path: '/schedule',
    sections: ['page-hero', 'guidance', 'qa', 'reviews', 'consultation'],
  },
  blog: {
    path: '/blog',
    sections: ['page-hero', 'shield-divider', 'articles', 'disclaimer', 'qa', 'consultation'],
  },
  article: {
    path: '/article/preparing-for-your-consultation-with-north-carolina-legal-services',
    sections: ['article-content', 'related-articles', 'related-articles-more', 'consultation'],
  },
  donate: {
    path: '/donate',
    sections: ['page-hero', 'shield-divider', 'donation', 'qa'],
  },
  privacy: {
    path: '/policies/privacy',
    sections: ['page-hero', 'legal-content'],
  },
  terms: {
    path: '/policies/terms',
    sections: ['page-hero', 'legal-content'],
  },
  notices: {
    path: '/third-party-notices',
    sections: ['page-hero', 'notices', 'consultation'],
  },
}

