import type { DbClient } from '../../../server/db/index.ts'
import { loadConversationPage } from '../../../server/domain/conversation-history.ts'
import { resolveConversationAccess, type ConversationWindow } from '../../../server/domain/conversations.ts'
import type { MemberAccessPrincipal } from '../../../server/utils/member-access.ts'

export async function conversationPageFor(
  db: DbClient,
  viewer: MemberAccessPrincipal | string,
  id: string,
  window: ConversationWindow = { before: null, limit: 40 },
  now?: Date,
) {
  const principal = typeof viewer === 'string' ? null : viewer
  const userId = typeof viewer === 'string' ? viewer : viewer.userId
  const access = await resolveConversationAccess(db, userId, id)
  return loadConversationPage(db, { ...access, userId, principal }, window, now)
}
