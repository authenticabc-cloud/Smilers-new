// ICE server configuration for Smilers WebRTC calls.
// Matches the web app configuration exactly (Google STUN + Metered.ca TURN relay).
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  {
    urls: 'turn:a.relay.metered.ca:80',
    username: 'e8dd65b92c62d5e868a8c006',
    credential: 'RiesKOMPpnBVm5RD',
  },
  {
    urls: 'turn:a.relay.metered.ca:80?transport=tcp',
    username: 'e8dd65b92c62d5e868a8c006',
    credential: 'RiesKOMPpnBVm5RD',
  },
  {
    urls: 'turn:a.relay.metered.ca:443',
    username: 'e8dd65b92c62d5e868a8c006',
    credential: 'RiesKOMPpnBVm5RD',
  },
  {
    urls: 'turn:a.relay.metered.ca:443?transport=tcp',
    username: 'e8dd65b92c62d5e868a8c006',
    credential: 'RiesKOMPpnBVm5RD',
  },
] as const;

export const PEER_CONNECTION_CONFIG = {
  iceServers: ICE_SERVERS as unknown as RTCIceServer[],
  iceTransportPolicy: 'all' as const,
  bundlePolicy: 'max-bundle' as const,
  rtcpMuxPolicy: 'require' as const,
};
