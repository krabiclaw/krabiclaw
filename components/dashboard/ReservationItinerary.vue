<template>
  <DashboardListItemDialog
    v-model:open="open"
    title="Get a PDF for visa purposes"
    save-label="Print or save as PDF"
    :save-disabled="!!nameError"
    :saving="preparing"
    :error="printError"
    @save="printItinerary"
  >
    <UFormField label="Who’s coming?" :error="nameError" hint="Optional" class="w-full">
      <UTextarea v-model="guestNames" placeholder="One full name per line" :rows="3" autoresize class="w-full" />
    </UFormField>
    <UFormField label="Itinerary language" class="w-full">
      <USelect v-model="documentLocale" :items="languages" class="w-full" />
    </UFormField>
  </DashboardListItemDialog>

  <Teleport v-if="open" to="body">
    <article class="reservation-itinerary-paper" :lang="documentLocale" data-testid="reservation-itinerary-paper">
      <header>
        <h1>{{ labels.title }}</h1>
        <p>{{ home.organization_name }}</p>
      </header>
      <img v-if="home.photo_urls[0]" ref="cover" class="reservation-itinerary-cover" :src="home.photo_urls[0]" :alt="home.name">
      <h2>{{ home.name }}</h2>
      <p v-if="home.location?.address">{{ formatPostalAddress(home.location.address) }}</p>
      <dl>
        <div v-for="row in facts" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </div>
      </dl>
      <section v-if="home.arrival_guide?.house_manual">
        <h3>{{ labels.houseManual }}</h3>
        <p class="reservation-itinerary-manual">{{ home.arrival_guide.house_manual }}</p>
      </section>
      <section v-if="home.house_rules.length">
        <h3>{{ labels.houseRules }}</h3>
        <ul>
          <li v-for="rule in home.house_rules" :key="rule">{{ rule }}</li>
        </ul>
      </section>
    </article>
  </Teleport>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import type { AccountNightBooking } from '~/composables/useDashboardBooking'
import { paymentMoney } from '~/shared/payment-display'
import { formatPostalAddress } from '~/utils/postal-address'
import { getErrorMessage } from '~/utils/errors'
import { formatCalendarDate, formatTime } from '~/utils/timezone'

const props = defineProps<{ booking: AccountNightBooking['booking']; home: AccountNightBooking['home']; confirmationCode: string }>()
const open = defineModel<boolean>('open', { required: true })
const { locale } = useI18n()

const translations = {
  en: {
    title: 'Travel itinerary', confirmation: 'Confirmation code', checkIn: 'Check-in', checkout: 'Checkout',
    guests: 'Guests', names: 'Guest names', hostedBy: 'Hosted by', paid: 'Amount paid', houseManual: 'House manual', houseRules: 'House rules',
  },
  ja: {
    title: '旅行日程表', confirmation: '予約確認コード', checkIn: 'チェックイン', checkout: 'チェックアウト',
    guests: '宿泊人数', names: '宿泊者名', hostedBy: 'ホスト', paid: '支払い済み金額', houseManual: 'ハウスマニュアル', houseRules: 'ハウスルール',
  },
  th: {
    title: 'กำหนดการเดินทาง', confirmation: 'รหัสยืนยันการจอง', checkIn: 'เช็คอิน', checkout: 'เช็คเอาท์',
    guests: 'จำนวนผู้เข้าพัก', names: 'ชื่อผู้เข้าพัก', hostedBy: 'เจ้าของที่พัก', paid: 'ยอดชำระแล้ว', houseManual: 'คู่มือที่พัก', houseRules: 'กฎของที่พัก',
  },
  vi: {
    title: 'Lịch trình chuyến đi', confirmation: 'Mã xác nhận', checkIn: 'Nhận phòng', checkout: 'Trả phòng',
    guests: 'Số khách', names: 'Tên khách', hostedBy: 'Chủ nhà', paid: 'Số tiền đã thanh toán', houseManual: 'Hướng dẫn sử dụng nhà', houseRules: 'Nội quy nhà',
  },
} as const

const languages: { label: string; value: keyof typeof translations }[] = [
  { label: 'English', value: 'en' },
  { label: '日本語', value: 'ja' },
  { label: 'ไทย', value: 'th' },
  { label: 'Tiếng Việt', value: 'vi' },
]
const documentLocale = ref(languages.find(language => language.value === locale.value)?.value ?? 'en')
const labels = computed(() => translations[documentLocale.value])
const guestNames = ref('')
const names = computed(() => guestNames.value.split('\n').map(name => name.trim()).filter(Boolean))
const guestCount = computed(() => props.booking.adults + props.booking.children + props.booking.infants)
const nameError = computed(() => {
  if (names.value.length > guestCount.value) return `Enter up to ${guestCount.value} names for this reservation.`
  if (names.value.some(name => name.length > 160)) return 'Each name must be 160 characters or fewer.'
  return undefined
})
const cover = ref<HTMLImageElement | null>(null)
const preparing = ref(false)
const printError = ref<string | null>(null)
watch(open, visible => {
  if (!visible) {
    guestNames.value = ''
    printError.value = null
  }
})

const facts = computed(() => {
  const { booking, home } = props
  const copy = labels.value
  const localizedDay = (date: string, time: string | null) => {
    const day = formatCalendarDate(date, documentLocale.value, { dateStyle: 'long' })
    return time ? `${day} · ${formatTime(time, documentLocale.value)}` : day
  }
  const paid = booking.online_payment
    ? booking.online_payment.captured_minor - booking.online_payment.refunded_minor
    : booking.paid_minor
  const amount = paymentMoney(paid, booking.currency, documentLocale.value)
  return [
    { label: copy.confirmation, value: props.confirmationCode },
    { label: copy.checkIn, value: localizedDay(booking.check_in_date, home.check_in_time) },
    { label: copy.checkout, value: localizedDay(booking.check_out_date, home.check_out_time) },
    { label: copy.guests, value: new Intl.NumberFormat(documentLocale.value).format(guestCount.value) },
    ...(names.value.length ? [{ label: copy.names, value: names.value.join(', ') }] : []),
    ...(home.host ? [{ label: copy.hostedBy, value: home.host.name }] : []),
    { label: copy.paid, value: amount },
  ]
})

async function printItinerary() {
  if (nameError.value || preparing.value) return
  preparing.value = true
  printError.value = null
  try {
    await cover.value?.decode()
    await document.fonts.ready
    if (open.value) window.print()
  } catch (cause) {
    printError.value = getErrorMessage(cause, 'The itinerary could not be printed')
  } finally {
    preparing.value = false
  }
}
</script>

<style>
.reservation-itinerary-paper {
  display: none;
}

@media print {
  @page reservation-itinerary {
    size: auto;
    margin: 16mm;
  }

  body:has(> .reservation-itinerary-paper) {
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
    background: white !important;
  }

  body:has(> .reservation-itinerary-paper) > :not(.reservation-itinerary-paper) {
    display: none !important;
  }

  .reservation-itinerary-paper {
    display: block;
    page: reservation-itinerary;
    color: #181818;
    font: 11pt/1.5 system-ui, sans-serif;
    overflow-wrap: anywhere;
  }

  .reservation-itinerary-paper header,
  .reservation-itinerary-paper dl {
    padding-bottom: 12pt;
    border-bottom: 1px solid #d0d0d0;
    margin-bottom: 16pt;
  }

  .reservation-itinerary-paper h1 {
    font-size: 23pt;
    font-weight: 700;
  }

  .reservation-itinerary-paper h2 {
    font-size: 15pt;
    font-weight: 650;
  }

  .reservation-itinerary-paper h3 {
    font-weight: 650;
    break-after: avoid;
  }

  .reservation-itinerary-cover {
    width: auto;
    max-width: 100%;
    max-height: 43mm;
    margin-bottom: 10pt;
    object-fit: contain;
  }

  .reservation-itinerary-paper dl {
    margin-top: 12pt;
  }

  .reservation-itinerary-paper dl div {
    display: grid;
    grid-template-columns: 36% 1fr;
    gap: 8pt;
    padding-block: 3pt;
    break-inside: avoid;
  }

  .reservation-itinerary-paper dt {
    font-weight: 600;
  }

  .reservation-itinerary-paper section + section {
    margin-top: 10pt;
  }

  .reservation-itinerary-paper ul {
    list-style: disc;
    padding-inline-start: 18pt;
  }

  .reservation-itinerary-manual {
    white-space: pre-wrap;
  }
}
</style>
