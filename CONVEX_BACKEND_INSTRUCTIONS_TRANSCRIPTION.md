# Convex Backend Contract — Message Transcription + Delivery Status

The mobile app (and likely the web app) needs the following message-level
mutations and fields shipped on the Convex side to make transcription +
the green/yellow/blue delivery dots fully functional.

---

## New mutation: `messages.setTranscription`

Called by the mobile client immediately after sending a voice/video message
once OpenAI Whisper returns. Also called optimistically with
`transcriptionStatus: 'pending'` while Whisper is running, and with
`'error'` if it fails.

```ts
export const setTranscription = mutation({
  args: {
    messageId: v.id("messages"),
    transcription: v.optional(v.string()),
    transcriptionLanguage: v.optional(v.string()),       // ISO 639-1 ('en', 'fr', ...)
    transcriptionStatus: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("error"),
    ),
    transcriptionError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Permission: only the sender of the message (or an admin) can patch.
    const me = await getCurrentUserOrThrow(ctx);
    const msg = await ctx.db.get(args.messageId);
    if (!msg) throw new ConvexError("Message not found");
    if (msg.senderId !== me._id) throw new ConvexError("Only the sender can attach a transcription");
    await ctx.db.patch(args.messageId, {
      transcription: args.transcription ?? msg.transcription,
      transcriptionLanguage: args.transcriptionLanguage ?? msg.transcriptionLanguage,
      transcriptionStatus: args.transcriptionStatus,
      transcriptionError: args.transcriptionError ?? null,
    });
  },
});
```

### Schema additions to the `messages` table

```ts
messages: defineTable({
  // ...existing fields...
  transcription: v.optional(v.string()),
  transcriptionLanguage: v.optional(v.string()),
  transcriptionStatus: v.optional(v.union(
    v.literal("pending"),
    v.literal("ready"),
    v.literal("error"),
  )),
  transcriptionError: v.optional(v.string()),
});
```

The mobile UI gates the transcription pill on `msg.transcription` (or the
status fields). No transcription field = no pill rendered.

---

## Delivery status — already wired client-side

The mobile renders the colored dot per spec from the existing
`readBy[]` and `deliveredTo[]` arrays on each message — no new mutation
needed for that. The backend must keep them up to date:

* `markDelivered` — fires when the recipient's device opens the chat;
  pushes their `userId` into `deliveredTo`.
* `markRead` — fires after a 1.5s delay while the chat is foregrounded;
  pushes their `userId` into `readBy`.
* Priority: a userId present in `readBy` wins over `deliveredTo`.
* The sender's own userId is automatically excluded by the mobile client
  before computing the dot color (so the sender never sees their own
  message marked "read" just because they sent it).

### Mobile color spec (already implemented)

| State | Color | Hex |
|-------|-------|-----|
| Sent (server received, not delivered yet) | Green | `#22c55e` |
| Delivered (reached recipient's device) | Yellow / Gold | `#eab308` |
| Read (recipient opened the chat) | Blue | `#3b82f6` |

Rendered as a 10px circle next to the timestamp on outgoing messages only.

---

## Backend transcription endpoint (already shipped on mobile FastAPI)

```
POST /api/transcribe
Content-Type: application/json
{
  "media_url": "https://...m4a",
  "language_hint": "en" | null
}

=>
{
  "text": "Hello good afternoon, how are you doing?",
  "language": "english",
  "duration_sec": 4.3
}
```

* Uses `OPENAI_API_KEY` from `/app/backend/.env` (user-provided).
* Downloads the URL with httpx (24MB cap — Whisper limit),
  tempfiles it with the inferred extension, then calls
  `openai.audio.transcriptions.create(model='whisper-1', response_format='verbose_json')`.
* Returns 502 with detail on Whisper failure, 413 on size cap, 400 on
  bad URL. Mobile UI degrades to a `transcriptionStatus: 'error'` pill.
