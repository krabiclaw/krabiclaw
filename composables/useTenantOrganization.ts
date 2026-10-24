import type { SocialImageSource } from '~/utils/social-metadata'
import type { OrganizationFontPreset } from '~/shared/organization-fonts'
import type { SitePalette } from '~/shared/site-palette'
import type { SiteLogo } from '~/shared/media-placement-contract'
import type { PublicTemplateDefinition } from '~/utils/template-registry'
import type { SiteRecipe } from '~/shared/site-recipe'

export type { SiteRecipe }

export interface TenantContext {
  organization: TenantOrganizationInfo
  previewAuthorized: boolean
}


export interface TenantOrganizationInfo {
  id: string
  subdomain: string
  name: string
  theme_id: string
  vertical: string
  template: PublicTemplateDefinition
  fontPreset: OrganizationFontPreset
  palette: SitePalette | null
  recipe?: SiteRecipe
  logos: SiteLogo[]
  brand_description: string | null
  media: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string; mime_type: string | null }>
  social_image: SocialImageSource | null
  social_profiles: Array<{ network: 'facebook' | 'instagram'; url: string }>
  policies: Array<'privacy' | 'terms' | 'acceptable-use'>
}

// The rendering organization is resolved once from the request host and travels
// with the Nuxt payload so hydration reads the same public identity as SSR.
export const useTenantOrganization = (): TenantContext => {
  const event = useRequestEvent()
  const tenantContext = useState<TenantContext>('tenant-context', () => {
    if (!event?.context.organization) {
      throw createError({ statusCode: 500, statusMessage: 'Tenant context unavailable', fatal: true })
    }
    return {
      organization: event.context.organization as TenantOrganizationInfo,
      previewAuthorized: event.context.previewAuthorized === true,
    }
  })
  if (!tenantContext.value) {
    throw createError({ statusCode: 500, statusMessage: 'Tenant context unavailable', fatal: true })
  }
  return tenantContext.value
}
