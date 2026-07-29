/**
 * systemMessage.ts — formats group "system" timeline events (WhatsApp-style)
 * such as "Kojo added Ama", "You left", "Kojo changed the group name".
 *
 * The Convex backend is expected to emit these as normal message documents in
 * `messages.list` with:
 *   {
 *     type: 'system',
 *     system: {
 *       action: 'group_created' | 'member_added' | 'member_removed'
 *             | 'member_left' | 'member_joined' | 'admin_promoted'
 *             | 'admin_demoted' | 'chief_transferred' | 'group_renamed'
 *             | 'group_icon_changed' | 'group_description_changed',
 *       actorId: <userId who performed the action>,
 *       targetIds?: <userId[] affected>,
 *       value?: <string, e.g. new group name>,
 *     },
 *   }
 *
 * Names are resolved to EACH viewer's device-saved contact name (the same
 * resolver used for message senders), so the copy reads like the user's own
 * phone book. A plain pre-rendered `text` field is used as a last-resort
 * fallback if the structured payload is missing.
 */
type ResolveName = (senderId: string, fallbackName?: string) => string | undefined;

export type SystemPayload = {
  action: string;
  actorId: string;
  targetIds: string[];
  value: string;
};

/** Returns the normalised system payload, or null if `item` is not a system row. */
export function getSystemPayload(item: any): SystemPayload | null {
  if (!item) return null;
  const isSystem =
    item.type === 'system' ||
    item.messageType === 'system' ||
    item.__kind === 'system';
  if (!isSystem) return null;
  const sys = item.system || item.systemData || {};
  const targetIds: string[] = Array.isArray(sys.targetIds)
    ? sys.targetIds.map((t: any) => String(t))
    : sys.targetId
    ? [String(sys.targetId)]
    : Array.isArray(item.targetIds)
    ? item.targetIds.map((t: any) => String(t))
    : [];
  return {
    action: String(sys.action || item.systemAction || item.action || ''),
    actorId: String(sys.actorId || item.actorId || item.senderId || ''),
    targetIds,
    value: String(sys.value ?? item.value ?? ''),
  };
}

/** Joins resolved names naturally: "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  const list = names.filter(Boolean);
  if (list.length === 0) return 'someone';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export type SystemFormatOpts = {
  myId?: string | null;
  resolveName: ResolveName;
  groupName?: string;
};

/**
 * Produces the human sentence for a system row, or '' if it can't be built
 * (caller should then skip rendering the pill).
 */
export function formatSystemMessage(item: any, opts: SystemFormatOpts): string {
  const payload = getSystemPayload(item);
  if (!payload) return '';

  const { myId, resolveName, groupName } = opts;
  const nameFor = (id: string, isActor = false): string => {
    if (!id) return isActor ? 'Someone' : 'someone';
    if (myId && String(id) === String(myId)) return isActor ? 'You' : 'you';
    return resolveName(String(id)) || (isActor ? 'Someone' : 'a member');
  };

  const actor = nameFor(payload.actorId, true);
  const targets = joinNames(payload.targetIds.map((t) => nameFor(t)));
  const gname = payload.value || groupName || '';

  switch (payload.action) {
    case 'group_created':
      return `${actor} created the group${gname ? ` "${gname}"` : ''}`;
    case 'member_added':
      return `${actor} added ${targets}`;
    case 'member_removed':
      return `${actor} removed ${targets}`;
    case 'member_left':
      return `${actor} left`;
    case 'member_joined':
      return `${actor} joined via invite link`;
    case 'admin_promoted':
      return `${actor} made ${targets} an admin`;
    case 'admin_demoted':
      return `${actor} removed ${targets} as admin`;
    case 'chief_transferred':
      return `${actor} transferred chief admin to ${targets}`;
    case 'group_renamed':
      return `${actor} changed the group name${payload.value ? ` to "${payload.value}"` : ''}`;
    case 'group_icon_changed':
      return `${actor} changed the group icon`;
    case 'group_description_changed':
      return `${actor} changed the group description`;
    default:
      // Backend may send a pre-rendered plain sentence for unknown actions.
      return typeof item?.text === 'string' ? item.text : '';
  }
}
