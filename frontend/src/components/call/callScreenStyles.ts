import { StyleSheet } from 'react-native';
import { Colors, FontSize, FontWeight, Shadow, Spacing } from '../../theme';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.headerBg,
    justifyContent: 'space-between',
  },
  heldBanner: {
    position: 'absolute',
    top: 96,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(75,85,99,0.95)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  heldBannerText: { flex: 1, color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  heldBannerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  heldBannerEndBtn: { backgroundColor: 'rgba(239,68,68,0.9)' },
  heldBannerBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  onHoldBanner: { top: 56, backgroundColor: 'rgba(180,53,59,0.95)' },
  containerTransparent: {
    backgroundColor: 'transparent',
  },
  callLoadingScreen: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
  },
  callLoadingText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
    color: Colors.white,
  },
  topArea: {
    alignItems: 'center',
    paddingTop: 18,
    gap: 6,
    paddingHorizontal: Spacing.lg,
    flex: 1,
    justifyContent: 'flex-start',
  },
  topAreaCompact: {
    paddingTop: 10,
  },
  topUtilityRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.lg,
    marginBottom: Spacing.base,
  },
  topUtilityRowCompact: {
    marginTop: Spacing.base,
    marginBottom: Spacing.sm,
  },
  heroContent: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.lg,
  },
  heroContentCompact: {
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  topUtilitySide: {
    width: 44,
    height: 44,
  },
  statusChip: {
    minHeight: 54,
    minWidth: 146,
    paddingHorizontal: 24,
    borderRadius: 28,
    backgroundColor: 'rgba(228,181,59,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(228,181,59,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusChipSpacer: {
    width: 146,
    height: 54,
  },
  statusChipText: {
    color: '#FFD34E',
    fontSize: 18,
    fontWeight: FontWeight.semibold,
  },
  ringingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  ring: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  callAvatarCore: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 6,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  callAvatarInitials: {
    color: 'rgba(255,255,255,0.4)',
    fontWeight: FontWeight.medium,
    letterSpacing: 1.5,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: Spacing.lg,
  },
  dotsRowCompact: {
    marginTop: Spacing.base,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primaryLight,
  },
  incomingRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    gap: Spacing.xxl,
  },
  incomingCol: {
    alignItems: 'center',
    gap: Spacing.sm,
  },
  incomingActionLabel: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  name: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    marginTop: Spacing.lg,
    textAlign: 'center',
    maxWidth: '90%',
  },
  nameCompact: {
    fontSize: 20,
    lineHeight: 26,
    marginTop: Spacing.md,
  },
  status: {
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.62)',
    fontWeight: FontWeight.regular,
    marginTop: 4,
  },
  statusCompact: {
    fontSize: FontSize.base,
    marginTop: 2,
  },
  subStatus: {
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.48)',
    opacity: 1,
  },
  subStatusCompact: {
    marginTop: 2,
  },
  errorText: {
    color: Colors.danger,
    fontSize: FontSize.sm,
    textAlign: 'center',
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  controls: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    gap: 16,
  },
  controlsCompact: {
    paddingBottom: Spacing.lg,
    gap: 10,
  },
  controlsTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  controlsSecondaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'flex-start',
    columnGap: Spacing.lg,
    rowGap: 12,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.lg,
  },
  bigBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  bigBtnXL: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  bigBtnLabel: {
    color: Colors.white,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    marginTop: 4,
  },
  smallBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  smallBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  smallControlWrap: {
    alignItems: 'center',
    width: 64,
    gap: 6,
  },
  smallBtnLabel: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    fontWeight: FontWeight.medium,
    textAlign: 'center',
    maxWidth: 64,
  },
  audioMenuCard: {
    backgroundColor: 'rgba(28,22,4,0.92)',
    alignSelf: 'center',
    width: '88%',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(228,181,59,0.18)',
    overflow: 'hidden',
    marginBottom: 6,
  },
  audioMenuTitle: {
    color: '#FFD34E',
    fontSize: 16,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.8,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(228,181,59,0.14)',
  },
  audioMenuRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 14,
  },
  audioMenuRowSelected: {
    backgroundColor: 'rgba(228,181,59,0.18)',
  },
  audioMenuIconWrap: {
    width: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioMenuLabel: {
    flex: 1,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 16,
    fontWeight: FontWeight.medium,
  },
  audioMenuLabelSelected: {
    color: '#FFD34E',
  },
  audioMenuSelectedDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#FFD34E',
  },

  /* Video layer */
  videoLayer: {
    flex: 1,
    backgroundColor: '#000',
    position: 'relative',
  },
  // iter-107: dark translucent scrim placed OVER the local-camera-as-
  // background during outgoing video-call ringing so the avatar / name /
  // "Ringing…" chip text remain readable on top of the live preview.
  // Slightly stronger than the gradient overlay (0.55) because phone
  // cameras often pick up bright backgrounds.
  ringingPreviewScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 7, 0, 0.55)',
  },
  pipWrap: {
    position: 'absolute',
    // iter-273: move the self-preview to the LOWER-right as a small rectangle
    // (above the controls) so it no longer covers the other participant's face
    // in the upper/centre of the frame. Smaller footprint too.
    bottom: 168,
    right: Spacing.base,
    width: 96,
    height: 130,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  // iter-314: pop-out (in-app mini + OS PiP) layout — the remote participant
  // fills the top and the local self-view is a rectangle attached directly
  // BELOW it (same width/base, ~18% height) instead of covering their face.
  popoutRoot: { flex: 1, backgroundColor: '#0b141a' },
  popoutRemote: { flex: 1, position: 'relative', overflow: 'hidden' },
  popoutSelfStrip: {
    height: '18%',
    width: '100%',
    backgroundColor: '#000',
    overflow: 'hidden',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.28)',
  },
  popoutSelfOff: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#11202b' },
  videoTopOverlay: {
    position: 'absolute',
    // iter-273: nudge the participant name higher so it clears the centre.
    top: Spacing.xs,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
  },
  // iter-278: full-screen wrappers so the auto-hide fade (opacity) can be
  // animated without disturbing the absolute anchoring of the inner overlays.
  videoTopOverlayAnim: {
    ...StyleSheet.absoluteFillObject,
  },
  videoControlsOverlayAnim: {
    ...StyleSheet.absoluteFillObject,
  },
  videoControlsOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.lg,
    // iter-273: shift the call buttons lower (less bottom padding above the
    // safe-area inset) so they sit nearer the bottom edge and free the centre.
    paddingBottom: Spacing.base,
    paddingTop: Spacing.xxl,
    gap: Spacing.lg,
    backgroundColor: 'transparent',
  },
  videoName: {
    color: Colors.white,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
    maxWidth: '86%',
  },
  videoStatus: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: FontSize.sm,
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  // iter-407/408: "video paused — weak network" tappable note during adaptive
  // audio-only fallback. Its own overlay so it stays interactive (the top
  // info bar fades with pointerEvents="none").
  weakNetOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingTop: 56,
  },
  // iter-407: "video paused — weak network" note during adaptive audio-only fallback.
  weakNetPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  weakNetText: {
    color: '#FFFFFF',
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
});
