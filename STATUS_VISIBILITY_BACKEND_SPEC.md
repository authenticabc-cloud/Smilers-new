# Backend Spec — Status visibility & privacy sync (Convex)

**Owner:** Convex / web backend team
**Reported:** iter-235 (native app)
**Symptom:** A status posted from the native app renders for the author and
on the web app, but the author's **contacts cannot see it**, even though the
native **Status** privacy is set to **"My contacts"**.

The native app is functioning correctly (details below). The fixes required
are all server-side in Convex.

---

## What the native app does (verified, do NOT change)

1. **Privacy screen** (`app/privacy.tsx`)
   - Reads:  `api.privacy.getSettings()` → `{ lastSeen, profilePhoto, about, status, groups, calls, readReceipts, typingIndicators }`
   - Writes: `api.privacy.updateSettings({ settings: {...} })`
   - `status` is one of `'everyone' | 'contacts' | 'nobody'`. The user has it set to `'contacts'`.

2. **Status create** (`app/status-compose.tsx`, `app/(tabs)/updates.tsx`)
   - `api.statuses.create({ type, content, backgroundColor, textColor })`
   - **No per-post audience/visibility argument is sent.** Visibility is expected
     to be derived server-side from the author's `privacy.status`.

3. **Contacts' feed** (`app/(tabs)/updates.tsx`)
   - `api.statuses.listStatusGroups()` ← this is the query a viewer's app calls
     to see other people's statuses. **This is where the filtering happens.**

---

## Evidence this is a backend data-model mismatch

- **Web and native show different privacy values for the same account.**
  e.g. Web shows `Last seen = My Contacts`; native (`api.privacy.getSettings`)
  shows `Last seen = Everyone`. → The web app and `api.privacy.*` are backed by
  **different stores/shapes** (e.g. web reads `users.privacy.*` embedded on the
  user doc, while `api.privacy.updateSettings` writes to a separate `privacy`
  table — or vice-versa). They are not the same source of truth.

- Because of that, `api.statuses.listStatusGroups` very likely reads a
  **different** privacy field than the one `api.privacy.updateSettings` writes,
  so `status = 'contacts'` set from native is never seen by the visibility check.

---

## Required backend fixes

### 1. Unify the privacy source of truth
`api.privacy.getSettings` / `api.privacy.updateSettings` and the web app's
privacy screen MUST read & write the **same** record/field for every key
(`lastSeen, profilePhoto, about, status, groups, calls, readReceipts,
typingIndicators`). After this, web and native must always display identical
values for the same account.

### 2. `statuses.listStatusGroups` must honor `privacy.status`
For each candidate author A and viewer V, include A's active statuses when:
- `A.privacy.status === 'everyone'`, OR
- `A.privacy.status === 'contacts'` **and V is in A's contacts** (see #3), 
- exclude entirely when `A.privacy.status === 'nobody'`.
Read `privacy.status` from the unified store from #1.

### 3. Contact matching must work for the actual contact graph
"My contacts" should resolve to the same contact set used elsewhere
(`api.contacts.getContacts`). Confirm whether the rule is:
- **bidirectional** (both saved each other), or
- **one-directional** (V is in A's contacts).
Please make status visibility use the SAME definition the product intends
(recommended: V can see A's "contacts" status if A has V in contacts, i.e.
A is broadcasting to people A knows). Document the chosen rule.

### 4. (Optional but recommended) snapshot audience on create
Consider having `statuses.create` snapshot the author's effective audience
(`'everyone' | 'contacts' | 'nobody'`) onto the status doc at creation time,
so later privacy changes don't retroactively reveal/hide old statuses. If you
adopt this, tell the native team the new optional arg name and we'll pass it.

---

## How to verify the fix
1. Account A: set Status privacy = **My contacts** (from native AND confirm web shows the same).
2. A posts a status.
3. Account B (in A's contacts) opens Updates → **B sees A's status**.
4. Account C (NOT in A's contacts) opens Updates → **C does NOT see it**.
5. Set A's Status = Everyone → C now sees it. Set = Nobody → B no longer sees it.
