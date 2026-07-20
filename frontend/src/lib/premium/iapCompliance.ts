/**
 * iapCompliance — single source of truth for Apple App Store compliance.
 *
 * Apple's App Store Review Guidelines (§3.1.1) require that unlocking premium
 * DIGITAL features inside the iOS app must go through Apple In-App Purchase —
 * apps may not use third-party payment mechanisms (card/PayPal via the web
 * checkout, Mobile Money, etc.) for in-app digital goods, nor direct users to
 * external purchase flows.
 *
 * Until native StoreKit IAP is integrated, we TEMPORARILY DISABLE all premium
 * PURCHASE entry points on iOS only. Android and web keep every purchase path
 * (Hercules Commerce card/PayPal checkout, Mobile Money, license-code redeem).
 *
 * IMPORTANT: this only hides the PURCHASE UI. It does NOT change premium
 * ENTITLEMENT — a user who already has Premium (trial, license, or an active
 * subscription bought on Android/web) keeps full access on iOS.
 */
import { Platform } from 'react-native';

/**
 * True when premium purchase/redeem UI must be hidden (iOS builds).
 * Web (Platform.OS === 'web') and Android keep all purchase options.
 */
export const PREMIUM_PURCHASES_DISABLED_IOS = Platform.OS === 'ios';
