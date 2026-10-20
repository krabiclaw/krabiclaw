<template>
  <div>
    <UFieldGroup class="w-full">
      <USelectMenu
        :id="`${id}-country`"
        :model-value="country"
        :items="countries"
        value-key="code"
        label-key="name"
        :filter-fields="['name', 'code', 'dialCode']"
        :aria-label="selectedCountry ? `${t('booking.phone_country')}: ${selectedCountry.name} (${selectedCountry.dialCode})` : t('booking.phone_country')"
        :disabled="disabled"
        :portal="false"
        :search-input="{ id: `${id}-country-search`, placeholder: t('booking.search_phone_countries'), icon: 'i-lucide-search' }"
        :content="{ align: 'start' }"
        :ui="{ base: 'pe-8', content: 'z-50 w-72 max-w-[calc(100vw-3rem)]', placeholder: 'hidden', trailingIcon: 'size-4' }"
        class="shrink-0"
        @update:model-value="selectCountry"
      >
        <span class="flex items-center gap-1.5 text-sm font-medium">
          <span v-if="selectedCountry" aria-hidden="true" class="text-base leading-none">{{ selectedCountry.emoji }}</span>
          <span :class="selectedCountry ? 'text-highlighted' : 'text-muted'">{{ selectedCountry?.dialCode ?? t('booking.phone_country_code') }}</span>
        </span>
        <template #content-top>
          <label :for="`${id}-country-search`" class="sr-only">{{ t('booking.search_phone_countries') }}</label>
        </template>
        <template #item-leading="{ item }">
          <span aria-hidden="true" class="text-base leading-none">{{ item.emoji }}</span>
        </template>
        <template #item-label="{ item }">{{ item.name }} ({{ item.dialCode }})</template>
      </USelectMenu>
      <UInput
        :id="id"
        ref="field"
        :model-value="display"
        type="tel"
        inputmode="tel"
        autocomplete="tel"
        :autofocus="autofocus"
        :required="required"
        :disabled="disabled"
        :placeholder="placeholder"
        :aria-invalid="error ? true : undefined"
        :aria-describedby="error ? `${id}-error` : undefined"
        class="min-w-0 flex-1"
        @beforeinput="beforeInput"
        @input="onInput"
        @compositionend="onInput"
        @blur="touched = true"
        @invalid.prevent="validate"
      />
    </UFieldGroup>
    <p v-if="error" :id="`${id}-error`" role="alert" class="mt-1.5 text-sm text-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
/*
  The one phone field. Its value is E.164 whenever the entry is a real number,
  and the text being typed while it is not, so the value alone says whether it
  can be saved: the input's own validity blocks a native form, and a parent
  without one checks `toE164(value)`. The country is the field's interpretation
  of national digits, never part of the value: the person's own choice (the
  picker, a number typed with "+", a saved number) and otherwise the default.
  A form that remounts the field binds `v-model:country` to keep that choice.
*/
import { parseIncompletePhoneNumber } from 'libphonenumber-js/min'
import { examplePhone, exceedsPhoneLength, formatPhoneAsTyped, listPhoneCountries, parsePhone, type CountryCode } from '~/utils/phone'

const props = withDefaults(defineProps<{
  id: string
  /** The country national digits are read in until the person picks another: the business or location's. */
  defaultCountry?: CountryCode
  autofocus?: boolean
  required?: boolean
  disabled?: boolean
}>(), { autofocus: false, required: false, disabled: false })
const model = defineModel<string>({ default: '' })
const { t, locale } = useI18n()
const field = ref<{ inputRef: HTMLInputElement | null } | null>(null)
const input = computed(() => field.value?.inputRef ?? null)
const touched = ref(false)
const chosen = defineModel<CountryCode | undefined>('country')
const country = computed(() => chosen.value ?? props.defaultCountry)
const display = ref('')

const countries = computed(() => {
  const names = new Intl.DisplayNames(locale.value, { type: 'region' })
  return listPhoneCountries()
    .map(item => ({ ...item, name: names.of(item.code) ?? item.name }))
    .sort((a, b) => a.name.localeCompare(b.name, locale.value))
})
const selectedCountry = computed(() => countries.value.find(item => item.code === country.value))
const placeholder = computed(() => (country.value && examplePhone(country.value)) || t('saya.experience_detail.phone_number'))

const isInternational = (value: string) => value.trim().startsWith('+')
const parsed = computed(() => parsePhone(display.value, isInternational(display.value) || !country.value ? undefined : { defaultCountry: country.value }))
const validationMessage = computed(() => {
  if (!display.value.trim()) return props.required ? t('booking.phone_required') : ''
  return parsed.value.valid ? '' : t('booking.invalid_phone')
})
const error = computed(() => touched.value ? validationMessage.value : '')
watchEffect(() => input.value?.setCustomValidity(validationMessage.value))

function validate() {
  touched.value = true
  input.value?.focus()
}

let emitted: string | undefined
function show(value: string) {
  display.value = value
  emitted = parsed.value.valid && parsed.value.e164 ? parsed.value.e164 : value.trim()
  model.value = emitted
}

/** A value the parent set (a saved number, a draft, a reset) is shown in the country it belongs to. */
function load(value: string) {
  const number = parsePhone(value)
  if (number.valid && number.country) {
    chosen.value = number.country
    show(formatPhoneAsTyped(number.nationalFormat ?? value, number.country))
    return
  }
  show(value)
}
load(model.value)
watch(model, value => { if (value !== emitted) load(value) })

/**
 * Format what is typed. An international number moves the picker to its own
 * country, and once complete reads nationally there, as a saved number does.
 */
function format(value: string): string {
  if (!isInternational(value)) return formatPhoneAsTyped(value, country.value)
  const number = parsePhone(value)
  if (!number.country) return formatPhoneAsTyped(value)
  chosen.value = number.country
  return number.valid && number.nationalFormat ? formatPhoneAsTyped(number.nationalFormat, number.country) : formatPhoneAsTyped(value)
}

function selectCountry(value: CountryCode | undefined) {
  if (!value) return
  // A number already complete keeps its digits, read nationally in the new country.
  const digits = parsed.value.valid ? parsed.value.nationalFormat ?? display.value : display.value
  chosen.value = value
  show(formatPhoneAsTyped(digits, value))
  nextTick(() => input.value?.focus())
}

function update(target: HTMLInputElement, value: string, caret: number) {
  const formatted = format(value)
  // The caret stays after the same count of digits when spacing changes around it.
  const wanted = parseIncompletePhoneNumber(value.slice(0, caret)).length
  let position = 0
  let count = 0
  while (position < formatted.length && count < wanted) {
    if (/[\d+]/.test(formatted[position]!)) count++
    position++
  }
  if (caret === value.length) position = formatted.length
  target.value = formatted
  show(formatted)
  nextTick(() => {
    if (document.activeElement === target) target.setSelectionRange(position, position)
  })
}

function onInput(event: Event) {
  if (event instanceof InputEvent && event.isComposing) return
  const target = event.target as HTMLInputElement
  update(target, target.value, target.selectionStart ?? target.value.length)
}

function beforeInput(event: InputEvent) {
  if (event.isComposing) return
  const target = event.target as HTMLInputElement
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? start
  const inserted = event.data ?? event.dataTransfer?.getData('text') ?? ''
  if (inserted) {
    // Digits past the end of the country's numbering plan are refused, not typed and then flagged.
    const candidate = target.value.slice(0, start) + inserted + target.value.slice(end)
    if (country.value && !isInternational(candidate) && exceedsPhoneLength(candidate, country.value)) event.preventDefault()
    return
  }
  if (start !== end || !['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)) return
  const backward = event.inputType === 'deleteContentBackward'
  let edge = backward ? start - 1 : start
  if (!target.value[edge] || /[\d+]/.test(target.value[edge]!)) return
  // Deleting a separator also removes the digit beside it; otherwise the
  // formatter puts the separator back and Backspace/Delete stops there.
  while (edge >= 0 && edge < target.value.length && !/[\d+]/.test(target.value[edge]!)) edge += backward ? -1 : 1
  const from = backward ? Math.max(0, edge) : start
  const to = backward ? end : Math.min(target.value.length, edge + 1)
  event.preventDefault()
  update(target, target.value.slice(0, from) + target.value.slice(to), from)
}
</script>
