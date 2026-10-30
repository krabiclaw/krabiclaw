import { authClient } from '~/lib/auth-client'
import { googleSignInOptions } from '~/shared/auth/oauth-login'

export interface UseAuthOperationResult {
  loading: Readonly<Ref<boolean>>
  error: Ref<string | null>
  run: <T>(operation: () => Promise<T>, fallback: string) => Promise<T | null>
  signInWithGoogle: (callbackURL?: string, loginHint?: string) => Promise<unknown>
  signInWithApple: (callbackURL?: string) => Promise<unknown>
}

export function useAuthOperation(): UseAuthOperationResult {
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function run<T>(operation: () => Promise<T>, fallback: string): Promise<T | null> {
    if (loading.value) return null
    loading.value = true
    error.value = null
    try {
      return await operation()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : fallback
      return null
    } finally {
      loading.value = false
    }
  }

  async function signInWithGoogle(callbackURL?: string, loginHint?: string) {
    return run(async () => {
      const result = await authClient.signIn.social(googleSignInOptions(callbackURL, loginHint))
      if (result?.error) throw new Error(result.error.message || 'Google sign in failed.')
      return result
    }, 'Google sign in failed. Please try again.')
  }

  async function signInWithApple(callbackURL?: string) {
    return run(async () => {
      const result = await authClient.signIn.social({ provider: 'apple', ...(callbackURL ? { callbackURL } : {}) })
      if (result?.error) throw new Error(result.error.message || 'Apple sign in failed.')
      return result
    }, 'Apple sign in failed. Please try again.')
  }

  return { loading: readonly(loading), error, run, signInWithGoogle, signInWithApple }
}
