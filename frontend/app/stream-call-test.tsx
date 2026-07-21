/**
 * /stream-call-test — isolated Stream Video 1:1 connection test.
 *
 * The screen body lives in StreamTestCallEntry, which is platform-split at the
 * COMPONENT level (StreamTestCallEntry.web.tsx renders a notice) so the native
 * Stream Video SDK never enters the web bundle. This route file itself has no
 * platform extension, as expo-router requires.
 */
import React from 'react';
import StreamTestCallEntry from '../src/components/stream/StreamTestCallEntry';

export default function StreamCallTestRoute() {
  return <StreamTestCallEntry />;
}
