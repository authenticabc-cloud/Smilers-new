/**
 * streamCallActions — start / join / leave 1:1 Stream Video calls.
 *
 * STAGED (Phase 1b): imported only by native call entry points. The SDK is
 * lazy-imported so nothing bundles on web. Uses the singleton client from
 * streamClient (getOrCreateInstance), so the same instance backs the push
 * handler and the React tree.
 */
import { createStreamVideoClient } from './streamClient';

/** Random, per-attempt call id so every call attempt is distinct (no dedupe collisions). */
function newCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Start an outgoing 1:1 ring to `calleeUserId`. `ring:true` makes Stream deliver
 * a native ringing push (ConnectionService/CallKit) to the callee even when
 * their app is killed. Returns the call id (so the UI can track it) or null.
 */
export async function startStreamCall(
  calleeUserId: string,
  opts?: { video?: boolean; callerName?: string },
): Promise<string | null> {
  const client = await createStreamVideoClient();
  if (!client) return null;
  const callId = newCallId();
  const call = client.call('default', callId);
  await call.getOrCreate({
    ring: true,
    data: {
      members: [{ user_id: client.streamClient?._user?.id ?? '' }, { user_id: calleeUserId }].filter(
        (m) => m.user_id,
      ),
      custom: { video: !!opts?.video, callerName: opts?.callerName || '' },
    },
  });
  // Publish/subscribe according to modality. For voice we still join with camera
  // off; the callee's accept will negotiate media.
  try {
    await call.microphone.enable();
    if (opts?.video) await call.camera.enable();
    else await call.camera.disable();
  } catch {}
  return callId;
}

/** Accept an incoming ringing call. */
export async function acceptStreamCall(call: any): Promise<void> {
  try {
    await call.join();
  } catch {}
}

/** Reject an incoming ringing call (or cancel an outgoing one). */
export async function rejectStreamCall(call: any, reason: 'decline' | 'cancel' = 'decline'): Promise<void> {
  try {
    await call.leave({ reject: true, reason });
  } catch {}
}

/** Hang up / leave an active call. */
export async function endStreamCall(call: any): Promise<void> {
  try {
    await call.leave();
  } catch {}
}
