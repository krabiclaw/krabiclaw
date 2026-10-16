// The organizations the authenticated user belongs to.
import { cloudflareEnv, jsonResponse } from '../utils/api-response'
import { getAuthSession } from '../utils/auth'
import { defineHandler } from 'nitro';
import { queryAll } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { listUserOrganizations } from '~/server/utils/member-access'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  
  if (!db) {
    return jsonResponse({ 
      error: 'Database not available' 
    }, { status: 500 })
  }
  
  const session = await getAuthSession(event, env)
  
  if (!session?.user?.id) {
    return jsonResponse({ 
      error: 'Authentication required' 
    }, { status: 401 })
  }
  
  const userId = session.user.id

  try {
    // Get user's organization
    const organization = await listUserOrganizations(env, userId)

    if (!organization || organization.length === 0) {
      return jsonResponse({
        organizations: []
      })
    }

    const orgIds = organization.map((org: ApiValue) => org.id)

    const organizations = await queryAll(db, `
      SELECT id, theme_id, name, slug, subdomain,
             (SELECT domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active' AND type = 'custom') AS custom_domain, status, "createdAt" AS created_at, updated_at,
             onboarding_status
      FROM organization
      WHERE id IN (SELECT value FROM json_each(?))
      ORDER BY "createdAt" DESC
    `, [d1JsonStringSet(orgIds)])

    return jsonResponse({
      organizations: organizations || []
    })
    
  } catch (error) {
    console.error('Failed to fetch organizations:', error)
    return jsonResponse({ 
      error: 'Failed to fetch organizations' 
    }, { status: 500 })
  }
})
