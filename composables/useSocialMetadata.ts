import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { defineHowTo, useSchemaOrg } from '#imports'
import { videoObjectNodes } from '~/shared/youtube-video'
import {
  composeSocialMetadata,
  resolveSeoUrl,
  type SocialPageMetadataInput,
} from '~/utils/social-metadata'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import type { TenantPageHowToData } from '~/utils/tenant-page-blocks'
import { markdownToPlainText } from '~/utils/markdown'
import { isDemoHost, isDemoOrganization } from '~/shared/demo'

export interface PageBreadcrumb {
  name: string
  url: string
}

export interface PageFaqItem {
  question: string
  answer?: string | null
}

export type SchemaPageType =
  | 'WebPage'
  | 'AboutPage'
  | 'ContactPage'
  | 'CollectionPage'
  | 'ItemPage'
  | 'SoftwareApplication'

export interface PageProfessionalServiceInput {
  recipe: string | null
  offering?: {
    name: string
    description?: string | null
  }
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
  breadcrumbs?: PageBreadcrumb[]
  schemaPageType?: SchemaPageType
  schemaNodes?: ApiRecord[]
  faqItems?: PageFaqItem[]
  contentBlocks?: ReadonlyArray<{ id: string; type: string; data: Record<string, unknown> }>
  article?: {
    type: 'BlogPosting' | 'TechArticle' | 'Article'
    authorType?: 'Person' | 'Organization'
    dateModified?: string | null
    imageUrl?: string | null
    imageWidth?: number | null
    imageHeight?: number | null
    articleSection?: string | null
    keywords?: string | null
    inLanguage: string
  }
  softwareApplication?: {
    applicationCategory?: string
    operatingSystem?: string
    offers?: ApiRecord
  }
  professionalService?: PageProfessionalServiceInput
  schema?: boolean
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
  const { organization, previewAuthorized } = useTenantOrganization()
  const shell = organization.template.slug === 'platform' ? null : useOrganizationShellState()
  const publicLocale = useState<string>('public-locale', () => 'en')
  const localeRepresentations = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])

  const normalized = computed(() => {
    const value = toValue(input)
    if (!value) return null
    const template = organization.template.slug
    const origin = template === 'platform'
      ? config.public.siteUrl
      : requestURL.origin
    const privatePage = value.discoverability === 'private'
    const exactRepresentation = privatePage ? undefined : localeRepresentations.value.find(item => item.locale === publicLocale.value)
    if (!privatePage && publicLocale.value !== 'en' && !exactRepresentation) {
      throw createError({ statusCode: 404, statusMessage: 'Localized route representation was not found' })
    }
    const canonicalUrl = resolveSeoUrl(value.canonicalPath ?? exactRepresentation?.route_path ?? value.path, origin)
    const brand = { organizationName: organization.name }
    const socialInput: SocialPageMetadataInput = {
      ...value,
      template,
      brand,
      pageType: value.pageType || 'website',
      canonicalUrl,
      // A preview is the owner looking at their own unpublished work on the
      // real host, and the demo showcase site is not a real business.
      // Whatever the page would otherwise say about itself, nothing
      // reached this way is Google's to keep — and deciding it here means no
      // page can be added that forgets to.
      discoverability: previewAuthorized || isDemoHost(requestURL.hostname) || isDemoOrganization(organization)
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
    if (!normalized.value) return []
    const { value, origin, template, tags } = normalized.value
    if (value.schema === false || value.discoverability === 'private') return []
    const blocks = (value.contentBlocks ?? []).filter(block =>
      block.data.status !== 'inactive' && block.data.render_enabled !== false && block.data.schema_enabled !== false,
    )
    const videos = videoObjectNodes(blocks, tags.canonicalUrl)
    const shouldEmitSchema = (
      template === 'platform'
      || value.schema === true
      || Boolean(value.breadcrumbs?.length)
      || Boolean(value.faqItems?.length)
      || Boolean(value.schemaNodes?.length)
      || blocks.some(block => block.type === 'how_to' || block.type === 'faq')
      || Boolean(videos.length)
      || Boolean(value.article)
      || Boolean(value.softwareApplication)
      || Boolean(value.professionalService)
    )
    if (!shouldEmitSchema) return []

    const organizationRoot = resolveSeoUrl('/', origin).replace(/\/$/, '')
    const websiteId = `${organizationRoot}/#website`
    const organizationId = `${organizationRoot}/#organization`
    const url = tags.canonicalUrl
    const webpageId = `${url}#webpage`
    const logo = organization.logos.find(item => item.slot === 'logo')?.url
    const organizationNode: ApiRecord = {
      '@type': 'Organization',
      '@id': organizationId,
      name: organization.name,
      url: organizationRoot,
      logo: logo ? resolveSeoUrl(logo, origin) : undefined,
      description: organization.brand_description,
    }
    const recipe = value.professionalService?.recipe
    const webpageNode: ApiRecord = {
      '@type': value.schemaPageType ?? (recipe === 'about' ? 'AboutPage' : recipe === 'contact' ? 'ContactPage' : recipe === 'services' || recipe === 'blog-index' ? 'CollectionPage' : 'WebPage'),
      '@id': webpageId,
      url,
      name: value.title,
      description: value.description,
      isPartOf: { '@id': websiteId },
      primaryImageOfPage: value.socialImage ? resolveSeoUrl(value.socialImage.url, origin) : undefined,
    }
    const graph: ApiRecord[] = [organizationNode, {
      '@type': 'WebSite',
      '@id': websiteId,
      url: organizationRoot,
      name: organization.name,
      description: organization.brand_description,
      publisher: { '@id': organizationId },
    }, webpageNode]
    if (value.breadcrumbs?.length) {
      const breadcrumbId = `${url}#breadcrumb`
      webpageNode.breadcrumb = { '@id': breadcrumbId }
      graph.push({
        '@type': 'BreadcrumbList',
        '@id': breadcrumbId,
        itemListElement: value.breadcrumbs.map((item, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: item.name,
          item: resolveSeoUrl(item.url, origin),
        })),
      })
    }

    if (value.professionalService) {
      const compliance = shell?.compliance.value
      organizationNode['@type'] = ['Organization', compliance?.entity_type ?? 'ProfessionalService']
      if (compliance) {
        Object.assign(organizationNode, {
          areaServed: compliance.service_area_type && compliance.service_area
            ? { '@type': compliance.service_area_type, name: compliance.service_area }
            : compliance.service_area,
          nonprofitStatus: compliance.nonprofit_status,
          sameAs: compliance.same_as,
          founder: compliance.founder_name ? { '@type': 'Person', name: compliance.founder_name } : undefined,
          foundingDate: compliance.founding_date,
          contactPoint: compliance.contact_points.filter(point => point.telephone || point.email || point.url).map(point => ({
            '@type': 'ContactPoint',
            contactType: point.contact_type,
            telephone: point.telephone,
            email: point.email,
            areaServed: point.area_served,
            availableLanguage: point.available_language,
            url: point.url,
          })),
        })
      }
      if (recipe === 'home' || recipe === 'contact') webpageNode.mainEntity = { '@id': organizationId }
      if (recipe === 'service-detail' && value.professionalService?.offering) {
        const offering = value.professionalService.offering
        const serviceId = `${url}#service`
        graph.push({
          '@type': 'Service',
          '@id': serviceId,
          name: offering.name,
          description: offering.description,
          url,
          provider: { '@id': organizationId },
        })
        webpageNode.mainEntity = { '@id': serviceId }
      }
      const items = blocks.filter(block => block.type === 'page_grid').flatMap(block =>
        block.data.items as Array<{ title: string; description?: string | null; url?: string | null }>,
      )
      if (items.length) {
        const itemListId = `${url}#itemlist`
        graph.push({
          '@type': 'ItemList',
          '@id': itemListId,
          itemListElement: items.map((item, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: item.title,
            description: item.description,
            url: item.url ? resolveSeoUrl(item.url, origin) : undefined,
          })),
        })
        if (recipe === 'services' || recipe === 'blog-index') webpageNode.mainEntity = { '@id': itemListId }
        else webpageNode.hasPart = [{ '@id': itemListId }]
      }
      if (recipe === 'donate') {
        const actions = blocks.filter(block => block.type === 'donation_choices' && block.data.destination).map(block => ({
          '@type': 'DonateAction',
          target: resolveSeoUrl(block.data.destination as string, origin),
          recipient: { '@id': organizationId },
        }))
        if (actions.length) webpageNode.potentialAction = actions
      }
      if (recipe === 'schedule' && shell?.canSchedule.value && shell.consultation.value) {
        const consultation = shell.consultation.value
        webpageNode.potentialAction = {
          '@type': 'ScheduleAction',
          target: consultation.mode === 'external_url' ? consultation.external_url : url,
        }
      }
    }

    if (value.schemaPageType === 'SoftwareApplication' && value.softwareApplication) {
      Object.assign(webpageNode, value.softwareApplication)
    }
    if (value.article) {
      const articleId = `${url}#article`
      const imageUrl = value.article.imageUrl ? resolveSeoUrl(value.article.imageUrl, origin) : undefined
      const image = imageUrl && value.article.imageWidth && value.article.imageHeight
        ? { '@type': 'ImageObject', url: imageUrl, width: value.article.imageWidth, height: value.article.imageHeight }
        : imageUrl
      webpageNode.mainEntity = { '@id': articleId }
      if (image) webpageNode.primaryImageOfPage = image
      graph.push({
        '@type': value.article.type,
        '@id': articleId,
        headline: value.title,
        description: value.description,
        url,
        mainEntityOfPage: { '@id': webpageId },
        publisher: { '@id': organizationId },
        isPartOf: { '@id': websiteId },
        inLanguage: value.article.inLanguage,
        image,
        author: value.author ? { '@type': value.article.authorType ?? 'Person', name: value.author } : undefined,
        datePublished: value.publishedAt,
        dateModified: value.article.dateModified,
        articleSection: value.article.articleSection,
        keywords: value.article.keywords,
      })
    }

    const parts: ApiRecord[] = [...(value.schemaNodes ?? []), ...videos]
    const faqs = [
      ...(value.faqItems ?? []),
      ...blocks.filter(block => block.type === 'faq').flatMap(block =>
        (block.data.items as Array<{ title: string; description?: string | null }>).map(item => ({ question: item.title, answer: item.description })),
      ),
    ].filter((item): item is { question: string; answer: string } => Boolean(item.question.trim() && item.answer?.trim()))
    if (faqs.length) {
      parts.push({
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: faqs.map(item => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: { '@type': 'Answer', text: markdownToPlainText(item.answer) },
        })),
      })
    }
    for (const block of blocks.filter(block => block.type === 'how_to')) {
      const howTo = block.data as TenantPageHowToData
      parts.push({
        ...defineHowTo(),
        '@id': `${url}#howto-${block.id}`,
        name: howTo.title?.trim() || undefined,
        description: howTo.description,
        step: howTo.steps.map((step, index) => ({
          '@type': 'HowToStep',
          position: index + 1,
          name: step.name,
          text: step.text,
        })),
        totalTime: howTo.estimated_time,
        tool: howTo.tool_items?.map(name => ({ '@type': 'HowToTool', name })),
        supply: howTo.supply_items?.map(name => ({ '@type': 'HowToSupply', name })),
      })
    }
    const hasPart = webpageNode.hasPart ? [webpageNode.hasPart].flat() as ApiRecord[] : []
    for (const node of parts) {
      if (!node['@id']) throw new Error('Supplementary schema requires a stable ID')
      if (value.schemaPageType === 'CollectionPage' && node['@type'] === 'ItemList') webpageNode.mainEntity = { '@id': node['@id'] }
      else hasPart.push({ '@id': node['@id'] })
    }
    if (hasPart.length) webpageNode.hasPart = hasPart
    graph.push(...parts)
    return graph
  }))
}
