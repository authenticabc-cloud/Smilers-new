import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Spacing, Shadow } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  onPickPhoto: () => void;
  onTakePhoto: () => void;
  onPickDocument?: () => void;
  onCreatePoll?: () => void;
}

export default function AttachmentSheet({
  visible,
  onClose,
  onPickPhoto,
  onTakePhoto,
  onPickDocument,
  onCreatePoll,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}} testID="attachment-sheet">
          <View style={styles.grabber} />
          <Text style={styles.title} testID="attachment-sheet-title">
            Share
          </Text>
          <View style={styles.grid}>
            <Tile
              color="#3B82F6"
              icon="image"
              lib="feather"
              label="Photo"
              onPress={() => {
                onClose();
                onPickPhoto();
              }}
              testID="attach-photo"
            />
            <Tile
              color="#EF4444"
              icon="camera"
              lib="feather"
              label="Camera"
              onPress={() => {
                onClose();
                onTakePhoto();
              }}
              testID="attach-camera"
            />
            <Tile
              color="#8B5CF6"
              icon="file-document-outline"
              lib="mc"
              label="Document"
              onPress={() => {
                onClose();
                onPickDocument?.();
              }}
              disabled={!onPickDocument}
              testID="attach-document"
            />
            <Tile
              color="#10B981"
              icon="bar-chart-2"
              lib="feather"
              label="Poll"
              onPress={() => {
                onClose();
                onCreatePoll?.();
              }}
              disabled={!onCreatePoll}
              testID="attach-poll"
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Tile({
  color,
  icon,
  lib,
  label,
  onPress,
  disabled,
  testID,
}: {
  color: string;
  icon: string;
  lib: 'feather' | 'ion' | 'mc';
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const Icon: any = lib === 'ion' ? Ionicons : lib === 'mc' ? MaterialCommunityIcons : Feather;

  return (
    <TouchableOpacity
      style={[styles.tile, disabled ? styles.tileDisabled : null]}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
    >
      <View style={[styles.tileIcon, { backgroundColor: color }]}>
        <Icon name={icon as any} size={26} color={Colors.white} />
      </View>
      <Text style={styles.tileLabel}>{label}</Text>
      {disabled ? <Text style={styles.tileBadge}>Soon</Text> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.xl,
    ...Shadow.lg,
  },
  grabber: {
    width: 40,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginVertical: Spacing.sm,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    marginBottom: Spacing.base,
    textAlign: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-around', gap: Spacing.base },
  tile: { alignItems: 'center', gap: 8, width: '22%', minHeight: 96 },
  tileDisabled: { opacity: 0.35 },
  tileIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: FontWeight.medium },
  tileBadge: { fontSize: 9, color: Colors.textMuted, marginTop: -4 },
});