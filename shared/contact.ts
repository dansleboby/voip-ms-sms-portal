/**
 * Icons a contact's avatar can show instead of its initials: a few on
 * purpose, enough to tell people apart at a glance.
 */
export const CONTACT_ICONS = [
  'heart',
  'star',
  'house',
  'users',
  'baby',
  'dog',
  'briefcase',
  'building',
  'car',
  'wrench',
  'stethoscope',
  'graduation-cap',
] as const;

export type ContactIcon = (typeof CONTACT_ICONS)[number];

/** Contacts deleted per request (POST /api/contacts/delete): the client sends longer lists in several. */
export const MAX_DELETE_IDS = 5000;
