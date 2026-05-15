# Hercules Agent Instructions — Smilers Mobile Sign-In Bridge

## Goal

Make the existing web sign-in at `https://smilers.online/` return control to the Expo native app after successful Hercules authentication.

The native app now opens the live web app with these query params:

- `mobile_app=1`
- `mobile_platform=ios|android|web`
- `mobile_callback=<callback url>`

Example callback values:

- Native app: `smilers://auth-callback`
- Web preview fallback: `https://<preview-domain>/auth-callback`

## What the web/Hercules side must do

After the user successfully signs in on the web app:

1. Detect whether `mobile_app=1` and `mobile_callback` are present.
2. If they are present, redirect the browser to `mobile_callback`.
3. Include either:

### Preferred option: return tokens directly

Redirect to:

```text
{mobile_callback}?id_token=...&access_token=...&refresh_token=...&expires_in=3600
```

Supported params on mobile side:

- `id_token` or `idToken`
- `access_token`
- `refresh_token`
- `expires_in`
- `error`
- `error_description`

### Alternate option: return OIDC code

Redirect to:

```text
{mobile_callback}?code=...&state=...
```

The mobile app already supports both token-style and code-style callback handling.

## Important note

If you return `code`, make sure the Hercules/OIDC mobile callback is allowed for:

```text
smilers://auth-callback
```

If you return tokens directly, the mobile app can complete sign-in without re-running the code exchange in the app.

## Recommended behavior

When `mobile_app=1`:

- do not keep the user on the normal web post-login page
- instead redirect immediately to the provided `mobile_callback`
- preserve existing web login for normal browser users when `mobile_app` is absent

## Native app behavior already implemented

The mobile app now:

- opens the live Smilers web sign-in flow inside a native WebView
- watches for `smilers://auth-callback` or `/auth/mobile-callback`
- accepts direct tokens from the web bridge
- also accepts an OIDC `code` + `state` callback
- stores the resulting tokens securely and routes to chats