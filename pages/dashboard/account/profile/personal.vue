<template>
  <DashboardLeafPanel id="account-personal" title="Personal information" :footer="false">
    <div class="divide-y divide-default">
      <!-- Photo -->
      <div class="py-6">
        <div class="flex items-center justify-between gap-4">
          <div class="flex min-w-0 items-center gap-4">
            <UAvatar :src="account.photoPreview.value ?? account.sessionData.value?.user?.image ?? undefined" icon="i-lucide-user" alt="" class="size-24" :ui="{ icon: 'size-10' }" />
            <div class="min-w-0">
              <p class="font-semibold text-highlighted">Photo</p>
              <p class="mt-1 text-sm leading-relaxed text-muted">A familiar face for your account.</p>
            </div>
          </div>
          <UButton variant="link" color="neutral" class="shrink-0" :label="account.editing.value === 'photo' ? 'Cancel' : 'Edit'" @click="account.toggleEdit('photo')" />
        </div>
        <p v-if="account.photoError.value" class="mt-4 text-sm text-error" role="alert">{{ account.photoError.value }}</p>
        <UInput v-if="account.editing.value === 'photo'" type="file" accept="image/*" aria-label="Account photo" class="mt-4 w-full" :disabled="account.photoSaving.value" @change="account.pickPhoto" />
      </div>

      <!-- Display name -->
      <div class="py-6">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm text-muted">Display name</p>
            <p v-if="account.editing.value !== 'name'" class="mt-1 break-words text-lg font-medium" :class="account.sessionData.value?.user?.name ? 'text-highlighted' : 'italic text-dimmed'">{{ account.sessionData.value?.user?.name || 'Not provided' }}</p>
          </div>
          <UButton variant="link" color="neutral" class="shrink-0" :label="account.editing.value === 'name' ? 'Cancel' : account.sessionData.value?.user?.name ? 'Edit' : 'Add'" @click="account.toggleEdit('name')" />
        </div>
        <div v-if="account.editing.value === 'name'" class="mt-4 space-y-4">
          <UInput v-model="account.nameInput.value" aria-label="Display name" autofocus class="w-full" @input="account.nameTouched.value = true" @keydown.enter="account.saveNameInline" />
          <p v-if="account.nameError.value" class="text-sm text-error" role="alert">{{ account.nameError.value }}</p>
          <UButton label="Save" :loading="account.nameSaving.value" :disabled="!account.nameDirty.value" @click="account.saveNameInline" />
        </div>
      </div>

      <!-- WhatsApp number -->
      <div class="py-6">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="font-semibold text-highlighted">WhatsApp number</p>
            <p v-if="account.editing.value !== 'phone'" class="mt-1 text-sm" :class="account.sessionData.value?.user?.phoneNumber ? 'text-muted' : 'italic text-dimmed'">
              {{ account.sessionData.value?.user?.phoneNumber ? formatPhone(account.sessionData.value.user.phoneNumber) : 'Not provided' }}
              <UBadge v-if="account.sessionData.value?.user?.phoneNumber" :color="account.sessionData.value?.user?.phoneNumberVerified ? 'success' : 'warning'" variant="subtle" size="sm" class="ms-2">{{ account.sessionData.value?.user?.phoneNumberVerified ? 'Verified' : 'Not verified' }}</UBadge>
            </p>
            <p class="mt-1 text-sm text-dimmed">Notifications and codes are sent over WhatsApp.</p>
          </div>
          <UButton variant="link" color="neutral" class="shrink-0" :label="account.editing.value === 'phone' ? 'Cancel' : account.sessionData.value?.user?.phoneNumber ? 'Edit' : 'Add'" @click="account.toggleEdit('phone')" />
        </div>
        <div v-if="account.editing.value === 'phone'" class="mt-4 space-y-4">
          <PhoneInput id="account-phone" v-model="account.phoneInput.value" autofocus @input="account.phoneTouched.value = true" @keydown.enter="account.requestPhoneVerify" />
          <p v-if="account.phoneError.value" class="text-sm text-error" role="alert">{{ account.phoneError.value }}</p>
          <UButton label="Verify and save" :loading="account.phoneSaving.value" :disabled="!account.phoneDirty.value || !account.phoneInput.value.trim()" @click="account.requestPhoneVerify" />
        </div>
      </div>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import PhoneInput from '~/components/PhoneInput.vue'
import { accountEditorKey } from '~/components/dashboard/AccountProfilePage.vue'

definePageMeta({ layout: 'dashboard' })

const account = inject(accountEditorKey)!
</script>
