/**
 * StreamTestCallEntry (WEB) — Stream Video SDK is native-only, so on web we
 * render a notice instead of importing the SDK.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Colors } from '../../theme';

export default function StreamTestCallEntryWeb() {
  return (
    <View style={styles.c}>
      <Text style={styles.t}>
        The Stream connection test runs on the mobile app only. Open it from a device build.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#0B0B0B' },
  t: { color: Colors.white, textAlign: 'center', fontSize: 16, lineHeight: 22 },
});
