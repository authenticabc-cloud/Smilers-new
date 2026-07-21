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
  CallingState,
  type StreamVideoClient,
  type Call,
} from '@stream-io/video-react-native-sdk';
import { createStreamVideoClient } from '../../lib/stream/streamClient';
import { setStreamPushConfig, registerStreamDevice } from '../../lib/stream/streamPush';

// Push config must be set as early as possible (module scope is ideal — done
// again here defensively so a cold JS start still registers it).
setStreamPushConfig();

function RingingCalls() {
  const calls = useCalls().filter(
    (c: Call) =>
      c.state.callingState === CallingState.RINGING ||
      c.ringing === true,
  );
  const call = calls[0];
  if (!call) return null;
  return (
    <StreamCall call={call}>
      <RingingCallContent />
    </StreamCall>
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
      <RingingCalls />
    </StreamVideo>
  );
}
