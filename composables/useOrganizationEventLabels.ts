const ORGANIZATION_EVENT_LABELS: Record<string, string> = {
  'contact.created': 'New contact message',
  'post.created': 'Created a post',
  'post.published': 'Published a post',
  'post.archived': 'Archived a post',
  'product.created': 'Created a Product',
  'product.updated': 'Updated a Product',
  'product.deleted': 'Deleted a Product',
  'product.reordered': 'Reordered Products',
  'product.category_renamed': 'Renamed a Product category',
  'product.category_deleted': 'Deleted a Product category',
  'content.updated': 'Updated content',
  'content.published': 'Published content',
  'media.uploaded': 'Uploaded media',
  'media.deleted': 'Deleted media',
  'review.received': 'New review received',
  'review.replied': 'Replied to a review',
  'reservation.created': 'New reservation',
  'reservation.confirmed': 'Confirmed a reservation',
  'reservation.cancelled': 'Cancelled a reservation',
  'location.created': 'Added a location',
  'location.updated': 'Updated a location',
  'experience.created': 'Created an experience',
  'experience.booking_received': 'New experience booking',
  'domain.connected': 'Connected a domain',
  'domain.verified': 'Domain verified',
  'domain.failed': 'Domain verification failed',
  'member.invited': 'Invited a member',
  'member.role_changed': "Updated a member's role",
  'member.removed': 'Removed a member',
  'member.access_scope_revoked': 'Revoked WhatsApp notification access',
  'stay.homes_assigned': "Changed the homes a member looks after",
  'team.message_sent': 'Sent a team message',
}

export const ORGANIZATION_EVENT_TYPES = Object.keys(ORGANIZATION_EVENT_LABELS)

export function useOrganizationEventLabels() {
  function eventLabel(type: string) {
    return ORGANIZATION_EVENT_LABELS[type] ?? type.replace('.', ' ')
  }

  return { eventLabel }
}
