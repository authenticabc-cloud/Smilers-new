# In-Conversation Search — Native wiring (iter-220) & confirmation needed

The native app now mirrors the web app's search:
**Search screen** has **Chats / Messages / People** tabs. Tapping a result opens the
conversation at `/chat/<conversationId>?q=<term>&mid=<messageId>`, and the chat screen
**highlights every match** and shows a **"<n> of <total>"** bar with **▲ ▼ ✕** that jumps
between matches (wrap-around, scroll-to-centre). Match = non-deleted text message whose
text contains the term (case-insensitive), ordered oldest→newest.

## What the native app calls (please confirm against the web canonical)

1. **`api.search.searchMessages`** — called as:
   ```
   useQuery(api.search.searchMessages, { query: <term> })   // only when term length >= 2
   ```
   - ❓ Confirm the ARG name is `query` (not `q` / `searchTerm`). Convex rejects unknown args,
     so a mismatch makes the Messages tab silently empty.
   - ❓ Confirm each returned result includes these fields (native reads them, with fallbacks):
     - conversation id → `conversationId` (fallbacks tried: `conversation._id`)
     - message id (used as `mid`) → `_id` (fallback: `messageId`)
     - snippet/text → `text` (fallbacks: `snippet`, `body`, `lastMessageText`)
     - display name → `conversationName` (fallbacks: `conversation.name`, `name`,
       `otherUserName`, `senderName`)

2. **Conversation taps** (Chats tab) navigate with `?q=<term>` so highlighting works even
   without a specific message id.

3. The chat screen computes matches from the already-loaded `api.messages.list` (decrypted
   text), so highlighting/▲▼ work regardless of `searchMessages` — only the Messages TAB
   depends on `searchMessages`.

## One product question for the user
The web screenshots show **2 tabs (Chats, Messages)**. The native app currently keeps a
**3rd "People" tab** (existing user search) so we don't lose that feature. If you want strict
2-tab parity, say so and I'll hide "People".
