import { MAX_ORDERED_MEDIA_ASSETS } from './media-placement-contract'

/** Features inspected on Airbnb's bedroom editor; these are host-authored facts, not approvals. */
export const STAY_ROOM_ACCESSIBILITY_FEATURES = {
  step_free_access: {
    label: 'Step-free access', icon: 'i-lucide-accessibility',
    description: 'The bedroom is on the ground floor or reached by a lift or ramp. The route from the guest entrance to the bedroom has no steps or thresholds higher than 5 cm (2 in).',
    guidelines: ['Confirm that the bedroom is on the ground floor or reached by a lift or ramp without steps above 5 cm (2 in).', 'Open the bedroom door and photograph it from outside, looking into the room.', 'Angle the camera down to show the entire entrance threshold.'],
  },
  wide_doorway: {
    label: 'Entrance wider than 32 inches', icon: 'i-lucide-door-open',
    description: 'The bedroom entrance is at least 32 inches wide when the door is open.',
    guidelines: ['Photograph the open doorway with a tape measure across its width.', 'Show both ends of the tape measure and make the numbers readable.'],
  },
} as const

export type StayRoomAccessibilityFeature = keyof typeof STAY_ROOM_ACCESSIBILITY_FEATURES
export interface StayRoomAccessibility {
  feature: StayRoomAccessibilityFeature
  available: boolean | null
  /** Canonical Product image/gallery asset IDs in the Product's photo order. */
  photo_ids: string[]
}

export function isStayRoomAccessibilityFeature(value: unknown): value is StayRoomAccessibilityFeature {
  return typeof value === 'string' && Object.hasOwn(STAY_ROOM_ACCESSIBILITY_FEATURES, value)
}

export function isStayRoomAccessibility(value: unknown): value is StayRoomAccessibility {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const answer = value as Record<string, unknown>
  return Object.keys(answer).every(key => ['feature', 'available', 'photo_ids'].includes(key))
    && isStayRoomAccessibilityFeature(answer.feature)
    && (answer.available === null || typeof answer.available === 'boolean')
    && Array.isArray(answer.photo_ids) && answer.photo_ids.every(id => typeof id === 'string' && id.length > 0 && id === id.trim())
    && new Set(answer.photo_ids).size === answer.photo_ids.length
    && answer.photo_ids.length <= MAX_ORDERED_MEDIA_ASSETS
    && (answer.available === true ? answer.photo_ids.length > 0 : answer.photo_ids.length === 0)
}

export function stayRoomAccessibilityFeatures(roomType: unknown): StayRoomAccessibilityFeature[] {
  return roomType === 'bedroom' ? Object.keys(STAY_ROOM_ACCESSIBILITY_FEATURES) as StayRoomAccessibilityFeature[] : []
}
