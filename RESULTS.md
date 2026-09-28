# Results

Everything here ran on preprod on 2026-09-27, with `@x402/core` 2.27.0, `@x402/cardano` 2.27.0,
`@x402/fetch` 2.27.0 and `@evolution-sdk/evolution` 0.5.14. Nothing ran on mainnet. Figures are
read back from Blockfrost, not taken from the code's own logs.

## 1. Feasibility, build only (`spike/feasibility.ts`)

Before any code, one transaction was built from a real tUSDM UTxO and a real ADA-only UTxO and
never submitted.

- evolution-sdk builds DESIGN.md section 5 as intended: `collectFrom` both inputs, one explicit
  output for the buyer's change, and `build({ changeAddress: payTo, availableUtxos: [] })`. The
  buyer's change carried exactly the buyer's 4.162539 tADA. The payment output carried the
  sponsor's 24.418605 tADA less the fee.
- The fee counts the sponsor's witness. The buyer-signed transaction was 988 B, the fully signed
  one 1,089 B (+101 B for one vkey witness), and the fee of 203,297 lovelace is exactly the floor
  for 1,089 B.
- `@x402/cardano`'s own facilitator `verify` accepted both the buyer-signed and the fully signed
  transaction.
- An evolution-sdk seed wallet's `signTx(tx)` signs only for required signers and for inputs found
  in `context.utxos`. Called without the context it returned no witness at all. The pool hands it
  exactly the bound UTxO.

## 2. Setup (`spike/fund.ts`)

| Account | Role | Funded in | Holding |
|---|---|---|---|
| 5 | buyer A | `200d0c9223929cd3b481e89d0821dbb3814a9d1a8fcb70a68377a88368c164c3` | one UTxO: 20 tUSDM + 1.176630 tADA, its exact min-ada |
| 7 | buyer B | the same transaction | the same |
| 6 | sponsor key | `f58285a937208bb195f1b85650d5a9426b0801a503510e291e8a8b99d22b0a04` | 6 × 1.5 tADA |
| 1 | seller `payTo` | — | — |

The sponsor was refilled with another 6 × 1.5 tADA for the negatives, in
`d2c1ed55b14781f11b8901aca3f27dee1fcf712e31ae06564baac2cc2536f109`.

The stack is `x402HTTPResourceServer` → `HTTPFacilitatorClient` → an `x402Facilitator` over HTTP,
with `@x402/fetch` as the client. The route charges 1 tUSDM, with `maxTimeoutSeconds` 300 and
settlement at block inclusion (`l1Confirmations: 0`).

## 3. Payments (`spike/e2e.ts`)

| # | Phase | Payer | Transaction | Block | CBOR | Fee (tADA) | Paid by | Request to 200 |
|---|---|---|---|---|---|---|---|---|
| 1 | sequential | buyer A | `f21a6ed8e510572cb0c7917040671f3e0e3aad84d2511ae09dbced1819179707` | 5226093 | 529 B | 0.178657 | seller | 59.0 s |
| 2 | sequential | buyer A | `d4a5d8bcf973aa79c0518e20c69a394856044bf7e63c566d7d1b83d9f8d22429` | 5226095 | 529 B | 0.178657 | seller | 41.7 s |
| — | sequential | buyer A | `173d63dff4295622703ee353fab5d13553dc2e43498b3a829bf0a31d5da53a79` | never | — | — | — | expired, see 5.4 |
| 3 | sequential | buyer A | `4c44f4c30ddda29a23ea6dad6147865375ea0b762e1f88cb761955735ce0d140` | 5226107 | 529 B | 0.178657 | seller | 53.1 s |
| 4 | sequential | buyer A | `e8ed2909ac44b03cde48e77a2eb80e83eab1c3a3bc0b104ad1fd706c2e037c10` | 5226109 | 529 B | 0.178657 | seller | 41.4 s |
| 5 | plain client | account 0 | `b6f6a3b12369740a4a940ec8931e732474a6b9e14f4ff25a7dbcbab4a4390347` | 5226110 | 988 B | 0.198853 | buyer | 21.9 s |
| 6 | concurrent | buyer B | `cc9da2db33ae22ae471a03a8d822edfdf3bb0e5ab62b6e02d60db314d823cfdc` | 5226113 | 529 B | 0.178657 | seller | 47.1 s |
| 7 | concurrent | buyer A | `3701549464375c3ae5372278b7c1f69e857b55529dd3e7bd500282de9fd98138` | 5226113 | 529 B | 0.178657 | seller | 47.7 s |

- Every sponsored transaction has 2 inputs (the buyer's tUSDM UTxO and one sponsor UTxO), 2
  outputs and 2 witnesses. Its fee, 178,657 lovelace, is exactly the ledger floor for its 529 B.
  (Blockfrost's `size` field reports 528.)
- Payment 5 used `@x402/cardano`'s reference signer, which ignores the offer. The server bound
  nothing, and the payment went through the plain way.
- Payments 6 and 7 were sent at the same moment. They got different sponsor UTxOs and landed in
  the same block.
- Request-to-200 times are dominated by waiting for a block: the facilitator settles at inclusion.

## 4. Reconciliation, per address, from the chain

Over the 7 payments in section 3:

| Address | tADA | tUSDM |
|---|---|---|
| buyer A | **±0** | −5 |
| buyer B | **±0** | −1 |
| account 0 (plain client) | −1.375483 | −1 |
| sponsor | −9.000000 | 0 |
| seller `payTo` | +9.104688 | +7 |

- Both buyers ended with exactly the 1.176630 tADA they started with, still in one UTxO each.
- The seller's `payTo` received 6 × 1.321343 tADA with the sponsored payments (each sponsor UTxO
  less its fee) and 1.176630 tADA of min-ada from the plain payment.
- The seller's net ADA across `payTo` and the sponsor is +0.104688. That is the plain buyer's
  1.176630 of min-ada less the 6 fees it paid, 1.071942. On the sponsored payments alone, **the
  seller's net ADA is minus the fees, to the lovelace**.
- The plain client's −1.375483 tADA is the 0.198853 fee plus the 1.176630 of min-ada it handed the
  seller: what every buyer pays today on top of the price.

## 5. Negatives (build-only, never co-signed)

Each case is a transaction built by hand from buyer A's real UTxO and a real offer, signed by the
buyer, and sent through the whole stack as a paid request. Each layer was also asked on its own:
the facilitator's `/verify`, and the seller's checks (`checkSponsoredTx`) as they run before it
would sign.

| Case | HTTP | Facilitator | Seller | Landed |
|---|---|---|---|---|
| S2: a second sponsor UTxO as input, its ADA to `payTo` | 402 `fee_sponsor_S2` | valid (S2 is the seller's) | S2 | no |
| S3: a collateral input | 402 `fee_sponsor_refused` | S3 | S3 | no |
| S4: 0.1 tADA of the sponsor's to the buyer | 402 `fee_sponsor_refused` | S4 | S4 | no |
| S5: fee 0.31 tADA over `maxFee` 0.3 | 402 `fee_sponsor_refused` | S5 | S5 | no |
| S7: validity bound past the offer | 402 `…ttl_too_far` | `@x402/cardano`'s TTL rule | S7 | no |
| S9: fee sized for one witness (174,213 < 178,657) | 402 `fee_sponsor_refused` | S9 | S9 | no |
| S8: half the price | 402 `…amount_insufficient` | `@x402/cardano`'s amount rule | S8 | no |
| an offer with its expiry moved | 402 `No matching payment requirements` | valid | passes | no |
| F3: `/settle` straight to the facilitator, no seller witness | — | `fee_sponsor_witness_missing` | — | no |

S6 (certificates, mint and the like) is covered by the chain-free tests only. On preprod,
`@x402/cardano`'s facilitator refuses any transaction with balance-changing operations before the
sponsorship rules run.

## 6. What the runs found, and what changed

1. **A paid retry must be matched to its offer.** The first run's paid request got a 402 "No
   matching payment requirements". Core's HTTP server puts the payment into the transport context
   (`request.paymentHeader`) only when the calling framework sets it. The server now also reads the
   `PAYMENT-SIGNATURE` header from the adapter, so any HTTP integration works. There is a
   chain-free test for each path.
2. **A refused payment kept the buyer's only UTxO marked as spent**, so the next attempt found no
   tUSDM. `SponsoredExactCardanoClient` now wraps `@x402/cardano`'s client scheme with an
   `onPaymentResponse` hook that releases a payment's inputs unless it settled.
3. **A provider hiccup emptied the pool.** One Blockfrost read failed during the first 402, which
   became an HTTP 500. The next 402s carried no offer, because a refresh was only retried 20 s
   later. The pool now retries its read, and a failed refresh keeps what it last read. The runner
   starts Node with `--dns-result-order=ipv4first`: IPv6 is unreachable on this host.
4. **A 172 s gap between preprod blocks** (12:52:55 → 12:55:47 UTC, blocks 5226095 → 5226096)
   expired a submitted payment. Its offer ran 120 s, and the transaction's validity bound was the
   offer's expiry. The facilitator reported `settlement_pending` and then "the transaction's
   validity window closed before it was included". The seller had served nothing, since
   settlement failed before the response was released. Offers now run for the accept's
   `maxTimeoutSeconds` by default (300 s here).
5. **`@x402/fetch` cannot recover a taken offer by itself.** On `{ recovered: true }` it rebuilds
   the payment from the *first* 402, which names the offer that failed. So the client scheme
   releases the inputs, and the caller asks again, which serves a fresh offer. The e2e does this
   once per payment.
6. **Only native-asset prices are sponsored.** With a lovelace price, the sponsor's ADA in the
   `payTo` output would count towards the price, and the seller would be paying itself.

## 7. Tests

41 chain-free tests (`npm test`): the rules S1–S9 on real-signed offline transactions, the pool,
the server's offers, binding, witness and cancellation, the facilitator's F1–F3 over
`@x402/cardano`'s own verification, the client scheme's release hook, and the signer's C6.
`npm run typecheck` is clean.

## 8. After milestone 1: the buyer checks the offer (C6)

Found on 2026-09-28, while bringing sponsorship to a wallet. At `3b251f6` the signer trusted the
offer's fields: a seller could name one of the buyer's own UTxOs as the sponsor's, and the
buyer's own signature would then spend it, its ADA going to the seller. This was confirmed on
preprod, with this project's own test accounts.

The fix is C6 (DESIGN.md section 5). The signer reads the offered UTxO through the wallet's
provider, `offerOnChainProblem` in `src/offer.ts` checks it against the offer and the buyer's
key, and the signer builds with the UTxO it read, not with the offer's fields. Two chain-free
tests cover it.
