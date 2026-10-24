<template>
  <div class="flex flex-col gap-4">
    <ul v-if="state.products.length" class="flex flex-col gap-2">
      <UCard
        v-for="(product, index) in state.products"
        :key="index"
        as="li"
        variant="subtle"
        :ui="{ body: 'flex items-center gap-3' }"
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-highlighted">{{ product.name }}</span>
          <span v-if="product.category" class="mt-0.5 block truncate text-sm text-toned">{{ product.category }}</span>
        </span>
        <span v-if="product.amountMinor === null" class="shrink-0 text-sm text-muted">No price</span>
        <span v-else class="shrink-0 font-medium text-highlighted">{{ formatAmount(product.amountMinor) }}</span>
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          square
          :aria-label="`Remove ${product.name}`"
          @click="state.products.splice(index, 1)"
        />
      </UCard>
    </ul>

    <UCard variant="subtle" :ui="{ body: 'flex flex-col gap-3' }">
      <p class="text-sm text-toned">{{ copy.prompt }}</p>
      <div class="flex flex-col gap-3 sm:flex-row">
        <UFormField :label="copy.nameLabel" class="flex-1">
          <UInput v-model="draftName" class="w-full" :placeholder="copy.namePlaceholder" @keydown.enter.prevent="add" />
        </UFormField>
        <UFormField label="Price" class="sm:w-40" hint="Optional" :error="priceError">
          <UInput v-model="draftPrice" class="w-full" inputmode="decimal" :placeholder="currencySymbol" @keydown.enter.prevent="add" />
        </UFormField>
      </div>
      <UFormField :label="copy.categoryLabel">
        <UInput v-model="draftCategory" class="w-full" :placeholder="copy.categoryPlaceholder" @keydown.enter.prevent="add" />
      </UFormField>
      <UButton class="self-start" :disabled="!canAdd" :label="copy.addLabel" @click="add" />
    </UCard>

    <p class="text-sm text-muted">{{ copy.enough }}</p>
  </div>
</template>

<script setup lang="ts">
import { useOnboardingState } from '~/composables/useOnboardingFlow'

/**
 * A categorised thing a guest buys or books: a dish on a restaurant's menu, an
 * experience on its experiences page. Both are rows in `products`, so this is
 * one step whose words change rather than two steps.
 *
 * The price is optional, because `prices` is a separate table and nothing in
 * `products` requires a row in it. A dish whose price is not settled yet is
 * added without one and renders with no price element on the public site — a
 * zero or placeholder amount would be a price the owner never set.
 *
 * Legal practices are not here. On a legal practice's site a practice area is
 * page content — NCLS has a /services page with blocks and zero product rows —
 * so that vertical skips this step rather than being asked to price a thing it
 * does not sell this way. Lodging homes need their location and stay settings,
 * which are collected by the canonical home editor after website setup.
 */
const state = useOnboardingState()

const draftName = ref('')
const draftCategory = ref('')
const draftPrice = ref('')

const COPY = {
  restaurant: {
    prompt: 'Your first dish — the name is all it takes. Add a price now or later.',
    nameLabel: 'Dish', namePlaceholder: 'Grilled squid',
    categoryLabel: 'Section', categoryPlaceholder: 'Small plates, Skewers, Drinks…',
    addLabel: 'Add dish',
    enough: 'Six or seven dishes is plenty to launch with. The rest can come later.',
  },
  experience: {
    prompt: 'Add an experience to finish configuring before guests can book.',
    nameLabel: 'Experience', namePlaceholder: 'Sunset kayak tour',
    categoryLabel: 'Category', categoryPlaceholder: 'Half day, Full day, Evening…',
    addLabel: 'Add experience',
    enough: 'Booking details are required before an experience can be published.',
  },
} as const

const copy = computed(() => {
  const vertical = state.value.vertical
  if (vertical !== 'restaurant' && vertical !== 'experience') throw createError({ statusCode: 400, statusMessage: 'This business type adds its offerings after website setup' })
  return COPY[vertical]
})
// Intl knows the symbol and the decimal places for the owner's currency, so
// neither is a table we keep in step with it.
const currencyFormat = computed(() => {
  // The currency step sits immediately before this one, so an unanswered
  // currency here means the flow let the owner past it. Price these items in a
  // guessed currency and they would be saved at those numbers.
  const currency = state.value.details.currency
  if (!currency) throw createError({ statusCode: 500, statusMessage: 'The currency step has not been answered' })
  return new Intl.NumberFormat('en', { style: 'currency', currency })
})
const currencySymbol = computed(() => currencyFormat.value
  .formatToParts(0)
  .find(part => part.type === 'currency')?.value ?? '')

// An empty price field is a product without a price; a field with characters in
// it that are not a non-negative amount is a typo the owner should see, not an
// absent price. Those are different answers, so parsing reports which one it
// read instead of collapsing both to null.
type ParsedAmount = { blank: true } | { blank: false; amountMinor: number } | { invalid: true }

// Prices are stored in minor units, so the owner's "12.50" becomes 1250 here
// rather than at the write boundary where a rounding choice would be invisible.
function parseAmount(value: string): ParsedAmount {
  const raw = value.trim()
  if (!raw) return { blank: true }
  // A price is never negative, and stripping the sign read "-5" as 5.
  if (raw.includes('-')) return { invalid: true }
  // Spaces and the currency symbol this field prompts for are dropped — "1 234,50"
  // is one number written with a group separator, and the placeholder invites
  // "฿450". Anything else that is not a digit or a separator is the typo this
  // function exists to report: stripping it read "12a.50" as 12.50 and stored a
  // price the owner never typed.
  const written = raw.split(currencySymbol.value).join('').replace(/\s/g, '')
  if (/[^\d.,]/.test(written)) return { invalid: true }
  // "1,234.50", "1.234,50" and "1 234,50" are one number written three ways, so
  // the separators are read rather than substituted: a separator followed by
  // exactly three digits groups thousands, and a shorter trailing run is the
  // decimal mark. Replacing only the first comma read "1,234" as 1.234 and
  // stored a $1,234 item as 123 minor units — $1.23. Anything that is not one
  // of these three shapes is refused rather than guessed at: "1.2.3" used to
  // parse as 12.30.
  const shapes = [
    /^\d+(?:[.,]\d{1,2})?$/,
    /^\d*[.,]\d{1,2}$/,
    /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/,
  ]
  if (!shapes.some(shape => shape.test(written))) return { invalid: true }
  const decimalAt = written.search(/[.,]\d{1,2}$/)
  const normalized = decimalAt === -1
    ? written.replace(/[.,]/g, '')
    : `${written.slice(0, decimalAt).replace(/[.,]/g, '')}.${written.slice(decimalAt + 1)}`
  const amount = Number.parseFloat(normalized)
  if (!Number.isFinite(amount)) return { invalid: true }
  return { blank: false, amountMinor: Math.round(amount * 100) }
}


const parsedPrice = computed(() => parseAmount(draftPrice.value))
const priceError = computed(() => 'invalid' in parsedPrice.value ? 'Enter an amount, or leave this blank' : undefined)
const canAdd = computed(() => draftName.value.trim().length > 0 && !('invalid' in parsedPrice.value))

function formatAmount(amountMinor: number) {
  return currencyFormat.value.format(amountMinor / 100)
}

function add() {
  const parsed = parsedPrice.value
  if (!draftName.value.trim() || 'invalid' in parsed) return
  state.value.products.push({
    name: draftName.value.trim(),
    category: draftCategory.value.trim(),
    amountMinor: parsed.blank ? null : parsed.amountMinor,
  })
  draftName.value = ''
  draftPrice.value = ''
}
</script>
