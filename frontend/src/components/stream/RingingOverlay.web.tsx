/**
 * Web passthrough for StreamCallProvider. The Stream Video SDK is native-only,
 * so on web (the preview surface) we render children unchanged and never import
 * the SDK — keeping the web bundle clean.
 */
import React from 'react';

export default function StreamCallProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
