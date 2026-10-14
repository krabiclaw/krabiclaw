export const TENANT_TYPES = {
  PLATFORM: 'platform',
  TENANT: 'tenant',
} as const

export type TenantType = (typeof TENANT_TYPES)[keyof typeof TENANT_TYPES]
