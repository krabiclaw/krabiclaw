import type { DbClient } from '../../../server/db/index.ts'
import { loadConversationPage } from '../../../server/domain/conversation-history.ts'
import type { ConversationWindow } from '../../../server/domain/conversations.ts'
import type { MemberAccessPrincipal } from '../../../server/utils/member-access.ts'

export async function conversationPageFor(
  db: DbClient,
  viewer: MemberAccessPrincipal | string,
  id: string,
  window: ConversationWindow & { before: null } = { before: null, limit: 40 },
  now?: Date,
) {
  const principal = typeof viewer === 'string' ? null : viewer
  const userId = typeof viewer === 'string' ? viewer : viewer.userId
  return loadConversationPage(db, { conversationId: id, userId, organizationId: principal?.organizationId }, window, now)
}
