# 🎟️ Convex Backend Changes Needed — Ad Credit Codes (Mobile Ads Addendum)

The mobile frontend now expects Ad Credit Codes support for both **Admin > Ads > Ad Codes** and **User > My Ads**.

The Convex backend source is not present in this repo, so please apply the following server-side changes.

## 1) New table: `adCreditCodes`

```ts
adCreditCodes: defineTable({
  code: v.string(),
  type: v.union(v.literal('credit'), v.literal('lifetime')),
  amountEur: v.optional(v.number()),
  remainingEur: v.optional(v.number()),
  status: v.union(v.literal('active'), v.literal('redeemed'), v.literal('exhausted'), v.literal('revoked')),
  createdBy: v.id('users'),
  redeemedBy: v.optional(v.id('users')),
  redeemedAt: v.optional(v.string()),
  note: v.optional(v.string()),
})
  .index('by_code', ['code'])
  .index('by_redeemed_by', ['redeemedBy'])
```

## 2) Required functions

| Function | Type | Path | Args | Returns | Auth |
|---|---|---|---|---|---|
| `generateCreditCode` | mutation | `api.adCreditCodes.generateCreditCode` | `{ amountEur, note? }` | `{ id, code }` | Admin |
| `generateLifetimeCode` | mutation | `api.adCreditCodes.generateLifetimeCode` | `{ note? }` | `{ id, code }` | Admin |
| `listCodes` | query | `api.adCreditCodes.listCodes` | `{}` | Last 100 codes with `redeemedByName?` | Admin |
| `revokeCode` | mutation | `api.adCreditCodes.revokeCode` | `{ codeId }` | `void` | Admin |
| `redeemCode` | mutation | `api.adCreditCodes.redeemCode` | `{ code }` | `{ type, amountEur? }` | Authenticated |
| `getMyAdCredits` | query | `api.adCreditCodes.getMyAdCredits` | `{}` | `{ hasLifetime, totalRemainingEur, codes[] }` | Authenticated |

## 3) Code format

- Human format: `XXX-XXX-XXX`
- Allowed chars: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
- Exclude: `I`, `O`, `1`, `0`
- Input lookup should normalize by:
  - uppercase
  - remove dashes/spaces

## 4) Business rules

- Only admins can generate and revoke codes
- Each code can only be redeemed once
- `lifetime` codes never exhaust
- `credit` codes decrement by **0.06 EUR per click**
- Revoking a redeemed code immediately stops it from covering future clicks
- Multiple redeemed codes may stack; lifetime overrides all standard balances

## 5) `api.ads.recordClick` change

When recording a click:

1. Find the ad creator's redeemed codes
2. If creator has a redeemed lifetime code, do **not** charge the click
3. Otherwise, find a redeemed credit code with `remainingEur >= 0.06`
4. Deduct `0.06`
5. If remaining balance becomes `0`, set `status = 'exhausted'`
6. Always record the ad click whether credits exist or not

## 6) Suggested return shapes

### `listCodes`

Return rows like:

```ts
{
  _id,
  code,
  type,
  amountEur,
  remainingEur,
  status,
  note,
  redeemedBy,
  redeemedByName,
  redeemedAt,
}
```

### `getMyAdCredits`

Return:

```ts
{
  hasLifetime: boolean,
  totalRemainingEur: number,
  codes: Array<{
    _id,
    code,
    type,
    amountEur,
    remainingEur,
    status,
    redeemedAt,
  }>
}
```

## 7) Mobile UI expectations

The mobile app now has:

- **Admin > Ads > Ad Codes** tab:
  - generate credit code
  - generate lifetime code
  - copy last generated code
  - revoke recent codes

- **My Ads** top card:
  - show lifetime / remaining EUR / no credits
  - redeem code input
  - click estimate based on `amount / 0.06`

If your backend already uses different function names, either alias them or update the frontend imports accordingly.