/**
 * StreamCallProvider + RingingOverlay — mounts the Stream client at the app
 * root and renders the native-style incoming/outgoing ringing UI.
 *
 * STAGED (Phase 1b): not yet imported by app/_layout.tsx. Wiring happens during
 * the destructive swap pass. See /app/memory/STREAM_MIGRATION.md.
 */
import React, { useEffect, useState } from 'react';
// @ts-expect-error — resolved after Phase 1b package install
import {
  StreamVideo,
  StreamCall,
  useCalls,
  RingingCallContent,
  CallContent,
  CallingState,
  type StreamVideoClient,
  type Call,
} from '@stream-io/video-react-native-sdk';
import { StyleSheet, View } from 'react-native';
import { createStreamVideoClient } from '../../lib/stream/streamClient';
import { setStreamPushConfig, registerStreamDevice } from '../../lib/stream/streamPush';

// Push config must be set as early as possible (module scope is ideal — done
// again here defensively so a cold JS start still registers it).
setStreamPushConfig();

/**
 * Renders the current Stream call full-screen: the native-style ringing UI
 * while it's RINGING (incoming or outgoing), then the in-call UI once JOINED.
 * Stream drives accept/reject/hangup via those components, so no custom call
 * screen is needed for 1:1.
 */
function ActiveCall() {
  const calls = useCalls() as Call[];
  // Prefer a joined/active call; otherwise the first ringing one.
  const joined = calls.find((c) => c.state.callingState === CallingState.JOINED);
  const ringing = calls.find(
    (c) => c.state.callingState === CallingState.RINGING || c.ringing === true,
  );
  const call = joined || ringing;
  if (!call) return null;

  const isRinging =
    !joined && (call.state.callingState === CallingState.RINGING || call.ringing === true);

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <StreamCall call={call}>{isRinging ? <RingingCallContent /> : <CallContent />}</StreamCall>
    </View>
  );
}

export default function StreamCallProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<StreamVideoClient | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const c = await createStreamVideoClient();
      if (!mounted) return;
      setClient(c);
      if (c) void registerStreamDevice(c);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (!client) return <>{children}</>;

  return (
    <StreamVideo client={client}>
      {children}
      <ActiveCall />
    </StreamVideo>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 9999, elevation: 9999 },
});
