/**
 * Preview-only route for visually verifying the ScheduleMessageSheet
 * component matches the Smilers web app reference. Open at /schedule-preview.
 */

import React, { useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScheduleMessageSheet, {
  ScheduleSelection,
} from '../src/components/ScheduleMessageSheet';
import { Colors, FontSize, FontWeight, Radius } from '../src/theme';

export default function ScheduleMessagePreview() {
  const [open, setOpen] = useState(true);
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.toolbar}>
        <Text style={styles.title}>Schedule sheet preview</Text>
        <TouchableOpacity
          style={styles.openBtn}
          onPress={() => setOpen(true)}
          testID="schedule-preview-open"
        >
          <Text style={styles.openBtnText}>Open sheet</Text>
        </TouchableOpacity>
      </View>
      <ScheduleMessageSheet
        visible={open}
        onCancel={() => setOpen(false)}
        onConfirm={(selection: ScheduleSelection) => {
          setOpen(false);
          Alert.alert(
            'Selected',
            JSON.stringify(
              {
                whenIso: new Date(selection.whenMs).toISOString(),
                recurring: selection.recurring,
                frequency: selection.frequency,
              },
              null,
              2,
            ),
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  toolbar: { padding: 20, gap: 16 },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  openBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignSelf: 'flex-start',
  },
  openBtnText: { color: Colors.white, fontWeight: FontWeight.bold, fontSize: FontSize.base },
});
