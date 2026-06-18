# Profile-photo save policy — Convex backend spec (iter-226)

The mobile app added a "Profile Photo Privacy" control (Everyone / My contacts /
Nobody) and enforces it in the profile-photo viewer (hides the in-app Save
button accordingly). For this to work cross-device (and on web), the backend
must persist + return the policy. The mobile app only consumes Convex.

## Required
1. **Schema:** add `photoSavePolicy: v.optional(v.union(v.literal("everyone"),
   v.literal("contacts"), v.literal("nobody")))` to the `users` table.
   Default/absent = treated as `"everyone"` by clients.
2. **Write:** `users.updateProfile` must ACCEPT and persist `photoSavePolicy`.
   (The mobile setting calls `updateProfile({ photoSavePolicy })`.)
3. **Read:** every query that returns another user's profile (the one powering
   the mobile `user/[userId]` screen, plus web profile views) must include
   `photoSavePolicy` on the returned object. Also include it on
   `users.getCurrentUser` so the settings screen shows the current choice.
4. (Optional but ideal) The same profile query should expose whether the viewer
   is a contact of the viewed user, so `"contacts"` can be enforced precisely.
   The mobile app currently derives `isContact` locally; a server flag is more
   reliable.

## Client behaviour (already shipped, dormant until backend returns the field)
- Viewer: `canSave = policy === 'everyone' || (policy === 'contacts' && isContact)`.
  `nobody` hides the Save button entirely.
- Until the field is returned, clients default to `everyone` (save allowed),
  i.e. no regression.

## Note
Enforcement is best-effort (screenshots are always possible); this only governs
the in-app Save action.
