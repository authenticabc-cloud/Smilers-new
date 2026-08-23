# Restoring "Share to Smilers" (expo-share-intent)

Temporarily removed (per Emergent Support) to unblock the iOS EAS build
(share-extension provisioning-profile mismatch). Re-add both pieces once
Support confirms the iOS signing fix has shipped, then rebuild.

## 1. app.json — add back inside `expo.plugins` (it sat after `"react-native-ble-plx"`):

```json
[
  "expo-share-intent",
  {
    "iosActivationRules": {
      "NSExtensionActivationSupportsText": true,
      "NSExtensionActivationSupportsWebURLWithMaxCount": 1,
      "NSExtensionActivationSupportsWebPageWithMaxCount": 1,
      "NSExtensionActivationSupportsImageWithMaxCount": 10,
      "NSExtensionActivationSupportsMovieWithMaxCount": 5,
      "NSExtensionActivationSupportsFileWithMaxCount": 10
    },
    "androidIntentFilters": [
      "text/*",
      "image/*",
      "video/*",
      "application/*",
      "audio/*"
    ],
    "androidMultiIntentFilters": [
      "image/*",
      "video/*",
      "application/*"
    ],
    "disableExperimental": true
  }
]
```

## 2. package.json — re-add `node ./scripts/patch-expo-share-intent.js` to BOTH
`postinstall` and `prepare` scripts (it ran right after `patch-rn-webrtc.js`).
