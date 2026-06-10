/**
 * Global Inter font defaults — wraps the RN <Text> render to inject a default
 * `fontFamily` that maps the requested `fontWeight` to the matching Inter
 * Google-Font weight. This means every <Text> in the app renders in Inter,
 * matching the web app's typography, without touching individual StyleSheets.
 *
 * Why this approach over a custom <Text> wrapper:
 *   - Hundreds of files already import `Text` from `react-native`. Replacing
 *     them all is error-prone.
 *   - React Native does NOT auto-select a font file from `fontWeight` like the
 *     web does — `fontFamily` MUST be explicit per weight (Inter_700Bold, etc).
 *   - Patching `Text.render` is the community-standard pattern for this case
 *     (see e.g. expo's docs and the react-native-web font discussions).
 *
 * Safe to call multiple times — guarded by a module-level flag.
 */

import { StyleSheet, Text } from 'react-native';

const WEIGHT_TO_INTER: Record<string, string> = {
  '100': 'Inter_300Light',
  '200': 'Inter_300Light',
  '300': 'Inter_300Light',
  '400': 'Inter_400Regular',
  '500': 'Inter_500Medium',
  '600': 'Inter_600SemiBold',
  '700': 'Inter_700Bold',
  '800': 'Inter_700Bold',
  '900': 'Inter_700Bold',
  normal: 'Inter_400Regular',
  bold: 'Inter_700Bold',
};

let patched = false;

function resolveInterFamily(style: any): string {
  const flat = StyleSheet.flatten(style) || {};
  // Caller explicitly requested a custom font (e.g. monospace). Honor it.
  if (typeof flat.fontFamily === 'string' && flat.fontFamily.length > 0) {
    return flat.fontFamily;
  }
  const weight = flat.fontWeight !== undefined && flat.fontWeight !== null
    ? String(flat.fontWeight)
    : '400';
  return WEIGHT_TO_INTER[weight] || 'Inter_400Regular';
}

export function applyInterFontPatch(): void {
  if (patched) return;
  patched = true;

  const TextAny = Text as any;
  const originalRender = TextAny.render;
  if (typeof originalRender !== 'function') return;

  TextAny.render = function patchedRender(props: any, ref: any) {
    try {
      const fontFamily = resolveInterFamily(props?.style);
      // Prepend our default so caller styles in props.style still override
      // fontFamily if they need to.
      const mergedStyle = props?.style != null
        ? [{ fontFamily }, props.style]
        : [{ fontFamily }];
      return originalRender.call(this, { ...props, style: mergedStyle }, ref);
    } catch {
      // If anything goes wrong with style resolution, fall back to the
      // original render so the app never gets stuck.
      return originalRender.call(this, props, ref);
    }
  };
}
