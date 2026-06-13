# Voice Tasks — canonical Convex backend contract

## Why
The native mobile app currently does **client-side** voice command parsing
(`/app/frontend/src/lib/voiceCommandParser.ts`) AND **client-side** action
routing. The result is divergence from the web app — e.g. the user said
"call one" and the native parser rejected it (although the web app
handled the same phrase correctly). We want to delete the entire local
parser + local router and route every voice command through the SAME
Convex backend pipeline the web app uses, so behavior is 100 % identical
cross-platform.

Please confirm the **exact** canonical names, args and return shapes
the web app uses for the voice-task pipeline.

---

## 1. Transcript interpretation
The web app captures a raw transcript (`"call one"`, `"video call to three"`,
`"voice note to 5"`, etc.). Does it send this transcript to a Convex
action / query for interpretation, or does it interpret locally and only
*execute* via Convex?

### If interpretation IS server-side, please give us:
- **Canonical name** (e.g. `api.voiceCommands.interpret` / `api.voiceTaskContacts.parseCommand`):
  `__________________________________________________`

- **Args shape** (TypeScript):
  ```ts
  {
    transcript: string;
    // anything else? lang? userId? deviceId?
  }
  ```

- **Return shape on success**:
  ```ts
  {
    action: 'call' | 'video' | 'voiceNote' | 'videoMessage' | 'location' | ...;
    position: number;          // 1..10
    contactId: Id<"users">;    // resolved contact
    name: string;
    // anything else used by web UI? (avatar, phone, etc.)
  }
  ```

- **Return shape on no-match**: does it return `null`? or
  `{ error: 'no_match', hint: '...' }`? or throw?

### If interpretation is CLIENT-SIDE on web too:
- Please share the exact regex/keyword list the web app uses so the
  native parser can be a 1:1 port.

---

## 2. Action execution
Once a command is recognized, who actually places the call / starts the
voice-note recording / etc.?

(a) **Web client routes locally** (just navigates to /call/:id?type=voice
    after the interpretation step returns the resolved contactId).
    ☐ Yes ☐ No

(b) **Convex backend triggers the action** (e.g. fires a `calls.startCall`
    mutation server-side as part of the interpret call).
    ☐ Yes ☐ No

If (b), please give the canonical names + arg shapes for each action:
- Voice call:        `api.calls.________________({ ... })`
- Video call:        `api.calls.________________({ ... })`
- Voice note intent: `api._______._____________({ ... })`
- Video message:     `api._______._____________({ ... })`
- Share location:    `api._______._____________({ ... })`

---

## 3. Contacts source
The current native app reads the position → contact map from
`api.voiceTaskContacts.getMyVoiceTaskContacts`. Is that still the
canonical table the web app reads from? If not, what is?

- Canonical query: `api._______._____________`
- Returned row shape:
  ```ts
  {
    _id: Id<"voiceTaskContacts">;
    position: number;
    contactId: Id<"users">;
    name: string;
    avatar?: string;
    phone?: string;
  }
  ```
- Same on web? ☐ Yes ☐ No (if no, please share the canonical shape)

---

## 4. "Smiley" wake-word
The native parser also handles a `"smiley"` trigger to end a hands-free
voice-note recording. Does the web app have this too? If so, is the
detection client-side or server-side? Same regex / keyword set?

`_________________________________________________________________`

---

## 5. Anything else
If the web app does extra work the native app should mirror — analytics
events, dictation language autodetect, per-user feature flags —
please flag it here so I wire it once.

`_________________________________________________________________`
