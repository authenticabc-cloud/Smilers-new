# eas.json Notes

> Why this file exists: `eas.json` is validated against a strict JSON schema by
> EAS CLI's `project:init` command — it rejects any field not in its known
> schema (including `//note`-style inline comments). So all documentation
> about why specific keys exist (or DON'T exist) lives here instead.

## FCM v1 Push Notifications — NOT configured via `eas.json`

A common mistake (which this repo previously made) is to wire the Firebase
Admin SDK service-account JSON into `eas.json` at
`submit.production.android.serviceAccountKeyPath`. **DO NOT do this.** That
key is for Google Play Console uploads ONLY — it expects a Play Console
service account, not a Firebase Admin SDK service account. Using a Firebase
key there will fail `eas submit` with a 401 from the Google Play API.

The **correct** way to wire FCM v1 push credentials is via Expo's project
credentials, NOT via `eas.json`:

### Upload procedure (CLI)

```sh
cd /app/frontend
eas credentials --platform android
# Choose: > Push Notifications: Manage your FCM Api Key
# Choose: > Firebase Cloud Messaging (V1)
# Choose: > Upload a new service account JSON
# Path: ./google-service-account.json
```

### Upload procedure (Dashboard)

> https://expo.dev/accounts/abcsimplesend/projects/smilers/credentials
>   → Android → Push Notifications → FCM V1 → "Upload Service Account Key"

### Verify

The Expo project credentials page should show under
**Service credentials → FCM V1 service account key**:
- Project ID: `smilers-a4e07`
- Client: `firebase-adminsdk-fbsvc@smilers-a4e07.iam.gserviceaccount.com`

After uploading once, **all future EAS Android builds** will automatically
embed the necessary credentials. No `eas.json` change required.

## Google Play Console submit credentials — currently UNCONFIGURED

`eas submit --platform android` requires a Google Play Console service
account (NOT a Firebase Admin SDK one). It's not configured yet.

When you're ready to enable automated Play Store submissions:

```sh
# 1. Create a Play Console service account
#    Google Play Console → Setup → API access → Create new service account
#    Grant role: "Release manager" (or finer-grained "Manage testing track")
# 2. Download the JSON key
# 3. Drop it at: /app/frontend/google-play-service-account.json
# 4. Add to eas.json:
#    "submit": {
#      "production": {
#        "android": {
#          "serviceAccountKeyPath": "./google-play-service-account.json"
#        }
#      }
#    }
```

## google-services.json — DEVICE-side FCM client config

`/app/frontend/google-services.json` is the FCM **client** config (not the
server key). It's read by the Android build at compile time and embedded in
the APK. It tells `expo-notifications` / FCM SDK how to acquire a device push
token from Firebase. Referenced by `app.json` →
`expo.android.googleServicesFile`.

This file is required AND distinct from the Firebase Admin SDK service
account (`google-service-account.json`). Do not delete or rename either.

## Build profiles

| Profile      | Purpose                                            |
| ------------ | -------------------------------------------------- |
| development  | Dev-client APK for `npx expo start --dev-client`   |
| preview      | Internal-distribution APK for QA                   |
| production   | Public release APK + auto-incrementing versionCode |
| app-bundle   | AAB for Google Play Store (auto-increment)         |

## Common pitfalls

1. **DO NOT** add `//` style comments as JSON keys — EAS schema rejects them.
2. **DO NOT** put the Firebase Admin SDK key at
   `submit.production.android.serviceAccountKeyPath` — that breaks `eas submit`.
3. **DO NOT** delete `/app/frontend/google-services.json` — that breaks
   FCM device token acquisition.
4. **DO NOT** commit a leaked / public-URL'd key — rotate via Firebase
   Console first.

## Rotating the FCM v1 key

1. Firebase Console → `smilers-a4e07` → Project Settings → Service Accounts
2. Delete the existing key (look for matching `private_key_id`)
3. "Generate new private key" → downloads a fresh JSON
4. Replace `/app/frontend/google-service-account.json` with the new file
5. Re-upload via `eas credentials --platform android` (Expo does not
   auto-pick-up file changes — manual re-upload is required)
6. Trigger a new EAS Android build so devices get fresh tokens
