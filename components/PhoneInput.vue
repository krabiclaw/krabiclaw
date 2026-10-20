<template>
  <div>
    <div
      class="flex rounded-lg border bg-default transition-colors focus-within:ring-2 focus-within:ring-inset"
      :class="error ? 'border-error focus-within:ring-error' : 'border-(--kc-field-border) focus-within:border-primary focus-within:ring-primary'"
    >
      <USelectMenu
        :model-value="countryCode === '' ? 'international' : countryCode"
        :items="countries"
        value-key="code"
        label-key="name"
        :filter-fields="['name', 'code', 'dialCode']"
        :aria-label="selectedCountry ? `${t('booking.phone_country')}: ${selectedCountry.name} (${selectedCountry.dialCode})` : t('booking.phone_country')"
        :disabled="disabled"
        :portal="false"
        :search-input="{ id: `${id}-country-search`, placeholder: t('booking.search_phone_countries') }"
        :content="{ align: 'start' }"
        :ui="{
          base: 'h-full rounded-none rounded-s-lg border-0 bg-transparent px-3 py-2.5 text-default shadow-none ring-0 focus-visible:ring-0',
          content: 'z-50 w-72 max-w-[calc(100vw-3rem)]',
          trailingIcon: 'size-4',
        }"
        class="shrink-0 border-e border-(--kc-field-border)"
        @update:model-value="selectCountry"
      >
        <span class="flex items-center gap-1.5 text-sm font-medium">
          <span v-if="selectedCountry" aria-hidden="true" class="text-base leading-none">{{ selectedCountry.emoji }}</span>
          <span>{{ selectedCountry?.dialCode ?? t('booking.phone_country_code') }}</span>
        </span>
        <template #content-top>
          <label :for="`${id}-country-search`" class="sr-only">{{ t('booking.search_phone_countries') }}</label>
        </template>
        <template #item-leading="{ item }">
          <span v-if="item.emoji" aria-hidden="true" class="text-base leading-none">{{ item.emoji }}</span>
        </template>
        <template #item-label="{ item }">{{ item.name }} ({{ item.dialCode }})</template>
      </USelectMenu>
      <input
        :id="id"
        ref="input"
        :value="model"
        type="tel"
        inputmode="tel"
        autocomplete="tel"
        :required="required"
        :disabled="disabled"
        :placeholder="placeholder"
        :aria-invalid="error ? true : undefined"
        :aria-describedby="[!countryCode ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined"
        class="min-w-0 flex-1 rounded-e-lg bg-transparent px-3.5 py-2.5 text-base text-default placeholder:text-muted focus:outline-none disabled:opacity-50"
        @beforeinput="beforeInput"
        @input="onInput"
        @compositionend="onInput"
        @blur="touched = true"
        @invalid.prevent="validate"
      />
    </div>
    <p v-if="!countryCode" :id="`${id}-hint`" class="mt-1.5 text-sm text-muted">{{ t('booking.phone_international_hint') }}</p>
    <p v-if="error" :id="`${id}-error`" role="alert" class="mt-1.5 text-sm text-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { getExampleNumber, parseIncompletePhoneNumber } from 'libphonenumber-js/min'
import examples from 'libphonenumber-js/mobile/examples'
import { formatPhoneAsTyped, listPhoneCountries, parsePhone, type CountryCode } from '~/utils/phone'

const props = withDefaults(defineProps<{
  id: string
  defaultCountry?: CountryCode
  required?: boolean
  disabled?: boolean
}>(), { required: false, disabled: false })
const model = defineModel<string>({ default: '' })
const country = defineModel<CountryCode | ''>('country')
const { t, locale } = useI18n()
const input = ref<HTMLInputElement | null>(null)
const touched = ref(false)
// An explicit empty country means international mode, including after remount.
const initialCountry = country.value ?? (model.value.trim().startsWith('+')
  ? parsePhone(model.value).country ?? undefined
  : props.defaultCountry)
const countryCode = computed(() => country.value)
if (initialCountry !== undefined) country.value = initialCountry

const countries = computed(() => {
  const names = new Intl.DisplayNames(locale.value, { type: 'region' })
  return [
    { code: 'international' as const, name: t('booking.phone_international'), dialCode: '+', emoji: '' },
    ...listPhoneCountries().map(item => ({ ...item, name: names.of(item.code) ?? item.name }))
      .sort((a, b) => a.name.localeCompare(b.name, locale.value)),
  ]
})
const selectedCountry = computed(() => countries.value.find(item => item.code === countryCode.value))
const placeholder = computed(() => countryCode.value
  ? getExampleNumber(countryCode.value, examples)?.formatNational() ?? t('saya.experience_detail.phone_number')
  : t('saya.experience_detail.phone_number'))
const parsed = computed(() => parsePhone(model.value, countryCode.value ? { defaultCountry: countryCode.value } : undefined))
const validationMessage = computed(() => {
  if (!model.value.trim()) return props.required ? t('booking.phone_required') : ''
  return parsed.value.valid && parsed.value.e164 ? '' : t('booking.invalid_phone')
})
const error = computed(() => touched.value ? validationMessage.value : '')
watchEffect(() => input.value?.setCustomValidity(validationMessage.value))

function validate(): boolean {
  touched.value = true
  if (!validationMessage.value) return true
  input.value?.focus()
  return false
}
defineExpose({ validate })

let lastEmitted = model.value
function setValue(value: string) {
  lastEmitted = value
  model.value = value
}

function selectCountry(value: CountryCode | 'international' | undefined) {
  if (!value) return
  const nextCountry = value === 'international' ? '' : value
  // Changing the interpretation keeps the digits editable. International mode
  // carries the full number, and a country mode carries its national input.
  const valueToFormat = nextCountry
    ? model.value.trim().startsWith('+') ? parsed.value.nationalFormat ?? model.value : model.value
    : parsed.value.valid ? parsed.value.e164 ?? model.value : model.value
  country.value = nextCountry
  setValue(formatPhoneAsTyped(valueToFormat, nextCountry || undefined))
  nextTick(() => input.value?.focus())
}

/** Normalize a complete international number without displaying its prefix twice. */
function formatInput(value: string): string {
  if (value.trim().startsWith('+')) {
    if (countryCode.value === '') return formatPhoneAsTyped(value)
    const number = parsePhone(value)
    country.value = number.country ?? undefined
    if (number.valid && number.country && number.nationalFormat) return number.nationalFormat
    return formatPhoneAsTyped(value)
  }
  return formatPhoneAsTyped(value, countryCode.value || undefined)
}

// Parent replacements (saved numbers/reset) follow the same path as paste;
// our own keystrokes and explicit international selection are already formatted.
watch(model, value => {
  if (value !== lastEmitted) setValue(formatInput(value))
})
if (model.value.trim().startsWith('+') && initialCountry) {
  const number = parsePhone(model.value)
  if (number.country === initialCountry && number.valid && number.nationalFormat) setValue(number.nationalFormat)
}

function updateInput(target: HTMLInputElement, value: string, caret: number) {
  const formatted = formatInput(value)
  // The library owns digit normalization; the DOM caret follows the same count
  // of phone characters when spacing or an international prefix changes.
  const charsBefore = parseIncompletePhoneNumber(value.slice(0, caret)).length
  const delta = parseIncompletePhoneNumber(formatted).length - parseIncompletePhoneNumber(value).length
  const wanted = Math.max(0, charsBefore + delta)
  let position = 0
  let count = 0
  while (position < formatted.length && count < wanted) {
    if (/[\d+]/.test(formatted[position]!)) count++
    position++
  }
  if (caret === value.length) position = formatted.length
  target.value = formatted
  setValue(formatted)
  nextTick(() => {
    if (document.activeElement === target) target.setSelectionRange(position, position)
  })
}

function onInput(event: Event) {
  if (event instanceof InputEvent && event.isComposing) return
  const target = event.target as HTMLInputElement
  updateInput(target, target.value, target.selectionStart ?? target.value.length)
}

function beforeInput(event: InputEvent) {
  if (event.isComposing || !['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)) return
  const target = event.target as HTMLInputElement
  const start = target.selectionStart ?? 0
  const end = target.selectionEnd ?? start
  if (start !== end) return
  const backward = event.inputType === 'deleteContentBackward'
  let edge = backward ? start - 1 : start
  if (!target.value[edge] || /[\d+]/.test(target.value[edge]!)) return
  // Deleting a separator must also remove the adjacent digit, otherwise the
  // formatter would reinsert the separator and trap Backspace/Delete there.
  while (edge >= 0 && edge < target.value.length && !/[\d+]/.test(target.value[edge]!)) edge += backward ? -1 : 1
  const from = backward ? Math.max(0, edge) : start
  const to = backward ? end : Math.min(target.value.length, edge + 1)
  event.preventDefault()
  updateInput(target, target.value.slice(0, from) + target.value.slice(to), from)
}
</script>
