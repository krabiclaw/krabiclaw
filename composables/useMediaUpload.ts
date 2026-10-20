import { getErrorMessage } from '~/utils/errors'

// The same limits the upload route enforces. A second, smaller number here
// meant the dashboard refused images MCP accepted.
export const IMAGE_MAX_SIZE_BYTES = 20 * 1024 * 1024
export const VIDEO_MAX_SIZE_BYTES = 50 * 1024 * 1024

export interface MediaUploadOptions {
  category?: string | null
}

export interface MediaUploadResult {
  asset_id: string
  kind: 'image' | 'video'
  public_url?: string | null
  thumbnail_url?: string
}

export function useMediaUpload(organizationApiBase: string) {
  const dashboardApi = useDashboardApi()
  const uploading = ref(false)
  const error = ref<string | null>(null)

  async function upload(file: File, options: MediaUploadOptions = {}): Promise<MediaUploadResult | null> {
    if (uploading.value) return null

    uploading.value = true
    error.value = null

    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')

    try {
      if (!isImage && !isVideo) {
        error.value = 'Only images and videos are supported.'
        return null
      }

      if (isImage && file.size > IMAGE_MAX_SIZE_BYTES) {
        error.value = `Images must be under ${formatBytes(IMAGE_MAX_SIZE_BYTES)}.`
        return null
      }

      if (isVideo && file.size > VIDEO_MAX_SIZE_BYTES) {
        error.value = `Videos must be under ${formatBytes(VIDEO_MAX_SIZE_BYTES)}.`
        return null
      }

      const form = new FormData()
      if (isImage) form.append('image', file)
      else {
        form.append('video', file)
        form.append('thumbnail', await generateVideoThumbnail(file))
      }

      // An image has no separate poster unless the provider made one: an AVIF
      // goes to R2 and answers with a null thumbnail. A video always has one.
      const response = await dashboardApi<{
        asset_id: string
        kind: 'image' | 'video'
        public_url: string
        thumbnail_url: string | null
        status: 'active'
      }>(`${organizationApiBase}/media/upload`, {
        method: 'POST',
        body: form,
        query: {
          filename: file.name,
          category: options.category || undefined,
        },
        validate: (value): value is {
          asset_id: string
          kind: 'image' | 'video'
          public_url: string
          thumbnail_url: string | null
          status: 'active'
        } => isRecord(value)
          && typeof value.asset_id === 'string'
          && (value.kind === 'image' || value.kind === 'video')
          && typeof value.public_url === 'string'
          && (typeof value.thumbnail_url === 'string' || value.thumbnail_url === null)
          && (value.kind === 'image' || typeof value.thumbnail_url === 'string')
          && value.status === 'active',
      })

      return {
        asset_id: response.asset_id,
        kind: response.kind,
        public_url: response.public_url,
        thumbnail_url: response.thumbnail_url ?? undefined,
      }
    } catch (uploadError) {
      error.value = getErrorMessage(uploadError, 'Upload failed.')
      throw uploadError
    } finally {
      uploading.value = false
    }
  }

  return {
    uploading,
    error,
    upload,
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
