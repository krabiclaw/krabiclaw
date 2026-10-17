<template>
  <UIcon v-if="icon" :name="icon" />
</template>

<script setup lang="ts">
const props = defineProps<{ name?: string | null }>()

const LUCIDE_BY_HEROICON: Record<string, string> = {
  AcademicCapIcon: 'i-lucide-graduation-cap',
  AdjustmentsHorizontalIcon: 'i-lucide-sliders-horizontal',
  BriefcaseIcon: 'i-lucide-briefcase',
  BuildingOffice2Icon: 'i-lucide-building-2',
  BuildingOfficeIcon: 'i-lucide-building',
  CalendarIcon: 'i-lucide-calendar',
  ChatBubbleBottomCenterTextIcon: 'i-lucide-message-square-text',
  ChatBubbleLeftRightIcon: 'i-lucide-messages-square',
  CheckIcon: 'i-lucide-check',
  ClipboardDocumentCheckIcon: 'i-lucide-clipboard-check',
  ClipboardDocumentListIcon: 'i-lucide-clipboard-list',
  ClipboardIcon: 'i-lucide-clipboard',
  CurrencyDollarIcon: 'i-lucide-circle-dollar-sign',
  DocumentCheckIcon: 'i-lucide-file-check',
  DocumentTextIcon: 'i-lucide-file-text',
  ExclamationCircleIcon: 'i-lucide-circle-alert',
  ExclamationTriangleIcon: 'i-lucide-triangle-alert',
  HandshakeIcon: 'i-lucide-handshake',
  HeartIcon: 'i-lucide-heart',
  LockClosedIcon: 'i-lucide-lock',
  PowerIcon: 'i-lucide-power',
  ScaleIcon: 'i-lucide-scale',
  ShieldCheckIcon: 'i-lucide-shield-check',
  ShieldExclamationIcon: 'i-lucide-shield-alert',
  StarIcon: 'i-lucide-star',
  UserGroupIcon: 'i-lucide-users',
  UserIcon: 'i-lucide-user',
  UsersIcon: 'i-lucide-users-round',
  WrenchIcon: 'i-lucide-wrench',
  XCircleIcon: 'i-lucide-circle-x',
}

const icon = computed(() => {
  return props.name ? LUCIDE_BY_HEROICON[props.name] ?? null : null
})
</script>
