/**
 * usePhoneMessageActions — makes phone numbers inside chat messages
 * actionable (user request, iter-222).
 *
 * Tapping a phone number in a message:
 *   1. Looks the number up against Smilers accounts (api.users.getByPhone).
 *   2. If the number belongs to a Smilers user → offer "Message" which
 *      opens (or creates) a direct conversation with them.
 *   3. If NOT on Smilers → offer "Invite", which opens the native share
 *      sheet pre-filled with the inviter's referral code (so the referral
 *      is credited exactly like the Earnings screen's Share button).
 *
 * The referral code is fetched lazily on tap (convex.query) rather than via
 * a live subscription, so this hook stays cheap when mounted inside every
 * message bubble.
 */
import { useCallback } from 'react';
import { Alert, Share } from 'react-native';
import { useRouter } from 'expo-router';
import { useConvex, useMutation } from 'convex/react';
import { api } from '../convexApi';
import { lookupUserByPhone } from './phoneLookup';
import { buildInviteMessage } from './inviteLink';

/** Find phone-number-like substrings. Matches an optional leading + then a
 *  run of digits, spaces, dashes, dots and parentheses. Validated by digit
 *  count before being treated as a real number. */
export const PHONE_REGEX = /\+?\d[\d\s().-]{5,}\d/g;

export function isLikelyPhoneNumber(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

export interface PhoneMatch {
  start: number;
  end: number;
  text: string;
}

/** Locate all phone-number substrings inside `text`. */
export function findPhoneMatches(text: string): PhoneMatch[] {
  if (!text) return [];
  const matches: PhoneMatch[] = [];
  PHONE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PHONE_REGEX.exec(text)) !== null) {
    const raw = m[0];
    if (isLikelyPhoneNumber(raw)) {
      matches.push({ start: m.index, end: m.index + raw.length, text: raw });
    }
    // Guard against zero-length loops (defensive — regex always advances).
    if (PHONE_REGEX.lastIndex === m.index) PHONE_REGEX.lastIndex += 1;
  }
  return matches;
}

export function usePhoneMessageActions() {
  const router = useRouter();
  const convex = useConvex();
  const getOrCreateDirect = useMutation(api.conversations.getOrCreateDirect);

  const onPhonePress = useCallback(
    async (rawNumber: string) => {
      const number = String(rawNumber || '').trim();
      if (!number) return;
      let match: any = null;
      try {
        match = await lookupUserByPhone(convex, number);
      } catch {
        match = null;
      }

      if (match && match._id) {
        const name = match.displayName || number;
        Alert.alert(
          name,
          'This number is on Smilers.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Message',
              onPress: async () => {
                try {
                  const result: any = await getOrCreateDirect({ otherUserId: match._id as any });
                  const id = result?._id || result?.conversationId || result?.id || result;
                  if (typeof id === 'string' && id.length > 0) {
                    router.push(`/chat/${encodeURIComponent(id)}` as any);
                  }
                } catch {
                  Alert.alert('Could not open chat', 'Please try again.');
                }
              },
            },
          ],
        );
        return;
      }

      // Not on Smilers → invite with the user's referral code.
      let referralCode: string | null = null;
      try {
        const profile: any = await convex.query((api as any).earnings.getMyProfile, {});
        referralCode = profile?.referralCode || null;
        if (!referralCode) {
          const created: any = await (convex as any).mutation(
            (api as any).earnings.getOrCreateReferralCode,
            {},
          );
          referralCode =
            typeof created === 'string' ? created : created?.code || created?.referralCode || null;
        }
      } catch {
        referralCode = null;
      }

      Alert.alert(
        'Not on Smilers yet',
        `${number} isn't on Smilers. Invite them to join?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Invite',
            onPress: async () => {
              try {
                await Share.share({
                  message: buildInviteMessage(referralCode),
                  title: 'Join me on Smilers',
                });
              } catch {
                /* user cancelled share — ignore */
              }
            },
          },
        ],
      );
    },
    [convex, getOrCreateDirect, router],
  );

  return { onPhonePress };
}
