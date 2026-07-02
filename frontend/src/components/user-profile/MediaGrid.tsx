import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Dimensions, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../theme';
import type { MediaTab } from './types';

const SCREEN_W = Dimensions.get('window').width;
const GRID_GAP = 8;
const GRID_PADDING = Spacing.lg;
const GRID_COLS = 3;
const GRID_TILE = Math.floor(
  (SCREEN_W - GRID_PADDING * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS,
);

/** Segmented tab button for the Photos / Videos / Files switcher. */
export function MediaTabBtn({
  active,
  icon,
  label,
  onPress,
  testID,
}: {
  active: boolean;
  icon: any;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.mediaTab, active ? styles.mediaTabActive : null]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      <Feather
        name={icon}
        size={15}
        color={active ? Colors.textPrimary : Colors.textSecondary}
      />
      <Text style={[styles.mediaTabLabel, active ? styles.mediaTabLabelActive : null]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** Grid (photos/videos) or list (files) of shared media between two users. */
export default function MediaGrid({
  tab,
  items,
  onPreview,
}: {
  tab: MediaTab;
  items: any[];
  onPreview: (uri: string) => void;
}) {
  if (items.length === 0) {
    return (
      <View style={styles.mediaEmptyWrap}>
        <Feather
          name={tab === 'photos' ? 'image' : tab === 'videos' ? 'film' : 'file-text'}
          size={28}
          color={Colors.textMuted}
        />
        <Text style={styles.mediaEmptyText}>
          {tab === 'photos'
            ? 'No shared photos yet.'
            : tab === 'videos'
              ? 'No shared videos yet.'
              : 'No shared files yet.'}
        </Text>
      </View>
    );
  }

  if (tab === 'files') {
    return (
      <View style={styles.filesList}>
        {items.map((file: any) => (
          <View key={file._id} style={styles.fileRow}>
            <View style={styles.fileIcon}>
              <Feather name="file-text" size={20} color={Colors.primary} />
            </View>
            <View style={styles.fileMeta}>
              <Text style={styles.fileName} numberOfLines={1}>
                {file?.fileName || 'Document'}
              </Text>
              <Text style={styles.fileSub}>
                {file?.mimeType
                  ? String(file.mimeType).split('/').pop()?.toUpperCase()
                  : 'FILE'}
              </Text>
            </View>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.mediaGrid}>
      {items.map((item: any) => {
        const src: string | null =
          item?.mediaUrl || item?.url || item?.imageUrl || item?.thumbnailUrl || null;
        return (
          <TouchableOpacity
            key={item._id}
            style={styles.mediaTile}
            activeOpacity={0.85}
            onPress={() => (src ? onPreview(src) : undefined)}
          >
            {src && /^https?:/i.test(src) ? (
              <Image source={{ uri: src }} style={styles.mediaTileImg} resizeMode="cover" />
            ) : (
              <View style={styles.mediaTilePlaceholder}>
                <Feather
                  name={tab === 'videos' ? 'film' : 'image'}
                  size={20}
                  color={Colors.textMuted}
                />
              </View>
            )}
            {tab === 'videos' ? (
              <View style={styles.mediaVideoOverlay}>
                <Feather name="play" size={18} color={Colors.white} />
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  mediaTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: Radius.md,
  },
  mediaTabActive: { backgroundColor: Colors.white },
  mediaTabLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },
  mediaTabLabelActive: { color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  mediaGrid: { marginTop: 14, flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  mediaTile: {
    width: GRID_TILE,
    height: GRID_TILE,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#EFE7D6',
    borderWidth: 1,
    borderColor: '#E0D6C0',
    position: 'relative',
  },
  mediaTileImg: { width: '100%', height: '100%' },
  mediaTilePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mediaVideoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  mediaEmptyWrap: { marginTop: 14, paddingVertical: Spacing.xl, alignItems: 'center', gap: 8 },
  mediaEmptyText: { fontSize: FontSize.sm, color: Colors.textMuted, fontStyle: 'italic' },
  filesList: { marginTop: 12, gap: 12 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileMeta: { flex: 1 },
  fileName: { fontSize: FontSize.base, color: Colors.textPrimary, fontWeight: FontWeight.semibold },
  fileSub: { marginTop: 2, fontSize: FontSize.xs, color: Colors.textSecondary },
});
