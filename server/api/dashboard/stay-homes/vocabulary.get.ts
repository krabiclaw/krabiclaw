import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import {
  STAY_AMENITIES, STAY_AMENITY_GROUPS, STAY_CANCELLATION_POLICIES, STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS,
  STAY_LONG_TERM_CANCELLATION_POLICIES, STAY_PROPERTY_TYPE_GROUPS, STAY_PROPERTY_TYPES,
} from '~/shared/stay-listing'

/** A vocabulary as ordered entries: an app decodes JSON objects without their key order. */
const entries = <T extends object>(vocabulary: Record<string, T>) => Object.entries(vocabulary).map(([code, entry]) => ({ code, ...entry }))

// The vocabularies a home is described in, in the order an editor offers them, so it offers exactly the codes the server accepts.
export default defineHandler(async (event) => {
  await getDashboardMemberContext(event, {})
  return jsonResponse({
    property_type_groups: Object.entries(STAY_PROPERTY_TYPE_GROUPS).map(([code, group]) => ({
      code, label: group.label, types: group.types.map(type => ({ code: type, ...STAY_PROPERTY_TYPES[type] })),
    })),
    amenity_groups: Object.entries(STAY_AMENITY_GROUPS).map(([code, group]) => ({
      code, label: group.label, amenities: group.amenities.map(amenity => ({ code: amenity, ...STAY_AMENITIES[amenity] })),
    })),
    cancellation_policies: entries(STAY_CANCELLATION_POLICIES),
    long_term_cancellation_policies: entries(STAY_LONG_TERM_CANCELLATION_POLICIES),
    check_in_methods: entries(STAY_CHECK_IN_METHODS),
    checkout_tasks: entries(STAY_CHECKOUT_TASKS),
  })
})
