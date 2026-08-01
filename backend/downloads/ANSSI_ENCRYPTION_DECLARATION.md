# ANSSI Encryption Declaration — Technical Dossier
## Smilers Chat (iOS / Android mobile application)

> **Purpose of this document:** Supporting technical description to accompany the
> declaration ("déclaration de fourniture / d'importation d'un moyen de
> cryptologie") filed with **ANSSI** (Agence nationale de la sécurité des
> systèmes d'information), as required to distribute an app using cryptography in
> France. Once filed, ANSSI returns a **récépissé de déclaration** — that receipt
> is the PDF you upload to App Store Connect ("French encryption declaration
> approval form").
>
> **Regulatory basis:** The product is a **mass-market** application relying
> **exclusively on standard, published cryptographic algorithms** (no proprietary
> or modified algorithm). It therefore falls under the **declaration** regime
> (régime de déclaration), not the authorisation regime.

---

## 1. Declarant / Company information  *(fill in before submitting)*

| Field | Value |
|---|---|
| Company / legal entity name | _______________________ |
| SIREN / registration number | _______________________ |
| Registered address | _______________________ |
| Contact name | _______________________ |
| Contact email | _______________________ |
| Contact phone | _______________________ |
| Role of declarant | Fournisseur / éditeur de l'application |

## 2. Product identification

| Field | Value |
|---|---|
| Product name | **Smilers Chat** |
| Type | Mobile application (iOS and Android) |
| iOS Bundle Identifier | `com.smilers.app` |
| Distribution channel | Apple App Store / Google Play |
| Category | Secure messaging & voice/video calling |
| Nature of the cryptographic means | Software, embedded in the application |
| Function of the cryptology | Confidentiality & integrity of user communications and locally stored data |

## 3. Functional description

Smilers Chat is a secure messaging and calling application that enables users to
exchange text messages, voice notes, images, and documents, and to make voice and
video calls. It uses **standard industry encryption** to protect user
communications and privacy:

- **End-to-end encryption (E2EE)** of message content and media attachments.
- **Encrypted local storage** for sensitive on-device data (e.g. private diary,
  cached media, credentials).
- **Encrypted transport** for all network traffic and real-time media.

No custom, proprietary, or modified cryptographic algorithm is designed or used.
All cryptography is implemented from **published, internationally standardised
primitives** using well-known, publicly audited open-source libraries.

## 4. Cryptographic mechanisms used

### 4.1 Symmetric encryption (content & media E2EE, local storage)
| Property | Value |
|---|---|
| Algorithm | **AES** in **GCM** mode (authenticated encryption) |
| Key length | **256 bits** |
| IV / nonce | 96 bits (12 bytes), unique per message |
| Authentication tag | 128 bits (GCM standard) |
| Standard | NIST FIPS 197 (AES), NIST SP 800-38D (GCM) |

### 4.2 Key derivation
| Property | Value |
|---|---|
| Function | **PBKDF2** with **HMAC-SHA-256** |
| Iterations | 100,000 |
| Derived key length | 256 bits |
| Salt | Per-conversation, randomly generated |
| Standard | NIST SP 800-132 / RFC 8018 (PBKDF2), RFC 2104 (HMAC), FIPS 180-4 (SHA-256) |

### 4.3 Hashing / integrity
| Property | Value |
|---|---|
| Hash function | **SHA-256** |
| Message authentication | **HMAC-SHA-256** |
| Standard | FIPS 180-4, RFC 2104 |

### 4.4 Transport security
| Property | Value |
|---|---|
| Protocol | **TLS 1.2 / 1.3** (provided by the operating system) |
| Real-time media (voice/video) | **DTLS-SRTP** (WebRTC standard) |
| Standard | RFC 8446 (TLS 1.3), RFC 5246 (TLS 1.2), RFC 5764 (DTLS-SRTP) |

> Note: No asymmetric key-exchange algorithm is implemented within the
> application itself. Public-key operations occur only inside the OS-provided
> TLS/DTLS stack (standard, exempt transport encryption).

### 4.5 Secure key / secret storage
| Property | Value |
|---|---|
| iOS | **Keychain Services** (via `expo-secure-store`) |
| Android | **Android Keystore / EncryptedSharedPreferences** (via `expo-secure-store`) |
| Randomness | OS CSPRNG (via `expo-crypto`) |

## 5. Cryptographic libraries (implementation)

| Library | Role | Nature |
|---|---|---|
| `@noble/ciphers` | AES-GCM implementation | Open-source, audited, standard algorithms |
| `@noble/hashes` | SHA-256, HMAC, PBKDF2 | Open-source, audited, standard algorithms |
| `expo-secure-store` | Keychain / Keystore access | Standard OS secure storage |
| `expo-crypto` | Cryptographically secure random | Standard OS CSPRNG |
| Operating system TLS/DTLS | Transport encryption | Apple/Google standard stacks |
| Stream Video SDK / WebRTC | Real-time media (DTLS-SRTP) | Industry-standard WebRTC |

## 6. Regulatory classification summary

- **Uses cryptography:** Yes.
- **Only standard / published algorithms (AES, PBKDF2, SHA-256, TLS, DTLS-SRTP):** Yes.
- **Proprietary or modified algorithm designed by the publisher:** No.
- **Regime:** Declaration (déclaration), mass-market product.
- **US EAR classification (for reference):** ECCN **5D992.c** (mass-market
  encryption software using standard cryptography).

## 7. Declaration checklist

1. [ ] Complete Section 1 (company/contact) and Section 2 (any missing IDs).
2. [ ] Submit the declaration on the ANSSI portal:
       `https://www.ssi.gouv.fr/entreprise/reglementation/controle-reglementaire-sur-la-cryptographie/`
       (choose **déclaration**, not demande d'autorisation).
3. [ ] Attach this dossier as the technical description.
4. [ ] Receive the **récépissé de déclaration** from ANSSI by email.
5. [ ] In App Store Connect → App Encryption Documentation (step 3/3):
       keep **Yes** for France, upload the ANSSI récépissé PDF, tap **Save**.

---

*This document describes the cryptography as implemented in the Smilers Chat
codebase. It is a technical aid for the ANSSI filing and does not constitute
legal advice; confirm the final filing details with your legal/compliance
contact.*
