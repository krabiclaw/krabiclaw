import type { TenantType } from '~/utils/tenant-routing'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import type { SocialImageSource } from '~/utils/social-metadata'
import type { OrganizationFontPreset } from '~/shared/organization-fonts'
import type { SitePalette } from '~/shared/site-palette'
import type { SiteLogo } from '~/shared/media-placement-contract'

interface TenantOrganizationState {
  tenantType: TenantType | null
  previewAuthorized: boolean
  organizationId: string | null
  themeId: string | null
  fontPreset: OrganizationFontPreset
  /** The colors a Saya or Blawby site renders; null on the platform. */
  palette: SitePalette | null
  logos: SiteLogo[]
  organization: TenantOrganizationInfo | null
}

interface TenantOrganizationInfo {
  name?: string | null
  brand_description?: string | null
  media?: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string; mime_type: string | null }>
  social_image?: SocialImageSource | null
  vertical?: string | null
  social_profiles?: Array<{ network: 'facebook' | 'instagram'; url: string }>
  policies?: Array<'privacy' | 'terms'>
  config?: {
    phone?: string | null
  } | null
}

// The rendering tenant, resolved from the host by tenant-resolution. There used
// to be a `organizationId` beside `organizationId` here, and every public request
// carried both: they named the same tenant, and a route that took the id from
// its path could be asked for one tenant on another's domain.
export const useTenantOrganization = () => {
  const event = useRequestEvent()

  // Get tenant context from middleware on the server, then reuse the serialized
  // Nuxt state on the client so SSR and hydration choose the same site shell.
  const tenantContext = useState<TenantOrganizationState>('tenant-context', () => {
    if (event) {
      return {
        tenantType: (event.context.tenantType as TenantType | undefined) ?? null,
        previewAuthorized: event.context.previewAuthorized === true,
        organizationId: typeof event.context.organizationId === 'string' ? event.context.organizationId : null,
        themeId: typeof event.context.themeId === 'string' ? event.context.themeId : null,
        fontPreset: (event.context.fontPreset as OrganizationFontPreset | undefined) ?? 'default',
        palette: (event.context.palette as SitePalette | null | undefined) ?? null,
        logos: (event.context.logos as SiteLogo[] | undefined) ?? [],
        organization: (event.context.organization as TenantOrganizationInfo | null | undefined) ?? null
      }
    }
    return {
      tenantType: null,
      previewAuthorized: false,
      organizationId: null,
      themeId: null,
      fontPreset: 'default',
      palette: null,
      logos: [],
      organization: null
    }
  })

  return {
    tenantType: tenantContext.value.tenantType,
    isPlatform: tenantContext.value.tenantType === TENANT_TYPES.PLATFORM,
    isTenant: tenantContext.value.tenantType === TENANT_TYPES.TENANT,
    previewAuthorized: tenantContext.value.previewAuthorized,
    organizationId: tenantContext.value.organizationId,
    themeId: tenantContext.value.themeId,
    fontPreset: tenantContext.value.fontPreset,
    palette: tenantContext.value.palette,
    logos: tenantContext.value.logos,
    organization: tenantContext.value.organization
  }
}
