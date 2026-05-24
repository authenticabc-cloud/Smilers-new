# Backend Contract — `messages.setTranscription` to accept `transcriptionSegments`

The mobile app now sends **time-aligned transcription segments** so the fullscreen video player can render captions synced to the playback timeline (just like the web app's external video viewer).

## Change required

Extend `api.messages.setTranscription` mutation to accept one extra optional argument:

```ts
transcriptionSegments: v.optional(v.array(v.object({
  start: v.number(),  // seconds (Whisper's start time for this segment)
  end:   v.number(),  // seconds
  text:  v.string(),  // segment text (untrimmed punctuation OK)
})))
```

Persist it on the `messages` row under a new optional schema field:

```ts
// convex/schema.ts (additive — keep existing fields)
messages: defineTable({
  // ...existing fields...
  transcriptionSegments: v.optional(v.array(v.object({
    start: v.number(),
    end:   v.number(),
    text:  v.string(),
  }))),
})
```

That's it — no new index, no new query. The mobile client reads `msg.transcriptionSegments` directly from the existing message subscription.

## How segments are produced

The Smilers FastAPI backend (`/api/transcribe`) already requests `response_format: "verbose_json"` from OpenAI Whisper, which returns segments natively. The mobile pipeline now forwards them through `setTranscription`. Each segment is ~3-10s of speech with exact start/end timestamps.

## Fallback behavior

- If `transcriptionSegments` arg is omitted (older mobile clients) → no change.
- If the mutation rejects the new arg → mobile catches the error and falls back to the existing local-cache path, so segments still drive the fullscreen viewer on this device.
- If a video has no segments (only full-text transcription) → the inline bubble still shows the full text via the existing `TranscriptionPill`. The fullscreen viewer simply hides the caption overlay.

## Mobile usage map (already wired)

| What | Where |
|---|---|
| Sends segments to backend | `/app/frontend/src/lib/triggerTranscription.ts` |
| Caches segments locally | Same file (`setCachedTranscription`) |
| Reads + renders synced captions | `/app/frontend/src/components/MediaBubble.tsx` → `VideoViewer` component |

## Acceptance check

1. Send a video with audible speech from web → mobile.
2. Open the message bubble on mobile → tap the fullscreen expand icon.
3. As playback progresses, captions should appear/disappear in sync with the audio (one segment at a time, like the web app's screenshot showing "If you're happy and you know it, clap your hands.").
4. Scrubbing the native fullscreen control to a different position → the caption should jump to the matching segment immediately.
