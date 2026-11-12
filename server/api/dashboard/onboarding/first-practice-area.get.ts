import { defineHandler, HTTPError } from 'nitro'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { catalogPath, firstPracticeAreaPath } from '~/server/utils/dashboard-links'
import { listOrganizationProducts } from '~/server/utils/product-management'

const handler = defineHandler(async (event) => {
  const { db, organization } = await getDashboardMemberContext(event, {})
  if (organization.vertical !== 'service' || organization.onboarding_status !== 'active') {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Practice area setup is unavailable' })
  }
  await assertRoleAllows({ ...organization, permissions: { products: ['create'] } })
  const areas = await listOrganizationProducts(db, { organizationId: organization.id, kind: 'service', window: { limit: 1, offset: 0 } })
  const guide = firstPracticeAreaPath(organization.slug)
  if (areas.length === 1 && organization.status === 'inactive') return { catalog_url: `${guide}/${encodeURIComponent(areas[0]!.id)}` }
  if (areas.length) return { catalog_url: catalogPath(organization.slug) }
  return {
    step: {
      title: 'Name your first practice area',
      detail: 'For example, Family Law.',
      name_label: 'Practice area name',
      max_length: PRODUCT_LIMITS.name,
      next_label: 'Next',
      continue_url: guide,
      back_label: 'Back',
      exit_label: 'Save & exit',
      today_url: `/dashboard/${encodeURIComponent(organization.slug)}`,
    },
  }
})

export type FirstPracticeAreaSetup = Awaited<ReturnType<typeof handler>>
export default handler
