/** Authored rooms and spaces in a home's photo tour. These do not imply capacity or amenities. */
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

export interface StayPhotoRoom {
  id: string
  type: StayPhotoRoomType
  /** Product image/gallery asset IDs, in their canonical photo order. */
  photo_ids: string[]
}

export function isStayPhotoRoomType(value: unknown): value is StayPhotoRoomType {
  return typeof value === 'string' && Object.hasOwn(STAY_PHOTO_ROOM_TYPES, value)
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
