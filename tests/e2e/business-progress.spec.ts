import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { expect, request as playwrightRequest, test, type APIResponse } from '@playwright/test'
import sharp from 'sharp'
import type { BusinessOutcomePage, BusinessProgressReference } from '../../shared/business-outcomes'
import type { BusinessGoal } from '../../shared/business-progress'
import type { TaskSection, TaskView } from '../../server/domain/tasks'
import type { OpportunityView } from '../../server/domain/opportunities'
import type { InboxRow } from '../../server/domain/guest-threads/types'
import type { ConversationPage } from '../../shared/messages-contract'
import { acceptOrganizationInvitation, authRequestHeaders, loginAs, sendOrganizationInvitation } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { seededTenant } from './seed/manifest'

type Progress = BusinessOutcomePage & { goals: BusinessGoal[] }

async function responseBody<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return response.json() as Promise<T>
}

test('authored goals and evidence-bound opportunity decisions follow persisted work', async ({ request, baseURL }) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'This journey writes only to disposable local D1 data.')
  test.setTimeout(300_000)
  const actorId = 'user-e2e-onboarding-wizard'
  await loginAs(request, baseURL!, actorId)
  const slug = `e2e-progress-${crypto.randomUUID().slice(0, 8)}`
  const name = `Progress Legal Practice ${slug}`
  const organization = await responseBody<{ id: string }>(await request.post('/api/auth/organization/create', {
    headers: authRequestHeaders(baseURL!), data: { name, slug, default_currency: 'USD', timezone: 'America/New_York' },
  }))
  const api = `/api/organizations/${organization.id}`
  const editor = `/api/editor/organizations/${organization.id}/blog`
  const member = await playwrightRequest.newContext({ baseURL })
  try {
    const provisioned = await responseBody<{ organization_id: string }>(await request.post('/api/organizations', {
      data: { organization_id: organization.id, name, subdomain: slug, vertical: 'service', source_locale: 'en' },
    }))
    expect(provisioned.organization_id).toBe(organization.id)
    await responseBody(await member.get(`${api}/progress`), 401)
    const intent = { idempotency_key: crypto.randomUUID(), intent: 'Explain consultation preparation clearly to prospective clients.', constraints: 'I have twenty minutes for writing this week.' }
    const concurrentCreates = await Promise.all([request.post(`${api}/goals`, { data: intent }), request.post(`${api}/goals`, { data: intent })])
    const createdGoals = await Promise.all(concurrentCreates.map(response => responseBody<{ goal: BusinessGoal }>(response, 201)))
    const goal = createdGoals[0]!.goal
    expect(createdGoals[1]!.goal).toEqual(goal)
    expect(goal).toMatchObject({ intent: intent.intent, constraints: intent.constraints, created_by_user_id: actorId, updated_by_user_id: actorId, target_at: null, status: 'active' })
    const replay = await responseBody<{ goal: BusinessGoal }>(await request.post(`${api}/goals`, { data: intent }), 201)
    expect(replay.goal).toEqual(goal)
    await responseBody(await request.post(`${api}/goals`, { data: { ...intent, intent: 'A different request under the same key.' } }), 409)
    let progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([goal])

    const revised = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, {
      data: { updated_at: goal.updated_at, intent: 'Explain which documents prospective clients should bring to a legal consultation.', constraints: 'I now have ten minutes for writing this week.' },
    }))
    expect(revised.goal.updated_at).not.toBe(goal.updated_at)
    expect(revised.goal).toMatchObject({ intent: 'Explain which documents prospective clients should bring to a legal consultation.', constraints: 'I now have ten minutes for writing this week.' })
    await responseBody(await request.patch(`${api}/goals/${goal.id}`, { data: { updated_at: goal.updated_at, intent: 'This stale edit must not replace current intent.' } }), 409)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([revised.goal])
    const currentGoal = revised.goal

    const qaUrl = `/api/editor/organizations/${organization.id}/qa`
    const question = 'Which documents should I bring?'
    const answer = 'Bring the documents and correspondence about your legal question.'
    const qa = await responseBody<{ id: string }>(await request.post(qaUrl, { data: { question, answer } }), 201)
    const qaRead = await responseBody<{ qa: Array<{ id: string; question: string; answer: string; answer_author: string | null; answer_date: string | null; updated_at: string; status: string }> }>(await request.get(qaUrl, { params: { id: qa.id } }))
    expect(qaRead.qa).toHaveLength(1)
    expect(qaRead.qa[0]).toMatchObject({ id: qa.id, question, answer })
    expect(qaRead.qa[0]!.answer_author?.trim()).toBeTruthy()
    expect(new Date(qaRead.qa[0]!.answer_date!).toISOString()).toBe(qaRead.qa[0]!.answer_date)
    const qaOutcomes = (value: Progress) => value.outcomes.filter(outcome => outcome.subject.kind === 'qa' && outcome.subject.id === qa.id)
    const qaCreatedProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(qaOutcomes(qaCreatedProgress)).toEqual([expect.objectContaining({
      source: { table: 'activity_entries', id: expect.any(String) }, event: 'content.updated',
      actor: { kind: 'member', user_id: actorId }, changed_fields: expect.arrayContaining(['question', 'answer']),
      state: 'published', revision: qaRead.qa[0]!.updated_at,
      details: expect.objectContaining({ afterState: expect.objectContaining({ updated_at: qaRead.qa[0]!.updated_at, status: 'published' }) }),
      verification: { status: 'verified', basis: 'persisted_change', receipts: [] },
    })])
    const updatedAnswer = 'Bring the relevant documents and any notice with a deadline.'
    const changedQa = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'update_qa', args: {
      organization_id: organization.id, qa_id: qa.id, answer: updatedAnswer,
    } })
    expect(changedQa.status(), await changedQa.text()).toBe(200)
    mcpData(await changedQa.json())
    const updatedQaRead = await responseBody<typeof qaRead>(await request.get(qaUrl, { params: { id: qa.id } }))
    expect(updatedQaRead.qa[0]).toMatchObject({ id: qa.id, answer: updatedAnswer, answer_author: qaRead.qa[0]!.answer_author })
    expect(Date.parse(updatedQaRead.qa[0]!.answer_date!)).toBeGreaterThan(Date.parse(qaRead.qa[0]!.answer_date!))
    const qaChangedProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(qaOutcomes(qaChangedProgress)).toHaveLength(2)
    expect(qaOutcomes(qaChangedProgress)[0]).toMatchObject({
      actor: { user_id: actorId }, changed_fields: ['answer'], state: 'published', revision: updatedQaRead.qa[0]!.updated_at,
      details: { beforeState: { updated_at: qaRead.qa[0]!.updated_at, status: 'published' }, afterState: { updated_at: updatedQaRead.qa[0]!.updated_at, status: 'published' } },
    })
    await responseBody(await request.patch(`${qaUrl}/${qa.id}`, { data: { answer: updatedAnswer } }))
    expect(qaOutcomes(await responseBody<Progress>(await request.get(`${api}/progress`)))).toEqual(qaOutcomes(qaChangedProgress))
    await responseBody(await request.patch(`${qaUrl}/${qa.id}`, { data: { status: 'hidden' } }))
    const hiddenQaRead = await responseBody<typeof qaRead>(await request.get(qaUrl, { params: { id: qa.id } }))
    expect(hiddenQaRead.qa[0]).toMatchObject({ id: qa.id, status: 'hidden', answer: updatedAnswer })
    const hiddenQaProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(qaOutcomes(hiddenQaProgress)).toHaveLength(3)
    expect(qaOutcomes(hiddenQaProgress)[0]).toMatchObject({
      changed_fields: ['status'], state: 'hidden', revision: hiddenQaRead.qa[0]!.updated_at,
      details: { beforeState: { updated_at: updatedQaRead.qa[0]!.updated_at, status: 'published' }, afterState: { updated_at: hiddenQaRead.qa[0]!.updated_at, status: 'hidden' } },
    })

    const { category } = await responseBody<{ category: { id: string } }>(await request.post(`${editor}/categories`, { data: { collection: 'blog', name: 'Consultations' } }), 201)
    const created = await responseBody<{ post: { id: string; title: string; updated_at: string } }>(await request.post(`${editor}/posts`, { data: {
      idempotency_key: crypto.randomUUID(), title: 'Prepare for a legal consultation', category_id: category.id,
      content_blocks: [{ type: 'markdown', data: { markdown: 'Bring the documents relevant to your legal question.', editor_mode: 'rich' } }],
    } }))
    const postId = created.post.id
    const postUrl = `${editor}/${postId}`
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    const articleOutcomes = (value: Progress) => value.outcomes.filter(outcome => outcome.subject.kind === 'article' && outcome.subject.id === postId)
    expect(articleOutcomes(progress)).toEqual([expect.objectContaining({
      event: 'article.created', actor: { kind: 'member', user_id: actorId },
      verification: { status: 'verified', basis: 'persisted_change', receipts: [] },
    })])

    const update = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'update_blog_post', args: {
      organization_id: organization.id, post_id: postId, updated_at: created.post.updated_at,
      title: 'Documents to bring to a legal consultation',
    } })
    expect(update.status(), await update.text()).toBe(200)
    const edited = mcpData<{ post: { updated_at: string; title: string } }>(await update.json()).post
    const independentArticle = await responseBody<{ post: { updated_at: string; title: string } }>(await request.get(postUrl))
    expect(independentArticle.post).toMatchObject({ title: edited.title, updated_at: edited.updated_at })
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    const editedOutcomes = articleOutcomes(progress)
    expect(editedOutcomes.map(outcome => outcome.event).sort()).toEqual(['article.created', 'article.updated'])
    expect(new Set(editedOutcomes.map(outcome => outcome.id)).size).toBe(2)
    expect(editedOutcomes.every(outcome => outcome.actor.user_id === actorId)).toBe(true)
    expect(progress.coverage.unverified).toContain('business_goal_achievement')
    expect(progress.coverage.unverified).toContain('public_visibility')

    const { reference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subject_id: postId } }))
    const noChange = await responseBody<{ changed: boolean; post: { updated_at: string } }>(await request.patch(postUrl, { data: { title: edited.title, updated_at: edited.updated_at } }))
    expect(noChange).toMatchObject({ changed: false, post: { updated_at: edited.updated_at } })
    const unchangedReference = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subject_id: postId } }))
    expect(unchangedReference.reference).toEqual(reference)
    const noChangeProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(articleOutcomes(noChangeProgress)).toEqual(editedOutcomes)

    await loginAs(member, baseURL!, 'user-e2e-buyer')
    const guestName = `Progress enquiry ${crypto.randomUUID().slice(0, 8)}`
    await responseBody(await member.post('/api/public/contact', { headers: { 'x-preview-tenant': slug }, data: {
      name: guestName, email: 'buyer@playwright.example', subject: 'general', consent: true, message: 'Which documents should I bring to my legal consultation?',
    } }), 201)
    const inbox = await responseBody<{ threads: InboxRow[] }>(await request.get('/api/messages', { params: { organization_id: organization.id, type: 'contact' } }))
    const contacts = inbox.threads.filter(thread => thread.title === guestName)
    expect(contacts).toHaveLength(1)
    const threadId = contacts[0]!.id
    const threadUrl = `/api/messages/${threadId}`

    const stillDraft = await responseBody<{ post: { status: string; updated_at: string } }>(await request.get(postUrl))
    expect(stillDraft.post).toMatchObject({ status: 'draft', updated_at: edited.updated_at })
    expect(articleOutcomes(await responseBody<Progress>(await request.get(`${api}/progress`)))).toEqual(editedOutcomes)

    const { goal: mixedGoal } = await responseBody<{ goal: BusinessGoal }>(await request.post(`${api}/goals`, { data: {
      idempotency_key: crypto.randomUUID(), intent: `Publish our approved guide "${edited.title}" and answer the recent client enquiry about consultation documents today.`,
    } }), 201)
    const { goal: archivedMixedGoal } = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${mixedGoal.id}`, {
      data: { updated_at: mixedGoal.updated_at, status: 'archived' },
    }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([archivedMixedGoal, currentGoal])

    // The draft is an opportunity, recorded against its evidence; the owner's decision about it lasts until the evidence changes.
    const blogPath = `/dashboard/${slug}/website/blog/${postId}`
    const draftOpportunities = async () => {
      const { opportunities } = await responseBody<{ opportunities: OpportunityView[]; issues: string[] }>(await request.get(`${api}/opportunities`))
      return opportunities.filter(opportunity => opportunity.path === blogPath)
    }
    const offered = await draftOpportunities()
    expect(offered).toEqual([expect.objectContaining({ status_line: 'Website', title: `Publish “${edited.title}”`, detail: expect.stringContaining('Complete legal review before publishing.') })])
    const dismissal = { note: 'Do not publish this guide. An attorney must review the consultation instructions first.' }
    expect(await responseBody(await request.post(`${api}/opportunities/${offered[0]!.id}/dismiss`, { data: dismissal }))).toEqual({ opportunity: { id: offered[0]!.id, status: 'dismissed' } })
    // A decision is made once: neither a second dismissal nor an accept changes it.
    expect(await responseBody(await request.post(`${api}/opportunities/${offered[0]!.id}/dismiss`, { data: dismissal }), 409)).toMatchObject({ data: { code: 'OPPORTUNITY_DECIDED' } })
    expect(await responseBody(await request.post(`${api}/opportunities/${offered[0]!.id}/accept`, { data: {} }), 409)).toMatchObject({ data: { code: 'OPPORTUNITY_DECIDED' } })
    // While the draft is unchanged it stays dismissed, and dismissing wrote nothing to the draft.
    expect(await draftOpportunities()).toEqual([])
    const { post: heldPost } = await responseBody<{ post: { id: string; status: string; updated_at: string } }>(await request.get(postUrl))
    expect(heldPost).toMatchObject({ id: postId, status: 'draft', updated_at: edited.updated_at })
    const unknownReviewReference = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subject_id: postId } }))
    expect(unknownReviewReference.reference).toEqual(reference)
    expect(articleOutcomes(await responseBody<Progress>(await request.get(`${api}/progress`)))).toEqual(editedOutcomes)

    const changedArticle = await responseBody<{ post: { updated_at: string } }>(await request.patch(postUrl, { data: {
      updated_at: edited.updated_at, excerpt: 'Updated guidance for existing clients.',
    } }))
    const changedReference = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subject_id: postId } }))
    expect(changedReference.reference.evidence_revision).not.toBe(reference.evidence_revision)
    // Changed evidence is a new opportunity; the dismissal of the old evidence does not hide it.
    const reoffered = await draftOpportunities()
    expect(reoffered).toEqual([expect.objectContaining({ title: `Publish “${edited.title}”` })])
    expect(reoffered[0]!.id).not.toBe(offered[0]!.id)
    // A deferral hides it until its time, on the real clock, and then it returns unchanged.
    const until = new Date(Date.now() + 5_000).toISOString()
    expect(await responseBody(await request.post(`${api}/opportunities/${reoffered[0]!.id}/defer`, { data: { until } }))).toEqual({ opportunity: { id: reoffered[0]!.id, available_at: until } })
    expect(await draftOpportunities()).toEqual([])
    await expect.poll(draftOpportunities, { timeout: 15_000 }).toEqual(reoffered)
    // Accepting makes it the owner's task, due today, recorded as business activity.
    const { task: acceptedTask } = await responseBody<{ task: TaskView }>(await request.post(`${api}/opportunities/${reoffered[0]!.id}/accept`, { data: {} }), 201)
    expect(acceptedTask).toMatchObject({ kind: 'opportunity', status: 'open', title: `Publish “${edited.title}”`, assignee: { type: 'member', you: true }, due_at: expect.any(String) })
    expect(await draftOpportunities()).toEqual([])
    const listedTasks = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'list_tasks', args: { organization_id: organization.id, range: 'today', kind: 'opportunity' } })
    expect(listedTasks.status(), await listedTasks.text()).toBe(200)
    expect(mcpData<{ sections: TaskSection[] }>(await listedTasks.json()).sections).toEqual([expect.objectContaining({ id: 'open', tasks: [expect.objectContaining({ id: acceptedTask.id, status: 'open' })] })])
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.outcomes.filter(outcome => outcome.event === 'opportunity.accepted' && outcome.subject.id === reoffered[0]!.id)).toEqual([expect.objectContaining({
      subject: { kind: 'opportunity', id: reoffered[0]!.id }, actor: { kind: 'member', user_id: actorId },
    })])

    const { lifecycle } = await responseBody<{ lifecycle: { status: string; changed: boolean; updated_at: string } }>(await request.post(`${postUrl}/publish`, { data: { updated_at: changedArticle.post.updated_at } }))
    expect(lifecycle).toMatchObject({ status: 'published', changed: true })
    const publishedRead = await responseBody<{ post: { status: string; updated_at: string } }>(await request.get(postUrl))
    expect(publishedRead.post).toMatchObject({ status: 'published', updated_at: lifecycle.updated_at })
    const publishedProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(articleOutcomes(publishedProgress).filter(outcome => outcome.event === 'article.published')).toEqual([expect.objectContaining({
      actor: { kind: 'member', user_id: actorId }, verification: { status: 'verified', basis: 'persisted_change', receipts: [] },
    })])
    const republished = await responseBody<{ lifecycle: { changed: boolean; updated_at: string } }>(await request.post(`${postUrl}/publish`, { data: { updated_at: lifecycle.updated_at } }))
    expect(republished.lifecycle).toMatchObject({ changed: false, updated_at: lifecycle.updated_at })
    expect(articleOutcomes(await responseBody<Progress>(await request.get(`${api}/progress`)))).toEqual(articleOutcomes(publishedProgress))

    const beforeMedia = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subject_id: postId } }))
    const asset = await responseBody<{ asset_id: string }>(await request.post(`/api/editor/organizations/${organization.id}/media/upload`, { multipart: {
      image: { name: 'consultation-cover.avif', mimeType: 'image/avif', buffer: await sharp('public/platform/apple-touch-icon.png').avif().toBuffer() },
    } }))
    const assignedCover = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'set_media', args: {
      organization_id: organization.id, placement: { owner_type: 'content_document', owner_id: postId, slot: 'cover' }, asset_id: asset.asset_id,
    } })
    expect(assignedCover.status(), await assignedCover.text()).toBe(200)
    mcpData(await assignedCover.json())
    const afterMedia = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subject_id: postId } }))
    expect(afterMedia.reference.evidence).toMatchObject({ kind: 'article', updated_at: publishedRead.post.updated_at, media: [expect.objectContaining({ asset_id: asset.asset_id })] })
    expect(afterMedia.reference.evidence_revision).not.toBe(beforeMedia.reference.evidence_revision)

    const replyBody = 'Please bring the relevant documents and any prior correspondence.'
    const replyKey = crypto.randomUUID()
    await responseBody(await request.post(threadUrl, { headers: authRequestHeaders(baseURL!), data: { body: replyBody, idempotency_key: replyKey } }))
    await responseBody(await request.post(threadUrl, { headers: authRequestHeaders(baseURL!), data: { body: replyBody, idempotency_key: replyKey } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    const replies = progress.outcomes.filter(outcome => outcome.event === 'thread.member_reply' && outcome.subject.id === threadId)
    expect(replies).toEqual([expect.objectContaining({
      event: 'thread.member_reply', actor: { kind: 'member', user_id: actorId },
      verification: { status: 'unconfirmed', basis: 'provider_acceptance', receipts: [expect.objectContaining({ provider: 'log_only', channel: 'email', status: 'sent' })] },
    })])
    const { reference: repliedReference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'guest_thread.reply', subject_id: threadId } }))
    expect(repliedReference.evidence).toMatchObject({ kind: 'guest_thread', latest_guest_entry_id: expect.any(String), latest_reply_entry_id: replies[0]!.id })
    const guestReply = 'I found another letter with a deadline tomorrow; should I send it now?'
    await responseBody(await member.post(threadUrl, { headers: authRequestHeaders(baseURL!), data: { body: guestReply, idempotency_key: crypto.randomUUID() } }))
    const { reference: inboundReference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'guest_thread.reply', subject_id: threadId } }))
    expect(inboundReference.evidence_revision).not.toBe(repliedReference.evidence_revision)
    if (inboundReference.evidence.kind !== 'guest_thread' || repliedReference.evidence.kind !== 'guest_thread') throw new Error('The explicit thread reference must describe thread evidence')
    expect(inboundReference.evidence.latest_guest_entry_id).not.toBe(repliedReference.evidence.latest_guest_entry_id)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.outcomes.filter(outcome => outcome.event === 'thread.member_reply' && outcome.subject.id === threadId)).toEqual(replies)
    // The conversation keeps one copy of each side's message: the owner's retried reply and the client's answer.
    const preserved = await responseBody<ConversationPage>(await request.get(threadUrl))
    expect(preserved.entries.filter(item => item.type === 'message' && item.body === replyBody)).toMatchObject([{ side: 'business' }])
    expect(preserved.entries.filter(item => item.type === 'message' && item.body === guestReply)).toMatchObject([{ side: 'guest' }])

    const archived = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, { data: { updated_at: currentGoal.updated_at, status: 'archived' } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([archived.goal, archivedMixedGoal])

    await responseBody(await request.get(`/api/organizations/${seededTenant('restaurant').organizationId}/progress`), 404)
    await responseBody(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subject_id: crypto.randomUUID() } }), 404)
    const actor = findE2eAuthFixture('user-e2e-demo-role-owner')
    const invitationId = await sendOrganizationInvitation(request, baseURL!, organization.id, actor.email, 'member')
    await loginAs(member, baseURL!, actor.id)
    const joined = await acceptOrganizationInvitation(member, baseURL!, invitationId)
    expect(joined).toMatchObject({ role: 'member', organizationId: organization.id })
    await responseBody(await member.get(`${api}/progress`), 404)
    await responseBody(await member.get(`${api}/progress/reference`, { params: { operation: 'article.update', subject_id: postId } }), 404)
    await responseBody(await member.post(`${api}/goals`, { data: { ...intent, idempotency_key: crypto.randomUUID() } }), 404)
    // Opportunities are the owner's decisions: a member can neither read nor decide one.
    expect(await responseBody(await member.get(`${api}/opportunities`), 403)).toMatchObject({ data: { code: 'FORBIDDEN' } })
    expect(await responseBody(await member.post(`${api}/opportunities/${reoffered[0]!.id}/dismiss`, { data: {} }), 403)).toMatchObject({ data: { code: 'FORBIDDEN' } })
  } finally {
    try {
      await responseBody(await request.post('/api/auth/organization/delete', { headers: authRequestHeaders(baseURL!), data: { organizationId: organization.id } }))
      const organizations = await responseBody<Array<{ id: string }>>(await request.get('/api/auth/organization/list'))
      expect(organizations.map(item => item.id)).not.toContain(organization.id)
    } finally {
      await member.dispose()
    }
  }
})

test('business progress read-only contract holds on an established business', async ({ request, baseURL }) => {
  const organizationId = seededTenant('restaurant').organizationId
  await loginAs(request, baseURL!)
  const api = `/api/organizations/${encodeURIComponent(organizationId)}`
  const first = await responseBody<Progress>(await request.get(`${api}/progress`))
  const second = await responseBody<Progress>(await request.get(`${api}/progress`))
  expect(first.coverage).toMatchObject({
    sources: ['activity_entries', 'messages', 'post_publications', 'reviews', 'analytics_events'],
    attribution: 'recorded_actor_only', article: 'persisted_change_only', web_reply: 'stored_message_only',
    external_reply: 'provider_acceptance_requires_receipt', verification: 'only_the_named_evidence_basis',
  })
  expect(first.coverage.unverified).toContain('attendance_or_fulfilment')
  expect(first.coverage.unverified).toContain('causal_revenue_attribution')
  expect(new Set(first.coverage.supported_events).size).toBe(first.coverage.supported_events.length)
  expect(second.coverage).toEqual(first.coverage)
  // These are fresh reads: edits/deletions can change goals,
  // while new activity can shift page membership. Compare retained versions.
  for (const goal of first.goals) {
    const repeated = second.goals.find(item => item.id === goal.id && item.updated_at === goal.updated_at)
    if (!repeated) continue
    expect(repeated).toMatchObject({ id: goal.id, intent: goal.intent, constraints: goal.constraints, target_at: goal.target_at,
      status: goal.status, created_at: goal.created_at, updated_at: goal.updated_at })
  }
  for (const outcome of first.outcomes) {
    const repeated = second.outcomes.find(item => item.id === outcome.id)
    if (!repeated) continue
    // Provider receipts and review moderation retain their source ID while the
    // recorded state/revision advances. Compare the same source revision.
    if (repeated.revision !== outcome.revision) continue
    expect(repeated, 'A canonical occurrence keeps its identity across progress reads').toMatchObject({
      id: outcome.id, event: outcome.event, subject: outcome.subject, actor: { kind: outcome.actor.kind }, occurred_at: outcome.occurred_at,
    })
    // Account deletion can redact attribution through its SET NULL foreign key.
    if (repeated.actor.user_id !== null) expect(repeated.actor.user_id).toBe(outcome.actor.user_id)
  }
  for (const outcome of [...first.outcomes, ...second.outcomes]) {
    expect(['guest', 'member', 'system', 'cloudflare', 'user', 'agent', 'unknown']).toContain(outcome.actor.kind)
    if (outcome.actor.user_id !== null) {
      expect(outcome.actor.user_id).toEqual(expect.any(String))
      expect(outcome.actor.user_id.length).toBeGreaterThan(0)
    }
  }
  // Audit history can describe a deleted article. Its immutable occurrence
  // remains valid; only an existing source can provide a current reference.
  for (const outcome of first.outcomes.filter(item => item.subject.kind === 'article')) {
    const articleUrl = `/api/editor/organizations/${encodeURIComponent(organizationId)}/blog/${encodeURIComponent(outcome.subject.id)}`
    const article = await request.get(articleUrl)
    if (article.status() === 404) continue
    const { post } = await responseBody<{ post: { id: string; status: string; updated_at: string } }>(article)
    expect(post.id).toBe(outcome.subject.id)
    expect(post.status).toEqual(expect.any(String))
    expect(new Date(post.updated_at).toISOString()).toBe(post.updated_at)
    const referenceResponse = await request.get(`${api}/progress/reference`, {
      params: { operation: 'article.update', subject_id: outcome.subject.id },
    })
    if (referenceResponse.status() === 404) {
      const deletedArticle = await request.get(articleUrl)
      expect(deletedArticle.status(), await deletedArticle.text()).toBe(404)
      continue
    }
    const { reference } = await responseBody<{ reference: BusinessProgressReference }>(referenceResponse)
    expect(reference).toMatchObject({ operation: 'article.update', subject_id: post.id, evidence: { kind: 'article' } })
    expect(reference.evidence_revision).toMatch(/^[a-f0-9]{64}$/)
    if (reference.evidence.kind !== 'article') throw new Error('An article reference must describe article evidence')
    expect(new Date(reference.evidence.updated_at).toISOString()).toBe(reference.evidence.updated_at)
    if (reference.evidence.updated_at === post.updated_at) expect(reference.evidence.status).toBe(post.status)
    break
  }
})
