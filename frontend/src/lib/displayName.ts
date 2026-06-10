function nextVisited(visited?: WeakSet<object>) {
  return visited ?? new WeakSet<object>();
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

export function normalizeDisplayText(value: unknown, visited?: WeakSet<object>, depth = 0): string {
  if (depth > 4) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const next = normalizeDisplayText(item, visited, depth + 1);
      if (next) {
        return next;
      }
    }
    return '';
  }

  if (value && typeof value === 'object') {
    const seen = nextVisited(visited);
    if (seen.has(value)) {
      return '';
    }
    seen.add(value);

    const record = value as Record<string, unknown>;
    const candidate = [
      record.displayName,
      record.name,
      record.fullName,
      record.username,
      record.title,
      record.label,
    ]
      .map((entry) => normalizeDisplayText(entry, seen, depth + 1))
      .find(Boolean);

    if (candidate) {
      return candidate;
    }

    const firstName = normalizeDisplayText(record.firstName, seen, depth + 1);
    const lastName = normalizeDisplayText(record.lastName, seen, depth + 1);
    return [firstName, lastName].filter(Boolean).join(' ').trim();
  }

  return '';
}

function isBrandFallback(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'smilers' || normalized === 'smilers user' || normalized === 'smilers contact';
}

function pickFirstDisplayName(values: unknown[], allowBrandFallback = true): string {
  const cleaned = values.map((value) => normalizeDisplayText(value)).filter(Boolean);
  if (allowBrandFallback) {
    return cleaned[0] || '';
  }
  return cleaned.find((value) => !isBrandFallback(value)) || cleaned[0] || '';
}

export function getUserIdFromRecord(record: any): string {
  return [
    record?.userId,
    record?.otherUserId,
    record?.user?._id,
    record?.user?.id,
    record?.otherUser?._id,
    record?.otherUser?.id,
    record?._id,
    record?.id,
  ]
    .map(normalizeId)
    .find(Boolean) || '';
}

export function getEntityUserIds(entity: any, currentUserId?: string | null): string[] {
  const values = new Set<string>();
  const addValue = (value: unknown) => {
    const normalized = normalizeId(value);
    if (!normalized || normalized === currentUserId) {
      return;
    }
    values.add(normalized);
  };

  if (typeof entity === 'string') {
    addValue(entity);
    return Array.from(values);
  }

  addValue(entity?.userId);
  addValue(entity?.otherUserId);
  addValue(entity?.user?._id);
  addValue(entity?.user?.id);
  addValue(entity?.otherUser?._id);
  addValue(entity?.otherUser?.id);

  [entity?.memberIds, entity?.participantIds, entity?.userIds].forEach((list) => {
    if (Array.isArray(list)) {
      list.forEach(addValue);
    }
  });

  [entity?.participants, entity?.members].forEach((list) => {
    if (!Array.isArray(list)) {
      return;
    }
    list.forEach((member) => {
      addValue(member?.userId);
      addValue(member?._id);
      addValue(member?.id);
    });
  });

  return Array.from(values);
}

export function findSavedContactDisplayName(contacts: any[] | undefined, entity: any, currentUserId?: string | null): string {
  const contact = getSavedContactRecord(contacts, entity, currentUserId);
  return contact ? getDisplayNameFromUser(contact, '') : '';
}

export function getSavedContactRecord(contacts: any[] | undefined, entity: any, currentUserId?: string | null): any | null {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return null;
  }

  const ids = new Set(getEntityUserIds(entity, currentUserId));
  if (ids.size === 0) {
    return null;
  }

  for (const contact of contacts) {
    const contactIds = getEntityUserIds(contact);
    if (contactIds.some((id) => ids.has(id))) {
      return contact;
    }
  }

  return null;
}

export function getDisplayNameFromUser(user: any, fallback = 'Smilers user'): string {
  const direct = pickFirstDisplayName(
    [
      user?.displayName,
      user?.name,
      user?.fullName,
      user?.otherUserName,
      user?.username,
      user?.title,
      [user?.firstName, user?.lastName],
      user?.phoneE164,
      user?.phone,
      user?.email,
    ],
    false,
  );

  return direct || fallback;
}

export function getConversationDisplayName(
  conversation: any,
  currentUserId?: string | null,
  fallback = 'Smilers',
): string {
  const memberCandidates = [conversation?.participants, conversation?.members]
    .filter(Array.isArray)
    .flatMap((members: any[]) =>
      members
        .filter((member) => {
          const memberId = String(member?.userId || member?._id || member?.id || '');
          return !!member && (!currentUserId || !memberId || memberId !== currentUserId);
        })
        .map((member) =>
          pickFirstDisplayName(
            [member?.displayName, member?.name, member?.fullName, member?.username, [member?.firstName, member?.lastName]],
            false,
          ),
        )
        .filter(Boolean),
    );

  const directName = pickFirstDisplayName(
    [
      conversation?.otherUserName,
      conversation?.otherUser?.displayName,
      conversation?.otherUser?.name,
      conversation?.otherUser?.fullName,
      conversation?.otherUser?.username,
      [conversation?.otherUser?.firstName, conversation?.otherUser?.lastName],
      memberCandidates,
    ],
    false,
  );

  const conversationName = normalizeDisplayText(conversation?.name);

  if (conversation?.type === 'group') {
    return conversationName || directName || fallback;
  }

  return directName || (!isBrandFallback(conversationName) ? conversationName : '') || fallback;
}

export function getDisplayInitials(name: unknown, maxLetters = 1): string {
  const displayName = normalizeDisplayText(name);
  if (!displayName) {
    return '?';
  }

  const parts = displayName
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return '?';
  }

  if (maxLetters <= 1) {
    return parts[0].charAt(0).toUpperCase();
  }

  return parts
    .slice(0, maxLetters)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}