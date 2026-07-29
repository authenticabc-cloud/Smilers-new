/**
 * systemMessage.ts — formats group "system" timeline events (WhatsApp-style)
 * such as "Kojo added Ama", "You left", "Kojo changed the group name".
 *
 * WIRE CONTRACT (aligned to the backend's existing `numberChanged` precedent):
 * the Convex backend emits these as normal `messages` rows returned by
 * `messages.list` with:
 *   {
 *     type: 'system',
 *     systemKind: 'memberAdded' | 'memberRemoved' | 'memberLeft'
 *               | 'memberJoined' | 'groupCreated' | 'adminPromoted'
 *               | 'adminDemoted' | 'chiefTransferred' | 'groupRenamed'
 *               | 'groupIconChanged' | 'groupDescriptionChanged',
 *     systemMeta: {
 *       actorId: <userId who performed the action>,
 *       targetIds?: <userId[] affected>,
 *       value?: <string, e.g. the new group name>,
 *     },
 *   }
 *
 * For the chats-list preview, the same info rides on the conversation row as
 * `lastSystemKind` + `lastSystemMeta` (+ `lastMessageId` for deep-linking).
 *
 * Names are resolved to EACH viewer's device-saved contact name (the same
 * resolver used for message senders). Action-key matching is normalised so
 * both camelCase (`memberAdded`) and snake_case (`member_added`) are accepted.
 */
type ResolveName = (senderId: string, fallbackName?: string) => string | undefined;

export type SystemPayload = {
  action: string; // normalised: lowercase, no separators (e.g. "memberadded")
  actorId: string;
  targetIds: string[];
  value: string;
};

function normaliseAction(raw: string): string {
  return String(raw || '')
    .replace(/[_\-\s]/g, '')
    .toLowerCase();
}

/** Returns the normalised system payload, or null if `item` is not a system row. */
export function getSystemPayload(item: any): SystemPayload | null {
  if (!item) return null;
  // Accept a message row (systemKind/systemMeta), the legacy `system` object,
  // or a conversation-list row (lastSystemKind/lastSystemMeta).
  const kindRaw =
    item.systemKind ||
    item.lastSystemKind ||
    item.system?.action ||
    item.action ||
    '';
  const isSystem =
    item.type === 'system' ||
    item.messageType === 'system' ||
    item.__kind === 'system' ||
    !!item.systemKind ||
    !!item.lastSystemKind;
  if (!isSystem || !kindRaw) return null;

  const meta = item.systemMeta || item.lastSystemMeta || item.system || {};
  const targetIds: string[] = Array.isArray(meta.targetIds)
    ? meta.targetIds.map((t: any) => String(t))
    : meta.targetId
    ? [String(meta.targetId)]
    : Array.isArray(item.targetIds)
    ? item.targetIds.map((t: any) => String(t))
    : [];
  return {
    action: normaliseAction(kindRaw),
    actorId: String(meta.actorId || item.senderId || item.actorId || ''),
    targetIds,
    value: String(meta.value ?? meta.newName ?? item.value ?? ''),
  };
}

/** True when a row is a system event of the given canonical key (any casing). */
export function isSystemAction(item: any, canonicalKey: string): boolean {
  const payload = getSystemPayload(item);
  return !!payload && payload.action === normaliseAction(canonicalKey);
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
    case 'groupcreated':
      return `${actor} created the group${gname ? ` "${gname}"` : ''}`;
    case 'memberadded':
      return `${actor} added ${targets}`;
    case 'memberremoved':
      return `${actor} removed ${targets}`;
    case 'memberleft':
      return `${actor} left`;
    case 'memberjoined':
      return `${actor} joined via invite link`;
    case 'adminpromoted':
      return `${actor} made ${targets} an admin`;
    case 'admindemoted':
      return `${actor} removed ${targets} as admin`;
    case 'chieftransferred':
      return `${actor} transferred chief admin to ${targets}`;
    case 'grouprenamed':
      return `${actor} changed the group name${payload.value ? ` to "${payload.value}"` : ''}`;
    case 'groupiconchanged':
      return `${actor} changed the group icon`;
    case 'groupdescriptionchanged':
      return `${actor} changed the group description`;
    default:
      // Backend may send a pre-rendered plain sentence for unknown actions.
      return typeof item?.text === 'string' ? item.text : '';
  }
}
