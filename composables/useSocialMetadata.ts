import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { resolveSeoUrl } from '~/composables/useSeoUrls'
import { useSchemaOrg } from '~/composables/useSchemaOrg'
import {
  composeSocialMetadata,
  type SocialBrand,
  type SocialPageMetadataInput,
  type SocialPageType,
  type SocialTemplate,
} from '~/utils/social-metadata'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { isDemoHost, isDemoOrg } from '~/shared/demo'
import {
  buildProfessionalServiceGraph,
  type ProfessionalServiceSchemaInput,
} from '~/utils/professional-service-schema'

export interface PageBreadcrumb {
  name: string
  url: string
}

export interface PageFaqItem {
  question: string
  answer: string
}

export type SchemaPageType =
  | 'WebPage'
  | 'AboutPage'
  | 'ContactPage'
  | 'CollectionPage'
  | 'ItemPage'
  | 'SoftwareApplication'

export type PageProfessionalServiceInput = Omit<ProfessionalServiceSchemaInput, 'origin' | 'pageUrl' | 'pageTitle'> & {
  pageUrl?: string
  pageTitle?: string
}

export type PageSocialMetadataInput = Omit<SocialPageMetadataInput, 'template' | 'canonicalUrl' | 'brand'> & {
  path: string
  /**
   * Canonical target when this page is deliberately not its own canonical
   * resource — e.g. a catalogue row with no price at all, which canonicalises
   * to its collection index rather than competing with it.
   *
   * Wins over both `path` and the active locale's route representation: the
   * representation resolves *this* resource in another locale, which is the
   * wrong axis when the canonical target is a different resource entirely.
   * Supply it already localized.
   */
  canonicalPath?: string
  template?: SocialTemplate
  brand?: SocialBrand
  breadcrumbs?: PageBreadcrumb[]
  schemaPageType?: SchemaPageType
  schemaNodes?: ApiRecord[]
  faqItems?: PageFaqItem[]
  softwareApplication?: {
    applicationCategory?: string
    operatingSystem?: string
    offers?: ApiRecord
  }
  professionalService?: PageProfessionalServiceInput
  isHomepage?: boolean
  socialType?: SocialPageType
  schema?: boolean
}

const PLATFORM_NAME = 'Krabiclaw'
const PLATFORM_DESCRIPTION = 'The AI-powered website builder for local businesses. Build your web presence through conversation with ChatGPT.'

function requireMetadata<T>(resolved: T | null): T {
  if (!resolved) throw new Error('useSocialMetadata: no page metadata to read')
  return resolved
}

/**
 * The single metadata entry point for every public page.
 *
 * `null` means there is no page to describe yet — a tenant page whose request
 * is still in flight, or one whose instance the router has already left. The
 * head stays untouched until there is, rather than describing a placeholder.
 */
export function useSocialMetadata(input: MaybeRefOrGetter<PageSocialMetadataInput | null>) {
  const config = useRuntimeConfig()
  const requestURL = useRequestURL()
  const tenant = useTenantOrganization()
  const publicLocale = useState<string>('public-locale', () => 'en')
  const localeRepresentations = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])

  const normalized = computed(() => {
    const value = toValue(input)
    if (!value) return null
    const template = value.template ?? tenant.template.slug
    const origin = template === 'platform'
      ? config.public.siteUrl
      : requestURL.origin
    const privatePage = value.discoverability === 'private'
    const exactRepresentation = privatePage ? undefined : localeRepresentations.value.find(item => item.locale === publicLocale.value)
    if (!privatePage && publicLocale.value !== 'en' && !exactRepresentation) {
      throw createError({ statusCode: 404, statusMessage: 'Localized route representation was not found' })
    }
    const canonicalUrl = resolveSeoUrl(value.canonicalPath ?? exactRepresentation?.route_path ?? value.path, origin)
    const brand = value.brand ?? (template === 'platform'
      ? {
          organizationName: PLATFORM_NAME,
        }
      : { organizationName: '' })
    const socialInput: SocialPageMetadataInput = {
      ...value,
      template,
      brand,
      pageType: value.socialType || value.pageType || 'website',
      canonicalUrl,
      // A preview is the owner looking at their own unpublished work on the
      // real host, and the demo showcase site is not a real business.
      // Whatever the page would otherwise say about itself, nothing
      // reached this way is Google's to keep — and deciding it here means no
      // page can be added that forgets to.
      discoverability: tenant.previewAuthorized || isDemoHost(requestURL.hostname) || isDemoOrg(tenant.organizationId)
        ? 'private'
        : value.discoverability,
    }
    const image = value.socialImage
    const resolvedImage = image
      ? { ...image, url: resolveSeoUrl(image.url, origin), alt: image.alt || value.title }
      : null
    return { value, origin, template, tags: composeSocialMetadata(socialInput, resolvedImage) }
  })

  useHead(() => {
    const resolved = normalized.value
    if (!resolved) return {}
    const alternateLinks: Array<{ rel: 'alternate'; hreflang: string; href: string }> = (resolved.value.discoverability === 'private' ? [] : localeRepresentations.value).map(representation => ({
      rel: 'alternate',
      hreflang: representation.locale,
      href: resolveSeoUrl(representation.route_path, resolved.origin),
    }))
    const canonicalLink: { rel: 'canonical'; href: string } = {
      rel: 'canonical',
      href: resolved.tags.canonicalUrl,
    }
    return {
      title: resolved.tags.title,
      meta: [
      { name: 'description', content: resolved.tags.description },
      { property: 'og:title', content: resolved.tags.ogTitle },
      { property: 'og:description', content: resolved.tags.ogDescription },
      { property: 'og:type', content: resolved.tags.ogType },
      { property: 'og:url', content: resolved.tags.ogUrl },
      ...(resolved.tags.ogSiteName ? [{ property: 'og:site_name', content: resolved.tags.ogSiteName }] : []),
      { property: 'og:image', content: resolved.tags.ogImage },
      { property: 'og:image:width', content: resolved.tags.ogImageWidth },
      { property: 'og:image:height', content: resolved.tags.ogImageHeight },
      { property: 'og:image:type', content: resolved.tags.ogImageType },
      { property: 'og:image:alt', content: resolved.tags.ogImageAlt },
      { name: 'twitter:card', content: resolved.tags.twitterCard },
      { name: 'twitter:title', content: resolved.tags.twitterTitle },
      { name: 'twitter:description', content: resolved.tags.twitterDescription },
      { name: 'twitter:image', content: resolved.tags.twitterImage },
      { name: 'twitter:image:alt', content: resolved.tags.twitterImageAlt },
      { property: 'article:author', content: resolved.tags.articleAuthor },
      { property: 'article:published_time', content: resolved.tags.articlePublishedTime },
      { name: 'robots', content: resolved.tags.robots },
      ].filter(item => item.content !== undefined),
      link: [
        canonicalLink,
        ...alternateLinks,
      ],
    }
  })

  useSchemaOrg(computed(() => {
    if (!normalized.value) return null
    const { value, origin, template, tags } = normalized.value
    const isArticleCollection = value.schemaPageType === 'CollectionPage' && value.schemaNodes?.some(node => node['@type'] === 'ItemList')
    const shouldEmitSchema = value.schema !== false && (
      template === 'platform'
      || isArticleCollection
      || value.schema === true
      || Boolean(value.breadcrumbs?.length)
      || Boolean(value.faqItems?.length)
      || Boolean(value.schemaNodes?.length)
      || Boolean(value.softwareApplication)
      || Boolean(value.professionalService)
    )
    if (!shouldEmitSchema) return null

    if (value.professionalService) {
      if (!value.professionalService.org?.name) return null
      const serviceGraph = buildProfessionalServiceGraph({
        ...value.professionalService,
        origin,
        pageUrl: value.professionalService.pageUrl ?? tags.canonicalUrl,
        pageTitle: value.professionalService.pageTitle ?? value.title,
        pageDescription: value.professionalService.pageDescription ?? value.description,
        breadcrumbs: value.professionalService.breadcrumbs ?? value.breadcrumbs,
        faqs: value.professionalService.faqs ?? value.faqItems,
        imageUrl: value.professionalService.imageUrl ?? (value.socialImage ? resolveSeoUrl(value.socialImage.url, origin) : undefined),
      })
      return serviceGraph as unknown as ApiRecord
    }
    const organizationRoot = resolveSeoUrl('/', origin).replace(/\/$/, '')
    const websiteId = `${organizationRoot}/#website`
    const organizationId = `${organizationRoot}/#organization`
    const url = tags.canonicalUrl
    const webpageId = `${url}#webpage`
    const breadcrumbId = `${url}#breadcrumb`
    const graph: ApiRecord[] = []
    const publisherName = template === 'platform' ? PLATFORM_NAME : tenant.organization?.name?.trim()
    if (!publisherName) throw new Error('Structured schema requires the organization or platform name')
    const publisherDescription = template === 'platform' ? PLATFORM_DESCRIPTION : tenant.organization?.brand_description || undefined
    const publisherLogo = template === 'platform' ? `${organizationRoot}/krabi-claw-logo.png` : tenant.logoUrl

    graph.push({
      '@type': 'Organization',
      '@id': organizationId,
      name: publisherName,
      url: organizationRoot,
      logo: publisherLogo ? resolveSeoUrl(publisherLogo, origin) : undefined,
      description: publisherDescription,
    })
    graph.push({
      '@type': 'WebSite',
      '@id': websiteId,
      url: organizationRoot,
      name: publisherName,
      description: publisherDescription,
      publisher: { '@id': organizationId },
    })

    const webpageNode: ApiRecord = {
      '@type': value.schemaPageType || 'WebPage',
      '@id': webpageId,
      url,
      name: value.title,
      description: value.description || undefined,
      isPartOf: { '@id': websiteId },
    }
    const breadcrumbItems = (value.breadcrumbs ?? [])
      .filter(item => item?.name && item?.url)
      .map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: resolveSeoUrl(item.url, origin),
      }))
    if (breadcrumbItems.length) webpageNode.breadcrumb = { '@id': breadcrumbId }

    if (value.schemaPageType === 'SoftwareApplication' && value.softwareApplication) {
      webpageNode.applicationCategory = value.softwareApplication.applicationCategory
      webpageNode.operatingSystem = value.softwareApplication.operatingSystem
      if (value.softwareApplication.offers) webpageNode.offers = value.softwareApplication.offers
    }

    const hasPart: Array<{ '@id': string }> = []
    if (value.faqItems?.length) {
      const faqId = `${url}#faq`
      hasPart.push({ '@id': faqId })
      graph.push({
        '@type': 'FAQPage',
        '@id': faqId,
        mainEntity: value.faqItems
          .filter(item => item.question?.trim() && item.answer?.trim())
          .map(item => ({
            '@type': 'Question',
            name: item.question.trim(),
            acceptedAnswer: { '@type': 'Answer', text: item.answer.trim() },
          })),
      })
    }
    if (value.schemaNodes?.length) {
      for (const node of value.schemaNodes) {
        if (node?.['@id']) {
          if (value.schemaPageType === 'CollectionPage' && node['@type'] === 'ItemList') webpageNode.mainEntity = { '@id': node['@id'] }
          else hasPart.push({ '@id': node['@id'] })
        }
      }
      graph.push(...value.schemaNodes)
    }
    if (hasPart.length) webpageNode.hasPart = hasPart.length === 1 ? hasPart[0] : hasPart
    graph.push(webpageNode)
    if (breadcrumbItems.length) {
      graph.push({ '@type': 'BreadcrumbList', '@id': breadcrumbId, itemListElement: breadcrumbItems })
    }
    return { '@context': 'https://schema.org', '@graph': graph }
  }))

  return {
    // Only a caller that passed a page has metadata to read back. Reading
    // these without one is a bug in the caller, not an absent value.
    canonicalUrl: computed(() => requireMetadata(normalized.value).tags.canonicalUrl),
    ogImageUrl: computed(() => requireMetadata(normalized.value).tags.ogImage),
  }
}
