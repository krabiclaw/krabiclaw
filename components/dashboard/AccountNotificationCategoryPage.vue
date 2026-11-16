<template>
  <!-- A new revision is a fresh form: Cancel puts the draft back and clears what the form saw as changed. -->
  <UForm v-if="setting" ref="form" :key="revision" :state="draft" class="space-y-6" @submit="save">
    <UAlert v-if="failure" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="failure" />

    <div>
      <UFormField name="email" class="border-b border-default">
        <SettingRow v-model="draft.email" label="Email" :disabled="emailLocked || saving" />
      </UFormField>
      <UFormField name="whatsapp" class="border-b border-default">
        <SettingRow v-model="draft.whatsapp" label="WhatsApp" :disabled="!phoneVerified || saving" />
      </UFormField>
      <!-- Reaches every device the person registered: the KrabiClaw app and subscribed browsers. -->
      <UFormField name="push">
        <SettingRow :model-value="draft.push" label="Push" :description="pushLine" :disabled="saving || enablingPush" @update:model-value="setPush">
          <UButton v-if="offHere" label="Turn on" color="neutral" variant="link" class="p-0" :loading="enablingPush" @click="turnOnHere" />
        </SettingRow>
      </UFormField>
    </div>

    <NuxtLink v-if="!phoneVerified" to="/dashboard/account/profile/personal" class="block text-sm text-muted underline underline-offset-2">
      Add a WhatsApp number
    </NuxtLink>
  </UForm>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { authClient } from '~/lib/auth-client'
import { isMandatoryEmailCategory, isNotificationCategory, type NotificationCategory } from '~/shared/notification-categories'

// The category is passed in rather than read from the route, because the index
// route renders this leaf for the first category with no segment of its own.
const props = defineProps<{ category: NotificationCategory }>()

const session = authClient.useSession()
const sessionData = computed(() => session.value.data)
const { preferences, save: savePreferences } = useNotificationPreferences(() => sessionData.value?.user?.id)

if (!isNotificationCategory(props.category)) throw createError({ statusCode: 404, statusMessage: 'Page not found' })

const setting = computed(() => preferences.value?.[props.category] ?? null)
const emailLocked = computed(() => isMandatoryEmailCategory(props.category))
const phoneVerified = computed(() => Boolean(sessionData.value?.user?.phoneNumberVerified))

const draft = reactive({ email: true, whatsapp: false, push: false })
const saving = ref(false)
const failure = ref('')

// Re-seeded whenever the stored value or the open category changes, so
// navigating between categories never leaves the previous one's draft behind.
watchEffect(() => {
  const current = setting.value
  if (!current || saving.value) return
  draft.email = current.email
  draft.whatsapp = current.whatsapp
  draft.push = current.push
})

// Push is the person's choice for every device; whether this browser is one of
// them is said under the switch, and turning it on here asks this browser.
const pushSubscription = usePushSubscription()
const enablingPush = ref(false)
onMounted(() => {
  void pushSubscription.refresh().catch((cause) => { failure.value = cause instanceof Error ? cause.message : 'Could not read this browser\'s notification permission.' })
})
const offHere = computed(() => draft.push && pushSubscription.state.value.availability === 'available' && !pushSubscription.state.value.subscribed)
const pushLine = computed(() => {
  const { availability, ios } = pushSubscription.state.value
  if (availability === 'blocked') return 'Blocked in this browser. Allow it in site settings.'
  if (availability === 'unsupported') return ios ? 'On iPhone, add KrabiClaw to your Home Screen first.' : 'This browser can\'t show notifications.'
  return offHere.value ? 'Not on in this browser.' : undefined
})

async function turnOnHere() {
  enablingPush.value = true
  failure.value = ''
  try {
    return await pushSubscription.enable()
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Could not turn on notifications in this browser.'
    return false
  } finally {
    enablingPush.value = false
  }
}

// Switching Push on is the click the browser's permission prompt needs.
async function setPush(on: boolean) {
  draft.push = on
  if (on && pushSubscription.state.value.availability === 'available' && !pushSubscription.state.value.subscribed) await turnOnHere()
}

const form = useTemplateRef('form')
const revision = ref(0)
const dirty = computed(() => Boolean(form.value?.dirty || failure.value))

function cancel() {
  if (!setting.value) return
  draft.email = setting.value.email
  draft.whatsapp = setting.value.whatsapp
  draft.push = setting.value.push
  failure.value = ''
  revision.value += 1
}

async function save() {
  saving.value = true
  failure.value = ''
  try {
    await savePreferences(props.category, { email: draft.email, whatsapp: draft.whatsapp, push: draft.push })
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Saving failed. Please try again.'
  } finally {
    saving.value = false
  }
}

// The page it sits in owns the Cancel/Save row, so every leaf commits the same way.
defineExpose({ dirty, saving, cancel, commit: () => form.value?.submit() })
</script>
