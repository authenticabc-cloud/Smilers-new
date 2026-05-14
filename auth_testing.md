# Smilers Auth Testing Notes

## Source of truth
- See `/app/memory/test_credentials.md` for the current Hercules/OIDC setup.

## Manual sign-in expectations
- The app opens Hercules Auth using the configured OIDC authority.
- On web preview, the sign-in may open an external provider page.
- On native, the redirect URI is `smilers://auth-callback`.

## Test checkpoints
1. Root screen shows `sign-in-screen`.
2. Tapping `sign-in-btn` launches Hercules Auth.
3. After successful auth, the app returns through the callback route.
4. If the user has no verified phone, route to `phone-verify-screen`.
5. If phone is already verified, route to `/(tabs)/chats`.

## Current limitation
- Automated Google-based sign-in is non-deterministic in browser automation because it depends on third-party interactive OAuth.