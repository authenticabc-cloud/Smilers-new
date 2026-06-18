/**
 * useTwilioCallSession — native (iOS/Android) implementation.
 *
 * Loaded automatically by Metro on iOS/Android due to the `.native.ts`
 * extension. The web preview uses the sibling `useTwilioCallSession.ts`
 * stub instead — that's why this file can safely import the SDK.
 *
 * Responsibilities:
 *   1. Build a TwilioCallSession instance for the call.
 *   2. Mount a hidden `<TwilioVideo>` host component (returned as
 *      `videoElement` — the screen renders it once, anywhere in the tree).
 *   3. Bridge SDK event callbacks into TwilioCallSession's
 *      mark- and emit- methods + a local participants[] state for the UI.
 *   4. Auto-connect on mount (once the token is set), auto-leave on
 *      unmount.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TwilioVideo, TwilioVideoLocalView, TwilioVideoParticipantView, TwilioVideoScreenShareView } from '@twilio/video-react-native-sdk';
import { StyleSheet } from 'react-native';

import {
  TwilioCallSession,
  type TwilioConnectionState,
  type TwilioVideoRef,
  type ScreenShareState,
} from './TwilioCallSession';

export interface TwilioParticipant {
  sid: string;
  identity: string;
  videoTrackSid?: string;
  audioMuted?: boolean;
  videoMuted?: boolean;
}

export interface TwilioCallHostState {
  session: TwilioCallSession | null;
  state: TwilioConnectionState;
  participants: TwilioParticipant[];
  videoElement: React.ReactElement | null;
  screenShareState: ScreenShareState;
  /** Render the local self-view. null on web. */
  renderLocalView: (style?: any, enabled?: boolean) => React.ReactElement | null;
  /** Render a remote participant's video. null if SDK unavailable. */
  renderParticipantView: (
    participant: TwilioParticipant,
    style?: any,
  ) => React.ReactElement | null;
  /** Render the local screen-share preview when active. */
  renderScreenShareView: (enabled: boolean, style?: any) => React.ReactElement | null;
  isSupported: boolean;
  error: string | null;
}

export interface UseTwilioCallSessionArgs {
  identity: string;
  roomName: string;
  token: string;
  isVideo: boolean;
  isCaller: boolean;
  region?: string;
  /** Defaults to true. Useful for deferring connect until token is ready. */
  enabled?: boolean;
}

export function useTwilioCallSession(args: UseTwilioCallSessionArgs): TwilioCallHostState {
  const { identity, roomName, token, isVideo, isCaller, region, enabled = true } = args;

  const twilioRef = useRef<TwilioVideoRef | null>(null);
  const sessionRef = useRef<TwilioCallSession | null>(null);
  const [state, setState] = useState<TwilioConnectionState>('idle');
  const [participants, setParticipants] = useState<TwilioParticipant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [screenShareState, setScreenShareState] = useState<ScreenShareState>('off');

  // Build the session ONCE per call (changing identity/room mid-call
  // makes no sense — caller should unmount + remount the screen).
  const session = useMemo(() => {
    const s = new TwilioCallSession({
      identity,
      roomName,
      token,
      isVideo,
      isCaller,
      region,
      onStateChange: (next, detail) => {
        setState(next);
        if (next === 'failed' && detail) setError(detail);
      },
      onParticipantConnected: (sid, ident) => {
        setParticipants((prev) =>
          prev.some((p) => p.sid === sid) ? prev : [...prev, { sid, identity: ident }],
        );
      },
      onParticipantDisconnected: (sid) => {
        setParticipants((prev) => prev.filter((p) => p.sid !== sid));
      },
      onError: (err) => setError(err.message),
      onScreenShareChange: (next) => setScreenShareState(next),
    });
    sessionRef.current = s;
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-connect once we have a ref + token + caller is enabled.
  useEffect(() => {
    if (!enabled || !token) return;
    // Defer one tick so the <TwilioVideo> ref is populated.
    const id = setTimeout(() => {
      session.connect();
    }, 50);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, token]);

  // Always leave on unmount.
  useEffect(() => {
    return () => {
      try {
        sessionRef.current?.leave();
      } catch {}
    };
  }, []);

  // Bind SDK events to the session. These callbacks are stable refs so
  // we declare them once outside of <TwilioVideo>'s JSX.
  const handleRoomDidConnect = useCallback(() => {
    session.markConnected();
  }, [session]);

  const handleRoomDidDisconnect = useCallback(
    (evt?: { error?: string }) => {
      session.markDisconnected(evt?.error);
    },
    [session],
  );

  const handleRoomDidFailToConnect = useCallback(
    (evt?: { error?: string }) => {
      session.markDisconnected(evt?.error || 'failed to connect');
    },
    [session],
  );

  const handleRoomIsReconnecting = useCallback(
    (evt?: { error?: string }) => {
      session.markReconnecting(evt?.error);
    },
    [session],
  );

  const handleRoomDidReconnect = useCallback(() => {
    session.markReconnected();
  }, [session]);

  const handleParticipantConnected = useCallback(
    (evt: { participant?: { sid?: string; identity?: string } }) => {
      const sid = evt?.participant?.sid;
      const ident = evt?.participant?.identity;
      if (sid && ident) session.emitParticipantConnected(sid, ident);
    },
    [session],
  );

  const handleParticipantDisconnected = useCallback(
    (evt: { participant?: { sid?: string; identity?: string } }) => {
      const sid = evt?.participant?.sid;
      const ident = evt?.participant?.identity;
      if (sid && ident) session.emitParticipantDisconnected(sid, ident);
    },
    [session],
  );

  // Track-level events let us update the video track SID per participant
  // so <TwilioVideoParticipantView> can render the right stream.
  const handleParticipantAddedVideoTrack = useCallback(
    (evt: any) => {
      const sid = evt?.participant?.sid;
      const trackSid = evt?.track?.trackSid;
      if (!sid || !trackSid) return;
      setParticipants((prev) =>
        prev.map((p) => (p.sid === sid ? { ...p, videoTrackSid: trackSid, videoMuted: false } : p)),
      );
    },
    [],
  );

  const handleParticipantRemovedVideoTrack = useCallback((evt: any) => {
    const sid = evt?.participant?.sid;
    if (!sid) return;
    setParticipants((prev) =>
      prev.map((p) => (p.sid === sid ? { ...p, videoTrackSid: undefined } : p)),
    );
  }, []);

  // Phase A.5 — local screen-share lifecycle. Twilio fires
  // onScreenShareChanged with screenShareEnabled true/false. We map
  // those to the session state machine.
  const handleScreenShareChanged = useCallback(
    (evt: { screenShareEnabled?: boolean }) => {
      const next: ScreenShareState = evt?.screenShareEnabled ? 'on' : 'off';
      session.markScreenShareState(next);
    },
    [session],
  );

  // iter-228: render helpers. These were declared in the interface but never
  // implemented/returned, so `host.renderParticipantView` / `renderLocalView`
  // were `undefined` — the remote tile (and a shared screen) never rendered.
  // `scaleType: 'fit'` ensures a shared screen is shown in full (no crop);
  // it letterboxes a camera tile, which is acceptable.
  const renderLocalView = useCallback(
    (style?: any, enabled: boolean = true) =>
      React.createElement(TwilioVideoLocalView, { enabled, scaleType: 'fit', style }),
    [],
  );

  const renderParticipantView = useCallback(
    (participant: TwilioParticipant, style?: any) => {
      if (!participant?.videoTrackSid) return null;
      return React.createElement(TwilioVideoParticipantView, {
        style,
        scaleType: 'fit',
        trackIdentifier: { videoTrackSid: participant.videoTrackSid },
      });
    },
    [],
  );

  const renderScreenShareView = useCallback(
    (enabled: boolean, style?: any) =>
      enabled ? React.createElement(TwilioVideoScreenShareView, { scaleType: 'fit', style }) : null,
    [],
  );

  // Build the host element ONCE — it's stable across renders so React
  // doesn't unmount and remount the Twilio component (which would drop
  // the call).
  const videoElement = useMemo<React.ReactElement>(
    () =>
      React.createElement(TwilioVideo, {
        ref: (r: any) => {
          twilioRef.current = r;
          session.attach(r);
        },
        onRoomDidConnect: handleRoomDidConnect,
        onRoomDidDisconnect: handleRoomDidDisconnect,
        onRoomDidFailToConnect: handleRoomDidFailToConnect,
        onRoomIsReconnecting: handleRoomIsReconnecting,
        onRoomDidReconnect: handleRoomDidReconnect,
        onRoomParticipantDidConnect: handleParticipantConnected,
        onRoomParticipantDidDisconnect: handleParticipantDisconnected,
        onParticipantAddedVideoTrack: handleParticipantAddedVideoTrack,
        onParticipantRemovedVideoTrack: handleParticipantRemovedVideoTrack,
        onScreenShareChanged: handleScreenShareChanged,
      }),
    // session is referentially stable per call lifecycle
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    session,
    state,
    participants,
    videoElement,
    screenShareState,
    renderLocalView,
    renderParticipantView,
    renderScreenShareView,
    isSupported: true,
    error,
  };
}
