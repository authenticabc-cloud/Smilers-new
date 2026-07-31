/**
 * autoEnhanceImage — one-tap "auto enhance" for the Photo Editor.
 *
 * Applies a curated saturation×contrast+brightness color-matrix to the source
 * image via the Skia engine (see colorMatrix.ts) — a TRUE pixel transform that
 * actually pops the photo. Native-only; returns null on web / any failure so
 * the caller keeps the original image.
 */
import { applyColorMatrixToImage, buildAdjustMatrix } from './colorMatrix';

export async function autoEnhanceImage(uri: string): Promise<string | null> {
  const matrix = buildAdjustMatrix({ contrast: 1.12, saturation: 1.25, brightness: 0.04 });
  return applyColorMatrixToImage(uri, matrix);
}

export default autoEnhanceImage;
