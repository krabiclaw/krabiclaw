/** Public disclosures authored by a host. Unanswered choices are not a No. */
export const STAY_SAFETY_DETAILS_LIMIT = 300
export const STAY_SAFETY_FIELDS = {
  unsecured_pool: { name: 'Unsecured pool or hot tub', description: 'Guests can reach a pool or hot tub without a gate or lock.', detailsKey: 'unsecured_pool_details' },
  nearby_water: { name: 'Nearby water', description: 'Guests can reach a body of water on or next to the property.', detailsKey: 'nearby_water_details' },
  climbing_structures: { name: 'Climbing or play structures', description: 'Play or climbing structures are available to guests.', detailsKey: 'climbing_structures_details' },
  unprotected_heights: { name: 'Unprotected heights', description: 'Elevated areas are accessible without a railing or other protection.', detailsKey: 'unprotected_heights_details' },
  dangerous_animals: { name: 'Potentially dangerous animals', description: 'Animals that could cause harm live on or near the property.', detailsKey: 'dangerous_animals_details' },
  exterior_security_cameras: { name: 'Exterior security cameras', description: 'Describe exterior cameras, what they monitor and whether they record audio or video.', detailsKey: 'exterior_security_cameras_details', disallowedLabel: 'No exterior security cameras' },
  noise_decibel_monitors: { name: 'Noise decibel monitors', description: 'Devices measure sound levels without recording conversations.', detailsKey: 'noise_decibel_monitors_details', disallowedLabel: 'No noise decibel monitors' },
  stairs_required: { name: 'Guests must climb stairs', description: 'Guests need to use stairs during their stay.', detailsKey: 'stairs_required_details' },
  potential_noise: { name: 'Potential noise during stays', description: 'Guests may hear traffic, construction or other noise.', detailsKey: 'potential_noise_details' },
  resident_pets: { name: 'Pets live on the property', description: 'Guests may encounter animals that live here.', detailsKey: 'resident_pets_details' },
  no_property_parking: { name: 'No parking on the property', description: 'Dedicated guest parking is not available on the property.', detailsKey: 'no_property_parking_details' },
  shared_spaces: { name: 'Shared spaces', description: 'Guests share some spaces with other people.', detailsKey: 'shared_spaces_details' },
  limited_essentials: { name: 'Limited essential amenities', description: 'Tell guests which everyday essentials are unavailable.', detailsKey: 'limited_essentials_details' },
  weapons_on_property: { name: 'Weapons on the property', description: 'Tell guests about weapons stored on the property.', detailsKey: 'weapons_on_property_details' },
} as const

export const STAY_SAFETY_SECTIONS = {
  considerations: { label: 'Safety considerations', fields: ['unsecured_pool', 'nearby_water', 'climbing_structures', 'unprotected_heights', 'dangerous_animals'], textKey: 'special_safety_considerations' },
  devices: { label: 'Safety devices', fields: ['exterior_security_cameras', 'noise_decibel_monitors'] },
  'property-info': { label: 'Property info', fields: ['stairs_required', 'potential_noise', 'resident_pets', 'no_property_parking', 'shared_spaces', 'limited_essentials', 'weapons_on_property'] },
} as const
export type StaySafetySection = keyof typeof STAY_SAFETY_SECTIONS
export type StaySafetyFlag = keyof typeof STAY_SAFETY_FIELDS
export type StaySafetyDetailKey = typeof STAY_SAFETY_FIELDS[StaySafetyFlag]['detailsKey'] | 'special_safety_considerations'
export type StaySafetyKey = StaySafetyFlag | StaySafetyDetailKey

/** The registry consumed by the one Product details validator and schema. */
export const STAY_SAFETY_DETAIL_FIELDS = {
  ...Object.fromEntries(Object.entries(STAY_SAFETY_FIELDS).flatMap(([key, field]) => [
    [key, { name: field.name, description: field.description, value_type: 'boolean', kinds: ['stay'], localizable: false, validations: {} }],
    [field.detailsKey, { name: `${field.name}: details`, description: `Host-authored details about ${field.name.toLowerCase()}. Requires its disclosure to be Yes.`, value_type: 'multi_line_text', kinds: ['stay'], localizable: true, validations: { max_length: STAY_SAFETY_DETAILS_LIMIT } }],
  ])) as Record<Exclude<StaySafetyKey, 'special_safety_considerations'>, { name: string; description: string; value_type: 'boolean' | 'multi_line_text'; kinds: readonly ['stay']; localizable: boolean; validations: { max_length?: number } }>,
  special_safety_considerations: { name: 'Special safety considerations', description: 'Other property features that guests should know could be unsafe, and why.', value_type: 'multi_line_text', kinds: ['stay'], localizable: true, validations: { max_length: STAY_SAFETY_DETAILS_LIMIT } },
} as const
export const STAY_SAFETY_DETAIL_KEYS = Object.keys(STAY_SAFETY_DETAIL_FIELDS) as StaySafetyKey[]

export function staySafetySectionKeys(section: StaySafetySection): StaySafetyKey[] {
  const group = STAY_SAFETY_SECTIONS[section]
  return [...group.fields.flatMap(key => [key, STAY_SAFETY_FIELDS[key].detailsKey]), ...('textKey' in group ? [group.textKey] : [])]
}

/** One projection for saved summaries, the guest listing and the team guide. */
export function staySafetyLines(details: Readonly<Record<string, unknown>>, options: { section?: StaySafetySection; includeNo?: boolean } = {}): string[] {
  const sections = options.section ? [options.section] : Object.keys(STAY_SAFETY_SECTIONS) as StaySafetySection[]
  return sections.flatMap((section) => {
    const group = STAY_SAFETY_SECTIONS[section]
    const lines: string[] = []
    for (const key of group.fields) {
      const field = STAY_SAFETY_FIELDS[key]
      if (details[key] === true) {
        const extra = details[field.detailsKey]
        lines.push(`${field.name}${typeof extra === 'string' ? `\n${extra}` : ''}`)
      } else if (details[key] === false && ('disallowedLabel' in field || options.includeNo)) {
        lines.push('disallowedLabel' in field ? field.disallowedLabel : `${field.name}: No`)
      }
    }
    if ('textKey' in group && typeof details[group.textKey] === 'string') lines.push(details[group.textKey] as string)
    return lines
  })
}
