<template>
  <div class="bg-default text-default" :class="compact ? undefined : 'min-h-screen'">
    <slot name="scope">
      <BookingScopeSelect :locations="locations ?? []" :online-available="onlineAvailable" :selected-location-id="location?.id ?? null" :scope-required="scopeRequired" />
    </slot>
    <AppBreadcrumb v-if="!compact" :crumbs="breadcrumbs" />

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
      <SayaButton v-if="canOrderExternally" class="shrink-0" :href="product.order_url!" target="_blank" rel="noopener noreferrer" @click="recordExternalOrderClick">{{ externalActionLabel }}</SayaButton>
      <SayaButton v-else-if="canEnquire" class="shrink-0" :to="enquiryPath">
        {{ t('saya.experience_detail.enquire') }}
      </SayaButton>
      <SayaButton v-else class="shrink-0" control-id="product-booking-toggle" @click="openBooking">
        {{ bookingLabel }}
      </SayaButton>
    </div>

    <article :class="booking || isStay ? 'mx-auto max-w-7xl px-4 pb-28 sm:px-6 lg:px-8 lg:pb-20' : 'mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8'">
      <!-- A bookable product is read the way it is sold: the gallery and the
           prose on the left, and the price, the facts and the booking control
           travelling with the reader on the right. A product that takes no
           bookings has nothing to put in that column, so it keeps the single
           card. -->
      <div v-if="booking || product.order_url || isStay">
        <MediaGallery v-if="!compact && galleryItems.length" :items="galleryItems" :title="displayTitle" />

        <!-- What it is, in one glance: name, tagline, how guests rate it,
             where it runs, how long, how many. Centred under the photographs
             the way the rest of Saya introduces a place. -->
        <header v-if="!compact" class="mx-auto mt-10 max-w-3xl text-center">
          <p class="saya-kicker mb-3">{{ collectionName }}</p>
          <h1 class="saya-display-md text-3xl text-default sm:text-4xl lg:text-5xl">{{ displayTitle }}</h1>
          <p v-if="tagline" class="mx-auto mt-4 max-w-2xl text-base text-muted sm:text-lg">{{ tagline }}</p>
          <ProductVariantPrices v-if="!booking && !isStay" :product="product" :location-ids="[location?.id ?? null]" :currency="currency" class="mx-auto mt-6 max-w-xl text-base" />
          <div class="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted">
              <template v-if="averageRating">
                <span class="inline-flex items-center gap-1 font-medium text-default">
                  <SayaIcon name="star" solid class="size-4" />{{ averageRating }}
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
              <SayaIcon :name="fact.icon" class="size-3.5" />
              {{ fact.label }}
            </span>
          </div>
          <slot name="actions" />
        </header>

        <div class="grid gap-10 lg:grid-cols-[1fr_380px] lg:items-start" :class="compact ? 'mt-8' : 'mt-14'">
        <div class="min-w-0">
          <p v-if="!canBook && !canEnquire && !canOrderExternally" role="status" class="rounded-xl border border-default bg-elevated p-5 text-muted lg:hidden">{{ scopeRequired ? t('booking.choose_location') : vertical === 'service' && !offer ? t('booking.price_unavailable_contact') : t('saya.common.temporarily_unavailable') }}</p>
          <section v-if="!compact && product.description" class="border-t border-default pt-10">
            <h2 v-if="vertical !== 'service'" class="saya-display text-2xl text-default sm:text-3xl">{{ isStay ? t('stay.about_this_place') : t('saya.experience_detail.what_youll_do') }}</h2>
            <p class="mt-4 whitespace-pre-line text-base leading-relaxed text-muted sm:text-lg">{{ product.description }}</p>
          </section>

          <!-- The next few sessions, on the page: a guest sees when it runs
               before they open anything. The full picker is one press away. -->
          <section v-if="canBook && !enquiryOnly && !isStay" :id="compact ? undefined : 'consultations'" class="border-t border-default pt-8 scroll-mt-32">
            <div class="flex flex-wrap items-baseline justify-between gap-4">
              <h2 class="saya-display text-2xl text-default sm:text-3xl">{{ t('saya.experience_detail.upcoming_availability') }}</h2>
              <SayaButton v-if="upcomingSessions.length" variant="ghost" control-id="product-booking-toggle" @click="openBooking">
                {{ t('saya.experience_detail.see_all_dates') }} →
              </SayaButton>
            </div>
            <!-- Sessions win over the spinner: the page is served with them, so
                 a refresh in flight never blanks dates a reader can already see.
                 The empty copy is the last branch, reached only when a load has
                 returned nothing — it is an answer, not an unfinished one. -->
            <BookingTimezoneSelect v-if="allowTimezoneSelection" :model-value="bookingTimezone" :options="timezoneOptions" class="mt-5 max-w-sm" @update:model-value="guestTimezone = $event" />
            <p v-if="bookingError" role="alert" class="mt-4 text-sm text-error">{{ bookingError }}</p>
            <ul v-else-if="upcomingSessions.length" class="mt-5 grid gap-3 sm:grid-cols-2">
              <li v-for="session in upcomingSessions" :key="session.id" class="flex items-center justify-between gap-4 rounded-xl border border-default bg-elevated px-4 py-3">
                <div class="min-w-0">
                  <p class="font-medium text-default">{{ sessionDayLabel(session) }}</p>
                  <p class="text-sm text-muted">
                    {{ sessionTimeLabel(session) }}
                    <template v-if="session.remaining !== null && vertical !== 'service'"> · {{ t('saya.experience_detail.left', { count: session.remaining }) }}</template>
                  </p>
                </div>
                <SayaButton control-id="product-booking-toggle" @click="openBookingAt(session)">
                  {{ vertical === 'service' ? t('saya.experience_detail.select_time') : t('saya.experience_detail.book') }}
                </SayaButton>
              </li>
            </ul>
            <p v-else-if="sessionsPending" class="mt-4 text-sm text-muted">{{ t('saya.experience_detail.processing') }}</p>
            <p v-else class="mt-4 text-sm text-muted">{{ t('saya.experience_detail.no_availability', { count: PUBLIC_BOOKING_WINDOW_DAYS }) }}</p>
          </section>

          <section v-if="includedItems.length || whatToBring.length" class="mt-10 grid gap-8 border-t border-default pt-10 sm:grid-cols-2">
            <div v-if="includedItems.length">
              <h2 class="saya-display text-2xl text-default sm:text-3xl">{{ t('saya.experience_detail.included') }}</h2>
              <ul class="mt-4 space-y-2">
                <li v-for="item in includedItems" :key="item" class="flex items-start gap-2 text-sm leading-6 text-muted">
                  <SayaIcon name="check-circle" class="mt-1 size-4 shrink-0 text-primary" />{{ item }}
                </li>
              </ul>
            </div>
            <div v-if="whatToBring.length">
              <h2 class="saya-display text-2xl text-default sm:text-3xl">{{ t('saya.experience_detail.what_to_bring') }}</h2>
              <ul class="mt-4 space-y-2">
                <li v-for="item in whatToBring" :key="item" class="flex items-start gap-2 text-sm leading-6 text-muted">
                  <SayaIcon name="shopping-bag" class="mt-1 size-4 shrink-0 text-primary" />{{ item }}
                </li>
              </ul>
            </div>
          </section>

          <section v-if="location" class="mt-10 border-t border-default pt-10">
            <h2 class="saya-display text-2xl text-default sm:text-3xl">{{ isStay ? t('stay.where_youll_be') : t('saya.experience_detail.where_youll_meet') }}</h2>
            <div class="mt-5 overflow-hidden rounded-xl border border-default bg-elevated">
              <div class="flex items-start gap-4 p-6">
                <SayaIcon name="map-pin" class="mt-0.5 size-5 shrink-0 text-primary" />
                <div class="min-w-0">
                  <p class="font-semibold text-default">{{ location?.title ?? organizationName }}</p>
                  <p v-if="addressLine" class="mt-1 text-sm text-muted">{{ addressLine }}</p>
                  <p v-if="location?.phone" class="mt-1 text-sm text-muted">{{ location.phone }}</p>
                  <p v-if="meetingPoint" class="mt-3 whitespace-pre-line text-sm leading-6 text-default">{{ meetingPoint }}</p>
                  <a
                    v-if="location?.maps_url"
                    :href="location?.maps_url ?? undefined"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    {{ t('saya.experience_detail.open_in_maps') }}
                    <SayaIcon name="arrow-top-right-on-square" class="size-3" />
                  </a>
                </div>
              </div>
              <iframe
                v-if="mapEmbedUrl"
                :src="mapEmbedUrl"
                :title="location?.title ?? organizationName"
                class="h-56 w-full border-t border-default"
                style="border-width: 1px 0 0"
                loading="lazy"
                referrerpolicy="no-referrer-when-downgrade"
              />
            </div>
          </section>

          <section v-if="thingsToKnow.length" class="mt-10 border-t border-default pt-10">
            <h2 class="saya-display text-2xl text-default sm:text-3xl">{{ t('saya.experience_detail.things_to_know') }}</h2>
            <div class="mt-5 grid gap-x-10 gap-y-6 sm:grid-cols-2">
              <div v-for="detail in thingsToKnow" :key="detail.key">
                <h3 class="text-sm font-semibold text-default">{{ detail.label }}</h3>
                <ul class="mt-2 space-y-1.5">
                  <li v-for="line in detail.values" :key="line" class="text-sm leading-6 text-muted">{{ line }}</li>
                </ul>
              </div>
            </div>
          </section>
        </div>

        <!-- The decision, travelling with the reader: what it costs, when it
             next runs, and the one action. -->
        <div class="hidden lg:sticky lg:top-28 lg:block">
          <div class="space-y-5 rounded-xl border border-default bg-elevated p-6 shadow-sm">
            <div v-if="priceLabel">
              <p class="saya-display text-3xl tabular-nums text-default">
                <span v-if="compareAtLabel" class="mr-2 text-lg text-muted line-through">{{ compareAtLabel }}</span>{{ isStay ? t('stay.price_per_night', { price: priceLabel }) : enquiryOnly || (vertical === 'service' && sellableVariants.length === 1) ? priceLabel : t('saya.experience_detail.from_price', { price: priceLabel }) }}
              </p>
              <p v-if="!enquiryOnly && vertical !== 'service' && !isStay" class="mt-1 text-sm text-muted">{{ t('saya.experience_detail.per_person') }}</p>
            </div>
            <!-- The stay a guest has chosen so far, read back from the server's quote. -->
            <div v-if="isStay && canBook" class="overflow-hidden rounded-lg border border-default">
              <!-- Labels for the dialog's checkbox, like every booking control: they open it before hydration too. -->
              <label for="product-booking-toggle" role="button" tabindex="0" class="grid w-full cursor-pointer grid-cols-2 text-left" @click="stayBooking.openBooking(1)" @keydown.enter.prevent="pressLabel" @keydown.space.prevent="pressLabel">
                <span class="border-r border-default px-3 py-2">
                  <span class="block text-[10px] font-semibold uppercase tracking-[0.15em] text-default">{{ t('stay.check_in') }}</span>
                  <span class="block text-sm text-muted">{{ stayBooking.checkIn.value ? stayBooking.dateLabel(stayBooking.checkIn.value) : t('stay.add_dates') }}</span>
                </span>
                <span class="px-3 py-2">
                  <span class="block text-[10px] font-semibold uppercase tracking-[0.15em] text-default">{{ t('stay.check_out') }}</span>
                  <span class="block text-sm text-muted">{{ stayBooking.checkOut.value ? stayBooking.dateLabel(stayBooking.checkOut.value) : t('stay.add_dates') }}</span>
                </span>
              </label>
              <label for="product-booking-toggle" role="button" tabindex="0" class="block w-full cursor-pointer border-t border-default px-3 py-2 text-left" @click="stayBooking.openBooking(1)" @keydown.enter.prevent="pressLabel" @keydown.space.prevent="pressLabel">
                <span class="block text-[10px] font-semibold uppercase tracking-[0.15em] text-default">{{ t('stay.guests') }}</span>
                <span class="block text-sm text-muted">{{ stayBooking.guestsLabel.value }}</span>
              </label>
            </div>
            <dl v-if="isStay && stayBooking.quote.value" class="space-y-2 text-sm">
              <div v-for="line in stayBooking.breakdown.value" :key="line.label" class="flex justify-between gap-4">
                <dt class="text-muted">{{ line.label }}</dt>
                <dd class="tabular-nums">{{ line.amount }}</dd>
              </div>
              <div class="flex justify-between gap-4 border-t border-default pt-3 font-semibold">
                <dt>{{ t('stay.total') }}</dt>
                <dd class="tabular-nums">{{ stayBooking.money(stayBooking.quote.value.total_minor) }}</dd>
              </div>
            </dl>
            <div v-if="factChips.length" class="flex flex-wrap gap-2">
              <span
                v-for="fact in factChips"
                :key="fact.label"
                class="inline-flex items-center gap-1.5 rounded-full border border-default bg-default px-3 py-1 text-xs font-medium text-muted"
              >
                <SayaIcon :name="fact.icon" class="size-3.5" />
                {{ fact.label }}
              </span>
            </div>
            <p v-if="isStay && canBook" class="text-sm text-muted">{{ t('stay.charged_in_full') }}</p>
            <p v-if="vertical === 'service' && !isStay && !product.order_url" class="text-sm text-muted">{{ booking?.confirmation_mode === 'review' ? t('booking.review_notice') : t('booking.instant_notice') }}</p>
            <p v-if="nextSession" class="inline-flex items-center gap-2 text-sm text-muted">
              <SayaIcon name="calendar-days" class="size-4" />
              {{ sessionDayLabel(nextSession) }} · {{ sessionTimeLabel(nextSession) }}
            </p>
            <p v-if="!canBook && !canEnquire && !canOrderExternally" class="rounded-lg bg-default px-4 py-3 text-center text-sm font-semibold text-muted">
              {{ scopeRequired ? t('booking.choose_location') : vertical === 'service' && !offer ? t('booking.price_unavailable') : t('saya.common.temporarily_unavailable') }}
            </p>
            <div v-else class="pt-2">
              <SayaButton v-if="canOrderExternally" block :href="product.order_url!" target="_blank" rel="noopener noreferrer" @click="recordExternalOrderClick">{{ externalActionLabel }}</SayaButton>
              <SayaButton v-else-if="canEnquire" block :to="enquiryPath">
                {{ t('saya.experience_detail.enquire') }}
              </SayaButton>
              <SayaButton v-else block control-id="product-booking-toggle" @click="openBooking">
                {{ bookingLabel }}
              </SayaButton>
            </div>
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
            <p class="saya-kicker">{{ collectionName }}</p>
            <h1 class="saya-display saya-italic mt-3 text-3xl sm:text-4xl lg:text-5xl text-default leading-tight">{{ product.name }}</h1>
            <p class="mt-2 text-sm sm:text-base text-muted">{{ location?.title ?? organizationName }}</p>
            <ProductVariantPrices :product="product" :location-ids="[location?.id ?? null]" :currency="currency" class="mt-6 text-lg" />
            <div v-if="!offer && priceLabel" class="mt-6 flex items-baseline gap-3 text-2xl font-semibold tabular-nums">
              <span v-if="compareAtLabel" class="text-base font-normal text-muted line-through">{{ compareAtLabel }}</span>
              <span>{{ priceLabel }}</span>
            </div>
            <p v-if="product.description" class="mt-6 text-base sm:text-lg leading-relaxed text-muted">{{ product.description }}</p>
            <p v-if="!isAvailable" class="mt-6 font-semibold text-muted">{{ t('saya.common.temporarily_unavailable') }}</p>
            <div class="mt-8 flex flex-wrap items-center gap-5">
              <SayaButton v-if="canEnquire" :to="enquiryPath">{{ t('saya.experience_detail.enquire') }}</SayaButton>
              <SayaButton
                v-if="canOrderExternally"
                :href="product.order_url!"
                target="_blank"
                rel="noopener noreferrer"
                @click="recordExternalOrderClick"
              >{{ externalActionLabel }}</SayaButton>
              <NuxtLink
                :to="localePath(presentation.collectionPath)"
                class="border-b border-default pb-0.5 text-xs font-bold uppercase tracking-widest text-default no-underline transition hover:opacity-60"
              >
                {{ t('saya.hero.view_menu') }} →
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
        <h2 class="saya-display saya-italic text-3xl sm:text-4xl">{{ t('saya.product_detail.more_in_category', { category: collectionName }) }}</h2>
        <ul class="mt-6 grid gap-x-10 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <li v-for="sibling in collectionSiblings" :key="sibling.id">
            <NuxtLink
              :to="localePath(presentation.productPath(location?.slug ?? '', sibling.slug))"
              class="text-base text-default no-underline transition hover:opacity-60"
            >{{ sibling.name }}</NuxtLink>
          </li>
        </ul>
      </section>

      <!-- The bookable layout already shows every photograph in its gallery;
           this strip is the card layout's only place for them. -->
      <section v-if="!booking && !isStay && product.gallery.length" class="mt-16">
        <h2 class="saya-display saya-italic text-4xl">{{ t('saya.footer.gallery') }}</h2>
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
        <ProductBookingSteps :controller="bookingController" :confirmation-mode="booking.confirmation_mode" />
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
        <div class="flex flex-wrap items-baseline gap-3">
          <h2 class="saya-display saya-italic text-3xl sm:text-4xl">{{ t('saya.footer.reviews') }}</h2>
          <span v-if="averageRating" class="inline-flex items-center gap-1 text-sm text-muted">
            <SayaIcon name="star" solid class="size-4 text-default" />{{ averageRating }} · {{ reviewCountLabel }}
          </span>
        </div>
        <div class="mt-6 grid gap-6 sm:grid-cols-2">
          <SayaReviewCard v-for="review in reviews" :key="review.id" :review="review" />
        </div>
      </section>
    </article>
    <div v-if="booking" class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8"><WhoYouMeet :organization-id="organizationId" :organization-name="organizationName || location?.title || ''" :product-id="product.id" :slug="product.slug" :session-id="bookingController.selectedSession.value?.id" /></div>
    <slot name="content" :can-book="canBook" />
  </div>
</template>

<script setup lang="ts">
import WhoYouMeet from '~/components/booking/WhoYouMeet.vue'
import type { ProductPresentation, PublicProduct } from '~/server/types/products'
import { useSchemaOrg } from '#imports'
import { STAY_AMENITIES, STAY_CANCELLATION_POLICIES, STAY_LONG_TERM_CANCELLATION_POLICIES, STAY_PROPERTY_TYPES } from '~/shared/stay-listing'
import type { CurrencyCode } from '~/shared/currencies'
import { minorAmountToMajor, selectPrice, type Price } from '~/shared/prices'
import { formatProductMoney } from '~/utils/product-money'
import { ga4Major } from '~/utils/ga4-projection'
import { productLocationCollectionPath } from '~/utils/product-presentation'
import { extractDietarySchemaUrls, type ProductCollectionSibling } from '~/utils/product-seo'
import type { ProductDetailValue } from '~/shared/product-details'
import { EXPERIENCE_ATTRIBUTE_HANDLES, productDetailFields, productDetailKey, PRICING_NOTE_HANDLE } from '~/shared/product-details'
import type { PublicProductBooking, PublicProductLocation, PublicProductReview, PublicProductSession } from '~/server/utils/public-products'
import { formatPostalAddress, schemaPostalAddress } from '~/utils/postal-address'
import { formatTime } from '~/utils/timezone'
import SayaReviewCard from '~/components/saya/SayaReviewCard.vue'
import BookingModal from '~/components/booking/BookingModal.vue'
import ProductBookingSteps from '~/components/booking/ProductBookingSteps.vue'
import StayBookingSteps from '~/components/booking/StayBookingSteps.vue'
import { useStayBooking } from '~/composables/useStayBooking'
import BookingTimezoneSelect from '~/components/booking/BookingTimezoneSelect.vue'
import BookingScopeSelect from '~/components/booking/BookingScopeSelect.vue'
import { PUBLIC_BOOKING_WINDOW_DAYS } from '~/shared/bookings'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import { isRecord, publicApiRequest } from '~/utils/api-clients'
import MediaGallery from '~/components/MediaGallery.vue'
import ProductVariantPrices from '~/components/products/ProductVariantPrices.vue'

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
  compact?: boolean
  scopeRequired?: boolean
  locations?: PublicProductLocation[]
  onlineAvailable?: boolean
}>()

const displayTitle = computed(() => props.product.name)
/** A place to stay is booked by its nights, paid in full; its booking is not a session's. */
const isStay = computed(() => props.product.kind === 'stay')
const stayBooking = useStayBooking(() => ({ product: props.product }))
const bookingLabel = computed(() => isStay.value
  ? stayBooking.quote.value ? t('stay.reserve') : t('stay.check_availability')
  : props.vertical === 'service'
    ? props.booking?.confirmation_mode === 'review' ? t('booking.request_appointment') : t('booking.book_appointment')
    : t('saya.experience_detail.book_now'))

const { trackProductOrder, trackProductView } = useOrganizationConversionTracking()
const { localePath, t, locale } = useI18n()
const collectionLabel = computed(() => {
  if (props.vertical === 'service' && (props.pageDocument || !props.location)) return t('blawby.footer.services')
  if (props.presentation.locationCollectionSegment === 'menu') return t('saya.footer.menu')
  if (props.presentation.locationCollectionSegment === 'stays') return t('saya.footer.stays')
  return props.presentation.locationCollectionSegment === 'experiences'
    ? t('saya.footer.experiences')
    : t('saya.footer.products')
})
const breadcrumbs = computed(() => [
  { to: localePath('/'), label: t('saya.experience_detail.home') },
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
const externalActionLabel = computed(() => props.product.kind === 'experience' || props.product.kind === 'service' || props.product.kind === 'stay' ? t('saya.experience_detail.book_now') : t('saya.cta.order_now'))
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
const galleryItems = computed(() => [
  ...(props.product.image ? [props.product.image] : []),
  ...props.product.gallery,
  ...(props.pageDocument?.media.filter(asset => asset.slot === 'cover' || asset.slot === 'gallery') ?? []),
].filter((asset, index, assets) => asset.public_url && assets.findIndex(item => item.public_url === asset.public_url) === index).map(asset => ({
  url: asset.public_url!,
  kind: asset.kind,
  poster: asset.kind === 'video' ? asset.thumbnail_url : undefined,
  alt: asset.alt_text ?? undefined,
})))

/**
 * The two facts a guest decides on before opening the form: how long it runs
 * and how many it takes. Both come from the product's booking configuration,
 * which is also what its sessions are generated from, so the page and the
 * calendar cannot disagree.
 */
const factChips = computed(() => {
  const chips: Array<{ icon: 'clock' | 'user-group' | 'video-camera' | 'check-circle' | 'moon' | 'home'; label: string }> = []
  const stay = props.product.stay
  if (stay) {
    if (stay.property_type) chips.push({ icon: 'home', label: STAY_PROPERTY_TYPES[stay.property_type].label })
    chips.push({ icon: 'user-group', label: t('stay.sleeps', { count: stay.max_guests }) })
    if (stay.bedrooms !== null) chips.push({ icon: 'home', label: t('stay.bedrooms', { count: stay.bedrooms }) })
    if (stay.beds !== null) chips.push({ icon: 'home', label: t('stay.beds', { count: stay.beds }) })
    if (stay.bathrooms !== null) chips.push({ icon: 'home', label: t('stay.bathrooms', { count: stay.bathrooms }) })
    chips.push({ icon: 'clock', label: t('stay.check_in_after', { time: formatTime(stay.check_in_time, locale.value) }) })
    chips.push({ icon: 'clock', label: t('stay.check_out_before', { time: formatTime(stay.check_out_time, locale.value) }) })
    if (stay.min_nights > 1) chips.push({ icon: 'moon', label: t('stay.min_nights', { count: stay.min_nights }) })
    return chips
  }
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
        ? t('saya.experience_detail.minutes', { count: minutes })
        : rest
          ? t('saya.experience_detail.hours_minutes', { hours, minutes: rest })
          : t('saya.experience_detail.hours', { count: hours }),
    })
  }
  if (config.default_capacity && props.vertical !== 'service') {
    chips.push({ icon: 'user-group', label: t('saya.experience_detail.capacity', { count: config.default_capacity }) })
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
  if (handle === PRICING_NOTE_HANDLE || definition.value_type === 'boolean') return []
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
    ...(stay.amenities.length ? [{ key: 'amenities', label: 'Amenities', values: stay.amenities.map(code => STAY_AMENITIES[code].label) }] : []),
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
  upcomingSessions, nextSession, sessionDayLabel, sessionTimeLabel, bookingError, allowTimezoneSelection, bookingTimezone, timezoneOptions, guestTimezone } = bookingController

function openBooking() {
  if (isStay.value) stayBooking.openBooking()
  else openSessionBooking()
}
/** A label pressed from the keyboard activates the checkbox it names, as a click does. */
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
const reviewCountLabel = computed(() => (props.reviews.length === 1
  ? t('saya.experience_detail.review_count_one')
  : t('saya.experience_detail.review_count', { count: props.reviews.length })))

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
const meetingPoint = computed(() => attribute(EXPERIENCE_ATTRIBUTE_HANDLES.meetingPoint, asText))
const includedItems = computed(() => attribute(EXPERIENCE_ATTRIBUTE_HANDLES.includedItems, asList) ?? [])
const whatToBring = computed(() => attribute(EXPERIENCE_ATTRIBUTE_HANDLES.whatToBring, asList) ?? [])
const PLACED_ATTRIBUTE_HANDLES = new Set<string>(Object.values(EXPERIENCE_ATTRIBUTE_HANDLES))
const thingsToKnow = computed(() => visibleDetails.value.filter((detail) => {
  const definition = productDetailFields(props.product.kind).find(entry => entry.id === detail.key)
  return !definition || !PLACED_ATTRIBUTE_HANDLES.has(productDetailKey(definition))
}))

const addressLine = computed(() => formatPostalAddress(props.location?.address ?? null))
// A map from the coordinates the branch already has; no key, no second source.
const mapEmbedUrl = computed(() => (props.location && props.location.latitude !== null && props.location.longitude !== null
  ? `https://www.google.com/maps?q=${props.location.latitude},${props.location.longitude}&output=embed`
  : null))


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
 * are an EventSeries, with each occurrence carried as a subEvent.
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

/** One occurrence, as its own dated Event under the series. */
function sessionEvent(session: PublicProductSession) {
  return {
    '@type': 'Event',
    name: props.product.name,
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
    ...(stay.bedrooms !== null ? { numberOfBedrooms: stay.bedrooms } : {}),
    ...(stay.bathrooms !== null ? { numberOfBathroomsTotal: stay.bathrooms } : {}),
    ...(stay.beds !== null ? { bed: { '@type': 'BedDetails', numberOfBeds: stay.beds } } : {}),
    ...(stay.amenities.length ? { amenityFeature: stay.amenities.map(code => ({ '@type': 'LocationFeatureSpecification', name: STAY_AMENITIES[code].label, value: true })) } : {}),
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'checkinTime', value: stay.check_in_time },
      { '@type': 'PropertyValue', name: 'checkoutTime', value: stay.check_out_time },
      { '@type': 'PropertyValue', name: 'minimumNights', value: stay.min_nights },
    ],
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
  if (props.pageDocument || props.compact) return []
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
  return {
    '@type': type,
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
          // One offer per occurrence, so the markup says when each seat is for.
          offers: list.map(sessionOffer),
          ...(type === 'EventSeries' ? { subEvent: list.map(sessionEvent) } : {}),
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
}))
</script>
