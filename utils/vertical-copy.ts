export type OrganizationVertical =
  | "restaurant"
  | "experience"
  | "service"
  | "lodging";

// The single canonical list of app-level verticals a tenant can be created
// or migrated with. This is the one place that enumerates every supported
// value — server/utils/organization-provisioning.ts's VALID_VERTICALS re-exports this
// rather than redeclaring its own array, and any UI vertical picker should
// import this (or ALL_VERTICALS) instead of hand-writing a local
// 'restaurant' | 'experience' union that silently omits new verticals.
export const ALL_VERTICALS: OrganizationVertical[] = ["restaurant", "experience", "service", "lodging"];

// The verticals a website draft (the dashboard wizard and save_website_draft)
// can start. A draft asks for a public address and opening hours, which a
// vacation rental would have to invent; a lodging organization is created by
// the native app through POST /api/organizations instead.
export const WEBSITE_DRAFT_VERTICALS: OrganizationVertical[] = ALL_VERTICALS.filter(vertical => vertical !== "lodging");

type LocaleCode = "en" | "th" | "ja" | "vi";

type VerticalCopy = {
  poweredByTagline: string
  aboutImageAlt: string
  ctaTitle: string
  ctaRoute: string
  contactSubtitle: string
  contactSubjectCatering: string
  reserveCta: string
  reservationPageKicker: string
  reservationFormTitle: string
  reservationRequestButton: string
  reservationWord: string
  reservationExploreLabel: string
  reservationExploreRoute: string
  experiencesPageTitle: string
  experiencesPageSubtitle: string
  locationGroupLine: (_count: number) => string
  bookingNotesPlaceholder: string
  contactLocationsByHeading: string
  contactLocationsByNote: string
  otherLocationsHeading: string
  seoReservationDescription: (_name: string) => string
  seoExperiencesDescription: (_name: string) => string
  viewMenuCta: string
  viewMenuRoute: string
  findUsKicker: string
  visitLocationCta: string
  mainLocationLabel: string
  secondLocationLabel: string
  connectGoogleAddressNote: string
  addSecondLocationNote: string
  connectGoogleCta: string
  ourStoryKicker: string
  reviewsKicker: string
  guestReviewsLabel: string
  whatGuestsSayLabel: string
  noReviewsLabel: string
  connectGoogleReviewsCta: string
  allLocationsFilter: string
  aboutHeroTitle: string
  aboutHeroSubtitle: string
  ourJourneyKicker: string
  ourJourneyTitle: string
  wedLoveToSeeYou: string
  openNowLabel: string
  closedLabel: string
  mainDiningRoomLabel: string
  connectGoogleLocationsCta: string
  additionalLocationsNote: string
  noExperiencesLabel: string
  soldOutLabel: string
  temporarilyUnavailableLabel: string
  fullyBookedLabel: string
  notScheduledLabel: string
  viewExperienceCta: string
  guestsMaxLabel: string
  durationHourLabel: string
  durationMinuteLabel: string
  nameLabel: string
  namePlaceholder: string
  emailLabel: string
  emailPlaceholder: string
  phoneLabel: string
  phonePlaceholder: string
  dateLabel: string
  pickDayLabel: string
  timeLabel: string
  selectTimeLabel: string
  guestsLabel: string
  selectGuestsLabel: string
  specialRequestsLabel: string
  specialRequestsPlaceholder: string
  guestLabel: string
  guestsLabelPlural: string
  contactInfoHeading: string
  phoneLabelShort: string
  emailLabelShort: string
  reservationPoliciesHeading: string
  goodToKnowKicker: string
  callButtonLabel: string
  contactFormButtonLabel: string
  locationLabel: string
  selectLocationLabel: string
  chooseLocationLabel: string
  oneGuestLabel: string
  thankYouLabel: (_name: string) => string
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) => string
  manageLabel: (_word: string) => string
  cancelAnytimeLabel: string
  callUsLabel: (_phone: string) => string
  makeAnotherLabel: (_word: string) => string
  cancelLabel: (_word: string) => string
}

const registry: Record<LocaleCode, Partial<Record<OrganizationVertical, VerticalCopy>>> = {
  ja: {},
  vi: {},
  en: {
    restaurant: {
      poweredByTagline: "restaurant sites that run themselves",
      aboutImageAlt: "About our restaurant",
      ctaTitle: "Come dine with us.",
      ctaRoute: "/reservations",
      contactSubtitle:
        "For a reservation or visit, head to your nearest location, for press, partnerships, catering or anything else, use the form below.",
      contactSubjectCatering: "Catering & events",
      reserveCta: "Reserve a table",
      reservationPageKicker: "Reservations",
      reservationFormTitle: "Make a Reservation",
      reservationRequestButton: "Request Reservation",
      reservationWord: "reservation",
      reservationExploreLabel: "View Menu",
      reservationExploreRoute: "/menu",
      experiencesPageTitle: "Experiences",
      experiencesPageSubtitle:
        "Classes, special dinners, and bookable nights beyond the usual table reservation.",
      locationGroupLine: (_count: number) => {
        const count = _count
        return `${count} location${count === 1 ? "" : "s"}, one kitchen philosophy.`
      },
      bookingNotesPlaceholder:
        "Dietary needs, accessibility requests, preferred seating, or celebration notes.",
      contactLocationsByHeading: "Hours, address, phone, for each room.",
      contactLocationsByNote:
        'For full parking, accessibility and policy details, follow the "Plan a visit" link on each card.',
      otherLocationsHeading: "Sister rooms",
      seoReservationDescription: (_name: string) => `Reserve a table at ${_name}.`,
      seoExperiencesDescription: (_name: string) =>
        `Explore classes, tasting nights, and bookable experiences at ${_name}.`,
      viewMenuCta: "View Menu",
      viewMenuRoute: "/menu",
      findUsKicker: "Find us",
      visitLocationCta: "Visit this location →",
      mainLocationLabel: "Main location",
      secondLocationLabel: "Second location",
      connectGoogleAddressNote: "Import your address, hours, ratings, and reviews from Google Places.",
      addSecondLocationNote: "Add a second location once your first is connected.",
      connectGoogleCta: "Import from Google Maps →",
      ourStoryKicker: "Our story",
      reviewsKicker: "Reviews",
      guestReviewsLabel: "Guest reviews & ratings.",
      whatGuestsSayLabel: "What your guests say.",
      noReviewsLabel: "No reviews yet.",
      connectGoogleReviewsCta: "Import reviews from Google Places →",
      allLocationsFilter: "All locations",
      aboutHeroTitle: "About us",
      aboutHeroSubtitle: "",
      ourJourneyKicker: "The journey",
      ourJourneyTitle: "Our Journey",
      wedLoveToSeeYou: "We'd love to see you in person.",
      openNowLabel: "Open now",
      closedLabel: "Closed",
      mainDiningRoomLabel: "Main Dining Room",
      connectGoogleLocationsCta: "Add locations from Google Maps",
      additionalLocationsNote: "Additional locations appear here when added.",
      noExperiencesLabel: "No experiences available right now. Check back soon.",
      soldOutLabel: "Sold Out",
      temporarilyUnavailableLabel: "Temporarily unavailable",
      fullyBookedLabel: "Fully booked",
      notScheduledLabel: "Not currently scheduled",
      viewExperienceCta: "View experience",
      guestsMaxLabel: "guests max",
      durationHourLabel: "hr",
      durationMinuteLabel: "min",
      nameLabel: "Name",
      namePlaceholder: "Your name",
      emailLabel: "Email",
      emailPlaceholder: "you@example.com",
      phoneLabel: "Phone",
      phonePlaceholder: "+66 81 234 5678",
      dateLabel: "Date",
      pickDayLabel: "Pick a day above to continue.",
      timeLabel: "Time",
      selectTimeLabel: "Select a time",
      guestsLabel: "Guests",
      selectGuestsLabel: "Select guests",
      specialRequestsLabel: "Special requests",
      specialRequestsPlaceholder: "Tell us anything that will help us prepare for your visit.",
      guestLabel: "guest",
      guestsLabelPlural: "guests",
      contactInfoHeading: "Contact Information",
      phoneLabelShort: "Phone",
      emailLabelShort: "Email",
      reservationPoliciesHeading: "Reservation Policies",
      goodToKnowKicker: "Good to know",
      callButtonLabel: "Call",
      contactFormButtonLabel: "Contact Form",
      locationLabel: "Location",
      selectLocationLabel: "Select a location",
      chooseLocationLabel: "Please choose a location.",
      oneGuestLabel: "1 Guest",
      thankYouLabel: (_name: string) => `Thank you, ${_name}!`,
      confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
        `Your reservation for ${_guests} ${_guestLabel} on ${_date} at ${_time} is confirmed.`,
      manageLabel: (_word: string) => `Manage ${_word}`,
      cancelAnytimeLabel: "Changed your plans? Cancel anytime before your visit.",
      callUsLabel: (_phone: string) => `Call us: ${_phone}`,
      makeAnotherLabel: (_word: string) => `Make another ${_word}`,
      cancelLabel: (_word: string) => `Cancel ${_word}`,
    },
    experience: {
      poweredByTagline: "experience booking sites that run themselves",
      aboutImageAlt: "About our studio",
      ctaTitle: "Book a class.",
      ctaRoute: "/experiences",
      contactSubtitle:
        "For booking a class or checking availability, head to your nearest studio, for press, partnerships, workshops or anything else, use the form below.",
      contactSubjectCatering: "Workshops & events",
      reserveCta: "Book a class",
      reservationPageKicker: "Bookings",
      reservationFormTitle: "Make a Booking",
      reservationRequestButton: "Request Booking",
      reservationWord: "booking",
      reservationExploreLabel: "View Experiences",
      reservationExploreRoute: "/experiences",
      experiencesPageTitle: "Experiences",
      experiencesPageSubtitle:
        "Classes, workshops, and special sessions you can book right now.",
      locationGroupLine: (_count: number) => {
        const count = _count
        return `${count} location${count === 1 ? "" : "s"}, one hands-on experience.`
      },
      bookingNotesPlaceholder:
        "Accessibility requests, group details, or other notes.",
      contactLocationsByHeading: "Hours, address, phone, for each studio.",
      contactLocationsByNote:
        'For full parking, accessibility and booking policies, follow the "Plan a visit" link on each card.',
      otherLocationsHeading: "Other spaces",
      seoReservationDescription: (_name: string) => `Book a class at ${_name}.`,
      seoExperiencesDescription: (_name: string) =>
        `Browse classes and bookable experiences at ${_name}.`,
      viewMenuCta: "View Experiences",
      viewMenuRoute: "/experiences",
      findUsKicker: "Find us",
      visitLocationCta: "Visit this studio →",
      mainLocationLabel: "Main studio",
      secondLocationLabel: "Second studio",
      connectGoogleAddressNote: "Import your address, hours, ratings, and reviews from Google Places.",
      addSecondLocationNote: "Add a second studio once your first is connected.",
      connectGoogleCta: "Import from Google Maps →",
      ourStoryKicker: "Our story",
      reviewsKicker: "Reviews",
      guestReviewsLabel: "Guest reviews & ratings.",
      whatGuestsSayLabel: "What your guests say.",
      noReviewsLabel: "No reviews yet.",
      connectGoogleReviewsCta: "Import reviews from Google Places →",
      allLocationsFilter: "All locations",
      aboutHeroTitle: "About us",
      aboutHeroSubtitle: "",
      ourJourneyKicker: "The journey",
      ourJourneyTitle: "Our Journey",
      wedLoveToSeeYou: "We'd love to see you in person.",
      openNowLabel: "Open now",
      closedLabel: "Closed",
      mainDiningRoomLabel: "Main Studio",
      connectGoogleLocationsCta: "Add locations from Google Maps",
      additionalLocationsNote: "Additional locations appear here when added.",
      noExperiencesLabel: "No experiences available right now. Check back soon.",
      soldOutLabel: "Sold Out",
      temporarilyUnavailableLabel: "Temporarily unavailable",
      fullyBookedLabel: "Fully booked",
      notScheduledLabel: "Not currently scheduled",
      viewExperienceCta: "View experience",
      guestsMaxLabel: "guests max",
      durationHourLabel: "hr",
      durationMinuteLabel: "min",
      nameLabel: "Name",
      namePlaceholder: "Your name",
      emailLabel: "Email",
      emailPlaceholder: "you@example.com",
      phoneLabel: "Phone",
      phonePlaceholder: "+66 81 234 5678",
      dateLabel: "Date",
      pickDayLabel: "Pick a day above to continue.",
      timeLabel: "Time",
      selectTimeLabel: "Select a time",
      guestsLabel: "Guests",
      selectGuestsLabel: "Select guests",
      specialRequestsLabel: "Special requests",
      specialRequestsPlaceholder: "Tell us anything that will help us prepare for your visit.",
      guestLabel: "guest",
      guestsLabelPlural: "guests",
      contactInfoHeading: "Contact Information",
      phoneLabelShort: "Phone",
      emailLabelShort: "Email",
      reservationPoliciesHeading: "Booking Policies",
      goodToKnowKicker: "Good to know",
      callButtonLabel: "Call",
      contactFormButtonLabel: "Contact Form",
      locationLabel: "Studio",
      selectLocationLabel: "Select a studio",
      chooseLocationLabel: "Please choose a studio.",
      oneGuestLabel: "1 Guest",
      thankYouLabel: (_name: string) => `Thank you, ${_name}!`,
      confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
        `We've received your request for ${_guests} ${_guestLabel} on ${_date} at ${_time}.`,
      manageLabel: (_word: string) => `Manage ${_word}`,
      cancelAnytimeLabel: "Changed your plans? Cancel anytime before your visit.",
      callUsLabel: (_phone: string) => `Call us: ${_phone}`,
      makeAnotherLabel: (_word: string) => `Make another ${_word}`,
      cancelLabel: (_word: string) => `Cancel ${_word}`,
    },
  },
  th: {
    restaurant: {
      poweredByTagline: "เว็บไซต์ร้านอาหารที่ดูแลตัวเองได้",
      aboutImageAlt: "เกี่ยวกับร้านอาหารของเรา",
      ctaTitle: "มากินด้วยกัน",
      ctaRoute: "/reservations",
      contactSubtitle:
        "สำหรับการจองหรือมาเยี่ยมชม ให้ไปที่สาขาใกล้คุณที่สุด หากเป็นเรื่องสื่อ พาร์ตเนอร์ งานจัดเลี้ยง หรือเรื่องอื่น ๆ ใช้แบบฟอร์มด้านล่างได้เลย",
      contactSubjectCatering: "งานจัดเลี้ยงและอีเวนต์",
      reserveCta: "จองโต๊ะ",
      reservationPageKicker: "การจอง",
      reservationFormTitle: "ทำรายการจอง",
      reservationRequestButton: "ขอจองโต๊ะ",
      reservationWord: "การจอง",
      reservationExploreLabel: "ดูเมนู",
      reservationExploreRoute: "/menu",
      experiencesPageTitle: "ประสบการณ์",
      experiencesPageSubtitle:
        "คลาส อาหารค่ำพิเศษ และคืนพิเศษที่จองได้ นอกเหนือจากการจองโต๊ะปกติ",
      locationGroupLine: (_count: number) => {
        const count = _count
        return `${count} สาขา ปรัชญาครัวเดียว`
      },
      bookingNotesPlaceholder:
        "ความต้องการด้านอาหาร คำขอเรื่องการเข้าถึง ที่นั่งที่ชอบ หรือบันทึกสำหรับการฉลอง",
      contactLocationsByHeading: "เวลาทำการ ที่อยู่ โทรศัพท์ สำหรับแต่ละพื้นที่",
      contactLocationsByNote:
        'สำหรับรายละเอียดที่จอดรถ การเข้าถึง และนโยบายต่าง ๆ ให้กดลิงก์ "วางแผนการมาเยือน" ในแต่ละการ์ด',
      otherLocationsHeading: "ห้องพี่น้อง",
      seoReservationDescription: (_name: string) => `จองโต๊ะที่ ${_name}`,
      seoExperiencesDescription: (_name: string) =>
        `สำรวจคลาส ชิมอาหารค่ำ และประสบการณ์ที่จองได้ที่ ${_name}`,
      viewMenuCta: "ดูเมนู",
      viewMenuRoute: "/menu",
      findUsKicker: "หาเรา",
      visitLocationCta: "เยี่ยมชมสาขานี้ →",
      mainLocationLabel: "สาขาหลัก",
      secondLocationLabel: "สาขาที่สอง",
      connectGoogleAddressNote: "นำเข้าที่อยู่ เวลาทำการ คะแนน และรีวิวจาก Google Places",
      addSecondLocationNote: "เพิ่มสาขาที่สองเมื่อสาขาแรกเชื่อมต่อแล้ว",
      connectGoogleCta: "นำเข้าจาก Google Maps →",
      ourStoryKicker: "เรื่องราวของเรา",
      reviewsKicker: "รีวิว",
      guestReviewsLabel: "รีวิวและคะแนนจากแขก",
      whatGuestsSayLabel: "สิ่งที่แขกพูดถึง",
      noReviewsLabel: "ยังไม่มีรีวิว",
      connectGoogleReviewsCta: "นำเข้ารีวิวจาก Google Places →",
      allLocationsFilter: "ทุกสาขา",
      aboutHeroTitle: "เกี่ยวกับเรา",
      aboutHeroSubtitle: "",
      ourJourneyKicker: "การเดินทาง",
      ourJourneyTitle: "การเดินทางของเรา",
      wedLoveToSeeYou: "เรายินดีต้อนรับคุณอย่างใกล้ชิด",
      openNowLabel: "เปิดอยู่",
      closedLabel: "ปิดแล้ว",
      mainDiningRoomLabel: "ห้องรับประทานอาหารหลัก",
      connectGoogleLocationsCta: "เพิ่มสาขาจาก Google Maps",
      additionalLocationsNote: "สาขาเพิ่มเติมจะปรากฏที่นี่เมื่อเพิ่มแล้ว",
      noExperiencesLabel: "ยังไม่มีประสบการณ์ให้เลือกตอนนี้ ตรวจสอบอีกครั้งเร็วๆ นี้",
      soldOutLabel: "เต็มแล้ว",
      temporarilyUnavailableLabel: "ปิดให้บริการชั่วคราว",
      fullyBookedLabel: "เต็มแล้ว",
      notScheduledLabel: "ยังไม่มีกำหนดการ",
      viewExperienceCta: "ดูประสบการณ์",
      guestsMaxLabel: "แขกสูงสุด",
      durationHourLabel: "ชม.",
      durationMinuteLabel: "นาที",
      nameLabel: "ชื่อ",
      namePlaceholder: "ชื่อของคุณ",
      emailLabel: "อีเมล",
      emailPlaceholder: "you@example.com",
      phoneLabel: "โทรศัพท์",
      phonePlaceholder: "+66 81 234 5678",
      dateLabel: "วันที่",
      pickDayLabel: "เลือกวันด้านบนเพื่อดำเนินการต่อ",
      timeLabel: "เวลา",
      selectTimeLabel: "เลือกเวลา",
      guestsLabel: "จำนวนแขก",
      selectGuestsLabel: "เลือกจำนวนแขก",
      specialRequestsLabel: "คำขอพิเศษ",
      specialRequestsPlaceholder: "บอกเราสิ่งใดก็ได้ที่จะช่วยเราเตรียมการสำหรับการเยี่ยมชมของคุณ",
      guestLabel: "แขก",
      guestsLabelPlural: "แขก",
      contactInfoHeading: "ข้อมูลติดต่อ",
      phoneLabelShort: "โทรศัพท์",
      emailLabelShort: "อีเมล",
      reservationPoliciesHeading: "นโยบายการจอง",
      goodToKnowKicker: "ควรทราบ",
      callButtonLabel: "โทร",
      contactFormButtonLabel: "แบบฟอร์มติดต่อ",
      locationLabel: "สาขา",
      selectLocationLabel: "เลือกสาขา",
      chooseLocationLabel: "กรุณาเลือกสาขา",
      oneGuestLabel: "1 แขก",
      thankYouLabel: (_name: string) => `ขอบคุณ ${_name}!`,
      confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
        `การจองสำหรับ ${_guests} ${_guestLabel} วันที่ ${_date} เวลา ${_time} ได้รับการยืนยันแล้ว`,
      manageLabel: (_word: string) => `จัดการ${_word}`,
      cancelAnytimeLabel: "เปลี่ยนแผนแล้วหรือ? ยกเลิกได้ทุกเมื่อก่อนมาเยือน",
      callUsLabel: (_phone: string) => `โทรหาเรา: ${_phone}`,
      makeAnotherLabel: (_word: string) => `สร้าง${_word}ใหม่`,
      cancelLabel: (_word: string) => `ยกเลิก${_word}`,
    },
    experience: {
      poweredByTagline: "เว็บไซต์จองประสบการณ์ที่ดูแลตัวเองได้",
      aboutImageAlt: "เกี่ยวกับสตูดิโอของเรา",
      ctaTitle: "จองคลาส",
      ctaRoute: "/experiences",
      contactSubtitle:
        "สำหรับการจองคลาสหรือตรวจสอบคิว ให้ไปที่สตูดิโอใกล้คุณ หากเป็นเรื่องสื่อ พาร์ตเนอร์ เวิร์กช็อป หรือเรื่องอื่น ๆ ใช้แบบฟอร์มด้านล่างได้เลย",
      contactSubjectCatering: "เวิร์กช็อปและอีเวนต์",
      reserveCta: "จองคลาส",
      reservationPageKicker: "การจอง",
      reservationFormTitle: "สร้างการจอง",
      reservationRequestButton: "ขอจอง",
      reservationWord: "การจอง",
      reservationExploreLabel: "ดูประสบการณ์",
      reservationExploreRoute: "/experiences",
      experiencesPageTitle: "ประสบการณ์",
      experiencesPageSubtitle:
        "คลาส เวิร์กช็อป และเซสชันพิเศษที่จองได้ตอนนี้",
      locationGroupLine: (_count: number) => {
        const count = _count
        return `${count} สาขา ประสบการณ์ลงมือทำแบบเดียวกัน`
      },
      bookingNotesPlaceholder:
        "คำขอเรื่องการเข้าถึง รายละเอียดกลุ่ม หรือหมายเหตุอื่น ๆ",
      contactLocationsByHeading: "เวลาทำการ ที่อยู่ โทรศัพท์ สำหรับแต่ละสตูดิโอ",
      contactLocationsByNote:
        'สำหรับรายละเอียดที่จอดรถ การเข้าถึง และนโยบายการจอง ให้กดลิงก์ "วางแผนการมาเยือน" ในแต่ละการ์ด',
      otherLocationsHeading: "พื้นที่อื่น ๆ",
      seoReservationDescription: (_name: string) => `จองคลาสที่ ${_name}`,
      seoExperiencesDescription: (_name: string) =>
        `เลือกดูคลาสและประสบการณ์ที่จองได้ที่ ${_name}`,
      viewMenuCta: "ดูประสบการณ์",
      viewMenuRoute: "/experiences",
      findUsKicker: "หาเรา",
      visitLocationCta: "เยี่ยมชมสตูดิโอนี้ →",
      mainLocationLabel: "สตูดิโอหลัก",
      secondLocationLabel: "สตูดิโอที่สอง",
      connectGoogleAddressNote: "นำเข้าที่อยู่ เวลาทำการ คะแนน และรีวิวจาก Google Places",
      addSecondLocationNote: "เพิ่มสตูดิโอที่สองเมื่อสตูดิโอแรกเชื่อมต่อแล้ว",
      connectGoogleCta: "นำเข้าจาก Google Maps →",
      ourStoryKicker: "เรื่องราวของเรา",
      reviewsKicker: "รีวิว",
      guestReviewsLabel: "รีวิวและคะแนนจากแขก",
      whatGuestsSayLabel: "สิ่งที่แขกพูดถึง",
      noReviewsLabel: "ยังไม่มีรีวิว",
      connectGoogleReviewsCta: "นำเข้ารีวิวจาก Google Places →",
      allLocationsFilter: "ทุกสาขา",
      aboutHeroTitle: "เกี่ยวกับเรา",
      aboutHeroSubtitle: "",
      ourJourneyKicker: "การเดินทาง",
      ourJourneyTitle: "การเดินทางของเรา",
      wedLoveToSeeYou: "เรายินดีต้อนรับคุณอย่างใกล้ชิด",
      openNowLabel: "เปิดอยู่",
      closedLabel: "ปิดแล้ว",
      mainDiningRoomLabel: "สตูดิโอหลัก",
      connectGoogleLocationsCta: "เพิ่มสาขาจาก Google Maps",
      additionalLocationsNote: "สาขาเพิ่มเติมจะปรากฏที่นี่เมื่อเพิ่มแล้ว",
      noExperiencesLabel: "ยังไม่มีประสบการณ์ให้เลือกตอนนี้ ตรวจสอบอีกครั้งเร็วๆ นี้",
      soldOutLabel: "เต็มแล้ว",
      temporarilyUnavailableLabel: "ปิดให้บริการชั่วคราว",
      fullyBookedLabel: "เต็มแล้ว",
      notScheduledLabel: "ยังไม่มีกำหนดการ",
      viewExperienceCta: "ดูประสบการณ์",
      guestsMaxLabel: "แขกสูงสุด",
      durationHourLabel: "ชม.",
      durationMinuteLabel: "นาที",
      nameLabel: "ชื่อ",
      namePlaceholder: "ชื่อของคุณ",
      emailLabel: "อีเมล",
      emailPlaceholder: "you@example.com",
      phoneLabel: "โทรศัพท์",
      phonePlaceholder: "+66 81 234 5678",
      dateLabel: "วันที่",
      pickDayLabel: "เลือกวันด้านบนเพื่อดำเนินการต่อ",
      timeLabel: "เวลา",
      selectTimeLabel: "เลือกเวลา",
      guestsLabel: "จำนวนแขก",
      selectGuestsLabel: "เลือกจำนวนแขก",
      specialRequestsLabel: "คำขอพิเศษ",
      specialRequestsPlaceholder: "บอกเราสิ่งใดก็ได้ที่จะช่วยเราเตรียมการสำหรับการเยี่ยมชมของคุณ",
      guestLabel: "แขก",
      guestsLabelPlural: "แขก",
      contactInfoHeading: "ข้อมูลติดต่อ",
      phoneLabelShort: "โทรศัพท์",
      emailLabelShort: "อีเมล",
      reservationPoliciesHeading: "นโยบายการจอง",
      goodToKnowKicker: "ควรทราบ",
      callButtonLabel: "โทร",
      contactFormButtonLabel: "แบบฟอร์มติดต่อ",
      locationLabel: "สตูดิโอ",
      selectLocationLabel: "เลือกสตูดิโอ",
      chooseLocationLabel: "กรุณาเลือกสตูดิโอ",
      oneGuestLabel: "1 แขก",
      thankYouLabel: (_name: string) => `ขอบคุณ ${_name}!`,
      confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
        `เราได้รับคำขอของคุณสำหรับ ${_guests} ${_guestLabel} วันที่ ${_date} เวลา ${_time}`,
      manageLabel: (_word: string) => `จัดการ${_word}`,
      cancelAnytimeLabel: "เปลี่ยนแผนแล้วหรือ? ยกเลิกได้ทุกเมื่อก่อนมาเยือน",
      callUsLabel: (_phone: string) => `โทรหาเรา: ${_phone}`,
      makeAnotherLabel: (_word: string) => `สร้าง${_word}ใหม่`,
      cancelLabel: (_word: string) => `ยกเลิก${_word}`,
    },
  },
}

registry.en.service = {
  ...(registry.en.experience ?? registry.en.restaurant!),
  poweredByTagline: "professional-service sites that stay current",
  aboutImageAlt: "About our organization",
  ctaTitle: "Talk with our team.",
  ctaRoute: "",
  contactSubtitle:
    "For a consultation or service question, use the form below or choose a direct contact option.",
  contactSubjectCatering: "Services",
  reserveCta: "",
  reservationPageKicker: "Consultations",
  reservationFormTitle: "Request a Consultation",
  reservationRequestButton: "Request Consultation",
  reservationWord: "consultation",
  reservationExploreLabel: "View Services",
  reservationExploreRoute: "/services",
  experiencesPageTitle: "Services",
  experiencesPageSubtitle:
    "Professional services and practice areas you can explore before getting in touch.",
  locationGroupLine: (_count: number) => "Our locations",
  bookingNotesPlaceholder:
    "Tell us what kind of help you need, preferred contact times, or accessibility notes.",
  contactLocationsByHeading: "Contact details and service-area information.",
  contactLocationsByNote:
    "Some professional-service locations may represent a service area or remote contact point rather than a public office.",
  otherLocationsHeading: "Other service areas",
  seoReservationDescription: (_name: string) => `Request a consultation with ${_name}.`,
  seoExperiencesDescription: (_name: string) =>
    `Explore professional services from ${_name}.`,
  viewMenuCta: "View Services",
  viewMenuRoute: "/services",
  findUsKicker: "Contact",
  visitLocationCta: "View contact details",
  mainLocationLabel: "Primary contact",
  secondLocationLabel: "Additional contact",
  connectGoogleAddressNote: "Optionally import public office details and hours from Google Places.",
  addSecondLocationNote: "Add another office or service-area presence when needed.",
  connectGoogleCta: "Import from Google Maps",
  ourStoryKicker: "About",
  reviewsKicker: "Reviews",
  guestReviewsLabel: "Client reviews and ratings.",
  whatGuestsSayLabel: "What clients say.",
  noReviewsLabel: "No reviews yet.",
  connectGoogleReviewsCta: "Import reviews from Google Places",
  allLocationsFilter: "All",
  aboutHeroTitle: "About us",
  aboutHeroSubtitle: "",
  ourJourneyKicker: "Our work",
  ourJourneyTitle: "How We Help",
  wedLoveToSeeYou: "We would be glad to hear from you.",
  openNowLabel: "Open now",
  closedLabel: "Closed",
  mainDiningRoomLabel: "Primary office",
  connectGoogleLocationsCta: "Add public office details from Google Maps",
  additionalLocationsNote: "Additional offices or service areas appear here when added.",
  noExperiencesLabel: "No services are published yet.",
  soldOutLabel: "Unavailable",
  temporarilyUnavailableLabel: "Temporarily unavailable",
  fullyBookedLabel: "Fully booked",
  notScheduledLabel: "Not currently scheduled",
  viewExperienceCta: "View service",
  guestsMaxLabel: "people max",
  durationHourLabel: "hr",
  durationMinuteLabel: "min",
  specialRequestsLabel: "How can we help?",
  specialRequestsPlaceholder: "Tell us what kind of help you need.",
  guestLabel: "person",
  guestsLabelPlural: "people",
  reservationPoliciesHeading: "Consultation Details",
  goodToKnowKicker: "Good to know",
  locationLabel: "Office",
  selectLocationLabel: "Select an office",
  chooseLocationLabel: "Please choose an office or contact point.",
  oneGuestLabel: "1 person",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `We have received your consultation request for ${_guests} ${_guestLabel} on ${_date} at ${_time}.`,
  callUsLabel: (_phone: string) => `Call: ${_phone}`,
}

registry.th.service = {
  ...registry.th.experience!,
  poweredByTagline: "เว็บไซต์ธุรกิจบริการมืออาชีพที่อัปเดตอยู่เสมอ",
  aboutImageAlt: "เกี่ยวกับองค์กรของเรา",
  ctaTitle: "พูดคุยกับทีมของเรา",
  ctaRoute: "",
  contactSubtitle: "หากต้องการขอคำปรึกษาหรือสอบถามเกี่ยวกับบริการ ใช้แบบฟอร์มด้านล่างหรือเลือกช่องทางติดต่อโดยตรงได้เลย",
  contactSubjectCatering: "บริการ",
  reserveCta: "",
  reservationPageKicker: "การปรึกษา",
  reservationFormTitle: "ขอรับคำปรึกษา",
  reservationRequestButton: "ส่งคำขอปรึกษา",
  reservationWord: "การปรึกษา",
  reservationExploreLabel: "ดูบริการ",
  reservationExploreRoute: "/services",
  experiencesPageTitle: "บริการ",
  experiencesPageSubtitle: "บริการและความเชี่ยวชาญที่คุณดูได้ก่อนติดต่อเรา",
  locationGroupLine: (_count: number) => `${_count} จุดให้บริการ ทีมเดียวกัน`,
  bookingNotesPlaceholder: "บอกเราว่าคุณต้องการความช่วยเหลือแบบใด ช่วงเวลาที่สะดวกให้ติดต่อ หรือความต้องการด้านการเข้าถึง",
  contactLocationsByHeading: "ข้อมูลติดต่อและพื้นที่ให้บริการ",
  contactLocationsByNote: "บางสถานที่อาจเป็นพื้นที่ให้บริการหรือช่องทางติดต่อออนไลน์ ไม่ใช่สำนักงานที่เปิดให้เข้าพบ",
  otherLocationsHeading: "พื้นที่ให้บริการอื่น ๆ",
  seoReservationDescription: (_name: string) => `ขอรับคำปรึกษากับ ${_name}`,
  seoExperiencesDescription: (_name: string) => `ดูบริการมืออาชีพจาก ${_name}`,
  viewMenuCta: "ดูบริการ",
  viewMenuRoute: "/services",
  findUsKicker: "ติดต่อ",
  visitLocationCta: "ดูข้อมูลติดต่อ",
  mainLocationLabel: "ช่องทางติดต่อหลัก",
  secondLocationLabel: "ช่องทางติดต่อเพิ่มเติม",
  connectGoogleAddressNote: "นำเข้าข้อมูลสำนักงานและเวลาทำการจาก Google Places ได้ตามต้องการ",
  addSecondLocationNote: "เพิ่มสำนักงานหรือพื้นที่ให้บริการอื่นได้เมื่อต้องการ",
  guestReviewsLabel: "รีวิวและคะแนนจากลูกค้า",
  whatGuestsSayLabel: "ลูกค้าพูดถึงเราอย่างไร",
  allLocationsFilter: "ทั้งหมด",
  ourStoryKicker: "เกี่ยวกับเรา",
  ourJourneyKicker: "งานของเรา",
  ourJourneyTitle: "เราช่วยคุณได้อย่างไร",
  wedLoveToSeeYou: "ยินดีที่จะได้รับการติดต่อจากคุณ",
  mainDiningRoomLabel: "สำนักงานหลัก",
  connectGoogleLocationsCta: "เพิ่มข้อมูลสำนักงานจาก Google Maps",
  additionalLocationsNote: "สำนักงานหรือพื้นที่ให้บริการที่เพิ่มจะแสดงที่นี่",
  noExperiencesLabel: "ยังไม่มีบริการที่เผยแพร่",
  soldOutLabel: "ไม่เปิดรับ",
  viewExperienceCta: "ดูบริการ",
  guestsMaxLabel: "คนสูงสุด",
  specialRequestsLabel: "เราช่วยอะไรคุณได้บ้าง",
  specialRequestsPlaceholder: "บอกเราว่าคุณต้องการความช่วยเหลือแบบใด",
  guestLabel: "คน",
  guestsLabelPlural: "คน",
  reservationPoliciesHeading: "รายละเอียดการปรึกษา",
  locationLabel: "สำนักงาน",
  selectLocationLabel: "เลือกสำนักงาน",
  chooseLocationLabel: "โปรดเลือกสำนักงานหรือช่องทางติดต่อ",
  oneGuestLabel: "1 คน",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `เราได้รับคำขอปรึกษาสำหรับ ${_guests} ${_guestLabel} ในวันที่ ${_date} เวลา ${_time} แล้ว`,
}

// Japanese has complete copy for every supported vertical. Shared wording is
// composed within Japanese; no English registry entry supplies Japanese text.
registry.ja.restaurant = {
  poweredByTagline: "自動で運営できる飲食店のウェブサイト",
  aboutImageAlt: "当店について",
  ctaTitle: "お食事にいらっしゃいませんか。",
  ctaRoute: "/reservations",
  contactSubtitle: "ご予約やご来店については最寄りの店舗ページをご確認ください。取材、提携、ケータリング、その他のお問い合わせは下記フォームをご利用ください。",
  contactSubjectCatering: "ケータリング・イベント",
  reserveCta: "席を予約する",
  reservationPageKicker: "ご予約",
  reservationFormTitle: "席のご予約",
  reservationRequestButton: "予約を申し込む",
  reservationWord: "予約",
  reservationExploreLabel: "メニューを見る",
  reservationExploreRoute: "/menu",
  experiencesPageTitle: "体験",
  experiencesPageSubtitle: "通常のお席のご予約に加え、料理教室や特別なディナーなどをお楽しみいただけます。",
  locationGroupLine: (_count: number) => `${_count}店舗で、料理への同じ想いを。`,
  bookingNotesPlaceholder: "食事制限、バリアフリー対応、ご希望のお席、お祝いなどについてお知らせください。",
  contactLocationsByHeading: "各店舗の営業時間・住所・電話番号。",
  contactLocationsByNote: "駐車場、バリアフリー対応、各種方針の詳細は、各店舗の「来店情報」からご確認ください。",
  otherLocationsHeading: "姉妹店",
  seoReservationDescription: (_name: string) => `${_name}のお席をご予約いただけます。`,
  seoExperiencesDescription: (_name: string) => `${_name}の料理教室、テイスティング、各種体験をご覧ください。`,
  viewMenuCta: "メニューを見る",
  viewMenuRoute: "/menu",
  findUsKicker: "アクセス",
  visitLocationCta: "この店舗を見る →",
  mainLocationLabel: "本店",
  secondLocationLabel: "2号店",
  connectGoogleAddressNote: "Google Placesから住所、営業時間、評価、レビューをインポートします。",
  addSecondLocationNote: "最初の店舗を接続した後、2店舗目を追加できます。",
  connectGoogleCta: "Google マップからインポート →",
  ourStoryKicker: "私たちのストーリー",
  reviewsKicker: "レビュー",
  guestReviewsLabel: "お客様のレビューと評価。",
  whatGuestsSayLabel: "お客様の声。",
  noReviewsLabel: "まだレビューはありません。",
  connectGoogleReviewsCta: "Google Placesからレビューをインポート →",
  allLocationsFilter: "すべての店舗",
  aboutHeroTitle: "私たちについて",
  aboutHeroSubtitle: "",
  ourJourneyKicker: "これまでの歩み",
  ourJourneyTitle: "私たちの歩み",
  wedLoveToSeeYou: "ご来店をお待ちしております。",
  openNowLabel: "営業中",
  closedLabel: "営業時間外",
  mainDiningRoomLabel: "メインダイニング",
  connectGoogleLocationsCta: "Google マップから店舗を追加",
  additionalLocationsNote: "追加した店舗がここに表示されます。",
  noExperiencesLabel: "現在ご予約いただける体験はありません。",
  soldOutLabel: "満席",
  temporarilyUnavailableLabel: "一時的にご利用いただけません",
  fullyBookedLabel: "予約で満席です",
  notScheduledLabel: "現在の開催予定はありません",
  viewExperienceCta: "体験を見る",
  guestsMaxLabel: "名まで",
  durationHourLabel: "時間",
  durationMinuteLabel: "分",
  nameLabel: "お名前",
  namePlaceholder: "お名前を入力してください",
  emailLabel: "メールアドレス",
  emailPlaceholder: "you@example.com",
  phoneLabel: "電話番号",
  phonePlaceholder: "+66 81 234 5678",
  dateLabel: "日付",
  pickDayLabel: "上から日付を選択してください。",
  timeLabel: "時間",
  selectTimeLabel: "時間を選択",
  guestsLabel: "人数",
  selectGuestsLabel: "人数を選択",
  specialRequestsLabel: "特別なご要望",
  specialRequestsPlaceholder: "ご来店にあたり、ご希望などがありましたらお知らせください。",
  guestLabel: "名",
  guestsLabelPlural: "名",
  contactInfoHeading: "連絡先",
  phoneLabelShort: "電話",
  emailLabelShort: "メール",
  reservationPoliciesHeading: "ご予約について",
  goodToKnowKicker: "ご案内",
  callButtonLabel: "電話する",
  contactFormButtonLabel: "お問い合わせフォーム",
  locationLabel: "店舗",
  selectLocationLabel: "店舗を選択",
  chooseLocationLabel: "店舗を選択してください。",
  oneGuestLabel: "1名",
  thankYouLabel: (_name: string) => `${_name}様、ありがとうございます。`,
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `${_date} ${_time}、${_guests}${_guestLabel}様のご予約が確定しました。`,
  manageLabel: (_word: string) => `${_word}を管理`,
  cancelAnytimeLabel: "ご予定が変わった場合は、ご来店前にキャンセルできます。",
  callUsLabel: (_phone: string) => `お電話：${_phone}`,
  makeAnotherLabel: (_word: string) => `新しい${_word}をする`,
  cancelLabel: (_word: string) => `${_word}をキャンセル`,
}

registry.ja.experience = {
  ...registry.ja.restaurant,
  poweredByTagline: "自動で運営できる体験予約のウェブサイト",
  aboutImageAlt: "スタジオについて",
  ctaTitle: "クラスを予約する。",
  ctaRoute: "/experiences",
  contactSubtitle: "クラスのご予約や空き状況は最寄りのスタジオページをご確認ください。取材、提携、ワークショップ、その他のお問い合わせは下記フォームをご利用ください。",
  contactSubjectCatering: "ワークショップ・イベント",
  reserveCta: "クラスを予約する",
  reservationFormTitle: "体験のご予約",
  reservationExploreLabel: "体験を見る",
  reservationExploreRoute: "/experiences",
  experiencesPageSubtitle: "ご予約可能なクラス、ワークショップ、特別なセッションをご覧ください。",
  locationGroupLine: (_count: number) => `${_count}か所で、同じ体験を。`,
  bookingNotesPlaceholder: "バリアフリー対応、グループの詳細、その他のご要望をお知らせください。",
  contactLocationsByHeading: "各スタジオの営業時間・住所・電話番号。",
  contactLocationsByNote: "駐車場、バリアフリー対応、ご予約の詳細は、各スタジオの「来店情報」からご確認ください。",
  otherLocationsHeading: "その他のスタジオ",
  seoReservationDescription: (_name: string) => `${_name}のクラスをご予約いただけます。`,
  seoExperiencesDescription: (_name: string) => `${_name}のクラスや各種体験をご覧ください。`,
  viewMenuCta: "体験を見る",
  viewMenuRoute: "/experiences",
  visitLocationCta: "このスタジオを見る →",
  mainLocationLabel: "メインスタジオ",
  secondLocationLabel: "2つ目のスタジオ",
  addSecondLocationNote: "最初のスタジオを接続した後、2つ目を追加できます。",
  mainDiningRoomLabel: "メインスタジオ",
  locationLabel: "スタジオ",
  selectLocationLabel: "スタジオを選択",
  chooseLocationLabel: "スタジオを選択してください。",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `${_date} ${_time}、${_guests}${_guestLabel}様のご予約リクエストを受け付けました。`,
}

registry.ja.service = {
  ...registry.ja.experience,
  poweredByTagline: "常に最新の情報を届ける専門サービスのウェブサイト",
  aboutImageAlt: "私たちの組織について",
  ctaTitle: "私たちにご相談ください。",
  ctaRoute: "",
  contactSubtitle: "ご相談やサービスに関するご質問は、下記フォームまたは直接の連絡先からお問い合わせください。",
  contactSubjectCatering: "サービス",
  reserveCta: "",
  reservationPageKicker: "ご相談",
  reservationFormTitle: "相談を申し込む",
  reservationRequestButton: "相談を申し込む",
  reservationWord: "相談",
  reservationExploreLabel: "サービスを見る",
  reservationExploreRoute: "/services",
  experiencesPageTitle: "サービス",
  experiencesPageSubtitle: "お問い合わせの前に、専門サービスや対応分野をご覧ください。",
  locationGroupLine: (_count: number) => `${_count}の拠点で、ひとつのチームが対応します。`,
  bookingNotesPlaceholder: "ご相談内容、ご希望の連絡時間、バリアフリー対応などについてお知らせください。",
  contactLocationsByHeading: "連絡先と対応地域。",
  contactLocationsByNote: "拠点には、ご来訪いただける事務所以外に、対応地域やオンライン窓口が含まれる場合があります。",
  otherLocationsHeading: "その他の対応地域",
  seoReservationDescription: (_name: string) => `${_name}へのご相談をお申し込みいただけます。`,
  seoExperiencesDescription: (_name: string) => `${_name}の専門サービスをご覧ください。`,
  viewMenuCta: "サービスを見る",
  viewMenuRoute: "/services",
  findUsKicker: "お問い合わせ",
  visitLocationCta: "連絡先を見る",
  mainLocationLabel: "主な連絡先",
  secondLocationLabel: "その他の連絡先",
  connectGoogleAddressNote: "必要に応じて、Google Placesから事務所の情報や営業時間をインポートできます。",
  addSecondLocationNote: "必要に応じて、別の事務所や対応地域を追加できます。",
  allLocationsFilter: "すべて",
  ourStoryKicker: "私たちについて",
  ourJourneyKicker: "私たちの仕事",
  ourJourneyTitle: "私たちにできること",
  wedLoveToSeeYou: "お問い合わせをお待ちしております。",
  mainDiningRoomLabel: "主な事務所",
  connectGoogleLocationsCta: "Google マップから事務所の情報を追加",
  additionalLocationsNote: "追加した事務所や対応地域がここに表示されます。",
  noExperiencesLabel: "公開されているサービスはまだありません。",
  soldOutLabel: "受付終了",
  viewExperienceCta: "サービスを見る",
  specialRequestsLabel: "ご相談内容",
  specialRequestsPlaceholder: "どのようなお手伝いが必要かお知らせください。",
  reservationPoliciesHeading: "ご相談の詳細",
  locationLabel: "事務所",
  selectLocationLabel: "事務所を選択",
  chooseLocationLabel: "事務所または窓口を選択してください。",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `${_date} ${_time}、${_guests}${_guestLabel}様のご相談リクエストを受け付けました。`,
}

// Vietnamese has complete copy for every supported vertical, composed the same
// way as Japanese: each vertical overrides the one before it.
registry.vi.restaurant = {
  poweredByTagline: "Website nhà hàng tự vận hành",
  aboutImageAlt: "Về nhà hàng của chúng tôi",
  ctaTitle: "Hãy đến dùng bữa cùng chúng tôi.",
  ctaRoute: "/reservations",
  contactSubtitle: "Để đặt bàn hoặc ghé thăm, vui lòng xem trang chi nhánh gần bạn nhất. Với báo chí, hợp tác, đặt tiệc hoặc các yêu cầu khác, vui lòng dùng biểu mẫu bên dưới.",
  contactSubjectCatering: "Đặt tiệc & sự kiện",
  reserveCta: "Đặt bàn",
  reservationPageKicker: "Đặt chỗ",
  reservationFormTitle: "Đặt bàn",
  reservationRequestButton: "Gửi yêu cầu đặt bàn",
  reservationWord: "đặt bàn",
  reservationExploreLabel: "Xem thực đơn",
  reservationExploreRoute: "/menu",
  experiencesPageTitle: "Trải nghiệm",
  experiencesPageSubtitle: "Ngoài đặt bàn thông thường, bạn có thể tham gia lớp nấu ăn, bữa tối đặc biệt và nhiều trải nghiệm khác.",
  locationGroupLine: (_count: number) => `${_count} chi nhánh, cùng một tâm huyết với ẩm thực.`,
  bookingNotesPlaceholder: "Cho chúng tôi biết về chế độ ăn kiêng, nhu cầu tiếp cận, chỗ ngồi mong muốn hoặc dịp kỷ niệm.",
  contactLocationsByHeading: "Giờ mở cửa, địa chỉ và số điện thoại của từng chi nhánh.",
  contactLocationsByNote: "Thông tin chỗ đỗ xe, lối đi tiếp cận và chính sách có trong mục Ghé thăm của từng chi nhánh.",
  otherLocationsHeading: "Các chi nhánh khác",
  seoReservationDescription: (_name: string) => `Đặt bàn tại ${_name}.`,
  seoExperiencesDescription: (_name: string) => `Khám phá lớp nấu ăn, buổi thưởng thức và các trải nghiệm tại ${_name}.`,
  viewMenuCta: "Xem thực đơn",
  viewMenuRoute: "/menu",
  findUsKicker: "Tìm chúng tôi",
  visitLocationCta: "Xem chi nhánh này →",
  mainLocationLabel: "Chi nhánh chính",
  secondLocationLabel: "Chi nhánh thứ hai",
  connectGoogleAddressNote: "Nhập địa chỉ, giờ mở cửa, xếp hạng và đánh giá từ Google Places.",
  addSecondLocationNote: "Bạn có thể thêm chi nhánh thứ hai sau khi kết nối chi nhánh đầu tiên.",
  connectGoogleCta: "Nhập từ Google Maps →",
  ourStoryKicker: "Câu chuyện của chúng tôi",
  reviewsKicker: "Đánh giá",
  guestReviewsLabel: "Đánh giá và xếp hạng của khách.",
  whatGuestsSayLabel: "Khách hàng nói gì.",
  noReviewsLabel: "Chưa có đánh giá nào.",
  connectGoogleReviewsCta: "Nhập đánh giá từ Google Places →",
  allLocationsFilter: "Tất cả chi nhánh",
  aboutHeroTitle: "Về chúng tôi",
  aboutHeroSubtitle: "",
  ourJourneyKicker: "Hành trình",
  ourJourneyTitle: "Hành trình của chúng tôi",
  wedLoveToSeeYou: "Rất mong được đón tiếp bạn.",
  openNowLabel: "Đang mở cửa",
  closedLabel: "Đã đóng cửa",
  mainDiningRoomLabel: "Phòng ăn chính",
  connectGoogleLocationsCta: "Thêm chi nhánh từ Google Maps",
  additionalLocationsNote: "Các chi nhánh bạn thêm sẽ hiển thị tại đây.",
  noExperiencesLabel: "Hiện chưa có trải nghiệm nào để đặt.",
  soldOutLabel: "Hết chỗ",
  temporarilyUnavailableLabel: "Tạm thời không khả dụng",
  fullyBookedLabel: "Đã kín chỗ",
  notScheduledLabel: "Hiện chưa có lịch",
  viewExperienceCta: "Xem trải nghiệm",
  guestsMaxLabel: "khách tối đa",
  durationHourLabel: "giờ",
  durationMinuteLabel: "phút",
  nameLabel: "Họ và tên",
  namePlaceholder: "Nhập họ và tên của bạn",
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  phoneLabel: "Số điện thoại",
  phonePlaceholder: "+84 90 123 4567",
  dateLabel: "Ngày",
  pickDayLabel: "Chọn một ngày ở trên.",
  timeLabel: "Giờ",
  selectTimeLabel: "Chọn giờ",
  guestsLabel: "Số khách",
  selectGuestsLabel: "Chọn số khách",
  specialRequestsLabel: "Yêu cầu đặc biệt",
  specialRequestsPlaceholder: "Cho chúng tôi biết nếu bạn có mong muốn gì cho chuyến ghé thăm.",
  guestLabel: "khách",
  guestsLabelPlural: "khách",
  contactInfoHeading: "Thông tin liên hệ",
  phoneLabelShort: "Điện thoại",
  emailLabelShort: "Email",
  reservationPoliciesHeading: "Chính sách đặt bàn",
  goodToKnowKicker: "Thông tin hữu ích",
  callButtonLabel: "Gọi điện",
  contactFormButtonLabel: "Biểu mẫu liên hệ",
  locationLabel: "Chi nhánh",
  selectLocationLabel: "Chọn chi nhánh",
  chooseLocationLabel: "Vui lòng chọn một chi nhánh.",
  oneGuestLabel: "1 khách",
  thankYouLabel: (_name: string) => `Cảm ơn bạn, ${_name}.`,
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `Đặt bàn cho ${_guests} ${_guestLabel} vào ${_date} lúc ${_time} đã được xác nhận.`,
  manageLabel: (_word: string) => `Quản lý ${_word}`,
  cancelAnytimeLabel: "Nếu kế hoạch thay đổi, bạn có thể hủy trước khi đến.",
  callUsLabel: (_phone: string) => `Gọi: ${_phone}`,
  makeAnotherLabel: (_word: string) => `Tạo ${_word} mới`,
  cancelLabel: (_word: string) => `Hủy ${_word}`,
}

registry.vi.experience = {
  ...registry.vi.restaurant,
  poweredByTagline: "Website đặt trải nghiệm tự vận hành",
  aboutImageAlt: "Về studio của chúng tôi",
  ctaTitle: "Đặt một lớp học.",
  ctaRoute: "/experiences",
  contactSubtitle: "Để đặt lớp hoặc xem lịch trống, vui lòng xem trang studio gần bạn nhất. Với báo chí, hợp tác, workshop hoặc các yêu cầu khác, vui lòng dùng biểu mẫu bên dưới.",
  contactSubjectCatering: "Workshop & sự kiện",
  reserveCta: "Đặt lớp học",
  reservationFormTitle: "Đặt trải nghiệm",
  reservationRequestButton: "Gửi yêu cầu đặt chỗ",
  reservationWord: "đặt chỗ",
  reservationExploreLabel: "Xem trải nghiệm",
  reservationExploreRoute: "/experiences",
  experiencesPageSubtitle: "Xem các lớp học, workshop và buổi trải nghiệm đặc biệt đang mở đặt chỗ.",
  locationGroupLine: (_count: number) => `${_count} địa điểm, cùng một trải nghiệm.`,
  bookingNotesPlaceholder: "Cho chúng tôi biết về nhu cầu tiếp cận, thông tin nhóm hoặc yêu cầu khác.",
  contactLocationsByHeading: "Giờ mở cửa, địa chỉ và số điện thoại của từng studio.",
  contactLocationsByNote: "Thông tin chỗ đỗ xe, lối đi tiếp cận và đặt chỗ có trong mục Ghé thăm của từng studio.",
  otherLocationsHeading: "Các studio khác",
  seoReservationDescription: (_name: string) => `Đặt lớp học tại ${_name}.`,
  seoExperiencesDescription: (_name: string) => `Khám phá các lớp học và trải nghiệm tại ${_name}.`,
  viewMenuCta: "Xem trải nghiệm",
  viewMenuRoute: "/experiences",
  visitLocationCta: "Xem studio này →",
  mainLocationLabel: "Studio chính",
  secondLocationLabel: "Studio thứ hai",
  addSecondLocationNote: "Bạn có thể thêm studio thứ hai sau khi kết nối studio đầu tiên.",
  mainDiningRoomLabel: "Studio chính",
  reservationPoliciesHeading: "Chính sách đặt chỗ",
  locationLabel: "Studio",
  selectLocationLabel: "Chọn studio",
  chooseLocationLabel: "Vui lòng chọn một studio.",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `Chúng tôi đã nhận yêu cầu đặt chỗ cho ${_guests} ${_guestLabel} vào ${_date} lúc ${_time}.`,
}

registry.vi.service = {
  ...registry.vi.experience,
  poweredByTagline: "Website dịch vụ chuyên nghiệp luôn cập nhật",
  aboutImageAlt: "Về tổ chức của chúng tôi",
  ctaTitle: "Hãy trao đổi với chúng tôi.",
  ctaRoute: "",
  contactSubtitle: "Để được tư vấn hoặc hỏi về dịch vụ, vui lòng dùng biểu mẫu bên dưới hoặc liên hệ trực tiếp.",
  contactSubjectCatering: "Dịch vụ",
  reserveCta: "",
  reservationPageKicker: "Tư vấn",
  reservationFormTitle: "Đăng ký tư vấn",
  reservationRequestButton: "Gửi yêu cầu tư vấn",
  reservationWord: "buổi tư vấn",
  reservationExploreLabel: "Xem dịch vụ",
  reservationExploreRoute: "/services",
  experiencesPageTitle: "Dịch vụ",
  experiencesPageSubtitle: "Xem các dịch vụ chuyên môn và lĩnh vực chúng tôi hỗ trợ trước khi liên hệ.",
  locationGroupLine: (_count: number) => `${_count} địa điểm, một đội ngũ hỗ trợ.`,
  bookingNotesPlaceholder: "Cho chúng tôi biết nội dung cần tư vấn, thời gian liên hệ phù hợp hoặc nhu cầu tiếp cận.",
  contactLocationsByHeading: "Thông tin liên hệ và khu vực phục vụ.",
  contactLocationsByNote: "Địa điểm có thể bao gồm khu vực phục vụ hoặc kênh trực tuyến, không chỉ văn phòng bạn có thể ghé thăm.",
  otherLocationsHeading: "Các khu vực phục vụ khác",
  seoReservationDescription: (_name: string) => `Đăng ký tư vấn với ${_name}.`,
  seoExperiencesDescription: (_name: string) => `Khám phá các dịch vụ chuyên môn của ${_name}.`,
  viewMenuCta: "Xem dịch vụ",
  viewMenuRoute: "/services",
  findUsKicker: "Liên hệ",
  visitLocationCta: "Xem thông tin liên hệ",
  mainLocationLabel: "Liên hệ chính",
  secondLocationLabel: "Liên hệ khác",
  connectGoogleAddressNote: "Bạn có thể nhập thông tin văn phòng và giờ làm việc từ Google Places nếu cần.",
  addSecondLocationNote: "Bạn có thể thêm văn phòng hoặc khu vực phục vụ khác nếu cần.",
  allLocationsFilter: "Tất cả",
  ourStoryKicker: "Về chúng tôi",
  ourJourneyKicker: "Công việc của chúng tôi",
  ourJourneyTitle: "Chúng tôi có thể giúp gì",
  wedLoveToSeeYou: "Rất mong nhận được liên hệ từ bạn.",
  mainDiningRoomLabel: "Văn phòng chính",
  connectGoogleLocationsCta: "Thêm thông tin văn phòng từ Google Maps",
  additionalLocationsNote: "Các văn phòng và khu vực phục vụ bạn thêm sẽ hiển thị tại đây.",
  noExperiencesLabel: "Chưa có dịch vụ nào được công bố.",
  soldOutLabel: "Ngừng nhận",
  viewExperienceCta: "Xem dịch vụ",
  guestsMaxLabel: "người tối đa",
  specialRequestsLabel: "Chúng tôi có thể giúp gì?",
  specialRequestsPlaceholder: "Cho chúng tôi biết bạn cần hỗ trợ điều gì.",
  guestLabel: "người",
  guestsLabelPlural: "người",
  reservationPoliciesHeading: "Chi tiết tư vấn",
  goodToKnowKicker: "Thông tin hữu ích",
  locationLabel: "Văn phòng",
  selectLocationLabel: "Chọn văn phòng",
  chooseLocationLabel: "Vui lòng chọn văn phòng hoặc đầu mối liên hệ.",
  oneGuestLabel: "1 người",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `Chúng tôi đã nhận yêu cầu tư vấn cho ${_guests} ${_guestLabel} vào ${_date} lúc ${_time}.`,
}

// A vacation rental. Its homes, stays and nightly prices live in the lodging
// service, not here, so its booking calls to action have nowhere to go yet and
// stay hidden (empty routes); the locations below are the business's address.
registry.en.lodging = {
  ...registry.en.experience!,
  poweredByTagline: "vacation rental sites that run themselves",
  aboutImageAlt: "About our place",
  ctaTitle: "Stay with us.",
  ctaRoute: "",
  contactSubtitle:
    "For availability or a booking, head to your property's page, for long stays, groups, partnerships or anything else, use the form below.",
  contactSubjectCatering: "Long stays & groups",
  reserveCta: "Check availability",
  reservationPageKicker: "Stays",
  reservationFormTitle: "Request a Stay",
  reservationRequestButton: "Request Stay",
  reservationWord: "stay",
  reservationExploreLabel: "View Properties",
  reservationExploreRoute: "",
  locationGroupLine: (_count: number) => `${_count} location${_count === 1 ? "" : "s"}`,
  bookingNotesPlaceholder: "Arrival time, number of guests, or anything we should prepare.",
  contactLocationsByHeading: "Address, check-in details and contact, for each property.",
  contactLocationsByNote: 'For parking, access and house rules, follow the "Plan a visit" link on each card.',
  otherLocationsHeading: "Other properties",
  seoReservationDescription: (_name: string) => `Request a stay at ${_name}.`,
  viewMenuCta: "View Properties",
  viewMenuRoute: "",
  visitLocationCta: "View this property →",
  mainLocationLabel: "Main property",
  secondLocationLabel: "Second property",
  addSecondLocationNote: "Add a second property once your first is connected.",
  mainDiningRoomLabel: "Main property",
  locationLabel: "Property",
  selectLocationLabel: "Select a property",
  chooseLocationLabel: "Please choose a property.",
  specialRequestsPlaceholder: "Tell us anything that will help us prepare for your stay.",
  cancelAnytimeLabel: "Need to change your plans? Contact us before arrival.",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `We've received your stay request for ${_guests} ${_guestLabel} arriving ${_date}.`,
}

registry.th.lodging = {
  ...registry.th.experience!,
  poweredByTagline: "เว็บไซต์บ้านพักให้เช่าที่ดูแลตัวเองได้",
  aboutImageAlt: "เกี่ยวกับที่พักของเรา",
  ctaTitle: "มาพักกับเรา",
  ctaRoute: "",
  contactSubtitle:
    "หากต้องการตรวจสอบห้องว่างหรือจองที่พัก ให้ไปที่หน้าของที่พักนั้น หากเป็นการเข้าพักระยะยาว กลุ่ม พาร์ตเนอร์ หรือเรื่องอื่น ๆ ใช้แบบฟอร์มด้านล่างได้เลย",
  contactSubjectCatering: "เข้าพักระยะยาวและกลุ่ม",
  reserveCta: "ตรวจสอบห้องว่าง",
  reservationPageKicker: "การเข้าพัก",
  reservationFormTitle: "ขอจองที่พัก",
  reservationRequestButton: "ส่งคำขอจองที่พัก",
  reservationWord: "การเข้าพัก",
  reservationExploreLabel: "ดูที่พัก",
  reservationExploreRoute: "",
  locationGroupLine: (_count: number) => `${_count} สถานที่`,
  bookingNotesPlaceholder: "เวลาที่จะมาถึง จำนวนผู้เข้าพัก หรือสิ่งที่อยากให้เราเตรียมไว้",
  contactLocationsByHeading: "ที่อยู่ รายละเอียดการเช็กอิน และช่องทางติดต่อของที่พักแต่ละแห่ง",
  contactLocationsByNote: 'สำหรับรายละเอียดที่จอดรถ การเดินทาง และกฎของบ้าน ให้กดลิงก์ "วางแผนการมาเยือน" ในแต่ละการ์ด',
  otherLocationsHeading: "ที่พักอื่น ๆ",
  seoReservationDescription: (_name: string) => `ขอจองที่พักที่ ${_name}`,
  viewMenuCta: "ดูที่พัก",
  viewMenuRoute: "",
  visitLocationCta: "ดูที่พักนี้ →",
  mainLocationLabel: "ที่พักหลัก",
  secondLocationLabel: "ที่พักแห่งที่สอง",
  addSecondLocationNote: "เพิ่มที่พักแห่งที่สองได้หลังจากเชื่อมต่อแห่งแรกแล้ว",
  mainDiningRoomLabel: "ที่พักหลัก",
  locationLabel: "ที่พัก",
  selectLocationLabel: "เลือกที่พัก",
  chooseLocationLabel: "กรุณาเลือกที่พัก",
  specialRequestsPlaceholder: "บอกเราได้ทุกอย่างที่ช่วยให้เราเตรียมพร้อมสำหรับการเข้าพักของคุณ",
  cancelAnytimeLabel: "ต้องการเปลี่ยนแผน? ติดต่อเราก่อนวันเข้าพัก",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `เราได้รับคำขอเข้าพักสำหรับ ${_guests} ${_guestLabel} เข้าพักวันที่ ${_date} แล้ว`,
}

registry.ja.lodging = {
  ...registry.ja.experience!,
  poweredByTagline: "自動で運営できる貸別荘のウェブサイト",
  aboutImageAlt: "私たちの宿について",
  ctaTitle: "私たちの宿に泊まる。",
  ctaRoute: "",
  contactSubtitle: "空室状況やご予約は各施設のページをご確認ください。長期滞在、団体、提携、その他のお問い合わせは下記フォームをご利用ください。",
  contactSubjectCatering: "長期滞在・団体",
  reserveCta: "空室を確認する",
  reservationPageKicker: "ご宿泊",
  reservationFormTitle: "宿泊のリクエスト",
  reservationRequestButton: "宿泊をリクエスト",
  reservationWord: "宿泊",
  reservationExploreLabel: "施設を見る",
  reservationExploreRoute: "",
  locationGroupLine: (_count: number) => `${_count}か所`,
  bookingNotesPlaceholder: "到着時刻、人数、ご準備しておくことなどをお知らせください。",
  contactLocationsByHeading: "各施設の住所・チェックイン情報・連絡先。",
  contactLocationsByNote: "駐車場、アクセス、ハウスルールは、各施設の「来店情報」からご確認ください。",
  otherLocationsHeading: "その他の施設",
  seoReservationDescription: (_name: string) => `${_name}のご宿泊をリクエストいただけます。`,
  viewMenuCta: "施設を見る",
  viewMenuRoute: "",
  visitLocationCta: "この施設を見る →",
  mainLocationLabel: "メイン施設",
  secondLocationLabel: "2つ目の施設",
  addSecondLocationNote: "最初の施設を接続した後、2つ目を追加できます。",
  mainDiningRoomLabel: "メイン施設",
  locationLabel: "施設",
  selectLocationLabel: "施設を選択",
  chooseLocationLabel: "施設を選択してください。",
  specialRequestsPlaceholder: "ご滞在の準備に役立つことがあれば何でもお知らせください。",
  cancelAnytimeLabel: "ご予定が変わった場合は、到着前にご連絡ください。",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `${_date}からのご宿泊、${_guests}${_guestLabel}様のリクエストを受け付けました。`,
}

registry.vi.lodging = {
  ...registry.vi.experience!,
  poweredByTagline: "Website cho thuê nhà nghỉ dưỡng tự vận hành",
  aboutImageAlt: "Về chỗ nghỉ của chúng tôi",
  ctaTitle: "Hãy đến nghỉ cùng chúng tôi.",
  ctaRoute: "",
  contactSubtitle:
    "Để xem phòng trống hoặc đặt chỗ, hãy vào trang của chỗ nghỉ; với lưu trú dài ngày, đoàn khách, hợp tác hoặc việc khác, hãy dùng biểu mẫu bên dưới.",
  contactSubjectCatering: "Lưu trú dài ngày & đoàn khách",
  reserveCta: "Xem phòng trống",
  reservationPageKicker: "Lưu trú",
  reservationFormTitle: "Yêu cầu đặt chỗ",
  reservationRequestButton: "Gửi yêu cầu đặt chỗ",
  reservationWord: "kỳ lưu trú",
  reservationExploreLabel: "Xem chỗ nghỉ",
  reservationExploreRoute: "",
  locationGroupLine: (_count: number) => `${_count} địa điểm`,
  bookingNotesPlaceholder: "Giờ đến, số khách hoặc bất cứ điều gì chúng tôi nên chuẩn bị.",
  contactLocationsByHeading: "Địa chỉ, thông tin nhận phòng và liên hệ của từng chỗ nghỉ.",
  contactLocationsByNote: "Thông tin chỗ đỗ xe, đường đến và nội quy có trong mục Ghé thăm của từng chỗ nghỉ.",
  otherLocationsHeading: "Chỗ nghỉ khác",
  seoReservationDescription: (_name: string) => `Gửi yêu cầu lưu trú tại ${_name}.`,
  viewMenuCta: "Xem chỗ nghỉ",
  viewMenuRoute: "",
  visitLocationCta: "Xem chỗ nghỉ này →",
  mainLocationLabel: "Chỗ nghỉ chính",
  secondLocationLabel: "Chỗ nghỉ thứ hai",
  addSecondLocationNote: "Thêm chỗ nghỉ thứ hai sau khi đã kết nối chỗ nghỉ đầu tiên.",
  mainDiningRoomLabel: "Chỗ nghỉ chính",
  locationLabel: "Chỗ nghỉ",
  selectLocationLabel: "Chọn chỗ nghỉ",
  chooseLocationLabel: "Vui lòng chọn một chỗ nghỉ.",
  specialRequestsPlaceholder: "Cho chúng tôi biết bất cứ điều gì giúp chúng tôi chuẩn bị cho kỳ lưu trú của bạn.",
  cancelAnytimeLabel: "Cần thay đổi kế hoạch? Hãy liên hệ với chúng tôi trước khi đến.",
  confirmationMessage: (_guests: number | string, _guestLabel: string, _date: string, _time: string) =>
    `Chúng tôi đã nhận yêu cầu lưu trú cho ${_guests} ${_guestLabel}, nhận phòng ngày ${_date}.`,
}

export function normalizeVertical(vertical: string | null | undefined): string {
  // `organizations.vertical` is NOT NULL (organizations_vertical_check in server/db/schema.ts).
  // Every caller already gates on the site being loaded before calling this,
  // or uses its own local ref for a genuine pre-creation onboarding default —
  // so a missing vertical here means the caller's data source failed to load,
  // not a state to paper over with a default vertical's copy.
  if (vertical == null || vertical === "") {
    throw new Error("normalizeVertical() received a missing vertical — the site data has not loaded correctly.")
  }
  return vertical
}

export function getVerticalLabel(vertical: string | null | undefined): string {
  const v = normalizeVertical(vertical)
  if (v === "service") return "Professional services"
  if (v === "experience") return "Experience"
  if (v === "restaurant") return "Restaurant"
  if (v === "lodging") return "Vacation rental"
  return "Business"
}

export function getVerticalCopy(vertical: string | null | undefined, locale: string | null | undefined = "en"): VerticalCopy {
  const v = normalizeVertical(vertical)
  const l = String(locale ?? "en") as LocaleCode
  const byLocale = Object.prototype.hasOwnProperty.call(registry, l) ? registry[l]! : registry.en
  const localized = byLocale[v as OrganizationVertical]
  if (localized) return localized
  const english = registry.en[v as OrganizationVertical]
  if (english) return english
  // `v` is a value the organizations_vertical_check constraint allows (e.g. 'retail',
  // 'wellness') but that isn't in ALL_VERTICALS/the copy registry yet, or an
  // unrecognized string entirely — a real data/registry gap, not a state to
  // paper over with restaurant copy.
  throw new Error(`getVerticalCopy() has no registry entry for vertical "${v}".`)
}

// Restaurants, professional services and lodging get their schema.org subtype plus
// LocalBusiness; other verticals fall back to the generic LocalBusiness type.
export function getBusinessSchemaTypes(vertical: string | null | undefined): string[] {
  const v = normalizeVertical(vertical)
  if (v === "restaurant") return ["Restaurant", "LocalBusiness"]
  if (v === "service") return ["ProfessionalService", "LocalBusiness"]
  if (v === "lodging") return ["LodgingBusiness", "LocalBusiness"]
  return ["LocalBusiness"]
}
