<template>
  <DashboardLeafPanel id="account-personal" title="Personal information" :footer="false">
    <div class="divide-y divide-default">
      <!-- Photo -->
      <div class="flex items-start justify-between gap-4 py-5">
        <div class="flex min-w-0 items-center gap-4">
          <UAvatar :src="account.photoPreview.value ?? account.sessionData.value?.user?.image ?? undefined" icon="i-lucide-user" alt="" class="size-16" :ui="{ icon: 'size-8' }" />
          <div class="min-w-0">
            <p class="font-semibold text-highlighted">Photo</p>
            <p v-if="account.photoError.value" class="mt-1 text-sm text-error">{{ account.photoError.value }}</p>
            <UInput v-if="account.editing.value === 'photo'" type="file" accept="image/*" class="mt-3 w-full" :disabled="account.photoSaving.value" @change="account.pickPhoto" />
          </div>
        </div>
        <UButton variant="link" color="neutral" class="shrink-0" :label="account.editing.value === 'photo' ? 'Cancel' : 'Edit'" @click="account.toggleEdit('photo')" />
      </div>

      <!-- Display name -->
      <div class="py-5">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="font-semibold text-highlighted">Display name</p>
            <p v-if="account.editing.value !== 'name'" class="mt-1 text-sm" :class="account.sessionData.value?.user?.name ? 'text-muted' : 'italic text-dimmed'">{{ account.sessionData.value?.user?.name || 'Not provided' }}</p>
          </div>
          <UButton variant="link" color="neutral" class="shrink-0" :label="account.editing.value === 'name' ? 'Cancel' : account.sessionData.value?.user?.name ? 'Edit' : 'Add'" @click="account.toggleEdit('name')" />
        </div>
        <div v-if="account.editing.value === 'name'" class="mt-4 space-y-4">
          <UInput v-model="account.nameInput.value" autofocus class="w-full" @input="account.nameTouched.value = true" @keydown.enter="account.saveNameInline" />
          <p v-if="account.nameError.value" class="text-sm text-error">{{ account.nameError.value }}</p>
          <UButton label="Save" :loading="account.nameSaving.value" :disabled="!account.nameDirty.value" @click="account.saveNameInline" />
        </div>
      </div>

      <!-- WhatsApp number -->
      <div class="py-5">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="font-semibold text-highlighted">WhatsApp number</p>
            <p v-if="account.editing.value !== 'phone'" class="mt-1 text-sm" :class="account.sessionData.value?.user?.phoneNumber ? 'text-muted' : 'italic text-dimmed'">
              {{ account.sessionData.value?.user?.phoneNumber || 'Not provided' }}
              <UBadge v-if="account.sessionData.value?.user?.phoneNumber" :color="account.sessionData.value?.user?.phoneNumberVerified ? 'success' : 'warning'" variant="subtle" size="sm" class="ms-2">{{ account.sessionData.value?.user?.phoneNumberVerified ? 'Verified' : 'Not verified' }}</UBadge>
            </p>
            <p class="mt-1 text-sm text-dimmed">Notifications and codes are sent over WhatsApp.</p>
          </div>
          <UButton variant="link" color="neutral" class="shrink-0" :label="account.editing.value === 'phone' ? 'Cancel' : account.sessionData.value?.user?.phoneNumber ? 'Edit' : 'Add'" @click="account.toggleEdit('phone')" />
        </div>
        <div v-if="account.editing.value === 'phone'" class="mt-4 space-y-4">
          <UInput v-model="account.phoneInput.value" type="tel" placeholder="Phone number with country code" autofocus class="w-full" @input="account.phoneTouched.value = true" @keydown.enter="account.requestPhoneVerify" />
          <p v-if="account.phoneError.value" class="text-sm text-error">{{ account.phoneError.value }}</p>
          <UButton label="Verify and save" :loading="account.phoneSaving.value" :disabled="!account.phoneDirty.value || !account.phoneInput.value.trim()" @click="account.requestPhoneVerify" />
        </div>
      </div>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { accountEditorKey } from '~/components/dashboard/AccountProfilePage.vue'

definePageMeta({ layout: 'dashboard' })

const account = inject(accountEditorKey)!
</script>
