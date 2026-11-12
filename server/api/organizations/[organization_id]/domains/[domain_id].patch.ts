import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { execute, queryFirst } from '~/server/db'
import { setCanonicalDomain } from '~/server/utils/domains'
import { requireOrganizationAccess } from '~/server/utils/location-access'

interface DomainPatchBody {
  role?: 'canonical'
  status?: 'disabled'
}

interface OrganizationDomainRow {
  id: string
  organization_id: string
  domain: string
  type: 'custom' | 'subdomain'
  role: 'canonical' | 'secondary'
  status: string
  created_at: string
}

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const domainId = getRouterParam(event, 'domain_id')
  let body: DomainPatchBody
  try {
    body = await readRequiredBody<DomainPatchBody>(event)
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!organizationId || !domainId) return jsonResponse({ error: 'Organization ID and domain ID are required' }, { status: 400 })
  if (body.role && body.status) {
    return jsonResponse({ error: 'Provide only one of role or status' }, { status: 400 })
  }
  if (body.role && body.role !== 'canonical') {
    return jsonResponse({ error: 'Unsupported role value' }, { status: 400 })
  }

  const { db, session, organization } = await requireOrganizationAccess(event, organizationId)

  try {
    if (body.role === 'canonical') {
      const actorRole = organization.member_role as 'owner' | 'admin'
      const domain = await setCanonicalDomain(db, organizationId, domainId, actorRole, session.user.id)
      return jsonResponse({ success: true, domain })
    }

    if (body.status === 'disabled') {
      const now = new Date().toISOString()
      let promotedDomain: OrganizationDomainRow | null = null

      const existing = await queryFirst<OrganizationDomainRow>(db, `
        SELECT *
        FROM organization_domains
        WHERE id = ? AND organization_id = ? AND type = 'custom'
        LIMIT 1
      `, [domainId, organizationId])
      if (!existing) {
        return jsonResponse({ error: 'Domain not found' }, { status: 404 })
      }

      const priorCanonical = await queryFirst<OrganizationDomainRow>(db, `
        SELECT * FROM organization_domains WHERE organization_id = ? AND role = 'canonical' LIMIT 1
      `, [organizationId])

      try {
        await execute(db, `
          UPDATE organization_domains
          SET status = 'disabled', role = 'secondary', updated_at = ?
          WHERE id = ? AND organization_id = ? AND type = 'custom'
        `, [now, domainId, organizationId])

        if (existing.role === 'canonical') {
          promotedDomain = await queryFirst<OrganizationDomainRow>(db, `
            SELECT *
            FROM organization_domains
            WHERE organization_id = ?
              AND type = 'custom'
              AND status = 'active'
              AND id != ?
            ORDER BY created_at ASC
            LIMIT 1
          `, [organizationId, domainId])

          if (promotedDomain) {
            await execute(db, `
              UPDATE organization_domains
              SET role = 'canonical', updated_at = ?
              WHERE id = ?
            `, [now, promotedDomain.id])
          }
        }
      } catch (error) {
        if (priorCanonical) {
          await execute(db, `
            UPDATE organization_domains
            SET role = 'canonical', updated_at = ?
            WHERE id = ?
          `, [now, priorCanonical.id])
        }
        throw error
      }

      const domain = await queryFirst<OrganizationDomainRow>(db, `
        SELECT * FROM organization_domains
        WHERE id = ? AND organization_id = ? AND type = 'custom'
        LIMIT 1
      `, [domainId, organizationId])

      if (!domain) return jsonResponse({ error: 'Domain not found' }, { status: 404 })
      return jsonResponse({ success: true, domain, promoted_domain: promotedDomain || null })
    }

    return jsonResponse({ error: 'No supported update provided' }, { status: 400 })
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Unknown error')
    console.error('domain_update_failed', {
      organizationId, domainId, userId: session.user.id, body, error: normalizedError.message, stack: normalizedError.stack || null
    })
    return jsonResponse({ error: 'Failed to update domain' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam  } from 'nitro/h3';
