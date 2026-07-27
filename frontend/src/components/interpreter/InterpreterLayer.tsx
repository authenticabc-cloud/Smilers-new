/**
 * InterpreterLayer — self-contained AI Voice Interpreter overlay for the
 * call screen. Mount ONCE inside the call view; it owns all interpreter
 * state, the on-device speech capture (speaking side), translated-voice
 * playback (listening side), the status banner, live subtitles, and the
 * settings sheet.
 *
 * Speaking side  → on-device STT → api.callInterpreter.addUtterance
 * Listening side → api.callInterpreter.getSubtitles (reactive) →
 *                  api.callInterpreterAction.speakTranslation → play locally,
 *                  duck original per mode.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useMutation } from 'convex/react';
import { api } from '../../convexApi';
import { modeShowsSubtitles, type LangName, type VoiceMode } from '../../lib/interpreter/languages';
import { useCallInterpreter } from '../../lib/interpreter/useCallInterpreter';
import { useSpeechCapture } from '../../lib/interpreter/useSpeechCapture';
import {
  useCallSubtitles,
  useTranslatedPlayback,
} from '../../lib/interpreter/useTranslatedPlayback';
import { InterpreterBanner } from './InterpreterBanner';
import { InterpreterSettingsSheet } from './InterpreterSettingsSheet';
import { SubtitlesOverlay } from './SubtitlesOverlay';
import { CallAiMenu } from './CallAiMenu';
import { callDebug } from '../../lib/callDebugLog';

export function InterpreterLayer({
  callId,
  connected,
  micMuted,
  topOffset,
  bottomOffset,
  onDuckRemote,
}: {
  callId: string | null;
  connected: boolean;
  micMuted: boolean;
  topOffset: number;
  bottomOffset: number;
  onDuckRemote: (ducked: boolean) => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const [showAiMenu, setShowAiMenu] = useState(false);
  const interp = useCallInterpreter(callId);
  const addUtterance = useMutation(api.callInterpreter.addUtterance);
  const subtitles = useCallSubtitles(callId);

  const captureActive =
    connected && interp.enabled && interp.voiceMode !== 'original' && !micMuted;

  // sml-interp: diagnostics so a captured log reveals WHERE the interpreter
  // breaks — whether the Convex interpreter functions responded (loading/
  // participants), whether capture is active, and how many subtitles arrive.
  const availLoggedRef = useRef(false);
  useEffect(() => {
    if (availLoggedRef.current) return;
    availLoggedRef.current = true;
    const hasGetForCall = Boolean((api as any).callInterpreter?.getForCall);
    const hasAddUtterance = Boolean((api as any).callInterpreter?.addUtterance);
    const hasSpeak = Boolean((api as any).callInterpreterAction?.speakTranslation);
    callDebug.push(
      'INTERP',
      `layer mounted callId=${callId || '(none)'} convexFns{getForCall=${hasGetForCall} addUtterance=${hasAddUtterance} speak=${hasSpeak}}`,
    );
  }, [callId]);
  useEffect(() => {
    callDebug.push(
      'INTERP',
      `state enabled=${interp.enabled} mode=${interp.voiceMode} speak=${interp.speakingLanguage} listen=${interp.listeningLanguage} captureActive=${captureActive} loading=${interp.loading}`,
    );
  }, [interp.enabled, interp.voiceMode, interp.speakingLanguage, interp.listeningLanguage, captureActive, interp.loading]);
  useEffect(() => {
    callDebug.push('INTERP', `subtitles received: ${Array.isArray(subtitles) ? subtitles.length : 0}`);
  }, [subtitles]);

  useSpeechCapture({
    active: captureActive,
    languageName: interp.speakingLanguage,
    onUtterance: (text) => {
      if (!callId) return;
      callDebug.push('INTERP', `utterance → addUtterance: "${text.slice(0, 40)}"`);
      addUtterance({ callId, sourceLanguage: interp.speakingLanguage, text } as any).catch(
        (e: any) => {
          callDebug.push('ERR', `INTERP addUtterance failed: ${String(e?.message || e).slice(0, 120)}`);
        },
      );
    },
  });

  useTranslatedPlayback({
    callId,
    listeningLanguage: interp.listeningLanguage,
    voiceMode: interp.voiceMode,
    playbackEnabled: connected && interp.enabled,
    prefs: interp.prefs,
    onDuck: onDuckRemote,
  });

  if (!connected) return null;

  const showSubs = interp.enabled && modeShowsSubtitles(interp.voiceMode as VoiceMode);
  const showOriginalCaption = interp.voiceMode === 'subtitles';

  return (
    <>
      <View style={[styles.bannerHost, { top: topOffset }]} pointerEvents="box-none">
        <InterpreterBanner
          enabled={interp.enabled}
          speakingLanguage={interp.speakingLanguage}
          listeningLanguage={interp.listeningLanguage}
          onOpen={() => setShowSettings(true)}
          onToggle={() => interp.save({ enabled: !interp.enabled })}
          onOpenAi={() => setShowAiMenu(true)}
        />
      </View>

      {showSubs ? (
        <View style={[styles.subsHost, { bottom: bottomOffset }]} pointerEvents="box-none">
          <SubtitlesOverlay
            lines={subtitles}
            listeningLanguage={interp.listeningLanguage}
            showOriginal={showOriginalCaption}
          />
        </View>
      ) : null}

      <InterpreterSettingsSheet
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        enabled={interp.enabled}
        speakingLanguage={interp.speakingLanguage as LangName}
        listeningLanguage={interp.listeningLanguage as LangName}
        voiceMode={interp.voiceMode as VoiceMode}
        prefs={interp.prefs}
        onSave={interp.save}
        onPrefs={interp.updatePrefs}
      />

      <CallAiMenu
        visible={showAiMenu}
        onClose={() => setShowAiMenu(false)}
        subtitles={subtitles}
        listeningLanguage={interp.listeningLanguage}
        onOpenInterpreter={() => setShowSettings(true)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bannerHost: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  subsHost: { position: 'absolute', left: 0, right: 0 },
});
