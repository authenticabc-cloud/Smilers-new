/**
 * ShareContactsDialog — 1:1 port of the web "Share Contacts" flow.
 *
 * Canonical spec: docs/SHARE_CONTACTS_NATIVE_CONTRACT.md
 *
 *   1. Pick contacts to share (multi-select, capped at 20).
 *   2. Toggle "Include name" — default ON. When OFF, the recipient
 *      only sees the phone number.
 *   3. Pick recipients (multi-select, capped at 50). When opened from
 *      inside a direct chat we expose `presetRecipientId` so the user
 *      can send straight to that chat in one tap.
 *   4. Fire `api.shareContacts.shareContacts({ contactIds,
 *      recipientIds, includeName })`.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useMutation, useQuery } from 'convex/react';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Contacts from 'expo-contacts';
import { api } from '../convexApi';
import { Colors } from '../theme';

type Step = 'pick-contacts' | 'pick-recipients' | 'sending';

const MAX_TOTAL_CONTACTS = 20;
const MAX_RECIPIENTS = 50;

interface DeviceContact {
  /** Unique row id for this picker session. */
  id: string;
  name?: string;
  phone: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Optional: when opened from inside a direct chat, pre-select this recipient. */
  presetRecipientId?: string | null;
}

export default function ShareContactsDialog({ visible, onClose, presetRecipientId }: Props) {
  const contacts = useQuery(api.contacts.getContacts, {}) as any[] | undefined;
  const shareContacts = useMutation(api.shareContacts.shareContacts);

  const [step, setStep] = useState<Step>('pick-contacts');
  const [includeName, setIncludeName] = useState(true);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
  // iter-206: device-book imports. These don't have a Smilers `_id`; the
  // server matches them by phone server-side. Per canonical spec we send
  // them as `rawContacts: Array<{ name?, phone }>`. Selection state for
  // them is "all of them" (we drop entries the user doesn't want before
  // showing the picker).
  const [deviceContacts, setDeviceContacts] = useState<DeviceContact[]>([]);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<Set<string>>(
    () => new Set(presetRecipientId ? [presetRecipientId] : [])
  );
  const [contactSearch, setContactSearch] = useState('');
  const [recipientSearch, setRecipientSearch] = useState('');

  // Total selected count for cap enforcement.
  const totalSelected = selectedContactIds.size + selectedDeviceIds.size;

  React.useEffect(() => {
    if (!visible) {
      // Reset on close for a clean next-open.
      setStep('pick-contacts');
      setIncludeName(true);
      setSelectedContactIds(new Set());
      setSelectedRecipientIds(new Set(presetRecipientId ? [presetRecipientId] : []));
      setContactSearch('');
      setRecipientSearch('');
      setDeviceContacts([]);
      setSelectedDeviceIds(new Set());
      setImporting(false);
    }
  }, [visible, presetRecipientId]);

  // iter-206: import contacts from the device address book and add
  // them to the picker as a "From device" group. We request the
  // platform permission contextually (only when the user taps Import),
  // and gracefully fall back if denied.
  const importFromDevice = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try {
      const perm = await Contacts.requestPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert(
          'Contacts permission needed',
          'Allow access to your device contacts to import them here.'
        );
        return;
      }
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
        sort: Contacts.SortTypes.FirstName,
      });
      const flat: DeviceContact[] = [];
      for (const c of data) {
        const phones = (c.phoneNumbers || []).filter((p) => p?.number);
        for (const p of phones) {
          const rawNum = String(p.number || '').trim();
          if (!rawNum) continue;
          flat.push({
            id: `dev::${c.id}::${rawNum}`,
            name: c.name || c.firstName || undefined,
            phone: rawNum,
          });
        }
      }
      if (flat.length === 0) {
        Alert.alert('No phone numbers found', 'None of your device contacts have a phone number to share.');
        return;
      }
      // De-dupe by phone digits.
      const seen = new Set<string>();
      const deduped = flat.filter((d) => {
        const k = d.phone.replace(/[^\d+]/g, '');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      setDeviceContacts(deduped);
      // iter-222: do NOT auto-select imported contacts. Auto-selecting the
      // first 20 confused users ("Next · 20" with nothing intentionally
      // picked) AND immediately hit the 20 cap, so tapping the contact they
      // actually searched for raised "Limit reached". Start with none
      // selected — the user taps exactly who they want to share.
      setSelectedDeviceIds(new Set());
    } catch (errorValue: any) {
      Alert.alert('Import failed', errorValue?.message || 'Could not load device contacts.');
    } finally {
      setImporting(false);
    }
  }, [importing, selectedContactIds.size]);

  // Filter contacts step — by name or phone substring.
  const filteredForContacts = useMemo(() => {
    if (!Array.isArray(contacts)) return [];
    const q = contactSearch.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const name = String(c?.name || '').toLowerCase();
      const phone = String(c?.phone || c?.phoneE164 || '').toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [contacts, contactSearch]);

  // iter-222: the search box must ALSO filter the device-imported list —
  // previously only the Smilers contacts were filtered, so typing a name
  // left the (often thousands of) device rows untouched and the user had
  // to scroll manually to find them.
  const filteredDeviceContacts = useMemo(() => {
    const q = contactSearch.trim().toLowerCase();
    if (!q) return deviceContacts;
    return deviceContacts.filter((d) => {
      const name = String(d.name || '').toLowerCase();
      const phone = String(d.phone || '').toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [deviceContacts, contactSearch]);

  // iter-222: single virtualized list (FROM DEVICE + SAVED ON SMILERS)
  // instead of rendering all device rows inside ListHeaderComponent — the
  // old approach rendered thousands of un-virtualized rows, which was slow
  // and made search feel unresponsive.
  type ContactRow =
    | { kind: 'section'; key: string; label: string }
    | { kind: 'device'; key: string; contact: DeviceContact }
    | { kind: 'smilers'; key: string; contact: any };

  const contactListData = useMemo<ContactRow[]>(() => {
    const rows: ContactRow[] = [];
    if (filteredDeviceContacts.length > 0) {
      rows.push({ kind: 'section', key: 'sec-device', label: 'FROM DEVICE' });
      filteredDeviceContacts.forEach((d) => rows.push({ kind: 'device', key: d.id, contact: d }));
    }
    if (filteredForContacts.length > 0) {
      if (deviceContacts.length > 0) {
        rows.push({ kind: 'section', key: 'sec-smilers', label: 'SAVED ON SMILERS' });
      }
      filteredForContacts.forEach((c) =>
        rows.push({ kind: 'smilers', key: String(c._id), contact: c }),
      );
    }
    return rows;
  }, [filteredDeviceContacts, filteredForContacts, deviceContacts.length]);

  // Recipients step — exclude the contacts being shared from the recipient list.
  const filteredForRecipients = useMemo(() => {
    if (!Array.isArray(contacts)) return [];
    const blocked = selectedContactIds;
    const q = recipientSearch.trim().toLowerCase();
    return contacts.filter((c) => {
      if (blocked.has(String(c?._id))) return false;
      if (!q) return true;
      const name = String(c?.name || '').toLowerCase();
      const phone = String(c?.phone || c?.phoneE164 || '').toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [contacts, recipientSearch, selectedContactIds]);

  const toggleContact = useCallback((id: string) => {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const newTotal = next.size + selectedDeviceIds.size + 1;
        if (newTotal > MAX_TOTAL_CONTACTS) {
          Alert.alert('Limit reached', `You can share up to ${MAX_TOTAL_CONTACTS} contacts at once.`);
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  }, [selectedDeviceIds.size]);

  const toggleDeviceContact = useCallback((id: string) => {
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const newTotal = selectedContactIds.size + next.size + 1;
        if (newTotal > MAX_TOTAL_CONTACTS) {
          Alert.alert('Limit reached', `You can share up to ${MAX_TOTAL_CONTACTS} contacts at once.`);
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  }, [selectedContactIds.size]);

  const toggleRecipient = useCallback((id: string) => {
    setSelectedRecipientIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= MAX_RECIPIENTS) {
          Alert.alert('Limit reached', `You can send to up to ${MAX_RECIPIENTS} chats at once.`);
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    if (totalSelected === 0) {
      Alert.alert('Pick at least one contact');
      return;
    }
    if (selectedRecipientIds.size === 0) {
      Alert.alert('Pick at least one recipient');
      return;
    }
    setStep('sending');
    // Build the rawContacts payload from the device picker selection.
    // Per canonical spec, `phone` is required; `name` is optional.
    const rawContacts = deviceContacts
      .filter((d) => selectedDeviceIds.has(d.id))
      .map((d) => (d.name ? { name: d.name, phone: d.phone } : { phone: d.phone }));
    try {
      const result: any = await shareContacts({
        contactIds: Array.from(selectedContactIds) as any[],
        ...(rawContacts.length > 0 ? { rawContacts } : {}),
        recipientIds: Array.from(selectedRecipientIds) as any[],
        includeName,
      });
      const sentTo = Number(result?.sentTo || 0);
      onClose();
      if (sentTo > 0) {
        setTimeout(() => {
          Alert.alert(
            sentTo === 1 ? 'Contact shared' : 'Contacts shared',
            sentTo === 1 ? 'Sent to 1 chat.' : `Sent to ${sentTo} chats.`
          );
        }, 200);
      }
    } catch (errorValue: any) {
      setStep('pick-recipients');
      const msg = errorValue?.data?.message || errorValue?.message || 'Could not share contacts.';
      Alert.alert("Couldn\u2019t share", String(msg));
    }
  }, [
    deviceContacts,
    includeName,
    onClose,
    selectedContactIds,
    selectedDeviceIds,
    selectedRecipientIds,
    shareContacts,
    totalSelected,
  ]);

  const renderContactRow = useCallback(
    ({ item, selected, onPress }: { item: any; selected: boolean; onPress: () => void }) => {
      const title = item?.name || item?.phone || 'Contact';
      const phone = item?.phone || item?.phoneE164 || '';
      const initial = String(title).slice(0, 1).toUpperCase();
      return (
        <TouchableOpacity style={styles.row} onPress={onPress} testID={`sc-row-${item?._id}`}>
          {item?.avatar ? (
            <Image source={{ uri: item.avatar }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarText}>{initial}</Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
            {item?.name && phone ? (
              <Text style={styles.rowSubtitle} numberOfLines={1}>{phone}</Text>
            ) : null}
          </View>
          <View style={[styles.checkbox, selected ? styles.checkboxOn : null]}>
            {selected ? (
              <MaterialCommunityIcons name="check" size={14} color="#FFFFFF" />
            ) : null}
          </View>
        </TouchableOpacity>
      );
    },
    []
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity
              onPress={() => {
                if (step === 'pick-recipients') {
                  setStep('pick-contacts');
                } else {
                  onClose();
                }
              }}
              style={styles.headerBtn}
              testID="sc-back"
            >
              <MaterialCommunityIcons
                name={step === 'pick-recipients' ? 'chevron-left' : 'close'}
                size={22}
                color={Colors.textPrimary}
              />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>
              {step === 'pick-recipients' ? 'Send to' : 'Share contact'}
            </Text>
            <View style={{ width: 36 }} />
          </View>

          {/* Body */}
          {step === 'sending' ? (
            <View style={styles.sending}>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.sendingText}>Sending\u2026</Text>
            </View>
          ) : step === 'pick-contacts' ? (
            <>
              <View style={styles.searchWrap}>
                <MaterialCommunityIcons name="magnify" size={18} color={Colors.textSecondary} />
                <TextInput
                  value={contactSearch}
                  onChangeText={setContactSearch}
                  placeholder="Search contacts"
                  placeholderTextColor={Colors.textSecondary}
                  style={styles.searchInput}
                  testID="sc-search-contacts"
                />
              </View>

              {/* iter-206 Import from device button. Opens the OS
                  contacts permission prompt, then reads names + phones
                  and adds them as a "From device" group below. */}
              <TouchableOpacity
                onPress={importFromDevice}
                disabled={importing}
                style={styles.importBtn}
                testID="sc-import-device"
              >
                {importing ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <>
                    <MaterialCommunityIcons name="cellphone-arrow-down" size={18} color={Colors.primary} />
                    <Text style={styles.importBtnText}>
                      {deviceContacts.length > 0
                        ? `Re-import from device (${deviceContacts.length})`
                        : 'Import from device'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleTitle}>Include name</Text>
                  <Text style={styles.toggleSubtitle}>
                    {includeName
                      ? 'Recipient will see the saved name and number.'
                      : 'Recipient will only see the phone number.'}
                  </Text>
                </View>
                <Switch
                  value={includeName}
                  onValueChange={setIncludeName}
                  trackColor={{ true: Colors.primary, false: '#D4D4D4' }}
                  thumbColor="#FFFFFF"
                  testID="sc-include-name"
                />
              </View>
              <FlatList
                data={contactListData}
                keyExtractor={(it) => it.key}
                renderItem={({ item }) => {
                  if (item.kind === 'section') {
                    return <Text style={styles.sectionLabel}>{item.label}</Text>;
                  }
                  if (item.kind === 'device') {
                    const d = item.contact;
                    return (
                      <TouchableOpacity
                        style={styles.row}
                        onPress={() => toggleDeviceContact(d.id)}
                        testID={`sc-dev-row-${d.id}`}
                      >
                        <View style={[styles.avatar, styles.avatarFallback]}>
                          <Text style={styles.avatarText}>
                            {(d.name || d.phone || '?').slice(0, 1).toUpperCase()}
                          </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.rowTitle} numberOfLines={1}>
                            {d.name || d.phone}
                          </Text>
                          {d.name ? (
                            <Text style={styles.rowSubtitle} numberOfLines={1}>{d.phone}</Text>
                          ) : null}
                        </View>
                        <View
                          style={[styles.checkbox, selectedDeviceIds.has(d.id) ? styles.checkboxOn : null]}
                        >
                          {selectedDeviceIds.has(d.id) ? (
                            <MaterialCommunityIcons name="check" size={14} color="#FFFFFF" />
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  }
                  return renderContactRow({
                    item: item.contact,
                    selected: selectedContactIds.has(String(item.contact._id)),
                    onPress: () => toggleContact(String(item.contact._id)),
                  });
                }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                  <Text style={styles.emptyText}>
                    {Array.isArray(contacts)
                      ? contactSearch.trim()
                        ? 'No contacts match your search.'
                        : 'No contacts to share.'
                      : 'Loading\u2026'}
                  </Text>
                }
              />
              <TouchableOpacity
                style={[styles.primaryBtn, totalSelected === 0 ? styles.btnDisabled : null]}
                onPress={() => setStep('pick-recipients')}
                disabled={totalSelected === 0}
                testID="sc-next"
              >
                <Text style={styles.primaryBtnText}>
                  {totalSelected > 0 ? `Next \u00B7 ${totalSelected}` : 'Next'}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={styles.searchWrap}>
                <MaterialCommunityIcons name="magnify" size={18} color={Colors.textSecondary} />
                <TextInput
                  value={recipientSearch}
                  onChangeText={setRecipientSearch}
                  placeholder="Search people"
                  placeholderTextColor={Colors.textSecondary}
                  style={styles.searchInput}
                  testID="sc-search-recipients"
                />
              </View>
              <FlatList
                data={filteredForRecipients}
                keyExtractor={(it: any) => String(it._id)}
                renderItem={({ item }) =>
                  renderContactRow({
                    item,
                    selected: selectedRecipientIds.has(String(item._id)),
                    onPress: () => toggleRecipient(String(item._id)),
                  })
                }
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                  <Text style={styles.emptyText}>No one to send to here.</Text>
                }
              />
              <TouchableOpacity
                style={[styles.primaryBtn, selectedRecipientIds.size === 0 ? styles.btnDisabled : null]}
                onPress={submit}
                disabled={selectedRecipientIds.size === 0}
                testID="sc-submit"
              >
                <Text style={styles.primaryBtnText}>
                  {selectedRecipientIds.size > 0
                    ? `Send \u00B7 ${selectedRecipientIds.size}`
                    : 'Send'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '85%',
    minHeight: '60%',
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  headerBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 14,
    marginTop: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(60, 40, 0, 0.06)',
    borderRadius: 999,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 9,
    color: Colors.textPrimary,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 6,
    marginHorizontal: 14,
    backgroundColor: 'rgba(202, 138, 4, 0.08)',
    borderRadius: 12,
  },
  importBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 14,
    marginTop: 10,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(202, 138, 4, 0.55)',
    backgroundColor: 'rgba(202, 138, 4, 0.06)',
  },
  importBtnText: {
    color: Colors.primary,
    fontWeight: '700',
    fontSize: 14,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: Colors.textSecondary,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  toggleTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  toggleSubtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  listContent: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
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
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  rowSubtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: '#C7C7C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  emptyText: {
    textAlign: 'center',
    color: Colors.textSecondary,
    paddingVertical: 28,
  },
  primaryBtn: {
    marginHorizontal: 14,
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: Colors.primary,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: Colors.headerBg,
    fontSize: 15,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  sending: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  sendingText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
});
