/**
 * patch-incallmanager.js
 *
 * Adds a session-independent `playInCallSound(bundleName)` method to
 * react-native-incall-manager (Android + iOS) so Smilers can play a one-shot
 * bundled sound on the in-call / voice-communication stream WITHOUT starting or
 * tearing down InCallManager's own audio session (Stream owns the WebRTC audio
 * session during a call). Used for the call-connect "Connected" tone and the
 * call-end "Ciaooo" tone. Purely ADDITIVE — does not modify any existing method
 * so current call audio behavior is untouched. Idempotent.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MARKER = 'playInCallSound'; // presence => already patched

function log(msg) {
  // eslint-disable-next-line no-console
  console.log('[patch-incallmanager] ' + msg);
}

// ── Android ────────────────────────────────────────────────────────────────
function patchAndroid() {
  const p = path.join(
    ROOT,
    'node_modules/react-native-incall-manager/android/src/main/java/com/zxcpoiu/incallmanager/InCallManagerModule.java',
  );
  if (!fs.existsSync(p)) {
    log('android source not found — skipping');
    return;
  }
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes(MARKER)) {
    log('android already patched — no-op');
    return;
  }

  // 1. field, right after the existing mBusytone field
  const fieldAnchor = 'private MyPlayerInterface mBusytone;';
  if (!src.includes(fieldAnchor)) {
    log('android field anchor missing — aborting android patch');
    return;
  }
  src = src.replace(
    fieldAnchor,
    fieldAnchor + '\n    private MyPlayerInterface mSmilersTone; // Smilers custom in-call tone',
  );

  // 2. the method, injected before chooseAudioRoute (a stable @ReactMethod)
  const methodAnchor = '    @ReactMethod\n    public void chooseAudioRoute(String audioRoute, Promise promise) {';
  if (!src.includes(methodAnchor)) {
    log('android method anchor missing — aborting android patch');
    return;
  }
  const method = `    // ===== Smilers custom in-call one-shot tone (patch-incallmanager.js) =====
    @ReactMethod
    public void playInCallSound(final String bundleName) {
        try {
            if (bundleName == null || bundleName.isEmpty()) {
                return;
            }
            Log.d(TAG, "playInCallSound(): " + bundleName);
            if (mSmilersTone != null) {
                try { mSmilersTone.stopPlay(); } catch (Exception ignored) {}
                mSmilersTone = null;
            }
            ReactContext reactContext = getReactApplicationContext();
            if (reactContext == null) {
                return;
            }
            int res = reactContext.getResources().getIdentifier(bundleName, "raw", mPackageName);
            if (res <= 0) {
                Log.d(TAG, "playInCallSound(): resource not found: " + bundleName);
                return;
            }
            Uri uri = Uri.parse("android.resource://" + mPackageName + "/" + Integer.toString(res));
            final myMediaPlayer player = new myMediaPlayer();
            player.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer mp) {
                    try { mp.setVolume(1.0f, 1.0f); } catch (Exception ignored) {}
                    try { mp.start(); } catch (Exception ignored) {}
                }
            });
            player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer mp) {
                    try { mp.release(); } catch (Exception ignored) {}
                    mSmilersTone = null;
                }
            });
            player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(MediaPlayer mp, int what, int extra) {
                    return true;
                }
            });
            java.util.Map data = new java.util.HashMap<String, Object>();
            data.put("name", "mSmilersTone");
            data.put("sourceUri", uri);
            data.put("setLooping", false);
            data.put("audioUsage", AudioAttributes.USAGE_VOICE_COMMUNICATION);
            data.put("audioContentType", AudioAttributes.CONTENT_TYPE_SONIFICATION);
            mSmilersTone = player;
            player.startPlay(data);
        } catch (Exception e) {
            Log.d(TAG, "playInCallSound() failed", e);
        }
    }

`;
  src = src.replace(methodAnchor, method + methodAnchor);

  fs.writeFileSync(p, src, 'utf8');
  log('android patched ✓ (playInCallSound added)');
}

// ── iOS ──────────────────────────────────────────────────────────────────
function patchIos() {
  const p = path.join(
    ROOT,
    'node_modules/react-native-incall-manager/ios/RNInCallManager/RNInCallManager.m',
  );
  if (!fs.existsSync(p)) {
    log('ios source not found — skipping');
    return;
  }
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes(MARKER)) {
    log('ios already patched — no-op');
    return;
  }

  // 1. instance var, after the existing _busytone declaration
  const ivarAnchor = 'AVAudioPlayer *_busytone;';
  if (src.includes(ivarAnchor)) {
    src = src.replace(ivarAnchor, ivarAnchor + '\n    AVAudioPlayer *_smilersTone; // Smilers custom in-call tone');
  } else {
    log('ios ivar anchor missing — aborting ios patch');
    return;
  }

  // 2. init to nil, after the existing _busytone = nil;
  const initAnchor = '_busytone = nil;';
  if (src.includes(initAnchor)) {
    src = src.replace(initAnchor, initAnchor + '\n        _smilersTone = nil;');
  }

  // 3. the exported method, before startBusytone (inside @implementation)
  const methodAnchor = '- (BOOL)startBusytone:(NSString *)_busytoneUriType';
  if (!src.includes(methodAnchor)) {
    log('ios method anchor missing — aborting ios patch');
    return;
  }
  const method = `// ===== Smilers custom in-call one-shot tone (patch-incallmanager.js) =====
RCT_EXPORT_METHOD(playInCallSound:(NSString *)bundleName)
{
    NSLog(@"RNInCallManager.playInCallSound(): %@", bundleName);
    @try {
        if (bundleName == nil || bundleName.length == 0) {
            return;
        }
        if (_smilersTone != nil) {
            [_smilersTone stop];
            _smilersTone = nil;
        }
        NSURL *uri = [[NSBundle mainBundle] URLForResource:bundleName withExtension:@"mp3"];
        if (uri == nil) {
            NSLog(@"RNInCallManager.playInCallSound(): resource not found: %@", bundleName);
            return;
        }
        _smilersTone = [[AVAudioPlayer alloc] initWithContentsOfURL:uri error:nil];
        _smilersTone.numberOfLoops = 0;
        _smilersTone.volume = 1.0;
        [_smilersTone prepareToPlay];
        [_smilersTone play];
    } @catch (NSException *e) {
        NSLog(@"RNInCallManager.playInCallSound(): caught error = %@", e.reason);
    }
}

`;
  src = src.replace(methodAnchor, method + methodAnchor);

  fs.writeFileSync(p, src, 'utf8');
  log('ios patched ✓ (playInCallSound added)');
}

try {
  patchAndroid();
  patchIos();
} catch (e) {
  log('failed: ' + (e && e.message));
}
