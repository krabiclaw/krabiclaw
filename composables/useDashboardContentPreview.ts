import { type ComponentPublicInstance, type MaybeRefOrGetter, toValue } from 'vue'
import { isNavigationFailure } from 'vue-router'
import { dashboardOverlayOpenKey } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import { getErrorMessage } from '~/utils/errors'

/** Preview is a mode of its existing editor, including on reload and from MCP links. */
export function useDashboardContentPreview(
  sourceError: MaybeRefOrGetter<string | null | undefined>,
  clearQuery: readonly string[] = [],
) {
  const route = useRoute()
  const router = useRouter()
  const previewButton = useTemplateRef<ComponentPublicInstance>('previewButton')
  const requested = computed(() => route.query.editMode === 'preview')
  provide(dashboardOverlayOpenKey, requested)
  const previewViewport = computed(() => route.query.previewViewport === undefined ? 'desktop'
    : route.query.previewViewport === 'desktop' || route.query.previewViewport === 'mobile' ? route.query.previewViewport : null)
  const navigationError = ref('')
  const previewPath = computed(() => router.resolve({
    path: route.path, query: { ...route.query, editMode: 'preview', previewViewport: 'desktop' }, hash: route.hash,
  }).fullPath)
  const previewFailure = computed(() => navigationError.value || toValue(sourceError)
    || (!previewViewport.value ? 'Choose Desktop view or Mobile view to open this preview.' : ''))
  const previewOpen = computed({
    get: () => requested.value,
    set: (open: boolean) => { if (!open) void closePreview() },
  })

  watch(() => route.fullPath, () => { navigationError.value = '' })

  async function closePreview() {
    try {
      const result = await navigateTo({
        path: route.path,
        query: { ...route.query, editMode: undefined, previewViewport: undefined, ...Object.fromEntries(clearQuery.map(key => [key, undefined])) },
        hash: route.hash,
      })
      if (isNavigationFailure(result)) throw result
    } catch (error) {
      navigationError.value = getErrorMessage(error, 'The preview could not be closed')
    }
  }

  async function changePreviewViewport(value: string | number) {
    if (value !== 'desktop' && value !== 'mobile') return
    try {
      const result = await navigateTo({ path: route.path, query: { ...route.query, previewViewport: value }, hash: route.hash }, { replace: true })
      if (isNavigationFailure(result)) throw result
    } catch (error) {
      navigationError.value = getErrorMessage(error, 'The preview device could not be changed')
    }
  }

  function restorePreviewFocus() {
    const element = previewButton.value?.$el
    if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true })
  }

  return { previewButton, previewPath, previewOpen, previewViewport, previewFailure, changePreviewViewport, restorePreviewFocus }
}
