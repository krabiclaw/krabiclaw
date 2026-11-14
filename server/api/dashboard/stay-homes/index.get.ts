import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { listStayHomes, stayAccessFor } from '~/server/domain/stays'

import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { productEditorPath } from '~/server/utils/dashboard-links'
import { readStayHomeSetupDraft } from '~/server/utils/stay-home-setup-draft'

// The places to stay this caller may see, with their stay rules and base price.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const [homes, draft] = await Promise.all([
    listStayHomes(db, access),
    access.manage ? readStayHomeSetupDraft(db, organization) : null,
  ])
  const needsFirstHome = access.manage && organization.vertical === 'lodging' && organization.onboarding_status === 'active' && homes.length === 0
  const canConnect = needsFirstHome && await hasOrganizationEntitlement(env, organization.id, 'channel_sync')
  const manualSetupTo = `${productEditorPath(organization.slug, 'new')}?kind=stay&setup=guided`
  const resume_home_setup = draft ? { label: 'Continue your listing', detail: 'Pick up where you left off.', to: manualSetupTo } : null
  const first_home_setup = needsFirstHome
    ? {
        title: 'How would you like to add a home?',
        manual: resume_home_setup ?? {
          label: 'Add your first home',
          detail: 'Start with the location and listing details.',
          to: manualSetupTo,
        },
        airbnb: {
          label: 'Import from Airbnb',
          detail: canConnect ? 'Choose the listings to bring over.' : 'Choose the listings to bring over. Airbnb sync requires Business.',
          to: `/dashboard/${encodeURIComponent(organization.slug)}/integrations/airbnb`,
          can_connect: canConnect,
        },
      }
    : null
  return jsonResponse({ homes, manage: access.manage, first_home_setup, resume_home_setup })
})
