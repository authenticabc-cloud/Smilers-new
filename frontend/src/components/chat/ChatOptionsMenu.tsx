/**
 * ChatOptionsMenu (extracted iter-184) — the bottom-sheet "more options"
 * menu opened from the chat header. Logic unchanged.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors } from '../../theme';

type MenuItemDef = {
  key: string;
  label: string;
  lib: 'feather' | 'ion' | 'mc';
  icon: string;
  destructive?: boolean;
};

export function ChatOptionsMenu({
  visible,
  title,
  muted,
  onClose,
  onAction,
}: {
  visible: boolean;
  title: string;
  muted: boolean;
  onClose: () => void;
  onAction: (key: string) => void;
}) {
  const items: MenuItemDef[] = [
    { key: 'export', label: 'Export chat', lib: 'feather', icon: 'download' },
    { key: 'media', label: 'Media & Files', lib: 'feather', icon: 'image' },
    { key: 'scheduled', label: 'Scheduled messages', lib: 'feather', icon: 'clock' },
    { key: 'mute', label: muted ? 'Unmute notifications' : 'Mute notifications', lib: 'feather', icon: muted ? 'bell' : 'bell-off' },
    { key: 'location', label: 'Request live location', lib: 'feather', icon: 'navigation' },
    { key: 'sendMoney', label: 'Send money', lib: 'feather', icon: 'dollar-sign' },
    { key: 'shareScreen', label: 'Share screen', lib: 'feather', icon: 'monitor' },
    { key: 'block', label: `Block ${title}`, lib: 'ion', icon: 'ban-outline', destructive: true },
    { key: 'report', label: `Report ${title}`, lib: 'feather', icon: 'flag', destructive: true },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={menuStyles.backdrop} onPress={onClose}>
        <Pressable style={menuStyles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={menuStyles.dragHandle} />
          {items.map((item, idx) => {
            const color = item.destructive ? Colors.danger : Colors.textPrimary;
            const isLast = idx === items.length - 1;
            return (
              <TouchableOpacity
                key={item.key}
                style={[menuStyles.row, isLast && { borderBottomWidth: 0 }]}
                onPress={() => onAction(item.key)}
                activeOpacity={0.6}
                testID={`menu-${item.key}`}
              >
                <View style={menuStyles.iconWrap}>
                  {item.lib === 'feather' ? (
                    <Feather name={item.icon as any} size={22} color={color} />
                  ) : item.lib === 'ion' ? (
                    <Ionicons name={item.icon as any} size={22} color={color} />
                  ) : (
                    <MaterialCommunityIcons name={item.icon as any} size={22} color={color} />
                  )}
                </View>
                <Text
                  style={[
                    menuStyles.label,
                    item.destructive && menuStyles.labelDanger,
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            style={menuStyles.cancelRow}
            onPress={onClose}
            activeOpacity={0.6}
            testID="menu-cancel"
          >
            <Text style={menuStyles.cancelLabel}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const menuStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    // iter-169 web parity: attachment sheet uses the app background token
    // so it tracks any future theme tweaks automatically.
    backgroundColor: Colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.18)',
    alignSelf: 'center',
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  iconWrap: {
    width: 32,
    alignItems: 'flex-start',
    marginRight: 12,
  },
  label: {
    fontSize: 17,
    color: Colors.textPrimary,
    fontWeight: '500',
    flex: 1,
  },
  labelDanger: {
    color: Colors.danger,
    fontWeight: '700',
  },
  cancelRow: {
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  cancelLabel: {
    fontSize: 17,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
});
