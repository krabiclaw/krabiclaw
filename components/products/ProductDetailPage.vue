<template>
  <div class="min-h-screen bg-default text-default">
    <slot name="scope">
      <BookingScopeSelect :locations="locations ?? []" :online-available="onlineAvailable" :selected-location-id="location?.id ?? null" :scope-required="scopeRequired" />
    </slot>
    <AppBreadcrumb :crumbs="breadcrumbs" />

    <!-- One responsive primary action: the mobile bar and the desktop card
         resolve the same booking, so the page never shows two of them. -->
    <div
      v-if="canBook || canOrderExternally || canEnquire"
      class="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-4 border-t border-default bg-default/95 px-5 py-4 shadow-lg backdrop-blur-sm lg:hidden"
    >
      <div v-if="priceLabel" class="min-w-0">
        <p v-if="compareAtLabel" class="text-xs text-muted line-through">{{ compareAtLabel }}</p>
        <p class="font-semibold leading-tight text-default">{{ isStay ? t('stay.price_per_night', { price: priceLabel }) : priceLabel }}</p>
        <p v-if="isStay && stayBooking.quote.value" class="text-xs text-muted">{{ stayBooking.rangeLabel.value }}</p>
      </div>
      <TenantButton v-if="canOrderExternally" class="shrink-0" :href="product.order_url!" target="_blank" rel="noopener noreferrer" @click="recordExternalOrderClick">{{ externalActionLabel }}</TenantButton>
      <TenantButton v-else-if="canEnquire" class="shrink-0" :to="enquiryPath">
        {{ t('site.experience_detail.enquire') }}
      </TenantButton>
      <TenantButton v-else class="shrink-0" control-id="product-booking-toggle" @click="openBooking">
        {{ bookingLabel }}
      </TenantButton>
    </div>

    <article :class="booking || isStay ? 'mx-auto max-w-7xl px-4 pb-28 sm:px-6 lg:px-8 lg:pb-20' : 'mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8'">
      <!-- A bookable product is read the way it is sold: the gallery and the
           prose on the left, and the price, the facts and the booking control
           travelling with the reader on the right. A product that takes no
           bookings has nothing to put in that column, so it keeps the single
           card. -->
      <div v-if="booking || product.order_url || isStay">
        <!-- Stays Airbnb-style header: title & rating/location above the photo mosaic -->
        <header v-if="isStay" class="mb-6">
          <h1 class="tenant-display text-2xl font-semibold text-default sm:text-3xl lg:text-4xl">{{ displayTitle }}</h1>
          <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <template v-if="averageRating">
              <span class="inline-flex items-center gap-1 font-semibold text-default">
                <TenantIcon name="star" solid class="size-4" />{{ averageRating }}
              </span>
              <span aria-hidden="true">·</span>
              <span class="underline">{{ reviewCountLabel }}</span>
              <span v-if="stayPlaceName" aria-hidden="true">·</span>
            </template>
            <span v-if="stayPlaceName" class="underline">{{ stayPlaceName }}</span>
            <ShareButton class="ml-auto" :title="displayTitle" />
          </div>
        </header>

        <!-- Airbnb's experience and service pages: the photographs on the left and
             the title beside them; a stay's photographs run the full width. -->
        <div :class="!isStay && galleryItems.length ? 'lg:grid lg:grid-cols-2 lg:items-center lg:gap-12' : undefined">
        <MediaGallery v-if="galleryItems.length" ref="mediaGallery" :items="galleryItems" :title="displayTitle" :photo-groups="photoGroups" />

        <header v-if="!isStay" class="mx-auto mt-10 max-w-3xl text-center" :class="galleryItems.length ? 'lg:mt-0' : undefined">
          <p class="tenant-kicker mb-3">{{ collectionName }}</p>
          <h1 class="tenant-display-md text-3xl text-default sm:text-4xl lg:text-5xl">{{ displayTitle }}</h1>
          <p v-if="tagline" class="mx-auto mt-4 max-w-2xl text-base text-muted sm:text-lg">{{ tagline }}</p>
          <HostedBy v-if="booking" class="mt-5 justify-center" :organization-id="organizationId" :product-id="product.id" :slug="product.slug" :session-id="bookingController.selectedSession.value?.id" />
          <ProductVariantPrices v-if="!booking && !isStay" :product="product" :location-ids="[location?.id ?? null]" :currency="currency" class="mx-auto mt-6 max-w-xl text-base" />
          <div class="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted">
              <template v-if="averageRating">
                <span class="inline-flex items-center gap-1 font-medium text-default">
                  <TenantIcon name="star" solid class="size-4" />{{ averageRating }}
                </span>
                <span aria-hidden="true">·</span>
                <span>{{ reviewCountLabel }}</span>
                <span aria-hidden="true">·</span>
              </template>
            <span>{{ location?.title ?? organizationName }}</span>
          </div>
          <div v-if="factChips.length" class="mt-5 flex flex-wrap justify-center gap-2">
            <span
              v-for="fact in factChips"
              :key="fact.label"
              class="inline-flex items-center gap-1.5 rounded-full border border-default bg-elevated px-3 py-1 text-xs font-medium text-muted"
            >
              <TenantIcon :name="fact.icon" class="size-3.5" />
              {{ fact.label }}
            </span>
          </div>
          <!-- Airbnb's rows under the title: the cancellation terms and a guest's own words. -->
          <ul v-if="experienceHighlights.length" class="mx-auto mt-6 max-w-md space-y-4 text-left">
            <li v-for="highlight in experienceHighlights" :key="highlight.key" class="flex items-start gap-4">
              <TenantIcon :name="highlight.icon" class="mt-0.5 size-6 shrink-0 text-default" />
              <div class="min-w-0">
                <p class="text-sm font-semibold text-default">{{ highlight.title }}</p>
                <p class="line-clamp-2 text-sm text-muted">{{ highlight.text }}</p>
              </div>
            </li>
          </ul>
          <ShareButton class="mt-5" :title="displayTitle" />
          <slot name="actions" />
        </header>
        </div>

        <div id="consultations" class="grid scroll-mt-32 gap-10 lg:grid-cols-[1fr_380px] lg:items-start" :class="isStay ? 'mt-8' : 'mt-14'">
        <div class="min-w-0">
          <p v-if="!canBook && !canEnquire && !canOrderExternally" role="status" class="rounded-xl border border-default bg-elevated p-5 text-muted lg:hidden">{{ scopeRequired ? t('booking.choose_location') : vertical === 'service' && !offer ? t('booking.price_unavailable_contact') : t('site.common.temporarily_unavailable') }}</p>

          <!-- Airbnb's overview under the photos: what kind of place, where, and its size. -->
          <div v-if="isStay" class="pb-6">
            <h2 class="text-xl font-semibold text-default sm:text-2xl">
              {{ stayPropertyTypeLabel && stayPlaceName ? `${stayPropertyTypeLabel} in ${stayPlaceName}` : stayPropertyTypeLabel || displayTitle }}
            </h2>
            <p class="mt-1 text-default">{{ staySpecsSummary }}</p>
            <HostedBy class="mt-6 border-t border-default pt-6" :organization-id="organizationId" :product-id="product.id" :slug="product.slug" />
            <dl v-if="stayPropertyFacts.length" class="mt-5 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
              <div v-for="fact in stayPropertyFacts" :key="fact.label">
                <dt class="text-muted">{{ fact.label }}</dt>
                <dd class="mt-1 text-default">{{ fact.value }}</dd>
              </div>
            </dl>
          </div>

          <!-- Key highlights for Stays -->
          <div v-if="isStay" class="border-t border-default py-6 space-y-4">
            <div class="flex items-start gap-4">
              <TenantIcon name="clock" class="size-5 text-default shrink-0 mt-0.5" />
              <div>
                <p class="font-medium text-default text-sm">{{ t('stay.check_in_after', { time: formatTime(product.stay!.check_in_time, locale) }) }}</p>
                <p class="text-xs text-muted">{{ t('stay.check_out_before', { time: formatTime(product.stay!.check_out_time, locale) }) }}</p>
              </div>
            </div>
            <div v-if="stayCancellationPolicyLabel" class="flex items-start gap-4">
              <TenantIcon name="calendar-days" class="size-5 text-default shrink-0 mt-0.5" />
              <div>
                <p class="font-medium text-default text-sm">{{ stayCancellationPolicyLabel }}</p>
                <p class="text-xs text-muted">{{ stayCheckoutAvailable ? t('stay.charged_in_full') : t('stay.enquiry_note') }}</p>
              </div>
            </div>
          </div>

          <section v-if="(product.description || stayDescriptionDetails.length)" class="border-t border-default pt-8" data-testid="product-description">
            <h2 v-if="vertical !== 'service'" class="tenant-display text-2xl text-default sm:text-3xl">{{ isStay ? t('stay.about_this_place') : product.kind === 'experience' ? t('site.experience_detail.what_youll_do') : t('site.product_detail.description') }}</h2>
            <!-- A long listing opens on its first lines, as Airbnb's does; the rest is one press away. -->
            <div :class="descriptionClamped ? 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : undefined">
              <p v-if="product.description" class="mt-4 text-base leading-relaxed text-muted sm:text-lg" :class="isStay ? 'whitespace-pre-wrap break-words' : 'whitespace-pre-line'" :data-testid="isStay ? 'stay-description-listing-description' : undefined">{{ product.description }}</p>
              <div v-for="detail in stayDescriptionDetails" :key="detail.key" class="mt-6" :data-testid="`stay-description-${detail.key}`">
                <h3 class="text-lg font-semibold text-default">{{ detail.label }}</h3>
                <p class="mt-3 whitespace-pre-wrap break-words text-base leading-relaxed text-muted sm:text-lg">{{ detail.value }}</p>
              </div>
            </div>
            <button v-if="descriptionLong" type="button" class="mt-4 inline-flex items-center gap-1 font-semibold text-default underline underline-offset-4" :aria-expanded="!descriptionClamped" @click="descriptionOpen = !descriptionOpen">
              {{ descriptionOpen ? t('stay.show_less') : t('stay.show_more') }}
            </button>
          </section>

          <section v-if="isStay && authoredRoomDetails.length" class="mt-10 border-t border-default pt-8" data-testid="stay-room-details">
            <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ roomDetailsTitle }}</h2>
            <div class="mt-5 grid gap-4 sm:grid-cols-2">
              <article v-for="room in authoredRoomDetails" :key="room.id" class="rounded-xl border border-default p-5" :data-testid="`stay-room-details-${room.id}`">
                <h3 class="font-semibold text-default">{{ room.title }}</h3>
                <ul v-if="room.details?.length" class="mt-3 space-y-2 text-sm text-muted"><li v-for="detail in room.details" :key="detail">{{ detail }}</li></ul>
                <StayFeatureList v-if="room.features?.length" class="mt-3" :features="room.features" :photos="galleryItems" @open-photo="openGalleryAsset" />
              </article>
            </div>
          </section>

          <section v-if="isStay && stayAccessibilityFeatures.length" class="mt-10 border-t border-default pt-8" data-testid="stay-accessibility-features">
            <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ t('stay.accessibility_title') }}</h2>
            <StayFeatureList class="mt-5" :features="stayAccessibilityFeatures" :photos="galleryItems" @open-photo="openGalleryAsset" />
          </section>

          <!-- What this place offers (Amenities) -->
          <section v-if="isStay && stayAmenitiesList.length" class="mt-10 border-t border-default pt-8">
            <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ t('stay.what_this_place_offers') }}</h2>
            <div class="mt-5 grid grid-cols-2 gap-4">
              <div v-for="amenity in stayAmenitiesList.slice(0, AMENITIES_SHOWN)" :key="amenity.code" class="flex items-center gap-3">
                <UIcon :name="amenity.icon" class="size-5 shrink-0 text-muted" aria-hidden="true" />
                <span class="text-sm text-default">{{ amenity.label }}</span>
              </div>
            </div>
            <UModal v-if="stayAmenitiesList.length > AMENITIES_SHOWN" :title="t('stay.what_this_place_offers')">
              <TenantButton variant="outline" class="mt-6">{{ t('stay.show_all_amenities', { count: stayAmenitiesList.length }) }}</TenantButton>
              <template #body>
                <div v-for="group in stayAmenityGroups" :key="group.label" class="border-b border-default py-5 last:border-b-0">
                  <h3 class="text-lg font-semibold text-default">{{ group.label }}</h3>
                  <ul class="mt-3 divide-y divide-default">
                    <li v-for="amenity in group.amenities" :key="amenity.code" class="flex items-center gap-4 py-4">
                      <UIcon :name="amenity.icon" class="size-6 shrink-0 text-default" aria-hidden="true" />
                      <span class="text-default">{{ amenity.label }}</span>
                    </li>
                  </ul>
                </div>
              </template>
            </UModal>
          </section>

          <!-- Inline Availability Calendar for stays (Airbnb style) -->
          <section v-if="isStay && canBook" class="mt-10 border-t border-default pt-8">
            <StayDatesStep inline :place="stayPlaceName" :controller="stayBooking" @next="stayBooking.openBooking(2)" />
          </section>

          <!-- The next few sessions, on the page: a guest sees when it runs
               before they open anything. On a wide product page they travel in
               the booking card instead, as Airbnb's do. -->
          <section v-if="canBook && !enquiryOnly && !isStay" class="border-t border-default pt-8 lg:hidden">
            <div class="flex flex-wrap items-baseline justify-between gap-4">
              <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ t('site.experience_detail.upcoming_availability') }}</h2>
              <TenantButton v-if="upcomingSessions.length" variant="ghost" control-id="product-booking-toggle" @click="openBooking">
                {{ t('site.experience_detail.see_all_dates') }} →
              </TenantButton>
            </div>
            <BookingTimezoneSelect v-if="allowTimezoneSelection" :model-value="bookingTimezone" :options="timezoneOptions" class="mt-5 max-w-sm" @update:model-value="guestTimezone = $event" />
            <p v-if="bookingError" role="alert" class="mt-4 text-sm text-error">{{ bookingError }}</p>
            <UpcomingSessions v-else-if="upcomingSessions.length" class="mt-5 grid gap-3 space-y-0! sm:grid-cols-2" :sessions="upcomingSessions" :day-label="sessionDayLabel" :time-label="sessionTimeLabel" :pick-label="sessionPickLabel" control-id="product-booking-toggle" :show-remaining="vertical !== 'service'" @pick="openBookingAt" />
            <p v-else-if="sessionsPending" class="mt-4 text-sm text-muted">{{ t('site.experience_detail.processing') }}</p>
            <p v-else class="mt-4 text-sm text-muted">{{ t('site.experience_detail.no_availability', { count: PUBLIC_BOOKING_WINDOW_DAYS }) }}</p>
          </section>

          <section v-if="includedItems.length || whatToBring.length" class="mt-10 grid gap-8 border-t border-default pt-10 sm:grid-cols-2">
            <div v-if="includedItems.length">
              <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ t('site.experience_detail.included') }}</h2>
              <ul class="mt-4 space-y-2">
                <li v-for="item in includedItems" :key="item" class="flex items-start gap-2 text-sm leading-6 text-muted">
                  <TenantIcon name="check-circle" class="mt-1 size-4 shrink-0 text-primary" />{{ item }}
                </li>
              </ul>
            </div>
            <div v-if="whatToBring.length">
              <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ t('site.experience_detail.what_to_bring') }}</h2>
              <ul class="mt-4 space-y-2">
                <li v-for="item in whatToBring" :key="item" class="flex items-start gap-2 text-sm leading-6 text-muted">
                  <TenantIcon name="shopping-bag" class="mt-1 size-4 shrink-0 text-primary" />{{ item }}
                </li>
              </ul>
            </div>
          </section>

          <section v-if="location" class="mt-10 border-t border-default pt-10">
            <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ isStay ? t('stay.where_youll_be') : product.kind === 'dish' || product.kind === 'item' ? t('site.location.find_us') : t('site.experience_detail.where_youll_meet') }}</h2>
            <div class="mt-5 overflow-hidden rounded-xl border border-default bg-elevated">
              <div class="flex items-start gap-4 p-6">
                <TenantIcon name="map-pin" class="mt-0.5 size-5 shrink-0 text-primary" />
                <div class="min-w-0">
                  <p class="font-semibold text-default">{{ locationName }}</p>
                  <p v-if="addressLine" class="mt-1 text-sm text-muted">{{ addressLine }}</p>
                  <p v-if="isStay && location?.stay_map_sharing && mapEmbedUrl" class="mt-2 text-sm leading-6 text-muted">{{ t(location.public_area?.approximate ? 'stay.general_location_notice' : 'stay.specific_location_notice') }}</p>
                  <p v-if="location?.phone" class="mt-1 text-sm text-muted">{{ formatPhone(location.phone) }}</p>
                  <p v-if="meetingPoint" class="mt-3 whitespace-pre-line text-sm leading-6 text-default">{{ meetingPoint }}</p>
                  <a
                    v-if="location?.maps_url"
                    :href="location?.maps_url ?? undefined"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    {{ t('site.experience_detail.open_in_maps') }}
                    <TenantIcon name="arrow-top-right-on-square" class="size-3" />
                  </a>
                </div>
              </div>
              <iframe
                v-if="mapEmbedUrl"
                :src="mapEmbedUrl"
                :title="locationName"
                class="h-56 w-full border-t border-default"
                style="border-width: 1px 0 0"
                loading="lazy"
                referrerpolicy="strict-origin-when-cross-origin"
              />
            </div>
            <div v-if="isStay" class="mt-6 space-y-6">
              <section v-for="detail in stayLocationDetails" :key="detail.key">
                <h3 class="text-lg font-semibold text-default">{{ detail.label }}</h3>
                <p class="mt-2 whitespace-pre-line text-sm leading-7 text-muted">{{ detail.text }}</p>
              </section>
            </div>
          </section>

          <WhoYouMeet v-if="booking || isStay" class="mt-10" :organization-id="organizationId" :product-id="product.id" :slug="product.slug" :session-id="bookingController.selectedSession.value?.id" :contact-to="enquiryPath" />

          <section v-if="thingsToKnow.length" id="things-to-know" class="mt-10 scroll-mt-24 border-t border-default pt-10">
            <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ t('site.experience_detail.things_to_know') }}</h2>
            <div class="mt-5 grid gap-x-10 gap-y-6 sm:grid-cols-2" :class="isStay ? 'lg:grid-cols-3' : undefined">
              <div v-for="detail in thingsToKnow" :key="detail.key">
                <h3 class="text-sm font-semibold text-default">{{ detail.label }}</h3>
                <ul class="mt-2 space-y-1.5">
                  <li v-for="(line, index) in detail.values" :key="index" class="whitespace-pre-wrap break-words text-sm leading-6 text-muted">{{ line }}</li>
                </ul>
              </div>
            </div>
          </section>
        </div>

        <!-- The decision, travelling with the reader: what it costs, when it
             next runs, and the one action. -->
        <div class="hidden lg:sticky lg:top-28 lg:block">
          <div class="space-y-5 rounded-2xl border border-default bg-elevated p-6 shadow-xl">
            <div v-if="priceLabel" class="flex items-center justify-between gap-4">
              <div>
                <span class="tenant-display text-2xl font-bold tabular-nums text-default">
                  <span v-if="compareAtLabel" class="mr-2 text-base text-muted line-through">{{ compareAtLabel }}</span>{{ isStay || enquiryOnly || (product.kind !== 'experience' && sellableVariants.length === 1) ? priceLabel : t('site.experience_detail.from_price', { price: priceLabel }) }}
                </span>
                <span v-if="isStay" class="text-sm font-normal text-muted"> / night</span>
                <p v-if="!enquiryOnly && product.kind === 'experience'" class="mt-1 text-sm text-muted">{{ t('site.experience_detail.per_person') }}</p>
              </div>
              <div v-if="isStay && averageRating" class="flex items-center gap-1 text-xs font-semibold text-default">
                <TenantIcon name="star" solid class="size-3.5" />
                <span>{{ averageRating }}</span>
                <span class="text-muted font-normal">({{ reviews.length }})</span>
              </div>
              <TenantButton v-else-if="cardListsSessions" size="lg" control-id="product-booking-toggle" class="shrink-0 font-semibold" @click="openBooking">
                {{ bookingLabel }}
              </TenantButton>
            </div>

            <!-- The stay a guest has chosen so far, read back from the server's quote. -->
            <div v-if="isStay && canBook" class="overflow-hidden rounded-xl border border-default">
              <!-- Labels for the dialog's checkbox, like every booking control: they open it before hydration too. -->
              <label for="product-booking-toggle" role="button" tabindex="0" class="grid w-full cursor-pointer grid-cols-2 text-left" @click="stayBooking.openBooking(1)" @keydown.enter.prevent="pressLabel" @keydown.space.prevent="pressLabel">
                <span class="border-r border-default px-3 py-2.5">
                  <span class="block text-[10px] font-bold uppercase tracking-wider text-default">{{ t('stay.check_in') }}</span>
                  <span class="block text-xs font-medium text-muted mt-0.5">{{ stayBooking.checkIn.value ? stayBooking.dateLabel(stayBooking.checkIn.value) : t('stay.add_dates') }}</span>
                </span>
                <span class="px-3 py-2.5">
                  <span class="block text-[10px] font-bold uppercase tracking-wider text-default">{{ t('stay.check_out') }}</span>
                  <span class="block text-xs font-medium text-muted mt-0.5">{{ stayBooking.checkOut.value ? stayBooking.dateLabel(stayBooking.checkOut.value) : t('stay.add_dates') }}</span>
                </span>
              </label>
              <label for="product-booking-toggle" role="button" tabindex="0" class="block w-full cursor-pointer border-t border-default px-3 py-2.5 text-left" @click="stayBooking.openBooking(1)" @keydown.enter.prevent="pressLabel" @keydown.space.prevent="pressLabel">
                <span class="block text-[10px] font-bold uppercase tracking-wider text-default">{{ t('stay.guests') }}</span>
                <span class="block text-xs font-medium text-muted mt-0.5">{{ stayBooking.guestsLabel.value }}</span>
              </label>
            </div>

            <div v-if="!cardListsSessions" class="pt-1">
              <TenantButton v-if="canOrderExternally" block :href="product.order_url!" target="_blank" rel="noopener noreferrer" @click="recordExternalOrderClick">{{ externalActionLabel }}</TenantButton>
              <TenantButton v-else-if="canEnquire" block :to="enquiryPath">
                {{ t('site.experience_detail.enquire') }}
              </TenantButton>
              <TenantButton v-else-if="canBook" block size="lg" control-id="product-booking-toggle" class="w-full font-semibold" @click="openBooking">
                {{ bookingLabel }}
              </TenantButton>
            </div>

            <p v-if="isStay && canBook" class="text-center text-xs text-muted">{{ stayCheckoutAvailable ? 'You won\'t be charged yet' : t('stay.enquiry_note') }}</p>

            <dl v-if="isStay && stayBooking.quote.value" class="space-y-3 border-t border-default pt-4 text-sm">
              <div v-for="line in stayBooking.breakdown.value" :key="line.label" class="flex justify-between gap-4">
                <dt class="text-muted underline decoration-dotted underline-offset-4">{{ line.label }}</dt>
                <dd class="tabular-nums text-default">{{ line.amount }}</dd>
              </div>
              <div class="flex justify-between gap-4 border-t border-default pt-3 font-semibold text-base text-default">
                <dt>{{ t('stay.total') }}</dt>
                <dd class="tabular-nums">{{ stayBooking.money(stayBooking.quote.value.total_minor) }}</dd>
              </div>
            </dl>

            <!-- Airbnb's dates under the price: the next sessions, each one press from booking. -->
            <template v-if="cardListsSessions">
              <BookingTimezoneSelect v-if="allowTimezoneSelection" :model-value="bookingTimezone" :options="timezoneOptions" @update:model-value="guestTimezone = $event" />
              <p v-if="bookingError" role="alert" class="text-sm text-error">{{ bookingError }}</p>
              <UpcomingSessions v-else-if="upcomingSessions.length" :sessions="upcomingSessions" :day-label="sessionDayLabel" :time-label="sessionTimeLabel" :pick-label="sessionPickLabel" control-id="product-booking-toggle" :show-remaining="vertical !== 'service'" @pick="openBookingAt" />
              <p v-else-if="sessionsPending" class="text-sm text-muted">{{ t('site.experience_detail.processing') }}</p>
              <p v-else class="text-sm text-muted">{{ t('site.experience_detail.no_availability', { count: PUBLIC_BOOKING_WINDOW_DAYS }) }}</p>
              <TenantButton v-if="upcomingSessions.length" variant="ghost" block control-id="product-booking-toggle" @click="openBooking">
                {{ t('site.experience_detail.see_all_dates') }}
              </TenantButton>
            </template>

            <p v-if="vertical === 'service' && !isStay && !product.order_url" class="text-sm text-muted">{{ booking?.confirmation_mode === 'review' ? t('booking.review_notice') : t('booking.instant_notice') }}</p>
            <p v-if="!canBook && !canEnquire && !canOrderExternally" class="rounded-lg bg-default px-4 py-3 text-center text-sm font-semibold text-muted">
              {{ scopeRequired ? t('booking.choose_location') : vertical === 'service' && !offer ? t('booking.price_unavailable') : t('site.common.temporarily_unavailable') }}
            </p>
          </div>
        </div>
        </div>
      </div>

      <div v-else class="rounded-2xl bg-elevated p-6 sm:p-10 lg:p-12">
        <div :class="product.image?.public_url ? 'grid gap-10 lg:grid-cols-2 items-start' : 'max-w-3xl'">
          <div v-if="product.image?.public_url">
            <img
              :src="product.image.public_url"
              :alt="product.image.alt_text || product.name"
              class="aspect-square w-full rounded-2xl object-cover"
            >
          </div>
          <div class="py-2">
            <p class="tenant-kicker">{{ collectionName }}</p>
            <h1 class="tenant-display tenant-italic mt-3 text-3xl sm:text-4xl lg:text-5xl text-default leading-tight">{{ product.name }}</h1>
            <p class="mt-2 text-sm sm:text-base text-muted">{{ location?.title ?? organizationName }}</p>
            <ProductVariantPrices :product="product" :location-ids="[location?.id ?? null]" :currency="currency" class="mt-6 text-lg" />
            <div v-if="!offer && priceLabel" class="mt-6 flex items-baseline gap-3 text-2xl font-semibold tabular-nums">
              <span v-if="compareAtLabel" class="text-base font-normal text-muted line-through">{{ compareAtLabel }}</span>
              <span>{{ priceLabel }}</span>
            </div>
            <p v-if="product.description" class="mt-6 text-base sm:text-lg leading-relaxed text-muted">{{ product.description }}</p>
            <p v-if="!isAvailable" class="mt-6 font-semibold text-muted">{{ t('site.common.temporarily_unavailable') }}</p>
            <div class="mt-8 flex flex-wrap items-center gap-5">
              <TenantButton v-if="canEnquire" :to="enquiryPath">{{ t('site.experience_detail.enquire') }}</TenantButton>
              <TenantButton
                v-if="canOrderExternally"
                :href="product.order_url!"
                target="_blank"
                rel="noopener noreferrer"
                @click="recordExternalOrderClick"
              >{{ externalActionLabel }}</TenantButton>
              <NuxtLink
                :to="localePath(verticalCopy.viewMenuRoute)"
                class="border-b border-default pb-0.5 text-xs font-bold uppercase tracking-widest text-default no-underline transition hover:opacity-60"
              >
                {{ verticalCopy.viewMenuCta }} →
              </NuxtLink>
            </div>
            <dl v-if="visibleDetails.length" class="mt-10 divide-y divide-default border-y border-default">
              <div v-for="detail in visibleDetails" :key="detail.key" class="py-4">
                <dt class="font-medium">{{ detail.label }}</dt>
                <dd class="mt-1 text-sm text-muted">{{ detail.values.join(', ') }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      <!-- Siblings in the collection this page was reached through. Derived
           entirely from membership, so every page's body text varies by real
           data and every item in a collection is reachable by internal link. -->
      <section v-if="collectionSiblings.length" class="mt-16 border-t border-default pt-12">
        <h2 class="tenant-display tenant-italic text-3xl sm:text-4xl">{{ t('site.product_detail.more_in_category', { category: collectionName }) }}</h2>
        <!-- Airbnb's row of cards: the picture, the name and what it costs. -->
        <ul class="mt-6 grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
          <li v-for="sibling in collectionSiblings" :key="sibling.id">
            <NuxtLink :to="localePath(presentation.productPath(location?.slug ?? '', sibling.slug))" class="group block text-default no-underline">
              <div class="aspect-square overflow-hidden rounded-xl bg-muted">
                <img v-if="sibling.image_url" :src="sibling.image_url" alt="" loading="lazy" class="size-full object-cover transition-transform duration-300 group-hover:scale-105">
              </div>
              <p class="mt-3 font-medium leading-snug">{{ sibling.name }}</p>
              <p v-if="sibling.price" class="mt-0.5 text-sm text-muted">
                {{ isStay ? t('stay.price_per_night', { price: formatProductMoney(sibling.price, locale) }) : t('site.experience_detail.from_price', { price: formatProductMoney(sibling.price, locale) }) }}
              </p>
            </NuxtLink>
          </li>
        </ul>
      </section>

      <!-- The bookable layout already shows every photograph in its gallery;
           this strip is the card layout's only place for them. -->
      <section v-if="!booking && !isStay && product.gallery.length" class="mt-16">
        <h2 class="tenant-display tenant-italic text-4xl">{{ t('site.footer.gallery') }}</h2>
        <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <img
            v-for="asset in product.gallery"
            :key="asset.asset_id"
            :src="asset.public_url"
            :alt="asset.alt_text || product.name"
            class="aspect-square w-full rounded-xl object-cover"
          >
        </div>
      </section>

      <!-- One booking surface, mounted outside the card so the mobile sheet and
           the desktop button open the same thing. -->
      <BookingModal
        v-if="booking && !product.order_url"
        v-model="bookingOpen"
        target-id="product-booking"
        :title="displayTitle"
        :can-go-back="bookingStep > 1 && !submitting"
        @back="bookingStep = 1"
      >
        <ProductBookingSteps :controller="bookingController" :confirmation-mode="booking.confirmation_mode" :payment-required="booking.online_payment_required && (bookingController.selectedPrice.value?.unit_amount ?? 0) > 0" />
      </BookingModal>
      <BookingModal
        v-else-if="isStay && canBook"
        v-model="stayBooking.bookingOpen.value"
        target-id="product-booking"
        :title="displayTitle"
        :can-go-back="stayBooking.bookingStep.value > 1 && !stayBooking.submitting.value"
        @back="stayBooking.bookingStep.value = 1"
      >
        <StayBookingSteps :controller="stayBooking" />
      </BookingModal>

      <section v-if="reviews.length" class="mt-16 border-t border-default pt-12">
        <!-- Airbnb leads its reviews with the score: "★ 4.88 · 473 reviews". -->
        <h2 class="flex flex-wrap items-center gap-2 text-2xl font-semibold text-default sm:text-3xl">
          <TenantIcon name="star" solid class="size-6" />
          <span>{{ averageRating }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ reviewCountLabel }}</span>
        </h2>
        <div class="mt-6 grid gap-6 sm:grid-cols-2">
          <TenantReviewCard v-for="review in reviews" :key="review.id" :review="review" />
        </div>
      </section>
    </article>
    <slot name="content" :can-book="canBook" />
  </div>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import WhoYouMeet from '~/components/booking/WhoYouMeet.vue'
import HostedBy from '~/components/booking/HostedBy.vue'
import ShareButton from '~/components/tenant/ShareButton.vue'
import UpcomingSessions from '~/components/booking/UpcomingSessions.vue'
import type { ProductPresentation, PublicProduct } from '~/server/types/products'
import type { Accommodation, PropertyValue } from 'nuxt-schema-org/schema'
import { useSchemaOrg } from '#imports'
import { STAY_AMENITIES, STAY_ALARM_AMENITIES, STAY_AMENITY_GROUPS, STAY_CANCELLATION_POLICIES, STAY_LISTING_TYPES, STAY_LONG_TERM_CANCELLATION_POLICIES, STAY_PROPERTY_SIZE_UNITS, STAY_PROPERTY_TYPES } from '~/shared/stay-listing'
import { stayPhotoRoomName, stayPhotoTourReady } from '~/shared/stay-photos'
import { STAY_ROOM_ACCESSIBILITY_FEATURES, STAY_HOME_ACCESSIBILITY_FEATURES } from '~/shared/stay-accessibility'
import type { MediaGalleryGroup } from '~/components/MediaLightbox.vue'
import type { CurrencyCode } from '~/shared/currencies'
import { minorAmountToMajor, selectPrice, type Price } from '~/shared/prices'
import { formatProductMoney } from '~/utils/product-money'
import { ga4Major } from '~/utils/ga4-projection'
import { productLocationCollectionPath, staySpecLabels } from '~/utils/product-presentation'
import { extractDietarySchemaUrls, type ProductCollectionSibling } from '~/utils/product-seo'
import type { ProductDetailValue } from '~/shared/product-details'
import { EXPERIENCE_ATTRIBUTE_HANDLES, productDetailFields, productDetailKey, PRICING_NOTE_HANDLE, STAY_DESCRIPTION_DETAIL_KEYS, STAY_HOUSE_RULE_DETAIL_KEYS, STAY_LOCATION_DETAIL_KEYS, stayHouseRuleLines } from '~/shared/product-details'
import { STAY_SAFETY_DETAIL_KEYS, staySafetyLines, stayAlarmLines } from '~/shared/stay-safety'
import type { PublicProductBooking, PublicProductLocation, PublicProductReview, PublicProductSession } from '~/server/utils/public-products'
import { addressPlaceName, formatPostalAddress, schemaPostalAddress } from '~/utils/postal-address'
import { formatTime } from '~/utils/timezone'
import TenantReviewCard from '~/components/tenant/TenantReviewCard.vue'
import BookingModal from '~/components/booking/BookingModal.vue'
import ProductBookingSteps from '~/components/booking/ProductBookingSteps.vue'
import StayBookingSteps from '~/components/booking/StayBookingSteps.vue'
import StayDatesStep from '~/components/booking/StayDatesStep.vue'
import { useStayBooking } from '~/composables/useStayBooking'
import BookingTimezoneSelect from '~/components/booking/BookingTimezoneSelect.vue'
import BookingScopeSelect from '~/components/booking/BookingScopeSelect.vue'
import { PUBLIC_BOOKING_WINDOW_DAYS } from '~/shared/bookings'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import { isRecord, publicApiRequest } from '~/utils/api-clients'
import MediaGallery from '~/components/MediaGallery.vue'
import StayFeatureList from '~/components/products/StayFeatureList.vue'
import ProductVariantPrices from '~/components/products/ProductVariantPrices.vue'
import { mediaStillUrl, uniqueMediaAssets } from '~/shared/media-placement-contract'
import { getVerticalCopy } from '~/utils/vertical-copy'

const props = defineProps<{
  organizationId: string
  vertical: string
  product: PublicProduct
  location: PublicProductLocation | null
  organizationName?: string
  reviews: PublicProductReview[]
  /** Non-null exactly when this Product takes bookings. */
  booking: PublicProductBooking | null
  /**
   * The occurrences on sale here, loaded with the page rather than after it.
   * They arrive rendered, so the dates are in the HTML a crawler reads.
   */
  sessions?: PublicProductSession[]
  collectionName: string
  collectionSiblings: ProductCollectionSibling[]
  currency: CurrencyCode
  presentation: ProductPresentation
  /** The page supplies its route, authored blocks and SEO; the Product owns the offer. */
  pageDocument?: PublicTenantPage
  /** The directory supplies its own selected-service introduction. */
  scopeRequired?: boolean
  locations?: PublicProductLocation[]
  onlineAvailable?: boolean
  /** A place to stay is paid for on the site once the business's Payments setup is complete; until then it takes enquiries. */
  stayCheckoutAvailable: boolean
}>()

const displayTitle = computed(() => props.product.name)
/** A place to stay is booked by its nights, paid in full; its booking is not a session's. */
const isStay = computed(() => props.product.kind === 'stay')
const stayBooking = useStayBooking(() => ({ product: props.product, location: props.location, checkout: props.stayCheckoutAvailable }))
const bookingLabel = computed(() => isStay.value
  ? stayBooking.quote.value ? props.stayCheckoutAvailable ? t('stay.reserve') : t('stay.send_enquiry') : t('stay.check_availability')
  : props.vertical === 'service'
    ? props.booking?.confirmation_mode === 'review' ? t('booking.request_appointment') : t('booking.book_appointment')
    : t('site.experience_detail.book_now'))

const staySpecsSummary = computed(() => props.product.stay ? staySpecLabels(props.product.stay, t).join(' · ') : '')

const stayPropertyTypeLabel = computed(() => {
  const type = props.product.stay?.property_type
  return type ? STAY_PROPERTY_TYPES[type].label : ''
})

const stayPropertyFacts = computed(() => {
  const stay = props.product.stay
  if (!stay) return []
  return [
    ...(stay.listing_type ? [{ label: 'Listing type', value: STAY_LISTING_TYPES[stay.listing_type].label }] : []),
    ...(stay.total_floors !== null ? [{ label: 'Floors in building', value: String(stay.total_floors) }] : []),
    ...(stay.listing_floor !== null ? [{ label: 'Listing floor', value: String(stay.listing_floor) }] : []),
    ...(stay.year_built !== null ? [{ label: 'Year built', value: String(stay.year_built) }] : []),
    ...(stay.property_size !== null && stay.property_size_unit ? [{ label: 'Property size', value: `${stay.property_size} ${STAY_PROPERTY_SIZE_UNITS[stay.property_size_unit].symbol}` }] : []),
  ]
})

const stayCancellationPolicyLabel = computed(() => {
  const p = props.product.stay?.cancellation_policy
  return p ? `${STAY_CANCELLATION_POLICIES[p].label} cancellation policy` : ''
})

const AMENITIES_SHOWN = 10
// The full list in Airbnb's groups, each amenity once, under the first group that names it.
const stayAmenityGroups = computed(() => {
  const listed = new Set(stayAmenitiesList.value.map(amenity => amenity.code))
  const seen = new Set<string>()
  return Object.values(STAY_AMENITY_GROUPS).map(group => ({
    label: group.label,
    amenities: group.amenities.filter(code => listed.has(code) && !seen.has(code) && seen.add(code)).map(code => stayAmenitiesList.value.find(amenity => amenity.code === code)!),
  })).filter(group => group.amenities.length)
})
const descriptionOpen = ref(false)
const descriptionLong = computed(() => isStay.value && ((props.product.description?.length ?? 0) > 400 || stayDescriptionDetails.value.length > 0))
const descriptionClamped = computed(() => descriptionLong.value && !descriptionOpen.value)
const stayAmenitiesList = computed(() => {
  const stay = props.product.stay
  if (!stay) return []
  return stay.amenities.map(code => ({ code, label: STAY_AMENITIES[code].label, icon: STAY_AMENITIES[code].icon }))
})

const { trackProductOrder, trackProductView } = useOrganizationConversionTracking()
const { localePath, t, locale } = useI18n()
const verticalCopy = computed(() => getVerticalCopy(props.vertical, locale.value))
const collectionLabel = computed(() => {
  if (props.vertical === 'service' && (props.pageDocument || !props.location)) return t('site.footer.services')
  if (props.presentation.locationCollectionSegment === 'menu') return t('site.footer.menu')
  if (props.presentation.locationCollectionSegment === 'stays') return t('site.footer.stays')
  return props.presentation.locationCollectionSegment === 'experiences'
    ? t('site.footer.experiences')
    : t('site.footer.products')
})
const breadcrumbs = computed(() => [
  { to: localePath('/'), label: t('site.experience_detail.home') },
  { to: localePath(props.pageDocument ? '/services' : props.presentation.collectionPath), label: collectionLabel.value },
  // A home is its own page, so no branch stands between it and its index.
  ...(props.location && props.presentation.locationCollectionSegment !== 'stays' ? [{ to: localePath(props.presentation.locationCollectionSegment === 'experiences'
    ? `/locations/${encodeURIComponent(props.location.slug)}/experiences`
    : productLocationCollectionPath(props.vertical, props.location.slug)), label: props.location.title }] : []),
  { to: localePath(props.pageDocument?.path ?? props.presentation.productPath(props.location?.slug ?? '', props.product.slug)), label: displayTitle.value },
])

/** The headline offer and the booking form use the same currency and scope. */
const offer = computed<Price | null>(() => {
  const selection = { currency: props.currency, location_id: props.location?.id ?? null, at: new Date().toISOString() }
  // Only variants a customer can actually choose: a disabled variant's price
  // would otherwise headline an amount the selector never offers.
  const offers = sellableVariants.value.flatMap(variant => selectPrice(variant.prices, selection) ?? [])
  return offers.reduce<Price | null>((lowest, candidate) => (!lowest || candidate.unit_amount < lowest.unit_amount ? candidate : lowest), null)
})
/**
 * The amount, or the merchant's own words when the product is priced in words
 * instead. Neither one means this page shows no price — never a zero, a
 * "Free", or a "Market price" nobody wrote.
 */
const priceLabel = computed(() => {
  if (props.vertical === 'service' && sellableVariants.value.length === 1 && offer.value?.unit_amount === 0) return 'Free'
  const amount = formatProductMoney(offer.value)
  if (amount) return amount
  const note = props.product.details[PRICING_NOTE_HANDLE]
  return typeof note === 'string' && note.trim() ? note : null
})
/**
 * A product priced in words is sold by conversation: "Contact us for group
 * pricing" is the merchant asking to be asked, not a seat to be claimed at a
 * price. Its one action is the contact form, with the product named — the
 * rule the old experience surface called inquiry_only.
 */
const enquiryOnly = computed(() => offer.value === null && priceLabel.value !== null)
const enquiryPath = computed(() => `${localePath('/contact')}?about=${encodeURIComponent(props.product.name)}`)

const compareAtLabel = computed(() => {
  const price = offer.value
  if (!price || price.compare_at_unit_amount === null) return null
  return formatProductMoney({ ...price, unit_amount: price.compare_at_unit_amount, compare_at_unit_amount: null })
})

/**
 * Whether this branch is selling it at all: the merchant's switch and this
 * location's. Two facts, neither substituting for the other.
 *
 * A price is not one of them. A product priced in words — "Market price" — is
 * on sale; it just cannot be checked out online, which is a different question
 * asked below.
 */
/** The options a customer can actually choose. A retired variant is not one. */
const sellableVariants = computed(() => props.product.variants.filter(variant => variant.active !== false))

const isAvailable = computed(() =>
  props.product.active
  && (props.location ? props.product.locations.some(entry => entry.location_id === props.location?.id && entry.active) : Boolean(props.product.order_url || props.booking?.held_online))
  // Every option retired is the merchant having nothing left to sell here. The
  // booking form otherwise asked for an option it had none to offer.
  && (Boolean(props.product.order_url) || sellableVariants.value.length > 0))
const canOrderExternally = computed(() => isAvailable.value && Boolean(props.product.order_url))
const externalActionLabel = computed(() => props.product.kind === 'experience' || props.product.kind === 'service' || props.product.kind === 'stay' ? t('site.experience_detail.book_now') : t('site.cta.order_now'))
const canEnquire = computed(() => props.product.kind !== 'experience' && isAvailable.value && !props.product.order_url && enquiryOnly.value)
const canBook = computed(() => isStay.value
  ? !props.scopeRequired && isAvailable.value && offer.value !== null
  : !props.scopeRequired && Boolean(props.booking) && isAvailable.value && !props.product.order_url && !enquiryOnly.value && (props.vertical !== 'service' || offer.value !== null))



/**
 * Every photograph this product has, cover first, in one gallery.
 *
 * The cover is the `product:image` placement and the rest are `product:gallery`
 * — two slots, read as the two things they are, not one list with a chosen
 * head.
 */
const productMedia = computed(() => uniqueMediaAssets([
  ...(props.product.image ? [props.product.image] : []),
  ...props.product.gallery,
]))
const galleryItems = computed(() => uniqueMediaAssets([
  ...productMedia.value,
  ...(props.pageDocument?.media.filter(asset => asset.slot === 'cover' || asset.slot === 'gallery') ?? []),
]).filter(asset => asset.public_url).map(asset => ({
  asset_id: asset.asset_id,
  url: asset.public_url!,
  kind: asset.kind,
  poster: asset.kind === 'video' ? asset.thumbnail_url : undefined,
  alt: asset.alt_text ?? undefined,
})))
const mediaGallery = ref<InstanceType<typeof MediaGallery> | null>(null)

function openGalleryAsset(assetId: string) {
  const index = galleryItems.value.findIndex(item => item.asset_id === assetId)
  if (index < 0 || !mediaGallery.value) throw new TypeError('The accessibility photo is not in this listing gallery')
  mediaGallery.value.openLightbox(index)
}

const stayAccessibilityFeatures = computed<NonNullable<MediaGalleryGroup['features']>>(() => {
  if (!isStay.value || !props.product.stay) return []
  const imageIds = new Set(productMedia.value.filter(asset => asset.kind === 'image' && asset.public_url).map(asset => asset.asset_id))
  return props.product.stay.accessibility.filter(answer => answer.available === true).map(answer => {
    if (!answer.photo_ids.length || answer.photo_ids.some(id => !imageIds.has(id))) throw new TypeError('The listing accessibility feature has no Product image evidence')
    return {
      id: answer.feature, icon: STAY_HOME_ACCESSIBILITY_FEATURES[answer.feature].icon,
      label: t(`stay.home_accessibility_features.${answer.feature}.label`),
      description: t(`stay.home_accessibility_features.${answer.feature}.description`),
      asset_ids: answer.photo_ids,
    }
  })
})

/** Room facts remain available even when the photo tour is not complete. */
const stayRoomGroups = computed<MediaGalleryGroup[]>(() => {
  if (!isStay.value || !props.product.stay) return []
  const rooms = props.product.stay.photo_rooms
  const imageIds = new Set(productMedia.value.filter(asset => asset.kind === 'image' && asset.public_url).map(asset => asset.asset_id))
  return rooms.map(room => ({
    id: room.id,
    title: stayPhotoRoomName(room, rooms, t(`stay.photo_room_types.${room.type}`)),
    asset_ids: room.photo_ids,
    details: [
      ...(room.sleeping_arrangements === null ? [] : room.sleeping_arrangements.length
        ? room.sleeping_arrangements.map(bed => t(`stay.bed_types.${bed.type}`, { count: bed.count }, bed.count))
        : [t('stay.no_sleeping_arrangements')]),
      ...(room.private_attached_bathroom === null ? [] : [t(room.private_attached_bathroom ? 'stay.private_attached_bathroom' : 'stay.no_private_attached_bathroom')]),
    ],
    features: [
      ...room.amenities.map(code => {
        const amenity = stayAmenitiesList.value.find(item => item.code === code)
        if (!amenity) throw new TypeError(`Room ${room.id} refers to an amenity the listing does not offer`)
        return { id: code, label: amenity.label, icon: amenity.icon }
      }),
      ...room.accessibility.filter(answer => answer.available === true).map(answer => {
        if (!answer.photo_ids.length || answer.photo_ids.some(id => !imageIds.has(id))) throw new TypeError(`Room ${room.id} has an accessibility feature without its Product image evidence`)
        const feature = STAY_ROOM_ACCESSIBILITY_FEATURES[answer.feature]
        return {
          id: `accessibility:${answer.feature}`,
          label: t(`stay.accessibility_features.${answer.feature}.label`),
          icon: feature.icon,
          description: t(`stay.accessibility_features.${answer.feature}.description`),
          asset_ids: answer.photo_ids,
        }
      }),
    ],
  }))
})
const authoredRoomDetails = computed(() => stayRoomGroups.value.filter(room => room.details?.length || room.features?.length))
const roomDetailsTitle = computed(() => t(props.product.stay?.photo_rooms.some(room => room.sleeping_arrangements?.length) ? 'stay.where_youll_sleep' : 'stay.room_details'))

/** A room tour is public only when every authored room has renderable Product media. */
const photoGroups = computed<MediaGalleryGroup[]>(() => {
  if (!isStay.value) return []
  const productIds = new Set(productMedia.value.filter(asset => asset.public_url && mediaStillUrl(asset)).map(asset => asset.asset_id))
  const rooms = (props.product.stay?.photo_rooms ?? []).map(room => ({ ...room, photo_ids: room.photo_ids.filter(id => productIds.has(id)) }))
  if (!stayPhotoTourReady(rooms)) return []
  const assigned = new Set(rooms.flatMap(room => room.photo_ids))
  const groups = stayRoomGroups.value.map(group => ({ ...group, asset_ids: rooms.find(room => room.id === group.id)!.photo_ids }))
  const additional = galleryItems.value.filter(item => !assigned.has(item.asset_id)).map(item => item.asset_id)
  if (additional.length) groups.push({ id: 'additional', title: t('stay.additional_photos'), asset_ids: additional })
  return groups
})

/**
 * The two facts a guest decides on before opening the form: how long it runs
 * and how many it takes. Both come from the product's booking configuration,
 * which is also what its sessions are generated from, so the page and the
 * calendar cannot disagree.
 */
const factChips = computed(() => {
  const chips: Array<{ icon: 'clock' | 'user-group' | 'video-camera' | 'check-circle'; label: string }> = []
  const config = props.product.booking
  if (!config) return []
  if (props.vertical === 'service' && !props.location && !props.product.order_url) chips.push({ icon: 'video-camera', label: 'Online' })
  if (config.duration_minutes) {
    const minutes = config.duration_minutes
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    chips.push({
      icon: 'clock',
      label: minutes < 60
        ? t('site.experience_detail.minutes', { count: minutes })
        : rest
          ? t('site.experience_detail.hours_minutes', { hours, minutes: rest })
          : t('site.experience_detail.hours', { count: hours }),
    })
  }
  if (config.default_capacity && props.vertical !== 'service') {
    chips.push({ icon: 'user-group', label: t('site.experience_detail.capacity', { count: config.default_capacity }) })
  }
  if (props.vertical === 'service' && !props.product.order_url) chips.push({ icon: 'check-circle', label: config.confirmation_mode === 'review' ? 'Staff review' : 'Instant confirmation' })
  return chips
})

/**
 * Customer facts labeled by the shared product field schema.
 * Invalid fields are refused by the canonical product writer.
 */
const visibleDetails = computed(() => productDetailFields(props.product.kind).flatMap((definition) => {
  const handle = productDetailKey(definition)
  // The pricing note is shown where the price goes, so it is not repeated in
  // the attribute list underneath it.
  if (handle === PRICING_NOTE_HANDLE || definition.value_type === 'boolean' || (STAY_HOUSE_RULE_DETAIL_KEYS as readonly string[]).includes(handle) || (STAY_SAFETY_DETAIL_KEYS as readonly string[]).includes(handle)) return []
  const value = props.product.details[handle]
  if (value === undefined || value === null) return []
  const values = Array.isArray(value) ? value : [String(value)]
  return values.length ? [{ key: definition.id, label: definition.name, values }] : []
}).concat(stayDetails(props.product.stay)))

/** A place to stay's amenities and cancellation policies, named from their catalogs. */
function stayDetails(stay: typeof props.product.stay): Array<{ key: string; label: string; values: string[] }> {
  if (!stay) return []
  const policies = [
    ...(stay.cancellation_policy ? [`${STAY_CANCELLATION_POLICIES[stay.cancellation_policy].label}: ${STAY_CANCELLATION_POLICIES[stay.cancellation_policy].summary}`] : []),
    ...(stay.long_term_cancellation_policy ? [`${STAY_LONG_TERM_CANCELLATION_POLICIES[stay.long_term_cancellation_policy].label}: ${STAY_LONG_TERM_CANCELLATION_POLICIES[stay.long_term_cancellation_policy].summary}`] : []),
  ]
  return [
    ...(policies.length ? [{ key: 'cancellation_policy', label: 'Cancellation policy', values: policies }] : []),
  ]
}

const { data: initialSessions, error: initialSessionsError } = await useAsyncData(`product-detail-sessions:${props.organizationId}:${props.product.id}:${props.location?.id ?? 'online'}`, async () => {
  if (!props.booking || props.product.order_url || props.scopeRequired) return []
  if (props.sessions !== undefined) return props.sessions
  if (import.meta.server) {
    const event = useRequestEvent()!
    const { cloudflareEnv } = await import('~/server/utils/api-response')
    const { listPublicBookingSessions } = await import('~/server/utils/public-session-booking')
    return (await listPublicBookingSessions(cloudflareEnv(event).DB, props.organizationId, props.product.slug, cloudflareEnv(event), props.location?.id ?? 'online')).sessions.filter(session => !session.is_full)
  }
  return (await publicApiRequest<{ success: true; sessions: PublicProductSession[] }>(`/api/public/products/${encodeURIComponent(props.product.slug)}/sessions?location_id=${encodeURIComponent(props.location?.id ?? 'online')}`, {
    validate: (value): value is { success: true; sessions: PublicProductSession[] } => isRecord(value) && value.success === true && Array.isArray(value.sessions),
  })).sessions.filter(session => !session.is_full)
})
if (initialSessionsError.value) throw initialSessionsError.value
if (!initialSessions.value) throw createError({ statusCode: 500, statusMessage: 'Appointment availability was not returned' })
const bookingController = useSessionBooking(() => ({ organizationId: props.organizationId,
    organizationName: props.location?.title ?? props.organizationName!, product: props.product, currency: props.currency,
    location: props.location, sessions: initialSessions.value!, showPartySize: props.vertical !== 'service' }))
const { bookingOpen, bookingStep, submitting, sessions: bookingSessions, sessionsPending, loadSessions, openBooking: openSessionBooking, openBookingAt,
  upcomingSessions, sessionDayLabel, sessionTimeLabel, bookingError, allowTimezoneSelection, bookingTimezone, timezoneOptions, guestTimezone } = bookingController

function openBooking() {
  if (isStay.value) stayBooking.openBooking()
  else openSessionBooking()
}
/** A label pressed from the keyboard activates the checkbox it names, as a click does. */
/** A wide product page with dated sessions carries them in its booking card, as Airbnb's experience and service pages do. */
const cardListsSessions = computed(() => !isStay.value && canBook.value && !enquiryOnly.value && !canOrderExternally.value && !canEnquire.value && Boolean(priceLabel.value))
const sessionPickLabel = computed(() => props.vertical === 'service' ? t('site.experience_detail.select_time') : t('site.experience_detail.book'))

function pressLabel(event: KeyboardEvent) {
  (event.currentTarget as HTMLElement).click()
}

// The page is served with its sessions; this re-reads them once the browser
// has it, so a tab left open does not offer a seat that has since gone. Only
// for a product a guest can book here; an enquiry has no calendar.
onMounted(() => {
  // Every product view is a native interaction; only a priced, bookable product is an ecommerce item.
  trackProductView(props.product.id, props.location?.id ?? null, offer.value && !enquiryOnly.value
    ? { product_id: props.product.id, name: props.product.name, currency: offer.value.currency, price: ga4Major(offer.value.unit_amount, offer.value.currency) }
    : null)
  if (props.booking && canBook.value) void loadSessions()
})

/** What guests say, in one number: the mean rating to one decimal, or none. */
const averageRating = computed(() => {
  if (!props.reviews.length) return null
  return (props.reviews.reduce((total, review) => total + review.rating, 0) / props.reviews.length).toFixed(1)
})
const experienceHighlights = computed(() => {
  if (isStay.value) return []
  const cancellation = props.product.details.cancellation_policy
  const recent = [...props.reviews].sort((left, right) => (right.original_review_date ?? right.created_at).localeCompare(left.original_review_date ?? left.created_at))[0]
  return [
    ...(typeof cancellation === 'string' && cancellation.trim() ? [{ key: 'cancellation', icon: 'calendar-days' as const, title: t('site.experience_detail.cancellation'), text: cancellation.trim() }] : []),
    ...(recent ? [{ key: 'review', icon: 'star' as const, title: t('site.experience_detail.recent_review'), text: `“${recent.content}” — ${recent.author_name}` }] : []),
  ]
})
const reviewCountLabel = computed(() => (props.reviews.length === 1
  ? t('site.experience_detail.review_count_one')
  : t('site.experience_detail.review_count', { count: props.reviews.length })))

/**
 * The attributes the page gives their own place, read by their canonical
 * handle (EXPERIENCE_ATTRIBUTE_HANDLES). Everything else the tenant defined
 * is "things to know".
 */
function attribute<T>(handle: keyof PublicProduct['details'], read: (_value: ProductDetailValue) => T | null): T | null {
  const value = props.product.details[handle]
  return value === undefined || value === null ? null : read(value)
}
const asText = (value: ProductDetailValue) => (typeof value === 'string' && value.trim() ? value : null)
const asList = (value: ProductDetailValue) => (Array.isArray(value) ? value.map(String).filter(Boolean) : null)
const tagline = computed(() => attribute(EXPERIENCE_ATTRIBUTE_HANDLES.tagline, asText))
const stayDescriptionDetails = computed(() => props.product.kind === 'stay'
  ? productDetailFields('stay').flatMap(definition => {
      if (!(STAY_DESCRIPTION_DETAIL_KEYS as readonly string[]).includes(definition.key)) return []
      const value = props.product.details[definition.key]
      return typeof value === 'string' && value.trim() ? [{ key: definition.key, label: definition.name, value }] : []
    })
  : [])
const meetingPoint = computed(() => attribute(EXPERIENCE_ATTRIBUTE_HANDLES.meetingPoint, asText))
const includedItems = computed(() => attribute(EXPERIENCE_ATTRIBUTE_HANDLES.includedItems, asList) ?? [])
const whatToBring = computed(() => attribute(EXPERIENCE_ATTRIBUTE_HANDLES.whatToBring, asList) ?? [])
const PLACED_ATTRIBUTE_HANDLES = new Set<string>([...Object.values(EXPERIENCE_ATTRIBUTE_HANDLES), ...STAY_DESCRIPTION_DETAIL_KEYS, ...STAY_LOCATION_DETAIL_KEYS])
const stayLocationDetails = computed(() => STAY_LOCATION_DETAIL_KEYS.flatMap(key => {
  const text = props.product.details[key]
  return typeof text === 'string' ? [{ key, label: t(`stay.${key}`), text }] : []
}))
const stayRules = computed(() => props.product.kind === 'stay' ? stayHouseRuleLines(props.product.details, value => formatTime(value, locale.value)) : [])
/** Airbnb's three columns for a home: house rules with its times and party, safety and property, then its other details. */
const stayHouseRules = computed(() => props.product.stay ? [
  t('stay.check_in_after', { time: formatTime(props.product.stay.check_in_time, locale.value) }),
  t('stay.check_out_before', { time: formatTime(props.product.stay.check_out_time, locale.value) }),
  t('stay.guests_maximum', props.product.stay.max_guests),
  ...stayRules.value,
] : [])
// Installed, absent and unanswered alarms retain their distinct authored meaning.
const staySafety = computed(() => {
  const stay = props.product.stay
  if (!stay) return []
  return [
    ...STAY_AMENITY_GROUPS.home_safety.amenities.filter(code => !(STAY_ALARM_AMENITIES as readonly string[]).includes(code) && stay.amenities.includes(code)).map(code => STAY_AMENITIES[code].label),
    ...stayAlarmLines(stay.amenity_answers, props.product.details, { includeUnknown: true, absent: item => t('stay.not_installed', { item }), unknown: item => t('stay.not_reported', { item }) }),
    ...staySafetyLines(props.product.details),
  ]
})
const thingsToKnow = computed(() => [
  ...(stayHouseRules.value.length ? [{ key: 'house_rules', label: t('stay.house_rules'), values: stayHouseRules.value }] : []),
  ...(staySafety.value.length ? [{ key: 'safety', label: t('stay.safety_property'), values: staySafety.value }] : []),
  ...visibleDetails.value.filter((detail) => {
    const definition = productDetailFields(props.product.kind).find(entry => entry.id === detail.key)
    return !definition || !PLACED_ATTRIBUTE_HANDLES.has(productDetailKey(definition))
  }),
])

const addressLine = computed(() => formatPostalAddress(props.location?.address ?? null))
// A home is named by its town, as Airbnb's "Villa in Ao Nang"; its location's title is the home's own name.
const stayPlaceName = computed(() => props.location?.public_area?.locality || props.location?.public_area?.administrative_area || props.location?.public_area?.label || addressPlaceName(props.location?.address ?? null))
const locationName = computed(() => props.location?.public_area?.label || props.location?.title || props.organizationName)
// A map from the coordinates the branch already has; no key, no second source.
const mapEmbedUrl = computed(() => props.location?.map_embed_url ?? null)


function recordExternalOrderClick() {
  if (!import.meta.client) return
  trackProductOrder(
    props.location?.id ?? null,
    props.product.id,
    props.pageDocument?.path ?? props.presentation.productPath(props.location?.slug ?? '', props.product.slug),
  )
}

/**
 * What this page describes, in schema.org's vocabulary.
 *
 * A dish is a MenuItem and a shop's goods are a Product: that is what the
 * surface sells, and `presentation.structuredDataType` names it. An experience
 * is a class that runs at a stated time, which is an Event — several of them
 * are an EventSeries. Google reads an occurrence only as its own top-level
 * Event with its own address and Offer, so the soonest occurrences are emitted
 * that way and joined to the series by @id; the series states how many there
 * are in one AggregateOffer rather than repeating every offer.
 *
 * A bookable experience with nothing scheduled is the one case that reads back
 * down to Product. An Event is defined by its `startDate`, and this one has no
 * date to state; it is still a Product on sale, so it says that rather than
 * claiming to be an Event that never happens.
 */
const schemaSessions = computed(() => [...bookingSessions.value].sort((left, right) => left.starts_at.localeCompare(right.starts_at)))
const structuredDataType = computed(() => {
  const declared = props.presentation.structuredDataType
  if (declared !== 'Event') return declared
  if (!schemaSessions.value.length) return 'Product'
  return schemaSessions.value.length > 1 ? 'EventSeries' : 'Event'
})

// Structured data names the page by an absolute URL, resolved against the
// request the way the breadcrumbs are, so a tenant's markup stays on the
// tenant's own domain.
const requestURL = useRequestURL()
// A place to stay has no external link: it is booked on this page, which is its canonical URL.
const canonicalProductUrl = computed(() => new URL(
  props.product.order_url || localePath(props.presentation.productPath(props.location?.slug ?? '', props.product.slug)),
  requestURL.origin,
).toString())

/** Where it runs: the branch, as a place a guest can be sent to. */
const schemaPlace = computed(() => props.location ? ({
  '@type': 'Place',
  name: props.location.title,
  address: schemaPostalAddress(props.location.address),
  ...(props.location && props.location.latitude !== null && props.location.longitude !== null
    ? { geo: { '@type': 'GeoCoordinates', latitude: props.location.latitude, longitude: props.location.longitude } }
    : {}),
}) : { '@type': 'VirtualLocation', url: canonicalProductUrl.value })

/**
 * The seat on one occurrence, priced the way the page prices it.
 *
 * A seat is on sale from the moment its occurrence exists — `created_at` on the
 * session row — until the class begins. Both ends are recorded facts, so the
 * markup states the window rather than the instant the page happened to render:
 * a `new Date()` here would differ between the server and the hydrated client
 * and change on every request.
 */
function sessionOffer(session: PublicProductSession) {
  const price = offer.value
  return {
    '@type': 'Offer',
    ...(price
      ? { price: minorAmountToMajor(price.unit_amount, price.currency), priceCurrency: price.currency }
      : {}),
    availability: isAvailable.value && !session.is_full
      ? 'https://schema.org/InStock'
      : 'https://schema.org/SoldOut',
    validFrom: session.created_at,
    validThrough: session.starts_at,
    url: canonicalProductUrl.value,
  }
}

/** Upcoming occurrences marked up as their own Events; the series counts the rest. */
const SCHEMA_EVENT_LIMIT = 10
const schemaSeriesId = computed(() => `${canonicalProductUrl.value}#event-series`)

/** One occurrence, as its own dated Event belonging to the series. */
function sessionEvent(session: PublicProductSession) {
  return {
    '@type': 'Event',
    '@id': `${canonicalProductUrl.value}#event-${session.id}`,
    superEvent: { '@id': schemaSeriesId.value },
    name: props.product.name,
    image: props.product.image?.public_url,
    startDate: session.starts_at,
    endDate: session.ends_at,
    eventAttendanceMode: props.location ? 'https://schema.org/OfflineEventAttendanceMode' : 'https://schema.org/OnlineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: schemaPlace.value,
    offers: sessionOffer(session),
  }
}

/**
 * A place to stay as schema.org reads one: an Accommodation at its address,
 * how many it sleeps, what it offers, its photographs, its arrival and
 * departure times, and its base rate stated per night. Its URL is this page,
 * where it is booked.
 */
const stayStructuredData = computed(() => {
  const stay = props.product.stay
  if (!stay) return null
  const price = offer.value
  return {
    '@type': 'Accommodation',
    name: props.product.name,
    description: props.product.description,
    url: canonicalProductUrl.value,
    image: galleryItems.value.filter(item => item.kind !== 'video').map(item => item.url),
    ...(props.location ? {
      address: schemaPostalAddress(props.location.address),
      ...(props.location.latitude !== null && props.location.longitude !== null ? { geo: { '@type': 'GeoCoordinates', latitude: props.location.latitude, longitude: props.location.longitude } } : {}),
    } : {}),
    occupancy: { '@type': 'QuantitativeValue', minValue: 1, maxValue: stay.max_guests },
    ...(stay.property_type ? { accommodationCategory: STAY_PROPERTY_TYPES[stay.property_type].label } : {}),
    ...(stay.listing_type ? { additionalType: STAY_LISTING_TYPES[stay.listing_type].schemaType satisfies Accommodation['additionalType'] } : {}),
    ...(stay.property_size !== null && stay.property_size_unit ? { floorSize: {
      '@type': 'QuantitativeValue',
      value: stay.property_size,
      unitText: STAY_PROPERTY_SIZE_UNITS[stay.property_size_unit].label,
    } } : {}),
    ...(stay.bedrooms !== null ? { numberOfBedrooms: stay.bedrooms } : {}),
    ...(stay.bathrooms !== null ? { numberOfBathroomsTotal: stay.bathrooms } : {}),
    ...(stay.beds !== null ? { bed: { '@type': 'BedDetails', numberOfBeds: stay.beds } } : {}),
    ...(stay.amenity_answers.length || stay.accessibility.some(answer => answer.available !== null) ? { amenityFeature: [
      ...stay.amenity_answers.map(answer => ({ '@type': 'LocationFeatureSpecification', name: STAY_AMENITIES[answer.code].label, value: answer.available })),
      ...stay.accessibility.flatMap(answer => answer.available === null ? [] : [{ '@type': 'LocationFeatureSpecification', name: t(`stay.home_accessibility_features.${answer.feature}.label`), value: answer.available }]),
    ] } : {}),
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'checkinTime', value: stay.check_in_time },
      { '@type': 'PropertyValue', name: 'checkoutTime', value: stay.check_out_time },
      { '@type': 'PropertyValue', name: 'minimumNights', value: stay.min_nights },
      ...(stay.total_floors !== null ? [{ '@type': 'PropertyValue' as const, name: 'totalFloors', value: stay.total_floors }] : []),
      ...(stay.listing_floor !== null ? [{ '@type': 'PropertyValue' as const, name: 'listingFloor', value: stay.listing_floor }] : []),
      ...(stay.year_built !== null ? [{ '@type': 'PropertyValue' as const, name: 'yearBuilt', value: stay.year_built }] : []),
    ] satisfies PropertyValue[],
    ...(price ? { offers: {
      '@type': 'Offer',
      url: canonicalProductUrl.value,
      availability: canBook.value ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: minorAmountToMajor(price.unit_amount, price.currency),
        priceCurrency: price.currency,
        unitText: 'night',
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'DAY', unitText: 'night' },
      },
    } } : {}),
  }
})

useSchemaOrg(computed(() => {
  // Page documents keep their canonical SEO/schema; a directory is not a second Product page.
  if (props.pageDocument) return []
  if (stayStructuredData.value) return {
    ...stayStructuredData.value,
    aggregateRating: props.reviews.length
      ? { '@type': 'AggregateRating', ratingValue: props.reviews.reduce((total, review) => total + review.rating, 0) / props.reviews.length, reviewCount: props.reviews.length }
      : undefined,
  }
  const type = structuredDataType.value
  const list = schemaSessions.value
  const first = list[0]
  const last = list[list.length - 1]
  const dietUrls = extractDietarySchemaUrls(props.product)
  const upcoming = type === 'EventSeries' ? list.slice(0, SCHEMA_EVENT_LIMIT).map(sessionEvent) : []
  const price = offer.value
  const node = {
    '@type': type,
    ...(type === 'EventSeries' ? { '@id': schemaSeriesId.value } : {}),
    name: props.product.name,
    description: props.product.description,
    image: props.product.image?.public_url,
    ...(dietUrls.length ? { suitableForDiet: dietUrls } : {}),
    ...(first && last
      ? {
          url: canonicalProductUrl.value,
          startDate: first.starts_at,
          endDate: last.ends_at,
          eventAttendanceMode: props.location ? 'https://schema.org/OfflineEventAttendanceMode' : 'https://schema.org/OnlineEventAttendanceMode',
          eventStatus: 'https://schema.org/EventScheduled',
          location: schemaPlace.value,
          // A single class carries its seat's own offer; a series states every
          // occurrence's seat once, and each marked-up Event carries its own.
          offers: type === 'EventSeries'
            ? {
                '@type': 'AggregateOffer',
                ...(price ? { lowPrice: minorAmountToMajor(price.unit_amount, price.currency), highPrice: minorAmountToMajor(price.unit_amount, price.currency), priceCurrency: price.currency } : {}),
                offerCount: list.length,
                availability: isAvailable.value && list.some(session => !session.is_full) ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut',
                url: canonicalProductUrl.value,
              }
            : sessionOffer(first),
          ...(type === 'EventSeries' ? { subEvent: upcoming.map(event => ({ '@id': event['@id'] })) } : {}),
        }
      : {
          // An offer node states an amount, so a product priced in words has none to
          // state. It is still on sale; it simply is not quoted here.
          offers: offer.value
            ? {
                '@type': 'Offer',
                price: minorAmountToMajor(offer.value.unit_amount, offer.value.currency),
                priceCurrency: offer.value.currency,
                availability: isAvailable.value ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
                url: canonicalProductUrl.value,
              }
            : undefined,
        }),
    aggregateRating: props.reviews.length
      ? {
          '@type': 'AggregateRating',
          ratingValue: props.reviews.reduce((total, review) => total + review.rating, 0) / props.reviews.length,
          reviewCount: props.reviews.length,
        }
      : undefined,
    review: props.reviews.map(review => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: review.author_name },
      name: review.title,
      reviewBody: review.content,
      reviewRating: { '@type': 'Rating', ratingValue: review.rating, bestRating: 5 },
    })),
  }
  return upcoming.length ? [node, ...upcoming] : node
}))
</script>
