import type { TenantType } from '~/utils/tenant-routing'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import type { SocialImageSource } from '~/utils/social-metadata'
import type { OrganizationFontPreset } from '~/shared/organization-fonts'
import type { SitePalette } from '~/shared/site-palette'
import type { SiteLogo } from '~/shared/media-placement-contract'
import { publicTemplateRegistry, type PublicTemplateDefinition, type PublicTemplateSlug } from '~/utils/template-registry'

export interface TenantContext {
  tenantType: TenantType
  isPlatform: boolean
  isTenant: boolean
  previewAuthorized: boolean
  organizationId: string
  themeId: string
  templateSlug: PublicTemplateSlug
  template: PublicTemplateDefinition
  fontPreset: OrganizationFontPreset
  palette: SitePalette | null
  logos: SiteLogo[]
  logoUrl: string | null
  socialImage: SocialImageSource | null
  organization: TenantOrganizationInfo
}

export interface TenantOrganizationInfo {
  id: string
  name: string
  theme_id: string
  vertical: string | null
  template: PublicTemplateDefinition
  fontPreset: OrganizationFontPreset
  palette: SitePalette | null
  logos: SiteLogo[]
  logoUrl: string | null
  socialImage: SocialImageSource | null
  brand_description?: string | null
  media?: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string; mime_type: string | null }>
  social_image?: SocialImageSource | null
  social_profiles?: Array<{ network: 'facebook' | 'instagram'; url: string }>
  policies?: Array<'privacy' | 'terms'>
  config?: {
    phone?: string | null
  } | null
}

// The rendering tenant, resolved from the host by tenant-resolution.
export const useTenantOrganization = (): TenantContext => {
  const event = useRequestEvent()

  const tenantContext = useState<TenantContext>('tenant-context', () => {
    if (!event?.context.organization || !event.context.tenantType) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Tenant context unavailable',
        fatal: true,
      })
    }

    const ctx = event.context
    const org = ctx.organization as TenantOrganizationInfo
    const template = org.template ?? publicTemplateRegistry[ctx.templateSlug as PublicTemplateSlug] ?? publicTemplateRegistry.saya
    const isPlatform = template.slug === 'platform'

    return {
      tenantType: isPlatform ? TENANT_TYPES.PLATFORM : TENANT_TYPES.TENANT,
      isPlatform,
      isTenant: !isPlatform,
      previewAuthorized: ctx.previewAuthorized === true,
      organizationId: org.id,
      themeId: org.theme_id,
      templateSlug: template.slug,
      template,
      fontPreset: org.fontPreset ?? 'default',
      palette: org.palette ?? null,
      logos: org.logos ?? [],
      logoUrl: org.logoUrl ?? null,
      socialImage: org.socialImage ?? null,
      organization: org,
    }
  })

  if (!tenantContext.value) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Tenant context uninitialized',
      fatal: true,
    })
  }

  return tenantContext.value
}
