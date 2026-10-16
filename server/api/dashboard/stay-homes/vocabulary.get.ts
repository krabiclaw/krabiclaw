import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import {
  STAY_AMENITIES, STAY_AMENITY_GROUPS, STAY_CANCELLATION_POLICIES, STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS,
  STAY_LONG_TERM_CANCELLATION_POLICIES, STAY_PROPERTY_TYPE_GROUPS, STAY_PROPERTY_TYPES,
} from '~/shared/stay-listing'

// The vocabularies a home is described in, so an editor offers exactly the codes the server accepts.
export default defineHandler(async (event) => {
  await getDashboardMemberContext(event, {})
  return jsonResponse({
    property_types: STAY_PROPERTY_TYPES, property_type_groups: STAY_PROPERTY_TYPE_GROUPS,
    amenities: STAY_AMENITIES, amenity_groups: STAY_AMENITY_GROUPS,
    cancellation_policies: STAY_CANCELLATION_POLICIES, long_term_cancellation_policies: STAY_LONG_TERM_CANCELLATION_POLICIES,
    check_in_methods: STAY_CHECK_IN_METHODS, checkout_tasks: STAY_CHECKOUT_TASKS,
  })
})
