<template>
  <DashboardIndexPanel :id="stay ? 'stay-details' : personalScope ? 'account-booking-details' : 'booking-details'" :title="pageTitle" column="record">
    <template #right>
      <UButton v-if="closeTo" :to="closeTo" icon="i-lucide-x" color="neutral" variant="soft" :aria-label="stay ? 'Close stay details' : 'Close booking details'" />
    </template>
    <UAlert v-if="error" color="error" variant="soft" title="Booking details could not be loaded" :description="getErrorMessage(error, 'Booking request failed')" />
    <div v-else class="min-w-0 [overflow-wrap:anywhere]">
      <UAlert v-if="actionError" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError" />
      <template v-if="booking || stay">
        <UButton v-if="changeRetry" class="mb-5" label="Retry update" color="neutral" variant="outline" :disabled="busy !== null" @click="answerStayChange(changeRetry.messageId, changeRetry.decision)" />
        <section v-for="change in pendingChanges" :key="change.id" class="mb-5 rounded-2xl border border-default bg-elevated p-5" :aria-labelledby="`change-title-${change.id}`" data-testid="booking-change-request">
          <h3 :id="`change-title-${change.id}`" class="font-semibold text-highlighted">{{ t('booking.change_review') }}</h3>
          <p v-if="change.requested_by === 'guest'" class="mt-1 text-sm text-muted">{{ t('booking.change_requested_by_guest', { guest: detail?.guest_name, channel: 'Airbnb' }) }}</p>
          <div class="mt-4 grid grid-cols-2 gap-4 text-sm">
            <div v-for="{ label, terms } in [{ label: 'booking.change_before', terms: change.before }, { label: 'booking.change_proposed', terms: change.after }]" :key="label">
              <h4 class="font-medium text-highlighted">{{ t(label) }}</h4>
              <dl class="mt-2 space-y-2">
                <div><dt class="sr-only">Dates</dt><dd>{{ terms.dates }}</dd></div>
                <div><dt class="text-muted">{{ t('stay.guests') }}</dt><dd>{{ terms.guests }}</dd></div>
                <div><dt class="text-muted">{{ t('booking.change_total') }}</dt><dd>{{ terms.total }}</dd></div>
              </dl>
            </div>
          </div>
          <p class="mt-4 text-sm text-muted">{{ t(change.requested_by === 'guest' ? 'booking.change_guest_waiting' : 'booking.change_host_waiting', { channel: 'Airbnb' }) }}</p>
          <div v-if="change.requested_by === 'guest'" class="mt-4 flex flex-wrap gap-3">
            <UButton :label="t('booking.change_accept')" :loading="busy === `accept-${change.id}`" :disabled="busy !== null" @click="answerStayChange(change.id, 'accept')" />
            <UButton :label="t('booking.change_decline')" color="neutral" variant="outline" :loading="busy === `decline-${change.id}`" :disabled="busy !== null" @click="answerStayChange(change.id, 'decline')" />
          </div>
        </section>
        <!-- A channel stay overlapping another is the host's to resolve; it never resolves itself. -->
        <UAlert
          v-if="detail?.overbooked"
          class="mb-5"
          color="error"
          icon="i-lucide-triangle-alert"
          title="Overbooked"
          :description="`${channelName} confirmed this stay on nights another stay holds. Cancel this stay on ${channelName}, or cancel the other stay where it was booked.`"
        />
        <UAlert v-if="!personalScope && guest.state === 'missing'" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" title="Guest name missing" description="This reservation requires a guest name." />
        <p v-if="changeResult" class="mb-4 text-sm text-highlighted" role="status">{{ changeResult }}</p>
        <UAlert
          v-if="booking?.pending_change"
          class="mb-5"
          data-testid="booking-change-request"
          color="info"
          variant="soft"
          icon="i-lucide-clock"
          :title="personalScope ? `${booking.organization_name} requested a change` : 'Change requested'"
          :actions="personalScope ? [
            { label: 'Accept', color: 'neutral' as const, loading: answering === 'accept', disabled: answering !== null, onClick: () => answerChange('accept') },
            { label: 'Decline', color: 'neutral' as const, variant: 'soft' as const, loading: answering === 'decline', disabled: answering !== null, onClick: () => answerChange('decline') },
          ] : undefined"
        >
          <template #description>
            <div class="mt-2 grid grid-cols-2 gap-4">
              <div v-for="{ label, terms } in [{ label: 'booking.change_before', terms: booking.pending_change.before }, { label: 'booking.change_proposed', terms: booking.pending_change.after }]" :key="label">
                <p class="font-medium text-highlighted">{{ t(label) }}</p>
                <p>{{ terms.when_label }}</p>
                <p>{{ terms.location_title }}</p>
                <p>{{ terms.party_size }} {{ terms.party_size === 1 ? recordCopy?.guestLabel : recordCopy?.guestsLabelPlural }}</p>
                <p>{{ terms.assigned_member_name ?? t('booking.change_unassigned') }}</p>
              </div>
            </div>
            <p class="mt-2">{{ personalScope ? 'Your booking stays unchanged until you accept.' : `Waiting for ${firstName(booking.guest_name ?? '')} to respond` }}</p>
          </template>
        </UAlert>

        <section v-if="panel" data-testid="reservation-panel">
          <UCarousel
            v-if="panel.photos.length"
            v-slot="{ item }"
            :items="panel.photos"
            :arrows="panel.photos.length > 1"
            :dots="panel.photos.length > 1"
            :prev="photoArrow"
            :next="photoArrow"
            :ui="{ viewport: 'rounded-2xl', container: 'ms-0', item: 'ps-0', prev: 'start-4 sm:start-4', next: 'end-4 sm:end-4', dots: 'bottom-3 gap-1.5', dot: 'size-1.5 bg-white/55 data-[state=active]:bg-white' }"
            aria-label="Listing photos"
            class="mb-6"
          >
            <img :src="item" :alt="panel.title ?? ''" class="aspect-[4/3] w-full bg-elevated object-cover">
          </UCarousel>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 class="text-[22px] font-semibold leading-7 tracking-tight text-highlighted">{{ panel.title }}</h2>
            <UBadge v-if="statusLabel" :color="(stay?.status ?? booking?.status) === 'pending' ? 'warning' : 'neutral'" variant="soft" :label="statusLabel" />
          </div>
          <p v-if="panel.host" class="text-xs text-muted">Hosted by {{ panel.host.name }}</p>
          <p v-if="panel.purchaseDate" class="text-xs text-muted">{{ panel.purchaseDate }}</p>
          <div v-if="recordGuestName" class="mt-4 flex items-center">
            <span class="relative">
              <UAvatar :src="recordGuestImage || undefined" :alt="recordGuestName" :text="recordGuestName.slice(0, 1).toUpperCase()" size="lg" class="bg-accented ring-2 ring-default" :ui="{ fallback: 'font-semibold text-highlighted' }" />
              <ChannelMark v-if="detail" :channel="detail.channel" class="absolute -bottom-1 -right-1 border-2 border-(--ui-bg)" />
            </span>
            <span v-if="partySize > 1" class="-ms-2 flex size-8 items-center justify-center rounded-full bg-accented text-xs font-bold text-highlighted ring-2 ring-default" :aria-label="otherGuestLabel">+{{ partySize - 1 }}</span>
            <UButton v-if="guestManagement?.available.value" type="button" :aria-label="manageGuestsLabel" icon="i-lucide-pencil" color="neutral" variant="outline" size="sm" class="ms-1 size-8 justify-center rounded-full" @click="manageBookingParty" />
          </div>
          <div v-if="manage && hostActions.includes('confirm')" class="mt-5 flex flex-wrap gap-3">
            <UButton color="neutral" size="lg" :label="t('stay.approve_request')" :loading="busy === 'confirm'" :disabled="busy !== null" @click="decide('confirm')" />
            <UButton color="neutral" variant="outline" size="lg" :label="t('stay.decline_request')" :loading="busy === 'reject'" :disabled="busy !== null" @click="decide('reject')" />
          </div>
          <UButton v-if="personalScope && detail?.request_status === 'awaiting_payment' && (paymentProcessing || (detail.pay_by && Date.parse(detail.pay_by) > Date.now()))"
            class="mt-5" color="neutral" size="lg" :label="t(paymentProcessing ? 'payment.view_payment' : 'payment.continue_to_pay')" :loading="busy === 'pay'" @click="payForStay" />

          <dl v-if="panel.when.length" class="mt-5 grid grid-cols-2 divide-x divide-default rounded-xl bg-accented/40 p-4">
            <div v-for="entry in panel.when" :key="entry.label" class="min-w-0 first:pe-4 last:ps-4 last:text-right">
              <dt class="text-sm font-semibold text-highlighted">{{ entry.label }}</dt>
              <dd class="mt-0.5 text-xs text-highlighted">{{ entry.value }}</dd>
              <dd v-if="entry.detail" class="mt-0.5 text-xs text-muted">{{ entry.detail }}</dd>
            </div>
          </dl>
          <p v-if="arrivalTime" class="mt-3 text-xs text-muted">Arriving {{ arrivalTime }}</p>

          <div v-if="panel.rows.length" class="mt-3">
            <component :is="row.to ? NuxtLink : row.href ? 'a' : 'button'" v-for="row in panel.rows" :key="row.label" :to="row.to" :href="row.href" :type="row.run ? 'button' : undefined" class="flex w-full items-start gap-4 py-3 text-left" @click="row.run?.()">
              <UIcon :name="row.icon" class="mt-0.5 size-5 shrink-0 text-highlighted" />
              <span class="min-w-0 flex-1"><span class="block text-sm font-medium text-highlighted">{{ row.label }}</span><span v-if="row.detail" class="block truncate text-xs text-muted">{{ row.detail }}</span></span>
            </component>
          </div>

          <div v-if="!purchase || recordGuestName" :class="sectionClass">
            <h2 class="text-lg font-semibold text-highlighted">{{ purchase ? 'Buyer' : 'Reservation details' }}</h2>
            <template v-if="panel.guests">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">Who’s coming</h3>
              <component :is="guestDetailLink ? NuxtLink : 'p'" :to="guestDetailLink" class="mt-1 flex justify-between gap-3 text-sm text-muted">
                <span>{{ panel.guests }}</span>
                <UIcon v-if="guestDetailLink" name="i-lucide-chevron-right" class="size-4 shrink-0" />
              </component>
            </template>
            <p v-else-if="purchase && recordGuestName" class="mt-1 text-sm text-muted">{{ recordGuestName }}</p>
            <div v-if="!personalScope && panel.contact.length" class="mt-2">
              <NuxtLink v-for="action in panel.contact" :key="action.label" :to="action.to" :class="rowClass" :data-testid="action.testid">
                <UIcon :name="action.icon" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">{{ action.label }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
              </NuxtLink>
            </div>
            <template v-if="panel.code">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">Confirmation code</h3>
              <p class="mt-1 text-sm text-muted" :data-testid="stay ? 'stay-confirmation-code' : 'booking-confirmation-code'">{{ panel.code }}</p>
            </template>
            <template v-if="panel.policy">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">Cancellation policy</h3>
              <p class="mt-1 text-sm text-muted">{{ panel.policy }}</p>
              <button v-if="policy?.terms.length || booking?.policy" type="button" class="mt-1 cursor-pointer text-sm font-medium text-highlighted underline" @click="policyOpen = true">Read more</button>
            </template>
            <template v-if="detail?.cancellation_reason">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">Cancellation reason</h3>
              <p class="mt-1 whitespace-pre-wrap text-sm text-muted">{{ detail.cancellation_reason }}</p>
            </template>
            <template v-if="!personalScope && !purchase">
              <NuxtLink v-if="note" :to="{ path: `${editorPath}/private-note`, query: route.query }" :class="rowClass" class="mt-3">
                <UIcon name="i-lucide-sticky-note" class="size-4 shrink-0" />
                <span class="min-w-0 flex-1"><span class="block font-medium">Private note</span><span v-if="note.text" class="block truncate text-xs text-muted">{{ note.text }}</span></span>
                <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
              </NuxtLink>
            </template>
            <template v-if="booking?.notes">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">{{ personalScope ? 'Your requests' : 'Requests' }}</h3>
              <p class="mt-1 whitespace-pre-wrap text-sm text-muted">{{ booking.notes }}</p>
            </template>
            <FormAnswersCard :answers="booking?.answers ?? detail?.answers ?? []" :title="personalScope ? 'Your answers' : undefined" />
            <div v-if="!personalScope && reviewStateLabel" class="mt-5" data-testid="booking-review-state">
              <h3 class="text-sm font-semibold text-highlighted">Review invitation</h3>
              <p class="mt-1 text-sm text-muted">{{ reviewStateLabel }}</p>
            </div>
            <div v-if="panel.actions.length" class="mt-3">
              <component :is="action.to ? NuxtLink : 'button'" v-for="action in panel.actions" :key="action.label" :to="action.to" :type="action.to ? undefined : 'button'" :class="rowClass" :disabled="action.to ? undefined : busy !== null" :data-testid="action.testid" @click="('run' in action) && action.run()">
                <UIcon :name="action.icon" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">{{ action.label }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
              </component>
            </div>
            <p v-if="channelManaged && detail" class="mt-4 text-sm text-muted">
              Payments, changes and cancellations for this stay are managed on
              <ULink v-if="detail.channel_booking_url" :to="detail.channel_booking_url" target="_blank" rel="noopener noreferrer" class="text-highlighted underline">{{ channelName }}</ULink><template v-else>{{ channelName }}</template>.
            </p>
          </div>

          <div v-if="showAgreementRow || showDepositRow" id="booking-agreement-section" :class="sectionClass">
            <h2 class="text-lg font-semibold text-highlighted">{{ showAgreementRow ? agreementLabelText : depositRead?.label }}</h2>
            <div class="mt-3">
              <component
                :is="personalScope ? 'button' : NuxtLink"
                v-if="showAgreementRow"
                :to="personalScope ? undefined : { path: `${editorPath}/agreement`, query: route.query }"
                type="button"
                :class="rowClass"
                data-testid="booking-agreement-row"
                @click="personalScope && (guestAgreementOpen = true)"
              >
                <UIcon name="i-lucide-file-text" class="size-4 shrink-0 text-highlighted" />
                <span class="min-w-0 flex-1">
                  <span class="block font-medium">{{ agreementLabelText }}</span>
                  <span v-if="agreementRowSummary" class="block text-xs text-muted" data-testid="booking-agreement-status">{{ agreementRowSummary }}</span>
                </span>
                <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
              </component>
            </div>
            <component
              :is="personalScope ? 'div' : NuxtLink"
              v-if="showDepositRow && depositRead"
              :to="personalScope ? undefined : { path: `${editorPath}/deposit`, query: route.query }"
              :class="rowClass"
              data-testid="booking-deposit-row"
            >
              <UIcon name="i-lucide-shield-check" class="size-4 shrink-0 text-highlighted" />
              <span class="min-w-0 flex-1">
                <span class="block font-medium">{{ depositRead.label }}</span>
                <span class="block text-xs text-muted" data-testid="booking-deposit-status">{{ depositSummary }}</span>
              </span>
              <UIcon v-if="!personalScope" name="i-lucide-chevron-right" class="size-4 text-muted" />
            </component>
            <DashboardListItemDialog v-if="personalScope && guestAgreementOpen && conversationId && agreementRead" v-model:open="guestAgreementOpen" :title="agreementLabelText ?? ''" :show-actions="false">
              <BookingAgreement
                :conversation-id="conversationId"
                :preloaded="{ agreement: agreementRead.agreement, canManage: false }"
                @open-signing="(value) => {
                  guestAgreementOpen = false
                  signingAgreement = value
                  signingOpen = true
                }"
              />
            </DashboardListItemDialog>
            <AgreementSignSheet
              v-if="signingAgreement && conversationId"
              v-model:open="signingOpen"
              :conversation-id="conversationId"
              :agreement="signingAgreement"
              @signed="refreshDetails()"
            />
          </div>
          <div v-if="panel.location || panel.address || panel.pin || panel.guide?.directions" id="getting-there" :class="sectionClass">
            <h2 class="text-lg font-semibold text-highlighted">Getting there</h2>
            <StaySetupMap v-if="panel.pin" :key="`${panel.pin.latitude},${panel.pin.longitude}`" :pin="panel.pin" :marker-icon="stay ? 'i-lucide-house' : 'i-lucide-map-pin'" :interactive="false" compact class="mt-4" />
            <p v-if="panel.location" class="mt-4 text-sm font-medium text-highlighted">{{ panel.location }}</p>
            <p v-if="panel.address" :class="panel.location ? 'mt-1' : 'mt-4'" class="text-sm text-muted">{{ panel.address }}</p>
            <template v-if="panel.guide?.directions">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">Directions from your host</h3>
              <p ref="directionsPreview" class="mt-1 line-clamp-6 whitespace-pre-wrap text-sm text-muted">{{ panel.guide.directions }}</p>
              <button v-if="directionsClipped" type="button" class="mt-1 text-sm font-medium text-highlighted underline" @click="guideSection = 'directions'">Read more</button>
            </template>
            <div v-if="panel.address || panel.mapsUrl" class="mt-3">
              <button v-if="panel.address" type="button" :class="rowClass" @click="copyAddress(panel.address)">
                <UIcon name="i-lucide-copy" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">Copy address</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
              </button>
              <a v-if="panel.mapsUrl" :href="panel.mapsUrl" target="_blank" rel="noopener noreferrer" :class="rowClass">
                <UIcon name="i-lucide-map-pin" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">Get directions</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
              </a>
            </div>
          </div>

          <div v-if="panel.guide && (panel.guide.method || panel.guide.instructions || panel.guide.wifi)" id="checking-in" :class="sectionClass">
            <h2 class="text-lg font-semibold text-highlighted">Checking in</h2>
            <template v-if="panel.guide.method">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">Check-in method</h3>
              <p class="mt-1 text-sm text-muted">{{ panel.guide.method }}</p>
            </template>
            <button v-if="panel.guide.instructions || panel.guide.wifi" type="button" :class="rowClass" class="mt-3" @click="guideSection = 'check-in'">
              <UIcon name="i-lucide-key-round" class="size-4 shrink-0" /><span class="min-w-0 flex-1">How to get inside</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
            </button>
          </div>

          <div v-if="panel.guide && (panel.guide.manual || panel.guide.rules.length || panel.guide.safety.length || panel.listingUrl)" id="rules-and-instructions" :class="sectionClass">
            <h2 class="text-lg font-semibold text-highlighted">Rules and instructions</h2>
            <template v-if="panel.guide.manual">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">House manual</h3>
              <p ref="manualPreview" class="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-muted">{{ panel.guide.manual }}</p>
              <button v-if="manualClipped" type="button" class="mt-1 text-sm font-medium text-highlighted underline" @click="guideSection = 'manual'">Show more</button>
            </template>
            <template v-if="panel.guide.rules.length">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">House rules</h3>
              <p ref="rulesPreview" class="mt-1 line-clamp-3 whitespace-pre-line text-sm text-muted">{{ panel.guide.rules.join('\n') }}</p>
              <button v-if="rulesClipped" type="button" class="mt-1 text-sm font-medium text-highlighted underline" @click="guideSection = 'rules'">Show more</button>
            </template>
            <template v-if="panel.guide.safety.length">
              <h3 class="mt-5 text-sm font-semibold text-highlighted">Safety and property</h3>
              <ul class="mt-1 space-y-1 text-sm text-muted"><li v-for="line in panel.guide.safety" :key="line">{{ line }}</li></ul>
            </template>
            <a v-if="panel.listingUrl" :href="panel.listingUrl" target="_blank" rel="noopener noreferrer" :class="rowClass" class="mt-3">
              <UIcon name="i-lucide-store" class="size-4 shrink-0" /><span class="min-w-0 flex-1">Show listing</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
            </a>
          </div>

          <div v-if="panel.host || panel.coHosts.length || (personalScope && panel.contact.length)" :class="sectionClass">
            <div v-if="panel.host" class="flex items-center gap-4">
              <h2 class="min-w-0 flex-1 text-lg font-semibold text-highlighted">Hosted by {{ panel.host.name }}</h2>
              <UAvatar :src="panel.host.photo_url ?? undefined" :alt="panel.host.name" size="xl" class="bg-accented" />
            </div>
            <div v-if="panel.host?.bio" class="mt-4">
              <h3 class="text-sm font-semibold text-highlighted">About your host</h3>
              <p ref="hostPreview" class="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted">{{ panel.host.bio }}</p>
              <button v-if="hostClipped" type="button" class="mt-1 text-sm font-medium text-highlighted underline" @click="showProfile('About your host', panel.host?.bio)">Show more</button>
            </div>
            <div v-for="(coHost, index) in panel.coHosts" :key="index" class="mt-5 flex items-center gap-4">
              <div class="min-w-0 flex-1">
                <h3 class="text-sm font-semibold text-highlighted">Co-host</h3>
                <button v-if="coHost.bio" type="button" class="mt-1 text-sm text-highlighted underline" @click="showProfile(coHost.name, coHost.bio)">{{ coHost.name }}</button>
                <p v-else class="mt-1 text-sm text-muted">{{ coHost.name }}</p>
              </div>
              <UAvatar :src="coHost.photo_url ?? undefined" :alt="coHost.name" size="xl" class="bg-accented" />
            </div>
            <div v-if="personalScope && panel.contact.length" class="mt-3">
              <NuxtLink v-for="action in panel.contact" :key="action.label" :to="action.to" :class="rowClass" :data-testid="action.testid">
                <UIcon :name="action.icon" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">{{ action.label }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
              </NuxtLink>
            </div>
          </div>

          <div v-if="detail || (booking?.type === 'booking' && booking.payments !== null) || booking?.payments?.length" :class="sectionClass">
            <h2 class="text-lg font-semibold text-highlighted">Payment info</h2>
            <template v-if="detail">
              <!-- Airbnb's payment rows: the label on the left, the amount on the right, both in the body colour. A channel's guest pays the channel, so its total is the booking's. -->
              <p class="mt-5 flex items-baseline justify-between gap-4 text-base font-semibold text-highlighted">
                <span>{{ channelManaged ? 'Total' : 'Amount paid' }}</span>
                <span data-testid="stay-amount-paid">{{ money(channelManaged ? detail.total_minor : detail.paid_minor) }}</span>
              </p>
              <p v-if="channelManaged" class="mt-1 text-sm text-muted">Payments, changes and cancellations are managed on {{ channelName }}.</p>
              <template v-if="!personalScope">
                <ul v-if="!channelManaged && detail.payments.length" class="mt-4 space-y-3">
                  <li v-for="payment in detail.payments" :key="payment.id" class="flex items-center gap-4">
                    <span class="min-w-0 flex-1">
                      <span class="block text-sm text-highlighted">{{ money(payment.amount_minor) }} · {{ methodLabel(payment.method) }}</span>
                      <span class="block text-xs text-muted">{{ formatCalendarDate(payment.paid_on, 'en') }}{{ payment.reference ? ` · ${payment.reference}` : '' }}</span>
                    </span>
                    <UButton v-if="manage" icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Delete payment of ${money(payment.amount_minor)}`" :loading="busy === payment.id" @click="deletePayment(payment.id)" />
                  </li>
                </ul>
                <!-- Each Stripe payment: the checkout, then each month of a stay paid monthly. -->
                <div v-for="online in detail.online_payments" :key="online.payment_id" class="mt-2" data-testid="stay-online-payment">
                  <NuxtLink :to="paymentPath(online.payment_id)" :class="rowClass">
                    <UIcon name="i-lucide-receipt-text" class="size-4 shrink-0 text-highlighted" />
                    <span class="min-w-0 flex-1">{{ money(online.captured_minor - online.refunded_minor) }} · Paid online <span class="block text-xs text-muted">{{ formatCreatedAt(online.created_at) }}</span></span>
                    <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
                  </NuxtLink>
                  <NuxtLink v-if="manage && online.captured_minor > online.refunded_minor" :to="{ path: `${paymentPath(online.payment_id)}/refund`, query: { payment: online.payment_id } }" :class="rowClass">
                    <UIcon name="i-lucide-undo-2" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">Send a refund</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
                  </NuxtLink>
                </div>
                <NuxtLink v-if="manage && !channelManaged && !requestStatus" :to="{ path: `${editorPath}/payment`, query: route.query }" :class="rowClass" class="mt-2" data-testid="stay-record-payment">
                  <UIcon name="i-lucide-receipt-text" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">Record a payment</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
                </NuxtLink>
              </template>
              <template v-else>
                <a v-for="online in detail.online_payments.filter(entry => entry.receipt_url)" :key="online.payment_id" :href="online.receipt_url!" target="_blank" rel="noopener noreferrer" :class="rowClass" class="mt-2">
                  <UIcon name="i-lucide-receipt-text" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">Receipt · {{ formatCreatedAt(online.created_at) }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
                </a>
              </template>
            </template>
            <p v-else-if="booking?.payments?.length === 0" class="mt-4 text-sm text-muted">No payments recorded.</p>
            <PaymentDetails v-for="entry in booking?.payments" :key="entry.payment.id" :payment="entry.payment" :refunds="entry.refunds">
              <template v-if="!personalScope && entry.payment.captured_amount > entry.payment.refunded_amount" #actions>
                <NuxtLink :to="{ path: `${editorPath}/refund`, query: { ...route.query, payment: entry.payment.id } }" :class="rowClass">
                  <UIcon name="i-lucide-undo-2" class="size-4 shrink-0 text-highlighted" /><span class="min-w-0 flex-1">Send a refund</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
                </NuxtLink>
              </template>
            </PaymentDetails>
          </div>
          <div v-if="!purchase" id="reservation-support" :class="sectionClass">
            <h2 class="text-lg font-semibold text-highlighted">Get support anytime</h2>
            <NuxtLink to="/help" :class="rowClass" class="mt-3">
              <UIcon name="i-lucide-circle-help" class="size-4 shrink-0" /><span class="min-w-0 flex-1">Visit the Help Center</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
            </NuxtLink>
          </div>
        </section>
      </template>
    </div>
  </DashboardIndexPanel>

  <ReservationItinerary
    v-if="itinerary && panel?.code"
    v-model:open="itineraryOpen"
    :itinerary="itinerary"
    :confirmation-code="panel.code"
  />

  <DashboardListItemDialog v-if="panel?.guide" v-model:open="guideOpen" :title="guideSection ? guideLabels[guideSection] : ''" :show-actions="false">
    <p v-if="guideSection === 'directions'" class="whitespace-pre-wrap text-sm text-muted">{{ panel.guide.directions }}</p>
    <p v-else-if="guideSection === 'manual'" class="whitespace-pre-wrap text-sm text-muted">{{ panel.guide.manual }}</p>
    <ul v-else-if="guideSection === 'rules'" class="space-y-2 text-sm text-muted">
      <li v-for="rule in panel.guide.rules" :key="rule">{{ rule }}</li>
    </ul>
    <div v-else-if="guideSection === 'check-in'" class="space-y-4 text-sm">
      <p v-if="panel.guide.instructions" class="whitespace-pre-wrap text-muted">{{ panel.guide.instructions }}</p>
      <div v-if="panel.guide.wifi">
        <h3 class="mb-1 font-semibold">Wi-Fi</h3>
        <p v-if="panel.guide.wifi.network" class="text-muted">{{ panel.guide.wifi.network }}</p>
        <p v-if="panel.guide.wifi.password" class="text-muted">{{ panel.guide.wifi.password }}</p>
      </div>
    </div>
    <template v-else-if="guideSection === 'checkout'">
      <ul class="space-y-3">
        <li v-for="instruction in panel.guide.checkout" :key="instruction.task" class="flex gap-4">
          <UIcon :name="STAY_CHECKOUT_TASKS[instruction.task].icon" class="mt-0.5 size-4 shrink-0 text-highlighted" />
          <span><span class="block text-sm text-highlighted">{{ STAY_CHECKOUT_TASKS[instruction.task].label }}</span><span v-if="instruction.details" class="block whitespace-pre-wrap text-xs text-muted">{{ instruction.details }}</span></span>
        </li>
      </ul>
      <UButton v-if="panel.guide.checkoutEditor" :to="panel.guide.checkoutEditor" label="Edit" color="neutral" variant="outline" class="mt-5" />
    </template>
  </DashboardListItemDialog>

  <DashboardListItemDialog v-model:open="profileOpen" :title="profile?.title ?? ''" :show-actions="false">
    <p class="whitespace-pre-wrap break-words text-sm text-muted">{{ profile?.bio }}</p>
  </DashboardListItemDialog>

  <DashboardListItemDialog v-model:open="policyOpen" :title="booking?.policy?.heading || 'Cancellation policy'" :show-actions="false">
    <ul v-if="policy" class="space-y-3 text-sm text-muted">
      <li v-for="term in policy.terms" :key="term">{{ term }}</li>
    </ul>
    <ul v-else-if="booking?.policy" class="space-y-3">
      <li v-for="item in booking.policy.items" :key="item.id" class="flex gap-3">
        <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-success" />
        <p class="text-sm text-muted">{{ item.text }}</p>
      </li>
    </ul>
  </DashboardListItemDialog>
  <!--
    Cancelling gets a screen that states the consequence and lets the tenant say
    why, rather than a native confirm() stacked on top of the sheet that opened
    it. The note travels with the notification the guest receives.
  -->
  <DashboardListItemDialog
    v-model:open="cancelOpen"
    :title="`Cancel ${noun}`"
    :show-actions="false"
    :error="actionError"
  >
    <div v-if="booking" class="space-y-5">
      <p class="text-sm leading-relaxed text-muted">{{ cancellationSummary }}</p>
      <UFormField v-if="!personalScope" :label="`Add a note for ${firstName(booking.guest_name ?? '')}`" hint="Optional">
        <UTextarea v-model="cancelNote" :rows="4" maxlength="500" class="w-full" placeholder="Let them know why, and what happens next." />
      </UFormField>
      <p v-if="personalScope" class="text-sm text-muted">
        {{ booking.organization_name }} is told the {{ noun }} was cancelled.
        <template v-if="refundable && booking.guest_cancel_refunds">Your payment is refunded in full.</template>
        <template v-else-if="refundable">Free cancellation has closed, so your payment won’t be refunded.</template>
        This cannot be undone.
      </p>
      <p v-else class="text-sm text-muted">
        {{ firstName(booking.guest_name ?? '') }} is told the {{ noun }} was cancelled{{ cancelNote.trim() ? ', with your note' : '' }}.
        <template v-if="refundable">Their {{ paymentMoney(refundable, booking.payments![0]!.payment.currency) }} payment is refunded in full; you approve that next.</template>
        This cannot be undone.
      </p>
      <div class="flex items-center justify-between gap-4 pt-1">
        <UButton :label="`Keep ${noun}`" color="neutral" variant="ghost" @click="cancelOpen = false" />
        <UButton :label="`Cancel ${noun}`" color="error" :loading="busy === 'cancel'" @click="runAction('cancel')" />
      </div>
    </div>
  </DashboardListItemDialog>
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { DashboardBookingDetails, DashboardRecordType } from '~/server/utils/dashboard-booking-details'

/** The record its levels edit; the change request keeps its own draft. */
export interface BookingEditor {
  bookingType: DashboardRecordType
  refresh: () => Promise<void>
  booking: Ref<DashboardBookingDetails | null>
  noun: ComputedRef<string>
  messageTo: ComputedRef<string | null>
  callTo: ComputedRef<string | null>
  firstName: (name: string) => string
  formatCreatedAt: (value: string) => string
  /** The team's private note on this booking or stay, when the viewer can edit it. */
  note: ComputedRef<{ id: string; version: number; text: string } | null>
  savePrivateNote: (input: { id: string; version: number; text: string }) => Promise<void>
  /** A stay's offline payment step: its currency, today at the home, and the write. */
  stayPayment: { currency: ComputedRef<string | null>; today: () => string; record: (input: { amount: string; method: StayPaymentMethod; paid_on: string; reference: string; idempotency_key: string }) => Promise<void> }
  /**
   * The booking's agreement as the business manages it: the current document,
   * who it may ask to sign, and what the booking is. Null when the booking's
   * read carries no agreement for this viewer to manage.
   */
  agreement: ComputedRef<{
    conversationId: string
    label: string
    title: string
    when: { label: string; value: string; detail: string | null }[]
    current: import('~/shared/agreements').BookingAgreement | null
    signers: { key: string; name: string; role: 'guest' | 'host' }[]
    /** The listing has the business's own template to fill from this booking. */
    template: boolean
  } | null>
  /** The booking's refundable deposit for the business's Deposit leaf; null where the booking has no currency or the viewer is the guest. */
  deposit: ComputedRef<{ bookingId: string; current: import('~/shared/deposits').BookingDeposit; today: string } | null>
  /** A stay's Change reservation step: what it is now, and the write. */
  stayChange: { stay: ComputedRef<{ check_in_date: string; check_out_date: string; adults: number; children: number } | null>; save: (input: { check_in_date: string; check_out_date: string; adults: number; children: number }) => Promise<void> }
}

export const bookingEditorKey = Symbol('booking-editor') as InjectionKey<BookingEditor>
</script>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { useResizeObserver } from '@vueuse/core'
import { manageReservationGuestsKey } from '~/lib/components/workspace/messages/guest-thread-client'
import { STAY_PRESENTATION } from '~/utils/product-presentation'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import FormAnswersCard from '~/components/forms/FormAnswersCard.vue'
import PaymentDetails from '~/components/dashboard/PaymentDetails.vue'
import ReservationItinerary, { type ReservationItineraryDetails } from '~/components/dashboard/ReservationItinerary.vue'
import ChannelMark from '~/lib/components/workspace/messages/ChannelMark.vue'
import { paymentMoney } from '~/shared/payment-display'
import { authClient } from '~/lib/auth-client'
import { NuxtLink } from '#components'
import { formatCalendarDate, formatTime, formatTimestamp, isValidCalendarDate, localDateAt } from '~/utils/timezone'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import DashboardIndexPanel from '~/lib/components/workspace/dashboard/DashboardIndexPanel.vue'
import { getErrorMessage } from '~/utils/errors'
import { getVerticalCopy, normalizeVertical } from '~/utils/vertical-copy'
import { STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS } from '~/shared/stay-listing'
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import { isChannelManagedStay, STAY_CHANNEL_LABELS, STAY_PAYMENT_METHOD_LABELS, type StayPaymentMethod } from '~/shared/bookings'
import { bookedPolicyTerms } from '~/shared/stay-cancellation'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor } from '~/shared/prices'
import { formatPostalAddress } from '~/utils/postal-address'
import StaySetupMap from './StaySetupMap.client.vue'
import BookingAgreement from '~/components/booking/BookingAgreement.vue'
import AgreementSignSheet from '~/components/booking/AgreementSignSheet.vue'
import { agreementLabel, agreementStatusLine, type BookingAgreement as BookingAgreementRecord } from '~/shared/agreements'
import { depositStatusLine } from '~/shared/deposits'
import { ApiClientError } from '~/utils/api-clients'

const props = defineProps<{
  bookingType: DashboardRecordType
  bookingId: string
  /** The record's canonical URL, which the rows that change it link into. */
  editorPath: string
  /** The account that booked, reading its own record: no team controls, its own cancel. */
  personalScope?: boolean
}>()
const recordLevel = useRouteLevel()
const route = useRoute()
const closeTo = computed(() => {
  const { from, q } = route.query
  if (!props.personalScope && /^\/dashboard\/[^/]+\/bookings\/[^/]+\/?$/.test(route.path)
    && typeof from === 'string' && isValidCalendarDate(from)) {
    return { path: `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/calendar`, query: { from, q } }
  }
  return recordLevel.to.value
})
const runtimeConfig = useRuntimeConfig()
const guestManagement = inject(manageReservationGuestsKey)
const photoArrow = { color: 'neutral', variant: 'solid', size: 'sm', class: 'bg-white text-black hover:bg-white/90 disabled:opacity-0' } as const
const guideLabels = {
  directions: 'Directions from your host',
  'check-in': 'How to get inside',
  manual: 'House manual',
  rules: 'House rules',
  checkout: 'Checkout details',
}
const guideSection = ref<keyof typeof guideLabels | null>(null)
const guideOpen = computed({
  get: () => guideSection.value !== null,
  set: open => { if (!open) guideSection.value = null },
})

function textPreview() {
  const element = ref<HTMLElement | null>(null)
  const clipped = ref(false)
  useResizeObserver(element, () => {
    const preview = element.value
    clipped.value = preview !== null && preview.scrollHeight > preview.clientHeight
  })
  return { element, clipped }
}
const { element: directionsPreview, clipped: directionsClipped } = textPreview()
const { element: manualPreview, clipped: manualClipped } = textPreview()
const { element: rulesPreview, clipped: rulesClipped } = textPreview()
const { element: hostPreview, clipped: hostClipped } = textPreview()
const profile = ref<{ title: string; bio: string } | null>(null)
const profileOpen = computed({
  get: () => profile.value !== null,
  set: open => { if (!open) profile.value = null },
})
function showProfile(title: string, bio: string | null | undefined) {
  if (bio) profile.value = { title, bio }
}

interface PanelLink {
  label: string
  icon: string
  to: RouteLocationRaw
  testid?: string
}

type PanelShortcut = {
  label: string
  icon: string
  detail: string | null | undefined
  href?: string
  to?: string
  run?: () => void
}

type PanelAction = PanelLink | {
  label: string
  icon: string
  to?: undefined
  run: () => void
  testid?: string
}

const sectionClass = 'mt-8 border-t border-default pt-7'
const rowClass = 'flex w-full items-center gap-3 py-2.5 text-left text-sm text-highlighted disabled:opacity-50'

const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const actionError = ref<string | null>(null)
const editorPath = computed(() => props.editorPath)
const { data, booking, error, presentation, noun, pageTitle: timedTitle, orgSlug, purchase, refresh: refreshDetails, clear } = await useBookingDetails(props.bookingType, props.bookingId, props.personalScope)
const realtime = useDashboardInvalidations()
watchEffect(() => {
  if (error.value && !data.value) showError(error.value)
})

const formattedTime = computed(() => {
  if (!booking.value?.booking_time) return ''
  const start = formatTime(booking.value.booking_time, 'en')
  const { booking_date: bookingDate, booking_end_date: bookingEndDate, booking_end_time: bookingEndTime } = booking.value
  if (!bookingEndTime) return start
  // A visit past midnight says which day it ends.
  const endDay = bookingEndDate && bookingEndDate !== bookingDate
    ? `${formatCalendarDate(bookingEndDate, 'en', { month: 'short', day: 'numeric', ...(bookingEndDate.slice(0, 4) !== bookingDate.slice(0, 4) ? { year: 'numeric' } : {}) })}, `
    : ''
  return `${start} – ${endDay}${formatTime(bookingEndTime, 'en')}`
})
const recordGuestName = computed(() => booking.value?.guest_name ?? stay.value?.guest_name ?? null)
const recordGuestImage = computed(() => booking.value?.guest_image_url ?? detail.value?.guest_image_url ?? null)
const partySize = computed(() => booking.value?.party_size ?? guestCount.value)
const recordCopy = computed(() => booking.value ? getVerticalCopy(booking.value.vertical) : null)
const bookingParty = computed(() => recordCopy.value?.guestsLabelPlural === 'clients' ? 'clients' : 'guests')
const manageGuestsLabel = computed(() => `Manage ${bookingParty.value}`)
function manageBookingParty() { guestManagement?.open(bookingParty.value) }
const otherGuestLabel = computed(() => `${partySize.value - 1} other ${partySize.value === 2 ? recordCopy.value?.guestLabel ?? 'guest' : recordCopy.value?.guestsLabelPlural ?? 'guests'}`)
const cancellationSummary = computed(() => booking.value?.policy?.items.find(item => item.id === 'cancellation')?.text)
const conversationId = computed(() => booking.value?.conversation_id ?? detail.value?.conversation_id ?? null)
/** The agreement the booking's own read carries, and for the business who it may ask to sign; a read that carries none (a turnover) shows none. */
const agreementRead = computed(() => {
  const record = booking.value ?? detail.value
  if (!record || !('agreement' in record) || record.agreement === undefined) return null
  return {
    agreement: record.agreement,
    signers: 'agreement_signers' in record ? record.agreement_signers ?? null : null,
    template: 'agreement_template' in record && record.agreement_template === true,
  }
})
const signingAgreement = ref<BookingAgreementRecord | null>(null)
/** The deposit the booking's read carries: null for a booking with no price, absent where the read carries none. */
const depositRead = computed(() => {
  const record = booking.value ?? detail.value
  return record && 'deposit' in record ? record.deposit ?? null : null
})
const showAgreementRow = computed(() => Boolean(conversationId.value && agreementRead.value && (agreementRead.value.agreement || !props.personalScope)))
// A guest sees the deposit once the business asks for one; the business always sees where to set it.
const showDepositRow = computed(() => Boolean(depositRead.value && (!props.personalScope || depositRead.value.required_minor !== null || depositRead.value.entries.length)))
const depositSummary = computed(() => {
  const value = depositRead.value
  if (!value) return null
  const currency = value.currency
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported deposit currency ${currency}`)
  return depositStatusLine(value, minor => formatMinorAmount(minor, currency))
})
const guestAgreementOpen = ref(false)
const signingOpen = ref(false)
/** The business's word for the document: the agreement's own, or the booking's kind's before one exists. */
const agreementLabelText = computed(() => {
  if (!agreementRead.value) return null
  if (agreementRead.value.agreement) return agreementRead.value.agreement.label
  return agreementLabel(stay.value ? 'stay' : booking.value?.product_kind ?? 'stay')
})
const agreementRowSummary = computed(() => {
  const value = agreementRead.value?.agreement
  if (!value) return props.personalScope ? null : 'Not sent'
  return agreementStatusLine(value)
})

const messageTo = computed(() => {
  if (!conversationId.value || (stay.value && !props.personalScope && !managedStay.value?.can_message_guest)) return null
  return `/dashboard/${encodeURIComponent(orgSlug.value)}/messages/${encodeURIComponent(conversationId.value)}`
})
const canChangeBooking = computed(() => Boolean(booking.value && !booking.value.complete && ['pending', 'confirmed'].includes(booking.value.status)))
const callTo = computed(() => {
  const phone = booking.value?.guest_phone ?? (!props.personalScope ? detail.value?.guest_phone : null)
  return phone ? `tel:${phone}` : null
})
const contactCallTo = computed(() => {
  if (!props.personalScope) return callTo.value
  const phone = recordHome.value?.contact_phone ?? booking.value?.contact_phone
  return phone ? `tel:${phone}` : null
})
const guestDetailLink = computed(() => booking.value?.type === 'booking' && !props.personalScope ? { path: `${editorPath.value}/guest`, query: route.query } : undefined)

const policyOpen = ref(false)
const toast = useToast()

async function copyAddress(address: string) {
  try {
    await navigator.clipboard.writeText(address)
    toast.add({ title: 'Address copied', color: 'success' })
  } catch (cause) {
    toast.add({ title: 'Address could not be copied', description: getErrorMessage(cause, 'Clipboard unavailable'), color: 'error' })
  }
}
const { t } = useI18n()
const session = authClient.useSession()
// The buyer's answer to a change, on the record itself; the email link records the same decision.
const answering = ref<'accept' | 'decline' | null>(null)
const changeResult = ref<string | null>(null)
async function answerChange(decision: 'accept' | 'decline') {
  const change = booking.value?.pending_change
  if (!change || !booking.value?.conversation_id || answering.value) return
  answering.value = decision
  actionError.value = null
  changeResult.value = null
  try {
    await applicationFetch(`/api/public/booking-changes/${encodeURIComponent(booking.value.conversation_id)}/${encodeURIComponent(change.message_id)}`, {
      method: 'POST',
      body: { decision },
      validate: (value): value is { status: 'accepted' | 'declined' } => isRecord(value) && value.status === (decision === 'accept' ? 'accepted' : 'declined'),
    })
    await refreshDetails()
    if (error.value) throw error.value
    changeResult.value = decision === 'accept' ? t('booking.change_accepted') : t('booking.change_declined')
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'Your answer could not be saved')
    if (!error.value) await refreshDetails()
  } finally {
    answering.value = null
  }
}
const cancelOpen = ref(false)
const cancelNote = ref('')
// What a cancellation gives back: everything still captured, as Airbnb's host cancellation does.
const refundable = computed(() => (booking.value?.payments ?? []).reduce((sum, entry) => sum + entry.payment.captured_amount - entry.payment.refunded_amount, 0))
const busy = ref<string | null>(null)
const actionAttempt = ref<{ draft: string; key: string } | null>(null)

const REVIEW_INVITATION_LABELS = { sent: 'Sent', submitted: 'Answered', revoked: 'Withdrawn', expired: 'Expired' } as const
const reviewStateLabel = computed(() => {
  const invitation = booking.value?.review_invitation
  return invitation ? `${REVIEW_INVITATION_LABELS[invitation.state]} ${formatCreatedAt(invitation.at)}` : ''
})

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name
}

function formatCreatedAt(value: string) {
  return formatTimestamp(value, 'en', 'UTC', { dateStyle: 'medium' })
}


function openCancel() {
  cancelNote.value = ''
  actionError.value = null
  cancelOpen.value = true
}

let accessChangeRevision = 0
watch(realtime.event, (event) => {
  if (!event || purchase || (booking.value && booking.value.organization_id !== event.organization_id)) return
  if (event.type === 'access.changed' || (event.type === 'CONVERSATION_LEAVE' && event.conversation_id === conversationId.value)) {
    accessChangeRevision++
    changeRetry.value = null
    changeResult.value = null
    clear()
    void refreshDetails()
  } else if (event.type === 'stay.changed' && stay.value && (event.booking_id === stay.value.booking_id || (event.booking_id === null && event.product_id === stay.value.product_id))) {
    void refreshDetails()
  } else if ((event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') && !event.scheduled && event.conversation_id === conversationId.value) {
    // A signature or a sent agreement is a message, so the record reads again with its agreement.
    if (booking.value || detail.value?.channel === 'airbnb' || agreementRead.value) void refreshDetails()
  }
})
watch(realtime.reconnectEpoch, epoch => {
  if (epoch > 0 && !purchase) void refreshDetails()
})

function selectAction(action: string) {
  if (action === 'cancel' && !booking.value?.guest_can_retry_cancellation) {
    openCancel()
  } else void runAction(action)
}

// A timed booking's note, or a managed stay's once it is no longer a request waiting on the guest's payment.
const note = computed(() => {
  if (props.personalScope || purchase) return null
  const timed = booking.value
  if (timed) return timed.type === 'booking' && timed.unit === 'slot' && timed.booking_id && timed.version !== null ? { id: timed.booking_id, version: timed.version, text: timed.private_notes ?? '' } : null
  const night = managedStay.value?.booking
  return night && !(night.status === 'pending' && night.respond_by) ? { id: night.booking_id, version: night.version, text: night.private_notes ?? '' } : null
})

async function savePrivateNote(input: { id: string; version: number; text: string }) {
  if (note.value?.id !== input.id) throw new Error('The reservation is no longer available to edit.')
  const revision = accessChangeRevision
  const { booking: saved } = await dashboardApi(dashboardBookingPath(input.id), {
    method: 'PATCH',
    body: { private_notes: input.text, version: input.version },
    validate: (value): value is { booking: { booking_id: string; private_notes: string | null; version: number } } =>
      isRecord(value) && isRecord(value.booking) && value.booking.booking_id === input.id
      && value.booking.private_notes === (input.text.trim() || null) && value.booking.version === input.version + 1,
  })
  const current = data.value
  const currentNote = note.value
  if (accessChangeRevision !== revision || !isDashboardBooking(current) || currentNote?.id !== input.id) {
    throw new Error('Reservation access changed while saving the note.')
  }
  if (currentNote.version > saved.version) return
  const updated = { ...current, booking: { ...current.booking, ...saved } }
  if (!isDashboardBooking(updated)) throw new Error('The reservation could not be updated with the saved note.')
  data.value = updated
}

const isCancelled = (value: unknown): value is { success: true } => isRecord(value) && value.success === true

async function updateStatus(action: string, record: Pick<DashboardBookingDetails, 'booking_id' | 'conversation_id' | 'version'>, note = '') {
  const revision = accessChangeRevision
  if (props.personalScope) {
    await applicationFetch(`/api/account/bookings/${encodeURIComponent(record.booking_id!)}/cancel`, {
      method: 'POST', body: { version: record.version }, validate: isCancelled,
    })
    await refreshNuxtData(`account-activity:${session.value.data?.user.id}`)
    await refreshDetails()
    return
  }
  const draft = JSON.stringify([record.conversation_id, action, note, record.version])
  if (actionAttempt.value?.draft !== draft) actionAttempt.value = { draft, key: crypto.randomUUID() }
  const request = { method: 'POST' as const, body: { version: record.version, idempotency_key: actionAttempt.value.key, ...(note ? { reason: note } : {}) } }
  const endpoint = `${dashboardBookingPath(record.booking_id!)}/${action}`
  if (stay.value) {
    const { booking: updated } = await dashboardApi(endpoint, { ...request, validate: isNightBooking })
    if ((action === 'confirm' && updated.request_status !== 'awaiting_payment') || (action === 'reject' && updated.status !== 'cancelled')) {
      throw new Error('The stay request did not reach its expected state.')
    }
    await refreshDetails()
  } else {
    const updated = await dashboardApi(endpoint, { ...request, validate: isDashboardBooking })
    if (accessChangeRevision === revision) data.value = updated
  }
  actionAttempt.value = null
}

async function runAction(action: string) {
  const record = booking.value
  if (!record?.conversation_id) return
  await run(action, async () => {
    await updateStatus(action, record, action === 'cancel' ? cancelNote.value.trim() : '')
    cancelOpen.value = false
  }, 'Booking could not be updated', false)
}
const confirmDialog = useOverlay().create(DashboardConfirmDialog)
const accountStay = computed(() => isAccountNightBooking(data.value) ? data.value : null)
const itineraryOpen = ref(false)
const dashboardStay = computed(() => isDashboardBooking(data.value) && 'home' in data.value ? data.value : null)
const managedStay = computed(() => dashboardStay.value?.manage ? dashboardStay.value : null)
const turnoverHome = computed(() => dashboardStay.value?.manage === false ? dashboardStay.value.home : null)
const stay = computed(() => accountStay.value?.booking ?? dashboardStay.value?.booking ?? null)
const detail = computed(() => accountStay.value?.booking ?? managedStay.value?.booking ?? null)
const pendingChanges = computed(() => managedStay.value?.booking.pending_changes ?? [])
const channelManaged = computed(() => detail.value !== null && isChannelManagedStay(detail.value))
const manage = computed(() => managedStay.value !== null)
const recordHome = computed(() => accountStay.value?.home ?? managedStay.value?.home ?? null)
const itinerary = computed<ReservationItineraryDetails | null>(() => {
  const value = detail.value
  const home = recordHome.value
  if (value?.status === 'confirmed' && home && !channelManaged.value) {
    return {
      title: home.name, organizationName: home.organization_name, address: home.location?.address ? formatPostalAddress(home.location.address) : null,
      photoUrl: home.photo_urls[0] ?? null, hostName: home.host?.name ?? null, partySize: value.adults + value.children + value.infants,
      paid: [{ amount: value.paid_minor, currency: value.currency }],
      schedule: { unit: 'nights', checkInDate: value.check_in_date, checkOutDate: value.check_out_date, checkInTime: home.check_in_time, checkOutTime: home.check_out_time },
      houseManual: home.arrival_guide?.house_manual, houseRules: home.house_rules,
    }
  }
  const record = booking.value
  if (record?.type !== 'booking' || record.status !== 'confirmed' || !record.starts_at || !record.ends_at || record.party_size === null) return null
  const paid = new Map<string, number>()
  for (const { payment } of record.payments ?? []) {
    if (payment.captured_amount > 0) paid.set(payment.currency, (paid.get(payment.currency) ?? 0) + payment.captured_amount - payment.refunded_amount)
  }
  return {
    title: record.product_kind === 'table' ? record.location_title : record.name, organizationName: record.organization_name, address: record.location_address,
    photoUrl: record.resource_photo_urls[0] ?? null, hostName: record.host?.name ?? null, partySize: record.party_size,
    paid: Array.from(paid, ([currency, amount]) => ({ amount, currency })),
    schedule: { unit: 'slot', startsAt: record.starts_at, endsAt: record.ends_at, timezone: record.timezone },
  }
})
const itineraryAction: PanelAction = { label: 'Get a PDF for visa purposes', icon: 'i-lucide-file-text', run: () => { itineraryOpen.value = true }, testid: 'stay-itinerary' }

/** When the guest said they arrive, where that differs from the home's check-in clock. */
const arrivalTime = computed(() => {
  const value = stay.value
  if (!value || value.starts_at.length === 10) return null
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: value.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value.starts_at))
  return local === (recordHome.value ?? turnoverHome.value)?.check_in_time ? null : formatTime(local, 'en')
})

const reservationActions = computed<PanelAction[]>(() => {
  const actions: PanelAction[] = []
  if (guestManagement?.available.value) {
    actions.push({ label: manageGuestsLabel.value, icon: 'i-lucide-users-round', run: manageBookingParty })
  }
  if (stay.value) {
    if (props.personalScope) {
      if (canRequestChange.value && messageTo.value) {
        actions.push({ label: 'Change reservation', icon: 'i-lucide-pencil', to: { path: messageTo.value, query: { intent: 'booking-change' } }, testid: 'stay-change' })
      }
      if (!channelManaged.value && !paymentProcessing.value && (canRequestChange.value || requestStatus.value)) {
        actions.push({ label: requestStatus.value ? t('stay.withdraw_request') : 'Cancel reservation', icon: 'i-lucide-ban', run: () => void cancelAsGuest(), testid: 'stay-cancel' })
      }
    } else if (manage.value && !channelManaged.value) {
      if (hostActions.value.includes('edit')) {
        actions.push({ label: 'Change reservation', icon: 'i-lucide-pencil', to: { path: `${editorPath.value}/dates`, query: route.query }, testid: 'stay-change' })
      }
      if (hostActions.value.includes('cancel')) {
        actions.push({ label: 'Cancel reservation', icon: 'i-lucide-ban', run: () => void cancelStay(), testid: 'stay-cancel' })
      }
    }
    if (!props.personalScope && manage.value && hostActions.value.includes('release_nights')) {
      actions.push({ label: 'Release remaining nights', icon: 'i-lucide-calendar-minus', run: () => void releaseRemainingNights(), testid: 'stay-early-checkout' })
    }
    if (itinerary.value) actions.push(itineraryAction)
    return actions
  }

  const record = booking.value
  if (!record?.conversation_id || !presentation.value) return actions
  if (canChangeBooking.value) {
    const to = props.personalScope
      ? { path: messageTo.value!, query: { intent: 'booking-change' } }
      : { path: `${editorPath.value}/change`, query: route.query }
    actions.push({ label: `Change ${noun.value}`, icon: 'i-lucide-pencil', to })
  }

  if (props.personalScope) {
    if (record.guest_can_retry_cancellation) {
      actions.push({ label: 'Retry deposit refund', icon: 'i-lucide-refresh-cw', run: () => selectAction('cancel') })
    } else if (record.guest_can_cancel) {
      actions.push({ label: `Cancel ${noun.value}`, icon: 'i-lucide-ban', run: () => selectAction('cancel') })
    }
  } else if (!record.complete) {
    if (record.status === 'pending') {
      actions.push(
        { label: `Confirm ${noun.value}`, icon: 'i-lucide-calendar-check', run: () => selectAction('confirm') },
        { label: `Decline ${noun.value}`, icon: 'i-lucide-calendar-x', run: () => selectAction('reject') },
      )
    } else if (record.status === 'confirmed') {
      actions.push({ label: `Cancel ${noun.value}`, icon: 'i-lucide-ban', run: () => selectAction('cancel') })
    }
  }
  // Airbnb's travel itinerary is for a trip; a law firm's consultation is not one.
  if (itinerary.value && normalizeVertical(record.vertical) !== 'service') actions.push(itineraryAction)
  return actions
})

const contact = computed(() => {
  const links: PanelLink[] = []
  const contactName = props.personalScope ? 'host' : recordCopy.value?.guestLabel ?? 'guest'
  if (messageTo.value && !route.meta.dashboardThirdPane) {
    links.push({
      label: props.personalScope ? t('stay.message_host') : `Message ${contactName}`,
      icon: 'i-lucide-message-circle',
      to: messageTo.value,
      testid: stay.value ? 'stay-message' : undefined,
    })
  }
  if (contactCallTo.value) {
    links.push({ label: `Call ${contactName}`, icon: 'i-lucide-phone', to: contactCallTo.value, testid: stay.value ? 'stay-call' : undefined })
  }
  return links
})

function reservationDay(date: string) {
  return formatCalendarDate(date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })
}

const panel = computed(() => {
  const value = stay.value
  const place = recordHome.value
  const turnover = turnoverHome.value
  const home = place ?? turnover
  const record = booking.value
  const guide = place?.arrival_guide
  const checkInMethod = guide?.check_in_method ?? turnover?.check_in_method
  const method = checkInMethod ? STAY_CHECK_IN_METHODS[checkInMethod].label : null
  const location = purchase ? null : record?.location_title
  const address = place?.location?.address ? formatPostalAddress(place.location.address) : record?.location_address
  const editor = value && `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/products/${encodeURIComponent(value.product_id)}`
  if (!value && !record) return null

  const rows: PanelShortcut[] = []
  if (value && !turnover) {
    if (address || guide?.directions || !props.personalScope) {
      rows.push({ label: 'Getting there', icon: 'i-lucide-map-pin', detail: address,
        ...(props.personalScope ? { href: '#getting-there' } : { to: `${editor}/directions` }) })
    }
    if (guide?.check_in_instructions || guide?.wifi_network || guide?.wifi_password || !props.personalScope) {
      rows.push({ label: 'How to get inside', icon: 'i-lucide-key-round', detail: 'Details for an easy check-in',
        ...(props.personalScope ? { run: () => { guideSection.value = 'check-in' } } : { to: `${editor}/check-in-method` }) })
    }
    if (guide?.house_manual || place?.house_rules.length || place?.safety.length || !props.personalScope) {
      rows.push({ label: 'House rules', icon: 'i-lucide-book-open', detail: 'Review these details for a smooth stay',
        ...(props.personalScope ? { href: '#rules-and-instructions' } : { to: `${editor}/house-rules` }) })
    }
    if (guide?.checkout_instructions.length) {
      rows.push({ label: 'Checkout details', icon: 'i-lucide-door-open', detail: 'How to check out',
        run: () => { guideSection.value = 'checkout' } })
    } else if (!props.personalScope) {
      rows.push({ label: 'Checkout details', icon: 'i-lucide-door-open', detail: 'How to check out', to: `${editor}/checkout-instructions` })
    }
  } else if (!value && (location || address)) {
    rows.push({ label: 'Getting there', icon: 'i-lucide-map-pin', detail: address ?? location, href: '#getting-there' })
  }
  if (!purchase) rows.push({ label: 'Get help', icon: 'i-lucide-life-buoy', detail: 'Contact support', href: '#reservation-support' })
  const when = value ? [
    {
      label: 'Check-in',
      value: reservationDay(value.check_in_date),
      detail: home?.check_in_time ? formatTime(home.check_in_time, 'en') : null,
    },
    { label: 'Checkout', value: reservationDay(value.check_out_date), detail: home?.check_out_time ? formatTime(home.check_out_time, 'en') : null },
  ] : record && !purchase ? [
    { label: 'Date', value: reservationDay(record.booking_date), detail: null },
    { label: 'Time', value: formattedTime.value, detail: null },
  ] : []
  const bookingId = value?.booking_id ?? record?.booking_id

  return {
    photos: place?.photo_urls ?? (turnover?.image_url ? [turnover.image_url] : record?.resource_photo_urls ?? []),
    title: home?.name ?? (record?.product_kind === 'table' ? record.location_title : record?.name),
    purchaseDate: purchase && record ? `Paid ${formatCreatedAt(record.created_at)}` : null,
    host: value ? place?.host : record?.host,
    coHosts: place?.co_hosts ?? [],
    when,
    rows,
    guests: value
      ? `${guestCount.value} ${guestCount.value === 1 ? 'guest' : 'guests'}`
      : record?.party_size != null ? presentation.value?.formatCount(record.party_size) : null,
    code: detail.value?.channel_booking_id ?? bookingId?.slice(0, 8).toUpperCase(),
    actions: reservationActions.value,
    contact: contact.value,
    location,
    address,
    pin: place?.location && place.location.latitude !== null && place.location.longitude !== null
      ? { latitude: place.location.latitude, longitude: place.location.longitude } : record?.location_pin,
    mapsUrl: place?.location?.maps_url ?? record?.location_maps_url,
    listingUrl: place?.listing ? new URL(STAY_PRESENTATION.productPath('', place.listing.slug), tenantOrganizationOrigin({
      platformDomain: String(runtimeConfig.public.platformDomain),
      freeOrganizationDomain: String(runtimeConfig.public.freeOrganizationDomain),
      subdomain: place.listing.subdomain,
      canonicalDomain: place.listing.canonical_domain,
    })).href : null,
    policy: policy.value ? (props.personalScope ? policy.value.terms[0] : `${policy.value.label} · ${policy.value.summary}`) : cancellationSummary.value,
    guide: home ? {
      directions: guide?.directions,
      method,
      instructions: guide?.check_in_instructions ?? turnover?.check_in_instructions,
      manual: guide?.house_manual,
      rules: place?.house_rules ?? [],
      wifi: guide && (guide.wifi_network || guide.wifi_password) ? { network: guide.wifi_network, password: guide.wifi_password } : null,
      safety: place?.safety ?? [],
      checkout: guide?.checkout_instructions ?? [],
      checkoutEditor: !props.personalScope && manage.value && editor ? `${editor}/checkout-instructions` : null,
    } : null,
  }
})
const cancellation = computed(() => accountStay.value?.cancellation ?? null)
const canRequestChange = computed(() => props.personalScope && detail.value !== null && !isChannelManagedStay(detail.value) && Boolean(messageTo.value) && detail.value.status === 'confirmed'
  && (detail.value.ends_at.length === 10 ? detail.value.check_out_date >= localDateAt(new Date(), detail.value.timezone) : Date.parse(detail.value.ends_at) > Date.now()))
const policy = computed(() => detail.value?.cancellation_policy ? bookedPolicyTerms(detail.value.cancellation_policy) : null)
const paymentPath = (paymentId: string) => `/dashboard/${route.params.org_slug}/bookings/payment/${encodeURIComponent(paymentId)}`
const channelName = computed(() => detail.value ? detail.value.channel === 'direct' ? 'You' : STAY_CHANNEL_LABELS[detail.value.channel] : '')
/**
 * Who the stay is for. A stay made here always names its guest, so one without
 * is missing data; a channel may send a stay without a name, which is said as
 * such rather than given one.
 */
type GuestIdentity = { state: 'loading' } | { state: 'named'; name: string } | { state: 'not-provided' } | { state: 'missing' } | { state: 'unnamed' }
const guest = computed<GuestIdentity>(() => {
  const value = detail.value
  // A turnover carries the guest's first name and nothing about who booked it.
  if (!value) return !stay.value ? { state: 'loading' } : stay.value.guest_name ? { state: 'named', name: stay.value.guest_name } : { state: 'unnamed' }
  if (value.owner === 'app' && !value.guest_name) return { state: 'missing' }
  return value.guest_name ? { state: 'named', name: value.guest_name } : { state: 'not-provided' }
})
const guestCount = computed(() => detail.value?.party_size ?? (stay.value ? stay.value.adults + stay.value.children : 0))
const paymentProcessing = computed(() => accountStay.value?.payment_processing === true)
const requestStatus = computed(() => detail.value?.request_status)
const hostActions = computed(() => managedStay.value?.booking.available_actions ?? [])
const pageTitle = computed(() => purchase ? timedTitle.value : 'Reservation')
const statusLabel = computed(() => {
  if (purchase) return null
  if (paymentProcessing.value) return t('payment.processing')
  if (requestStatus.value === 'awaiting_payment') return t('stay.awaiting_payment')
  if (requestStatus.value === 'awaiting_approval') return t('stay.awaiting_approval')
  const status = stay.value?.status ?? booking.value?.status
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'pending') return 'Awaiting review'
  return null
})

function money(minor: number): string {
  const currency = detail.value?.currency
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported stay currency ${String(currency)}`)
  return `${minor < 0 ? '−' : ''}${formatMinorAmount(Math.abs(minor), currency)}`
}
function methodLabel(method: StayPaymentMethod) { return STAY_PAYMENT_METHOD_LABELS[method] }

const changeRetry = ref<{ messageId: string; decision: 'accept' | 'decline' } | null>(null)
// The payment day defaults to today where the home is; one key per payment being entered, kept across retries.
const homeToday = () => stay.value ? localDateAt(new Date(), stay.value.timezone) : ''

async function run(key: string, action: () => Promise<unknown>, failure: string, reload = true) {
  if (busy.value) return
  busy.value = key
  actionError.value = null
  try {
    await action()
    if (reload) await refreshDetails()
  } catch (cause) {
    const details = cause instanceof ApiClientError ? (isRecord(cause.data.data) ? cause.data.data : cause.data) : null
    const approval = typeof details?.financial_approval_url === 'string' ? details.financial_approval_url : null
    if (approval) {
      await navigateTo(approval)
      return
    }
    actionError.value = getErrorMessage(cause, failure)
    if (cause instanceof ApiClientError && (cause.code === 'CHANGE_REQUEST_RESOLVED' || cause.data.committed === true || (isRecord(cause.data.data) && cause.data.data.committed === true))) {
      try {
        await refreshDetails()
      } catch (readError) {
        actionError.value += ` ${getErrorMessage(readError, 'The saved booking could not be reloaded.')}`
      }
    }
  } finally {
    busy.value = null
  }
}

async function answerStayChange(messageId: string, decision: 'accept' | 'decline') {
  if (busy.value !== null || !detail.value) return
  const { booking_id: bookingId, conversation_id: conversationId } = detail.value
  const accessRevision = accessChangeRevision
  changeRetry.value = null
  changeResult.value = null
  await run(`${decision}-${messageId}`, async () => {
    try {
      await dashboardApi(`${dashboardBookingPath(bookingId)}/${decision}_change`, {
        method: 'POST',
        body: { message_id: messageId },
        validate: (value): value is undefined => value === undefined,
      })
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === 'STAY_CHANGE_INCOMPLETE' && accessRevision === accessChangeRevision && detail.value?.conversation_id === conversationId) {
        changeRetry.value = { messageId, decision }
      }
      throw cause
    }
    if (accessRevision !== accessChangeRevision || detail.value?.conversation_id !== conversationId) return
    changeRetry.value = null
    changeResult.value = decision === 'accept' ? t('booking.change_guest_accepted', { channel: 'Airbnb' }) : t('booking.change_declined')
  }, t('booking.change_failed'))
}

/** The payment step's write: money the host received or refunded offline, recorded on the stay. */
async function recordStayPayment(input: { amount: string; method: StayPaymentMethod; paid_on: string; reference: string; idempotency_key: string }) {
  const value = detail.value
  if (!value || isChannelManagedStay(value) || !isCurrencyCode(value.currency)) throw new Error('This stay records no payments here')
  const typed = input.amount.trim()
  const negative = typed.startsWith('-')
  const minor = majorAmountToMinor(negative ? typed.slice(1) : typed, value.currency as Parameters<typeof majorAmountToMinor>[1])
  await dashboardApi(`${dashboardBookingPath(value.booking_id)}/payments`, {
    method: 'POST', validate: isNightBooking,
    body: { amount_minor: negative ? -minor : minor, method: input.method, paid_on: input.paid_on, reference: input.reference || undefined, idempotency_key: input.idempotency_key },
  })
  await refreshDetails()
}

async function deletePayment(paymentId: string) {
  const value = detail.value
  if (!value || isChannelManagedStay(value)) return
  await run(paymentId, () => dashboardApi(`${dashboardBookingPath(value.booking_id)}/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE', validate: isNightBooking }), 'The payment could not be deleted')
}

/** The Change reservation step's write: new dates and guests for a stay the business made, under its version. */
async function changeStay(input: { check_in_date: string; check_out_date: string; adults: number; children: number }) {
  const value = detail.value
  if (!value) throw new Error('The stay is not loaded')
  const revision = accessChangeRevision
  const { booking: saved } = await dashboardApi(`${dashboardBookingPath(value.booking_id)}/move`, {
    method: 'POST', validate: isNightBooking, body: { ...input, version: value.version },
  })
  const current = managedStay.value
  if (accessChangeRevision !== revision || !current || current.booking.booking_id !== saved.booking_id) {
    throw new Error('Reservation access changed while saving.')
  }
  if (current.booking.version <= saved.version) {
    data.value = { ...current, booking: { ...current.booking, ...saved } }
    realtime.savedReservation.value = saved
  }
}

async function releaseRemainingNights() {
  const value = detail.value
  if (!value || !hostActions.value.includes('release_nights')) return
  if (!await confirmDialog.open({
    title: 'Has the guest checked out?',
    description: 'The calendar releases the remaining nights starting today. The Airbnb reservation keeps its original dates.',
    confirmLabel: 'Release remaining nights', cancelLabel: 'Keep nights blocked',
  })) return
  await run('move', async () => {
    const checkout = localDateAt(new Date(), value.timezone)
    const { booking: saved } = await dashboardApi(`${dashboardBookingPath(value.booking_id)}/early-checkout`, {
      method: 'POST', validate: isNightBooking, body: { version: value.version, actual_check_out_date: checkout },
    })
    if (saved.actual_check_out_date !== checkout || saved.check_out_date !== value.check_out_date) {
      throw new Error('The server did not confirm the early checkout.')
    }
    await refreshDetails()
  }, 'The remaining nights could not be released', false)
}

async function cancelStay() {
  const value = detail.value
  if (!value || isChannelManagedStay(value)) return
  const held = value.online_payments.reduce((sum, online) => sum + online.captured_minor - online.refunded_minor, 0)
  const description = held > 0
    ? `Its nights become available again and ${guest.value.state === 'named' ? guest.value.name : 'the guest'} is refunded ${money(held)} in full. You approve the refund next.`
    : value.request_status ? 'The guest will be notified and the nights will become available again.' : 'Its nights become available again. Record any refund as a payment.'
  if (!await confirmDialog.open({ title: guest.value.state === 'named' ? `Cancel ${guest.value.name}’s stay` : 'Cancel this stay', description, confirmLabel: 'Cancel stay', cancelLabel: 'Keep stay' })) return
  await run('cancel', () => updateStatus('cancel', value), 'The stay could not be cancelled', false)
}

async function decide(action: 'confirm' | 'reject') {
  const value = detail.value
  if (!value || !hostActions.value.includes(action) || busy.value) return
  const label = action === 'confirm' ? t('stay.approve_request') : t('stay.decline_request')
  if (action === 'reject' && !await confirmDialog.open({ title: label, description: '', confirmLabel: label, cancelLabel: t('stay.keep_request') })) return
  await run(action, () => updateStatus(action, value), 'The stay request could not be updated.', false)
}

async function payForStay() {
  if (!stay.value || busy.value) return
  busy.value = 'pay'
  actionError.value = null
  try {
    const { pay_url } = await applicationFetch(`/api/account/bookings/${encodeURIComponent(stay.value.booking_id)}/pay`, {
      method: 'POST',
      validate: (response): response is { pay_url: string } => isRecord(response) && typeof response.pay_url === 'string',
    })
    await navigateTo(pay_url, { external: true })
  } catch (cause) {
    actionError.value = getErrorMessage(cause, t('payment.unavailable'))
  } finally {
    busy.value = null
  }
}

/** The guest cancels their own stay; the policy they booked under decides what comes back. */
async function cancelAsGuest() {
  const value = detail.value
  const quote = cancellation.value
  if (!value || isChannelManagedStay(value) || !value.conversation_id) return
  const pending = value.request_status !== null
  if (!pending && !quote) {
    if (messageTo.value && await confirmDialog.open({ title: 'Cancel reservation', description: 'Contact your host to cancel this reservation.',
      confirmLabel: t('stay.message_host'), cancelLabel: 'Keep reservation' })) await navigateTo(messageTo.value)
    return
  }
  const description = pending || !quote ? '' : quote.refund_minor === quote.paid_minor ? `You get back the full ${money(quote.paid_minor)}.`
    : quote.refund_minor > 0 ? `Under the ${policy.value?.label} policy you get back ${money(quote.refund_minor)} of the ${money(quote.paid_minor)} you paid.`
      : `Under the ${policy.value?.label} policy none of the ${money(quote.paid_minor)} you paid comes back.`
  if (!await confirmDialog.open({ title: pending ? t('stay.withdraw_request_title') : 'Cancel your stay?', description,
    confirmLabel: pending ? t('stay.withdraw_request') : 'Cancel stay', cancelLabel: pending ? t('stay.keep_request') : 'Keep stay' })) return
  await run('cancel', () => updateStatus('cancel', value), 'Your stay could not be cancelled', false)
}

provide(bookingEditorKey, {
  bookingType: props.bookingType,
  refresh: async () => { await refreshDetails() },
  booking,
  noun,
  messageTo,
  callTo,
  firstName,
  formatCreatedAt,
  note,
  savePrivateNote,
  stayPayment: { currency: computed(() => detail.value?.currency ?? null), today: homeToday, record: recordStayPayment },
  agreement: computed(() => {
    const read = agreementRead.value
    const view = panel.value
    if (!read?.signers || !conversationId.value || !agreementLabelText.value || !view) return null
    return { conversationId: conversationId.value, label: agreementLabelText.value, title: view.title ?? agreementLabelText.value, when: view.when, current: read.agreement, signers: read.signers, template: read.template }
  }),
  deposit: computed(() => {
    const current = depositRead.value
    if (props.personalScope || !current) return null
    const timezone = stay.value?.timezone ?? booking.value?.timezone
    if (!timezone) throw new Error('A booking with a deposit has no timezone to date its entries in')
    return { bookingId: props.bookingId, current, today: localDateAt(new Date(), timezone) }
  }),
  stayChange: { stay: computed(() => detail.value ? { check_in_date: detail.value.check_in_date, check_out_date: detail.value.check_out_date, adults: detail.value.adults, children: detail.value.children } : null), save: changeStay },
})
</script>
