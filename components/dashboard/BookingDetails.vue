<template>
  <DashboardIndexPanel :id="stay ? 'stay-details' : personalScope ? 'account-booking-details' : 'booking-details'" :title="pageTitle" column="record">
    <template #right>
      <UButton v-if="recordLevel.to.value" :to="recordLevel.to.value" icon="i-lucide-x" color="neutral" variant="ghost" :aria-label="stay ? 'Close stay details' : 'Close booking details'" />
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
          :description="`${channelName} confirmed this stay on nights another stay holds. Move this guest to another home, cancel this stay on ${channelName}, or cancel the other stay where it was booked.`"
        />
        <UAlert
          v-if="manage && detail?.booked_home_name"
          class="mb-5"
          color="info"
          variant="soft"
          icon="i-lucide-move-right"
          title="Moved"
          :description="`Booked as ${detail.booked_home_name} on ${channelName}. These nights are held on the home the guest moved to.`"
          :actions="[{ label: 'Undo move', color: 'neutral', variant: 'outline', loading: busy === 'undo_move', onClick: undoMove }]"
        />
        <UAlert v-if="!personalScope && guest.state === 'missing'" class="mb-5" color="error" variant="soft" icon="i-lucide-circle-alert" title="Guest name missing" description="This stay was made in KrabiClaw, which requires a guest name, but it has none." />
        <div class="flex flex-col items-center pb-12 text-center" :class="recordImage ? 'pt-2' : 'pt-10'">
          <img v-if="recordImage" :src="recordImage" alt="" class="aspect-square w-full max-w-80 rounded-2xl bg-elevated object-cover" :class="!personalScope && !purchase && recordGuestName ? '' : 'mb-6'">
          <div v-if="!personalScope && !purchase && recordGuestName" class="relative mx-auto mb-6 shrink-0 md:mb-8" :class="[recordImage ? '-mt-12 md:-mt-14' : '', partySize && partySize > 1 ? 'h-30 w-35 md:h-40 md:w-46' : 'size-27 md:size-36']">
            <UAvatar :src="recordGuestImage || undefined" :alt="recordGuestName" :text="recordGuestName.slice(0, 1).toUpperCase()" size="3xl" class="absolute bottom-0 left-0" :class="partySize && partySize > 1 ? 'size-21 md:size-28' : 'size-27 md:size-36'" :ui="{ fallback: 'text-[30px] font-semibold text-highlighted md:text-4xl' }" />
            <span v-if="partySize > 1" class="absolute right-0 top-0 flex size-16 items-center justify-center rounded-full bg-elevated text-[9px] font-bold text-highlighted md:size-21 md:text-xs" :aria-label="otherGuestLabel">+{{ partySize - 1 }}</span>
          </div>
          <h2 class="max-w-full break-words text-[32px] font-semibold leading-9 tracking-tight text-highlighted">{{ heroTitle }}</h2>
          <p v-if="heroDate" class="mt-4 break-words text-base text-muted">{{ heroDate }}</p>
          <p v-if="heroSubtitle" class="mt-1 break-words text-base text-muted">{{ heroSubtitle }}</p>
          <UBadge v-if="stay && (personalScope || (manage && requestStatus))" class="mt-3" :color="stay.status === 'confirmed' ? 'success' : 'neutral'" variant="soft" :label="statusLabel" />
          <div v-if="manage && hostActions.includes('confirm')" class="mt-5 flex flex-wrap justify-center gap-3">
            <UButton color="neutral" size="lg" :label="t('stay.approve_request')" :loading="busy === 'confirm'" :disabled="busy !== null" @click="decide('confirm')" />
            <UButton color="neutral" variant="outline" size="lg" :label="t('stay.decline_request')" :loading="busy === 'reject'" :disabled="busy !== null" @click="decide('reject')" />
          </div>
          <UButton v-if="personalScope && detail?.request_status === 'awaiting_payment' && (paymentProcessing || (detail.pay_by && Date.parse(detail.pay_by) > Date.now()))"
            class="mt-5" color="neutral" size="lg" :label="t(paymentProcessing ? 'payment.view_payment' : 'payment.continue_to_pay')" :loading="busy === 'pay'" @click="payForStay" />
        </div>

        <div class="space-y-4">
          <p v-if="changeResult" class="text-sm text-highlighted" role="status">{{ changeResult }}</p>
          <UAlert
            v-if="booking?.pending_change"
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

          <UCard v-if="!purchase" variant="record">
            <div class="grid grid-cols-2 divide-x divide-default">
              <div class="min-w-0 pe-6">
                <h3 class="text-base font-semibold text-highlighted">{{ stay ? 'Check-in' : 'Date' }}</h3>
                <p class="mt-1 text-sm text-muted">{{ formattedDate }}</p>
                <p v-if="checkInTime" class="mt-1 text-sm text-muted">{{ checkInTime }}</p>
              </div>
              <div class="min-w-0 ps-6 text-right">
                <h3 class="text-base font-semibold text-highlighted">{{ stay ? 'Checkout' : 'Time' }}</h3>
                <p class="mt-1 text-sm text-muted">{{ stay ? formatCalendarDate(stay.check_out_date, 'en') : formattedTime }}</p>
                <p v-if="stay && recordHome?.check_out_time" class="mt-1 text-sm text-muted">By {{ formatTime(recordHome.check_out_time, 'en') }}</p>
              </div>
            </div>
            <div v-if="arrivalTime" class="mt-6 border-t border-default pt-4">
              <p class="text-base font-medium text-highlighted">Arriving</p>
              <p class="mt-1 text-base text-muted">{{ arrivalTime }}</p>
            </div>
            <p v-if="stay?.no_show_at && !detail" class="mt-6 border-t border-default pt-4 text-base text-muted" data-testid="stay-no-show">No-show recorded {{ formatCalendarDate(stay.no_show_at.slice(0, 10), 'en') }}.</p>
          </UCard>
          <UCard v-if="!personalScope && hostHome && (hostHome.check_in_method || hostHome.check_in_instructions)" variant="record">
            <h3 class="text-base font-semibold text-highlighted">{{ t('stay.check_in_method') }}</h3>
            <p v-if="hostHome.check_in_method" class="mt-3 text-base text-muted">{{ STAY_CHECK_IN_METHODS[hostHome.check_in_method].label }}</p>
            <p v-if="hostHome.check_in_instructions" class="mt-3 whitespace-pre-wrap text-base text-muted">{{ hostHome.check_in_instructions }}</p>
          </UCard>

          <UCard v-if="personalScope && home?.location && (guestAddress || home.location.maps_url)" variant="record">
            <h2 class="text-base font-semibold text-highlighted">{{ t('stay.where_youll_be') }}</h2>
            <p v-if="guestAddress" class="mt-3 whitespace-pre-line break-words text-base text-muted">{{ guestAddress }}</p>
            <UButton v-if="home.location.maps_url" :to="home.location.maps_url" target="_blank" rel="noopener noreferrer" class="mt-4" color="neutral" variant="outline" :label="t('site.experience_detail.open_in_maps')" />
          </UCard>

          <UCard v-if="personalScope && home?.arrival_guide" variant="record">
            <h2 class="mb-6 text-base font-semibold text-highlighted">{{ t('stay.arrival_guide') }}</h2>
            <StayArrivalGuideView :guide="home.arrival_guide" :rules="home.house_rules" :safety="home.safety" />
          </UCard>

          <UCard v-if="booking && !purchase" variant="record">
            <h3 class="text-base font-semibold text-highlighted">Where</h3>
            <p class="mt-1 text-sm text-muted">{{ booking.location_title }}</p>
            <p v-if="booking.location_address" class="mt-1 text-sm text-muted">{{ booking.location_address }}</p>
          </UCard>

          <UCard v-if="booking?.type === 'booking' && !personalScope" variant="record">
            <h3 class="text-base font-semibold text-highlighted">What’s booked</h3>
            <p class="mt-1 text-sm text-muted">{{ offeringName }}<template v-if="booking.party_size"> · {{ guestCountLabel }}</template></p>
          </UCard>

          <template v-if="booking?.type === 'booking' && !personalScope">
            <UCard variant="record">
              <div class="flex items-center gap-4">
                <span class="min-w-0 flex-1"><span class="block text-base font-semibold text-highlighted">{{ recordCopy?.assigneeLabel }}</span><span class="mt-1 block text-sm text-muted">{{ booking.assigned_member_name || (booking.assigned_member_id ? 'Previously assigned member' : booking.organization_name) }}</span></span>
              </div>
            </UCard>
            <UAlert v-if="booking.provider_conflict" color="warning" :description="`This ${noun} overlaps a busy time. Contact your ${recordCopy?.guestLabel} to change it.`" />
          </template>

          <UCard v-if="booking && !personalScope && !purchase" variant="record">
            <h3 class="text-base font-semibold text-highlighted">Private note</h3>
            <p class="mt-1 text-sm text-muted">Only your team sees this.</p>
            <div class="group mt-4">
              <UTextarea v-model="noteDraft" aria-label="Private note" placeholder="Add a note for your team" :rows="2" autoresize maxlength="2000" :disabled="noteSaving" class="w-full" @blur="saveNote" />
              <p class="mt-2 hidden text-right text-xs text-muted group-focus-within:block">{{ 2000 - noteDraft.length }} characters available</p>
              <UAlert v-if="noteError" class="mt-3" color="error" variant="soft" :description="noteError" :actions="[{ label: 'Retry', color: 'neutral' as const, loading: noteSaving, onClick: saveNote }]" />
            </div>
          </UCard>

          <UCard v-if="stay || (personalScope && !purchase) || (!personalScope && recordGuestName)" variant="record">
            <component :is="guestDetailLink ? NuxtLink : 'div'" :to="guestDetailLink" :aria-label="guestDetailLink ? `${guestHeading} ${recordGuestName} · ${guestCountLabel}` : undefined" class="block">
              <h3 class="text-base font-semibold text-highlighted">{{ personalScope ? 'Who’s coming' : purchase ? 'Buyer' : guestHeading }}</h3>
              <div v-if="recordGuestName && (stay || !personalScope)" class="mt-4 flex items-center gap-4">
                <UAvatar :src="recordGuestImage || undefined" :alt="recordGuestName" :text="recordGuestName.slice(0, 1).toUpperCase()" size="xl" class="size-12 bg-muted" aria-hidden="true" />
                <span class="min-w-0 flex-1 text-base text-highlighted">{{ recordGuestName }}</span>
                <UIcon v-if="guestDetailLink" name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
              </div>
              <div v-if="partySize > 1 && (stay || !personalScope)" class="mt-4 flex items-center gap-4">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden="true">+{{ partySize - 1 }}</span>
                <span class="text-base text-highlighted">{{ otherGuestLabel }}</span>
              </div>
              <p v-if="stay || personalScope" class="mt-3 text-base text-muted">{{ stay ? partyLabel : guestCountLabel }}</p>
            </component>
            <a v-if="detail?.guest_phone" :href="`tel:${detail.guest_phone}`" class="mt-3 block w-fit text-base text-highlighted underline underline-offset-4">{{ formatPhone(detail.guest_phone) }}</a>
            <a v-if="detail?.guest_email" :href="`mailto:${detail.guest_email}`" class="mt-2 block w-fit break-all text-base text-highlighted underline underline-offset-4">{{ detail.guest_email }}</a>
          </UCard>

          <!-- The guest did not come, or where the visit's review invitation stands: the team's own record of it. -->
          <UCard v-if="!personalScope && (booking?.no_show_at || booking?.review_invitation)" variant="record" data-testid="booking-review-state">
            <h3 class="text-base font-semibold text-highlighted">{{ booking.no_show_at ? 'No-show' : 'Review invitation' }}</h3>
            <p class="mt-1 text-sm text-muted">{{ reviewStateLabel }}</p>
          </UCard>

          <FormAnswersCard v-if="booking || detail" :answers="booking?.answers ?? detail?.answers ?? []" :title="personalScope ? 'Your answers' : undefined" />
          <UCard v-if="booking?.notes" variant="record">
            <h3 class="text-base font-semibold text-highlighted">{{ personalScope ? 'Your requests' : `${recordCopy?.guestLabel.charAt(0).toUpperCase()}${recordCopy?.guestLabel.slice(1)} requests` }}</h3>
            <p class="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted">{{ booking.notes }}</p>
          </UCard>

          <UCard v-if="booking && !purchase" as="button" type="button" variant="record" class="w-full text-left" @click="policyOpen = true">
            <span class="flex items-center gap-4">
              <span class="min-w-0 flex-1"><span class="block text-base font-semibold text-highlighted">Cancellation policy</span><span class="mt-1 block text-sm text-muted">{{ cancellationSummary }}</span></span>
              <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
            </span>
          </UCard>

          <PaymentDetails v-for="detail in booking?.payments" :key="detail.payment.id" :payment="detail.payment" :refunds="detail.refunds" :order="detail.order">
            <template v-if="!personalScope && detail.payment.captured_amount > detail.payment.refunded_amount" #actions>
              <NuxtLink :to="{ path: `${editorPath}/refund`, query: { ...route.query, payment: detail.payment.id } }" class="flex items-center gap-4 border-t border-default py-4">
                <span class="min-w-0 flex-1 text-base font-medium text-highlighted">Send a refund</span>
                <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
              </NuxtLink>
            </template>
          </PaymentDetails>

          <template v-if="detail">
          <UCard v-if="!personalScope && detail.private_notes" variant="record">
            <h3 class="text-base font-semibold text-highlighted">Private note</h3>
            <p class="mt-3 whitespace-pre-wrap text-base text-muted">{{ detail.private_notes }}</p>
          </UCard>

          <!-- The policy the guest booked under, in Airbnb's words: what their own cancellation returns. -->
          <UCard v-if="policy || detail.cancellation_reason" variant="record">
          <template v-if="policy">
            <h2 class="text-base font-semibold text-highlighted">Cancellation policy</h2>
            <p class="mt-1 text-base text-highlighted">{{ policy.label }}</p>
            <ul class="mt-2 space-y-1 text-base text-muted">
              <li v-for="term in policy.terms" :key="term">{{ term }}</li>
            </ul>
          </template>
          <section v-if="detail.cancellation_reason" class="mt-6">
            <h3 class="text-base font-semibold text-highlighted">Cancellation reason</h3>
            <p class="mt-2 whitespace-pre-wrap text-base text-muted">{{ detail.cancellation_reason }}</p>
          </section>
          </UCard>

          <UCard variant="record">
          <dl class="space-y-4">
            <div class="flex items-start justify-between gap-4">
              <dt class="text-base font-semibold text-highlighted">Total</dt>
              <dd class="text-right text-base font-semibold text-highlighted">{{ money(detail.total_minor) }}</dd>
            </div>
            <div v-if="!channelManaged" class="flex items-start justify-between gap-4 border-t border-default pt-4">
              <dt class="text-base text-muted">Paid</dt>
              <dd class="text-right text-base text-highlighted">{{ money(detail.paid_minor) }}</dd>
            </div>
          </dl>
          </UCard>

          <!-- The Stripe payment the guest made on the site: its record and refunds are the payment's own screens. -->
          <UCard v-if="!personalScope && (detail.online_payment || (!channelManaged && !requestStatus))" variant="record">
          <h2 class="text-base font-semibold text-highlighted">Payments</h2>
          <template v-if="detail.online_payment">
            <h3 class="mt-6 text-base font-semibold text-highlighted">Paid on your site</h3>
            <p class="mt-1 text-base text-muted">{{ money(detail.online_payment.captured_minor) }}{{ detail.online_payment.refunded_minor ? ` · ${money(detail.online_payment.refunded_minor)} refunded` : '' }}</p>
            <div class="mt-4 divide-y divide-default border-y border-default">
              <NuxtLink :to="`${paymentPath}`" class="flex items-center gap-4 py-4">
                <span class="min-w-0 flex-1 text-base font-medium text-highlighted">View payment</span>
                <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
              </NuxtLink>
              <NuxtLink v-if="manage && detail.online_payment.captured_minor > detail.online_payment.refunded_minor" :to="{ path: `${paymentPath}/refund`, query: { payment: detail.online_payment.payment_id } }" class="flex items-center gap-4 py-4">
                <span class="min-w-0 flex-1 text-base font-medium text-highlighted">Send a refund</span>
                <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
              </NuxtLink>
            </div>
          </template>

          <template v-if="!channelManaged && !requestStatus">
            <p class="text-sm text-muted" :class="detail.online_payment ? 'mt-6' : 'mt-1'">Money you received or refunded outside KrabiClaw. Recording it moves no money.</p>
            <ul v-if="detail.payments.length" class="mt-4 divide-y divide-default border-y border-default">
              <li v-for="payment in detail.payments" :key="payment.id" class="flex items-center gap-4 py-3">
                <span class="min-w-0 flex-1">
                  <span class="block text-base text-highlighted">{{ money(payment.amount_minor) }} · {{ methodLabel(payment.method) }}</span>
                  <span class="block text-sm text-muted">{{ formatCalendarDate(payment.paid_on, 'en') }}{{ payment.reference ? ` · ${payment.reference}` : '' }}</span>
                </span>
                <UButton v-if="manage" icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Delete payment of ${money(payment.amount_minor)}`" :loading="busy === payment.id" @click="deletePayment(payment.id)" />
              </li>
            </ul>
            <p v-else class="mt-4 text-base text-muted">No payments recorded.</p>

            <UForm v-if="manage" :state="draft" class="mt-6 space-y-4" @submit="recordPayment">
              <div class="grid gap-4 sm:grid-cols-2">
                <UFormField :label="`Amount (${detail.currency})`" name="amount" description="Negative for a refund." required>
                  <UInput v-model="draft.amount" inputmode="decimal" class="w-full" />
                </UFormField>
                <UFormField label="Method" name="method" required>
                  <USelect v-model="draft.method" :items="methods" class="w-full" />
                </UFormField>
                <UFormField label="Date" name="paid_on" required>
                  <UInput v-model="draft.paid_on" type="date" class="w-full" />
                </UFormField>
                <UFormField label="Reference" name="reference">
                  <UInput v-model="draft.reference" class="w-full" />
                </UFormField>
              </div>
              <UButton type="submit" label="Record payment" :loading="busy === 'record'" :disabled="!draft.amount.trim() || !draft.paid_on" />
            </UForm>
            <p v-if="!personalScope && detail.no_show_at" class="mt-6 text-sm text-muted" data-testid="stay-no-show">No-show recorded {{ formatCalendarDate(detail.no_show_at.slice(0, 10), 'en') }}. No review invitation is sent.</p>
            <UButton v-else-if="canMarkNoShow" class="mt-4 ms-2" color="neutral" variant="soft" label="Mark as a no-show" :loading="busy === 'no_show'" @click="markNoShow" />
          </template>
          </UCard>
          <UButton v-if="manage && !personalScope && !channelManaged && hostActions.includes('cancel')" color="error" variant="soft" label="Cancel stay" :loading="busy === 'cancel'" :disabled="busy !== null" @click="cancelStay" />
          <UCard variant="record">
          <dl class="space-y-4">
            <div v-if="detail.channel_booking_id" class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
              <dt class="text-base text-muted">{{ STAY_CHANNEL_LABELS[detail.channel] }} confirmation</dt>
              <dd class="break-words text-right text-base text-highlighted">{{ detail.channel_booking_id }}</dd>
            </div>
            <div class="flex items-start justify-between gap-4">
              <dt class="text-base text-muted">Booked through</dt>
              <dd class="text-right text-base text-highlighted">{{ STAY_CHANNEL_LABELS[detail.channel] }}</dd>
            </div>
          </dl>
          <UButton v-if="manage && hostActions.includes('move')" class="mt-4" color="neutral" variant="outline" label="Move guest" :to="`/dashboard/${encodeURIComponent(String(route.params.org_slug))}/bookings/${encodeURIComponent(detail.booking_id)}/move`" data-testid="stay-move" />
          <p v-if="!personalScope && channelManaged" class="mt-4 text-base text-muted">
            Payments, changes and cancellations for this stay are managed on
            <ULink v-if="detail.channel_booking_url" :to="detail.channel_booking_url" target="_blank" rel="noopener noreferrer" class="text-highlighted underline">{{ channelName }}</ULink><template v-else>{{ channelName }}</template>.
          </p>
          </UCard>
          </template>
          <UCard v-if="(booking && (!purchase || availableActions.length)) || (stay && personalScope)" as="button" type="button" variant="record" class="w-full text-left" @click="manageOpen = true">
            <span class="flex items-center gap-4"><span class="min-w-0 flex-1 text-base font-semibold text-highlighted">{{ stay ? t('booking.manage') : `Manage ${noun}` }}</span><UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" /></span>
          </UCard>
          <UCard v-if="booking" variant="record">
            <p class="text-base font-semibold text-highlighted">{{ purchase ? 'Purchase date' : 'Booking date' }}</p>
            <p class="mt-1 text-sm text-muted">{{ formatCreatedAt(booking.created_at) }}</p>
          </UCard>
        </div>
      </template>
    </div>
    <template v-if="(booking || stay) && !error && (messageTo || contactCallTo)" #footer>
      <div class="flex flex-wrap justify-center gap-3">
        <UButton v-if="messageTo" :to="messageTo" :label="stay && personalScope ? t('stay.message_host') : 'Message'" :aria-label="messageLabel" color="neutral" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" />
        <UButton v-if="contactCallTo" :to="contactCallTo" label="Call" color="neutral" class="pointer-events-auto h-14 rounded-full px-8 shadow-lg" />
      </div>
    </template>
  </DashboardIndexPanel>

  <DashboardListItemDialog v-model:open="manageOpen" :title="stay ? t('booking.manage') : `Manage ${noun}`" :show-actions="false" :error="actionError">
    <div v-if="booking" class="divide-y divide-default">
      <NuxtLink v-if="canChangeBooking && !personalScope" :to="{ path: `${editorPath}/change`, query: route.query }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>Change {{ noun }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="personalScope && canChangeBooking && messageTo" :to="{ path: messageTo, query: { intent: 'booking-change' } }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('booking.request_change') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="!purchase" :to="{ path: personalScope ? `/dashboard/account/calendar/${booking.booking_date}` : `/dashboard/${orgSlug}/calendar/${booking.booking_date}`, query: !personalScope && booking.location_id ? { locationId: booking.location_id } : undefined }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>View on calendar</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <UButton v-for="action in availableActions" :key="action.value" :label="action.label" :icon="action.icon" :color="action.color" variant="ghost" block class="justify-start py-4" :loading="busy === action.value" @click="selectAction(action.value)" />
    </div>
    <div v-else-if="detail" class="divide-y divide-default">
      <p v-if="channelManaged" class="py-4 text-base text-muted">{{ t('booking.channel_manage', { channel: channelName }) }}</p>
      <NuxtLink v-if="canRequestChange && messageTo" :to="{ path: messageTo, query: { intent: 'booking-change' } }" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('booking.request_change') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <NuxtLink v-if="messageTo" :to="messageTo" class="flex items-center justify-between gap-4 py-4 text-base font-medium text-highlighted" @click="manageOpen = false"><span>{{ t('stay.message_host') }}</span><UIcon name="i-lucide-chevron-right" class="size-5" /></NuxtLink>
      <p v-if="personalScope && !channelManaged && recordHome?.check_in_time === null && detail.online_payment && detail.status !== 'cancelled'" class="py-4 text-base text-muted">Contact your host to cancel this stay.</p>
      <UButton v-if="personalScope && !channelManaged && !paymentProcessing && (cancellation || detail.request_status)" color="error" variant="ghost" block
        class="justify-start py-4" :label="detail.request_status ? t('stay.withdraw_request') : 'Cancel stay'" :loading="busy === 'cancel'"
        @click="manageOpen = false; cancelAsGuest()" />
    </div>
  </DashboardListItemDialog>
  <DashboardListItemDialog v-model:open="policyOpen" :title="booking?.policy?.heading || 'Cancellation policy'" :show-actions="false">
    <div v-if="booking" class="space-y-4">
      <div class="space-y-3">
        <div v-for="item in booking.policy!.items" :key="item.id" class="flex gap-3">
          <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-success" />
          <p class="text-sm leading-relaxed text-muted">{{ item.text }}</p>
        </div>
      </div>
    </div>
  </DashboardListItemDialog>
  <DashboardListItemDialog v-model:open="noShowOpen" title="Mark as a no-show" :show-actions="false" :error="actionError">
    <div v-if="booking" class="space-y-5">
      <p class="text-sm leading-relaxed text-muted">{{ firstName(booking.guest_name ?? '') }} won’t be asked to review this {{ noun }}, and a review link already sent stops working. The {{ noun }} itself stays as it is. This cannot be undone.</p>
      <div class="flex items-center justify-between gap-4 pt-1">
        <UButton label="Keep as is" color="neutral" variant="ghost" @click="noShowOpen = false" />
        <UButton label="Mark as a no-show" color="error" :loading="busy === 'no_show'" @click="runAction('no_show')" />
      </div>
    </div>
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
}

export const bookingEditorKey = Symbol('booking-editor') as InjectionKey<BookingEditor>
</script>

<script setup lang="ts">
import FormAnswersCard from '~/components/forms/FormAnswersCard.vue'
import PaymentDetails from '~/components/dashboard/PaymentDetails.vue'
import { paymentMoney } from '~/shared/payment-display'
import { authClient } from '~/lib/auth-client'
import { NuxtLink } from '#components'
import { formatCalendarDate, formatTime, formatTimestamp, localDateAt  } from '~/utils/timezone'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import DashboardIndexPanel from '~/lib/components/workspace/dashboard/DashboardIndexPanel.vue'
import { getErrorMessage } from '~/utils/errors'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { formatPhone } from '~/utils/phone'
import StayArrivalGuideView from '~/components/booking/StayArrivalGuide.vue'
import { stayCheckInWindow } from '~/shared/stay-arrival'
import { STAY_CHECK_IN_METHODS } from '~/shared/stay-listing'
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import { isChannelManagedStay, STAY_CHANNEL_LABELS, STAY_PAYMENT_METHOD_LABELS, type StayPaymentMethod } from '~/shared/bookings'
import { bookedPolicyTerms } from '~/shared/stay-cancellation'
import { STAY_MOVE_MESSAGE_QUEUED, isMovedStayResponse } from '~/shared/stay-move'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor } from '~/shared/prices'
import { formatPostalAddress } from '~/utils/postal-address'
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

type ActionColor = 'success' | 'error' | 'neutral'

const dashboardApi = props.personalScope ? applicationFetch : useDashboardApi()
const actionError = ref<string | null>(null)
const editorPath = computed(() => props.editorPath)
const { data, booking, error, presentation, noun, pageTitle: timedTitle, orgSlug, purchase, refresh: refreshDetails, clear } = await useBookingDetails(props.bookingType, props.bookingId, props.personalScope)
const realtime = useDashboardInvalidations()
watchEffect(() => {
  if (error.value && !data.value) showError(error.value)
})

const formattedDate = computed(() => stay.value ? formatCalendarDate(stay.value.check_in_date, 'en') : booking.value ? formatCalendarDate(booking.value.booking_date, 'en') : '')
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
const partyTitle = computed(() => {
  const name = firstName(recordGuestName.value ?? '')
  return partySize.value > 1 ? `${name}’s group of ${partySize.value}` : name
})
const recordImage = computed(() => booking.value?.resource_image_url ?? recordHome.value?.image_url ?? null)
const heroTitle = computed(() => {
  if (!stay.value) return props.personalScope || purchase ? offeringName.value : partyTitle.value
  if (props.personalScope && home.value) return home.value.name
  if (guest.value.state === 'named') return partyTitle.value
  if (guest.value.state === 'not-provided') return `Name not provided by ${channelName.value}`
  return guest.value.state === 'missing' ? 'Guest name missing' : 'Guest'
})
const heroDate = computed(() => stay.value ? stayDates.value : purchase
  ? `${booking.value?.type === 'order' ? 'Ordered' : 'Paid'} ${formattedDate.value}`
  : props.personalScope ? formattedDate.value : '')
const heroSubtitle = computed(() => stay.value ? home.value?.organization_name ?? hostHome.value?.internal_name
  : props.personalScope ? booking.value?.organization_name : purchase ? recordGuestName.value : offeringName.value)
const recordCopy = computed(() => booking.value ? getVerticalCopy(booking.value.vertical) : null)
const guestHeading = computed(() => {
  const label = recordCopy.value?.guestsLabelPlural ?? 'Guests'
  return label.charAt(0).toUpperCase() + label.slice(1)
})
const offeringName = computed(() => booking.value?.product_kind === 'table' ? booking.value.location_title : booking.value?.name ?? '')
const guestCountLabel = computed(() => `${booking.value?.party_size ?? 0} ${booking.value?.party_size === 1 ? recordCopy.value?.guestLabel : recordCopy.value?.guestsLabelPlural}`)
const otherGuestLabel = computed(() => `${partySize.value - 1} other ${partySize.value === 2 ? recordCopy.value?.guestLabel ?? 'guest' : recordCopy.value?.guestsLabelPlural ?? 'guests'}`)
const cancellationSummary = computed(() => booking.value?.policy?.items.find(item => item.id === 'cancellation')?.text)
const conversationId = computed(() => booking.value?.conversation_id ?? detail.value?.conversation_id ?? null)
const messageTo = computed(() => {
  if (!conversationId.value || (stay.value && !props.personalScope && !managedStay.value?.can_message_guest)) return null
  return `/dashboard/${encodeURIComponent(orgSlug.value)}/messages/${encodeURIComponent(conversationId.value)}`
})
const canChangeBooking = computed(() => Boolean(booking.value && !booking.value.complete && ['pending', 'confirmed'].includes(booking.value.status)))
const callTo = computed(() => {
  const phone = booking.value?.guest_phone ?? (!props.personalScope ? detail.value?.guest_phone : null)
  return phone ? `tel:${phone}` : null
})
const contactCallTo = computed(() => props.personalScope ? booking.value?.contact_phone ? `tel:${booking.value.contact_phone}` : null : callTo.value)
const guestDetailLink = computed(() => booking.value?.type === 'booking' && !props.personalScope ? { path: `${editorPath.value}/guest`, query: route.query } : undefined)
const messageLabel = computed(() => props.personalScope ? stay.value ? t('stay.message_host') : 'Message' : `Message ${recordCopy.value?.guestLabel ?? 'guest'}`)

const policyOpen = ref(false)
const { t } = useI18n()
const manageOpen = ref(false)
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
const noShowOpen = ref(false)
const cancelNote = ref('')
// What a cancellation gives back: everything still captured, as Airbnb's host cancellation does.
const refundable = computed(() => (booking.value?.payments ?? []).reduce((sum, entry) => sum + entry.payment.captured_amount - entry.payment.refunded_amount, 0))
const busy = ref<string | null>(null)
const actionAttempt = ref<{ draft: string; key: string } | null>(null)
// The team's one private note on the booking, saved as a whole when the field is left.
const noteDraft = ref('')
const noteSaving = ref(false)
const noteError = ref<string | null>(null)
watch(() => booking.value?.private_notes, (saved) => { if (!noteSaving.value) noteDraft.value = saved ?? '' }, { immediate: true })

// Nothing to approve and nothing to mark done: a booking arrives confirmed and
// is complete once its end passes. Cancelling is the one thing left to decide,
// and changing it is the link above.
const availableActions = computed<Array<{ value: string; label: string; icon: string; color: ActionColor }>>(() => {
  if (!booking.value || !presentation.value || !booking.value.conversation_id) return []
  if (props.personalScope && booking.value.guest_can_retry_cancellation) return [
    { value: 'cancel', label: 'Retry deposit refund', icon: 'i-lucide-refresh-cw', color: 'neutral' as const },
  ]
  // The account's one decision is its own cancellation, on the public cancel rule the server already answered.
  if (props.personalScope) return booking.value.guest_can_cancel
    ? [{ value: 'cancel', label: `Cancel ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const }]
    : []
  const noShow = booking.value.can_mark_no_show ? [{ value: 'no_show', label: 'Mark as a no-show', icon: 'i-lucide-user-x', color: 'neutral' as const }] : []
  if (booking.value.complete) return noShow
  if (booking.value.type === 'booking' && booking.value.status === 'pending') return [
    { value: 'confirm', label: `Confirm ${presentation.value.noun}`, icon: 'i-lucide-calendar-check', color: 'success' as const },
    { value: 'reject', label: `Decline ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const },
  ]
  if (booking.value.status !== 'confirmed') return []
  return [{ value: 'cancel', label: `Cancel ${presentation.value.noun}`, icon: 'i-lucide-calendar-x', color: 'error' as const }, ...noShow]
})

const REVIEW_INVITATION_LABELS = { sent: 'Sent', submitted: 'Answered', revoked: 'Withdrawn', expired: 'Expired' } as const
const reviewStateLabel = computed(() => {
  const record = booking.value
  if (!record) return ''
  if (record.no_show_at) return `Recorded ${formatCreatedAt(record.no_show_at)}. No review invitation is sent.`
  const invitation = record.review_invitation
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
  } else if ((event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') && !event.scheduled && event.conversation_id === conversationId.value && (booking.value || detail.value?.channel === 'airbnb')) {
    void refreshDetails()
  }
})
watch(realtime.connectionEpoch, epoch => {
  if (epoch > 0 && !purchase) void refreshDetails()
})

// A blur save and the navigation it caused share one write. Failed text stays
// visible on the record.
let pendingNote: Promise<boolean> | null = null
function saveNote(): Promise<boolean> {
  if (pendingNote) return pendingNote
  const current = booking.value
  if (!current || noteDraft.value.trim() === (current.private_notes ?? '')) return Promise.resolve(true)
  pendingNote = writeNote(current).finally(() => { pendingNote = null })
  return pendingNote
}
onBeforeRouteUpdate(saveNote)
onBeforeRouteLeave(saveNote)

function selectAction(action: string) {
  if (action === 'cancel' && !booking.value?.guest_can_retry_cancellation) {
    manageOpen.value = false
    openCancel()
  } else if (action === 'no_show') {
    manageOpen.value = false
    actionError.value = null
    noShowOpen.value = true
  } else void runAction(action)
}

async function writeNote(current: DashboardBookingDetails) {
  const revision = accessChangeRevision
  const note = noteDraft.value
  noteSaving.value = true
  noteError.value = null
  try {
    const updated = await dashboardApi(
      dashboardBookingPath(props.bookingId),
      {
        method: 'PATCH',
        // Guarded by the booking as it was read: an edit since then is not overwritten.
        body: { private_notes: note, version: current.version },
        validate: isDashboardBooking,
      },
    )
    if (accessChangeRevision === revision) data.value = updated
    return true
  } catch (cause) {
    noteError.value = getErrorMessage(cause, 'Note could not be saved')
    return false
  } finally {
    noteSaving.value = false
  }
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
    noShowOpen.value = false
    manageOpen.value = false
  }, 'Booking could not be updated', false)
}
const toast = useToast()
const confirmDialog = useOverlay().create(DashboardConfirmDialog)
const accountStay = computed(() => isAccountNightBooking(data.value) ? data.value : null)
const dashboardStay = computed(() => isDashboardBooking(data.value) && 'home' in data.value ? data.value : null)
const managedStay = computed(() => dashboardStay.value?.manage ? dashboardStay.value : null)
const stay = computed(() => accountStay.value?.booking ?? dashboardStay.value?.booking ?? null)
const detail = computed(() => accountStay.value?.booking ?? managedStay.value?.booking ?? null)
const pendingChanges = computed(() => managedStay.value?.booking.pending_changes ?? [])
const channelManaged = computed(() => detail.value !== null && isChannelManagedStay(detail.value))
const manage = computed(() => managedStay.value !== null)
const home = computed(() => accountStay.value?.home ?? null)
const hostHome = computed(() => dashboardStay.value?.home ?? null)
const recordHome = computed(() => home.value ?? hostHome.value)
const checkInTime = computed(() => recordHome.value?.check_in_time
  ? stayCheckInWindow(formatTime(recordHome.value.check_in_time, 'en'), hostHome.value?.check_in_end_time ? formatTime(hostHome.value.check_in_end_time, 'en') : null)
  : null)
/** When the guest said they arrive, where that is not the home's check-in time: the stay's stored start in the home's clock. */
const arrivalTime = computed(() => {
  const value = stay.value
  if (!value || value.starts_at.length === 10) return null
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: value.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value.starts_at))
  return local === recordHome.value?.check_in_time ? null : formatTime(local, 'en')
})
const guestAddress = computed(() => home.value?.location?.address ? formatPostalAddress(home.value.location.address) : '')
const cancellation = computed(() => accountStay.value?.cancellation ?? null)
const canRequestChange = computed(() => props.personalScope && detail.value !== null && !isChannelManagedStay(detail.value) && Boolean(messageTo.value) && detail.value.status === 'confirmed'
  && (detail.value.ends_at.length === 10 ? detail.value.check_out_date >= localDateAt(new Date(), detail.value.timezone) : Date.parse(detail.value.ends_at) > Date.now()))
const policy = computed(() => detail.value?.cancellation_policy ? bookedPolicyTerms(detail.value.cancellation_policy) : null)
const paymentPath = computed(() => detail.value?.online_payment ? `/dashboard/${route.params.org_slug}/bookings/payment/${encodeURIComponent(detail.value.online_payment.payment_id)}` : '')
const methods = Object.entries(STAY_PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))
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
const nights = computed(() => stay.value ? Math.round((Date.parse(`${stay.value.check_out_date}T00:00:00Z`) - Date.parse(`${stay.value.check_in_date}T00:00:00Z`)) / 86_400_000) : 0)
const stayDates = computed(() => stay.value
  ? `${formatCalendarDate(stay.value.check_in_date, 'en')} – ${formatCalendarDate(stay.value.check_out_date, 'en')} · ${nights.value === 1 ? '1 night' : `${nights.value} nights`}`
  : '')
const partyLabel = computed(() => {
  const value = stay.value
  if (!value) return ''
  const parts = [`${value.adults} ${value.adults === 1 ? 'adult' : 'adults'}`]
  if (value.children) parts.push(`${value.children} ${value.children === 1 ? 'child' : 'children'}`)
  if (value.infants) parts.push(`${value.infants} ${value.infants === 1 ? 'infant' : 'infants'}`)
  return parts.join(', ')
})
const guestCount = computed(() => stay.value ? stay.value.adults + stay.value.children + stay.value.infants : 0)
const paymentProcessing = computed(() => accountStay.value?.payment_processing === true)
const requestStatus = computed(() => detail.value?.request_status)
const hostActions = computed(() => managedStay.value?.booking.available_actions ?? [])
const pageTitle = computed(() => stay.value ? props.personalScope ? 'Your stay' : statusLabel.value : timedTitle.value)
const statusLabel = computed(() => {
  if (!stay.value) return 'Stay'
  if (paymentProcessing.value) return t('payment.processing')
  if (requestStatus.value === 'awaiting_payment') return t('stay.awaiting_payment')
  if (requestStatus.value === 'awaiting_approval') return t('stay.awaiting_approval')
  return { pending: 'Pending', cancelled: 'Cancelled', confirmed: 'Confirmed' }[stay.value.status]
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
const draft = reactive({ amount: '', method: 'cash' as StayPaymentMethod, paid_on: homeToday(), reference: '', key: crypto.randomUUID() })
watch(stay, () => { if (!draft.paid_on) draft.paid_on = homeToday() })

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

async function recordPayment() {
  const value = detail.value
  if (!value || isChannelManagedStay(value) || !isCurrencyCode(value.currency)) return
  const typed = draft.amount.trim()
  const negative = typed.startsWith('-')
  await run('record', async () => {
    const minor = majorAmountToMinor(negative ? typed.slice(1) : typed, value.currency as Parameters<typeof majorAmountToMinor>[1])
    await dashboardApi(`${dashboardBookingPath(value.booking_id)}/payments`, {
      method: 'POST', validate: isNightBooking,
      body: { amount_minor: negative ? -minor : minor, method: draft.method, paid_on: draft.paid_on, reference: draft.reference || undefined, idempotency_key: draft.key },
    })
    draft.amount = ''
    draft.reference = ''
    draft.key = crypto.randomUUID()
  }, 'The payment could not be recorded')
}

async function deletePayment(paymentId: string) {
  const value = detail.value
  if (!value || isChannelManagedStay(value)) return
  await run(paymentId, () => dashboardApi(`${dashboardBookingPath(value.booking_id)}/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE', validate: isNightBooking }), 'The payment could not be deleted')
}

// A stay paid on the site returns the guest's whole payment, as Airbnb's host cancellation does; the host approves that refund next.
// A stay booked here that has begun, before its guest reviewed it. The thread
// operation is the writer; it refuses a stay that no longer qualifies.
const canMarkNoShow = computed(() => !props.personalScope && manage.value && detail.value?.channel === 'direct' && detail.value.status === 'confirmed'
  && !detail.value.no_show_at && Boolean(detail.value.conversation_id) && detail.value.check_in_date <= localDateAt(new Date(), detail.value.timezone))

async function undoMove() {
  const value = detail.value
  if (!value?.booked_product_id) return
  if (!await confirmDialog.open({ title: 'Undo this move', description: `The guest goes back to ${value.booked_home_name} and a message with its address and entry details is queued.`, confirmLabel: 'Undo move', cancelLabel: 'Keep the move' })) return
  await run('undo_move', async () => {
    await dashboardApi(`${dashboardBookingPath(value.booking_id)}/move`, { method: 'POST', validate: isMovedStayResponse, body: { version: value.version, product_id: value.booked_product_id } })
    toast.add(STAY_MOVE_MESSAGE_QUEUED)
  }, 'The move could not be undone.')
}

async function markNoShow() {
  const value = detail.value
  if (!value?.conversation_id) return
  if (!await confirmDialog.open({
    title: 'Mark as a no-show',
    description: `${guest.value.state === 'named' ? guest.value.name : 'The guest'} won’t be asked to review this stay, and a review link already sent stops working. The stay itself stays as it is. This cannot be undone.`,
    confirmLabel: 'Mark as a no-show', cancelLabel: 'Keep as is',
  })) return
  await run('no_show', () => updateStatus('no_show', value), 'The stay could not be marked as a no-show', false)
}

async function cancelStay() {
  const value = detail.value
  if (!value || isChannelManagedStay(value)) return
  const held = value.online_payment ? value.online_payment.captured_minor - value.online_payment.refunded_minor : 0
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
  if (!pending && (!quote || !policy.value)) return
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
})
</script>
