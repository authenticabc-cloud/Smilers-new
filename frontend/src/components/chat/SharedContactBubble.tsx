/**
 * SharedContactBubble — renders a `messages.type === 'contact'` payload.
 *
 * Per the canonical Share Contacts spec (docs/SHARE_CONTACTS_NATIVE_CONTRACT.md):
 *   - One message can carry MULTIPLE shared contact cards.
 *   - Each card has optional userId / name / phone / avatar fields.
 *   - When the sender chose "Include name = OFF", the `name` field is
 *     OMITTED entirely. We then use the phone as the title.
 *   - If `userId` is present, a "Message" action opens (or creates) a
 *     direct conversation with that user via
 *     `api.conversations.getOrCreateDirect({ otherUserId })`.
 */
import React, { useCallback } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '../../convexApi';
import { Colors } from '../../theme';

export interface SharedContact {
  userId?: string;
  name?: string;
  phone?: string;
  avatar?: string;
}

export function SharedContactBubble({
  contacts,
  isMine,
}: {
  contacts: SharedContact[];
  isMine: boolean;
}) {
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  return (
    <View style={[styles.wrap, isMine ? styles.wrapMine : styles.wrapTheirs]}>
      {contacts.map((c, idx) => (
        <SharedContactCard key={`${c.userId || c.phone || idx}-${idx}`} contact={c} isMine={isMine} />
      ))}
    </View>
  );
}

function SharedContactCard({ contact, isMine }: { contact: SharedContact; isMine: boolean }) {
  const router = useRouter();
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);
  const [opening, setOpening] = React.useState(false);

  // Title precedence per spec: name → phone → "Contact".
  const title = (contact.name && contact.name.trim()) || contact.phone || 'Contact';
  // Subtitle: when name is present we show the phone underneath.
  // When name is OMITTED (shared without name) we show the helper line.
  const subtitle = contact.name && contact.phone ? contact.phone : (contact.name ? undefined : 'Shared contact');

  const onOpenChat = useCallback(async () => {
    if (!contact.userId || opening) return;
    setOpening(true);
    try {
      const result: any = await getOrCreateDirect({ otherUserId: contact.userId as any });
      const rawId = result?._id || result?.conversationId || result?.id || result;
      if (typeof rawId === 'string' && rawId.length > 0) {
        router.push(`/chat/${encodeURIComponent(rawId)}` as any);
      }
    } catch {
      // swallow — user can retry; we don't have a toast hook here.
    } finally {
      setOpening(false);
    }
  }, [contact.userId, getOrCreateDirect, opening, router]);

  const initial = (title || '?').slice(0, 1).toUpperCase();

  return (
    <View style={[styles.card, isMine ? styles.cardMine : styles.cardTheirs]} testID="shared-contact-card">
      <View style={styles.row}>
        {contact.avatar ? (
          <Image source={{ uri: contact.avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
        )}
        <View style={styles.textBlock}>
          <Text style={[styles.title, isMine ? styles.titleMine : null]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, isMine ? styles.subtitleMine : null]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {contact.userId ? (
        <TouchableOpacity
          onPress={onOpenChat}
          disabled={opening}
          style={[styles.actionBtn, isMine ? styles.actionBtnMine : styles.actionBtnTheirs]}
          testID="shared-contact-message-btn"
        >
          {opening ? (
            <ActivityIndicator size="small" color={isMine ? Colors.headerBg : Colors.primary} />
          ) : (
            <>
              <MaterialCommunityIcons
                name="message-text-outline"
                size={14}
                color={isMine ? Colors.headerBg : Colors.primary}
              />
              <Text style={[styles.actionText, isMine ? styles.actionTextMine : null]}>Message</Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
    minWidth: 220,
    maxWidth: 280,
  },
  wrapMine: {},
  wrapTheirs: {},
  card: {
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardMine: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderColor: 'rgba(255, 255, 255, 0.20)',
  },
  cardTheirs: {
    backgroundColor: 'rgba(60, 40, 0, 0.04)',
    borderColor: 'rgba(60, 40, 0, 0.10)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  avatarFallback: {
    backgroundColor: '#FBBF24',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#3F2A00',
  },
  textBlock: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  titleMine: {
    color: '#FFFFFF',
  },
  subtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  subtitleMine: {
    color: 'rgba(255, 255, 255, 0.78)',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
    paddingVertical: 7,
    borderRadius: 999,
  },
  actionBtnMine: {
    backgroundColor: '#FFFFFF',
  },
  actionBtnTheirs: {
    backgroundColor: 'rgba(202, 138, 4, 0.12)',
  },
  actionText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.primary,
  },
  actionTextMine: {
    color: Colors.headerBg,
  },
});
