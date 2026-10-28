import { expect, request as playwrightRequest, test, type APIResponse } from '@playwright/test'
import sharp from 'sharp'
import type { BusinessOutcomePage, BusinessProgressReference } from '../../shared/business-outcomes'
import type { BusinessGoal, RecommendationFeedback, RecommendationFeedbackView } from '../../shared/business-progress'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'

type Progress = BusinessOutcomePage & { goals: BusinessGoal[]; feedback: RecommendationFeedbackView[] }

async function responseBody<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return response.json() as Promise<T>
}

test('authored goals and evidence-bound feedback follow persisted work', async ({ request, baseURL }) => {
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
    const provisioned = await responseBody<{ organizationId: string }>(await request.post('/api/organizations', {
      data: { organizationId: organization.id, name, subdomain: slug, vertical: 'service', sourceLocale: 'en' },
    }))
    expect(provisioned.organizationId).toBe(organization.id)
    await responseBody(await member.get(`${api}/progress`), 401)
    const intent = { idempotencyKey: crypto.randomUUID(), intent: 'Explain consultation preparation clearly to prospective clients.', constraints: 'I have twenty minutes for writing this week.' }
    const concurrentCreates = await Promise.all([request.post(`${api}/goals`, { data: intent }), request.post(`${api}/goals`, { data: intent })])
    const createdGoals = await Promise.all(concurrentCreates.map(response => responseBody<{ goal: BusinessGoal }>(response, 201)))
    const goal = createdGoals[0]!.goal
    expect(createdGoals[1]!.goal).toEqual(goal)
    expect(goal).toMatchObject({ intent: intent.intent, constraints: intent.constraints, createdBy: actorId, updatedBy: actorId, targetAt: null, status: 'active' })
    const replay = await responseBody<{ goal: BusinessGoal }>(await request.post(`${api}/goals`, { data: intent }), 201)
    expect(replay.goal).toEqual(goal)
    await responseBody(await request.post(`${api}/goals`, { data: { ...intent, intent: 'A different request under the same key.' } }), 409)
    let progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([goal])

    const revised = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, {
      data: { revision: goal.revision, intent: 'Explain which documents prospective clients should bring to a legal consultation.', constraints: 'I now have ten minutes for writing this week.' },
    }))
    expect(revised.goal.revision).not.toBe(goal.revision)
    expect(revised.goal).toMatchObject({ intent: 'Explain which documents prospective clients should bring to a legal consultation.', constraints: 'I now have ten minutes for writing this week.' })
    await responseBody(await request.patch(`${api}/goals/${goal.id}`, { data: { revision: goal.revision, intent: 'This stale edit must not replace current intent.' } }), 409)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([revised.goal])
    const currentGoal = revised.goal

    const { category } = await responseBody<{ category: { id: string } }>(await request.post(`${editor}/categories`, { data: { collection: 'blog', name: 'Consultations' } }), 201)
    const created = await responseBody<{ post: { id: string; title: string; updated_at: string } }>(await request.post(`${editor}/posts`, { data: {
      idempotency_key: crypto.randomUUID(), title: 'Prepare for a legal consultation', category_id: category.id,
      content_blocks: [{ type: 'markdown', data: { markdown: 'Bring the documents relevant to your legal question.', editor_mode: 'rich' } }],
    } }))
    const postId = created.post.id
    const postUrl = `${editor}/${postId}`
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    const articleOutcomes = (value: Progress) => value.outcomes.filter(outcome => outcome.subject.id === postId)
    expect(articleOutcomes(progress)).toEqual([expect.objectContaining({
      event: 'article.created', actor: { kind: 'member', userId: actorId },
      verification: { status: 'verified', basis: 'persisted_change', receipts: [] },
    })])

    const update = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'update_blog_post', args: {
      organization_id: organization.id, post_id: postId, expected_updated_at: created.post.updated_at,
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
    expect(editedOutcomes.every(outcome => outcome.actor.userId === actorId)).toBe(true)
    expect(progress.coverage.unverified).toContain('business_goal_achievement')
    expect(progress.coverage.unverified).toContain('public_visibility')

    const { reference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subjectId: postId } }))
    const noChange = await responseBody<{ changed: boolean; post: { updated_at: string } }>(await request.patch(postUrl, { data: { title: edited.title, expected_updated_at: edited.updated_at } }))
    expect(noChange).toMatchObject({ changed: false, post: { updated_at: edited.updated_at } })
    const unchangedReference = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subjectId: postId } }))
    expect(unchangedReference.reference).toEqual(reference)
    const noChangeProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(articleOutcomes(noChangeProgress)).toEqual(editedOutcomes)

    await loginAs(member, baseURL!, 'user-e2e-buyer')
    const guestName = `Progress enquiry ${crypto.randomUUID().slice(0, 8)}`
    await responseBody(await member.post('/api/public/contact', { headers: { 'x-preview-tenant': slug }, data: {
      name: guestName, email: 'buyer@playwright.example', subject: 'general', consent: true, message: 'Which documents should I bring to my legal consultation?',
    } }), 201)
    const inbox = await responseBody<{ threads: Array<{ id: string; guestName: string }> }>(await request.get(`/api/dashboard/organizations/${organization.id}/guest-threads`, { params: { type: 'contact' } }))
    const contacts = inbox.threads.filter(thread => thread.guestName === guestName)
    expect(contacts).toHaveLength(1)
    const threadId = contacts[0]!.id
    const threadUrl = `/api/dashboard/organizations/${organization.id}/guest-threads/${threadId}`

    const stillDraft = await responseBody<{ post: { status: string; updated_at: string } }>(await request.get(postUrl))
    expect(stillDraft.post).toMatchObject({ status: 'draft', updated_at: edited.updated_at })
    expect(articleOutcomes(await responseBody<Progress>(await request.get(`${api}/progress`)))).toEqual(editedOutcomes)

    const { goal: mixedGoal } = await responseBody<{ goal: BusinessGoal }>(await request.post(`${api}/goals`, { data: {
      idempotencyKey: crypto.randomUUID(), intent: `Publish our approved guide "${edited.title}" and answer the recent client enquiry about consultation documents today.`,
    } }), 201)
    const { feedback: mixedHold } = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: {
      operation: reference.operation, subjectId: postId, evidenceRevision: reference.evidenceRevision,
      goalId: mixedGoal.id, goalRevision: mixedGoal.revision, decision: 'correct',
      note: 'The consultation instructions are already attorney-approved for direct replies to clients. Website publication must wait for my separate publication authorization.',
    } }))
    const { goal: archivedMixedGoal } = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${mixedGoal.id}`, {
      data: { revision: mixedGoal.revision, status: 'archived' },
    }))

    const feedbackRequest = {
      operation: reference.operation, subjectId: postId, evidenceRevision: reference.evidenceRevision,
      goalId: goal.id, goalRevision: currentGoal.revision, decision: 'dismiss', note: 'The current explanation is sufficient for this week.',
    }
    const { feedback } = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: feedbackRequest }))
    const feedbackReplay = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: feedbackRequest }))
    expect(feedbackReplay.feedback).toEqual(feedback)
    await responseBody(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, decision: 'accept' } }), 409)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback).toEqual([
      expect.objectContaining({ id: feedback.id, actorId, decision: 'dismiss', note: feedbackRequest.note, applicability: { current: true, reasons: [] } }),
      { ...mixedHold, applicability: { current: false, reasons: ['goal_changed', 'goal_archived'] } },
    ])
    const correction = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: {
      ...feedbackRequest, revision: feedback.revision, decision: 'correct', note: 'Do not publish this guide. An attorney must review the consultation instructions first.',
    } }))
    expect(correction.feedback).toMatchObject({ id: feedback.id, decision: 'correct' })
    expect(correction.feedback.revision).not.toBe(feedback.revision)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback.find(item => item.id === feedback.id)).toEqual({
      ...correction.feedback,
      note: 'Do not publish this guide. An attorney must review the consultation instructions first.',
      applicability: { current: true, reasons: [] },
    })
    expect(progress.goals).toEqual([archivedMixedGoal, currentGoal])
    const { post: heldPost } = await responseBody<{ post: { id: string; status: string; updated_at: string } }>(await request.get(postUrl))
    expect(heldPost).toMatchObject({ id: postId, status: 'draft', updated_at: edited.updated_at })
    await responseBody(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, revision: feedback.revision, decision: 'accept' } }), 409)

    const unknownCorrection = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: {
      ...feedbackRequest, revision: correction.feedback.revision, decision: 'correct',
      note: 'I do not know whether an attorney has reviewed this revision; publication must wait until that is confirmed.',
    } }))
    expect(unknownCorrection.feedback).toMatchObject({ id: feedback.id, decision: 'correct' })
    expect(unknownCorrection.feedback.revision).not.toBe(correction.feedback.revision)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback.find(item => item.id === feedback.id)).toEqual({
      ...unknownCorrection.feedback,
      note: 'I do not know whether an attorney has reviewed this revision; publication must wait until that is confirmed.',
      applicability: { current: true, reasons: [] },
    })
    expect(progress.goals).toEqual([archivedMixedGoal, currentGoal])
    const unknownReviewReference = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subjectId: postId } }))
    expect(unknownReviewReference.reference).toEqual(reference)
    const { post: unknownReviewPost } = await responseBody<{ post: { id: string; status: string; updated_at: string } }>(await request.get(postUrl))
    expect(unknownReviewPost).toMatchObject({ id: postId, status: 'draft', updated_at: edited.updated_at })
    await responseBody(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, revision: correction.feedback.revision, decision: 'accept' } }), 409)

    const changedArticle = await responseBody<{ post: { updated_at: string } }>(await request.patch(postUrl, { data: {
      expected_updated_at: edited.updated_at, excerpt: 'Updated guidance for existing clients.',
    } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback).toEqual([
      expect.objectContaining({ id: feedback.id, decision: 'correct', applicability: { current: false, reasons: ['evidence_changed'] } }),
      { ...mixedHold, applicability: { current: false, reasons: ['evidence_changed', 'goal_changed', 'goal_archived'] } },
    ])
    await responseBody(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, revision: unknownCorrection.feedback.revision } }), 409)
    const changedReference = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subjectId: postId } }))
    expect(changedReference.reference.evidenceRevision).not.toBe(reference.evidenceRevision)
    const newFeedback = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, evidenceRevision: changedReference.reference.evidenceRevision } }))
    expect(newFeedback.feedback.id).not.toBe(feedback.id)

    const { lifecycle } = await responseBody<{ lifecycle: { status: string; changed: boolean; updated_at: string } }>(await request.post(`${postUrl}/publish`, { data: { expected_updated_at: changedArticle.post.updated_at } }))
    expect(lifecycle).toMatchObject({ status: 'published', changed: true })
    const publishedRead = await responseBody<{ post: { status: string; updated_at: string } }>(await request.get(postUrl))
    expect(publishedRead.post).toMatchObject({ status: 'published', updated_at: lifecycle.updated_at })
    const publishedProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(articleOutcomes(publishedProgress).filter(outcome => outcome.event === 'article.published')).toEqual([expect.objectContaining({
      actor: { kind: 'member', userId: actorId }, verification: { status: 'verified', basis: 'persisted_change', receipts: [] },
    })])
    const republished = await responseBody<{ lifecycle: { changed: boolean; updated_at: string } }>(await request.post(`${postUrl}/publish`, { data: { expected_updated_at: lifecycle.updated_at } }))
    expect(republished.lifecycle).toMatchObject({ changed: false, updated_at: lifecycle.updated_at })
    expect(articleOutcomes(await responseBody<Progress>(await request.get(`${api}/progress`)))).toEqual(articleOutcomes(publishedProgress))

    const beforeMedia = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subjectId: postId } }))
    const asset = await responseBody<{ asset_id: string }>(await request.post(`/api/editor/organizations/${organization.id}/media/upload`, { multipart: {
      image: { name: 'consultation-cover.avif', mimeType: 'image/avif', buffer: await sharp('public/platform/apple-touch-icon.png').avif().toBuffer() },
    } }))
    const assignedCover = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'set_media', args: {
      organization_id: organization.id, placement: { owner_type: 'content_document', owner_id: postId, slot: 'cover' }, asset_id: asset.asset_id,
    } })
    expect(assignedCover.status(), await assignedCover.text()).toBe(200)
    mcpData(await assignedCover.json())
    const afterMedia = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subjectId: postId } }))
    expect(afterMedia.reference.evidence).toMatchObject({ kind: 'article', updatedAt: publishedRead.post.updated_at, media: [expect.objectContaining({ assetId: asset.asset_id })] })
    expect(afterMedia.reference.evidenceRevision).not.toBe(beforeMedia.reference.evidenceRevision)

    const { reference: unansweredReference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'guest_thread.reply', subjectId: threadId } }))
    // A short authored deferral lets progress prove expiry using its real clock.
    const { feedback: shortDeferral } = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: {
      operation: 'guest_thread.reply', subjectId: threadId, evidenceRevision: unansweredReference.evidenceRevision,
      decision: 'defer', deferUntil: new Date(Date.now() + 5_000).toISOString(), note: 'Pause this enquiry briefly before reassessing it.',
    } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback.find(item => item.id === shortDeferral.id)).toEqual({ ...shortDeferral, applicability: { current: true, reasons: [] } })
    await expect.poll(async () => {
      const current = await responseBody<Progress>(await request.get(`${api}/progress`))
      return current.feedback.find(item => item.id === shortDeferral.id)
    }, { timeout: 10_000 }).toEqual({ ...shortDeferral, applicability: { current: false, reasons: ['defer_elapsed'] } })
    const replyBody = 'Please bring the relevant documents and any prior correspondence.'
    const replyKey = crypto.randomUUID()
    await responseBody(await request.post(`${threadUrl}/operations/reply`, { data: { body: replyBody, idempotencyKey: replyKey } }))
    await responseBody(await request.post(`${threadUrl}/operations/reply`, { data: { body: replyBody, idempotencyKey: replyKey } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    const replies = progress.outcomes.filter(outcome => outcome.subject.id === threadId)
    expect(replies).toEqual([expect.objectContaining({
      event: 'thread.member_reply', actor: { kind: 'member', userId: actorId },
      verification: { status: 'unconfirmed', basis: 'provider_acceptance', receipts: [expect.objectContaining({ provider: 'log_only', channel: 'email', status: 'sent' })] },
    })])
    const { reference: repliedReference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'guest_thread.reply', subjectId: threadId } }))
    expect(repliedReference.evidence).toMatchObject({ kind: 'guest_thread', latestGuestEntryId: expect.any(String), latestReplyEntryId: replies[0]!.id })
    const { feedback: deferred } = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: {
      operation: 'guest_thread.reply', subjectId: threadId, evidenceRevision: repliedReference.evidenceRevision,
      decision: 'defer', deferUntil: new Date(Date.now() + 86_400_000).toISOString(), note: 'Wait for the client to provide documents.',
    } }))
    const guestReply = 'I found another letter with a deadline tomorrow; should I send it now?'
    await responseBody(await member.post(`/api/account/messages/${threadId}/reply`, { headers: authRequestHeaders(baseURL!), data: { body: guestReply, idempotencyKey: crypto.randomUUID() } }))
    const { reference: inboundReference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'guest_thread.reply', subjectId: threadId } }))
    expect(inboundReference.evidenceRevision).not.toBe(repliedReference.evidenceRevision)
    if (inboundReference.evidence.kind !== 'guest_thread' || repliedReference.evidence.kind !== 'guest_thread') throw new Error('The explicit thread reference must describe thread evidence')
    expect(inboundReference.evidence.latestGuestEntryId).not.toBe(repliedReference.evidence.latestGuestEntryId)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback.find(item => item.id === deferred.id)?.applicability).toEqual({ current: false, reasons: ['evidence_changed'] })
    expect(progress.outcomes.filter(outcome => outcome.subject.id === threadId)).toEqual(replies)
    const preserved = await responseBody<{ thread: { entries: Array<{ body: string | null }> } }>(await request.get(threadUrl))
    expect(preserved.thread.entries.filter(entry => entry.body === replyBody)).toHaveLength(1)
    expect(preserved.thread.entries.filter(entry => entry.body === guestReply)).toHaveLength(1)

    const archived = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, { data: { revision: currentGoal.revision, status: 'archived' } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([archived.goal, archivedMixedGoal])
    expect(progress.feedback.find(item => item.id === newFeedback.feedback.id)?.applicability).toEqual({ current: false, reasons: ['evidence_changed', 'goal_changed', 'goal_archived'] })

    await responseBody(await request.get('/api/organizations/org-demo/progress'), 404)
    await responseBody(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subjectId: crypto.randomUUID() } }), 404)
    const { token } = await responseBody<{ token: string }>(await request.post(`${api}/invite-links`, { data: { role: 'member' } }), 201)
    await loginAs(member, baseURL!, 'user-e2e-demo-role-owner')
    const joined = await responseBody<{ role: string; organization: { id: string } }>(await member.post(`/api/invite-links/${token}/accept`))
    expect(joined).toMatchObject({ role: 'member', organization: { id: organization.id } })
    await responseBody(await member.get(`${api}/progress`), 404)
    await responseBody(await member.get(`${api}/progress/reference`, { params: { operation: 'article.update', subjectId: postId } }), 404)
    await responseBody(await member.post(`${api}/goals`, { data: { ...intent, idempotencyKey: crypto.randomUUID() } }), 404)
    await responseBody(await member.put(`${api}/recommendation-feedback`, { data: feedbackRequest }), 404)
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

test('business progress read-only contract uses the explicitly configured canary organization', async ({ request, baseURL }) => {
  const organizationId = process.env.CANARY_ORG_ID
  if (!organizationId) throw new Error('CANARY_ORG_ID must explicitly identify the tenant for the read-only progress check')
  await loginAs(request, baseURL!)
  const api = `/api/organizations/${encodeURIComponent(organizationId)}`
  const first = await responseBody<Progress>(await request.get(`${api}/progress`))
  const second = await responseBody<Progress>(await request.get(`${api}/progress`))
  expect(first.coverage).toEqual({
    supportedEvents: ['article.created', 'article.updated', 'article.published', 'thread.member_reply'],
    attribution: 'recorded_actor_only', article: 'persisted_change_only', webReply: 'stored_message_only',
    externalReply: 'provider_acceptance_requires_receipt',
    unverified: ['public_visibility', 'operation_completion', 'recipient_notification', 'conversation_resolution', 'business_goal_achievement'],
  })
  expect(second.coverage).toEqual(first.coverage)
  // These are fresh reads: edits/deletions can change goals and feedback,
  // while new activity can shift page membership. Compare retained versions.
  for (const goal of first.goals) {
    const repeated = second.goals.find(item => item.id === goal.id && item.revision === goal.revision)
    if (!repeated) continue
    expect(repeated).toMatchObject({ id: goal.id, intent: goal.intent, constraints: goal.constraints, targetAt: goal.targetAt,
      status: goal.status, createdAt: goal.createdAt, revision: goal.revision })
  }
  for (const feedback of first.feedback) {
    const repeated = second.feedback.find(item => item.id === feedback.id && item.revision === feedback.revision)
    if (!repeated) continue
    const { applicability: _firstApplicability, ...saved } = feedback
    const { applicability: _secondApplicability, ...savedAgain } = repeated
    expect(savedAgain).toEqual(saved)
  }
  for (const outcome of first.outcomes) {
    const repeated = second.outcomes.find(item => item.id === outcome.id)
    if (!repeated) continue
    expect(repeated, 'A canonical occurrence keeps its identity across progress reads').toMatchObject({
      id: outcome.id, event: outcome.event, subject: outcome.subject, actor: { kind: outcome.actor.kind }, occurredAt: outcome.occurredAt,
    })
    // Account deletion can redact attribution through its SET NULL foreign key.
    if (repeated.actor.userId !== null) expect(repeated.actor.userId).toBe(outcome.actor.userId)
  }
  for (const outcome of [...first.outcomes, ...second.outcomes]) {
    expect(['guest', 'member', 'system', 'cloudflare']).toContain(outcome.actor.kind)
    if (outcome.actor.userId !== null) {
      expect(outcome.actor.userId).toEqual(expect.any(String))
      expect(outcome.actor.userId.length).toBeGreaterThan(0)
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
      params: { operation: 'article.update', subjectId: outcome.subject.id },
    })
    if (referenceResponse.status() === 404) {
      const deletedArticle = await request.get(articleUrl)
      expect(deletedArticle.status(), await deletedArticle.text()).toBe(404)
      continue
    }
    const { reference } = await responseBody<{ reference: BusinessProgressReference }>(referenceResponse)
    expect(reference).toMatchObject({ operation: 'article.update', subjectId: post.id, evidence: { kind: 'article' } })
    expect(reference.evidenceRevision).toMatch(/^[a-f0-9]{64}$/)
    if (reference.evidence.kind !== 'article') throw new Error('An article reference must describe article evidence')
    expect(new Date(reference.evidence.updatedAt).toISOString()).toBe(reference.evidence.updatedAt)
    if (reference.evidence.updatedAt === post.updated_at) expect(reference.evidence.status).toBe(post.status)
    break
  }
})
