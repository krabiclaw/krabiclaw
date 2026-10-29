// The fixed questions a guest is asked about a visit, by what they booked.
// The overall rating is always asked and stored on the review itself; these
// are the optional category scores beside it. A business cannot edit them yet.

export const REVIEW_SUBJECTS = ['restaurant', 'experience', 'legal_consultation', 'lodging'] as const
export type ReviewSubject = typeof REVIEW_SUBJECTS[number]

export const REVIEW_CATEGORIES = {
  restaurant: [
    { key: 'food', label: 'Food' },
    { key: 'service', label: 'Service' },
    { key: 'atmosphere', label: 'Atmosphere' },
  ],
  experience: [
    { key: 'expertise', label: 'Host expertise' },
    { key: 'organization', label: 'Organization' },
    { key: 'enjoyment', label: 'Enjoyment' },
  ],
  legal_consultation: [
    { key: 'listening', label: 'Listening and understanding' },
    { key: 'explanation', label: 'Clear explanations' },
    { key: 'next_steps', label: 'Clear next steps' },
  ],
  lodging: [
    { key: 'cleanliness', label: 'Cleanliness' },
    { key: 'accuracy', label: 'Accuracy' },
    { key: 'check_in', label: 'Check-in' },
    { key: 'communication', label: 'Communication' },
  ],
} as const satisfies Record<ReviewSubject, ReadonlyArray<{ key: string; label: string }>>

export type ReviewCategory = typeof REVIEW_CATEGORIES[ReviewSubject][number]['key']

export const REVIEW_CATEGORY_KEYS = [...new Set(REVIEW_SUBJECTS.flatMap(subject => REVIEW_CATEGORIES[subject].map(category => category.key)))] as ReviewCategory[]

/** What a booked visit is reviewed as: a reservation, a stay, or a booking of a consultation or an experience. */
export function reviewSubject(bookingType: 'reservation' | 'booking' | 'stay', productKind: string | null): ReviewSubject {
  if (bookingType === 'reservation') return 'restaurant'
  if (bookingType === 'stay') return 'lodging'
  if (productKind === 'service') return 'legal_consultation'
  if (productKind === 'experience') return 'experience'
  throw new Error(`A ${productKind ?? 'missing'} product has no review questions`)
}

export const REVIEW_SUBJECT_LABELS: Record<ReviewSubject, string> = {
  restaurant: 'Restaurant',
  experience: 'Experience',
  legal_consultation: 'Legal consultation',
  lodging: 'Stay',
}
