/**
 * mediaGalleryStore — shared, conversation-level media gallery signal.
 *
 * Each media bubble used to open its OWN single-item viewer, so there was no
 * way to swipe between photos/videos in a chat. This tiny singleton lets a
 * bubble ask a mounted <MediaGalleryModal> (which knows the full ordered media
 * list) to open at a given message, enabling left/right swiping. Bubbles fall
 * back to their local viewer when no gallery host is mounted (e.g. search or
 * forwarded contexts), so nothing breaks elsewhere.
 */
let openMsgId: string | null = null;
let hostMounted = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}

export function openGalleryFor(msgId: string): void {
  if (!msgId) return;
  openMsgId = msgId;
  emit();
}

export function closeGallery(): void {
  openMsgId = null;
  emit();
}

export function getOpenMsgId(): string | null {
  return openMsgId;
}

export function setGalleryHostMounted(v: boolean): void {
  hostMounted = v;
  if (!v) openMsgId = null;
}

export function isGalleryHostMounted(): boolean {
  return hostMounted;
}

export function subscribeGallery(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
