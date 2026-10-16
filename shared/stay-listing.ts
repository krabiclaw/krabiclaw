/**
 * The fixed vocabularies a place to stay is described in: what kind of place
 * it is, what it offers, how it cancels, how guests get in and what they do
 * before they leave. Each is a code list; the database stores the code, every
 * surface shows the label. Property types and amenities are Airbnb's own
 * catalog, codes included, read from Airbnb's listing editor, so a home
 * described here maps one to one onto its Airbnb listing.
 */

/** Airbnb's property types ("Which is most like your place?"), with Airbnb's description of each. */
export const STAY_PROPERTY_TYPES = {
  apartment: { label: "Rental unit", description: "A rented place within a multi-unit residential building or complex." },
  condominium: { label: "Condo", description: "A place within a multi-unit building or complex owned by the residents." },
  serviced_apartment: { label: "Serviced apartment", description: "An apartment with hotel-like amenities serviced by a professional management company." },
  loft: { label: "Loft", description: "An open layout apartment or condo, which may have short interior walls." },
  house: { label: "Home", description: "A home that may stand-alone or have shared walls." },
  townhouse: { label: "Townhouse", description: "A multi-level row or terrace house that shares walls and possibly outdoor spaces." },
  bungalow: { label: "Bungalow", description: "A single-level house with a wide front porch and a sloping roof." },
  cabin: { label: "Cabin", description: "A house made with natural materials like wood and built in a natural setting." },
  chalet: { label: "Chalet", description: "A wooden house with a sloped roof popular for skiing or summer stays." },
  earthhouse: { label: "Earthen home", description: "A home built in the ground or made from materials like rammed earth." },
  hut: { label: "Hut", description: "A home made of wood or mud that may have a thatched straw roof." },
  lighthouse: { label: "Lighthouse", description: "A tower near water with a bright light used at any point to help guide ships." },
  villa: { label: "Villa", description: "A luxury home that may have indoor-outdoor spaces, gardens, and pools." },
  dome: { label: "Dome", description: "A home with a domed roof or spherical shape, such as a bubble home." },
  cottage: { label: "Cottage", description: "A cozy house built in a rural area or near a lake or beach." },
  farmstay: { label: "Farm stay", description: "A rural stay where guests may spend time in an agricultural setting or with animals." },
  houseboat: { label: "Houseboat", description: "A floating home constructed from similar materials as a land-based home." },
  tiny_house: { label: "Tiny home", description: "A stand-alone house that's usually less than 400 square feet." },
  guesthouse: { label: "Guesthouse", description: "A separate building from the main house." },
  private_suite: { label: "Guest suite", description: "A space with a private entrance inside of or attached to a larger structure." },
  boat: { label: "Boat", description: "A boat, sailboat, or yacht moored during guest visits. Not a houseboat." },
  castle: { label: "Castle", description: "A majestic, possibly historical building that may have towers and moats." },
  cave: { label: "Cave", description: "A natural or carved dwelling on a hillside or cliff." },
  igloo: { label: "Ice dome", description: "A dome-shaped structure made of snow and ice found in cold climates." },
  island: { label: "Island", description: "A piece of land surrounded by water." },
  plane: { label: "Plane", description: "An aircraft that's been converted into a place to stay." },
  rv: { label: "Camper/RV", description: "A motorhome or camping trailer that's half-home and half-vehicle." },
  tent: { label: "Tent", description: "A usually portable, collapsible structure made from fabric and poles." },
  tipi: { label: "Tipi", description: "A cone-shaped tent supported by poles with a flap door and open top." },
  train: { label: "Train", description: "A caboose, boxcar, or other railroad car converted to a living space." },
  treehouse: { label: "Treehouse", description: "A dwelling built into the trunk or branches of a tree, or sitting on stilts among trees." },
  yurt: { label: "Yurt", description: "A round tent built on a collapsible wooden framework." },
  other: { label: "Other", description: "" },
  barn: { label: "Barn", description: "A converted space in a building used at any time for grain, livestock, or farming." },
  campsite: { label: "Campsite", description: "An area of land where guests can set up a tent, yurt, RV, or tiny house." },
  windmill: { label: "Windmill", description: "A living space in a structure used at any point to generate wind power." },
  bus: { label: "Bus", description: "A converted multi-passenger vehicle with a creatively reimagined interior." },
  holiday_park: { label: "Holiday park", description: "A plot of land with cabins or campsites in Australia or New Zealand." },
  ranch: { label: "Ranch", description: "A home on a large area of land used to raise livestock." },
  religious_building: { label: "Religious building", description: "A converted space in a former place of worship like a church or mosque." },
  riad: { label: "Riad", description: "A traditional home with an open-air courtyard or garden in Morocco." },
  shipping_container: { label: "Shipping container", description: "A converted steel container once used to transport goods." },
  tower: { label: "Tower", description: "A free-standing structure that's several stories tall with a view." },
  bnb: { label: "Bed and breakfast", description: "A hospitality business offering guests breakfast with a host on-site." },
  nature_eco_lodge: { label: "Nature lodge", description: "A business offering stays near natural settings like forests or mountains." },
  boutique_hotel: { label: "Boutique hotel", description: "A hospitality business with a unique style or theme defining its identity." },
  hostel: { label: "Hostel", description: "A hospitality business that rents beds in shared dorms and private rooms." },
  aparthotel: { label: "Aparthotel", description: "A place with hotel-like amenities and rooms that feel like apartments." },
  hotel: { label: "Hotel", description: "A business offering private rooms, suites, or unique stays for guests." },
  resort: { label: "Resort", description: "A hospitality business with more amenities and services than a hotel." },
} as const satisfies Record<string, { label: string; description: string }>

export type StayPropertyType = keyof typeof STAY_PROPERTY_TYPES

/** Airbnb's property groups and the types each offers; a type can sit in several groups. */
export const STAY_PROPERTY_TYPE_GROUPS = {
  apartments: { label: "Apartment", types: ['apartment', 'condominium', 'serviced_apartment', 'loft'] },
  houses: { label: "House", types: ['house', 'townhouse', 'bungalow', 'cabin', 'chalet', 'earthhouse', 'hut', 'lighthouse', 'villa', 'dome', 'cottage', 'farmstay', 'houseboat', 'tiny_house'] },
  secondary_units: { label: "Secondary unit", types: ['guesthouse', 'private_suite', 'farmstay'] },
  unique_homes: { label: "Unique space", types: ['boat', 'castle', 'cave', 'earthhouse', 'hut', 'igloo', 'island', 'lighthouse', 'plane', 'rv', 'tent', 'tipi', 'train', 'treehouse', 'yurt', 'other', 'dome', 'barn', 'campsite', 'farmstay', 'houseboat', 'tiny_house', 'windmill', 'bus', 'holiday_park', 'ranch', 'religious_building', 'riad', 'shipping_container', 'tower'] },
  bnb: { label: "Bed and breakfast", types: ['bnb', 'nature_eco_lodge', 'farmstay'] },
  boutique_hotels_and_more: { label: "Boutique hotel", types: ['boutique_hotel', 'nature_eco_lodge', 'hostel', 'serviced_apartment', 'aparthotel', 'hotel', 'resort'] },
} as const satisfies Record<string, { label: string; types: readonly StayPropertyType[] }>
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
  smart_lock: { label: 'Smart lock', symbol: 'lock.iphone' },
  keypad: { label: 'Keypad', symbol: 'circle.grid.3x3' },
  lockbox: { label: 'Lockbox', symbol: 'lock.square' },
  building_staff: { label: 'Building staff', symbol: 'person.badge.key' },
  in_person: { label: 'In-person greeting', symbol: 'hand.wave' },
  other: { label: 'Other', symbol: 'key' },
} as const satisfies Record<string, { label: string; symbol: string }>
export type StayCheckInMethod = keyof typeof STAY_CHECK_IN_METHODS

/** What guests are asked to do before they leave (Airbnb's checkout instructions), with the SF Symbol the app shows. */
export const STAY_CHECKOUT_TASKS = {
  gather_towels: { label: 'Gather used towels', symbol: 'basket' },
  throw_trash: { label: 'Throw trash away', symbol: 'trash' },
  turn_off: { label: 'Turn things off', symbol: 'power' },
  lock_up: { label: 'Lock up', symbol: 'lock' },
  return_keys: { label: 'Return keys', symbol: 'key' },
  additional: { label: 'Additional requests', symbol: 'text.bubble' },
} as const satisfies Record<string, { label: string; symbol: string }>
export type StayCheckoutTask = keyof typeof STAY_CHECKOUT_TASKS

/** Every amenity Airbnb's editor offers, by Airbnb's code, with the SF Symbol the app shows beside it. */
export const STAY_AMENITIES = {
  ac: { label: 'Air conditioning', symbol: 'snowflake' },
  dryer: { label: 'Dryer', symbol: 'dryer' },
  essentials: { label: 'Essentials', symbol: 'shippingbox' },
  heating: { label: 'Heating', symbol: 'heater.vertical' },
  hot_water: { label: 'Hot water', symbol: 'drop.degreesign' },
  kitchen: { label: 'Kitchen', symbol: 'fork.knife' },
  tv: { label: 'TV', symbol: 'tv' },
  washer: { label: 'Washer', symbol: 'washer' },
  wireless_internet: { label: 'Wifi', symbol: 'wifi' },
  bathtub: { label: 'Bathtub', symbol: 'bathtub' },
  bidet: { label: 'Bidet', symbol: 'toilet' },
  body_soap: { label: 'Body soap', symbol: 'bubbles.and.sparkles' },
  cleaning_products: { label: 'Cleaning products', symbol: 'hands.and.sparkles' },
  conditioner: { label: 'Conditioner', symbol: 'drop.halffull' },
  hair_dryer: { label: 'Hair dryer', symbol: 'wind' },
  alfresco_shower: { label: 'Outdoor shower', symbol: 'shower' },
  shampoo: { label: 'Shampoo', symbol: 'drop' },
  shower_gel: { label: 'Shower gel', symbol: 'drop.circle' },
  bed_linens: { label: 'Bed linens', symbol: 'bed.double' },
  wardrobe_or_closet: { label: 'Clothing storage', symbol: 'cabinet' },
  clothes_drying_rack: { label: 'Drying rack for clothing', symbol: 'tshirt' },
  extra_pillows_and_blankets: { label: 'Extra pillows and blankets', symbol: 'bed.double.circle' },
  hangers: { label: 'Hangers', symbol: 'hanger' },
  iron: { label: 'Iron', symbol: 'flame' },
  mosquito_net: { label: 'Mosquito net', symbol: 'ant' },
  room_darkening_shades: { label: 'Room-darkening shades', symbol: 'blinds.horizontal.closed' },
  safe: { label: 'Safe', symbol: 'lock.square.stack' },
  arcade_machine: { label: 'Arcade games', symbol: 'arcade.stick' },
  batting_cage: { label: 'Batting cage', symbol: 'figure.baseball' },
  books: { label: 'Books and reading material', symbol: 'books.vertical' },
  bowling_alley: { label: 'Bowling alley', symbol: 'figure.bowling' },
  climbing_wall: { label: 'Climbing wall', symbol: 'figure.climbing' },
  ethernet_connection: { label: 'Ethernet connection', symbol: 'cable.connector' },
  exercise_equipment: { label: 'Exercise equipment', symbol: 'dumbbell' },
  game_console: { label: 'Game console', symbol: 'gamecontroller' },
  laser_tag: { label: 'Laser tag', symbol: 'scope' },
  life_size_games: { label: 'Life size games', symbol: 'checkerboard.rectangle' },
  mini_golf: { label: 'Mini golf', symbol: 'figure.golf' },
  home_theater: { label: 'Movie theater', symbol: 'film' },
  piano: { label: 'Piano', symbol: 'pianokeys' },
  ping_pong_table: { label: 'Ping pong table', symbol: 'figure.table.tennis' },
  pool_table: { label: 'Pool table', symbol: 'circle.grid.cross' },
  record_player: { label: 'Record player', symbol: 'opticaldisc' },
  skate_ramp: { label: 'Skate ramp', symbol: 'figure.skateboarding' },
  sound_system: { label: 'Sound system', symbol: 'hifispeaker' },
  theme_room: { label: 'Theme room', symbol: 'theatermasks' },
  baby_bath: { label: 'Baby bath', symbol: 'bathtub.fill' },
  baby_monitor: { label: 'Baby monitor', symbol: 'video.circle' },
  childrens_bike: { label: 'Children’s bikes', symbol: 'bicycle' },
  playroom: { label: "Children's playroom", symbol: 'teddybear' },
  stair_gates: { label: 'Baby safety gates', symbol: 'square.split.2x1' },
  babysitter_recommendations: { label: 'Babysitter recommendations', symbol: 'person.2' },
  board_games: { label: 'Board games', symbol: 'die.face.5' },
  changing_table: { label: 'Changing table', symbol: 'table.furniture' },
  childrens_books_and_toys: { label: 'Children’s books and toys', symbol: 'book.closed' },
  childrens_dinnerware: { label: 'Children’s dinnerware', symbol: 'fork.knife.circle' },
  crib: { label: 'Crib', symbol: 'bed.double.circle.fill' },
  fireplace_guards: { label: 'Fireplace guards', symbol: 'fireplace.fill' },
  high_chair: { label: 'High chair', symbol: 'chair' },
  playground: { label: 'Outdoor playground', symbol: 'figure.play' },
  outlet_covers: { label: 'Outlet covers', symbol: 'poweroutlet.type.b' },
  pack_n_play_travel_crib: { label: 'Pack ’n play/Travel crib', symbol: 'square.on.square' },
  table_corner_guards: { label: 'Table corner guards', symbol: 'square.dashed' },
  window_guards: { label: 'Window guards', symbol: 'window.vertical.closed' },
  ceiling_fan: { label: 'Ceiling fan', symbol: 'fan.ceiling' },
  fireplace: { label: 'Indoor fireplace', symbol: 'fireplace' },
  portable_fans: { label: 'Portable fans', symbol: 'fan' },
  carbon_monoxide_detector: { label: 'Carbon monoxide alarm', symbol: 'sensor' },
  fire_extinguisher: { label: 'Fire extinguisher', symbol: 'flame.circle' },
  first_aid_kit: { label: 'First aid kit', symbol: 'cross.case' },
  smoke_detector: { label: 'Smoke alarm', symbol: 'smoke' },
  laptop_friendly_workspace: { label: 'Dedicated workspace', symbol: 'desktopcomputer' },
  pocket_wifi: { label: 'Pocket wifi', symbol: 'antenna.radiowaves.left.and.right' },
  baking_sheet: { label: 'Baking sheet', symbol: 'square.grid.3x3' },
  barbeque_utensils: { label: 'Barbecue utensils', symbol: 'fork.knife' },
  bread_maker: { label: 'Bread maker', symbol: 'birthday.cake' },
  blender: { label: 'Blender', symbol: 'cup.and.heat.waves' },
  coffee: { label: 'Coffee', symbol: 'cup.and.saucer.fill' },
  coffee_maker: { label: 'Coffee maker', symbol: 'cup.and.saucer' },
  cooking_basics: { label: 'Cooking basics', symbol: 'frying.pan' },
  dining_table: { label: 'Dining table', symbol: 'table.furniture.fill' },
  dishes_and_silverware: { label: 'Dishes and silverware', symbol: 'fork.knife.circle.fill' },
  dishwasher: { label: 'Dishwasher', symbol: 'dishwasher' },
  freezer: { label: 'Freezer', symbol: 'snowflake.circle' },
  hot_water_kettle: { label: 'Hot water kettle', symbol: 'mug' },
  kitchenette: { label: 'Kitchenette', symbol: 'stove.fill' },
  microwave: { label: 'Microwave', symbol: 'microwave' },
  mini_fridge: { label: 'Mini fridge', symbol: 'refrigerator.fill' },
  oven: { label: 'Oven', symbol: 'oven' },
  refrigerator: { label: 'Refrigerator', symbol: 'refrigerator' },
  rice_maker: { label: 'Rice maker', symbol: 'takeoutbag.and.cup.and.straw' },
  stove: { label: 'Stove', symbol: 'stove' },
  toaster: { label: 'Toaster', symbol: 'rectangle.split.2x1' },
  trash_compacter: { label: 'Trash compactor', symbol: 'trash' },
  wine_glasses: { label: 'Wine glasses', symbol: 'wineglass' },
  beach_access: { label: 'Beach access', symbol: 'beach.umbrella' },
  lake_access: { label: 'Lake access', symbol: 'water.waves' },
  laundromat_nearby: { label: 'Laundromat nearby', symbol: 'washer.fill' },
  private_entrance: { label: 'Private entrance', symbol: 'door.left.hand.open' },
  resort_access: { label: 'Resort access', symbol: 'building.2' },
  ski_in_ski_out: { label: 'Ski-in/Ski-out', symbol: 'figure.skiing.downhill' },
  waterfront: { label: 'Waterfront', symbol: 'water.waves.and.arrow.trianglehead.up' },
  garden_or_backyard: { label: 'Backyard', symbol: 'tree' },
  bbq_area: { label: 'BBQ grill', symbol: 'flame.fill' },
  beach_essentials: { label: 'Beach essentials', symbol: 'sun.max' },
  bicycle: { label: 'Bikes', symbol: 'bicycle' },
  boat_slip: { label: 'Boat slip', symbol: 'ferry' },
  fire_pit: { label: 'Fire pit', symbol: 'fireplace.fill' },
  hammock: { label: 'Hammock', symbol: 'figure.mind.and.body' },
  kayak: { label: 'Kayak', symbol: 'figure.outdoor.rowing' },
  alfresco_dining: { label: 'Outdoor dining area', symbol: 'table.furniture' },
  outdoor_seating: { label: 'Outdoor furniture', symbol: 'chair.lounge' },
  outdoor_kitchen: { label: 'Outdoor kitchen', symbol: 'frying.pan.fill' },
  patio_or_belcony: { label: 'Patio or balcony', symbol: 'sun.max.fill' },
  sun_loungers: { label: 'Sun loungers', symbol: 'chair.lounge.fill' },
  free_parking: { label: 'Free parking on premises', symbol: 'parkingsign' },
  street_parking: { label: 'Free street parking', symbol: 'parkingsign.square' },
  paid_parking_on_premises: { label: 'Paid parking on premises', symbol: 'parkingsign.circle' },
  paid_parking: { label: 'Paid parking off premises', symbol: 'parkingsign.circle.fill' },
  free_parking_off_premises: { label: 'Free parking off premises', symbol: 'car' },
  elevator: { label: 'Elevator', symbol: 'arrow.up.arrow.down.square' },
  ev_charger: { label: 'EV charger', symbol: 'ev.charger' },
  hockey_rink: { label: 'Hockey rink', symbol: 'figure.hockey' },
  gym: { label: 'Gym', symbol: 'figure.strengthtraining.traditional' },
  jacuzzi: { label: 'Hot tub', symbol: 'bathtub.fill' },
  pool: { label: 'Pool', symbol: 'figure.pool.swim' },
  private_living_room: { label: 'Private living room', symbol: 'sofa' },
  sauna: { label: 'Sauna', symbol: 'heat.waves' },
  single_level_home: { label: 'Single level home', symbol: 'house' },
  ebike_charger: { label: 'eBike charger', symbol: 'bicycle.circle' },
  solar_power: { label: 'Solar panels', symbol: 'sun.max.circle' },
  recycling: { label: 'Recycling', symbol: 'arrow.3.trianglepath' },
  composting: { label: 'Composting', symbol: 'leaf' },
  doorman: { label: 'Doorman', symbol: 'person.badge.key' },
  gated_community: { label: 'Gated community', symbol: 'shield.lefthalf.filled' },
  breakfast: { label: 'Breakfast', symbol: 'cup.and.saucer' },
  cleaning_before_checkout: { label: 'Cleaning available during stay', symbol: 'sparkles' },
  long_term_stays_allowed: { label: 'Long term stays allowed', symbol: 'calendar' },
  luggage_dropoff_allowed: { label: 'Luggage dropoff allowed', symbol: 'suitcase' },
} as const satisfies Record<string, { label: string; symbol: string }>

export type StayAmenity = keyof typeof STAY_AMENITIES

/** Airbnb's amenity groups in the editor's order; an amenity can sit in several groups. */
export const STAY_AMENITY_GROUPS = {
  basic: { label: 'Basics', amenities: ['ac', 'dryer', 'essentials', 'heating', 'hot_water', 'kitchen', 'tv', 'washer', 'wireless_internet'] },
  bathroom: { label: 'Bathroom', amenities: ['bathtub', 'bidet', 'body_soap', 'cleaning_products', 'conditioner', 'hair_dryer', 'hot_water', 'alfresco_shower', 'shampoo', 'shower_gel'] },
  bedroom_laundry: { label: 'Bedroom and laundry', amenities: ['essentials', 'bed_linens', 'wardrobe_or_closet', 'dryer', 'clothes_drying_rack', 'extra_pillows_and_blankets', 'hangers', 'iron', 'mosquito_net', 'room_darkening_shades', 'safe', 'washer'] },
  entertainment: { label: 'Entertainment', amenities: ['arcade_machine', 'batting_cage', 'books', 'bowling_alley', 'climbing_wall', 'ethernet_connection', 'exercise_equipment', 'game_console', 'laser_tag', 'life_size_games', 'mini_golf', 'home_theater', 'piano', 'ping_pong_table', 'pool_table', 'record_player', 'skate_ramp', 'sound_system', 'theme_room', 'tv'] },
  family: { label: 'Family', amenities: ['baby_bath', 'baby_monitor', 'childrens_bike', 'playroom', 'stair_gates', 'babysitter_recommendations', 'board_games', 'changing_table', 'childrens_books_and_toys', 'childrens_dinnerware', 'crib', 'fireplace_guards', 'high_chair', 'playground', 'outlet_covers', 'pack_n_play_travel_crib', 'table_corner_guards', 'window_guards'] },
  heating_cooling: { label: 'Heating and cooling', amenities: ['ac', 'ceiling_fan', 'heating', 'fireplace', 'portable_fans'] },
  home_safety: { label: 'Home safety', amenities: ['carbon_monoxide_detector', 'fire_extinguisher', 'first_aid_kit', 'smoke_detector'] },
  internet_office: { label: 'Internet and office', amenities: ['laptop_friendly_workspace', 'pocket_wifi', 'wireless_internet'] },
  kitchen_dining: { label: 'Kitchen and dining', amenities: ['baking_sheet', 'barbeque_utensils', 'bread_maker', 'blender', 'coffee', 'coffee_maker', 'cooking_basics', 'dining_table', 'dishes_and_silverware', 'dishwasher', 'freezer', 'hot_water_kettle', 'kitchen', 'kitchenette', 'microwave', 'mini_fridge', 'oven', 'refrigerator', 'rice_maker', 'stove', 'toaster', 'trash_compacter', 'wine_glasses'] },
  location: { label: 'Location features', amenities: ['beach_access', 'lake_access', 'laundromat_nearby', 'private_entrance', 'resort_access', 'ski_in_ski_out', 'waterfront'] },
  outdoor: { label: 'Outdoor', amenities: ['garden_or_backyard', 'bbq_area', 'beach_essentials', 'bicycle', 'boat_slip', 'fire_pit', 'hammock', 'kayak', 'alfresco_dining', 'outdoor_seating', 'outdoor_kitchen', 'patio_or_belcony', 'sun_loungers'] },
  facilities: { label: 'Parking and facilities', amenities: ['free_parking', 'street_parking', 'paid_parking_on_premises', 'paid_parking', 'free_parking_off_premises', 'elevator', 'ev_charger', 'hockey_rink', 'gym', 'jacuzzi', 'pool', 'private_living_room', 'sauna', 'single_level_home', 'ebike_charger', 'solar_power', 'recycling', 'composting', 'doorman', 'gated_community'] },
  services: { label: 'Services', amenities: ['breakfast', 'cleaning_before_checkout', 'long_term_stays_allowed', 'luggage_dropoff_allowed'] },
} as const satisfies Record<string, { label: string; amenities: readonly StayAmenity[] }>
export type StayAmenityGroup = keyof typeof STAY_AMENITY_GROUPS

export function isStayAmenity(value: unknown): value is StayAmenity {
  return typeof value === 'string' && Object.hasOwn(STAY_AMENITIES, value)
}

/** The codes of one vocabulary, for validators and JSON schemas. */
export function stayCodes<T extends Record<string, unknown>>(vocabulary: T): Array<keyof T & string> {
  return Object.keys(vocabulary) as Array<keyof T & string>
}
