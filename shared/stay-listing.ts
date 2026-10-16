/**
 * The fixed vocabularies a place to stay is described in: what kind of place
 * it is, what it offers, how it cancels, how guests get in and what they do
 * before they leave. Each is a code list; the database stores the code, every
 * surface shows the label. The lists follow Airbnb's listing editor, so a home
 * described here reads the same as its channel listing.
 */

/** Airbnb's property groups ("Which is most like your place?"). */
export const STAY_PROPERTY_TYPES = {
  apartment: 'Apartment',
  house: 'House',
  secondary_unit: 'Secondary unit',
  unique_space: 'Unique space',
  bed_and_breakfast: 'Bed and breakfast',
  boutique_hotel: 'Boutique hotel',
} as const
export type StayPropertyType = keyof typeof STAY_PROPERTY_TYPES

/** Airbnb's cancellation policies a host can choose for stays shorter than 28 nights. */
export const STAY_CANCELLATION_POLICIES = {
  flexible: 'Flexible',
  moderate: 'Moderate',
  limited: 'Limited',
  firm: 'Firm',
  strict: 'Strict',
} as const
export type StayCancellationPolicy = keyof typeof STAY_CANCELLATION_POLICIES

/** Airbnb's cancellation policies for stays of 28 nights or more. */
export const STAY_LONG_TERM_CANCELLATION_POLICIES = {
  firm: 'Firm Long Term',
  strict: 'Strict Long Term',
} as const
export type StayLongTermCancellationPolicy = keyof typeof STAY_LONG_TERM_CANCELLATION_POLICIES

/** How guests get in (Airbnb's check-in method cards). */
export const STAY_CHECK_IN_METHODS = {
  smart_lock: 'Smart lock',
  keypad: 'Keypad',
  lockbox: 'Lockbox',
  building_staff: 'Building staff',
  in_person: 'In-person greeting',
  other: 'Other',
} as const
export type StayCheckInMethod = keyof typeof STAY_CHECK_IN_METHODS

/** What guests are asked to do before they leave (Airbnb's checkout instructions). */
export const STAY_CHECKOUT_TASKS = {
  gather_towels: 'Gather used towels',
  throw_trash: 'Throw trash away',
  turn_off: 'Turn things off',
  lock_up: 'Lock up',
  return_keys: 'Return keys',
  additional: 'Additional requests',
} as const
export type StayCheckoutTask = keyof typeof STAY_CHECKOUT_TASKS

export const STAY_AMENITY_GROUPS = {
  bathroom: 'Bathroom',
  bedroom_laundry: 'Bedroom and laundry',
  entertainment: 'Entertainment',
  family: 'Family',
  heating_cooling: 'Heating and cooling',
  home_safety: 'Home safety',
  internet_office: 'Internet and office',
  kitchen_dining: 'Kitchen and dining',
  location: 'Location features',
  outdoor: 'Outdoor',
  parking_facilities: 'Parking and facilities',
  services: 'Services',
} as const
export type StayAmenityGroup = keyof typeof STAY_AMENITY_GROUPS

/** Each amenity a home can offer, in its group, in the order the editor lists them. */
export const STAY_AMENITIES = {
  hair_dryer: { label: 'Hair dryer', group: 'bathroom' },
  shampoo: { label: 'Shampoo', group: 'bathroom' },
  hot_water: { label: 'Hot water', group: 'bathroom' },
  bathtub: { label: 'Bathtub', group: 'bathroom' },
  essentials: { label: 'Essentials', group: 'bedroom_laundry' },
  bed_linens: { label: 'Bed linens', group: 'bedroom_laundry' },
  hangers: { label: 'Hangers', group: 'bedroom_laundry' },
  iron: { label: 'Iron', group: 'bedroom_laundry' },
  washer: { label: 'Washer', group: 'bedroom_laundry' },
  dryer: { label: 'Dryer', group: 'bedroom_laundry' },
  tv: { label: 'TV', group: 'entertainment' },
  pool_table: { label: 'Pool table', group: 'entertainment' },
  piano: { label: 'Piano', group: 'entertainment' },
  exercise_equipment: { label: 'Exercise equipment', group: 'entertainment' },
  crib: { label: 'Crib', group: 'family' },
  high_chair: { label: 'High chair', group: 'family' },
  air_conditioning: { label: 'Air conditioning', group: 'heating_cooling' },
  heating: { label: 'Heating', group: 'heating_cooling' },
  indoor_fireplace: { label: 'Indoor fireplace', group: 'heating_cooling' },
  smoke_alarm: { label: 'Smoke alarm', group: 'home_safety' },
  carbon_monoxide_alarm: { label: 'Carbon monoxide alarm', group: 'home_safety' },
  fire_extinguisher: { label: 'Fire extinguisher', group: 'home_safety' },
  first_aid_kit: { label: 'First aid kit', group: 'home_safety' },
  wifi: { label: 'Wifi', group: 'internet_office' },
  dedicated_workspace: { label: 'Dedicated workspace', group: 'internet_office' },
  kitchen: { label: 'Kitchen', group: 'kitchen_dining' },
  refrigerator: { label: 'Refrigerator', group: 'kitchen_dining' },
  microwave: { label: 'Microwave', group: 'kitchen_dining' },
  cooking_basics: { label: 'Cooking basics', group: 'kitchen_dining' },
  dishes_and_silverware: { label: 'Dishes and silverware', group: 'kitchen_dining' },
  dishwasher: { label: 'Dishwasher', group: 'kitchen_dining' },
  stove: { label: 'Stove', group: 'kitchen_dining' },
  oven: { label: 'Oven', group: 'kitchen_dining' },
  coffee_maker: { label: 'Coffee maker', group: 'kitchen_dining' },
  lake_access: { label: 'Lake access', group: 'location' },
  beach_access: { label: 'Beach access', group: 'location' },
  ski_in_out: { label: 'Ski-in/Ski-out', group: 'location' },
  private_entrance: { label: 'Private entrance', group: 'location' },
  patio: { label: 'Patio', group: 'outdoor' },
  bbq_grill: { label: 'BBQ grill', group: 'outdoor' },
  outdoor_dining: { label: 'Outdoor dining area', group: 'outdoor' },
  fire_pit: { label: 'Fire pit', group: 'outdoor' },
  outdoor_shower: { label: 'Outdoor shower', group: 'outdoor' },
  free_parking: { label: 'Free parking on premises', group: 'parking_facilities' },
  paid_parking: { label: 'Paid parking on premises', group: 'parking_facilities' },
  ev_charger: { label: 'EV charger', group: 'parking_facilities' },
  pool: { label: 'Pool', group: 'parking_facilities' },
  hot_tub: { label: 'Hot tub', group: 'parking_facilities' },
  gym: { label: 'Gym', group: 'parking_facilities' },
  elevator: { label: 'Elevator', group: 'parking_facilities' },
  self_check_in: { label: 'Self check-in', group: 'services' },
  long_term_stays: { label: 'Long term stays allowed', group: 'services' },
  luggage_dropoff: { label: 'Luggage dropoff allowed', group: 'services' },
  pets_allowed: { label: 'Pets allowed', group: 'services' },
} as const satisfies Record<string, { label: string; group: StayAmenityGroup }>
export type StayAmenity = keyof typeof STAY_AMENITIES

export function isStayAmenity(value: unknown): value is StayAmenity {
  return typeof value === 'string' && Object.hasOwn(STAY_AMENITIES, value)
}

/** The codes of one vocabulary, for validators and JSON schemas. */
export function stayCodes<T extends Record<string, unknown>>(vocabulary: T): Array<keyof T & string> {
  return Object.keys(vocabulary) as Array<keyof T & string>
}
