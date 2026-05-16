export function normalizeDisplayText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const next = normalizeDisplayText(item);
      if (next) {
        return next;
      }
    }
    return '';
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidate = [
      record.displayName,
      record.name,
      record.fullName,
      record.username,
      record.title,
      record.label,
    ]
      .map(normalizeDisplayText)
      .find(Boolean);

    if (candidate) {
      return candidate;
    }

    const firstName = normalizeDisplayText(record.firstName);
    const lastName = normalizeDisplayText(record.lastName);
    return [firstName, lastName].filter(Boolean).join(' ').trim();
  }

  return '';
}

function isBrandFallback(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'smilers' || normalized === 'smilers user' || normalized === 'smilers contact';
}

function pickFirstDisplayName(values: unknown[], allowBrandFallback = true): string {
  const cleaned = values.map(normalizeDisplayText).filter(Boolean);
  if (allowBrandFallback) {
    return cleaned[0] || '';
  }
  return cleaned.find((value) => !isBrandFallback(value)) || cleaned[0] || '';
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