# Sign in with Apple — Decision & Contract (read before touching auth)

## TL;DR: Do NOT build an in-app "Continue with Apple" button. It is not possible with Hercules Auth.

Smilers authenticates via **Hercules Auth (OIDC)** → Convex identity
(`AuthSession.useAuthRequest` in `src/providers/AuthProvider.tsx`, authority
`EXPO_PUBLIC_OIDC_AUTHORITY`). The single in-app "Sign in" button opens the
**Hercules-hosted portal**, where the user picks their provider.

### Confirmed by the Hercules team (do not re-investigate)
Hercules Auth **does NOT support provider pre-selection**. It ignores
`idp_hint`, `kc_idp_hint`, `connection`, and every similar authorize parameter.
There is no way to deep-link straight to Apple from the app. Passing such params
does nothing.

Therefore:
- ❌ A custom native "Continue with Apple" button that skips the portal is NOT
  achievable.
- ❌ `expo-apple-authentication` + a separate Apple/session backend is the WRONG
  approach here — it would create a second identity disconnected from Convex.

### The correct (and only) path — App-Store-compliant
1. **App owner enables Apple as a login option in the Hercules dashboard**,
   using their Apple Developer credentials (Services ID, Team ID, Key ID, and
   the `.p8` private key). This is Hercules-side config — NO mobile code change.
2. The existing "Sign in" button then redirects to the Hercules portal, where
   **Apple appears alongside Google**.
3. Apple App Store Guideline 4.8 is satisfied: the app shows a single neutral
   "Sign in" entry point (no native Google button that would require an
   equivalent native Apple button), and Apple is offered equally on the portal.

### Account deletion (also part of 4.8 compliance) — already implemented
Settings → Account → "Delete account" (`app/account.tsx`): type-DELETE confirm →
`api.users.deleteAccount` → clears local data → signs out. Convex team must
ensure `deleteAccount` truly deletes server-side.

### Status
No mobile code change required for Apple Sign-in. Action item is entirely on the
app owner (enable Apple in Hercules). Once enabled, verify: tap "Sign in" →
portal shows Apple → complete Apple flow → lands authenticated (same Convex
identity as any other provider).
