/**
 * StreamTestCallEntry (NATIVE) — re-exports the real Stream test screen.
 * A .web.tsx sibling provides a no-SDK notice so the Stream Video SDK never
 * enters the web bundle (component-level platform split, like RingingOverlay).
 */
export { default } from './StreamTestCall';
