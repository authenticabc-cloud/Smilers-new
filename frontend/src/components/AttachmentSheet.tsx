import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing, Shadow } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  onPickPhoto: () => void;
  onTakePhoto?: () => void;
  onPickVideo: () => void;
  onRecordVideo: () => void;
  onPickDocument?: () => void;
  onShareLocation?: () => void;
  onShareContact?: () => void;
}

export default function AttachmentSheet({
  visible,
  onClose,
  onPickPhoto,
  onTakePhoto,
  onPickVideo,
  onRecordVideo,
  onPickDocument,
  onShareLocation,
  onShareContact,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheetWrap} onPress={() => {}}>
          <View style={styles.sheet} testID="attachment-sheet">
            <ActionRow
              color="#FEF3C7"
              iconColor="#D97706"
              icon="camera-outline"
              lib="ion"
              label="Take Photo"
              onPress={() => {
                onClose();
                onTakePhoto?.();
              }}
              disabled={!onTakePhoto}
              testID="attach-take-photo"
            />
            <ActionRow
              color="#FCE7F3"
              iconColor="#EC4899"
              icon="image-outline"
              lib="ion"
              label="Photo from Gallery"
              onPress={() => {
                onClose();
                onPickPhoto();
              }}
              testID="attach-photo"
            />
            <ActionRow
              color="#E9D5FF"
              iconColor="#A855F7"
              icon="video-library"
              lib="mc"
              label="Video from Gallery"
              onPress={() => {
                onClose();
                onPickVideo();
              }}
              testID="attach-video-gallery"
            />
            <ActionRow
              color="#FCE7E7"
              iconColor="#EF4444"
              icon="videocam-outline"
              lib="ion"
              label="Record Video"
              onPress={() => {
                onClose();
                onRecordVideo();
              }}
              testID="attach-record-video"
            />
            <ActionRow
              color="#DBEAFE"
              iconColor="#3B82F6"
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
            <ActionRow
              color="#DCFCE7"
              iconColor="#22C55E"
              icon="location-outline"
              lib="ion"
              label="Location"
              onPress={() => {
                onClose();
                onShareLocation?.();
              }}
              disabled={!onShareLocation}
              testID="attach-location"
            />
            <ActionRow
              color="#FEF9C3"
              iconColor="#CA8A04"
              icon="account-arrow-right-outline"
              lib="mc"
              label="Contact"
              onPress={() => {
                onClose();
                onShareContact?.();
              }}
              disabled={!onShareContact}
              testID="attach-contact"
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionRow({ color, iconColor, icon, lib, label, onPress, disabled, testID }: {
  color: string;
  iconColor: string;
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
      style={[styles.row, disabled ? styles.rowDisabled : null]}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
    >
      <View style={[styles.rowIcon, { backgroundColor: color }]}> 
        <Icon name={icon as any} size={24} color={iconColor} />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.1)', justifyContent: 'flex-end' },
  sheetWrap: {
    paddingHorizontal: 28,
    paddingBottom: 86,
    alignItems: 'flex-start',
  },
  sheet: {
    width: 292,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderRadius: 26,
    paddingVertical: 10,
    paddingHorizontal: 12,
    ...Shadow.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    minHeight: 68,
    paddingHorizontal: 8,
    borderRadius: Radius.lg,
  },
  rowDisabled: { opacity: 0.35 },
  rowIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { fontSize: 17, color: Colors.textPrimary, fontWeight: FontWeight.medium, flex: 1 },
});