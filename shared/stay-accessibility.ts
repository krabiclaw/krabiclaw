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

/** Listing-wide features inspected on Airbnb; none creates or identifies a room. */
export const STAY_HOME_ACCESSIBILITY_FEATURES = {
  disabled_parking_spot: {
    label: 'Disabled parking spot', icon: 'i-lucide-accessibility',
    description: 'A private parking space is at least 11 ft (3.35 m) wide, or a designated public accessible parking space has signs identifying it.',
    guidelines: ['For a private space, take a photo from far enough away to show its full width.', 'For a public space, show the signs identifying it as accessible parking.'],
  },
  path_to_entrance_lit_at_night: {
    label: 'Path to entrance lit at night', icon: 'i-lucide-lightbulb',
    description: 'The path to the guest entrance is well lit at night.',
    guidelines: ['Photograph the light sources along the path at night.', 'Show where each light is in relation to the path.', 'Light from inside the listing does not count as lighting for the path.'],
  },
  home_step_free_access: {
    label: 'Step-free access', icon: 'i-lucide-accessibility',
    description: 'The entire route from the arrival or parking area to the guest entrance has no steps or obstacles 5 cm (2 in) or higher, including shared paths, hallways and lifts.',
    guidelines: ['Open every door and gate along the route and put any ramps in place.', 'Take photos from the arrival or parking area and at least every 3 m along the route to the entrance.', 'Photograph the open entrance from outside, about 2.4 m away, with the entire threshold visible.'],
  },
  home_wide_doorway: {
    label: 'Entrance wider than 32 inches', icon: 'i-lucide-door-open',
    description: 'The guest entrance is at least 32 in (81 cm) wide with the door fully open.',
    guidelines: ['Place a tape measure across the narrowest part of the open door frame.', 'Photograph the whole tape measure with both ends visible.', 'Add a close-up that makes the measurement and its units readable.'],
  },
  pool_hoist: {
    label: 'Pool or hot tub hoist', icon: 'i-lucide-accessibility',
    description: 'A purpose-built hoist transfers a person into and out of the pool or hot tub.',
    guidelines: ['Photograph the hoist and show how close it is to the pool or hot tub.'],
  },
  ceiling_hoist: {
    label: 'Ceiling or mobile hoist', icon: 'i-lucide-accessibility',
    description: 'A purpose-built ceiling-mounted or freestanding hoist transfers a person into and out of a wheelchair.',
    guidelines: ['Photograph the ceiling-mounted or mobile hoist in the bedroom or bathroom where guests can use it.'],
  },
} as const

export type StayHomeAccessibilityFeature = keyof typeof STAY_HOME_ACCESSIBILITY_FEATURES
export interface StayHomeAccessibility {
  feature: StayHomeAccessibilityFeature
  available: boolean | null
  /** Canonical Product image/gallery asset IDs in the Product's photo order. */
  photo_ids: string[]
}

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

export function isStayHomeAccessibilityFeature(value: unknown): value is StayHomeAccessibilityFeature {
  return typeof value === 'string' && Object.hasOwn(STAY_HOME_ACCESSIBILITY_FEATURES, value)
}

function isAccessibilityAnswer(value: unknown, isFeature: (feature: unknown) => boolean): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const answer = value as Record<string, unknown>
  return Object.keys(answer).every(key => ['feature', 'available', 'photo_ids'].includes(key))
    && isFeature(answer.feature)
    && (answer.available === null || typeof answer.available === 'boolean')
    && Array.isArray(answer.photo_ids) && answer.photo_ids.every(id => typeof id === 'string' && id.length > 0 && id === id.trim())
    && new Set(answer.photo_ids).size === answer.photo_ids.length
    && answer.photo_ids.length <= MAX_ORDERED_MEDIA_ASSETS
    && (answer.available === true ? answer.photo_ids.length > 0 : answer.photo_ids.length === 0)
}

export function isStayRoomAccessibility(value: unknown): value is StayRoomAccessibility {
  return isAccessibilityAnswer(value, isStayRoomAccessibilityFeature)
}

export function isStayHomeAccessibility(value: unknown): value is StayHomeAccessibility {
  return isAccessibilityAnswer(value, isStayHomeAccessibilityFeature)
}

export function stayRoomAccessibilityFeatures(roomType: unknown): StayRoomAccessibilityFeature[] {
  return roomType === 'bedroom' ? Object.keys(STAY_ROOM_ACCESSIBILITY_FEATURES) as StayRoomAccessibilityFeature[] : []
}
