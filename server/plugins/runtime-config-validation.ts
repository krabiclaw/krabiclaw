import { definePlugin } from 'nitro';
import { useRuntimeConfig } from 'nitro/runtime-config'

export default definePlugin(() => {
  const config = useRuntimeConfig()
  
  // Required public environment variables
  const requiredPublicVars = [
    { key: 'public.platformDomain', env: 'NUXT_PUBLIC_PLATFORM_DOMAIN' },
    { key: 'public.freeOrganizationDomain', env: 'NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN' },
    { key: 'public.appName', env: 'NUXT_PUBLIC_APP_NAME' },
    { key: 'public.siteUrl', env: 'NUXT_PUBLIC_SITE_URL' },
  ]


  
  const missingVars: string[] = []
  
  // Check public variables
  for (const { key, env } of requiredPublicVars) {
    const value = getNestedValue(config, key)
    if (!value || value.trim() === '') {
      missingVars.push(env)
    }
  }
  

  
  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables:\n` +
      missingVars.map(env => `  - ${env}`).join('\n') +
      `\n\nPlease set these environment variables and restart the server.\n` +
      `See .env.example for required values.`
    )
  }
})

// Helper function to get nested object values by string path
function getNestedValue(obj: ApiValue, path: string): string {
  return path.split('.').reduce((current, key) => current?.[key], obj) || ''
}
