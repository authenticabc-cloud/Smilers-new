# eas.json Notes

> Why this file exists: `eas.json` is validated against a strict JSON schema by
> EAS CLI's `project:init` command — it rejects any field not in its known
> schema (including `//note`-style inline comments). So all documentation
> about why specific keys exist lives here instead.

## `submit.production.android.serviceAccountKeyPath`

Points at `./google-service-account.json` — the **FCM v1 service account
private key** generated from:

> Firebase Console → Project Settings → Service Accounts →
> "Generate new private key"

for project **smilers-a4e07**.

When the Emergent / EAS build pipeline runs `eas submit` or
`eas project:init`, this file is automatically:

1. Read from the repo at the path above
2. Uploaded to EAS as the project's **FCM V1** push credential
3. Used by Expo's push server when forwarding pushes to Firebase Cloud
   Messaging for the `com.smilers.app` package

### Rotating the key

```
1. Firebase Console → smilers-a4e07 → Project Settings → Service Accounts
2. Delete the existing key (look for the matching `private_key_id`)
3. "Generate new private key" → downloads a fresh JSON
4. Replace /app/frontend/google-service-account.json with the new file
5. Trigger a new Emergent Android build
```

No code changes are required to rotate — just swap the file and rebuild.

## Build profiles

| Profile      | Purpose                                    |
| ------------ | ------------------------------------------ |
| development  | Dev-client APK for `npx expo start --dev-client` |
| preview      | Internal-distribution APK for QA          |
| production   | Public release APK + auto-incrementing versionCode |
| app-bundle   | AAB for Google Play Store (auto-increment) |

## Common pitfalls

1. **DO NOT** add `//` style comments as JSON keys — EAS schema rejects them.
2. **DO NOT** rename `google-service-account.json` without updating
   `serviceAccountKeyPath` here.
3. **DO NOT** commit a leaked / public-URL'd key — rotate via Firebase
   Console first.
