import {
  BLAWBY_ROUTE_RECIPES,
  isBlawbyShellOnlyRouteRecipe,
  type PublicBlawbyRouteData,
  type PublicBlawbyShellData,
} from '~/types/blawby'
import { isRecord } from '~/utils/api-clients'

export interface BlawbyDocumentPayload {
  success: true
  shell: PublicBlawbyShellData
  route: PublicBlawbyRouteData
}

const RECIPES = new Set<string>(BLAWBY_ROUTE_RECIPES)

const isNullableString = (value: unknown) => value === null || typeof value === 'string'

function hasValidIdentity(value: unknown) {
  return isRecord(value)
    && typeof value.name === 'string'
    && isNullableString(value.brand_description)
    && Array.isArray(value.media)
    && value.media.every(item => isRecord(item)
      && typeof item.asset_id === 'string'
      && typeof item.slot === 'string'
      && isNullableString(item.public_url))
    && isNullableString(value.phone)
}

function hasValidConsultation(value: unknown) {
  return isRecord(value)
    && (value.mode === 'native' || value.mode === 'external_url' || value.mode === 'native_disabled')
    && typeof value.cta_label === 'string'
    && isNullableString(value.external_url)
    && typeof value.schedule_path === 'string'
    && typeof value.confirmation_path === 'string'
    && typeof value.tracking_enabled === 'boolean'
}

function hasRequiredRouteContent(route: Record<string, unknown>) {
  if (route.recipe === 'confirmation' || isBlawbyShellOnlyRouteRecipe(route.recipe as PublicBlawbyRouteData['recipe'])) return true
  return isRecord(route.page)
}

export const isBlawbyDocumentPayload = (
  value: unknown,
  expectedRecipe: PublicBlawbyRouteData['recipe'],
): value is BlawbyDocumentPayload =>
  isRecord(value)
  && value.success === true
  && isRecord(value.shell)
  && isRecord(value.route)
  && hasValidIdentity(value.shell.identity)
  && hasValidConsultation(value.shell.consultation)
  && typeof value.shell.canSchedule === 'boolean'
  && Array.isArray(value.shell.pageLinks)
  && (value.shell.searchConsoleVerification === null || typeof value.shell.searchConsoleVerification === 'string')
  && typeof value.route.recipe === 'string'
  && RECIPES.has(value.route.recipe)
  && value.route.recipe === expectedRecipe
  && Array.isArray(value.route.localeRepresentations)
  && hasRequiredRouteContent(value.route)
