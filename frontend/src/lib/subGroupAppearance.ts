/**
 * Sub-group appearance is a SYNCED field (`appearance: { emoji?, color? }`) on
 * the conversation doc — set via subGroups.create and edited via
 * conversations.updateGroup. These are just the picker option lists.
 */
export type SubGroupAppearance = { emoji?: string; color?: string };

export const SUB_GROUP_EMOJIS = ['⭐', '🔥', '💼', '📌', '🎯', '👑', '🛡️', '📣', '🎓', '⚽', '🎵', '❤️'];
export const SUB_GROUP_COLORS = [
  '#E53935',
  '#FB8C00',
  '#F4B400',
  '#43A047',
  '#00ACC1',
  '#1E88E5',
  '#8E24AA',
  '#6D4C41',
];
