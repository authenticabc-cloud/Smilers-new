/**
 * StreamCallInnerEntry (NATIVE) — re-exports the Stream 1:1 call screen.
 * The .web.tsx sibling is a no-op so the Stream Video SDK never enters the web
 * bundle (component-level platform split).
 */
export { default } from './StreamCallInner';
