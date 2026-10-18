/**
 * The fixed vocabularies a place to stay is described in: what kind of place
 * it is, what it offers, how it cancels, how guests get in and what they do
 * before they leave. Each is a code list; the database stores the code, every
 * surface shows the label. Property types and amenities are Airbnb's own
 * catalog, codes included, read from Airbnb's listing editor, so a home
 * described here maps one to one onto its Airbnb listing.
 */

/** The privacy of the accommodation offered, independently of its building type. */
export const STAY_LISTING_TYPES = {
  entire_place: { label: 'Entire place', description: 'Guests have the whole property to themselves.', schemaType: 'EntirePlace' },
  private_room: { label: 'Room', description: 'Guests have a private room and may share other areas.', schemaType: 'PrivateRoom' },
  shared_room: { label: 'Shared room', description: 'Guests share the sleeping area with other people.', schemaType: 'SharedRoom' },
} as const
export type StayListingType = keyof typeof STAY_LISTING_TYPES

export const STAY_PROPERTY_SIZE_UNITS = {
  square_meters: { label: 'Square meters', symbol: 'm²' },
  square_feet: { label: 'Square feet', symbol: 'sq ft' },
} as const
export type StayPropertySizeUnit = keyof typeof STAY_PROPERTY_SIZE_UNITS

/** Airbnb's property types ("Which is most like your place?"), with Airbnb's description of each. */
export const STAY_PROPERTY_TYPES = {
  apartment: { icon: 'i-lucide-building-2', label: "Rental unit", description: "A rented place within a multi-unit residential building or complex." },
  condominium: { icon: 'i-lucide-building', label: "Condo", description: "A place within a multi-unit building or complex owned by the residents." },
  serviced_apartment: { icon: 'i-lucide-concierge-bell', label: "Serviced apartment", description: "An apartment with hotel-like amenities serviced by a professional management company." },
  loft: { icon: 'i-lucide-warehouse', label: "Loft", description: "An open layout apartment or condo, which may have short interior walls." },
  house: { icon: 'i-lucide-house', label: "Home", description: "A home that may stand-alone or have shared walls." },
  townhouse: { icon: 'i-lucide-building-2', label: "Townhouse", description: "A multi-level row or terrace house that shares walls and possibly outdoor spaces." },
  bungalow: { icon: 'i-lucide-house', label: "Bungalow", description: "A single-level house with a wide front porch and a sloping roof." },
  cabin: { icon: 'i-lucide-house', label: "Cabin", description: "A house made with natural materials like wood and built in a natural setting." },
  chalet: { icon: 'i-lucide-mountain-snow', label: "Chalet", description: "A wooden house with a sloped roof popular for skiing or summer stays." },
  earthhouse: { icon: 'i-lucide-mountain', label: "Earthen home", description: "A home built in the ground or made from materials like rammed earth." },
  hut: { icon: 'i-lucide-tent', label: "Hut", description: "A home made of wood or mud that may have a thatched straw roof." },
  lighthouse: { icon: 'i-krabi-lighthouse', label: "Lighthouse", description: "A tower near water with a bright light used at any point to help guide ships." },
  villa: { icon: 'i-lucide-house-heart', label: "Villa", description: "A luxury home that may have indoor-outdoor spaces, gardens, and pools." },
  dome: { icon: 'i-krabi-dome', label: "Dome", description: "A home with a domed roof or spherical shape, such as a bubble home." },
  cottage: { icon: 'i-lucide-house', label: "Cottage", description: "A cozy house built in a rural area or near a lake or beach." },
  farmstay: { icon: 'i-lucide-tractor', label: "Farm stay", description: "A rural stay where guests may spend time in an agricultural setting or with animals." },
  houseboat: { icon: 'i-lucide-ship', label: "Houseboat", description: "A floating home constructed from similar materials as a land-based home." },
  tiny_house: { icon: 'i-lucide-house', label: "Tiny home", description: "A stand-alone house that's usually less than 400 square feet." },
  guesthouse: { icon: 'i-lucide-house-plus', label: "Guesthouse", description: "A separate building from the main house." },
  private_suite: { icon: 'i-lucide-door-open', label: "Guest suite", description: "A space with a private entrance inside of or attached to a larger structure." },
  boat: { icon: 'i-lucide-sailboat', label: "Boat", description: "A boat, sailboat, or yacht moored during guest visits. Not a houseboat." },
  castle: { icon: 'i-lucide-castle', label: "Castle", description: "A majestic, possibly historical building that may have towers and moats." },
  cave: { icon: 'i-lucide-mountain', label: "Cave", description: "A natural or carved dwelling on a hillside or cliff." },
  igloo: { icon: 'i-krabi-dome', label: "Ice dome", description: "A dome-shaped structure made of snow and ice found in cold climates." },
  island: { icon: 'i-lucide-tree-palm', label: "Island", description: "A piece of land surrounded by water." },
  plane: { icon: 'i-lucide-plane', label: "Plane", description: "An aircraft that's been converted into a place to stay." },
  rv: { icon: 'i-lucide-caravan', label: "Camper/RV", description: "A motorhome or camping trailer that's half-home and half-vehicle." },
  tent: { icon: 'i-lucide-tent', label: "Tent", description: "A usually portable, collapsible structure made from fabric and poles." },
  tipi: { icon: 'i-lucide-tent', label: "Tipi", description: "A cone-shaped tent supported by poles with a flap door and open top." },
  train: { icon: 'i-lucide-train-front', label: "Train", description: "A caboose, boxcar, or other railroad car converted to a living space." },
  treehouse: { icon: 'i-krabi-treehouse', label: "Treehouse", description: "A dwelling built into the trunk or branches of a tree, or sitting on stilts among trees." },
  yurt: { icon: 'i-krabi-yurt', label: "Yurt", description: "A round tent built on a collapsible wooden framework." },
  other: { icon: 'i-lucide-shapes', label: "Other", description: "" },
  barn: { icon: 'i-lucide-warehouse', label: "Barn", description: "A converted space in a building used at any time for grain, livestock, or farming." },
  campsite: { icon: 'i-lucide-tent-tree', label: "Campsite", description: "An area of land where guests can set up a tent, yurt, RV, or tiny house." },
  windmill: { icon: 'i-krabi-windmill', label: "Windmill", description: "A living space in a structure used at any point to generate wind power." },
  bus: { icon: 'i-lucide-bus', label: "Bus", description: "A converted multi-passenger vehicle with a creatively reimagined interior." },
  holiday_park: { icon: 'i-lucide-tent-tree', label: "Holiday park", description: "A plot of land with cabins or campsites in Australia or New Zealand." },
  ranch: { icon: 'i-lucide-tractor', label: "Ranch", description: "A home on a large area of land used to raise livestock." },
  religious_building: { icon: 'i-lucide-church', label: "Religious building", description: "A converted space in a former place of worship like a church or mosque." },
  riad: { icon: 'i-lucide-house', label: "Riad", description: "A traditional home with an open-air courtyard or garden in Morocco." },
  shipping_container: { icon: 'i-lucide-container', label: "Shipping container", description: "A converted steel container once used to transport goods." },
  tower: { icon: 'i-lucide-building', label: "Tower", description: "A free-standing structure that's several stories tall with a view." },
  bnb: { icon: 'i-lucide-coffee', label: "Bed and breakfast", description: "A hospitality business offering guests breakfast with a host on-site." },
  nature_eco_lodge: { icon: 'i-lucide-trees', label: "Nature lodge", description: "A business offering stays near natural settings like forests or mountains." },
  boutique_hotel: { icon: 'i-lucide-hotel', label: "Boutique hotel", description: "A hospitality business with a unique style or theme defining its identity." },
  hostel: { icon: 'i-lucide-bed-single', label: "Hostel", description: "A hospitality business that rents beds in shared dorms and private rooms." },
  aparthotel: { icon: 'i-lucide-building-2', label: "Aparthotel", description: "A place with hotel-like amenities and rooms that feel like apartments." },
  hotel: { icon: 'i-lucide-hotel', label: "Hotel", description: "A business offering private rooms, suites, or unique stays for guests." },
  resort: { icon: 'i-lucide-tree-palm', label: "Resort", description: "A hospitality business with more amenities and services than a hotel." },
} as const satisfies Record<string, { icon: string; label: string; description: string }>

export type StayPropertyType = keyof typeof STAY_PROPERTY_TYPES

/** Airbnb's property groups and the types each offers; a type can sit in several groups. */
export const STAY_PROPERTY_TYPE_GROUPS = {
  apartments: { icon: 'i-lucide-building-2', label: "Apartment", types: ['apartment', 'condominium', 'serviced_apartment', 'loft'] },
  houses: { icon: 'i-lucide-house', label: "House", types: ['house', 'townhouse', 'bungalow', 'cabin', 'chalet', 'earthhouse', 'hut', 'lighthouse', 'villa', 'dome', 'cottage', 'farmstay', 'houseboat', 'tiny_house'] },
  secondary_units: { icon: 'i-lucide-house-plus', label: "Secondary unit", types: ['guesthouse', 'private_suite', 'farmstay'] },
  unique_homes: { icon: 'i-lucide-tent-tree', label: "Unique space", types: ['boat', 'castle', 'cave', 'earthhouse', 'hut', 'igloo', 'island', 'lighthouse', 'plane', 'rv', 'tent', 'tipi', 'train', 'treehouse', 'yurt', 'other', 'dome', 'barn', 'campsite', 'farmstay', 'houseboat', 'tiny_house', 'windmill', 'bus', 'holiday_park', 'ranch', 'religious_building', 'riad', 'shipping_container', 'tower'] },
  bnb: { icon: 'i-lucide-coffee', label: "Bed and breakfast", types: ['bnb', 'nature_eco_lodge', 'farmstay'] },
  boutique_hotels_and_more: { icon: 'i-lucide-hotel', label: "Boutique hotel", types: ['boutique_hotel', 'nature_eco_lodge', 'hostel', 'serviced_apartment', 'aparthotel', 'hotel', 'resort'] },
} as const satisfies Record<string, { icon: string; label: string; types: readonly StayPropertyType[] }>
export type StayPropertyTypeGroup = keyof typeof STAY_PROPERTY_TYPE_GROUPS

export function isStayPropertyType(group: unknown, type: unknown): group is StayPropertyTypeGroup {
  return typeof group === 'string' && Object.hasOwn(STAY_PROPERTY_TYPE_GROUPS, group)
    && (STAY_PROPERTY_TYPE_GROUPS[group as StayPropertyTypeGroup].types as readonly string[]).includes(type as string)
}

/**
 * Airbnb's cancellation policies for stays shorter than 28 nights, in Airbnb's
 * words: the summary, the two terms and the partial-refund detail its listing
 * editor shows. Strict is Airbnb's invitation-only policy, worded as its Help
 * Center states it.
 */
export const STAY_CANCELLATION_POLICIES = {
  flexible: {
    label: 'Flexible', summary: 'Guests get a full refund if they cancel up to a day before check-in.',
    terms: ['Full refund at least 1 day before check-in', 'Partial refund within 1 day of check-in'],
    detail: 'Guests who cancel within 1 day of check-in will be charged for 1 night. If guests cancel during their trip, they’ll be charged 1 extra night and be refunded the rest.',
  },
  moderate: {
    label: 'Moderate', summary: 'Guests get a full refund if they cancel up to 5 days before check-in.',
    terms: ['Full refund at least 5 days before check-in', 'Partial refund within 5 days of check-in'],
    detail: 'Guests who cancel within 5 days of check-in or during their trip will be charged 1 extra night and refunded 50% of unspent nights.',
  },
  limited: {
    label: 'Limited', summary: 'Full refund at least 14 days before check-in',
    terms: ['Full refund at least 14 days before check-in', 'Partial refund 7-14 days before check-in'],
    detail: 'Guests who cancel 7 – 14 days before check-in get 50% back. After that, their trip is non-refundable.',
  },
  firm: {
    label: 'Firm', summary: 'Guests get a full refund if they cancel up to 30 days before check-in, except in certain cases.',
    terms: ['Full refund at least 30 days before check-in', 'Partial refund 7-30 days before check-in'],
    detail: 'Guests who cancel 7 – 30 days before check-in get 50% back. After that, their trip is non-refundable.',
  },
  strict: {
    label: 'Strict', summary: 'Guests get a 50% refund if they cancel at least 7 days before check-in.',
    terms: ['50% refund at least 7 days before check-in', 'No refund within 7 days of check-in'],
    detail: 'Guests who cancel at least 7 days before check-in get 50% back. After that, their trip is non-refundable.',
  },
} as const satisfies Record<string, { label: string; summary: string; terms: readonly string[]; detail: string }>
export type StayCancellationPolicy = keyof typeof STAY_CANCELLATION_POLICIES

/** Airbnb's cancellation policies for stays of 28 nights or more, in Airbnb's words. */
export const STAY_LONG_TERM_CANCELLATION_POLICIES = {
  firm: {
    label: 'Firm Long Term', summary: 'Full refund up to 30 days before check-in. After that, the first 30 days of the stay are non-refundable.',
    terms: ['Full refund up to 30 days before check-in', 'After that, the first 30 days of the stay are non-refundable'],
  },
  strict: {
    label: 'Strict Long Term', summary: 'Full refund if cancelled within 48 hours of booking and at least 28 days before check-in. After that, the first 30 days of the stay are non-refundable.',
    terms: ['Full refund if canceled within 48 hours of booking and at least 28 days before check-in', 'After that, the first 30 days of the stay are non-refundable'],
  },
} as const satisfies Record<string, { label: string; summary: string; terms: readonly string[] }>
export type StayLongTermCancellationPolicy = keyof typeof STAY_LONG_TERM_CANCELLATION_POLICIES

/** How guests get in (Airbnb's check-in method cards), with the SF Symbol the app shows. */
export const STAY_CHECK_IN_METHODS = {
  smart_lock: { label: 'Smart lock', description: 'Guests unlock the door with an app or a code.', icon: 'i-lucide-smartphone', symbol: 'lock.iphone' },
  keypad: { label: 'Keypad', description: 'Guests enter a code on a keypad.', icon: 'i-lucide-grid-3x3', symbol: 'circle.grid.3x3' },
  lockbox: { label: 'Lockbox', description: 'Guests collect a key from a lockbox.', icon: 'i-lucide-vault', symbol: 'lock.square' },
  building_staff: { label: 'Building staff', description: 'A member of the building staff lets guests in.', icon: 'i-lucide-concierge-bell', symbol: 'person.badge.key' },
  in_person: { label: 'In-person greeting', description: 'You or your co-host greet guests and let them in.', icon: 'i-lucide-hand', symbol: 'hand.wave' },
  other: { label: 'Other', description: 'Describe another way guests can get inside.', icon: 'i-lucide-key-round', symbol: 'key' },
} as const satisfies Record<string, { label: string; description: string; icon: string; symbol: string }>
export type StayCheckInMethod = keyof typeof STAY_CHECK_IN_METHODS

/** What guests are asked to do before they leave (Airbnb's checkout instructions), with the SF Symbol the app shows. */
export const STAY_CHECKOUT_TASKS = {
  gather_towels: { label: 'Gather used towels', icon: 'i-krabi-towels', symbol: 'basket' },
  throw_trash: { label: 'Throw trash away', icon: 'i-lucide-trash-2', symbol: 'trash' },
  turn_off: { label: 'Turn things off', icon: 'i-lucide-power', symbol: 'power' },
  lock_up: { label: 'Lock up', icon: 'i-lucide-lock-keyhole', symbol: 'lock' },
  return_keys: { label: 'Return keys', icon: 'i-lucide-key-round', symbol: 'key' },
  additional: { label: 'Additional requests', icon: 'i-lucide-message-square-text', symbol: 'text.bubble' },
} as const satisfies Record<string, { label: string; icon: string; symbol: string }>
export type StayCheckoutTask = keyof typeof STAY_CHECKOUT_TASKS

/** Every amenity Airbnb's editor offers, by Airbnb's code, with web and native glyphs for the same meaning. */
export const STAY_AMENITIES = {
  ac: { icon: 'i-lucide-snowflake', label: 'Air conditioning', description: "A system for cooling the indoor space.", symbol: 'snowflake' },
  dryer: { icon: 'i-krabi-dryer', label: 'Dryer', description: "A machine for drying laundry.", symbol: 'dryer' },
  essentials: { icon: 'i-lucide-towel-rack', label: 'Essentials', description: "Basic supplies such as towels, bed linens, soap and toilet paper.", symbol: 'shippingbox' },
  heating: { icon: 'i-lucide-heater', label: 'Heating', description: "A system for warming the indoor space.", symbol: 'heater.vertical' },
  hot_water: { icon: 'i-lucide-thermometer-sun', label: 'Hot water', description: "Hot water for washing and bathing.", symbol: 'drop.degreesign' },
  kitchen: { icon: 'i-lucide-cooking-pot', label: 'Kitchen', description: "A space for preparing and cooking meals.", symbol: 'fork.knife' },
  tv: { icon: 'i-lucide-tv', label: 'TV', description: "A television for guests to watch.", symbol: 'tv' },
  washer: { icon: 'i-lucide-washing-machine', label: 'Washer', description: "A machine for washing laundry.", symbol: 'washer' },
  wireless_internet: { icon: 'i-lucide-wifi', label: 'Wifi', description: "A wireless internet connection.", symbol: 'wifi' },
  bathtub: { icon: 'i-lucide-bath', label: 'Bathtub', description: "A tub for bathing.", symbol: 'bathtub' },
  bidet: { icon: 'i-lucide-toilet', label: 'Bidet', description: "A fixture for washing after using the toilet.", symbol: 'toilet' },
  body_soap: { icon: 'i-lucide-soap-dispenser-droplet', label: 'Body soap', description: "Soap for washing the body.", symbol: 'bubbles.and.sparkles' },
  cleaning_products: { icon: 'i-lucide-spray-can', label: 'Cleaning products', description: "Supplies for cleaning the space.", symbol: 'hands.and.sparkles' },
  conditioner: { icon: 'i-lucide-soap-dispenser-droplet', label: 'Conditioner', description: "Hair conditioner for guests to use.", symbol: 'drop.halffull' },
  hair_dryer: { icon: 'i-krabi-hair-dryer', label: 'Hair dryer', symbol: 'wind' },
  alfresco_shower: { icon: 'i-lucide-shower-head', label: 'Outdoor shower', description: "A shower located outdoors.", symbol: 'shower' },
  shampoo: { icon: 'i-lucide-soap-dispenser-droplet', label: 'Shampoo', symbol: 'drop' },
  shower_gel: { icon: 'i-lucide-bubbles', label: 'Shower gel', description: "Body wash for use in the shower.", symbol: 'drop.circle' },
  bed_linens: { icon: 'i-lucide-bed-double', label: 'Bed linens', description: "Sheets and other linen for the beds.", symbol: 'bed.double' },
  wardrobe_or_closet: { icon: 'i-lucide-shelving-unit', label: 'Clothing storage', description: "A place to store clothing.", symbol: 'cabinet' },
  clothes_drying_rack: { icon: 'i-lucide-shirt', label: 'Drying rack for clothing', description: "A rack for air-drying laundry.", symbol: 'tshirt' },
  extra_pillows_and_blankets: { icon: 'i-lucide-bed-double', label: 'Extra pillows and blankets', description: "Additional pillows and blankets.", symbol: 'bed.double.circle' },
  hangers: { icon: 'i-krabi-hanger', label: 'Hangers', symbol: 'hanger' },
  iron: { icon: 'i-krabi-iron', label: 'Iron', symbol: 'flame' },
  mosquito_net: { icon: 'i-lucide-bug-off', label: 'Mosquito net', description: "Netting to keep mosquitoes away while sleeping.", symbol: 'ant' },
  room_darkening_shades: { icon: 'i-lucide-blinds', label: 'Room-darkening shades', description: "Window coverings that reduce incoming light.", symbol: 'blinds.horizontal.closed' },
  safe: { icon: 'i-lucide-vault', label: 'Safe', description: "A secure compartment for valuables.", symbol: 'lock.square.stack' },
  arcade_machine: { icon: 'i-lucide-joystick', label: 'Arcade games', description: "Arcade games for guests to play.", symbol: 'arcade.stick' },
  batting_cage: { icon: 'i-lucide-fence', label: 'Batting cage', description: "An enclosed area for practicing batting.", symbol: 'figure.baseball' },
  books: { icon: 'i-lucide-book-open', label: 'Books and reading material', description: "Books and other material for reading.", symbol: 'books.vertical' },
  bowling_alley: { icon: 'i-krabi-bowling', label: 'Bowling alley', description: "A lane for playing bowling.", symbol: 'figure.bowling' },
  climbing_wall: { icon: 'i-lucide-mountain', label: 'Climbing wall', description: "A wall equipped for climbing.", symbol: 'figure.climbing' },
  ethernet_connection: { icon: 'i-lucide-ethernet-port', label: 'Ethernet connection', description: "A wired internet connection.", symbol: 'cable.connector' },
  exercise_equipment: { icon: 'i-lucide-dumbbell', label: 'Exercise equipment', description: "Equipment for exercising.", symbol: 'dumbbell' },
  game_console: { icon: 'i-lucide-gamepad-2', label: 'Game console', description: "A video game console.", symbol: 'gamecontroller' },
  laser_tag: { icon: 'i-lucide-target', label: 'Laser tag', description: "Equipment or a space for playing laser tag.", symbol: 'scope' },
  life_size_games: { icon: 'i-lucide-dices', label: 'Life size games', description: "Large games for guests to play.", symbol: 'checkerboard.rectangle' },
  mini_golf: { icon: 'i-lucide-flag-triangle-right', label: 'Mini golf', description: "A course for playing miniature golf.", symbol: 'figure.golf' },
  home_theater: { icon: 'i-lucide-projector', label: 'Movie theater', description: "A space set up for watching movies.", symbol: 'film' },
  piano: { icon: 'i-lucide-piano', label: 'Piano', description: "A piano for guests to play.", symbol: 'pianokeys' },
  ping_pong_table: { icon: 'i-krabi-table-tennis', label: 'Ping pong table', description: "A table for playing table tennis.", symbol: 'figure.table.tennis' },
  pool_table: { icon: 'i-krabi-pool-table', label: 'Pool table', description: "A table for playing pool.", symbol: 'circle.grid.cross' },
  record_player: { icon: 'i-lucide-turntable', label: 'Record player', description: "A player for vinyl records.", symbol: 'opticaldisc' },
  skate_ramp: { icon: 'i-krabi-skate-ramp', label: 'Skate ramp', description: "A ramp for skateboarding.", symbol: 'figure.skateboarding' },
  sound_system: { icon: 'i-lucide-speaker', label: 'Sound system', description: "Audio equipment for listening to music.", symbol: 'hifispeaker' },
  theme_room: { icon: 'i-lucide-drama', label: 'Theme room', description: "A room designed around a particular theme.", symbol: 'theatermasks' },
  baby_bath: { icon: 'i-lucide-bath', label: 'Baby bath', description: "A small tub for bathing babies.", symbol: 'bathtub.fill' },
  baby_monitor: { icon: 'i-lucide-video', label: 'Baby monitor', description: "A device for monitoring a baby from another room.", symbol: 'video.circle' },
  childrens_bike: { icon: 'i-lucide-bike', label: 'Children’s bikes', description: "Bicycles sized for children.", symbol: 'bicycle' },
  playroom: { icon: 'i-lucide-toy-brick', label: "Children's playroom", description: "A room for children to play in.", symbol: 'teddybear' },
  stair_gates: { icon: 'i-lucide-fence', label: 'Baby safety gates', description: "Gates that restrict access to stairs.", symbol: 'square.split.2x1' },
  babysitter_recommendations: { icon: 'i-lucide-users', label: 'Babysitter recommendations', description: "Information about babysitters in the area.", symbol: 'person.2' },
  board_games: { icon: 'i-lucide-dices', label: 'Board games', description: "Tabletop games for guests to play.", symbol: 'die.face.5' },
  changing_table: { icon: 'i-lucide-baby', label: 'Changing table', description: "A surface for changing a baby’s diapers.", symbol: 'table.furniture' },
  childrens_books_and_toys: { icon: 'i-lucide-book-open', label: 'Children’s books and toys', description: "Reading material and toys for children.", symbol: 'book.closed' },
  childrens_dinnerware: { icon: 'i-lucide-utensils', label: 'Children’s dinnerware', description: "Plates, cups or utensils intended for children.", symbol: 'fork.knife.circle' },
  crib: { icon: 'i-krabi-crib', label: 'Crib', description: "A bed designed for an infant.", symbol: 'bed.double.circle.fill' },
  fireplace_guards: { icon: 'i-lucide-fence', label: 'Fireplace guards', description: "A barrier around the fireplace.", symbol: 'fireplace.fill' },
  high_chair: { icon: 'i-krabi-high-chair', label: 'High chair', description: "A raised chair for feeding a young child.", symbol: 'chair' },
  playground: { icon: 'i-krabi-playground', label: 'Outdoor playground', description: "An outdoor space with play equipment.", symbol: 'figure.play' },
  outlet_covers: { icon: 'i-lucide-plug', label: 'Outlet covers', description: "Covers that restrict access to electrical outlets.", symbol: 'poweroutlet.type.b' },
  pack_n_play_travel_crib: { icon: 'i-krabi-crib', label: 'Pack ’n play/Travel crib', description: "A portable crib for infants.", symbol: 'square.on.square' },
  table_corner_guards: { icon: 'i-lucide-square-round-corner', label: 'Table corner guards', description: "Protective covers for table corners.", symbol: 'square.dashed' },
  window_guards: { icon: 'i-lucide-panels-top-left', label: 'Window guards', description: "Barriers that restrict access through windows.", symbol: 'window.vertical.closed' },
  ceiling_fan: { icon: 'i-krabi-ceiling-fan', label: 'Ceiling fan', description: "A fan mounted to the ceiling.", symbol: 'fan.ceiling' },
  fireplace: { icon: 'i-lucide-flame-kindling', label: 'Indoor fireplace', description: "A fireplace inside the home.", symbol: 'fireplace' },
  portable_fans: { icon: 'i-lucide-fan', label: 'Portable fans', description: "Fans that can be moved between rooms.", symbol: 'fan' },
  carbon_monoxide_detector: { icon: 'i-lucide-alarm-smoke', label: 'Carbon monoxide alarm', description: "A device that alerts occupants to carbon monoxide.", symbol: 'sensor' },
  fire_extinguisher: { icon: 'i-lucide-fire-extinguisher', label: 'Fire extinguisher', symbol: 'flame.circle' },
  first_aid_kit: { icon: 'i-lucide-briefcase-medical', label: 'First aid kit', symbol: 'cross.case' },
  smoke_detector: { icon: 'i-lucide-alarm-smoke', label: 'Smoke alarm', description: "A device that alerts occupants to smoke.", symbol: 'smoke' },
  laptop_friendly_workspace: { icon: 'i-lucide-lamp-desk', label: 'Dedicated workspace', description: "A space set aside for working.", symbol: 'desktopcomputer' },
  pocket_wifi: { icon: 'i-lucide-router', label: 'Pocket wifi', description: "A portable device that provides a wifi connection.", symbol: 'antenna.radiowaves.left.and.right' },
  baking_sheet: { icon: 'i-lucide-rectangle-horizontal', label: 'Baking sheet', description: "A tray for baking food in the oven.", symbol: 'square.grid.3x3' },
  barbeque_utensils: { icon: 'i-lucide-utensils', label: 'Barbecue utensils', description: "Tools for cooking on a barbecue.", symbol: 'fork.knife' },
  bread_maker: { icon: 'i-lucide-croissant', label: 'Bread maker', description: "An appliance for making bread.", symbol: 'birthday.cake' },
  blender: { icon: 'i-lucide-blender', label: 'Blender', description: "An appliance for blending food and drinks.", symbol: 'cup.and.heat.waves' },
  coffee: { icon: 'i-lucide-coffee', label: 'Coffee', description: "Coffee for guests to prepare.", symbol: 'cup.and.saucer.fill' },
  coffee_maker: { icon: 'i-lucide-coffee', label: 'Coffee maker', description: "Equipment for brewing coffee.", symbol: 'cup.and.saucer' },
  cooking_basics: { icon: 'i-lucide-cooking-pot', label: 'Cooking basics', description: "Basic equipment and supplies for cooking.", symbol: 'frying.pan' },
  dining_table: { icon: 'i-krabi-dining-table', label: 'Dining table', description: "A table for eating meals.", symbol: 'table.furniture.fill' },
  dishes_and_silverware: { icon: 'i-lucide-utensils', label: 'Dishes and silverware', description: "Plates, bowls, glasses and eating utensils.", symbol: 'fork.knife.circle.fill' },
  dishwasher: { icon: 'i-krabi-dishwasher', label: 'Dishwasher', description: "A machine for washing dishes.", symbol: 'dishwasher' },
  freezer: { icon: 'i-lucide-snowflake', label: 'Freezer', description: "An appliance or compartment for keeping food frozen.", symbol: 'snowflake.circle' },
  hot_water_kettle: { icon: 'i-lucide-coffee', label: 'Hot water kettle', description: "An appliance for boiling water.", symbol: 'mug' },
  kitchenette: { icon: 'i-lucide-cooking-pot', label: 'Kitchenette', description: "A compact space for preparing meals.", symbol: 'stove.fill' },
  microwave: { icon: 'i-lucide-microwave', label: 'Microwave', description: "An appliance for heating food with microwaves.", symbol: 'microwave' },
  mini_fridge: { icon: 'i-lucide-refrigerator', label: 'Mini fridge', description: "A compact refrigerator.", symbol: 'refrigerator.fill' },
  oven: { icon: 'i-krabi-oven', label: 'Oven', description: "An appliance for baking and roasting food.", symbol: 'oven' },
  refrigerator: { icon: 'i-lucide-refrigerator', label: 'Refrigerator', description: "An appliance for keeping food and drinks cold.", symbol: 'refrigerator' },
  rice_maker: { icon: 'i-lucide-cooking-pot', label: 'Rice maker', description: "An appliance for cooking rice.", symbol: 'takeoutbag.and.cup.and.straw' },
  stove: { icon: 'i-lucide-cooking-pot', label: 'Stove', description: "A cooktop for preparing meals.", symbol: 'stove' },
  toaster: { icon: 'i-krabi-toaster', label: 'Toaster', description: "An appliance for toasting bread.", symbol: 'rectangle.split.2x1' },
  trash_compacter: { icon: 'i-lucide-trash-2', label: 'Trash compactor', description: "An appliance for compressing household waste.", symbol: 'trash' },
  wine_glasses: { icon: 'i-lucide-wine', label: 'Wine glasses', description: "Glasses intended for serving wine.", symbol: 'wineglass' },
  beach_access: { icon: 'i-lucide-parasol', label: 'Beach access', description: "Access to a beach from the property.", symbol: 'beach.umbrella' },
  lake_access: { icon: 'i-lucide-waves', label: 'Lake access', description: "Access to a lake from the property.", symbol: 'water.waves' },
  laundromat_nearby: { icon: 'i-lucide-washing-machine', label: 'Laundromat nearby', description: "A laundromat near the property.", symbol: 'washer.fill' },
  private_entrance: { icon: 'i-lucide-door-open', label: 'Private entrance', description: "An entrance for the space that guests are booking.", symbol: 'door.left.hand.open' },
  resort_access: { icon: 'i-lucide-hotel', label: 'Resort access', description: "Access to resort facilities.", symbol: 'building.2' },
  ski_in_ski_out: { icon: 'i-lucide-mountain-snow', label: 'Ski-in/Ski-out', description: "Access between the property and ski terrain.", symbol: 'figure.skiing.downhill' },
  waterfront: { icon: 'i-lucide-waves', label: 'Waterfront', description: "A property located alongside a body of water.", symbol: 'water.waves.and.arrow.trianglehead.up' },
  garden_or_backyard: { icon: 'i-lucide-trees', label: 'Backyard', description: "An outdoor garden or backyard.", symbol: 'tree' },
  bbq_area: { icon: 'i-krabi-barbecue', label: 'BBQ grill', description: "A grill for cooking outdoors.", symbol: 'flame.fill' },
  beach_essentials: { icon: 'i-lucide-parasol', label: 'Beach essentials', description: "Supplies for a visit to the beach.", symbol: 'sun.max' },
  bicycle: { icon: 'i-lucide-bike', label: 'Bikes', description: "Bicycles for guests to use.", symbol: 'bicycle' },
  boat_slip: { icon: 'i-lucide-anchor', label: 'Boat slip', description: "A place for mooring a boat.", symbol: 'ferry' },
  fire_pit: { icon: 'i-lucide-flame-kindling', label: 'Fire pit', description: "An outdoor area for a contained fire.", symbol: 'fireplace.fill' },
  hammock: { icon: 'i-krabi-hammock', label: 'Hammock', description: "A suspended sling for resting outdoors.", symbol: 'figure.mind.and.body' },
  kayak: { icon: 'i-lucide-kayak', label: 'Kayak', description: "A kayak for guests to use.", symbol: 'figure.outdoor.rowing' },
  alfresco_dining: { icon: 'i-krabi-dining-table', label: 'Outdoor dining area', description: "A place for eating meals outdoors.", symbol: 'table.furniture' },
  outdoor_seating: { icon: 'i-lucide-armchair', label: 'Outdoor furniture', description: "Furniture for sitting outdoors.", symbol: 'chair.lounge' },
  outdoor_kitchen: { icon: 'i-lucide-cooking-pot', label: 'Outdoor kitchen', description: "A cooking space outdoors.", symbol: 'frying.pan.fill' },
  patio_or_belcony: { icon: 'i-lucide-fence', label: 'Patio or balcony', description: "A patio or balcony at the property.", symbol: 'sun.max.fill' },
  sun_loungers: { icon: 'i-lucide-armchair', label: 'Sun loungers', description: "Reclining seats for relaxing outdoors.", symbol: 'chair.lounge.fill' },
  free_parking: { icon: 'i-lucide-square-parking', label: 'Free parking on premises', description: "Parking on the property at no additional charge.", symbol: 'parkingsign' },
  street_parking: { icon: 'i-lucide-road', label: 'Free street parking', description: "Street parking at no additional charge.", symbol: 'parkingsign.square' },
  paid_parking_on_premises: { icon: 'i-lucide-circle-parking', label: 'Paid parking on premises', description: "Parking on the property for an additional charge.", symbol: 'parkingsign.circle' },
  paid_parking: { icon: 'i-lucide-circle-parking', label: 'Paid parking off premises', description: "Parking away from the property for an additional charge.", symbol: 'parkingsign.circle.fill' },
  free_parking_off_premises: { icon: 'i-lucide-car', label: 'Free parking off premises', description: "Parking away from the property at no additional charge.", symbol: 'car' },
  elevator: { icon: 'i-krabi-elevator', label: 'Elevator', description: "A lift for moving between floors.", symbol: 'arrow.up.arrow.down.square' },
  ev_charger: { icon: 'i-lucide-ev-charger', label: 'EV charger', description: "A charging point for an electric vehicle.", symbol: 'ev.charger' },
  hockey_rink: { icon: 'i-krabi-hockey-rink', label: 'Hockey rink', description: "A rink for playing hockey.", symbol: 'figure.hockey' },
  gym: { icon: 'i-lucide-dumbbell', label: 'Gym', description: "A space equipped for exercise.", symbol: 'figure.strengthtraining.traditional' },
  jacuzzi: { icon: 'i-lucide-bath', label: 'Hot tub', description: "A tub with heated water for soaking.", symbol: 'bathtub.fill' },
  pool: { icon: 'i-lucide-waves-ladder', label: 'Pool', description: "A swimming pool.", symbol: 'figure.pool.swim' },
  private_living_room: { icon: 'i-lucide-sofa', label: 'Private living room', description: "A living room for the guests booking this space.", symbol: 'sofa' },
  sauna: { icon: 'i-krabi-sauna', label: 'Sauna', description: "A heated room for relaxation.", symbol: 'heat.waves' },
  single_level_home: { icon: 'i-lucide-house', label: 'Single level home', description: "A home with living spaces on one level.", symbol: 'house' },
  ebike_charger: { icon: 'i-lucide-bike', label: 'eBike charger', description: "A charging point for an electric bicycle.", symbol: 'bicycle.circle' },
  solar_power: { icon: 'i-lucide-solar-panel', label: 'Solar panels', description: "Solar panels at the property.", symbol: 'sun.max.circle' },
  recycling: { icon: 'i-lucide-recycle', label: 'Recycling', description: "Facilities for separating recyclable waste.", symbol: 'arrow.3.trianglepath' },
  composting: { icon: 'i-lucide-sprout', label: 'Composting', description: "Facilities for collecting compostable waste.", symbol: 'leaf' },
  doorman: { icon: 'i-lucide-concierge-bell', label: 'Doorman', description: "A person who attends the building’s entrance.", symbol: 'person.badge.key' },
  gated_community: { icon: 'i-lucide-fence', label: 'Gated community', description: "A community with a controlled entrance.", symbol: 'shield.lefthalf.filled' },
  breakfast: { icon: 'i-lucide-coffee', label: 'Breakfast', description: "Breakfast offered as part of the stay.", symbol: 'cup.and.saucer' },
  cleaning_before_checkout: { icon: 'i-lucide-sparkles', label: 'Cleaning available during stay', description: "Cleaning services available during the stay.", symbol: 'sparkles' },
  long_term_stays_allowed: { icon: 'i-lucide-calendar-days', label: 'Long term stays allowed', description: "The option to book an extended stay.", symbol: 'calendar' },
  luggage_dropoff_allowed: { icon: 'i-lucide-luggage', label: 'Luggage dropoff allowed', description: "A place to leave luggage before check-in or after checkout.", symbol: 'suitcase' },
} as const satisfies Record<string, { icon: string; label: string; description?: string; symbol: string }>

export type StayAmenity = keyof typeof STAY_AMENITIES

/** Airbnb's amenity groups in the editor's order; an amenity can sit in several groups. */
export const STAY_AMENITY_GROUPS = {
  basic: { icon: 'i-lucide-house', label: 'Basics', amenities: ['ac', 'dryer', 'essentials', 'heating', 'hot_water', 'kitchen', 'tv', 'washer', 'wireless_internet'] },
  bathroom: { icon: 'i-lucide-bath', label: 'Bathroom', amenities: ['bathtub', 'bidet', 'body_soap', 'cleaning_products', 'conditioner', 'hair_dryer', 'hot_water', 'alfresco_shower', 'shampoo', 'shower_gel'] },
  bedroom_laundry: { icon: 'i-lucide-bed-double', label: 'Bedroom and laundry', amenities: ['essentials', 'bed_linens', 'wardrobe_or_closet', 'dryer', 'clothes_drying_rack', 'extra_pillows_and_blankets', 'hangers', 'iron', 'mosquito_net', 'room_darkening_shades', 'safe', 'washer'] },
  entertainment: { icon: 'i-lucide-gamepad-2', label: 'Entertainment', amenities: ['arcade_machine', 'batting_cage', 'books', 'bowling_alley', 'climbing_wall', 'ethernet_connection', 'exercise_equipment', 'game_console', 'laser_tag', 'life_size_games', 'mini_golf', 'home_theater', 'piano', 'ping_pong_table', 'pool_table', 'record_player', 'skate_ramp', 'sound_system', 'theme_room', 'tv'] },
  family: { icon: 'i-lucide-baby', label: 'Family', amenities: ['baby_bath', 'baby_monitor', 'childrens_bike', 'playroom', 'stair_gates', 'babysitter_recommendations', 'board_games', 'changing_table', 'childrens_books_and_toys', 'childrens_dinnerware', 'crib', 'fireplace_guards', 'high_chair', 'playground', 'outlet_covers', 'pack_n_play_travel_crib', 'table_corner_guards', 'window_guards'] },
  heating_cooling: { icon: 'i-lucide-thermometer', label: 'Heating and cooling', amenities: ['ac', 'ceiling_fan', 'heating', 'fireplace', 'portable_fans'] },
  home_safety: { icon: 'i-lucide-shield-check', label: 'Home safety', amenities: ['carbon_monoxide_detector', 'fire_extinguisher', 'first_aid_kit', 'smoke_detector'] },
  internet_office: { icon: 'i-lucide-wifi', label: 'Internet and office', amenities: ['laptop_friendly_workspace', 'pocket_wifi', 'wireless_internet'] },
  kitchen_dining: { icon: 'i-lucide-cooking-pot', label: 'Kitchen and dining', amenities: ['baking_sheet', 'barbeque_utensils', 'bread_maker', 'blender', 'coffee', 'coffee_maker', 'cooking_basics', 'dining_table', 'dishes_and_silverware', 'dishwasher', 'freezer', 'hot_water_kettle', 'kitchen', 'kitchenette', 'microwave', 'mini_fridge', 'oven', 'refrigerator', 'rice_maker', 'stove', 'toaster', 'trash_compacter', 'wine_glasses'] },
  location: { icon: 'i-lucide-map-pin', label: 'Location features', amenities: ['beach_access', 'lake_access', 'laundromat_nearby', 'private_entrance', 'resort_access', 'ski_in_ski_out', 'waterfront'] },
  outdoor: { icon: 'i-lucide-trees', label: 'Outdoor', amenities: ['garden_or_backyard', 'bbq_area', 'beach_essentials', 'bicycle', 'boat_slip', 'fire_pit', 'hammock', 'kayak', 'alfresco_dining', 'outdoor_seating', 'outdoor_kitchen', 'patio_or_belcony', 'sun_loungers'] },
  facilities: { icon: 'i-lucide-square-parking', label: 'Parking and facilities', amenities: ['free_parking', 'street_parking', 'paid_parking_on_premises', 'paid_parking', 'free_parking_off_premises', 'elevator', 'ev_charger', 'hockey_rink', 'gym', 'jacuzzi', 'pool', 'private_living_room', 'sauna', 'single_level_home', 'ebike_charger', 'solar_power', 'recycling', 'composting', 'doorman', 'gated_community'] },
  services: { icon: 'i-lucide-concierge-bell', label: 'Services', amenities: ['breakfast', 'cleaning_before_checkout', 'long_term_stays_allowed', 'luggage_dropoff_allowed'] },
} as const satisfies Record<string, { icon: string; label: string; amenities: readonly StayAmenity[] }>
export type StayAmenityGroup = keyof typeof STAY_AMENITY_GROUPS

export function isStayAmenity(value: unknown): value is StayAmenity {
  return typeof value === 'string' && Object.hasOwn(STAY_AMENITIES, value)
}

/** The codes of one vocabulary, for validators and JSON schemas. */
export function stayCodes<T extends Record<string, unknown>>(vocabulary: T): Array<keyof T & string> {
  return Object.keys(vocabulary) as Array<keyof T & string>
}
