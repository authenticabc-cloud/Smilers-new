/**
 * colorMatrix — build 4×5 RGBA color matrices for grayscale / contrast /
 * saturation / brightness adjustments, and bake them into an image file via the
 * Skia engine (offscreen render). Shared by the Photo Editor's "Adjust" sliders
 * and the one-tap "Enhance" preset.
 *
 * Native-only: Skia is lazy-imported (kept out of the web bundle); the bake
 * function no-ops on web and returns null so callers keep the original image.
 */
import { Platform } from 'react-native';

export interface AdjustParams {
  /** 0 = full color, 1 = full grayscale. */
  grayscale?: number;
  /** 1 = neutral (~0.5..1.5 useful). */
  contrast?: number;
  /** 1 = neutral (0 = grayscale, 2 = vivid). */
  saturation?: number;
  /** 0 = neutral, normalized offset added to each channel. */
  brightness?: number;
}

// Rec. 709 luma weights.
const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

/**
 * Compose saturation (grayscale folds in as effectiveSaturation), then contrast
 * + brightness, into a single 20-element (4×5) color matrix.
 */
export function buildAdjustMatrix({ grayscale = 0, contrast = 1, saturation = 1, brightness = 0 }: AdjustParams): number[] {
  const s = Math.max(0, saturation) * (1 - Math.min(1, Math.max(0, grayscale)));
  const sr = (1 - s) * LR;
  const sg = (1 - s) * LG;
  const sb = (1 - s) * LB;
  const S = [
    [sr + s, sg, sb],
    [sr, sg + s, sb],
    [sr, sg, sb + s],
  ];
  const c = contrast;
  const t = (1 - c) * 0.5 + brightness;
  return [
    c * S[0][0], c * S[0][1], c * S[0][2], 0, t,
    c * S[1][0], c * S[1][1], c * S[1][2], 0, t,
    c * S[2][0], c * S[2][1], c * S[2][2], 0, t,
    0, 0, 0, 1, 0,
  ];
}

/** Bake a color matrix into `uri`, returning a new JPEG file uri (or null). */
export async function applyColorMatrixToImage(uri: string, matrix: number[]): Promise<string | null> {
  if (Platform.OS === 'web' || !uri) return null;
  try {
    const { Skia, ImageFormat } = await import('@shopify/react-native-skia');
    const LegacyFileSystem = await import('expo-file-system/legacy');

    const data = await Skia.Data.fromURI(uri);
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) return null;

    const w = image.width();
    const h = image.height();
    const surface = Skia.Surface.MakeOffscreen(w, h);
    if (!surface) return null;

    const canvas = surface.getCanvas();
    const paint = Skia.Paint();
    paint.setColorFilter(Skia.ColorFilter.MakeMatrix(matrix));
    canvas.drawImage(image, 0, 0, paint);
    surface.flush();

    const snapshot = surface.makeImageSnapshot();
    const b64 = snapshot.encodeToBase64(ImageFormat.JPEG, 92);
    if (!b64) return null;

    const out = `${LegacyFileSystem.cacheDirectory}pe_adjust_${Date.now()}.jpg`;
    await LegacyFileSystem.writeAsStringAsync(out, b64, { encoding: LegacyFileSystem.EncodingType.Base64 });
    return out;
  } catch (err) {
    console.log('[colorMatrix] apply failed', err);
    return null;
  }
}
