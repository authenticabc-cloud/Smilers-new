/**
 * callControl — tiny bridge so Drive Mode can put the CURRENT active 1:1 call
 * "on hold" (mute the local mic) before answering a second incoming call.
 * The active twilio-call screen registers a hold handler while mounted.
 */
type HoldFn = () => void;

let holdFn: HoldFn | null = null;

export function registerActiveCall(hold: HoldFn): void {
  holdFn = hold;
}

export function clearActiveCall(hold?: HoldFn): void {
  if (!hold || holdFn === hold) holdFn = null;
}

export function hasActiveCall(): boolean {
  return holdFn != null;
}

/** Put the current call on hold (mute local audio). Returns true if a call was held. */
export function holdActiveCall(): boolean {
  if (!holdFn) return false;
  try {
    holdFn();
    return true;
  } catch {
    return false;
  }
}
