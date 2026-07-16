# 🔧 Backend Fix — Chief Admin cannot generate/disable Invite Link

**Severity:** P0 (blocks a core group feature for the group creator)
**Where:** External Convex backend (shared with the Smilers web app) — file `convex/groupAdmin.ts`
**Reported on:** Native mobile app, `Group Info → Invite Link → Generate Invite Link`

---

## Symptom

The **Chief Admin** (group creator) taps **Generate Invite Link** and receives the
error:

> "Only admins are allowed to generate and share invite links."

…even though the same user is correctly shown as the Chief Admin in the UI
(`Admins: 1/1`, the ADMIN ACTIONS section is visible, etc.).

## Root Cause

There is an **inconsistency between two functions** in `groupAdmin.ts`:

- `getGroupAdminInfo` computes `isAdmin` as **"is the caller in `admins[]` OR is the
  caller the `chiefAdmin`/creator"** → returns `isAdmin: true` for the chief. ✅
- `generateInviteLink` (and almost certainly `disableInviteLink`) guard **only**
  checks membership of the `admins[]` array and does **NOT** include the
  chief admin / creator. ❌

The Chief Admin is stored **separately** from the `admins[]` array (a group has
`chiefAdmin`/`createdBy` + a distinct `admins` list). So the chief passes the
info check but fails the invite-link guard.

## The Fix

Make the invite-link mutations use the **same** "is authorized admin" test that
`getGroupAdminInfo.isAdmin` uses — i.e. treat the **chief admin / creator as an
admin**.

### 1. Add / reuse a shared helper (recommended)

```ts
// convex/groupAdmin.ts (or a shared groupAuth.ts)
function isAuthorizedAdmin(group, userId: Id<"users">): boolean {
  if (!group) return false;
  const admins = (group.admins ?? []).map(String);
  return (
    admins.includes(String(userId)) ||
    String(group.chiefAdmin) === String(userId) ||   // chief admin
    String(group.createdBy) === String(userId)        // creator (defensive)
  );
}
```

### 2. Use it in `generateInviteLink`

```ts
export const generateInviteLink = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const userId = await getAuthUserId(ctx);           // your existing auth helper
    if (!userId) throw new ConvexError("Not authenticated");

    const group = await ctx.db.get(conversationId);
    if (!group) throw new ConvexError("Group not found");

    // ⬇️ FIX: chief admin / creator must count as an admin here
    if (!isAuthorizedAdmin(group, userId)) {
      throw new ConvexError("Only admins are allowed to generate and share invite links.");
    }

    const inviteCode = group.inviteCode ?? generate12CharCode();
    await ctx.db.patch(conversationId, {
      inviteCode,
      inviteLinkEnabled: true,
    });
    return inviteCode; // 12-char code (per GROUPS_CANONICAL_CONTRACT_iter151.md §2)
  },
});
```

### 3. Apply the identical guard fix to `disableInviteLink`

```ts
if (!isAuthorizedAdmin(group, userId)) {
  throw new ConvexError("Only admins are allowed to manage invite links.");
}
```

### 4. Audit the other `groupAdmin.*` mutations for the same bug

The chief-admin-not-in-`admins[]` mismatch likely affects other guards too.
Verify each mutation below uses `isAuthorizedAdmin` (chief counts as admin),
**except** where the contract explicitly says *chief-only*:

| Function | Required guard |
|---|---|
| `generateInviteLink` | admin **incl. chief** |
| `disableInviteLink` | admin **incl. chief** |
| `promoteToAdmin` | admin **incl. chief** |
| `demoteFromAdmin` | **chief only** (leave as-is) |
| `transferChiefAdmin` | **chief only** (leave as-is) |
| `messageApproval.toggleApproval` | admin **incl. chief** |

## Verification

1. As the **Chief Admin** of a group where you are NOT separately listed in
   `admins[]`, call `generateInviteLink` → should return a 12-char code and set
   `inviteLinkEnabled: true` (no error).
2. `getGroupAdminInfo` should then return `inviteLinkEnabled: true` and
   `inviteCode: "<12chars>"`.
3. A plain **member** (not admin, not chief) calling `generateInviteLink` should
   still get the "Only admins…" error.
4. Repeat for `disableInviteLink`.

## Contract reference

See `GROUPS_CANONICAL_CONTRACT_iter151.md` §2 (`api.groupAdmin.*`):
- `generateInviteLink({ conversationId }) → string (12-char code); sets inviteLinkEnabled: true`
- `getGroupAdminInfo(...).isAdmin` already treats the chief admin as an admin —
  the mutation guards must match that behavior.

---

*No mobile-side change is possible for this bug — the permission check is
enforced server-side in Convex. Once the web/Convex team deploys the guard fix
above, the existing mobile UI works unchanged (it already treats the chief admin
as an admin and calls `groupAdmin.generateInviteLink`).*
