import { isStayAmenity, type StayAmenity } from './stay-listing'

/** Authored rooms and spaces in a home's photo tour. Their existence implies no capacity or amenities. */
export const STAY_PHOTO_ROOM_TYPES = {
  art_studio: { label: 'Art studio', icon: 'i-lucide-palette' },
  backyard: { label: 'Backyard', icon: 'i-lucide-trees' },
  balcony: { label: 'Balcony', icon: 'i-lucide-fence' },
  bedroom: { label: 'Bedroom', icon: 'i-lucide-bed-double' },
  bowling_alley: { label: 'Bowling alley', icon: 'i-lucide-circle-dot' },
  childrens_playroom: { label: 'Children’s playroom', icon: 'i-lucide-blocks' },
  courtyard: { label: 'Courtyard', icon: 'i-lucide-square' },
  darkroom: { label: 'Darkroom', icon: 'i-lucide-camera' },
  deck: { label: 'Deck', icon: 'i-lucide-fence' },
  dining_area: { label: 'Dining area', icon: 'i-lucide-utensils' },
  event_room: { label: 'Event room', icon: 'i-lucide-party-popper' },
  exterior: { label: 'Exterior', icon: 'i-lucide-house' },
  front_yard: { label: 'Front yard', icon: 'i-lucide-tree-deciduous' },
  full_bathroom: { label: 'Full bathroom', icon: 'i-lucide-bath' },
  full_kitchen: { label: 'Full kitchen', icon: 'i-lucide-cooking-pot' },
  game_room: { label: 'Game room', icon: 'i-lucide-gamepad-2' },
  garage: { label: 'Garage', icon: 'i-lucide-warehouse' },
  garden: { label: 'Garden', icon: 'i-lucide-flower-2' },
  gym: { label: 'Gym', icon: 'i-lucide-dumbbell' },
  half_bathroom: { label: 'Half bathroom', icon: 'i-lucide-toilet' },
  hot_tub: { label: 'Hot tub', icon: 'i-lucide-waves' },
  kitchenette: { label: 'Kitchenette', icon: 'i-lucide-microwave' },
  laundry_area: { label: 'Laundry area', icon: 'i-lucide-washing-machine' },
  library: { label: 'Library', icon: 'i-lucide-library' },
  living_room: { label: 'Living room', icon: 'i-lucide-sofa' },
  movie_theater: { label: 'Movie theater', icon: 'i-lucide-projector' },
  music_studio: { label: 'Music studio', icon: 'i-lucide-music' },
  office: { label: 'Office', icon: 'i-lucide-briefcase-business' },
  patio: { label: 'Patio', icon: 'i-lucide-armchair' },
  photography_studio: { label: 'Photography studio', icon: 'i-lucide-camera' },
  pool: { label: 'Pool', icon: 'i-lucide-waves' },
  porch: { label: 'Porch', icon: 'i-lucide-door-open' },
  rooftop: { label: 'Rooftop', icon: 'i-lucide-building' },
  sunroom: { label: 'Sunroom', icon: 'i-lucide-sun' },
  terrace: { label: 'Terrace', icon: 'i-lucide-fence' },
  theme_room: { label: 'Theme room', icon: 'i-lucide-sparkles' },
  wine_cellar: { label: 'Wine cellar', icon: 'i-lucide-wine' },
  woodshop: { label: 'Woodshop', icon: 'i-lucide-hammer' },
  workshop: { label: 'Workshop', icon: 'i-lucide-wrench' },
  workspace: { label: 'Workspace', icon: 'i-lucide-laptop' },
} as const

export type StayPhotoRoomType = keyof typeof STAY_PHOTO_ROOM_TYPES

export const STAY_BED_TYPES = {
  single: { label: 'Single', icon: 'i-lucide-bed-single' },
  double: { label: 'Double', icon: 'i-lucide-bed-double' },
  queen: { label: 'Queen', icon: 'i-lucide-bed-double' },
  king: { label: 'King', icon: 'i-lucide-bed-double' },
  small_double: { label: 'Small double', icon: 'i-lucide-bed-double' },
  bunk_bed: { label: 'Bunk bed', icon: 'i-lucide-bed-single' },
  sofa_bed: { label: 'Sofa bed', icon: 'i-lucide-sofa' },
  couch: { label: 'Couch', icon: 'i-lucide-sofa' },
  floor_mattress: { label: 'Floor mattress', icon: 'i-lucide-bed-single' },
  air_mattress: { label: 'Air mattress', icon: 'i-lucide-bed-single' },
  crib: { label: 'Crib', icon: 'i-krabi-crib' },
  toddler_bed: { label: 'Toddler bed', icon: 'i-lucide-bed-single' },
  hammock: { label: 'Hammock', icon: 'i-krabi-hammock' },
  water_bed: { label: 'Water bed', icon: 'i-lucide-bed-double' },
} as const
export type StayBedType = keyof typeof STAY_BED_TYPES
export interface StaySleepingArrangement { type: StayBedType; count: number }
export const MAX_STAY_BEDS_PER_TYPE = 50

export function isStayBedType(value: unknown): value is StayBedType {
  return typeof value === 'string' && Object.hasOwn(STAY_BED_TYPES, value)
}

/** Null is unanswered; an empty list explicitly records no sleeping arrangements. */
export function isStaySleepingArrangements(value: unknown): value is StaySleepingArrangement[] | null {
  if (value === null) return true
  if (!Array.isArray(value)) return false
  const types = new Set<StayBedType>()
  return value.every(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
      || Object.keys(entry).some(key => key !== 'type' && key !== 'count')
      || !isStayBedType(entry.type) || types.has(entry.type)
      || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > MAX_STAY_BEDS_PER_TYPE) return false
    types.add(entry.type)
    return true
  })
}

export function parseStaySleepingArrangements(value: unknown): StaySleepingArrangement[] | null {
  if (!isStaySleepingArrangements(value)) throw new TypeError(`Sleeping arrangements must be null or a list of unique bed types with whole counts from 1 to ${MAX_STAY_BEDS_PER_TYPE}`)
  return value === null ? null : Object.keys(STAY_BED_TYPES).flatMap(type => value.filter(bed => bed.type === type).map(bed => ({ ...bed })))
}

export interface StayPhotoRoom {
  id: string
  type: StayPhotoRoomType
  /** Product image/gallery asset IDs, in their canonical photo order. */
  photo_ids: string[]
  details_version: number
  sleeping_arrangements: StaySleepingArrangement[] | null
  /** Only authored bedrooms may state whether they have a private attached bathroom. */
  private_attached_bathroom: boolean | null
  /** Room references to amenities present in the canonical listing amenity set. */
  amenities: StayAmenity[]
}

export function isStayPhotoRoomType(value: unknown): value is StayPhotoRoomType {
  return typeof value === 'string' && Object.hasOwn(STAY_PHOTO_ROOM_TYPES, value)
}

/** Every surface reads the same explicit room facts, including unanswered values. */
export function isStayPhotoRoom(value: unknown): value is StayPhotoRoom {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const room = value as Record<string, unknown>
  return Object.keys(room).every(key => ['id', 'type', 'photo_ids', 'details_version', 'sleeping_arrangements', 'private_attached_bathroom', 'amenities'].includes(key))
    && typeof room.id === 'string' && room.id.length > 0
    && isStayPhotoRoomType(room.type)
    && Array.isArray(room.photo_ids) && room.photo_ids.every(id => typeof id === 'string' && id.length > 0)
    && new Set(room.photo_ids).size === room.photo_ids.length
    && Number.isInteger(room.details_version) && (room.details_version as number) >= 1
    && isStaySleepingArrangements(room.sleeping_arrangements)
    && (room.private_attached_bathroom === null || (room.type === 'bedroom' && typeof room.private_attached_bathroom === 'boolean'))
    && Array.isArray(room.amenities) && room.amenities.every(isStayAmenity) && new Set(room.amenities).size === room.amenities.length
}

/** Multiple authored rooms of a type receive a number in their saved order. */
export function stayPhotoRoomName(room: StayPhotoRoom, rooms: readonly StayPhotoRoom[], label = STAY_PHOTO_ROOM_TYPES[room.type].label as string): string {
  const peers = rooms.filter(entry => entry.type === room.type)
  const index = peers.findIndex(entry => entry.id === room.id)
  if (index < 0) throw new TypeError('The room is not in this photo tour')
  return peers.length > 1 ? `${label} ${index + 1}` : label
}

/** A partial tour must not hide any of the listing's photos from guests. */
export function stayPhotoTourReady(rooms: readonly StayPhotoRoom[]): boolean {
  return rooms.length > 0 && rooms.every(room => room.photo_ids.length > 0)
}
