# Seller-sponsored fees for x402 `exact` on Cardano

**Status: milestone 1 (section 14) passed on preprod on 2026-09-27; see [RESULTS.md](RESULTS.md).
Preprod only.** It extends the Cardano binding of x402's
`exact` scheme (`specs/schemes/exact/scheme_exact_cardano.md` in x402-foundation/x402, as
implemented by `@x402/cardano` 2.27.0). Nothing here has run on mainnet.

## 1. The problem

On Cardano's `exact` scheme the client builds and signs the whole transaction, so the spec says
"the client pays the fee" and "the client funds this min-ada" for the output paying `payTo`. It
also says fee sponsorship "is not supported by this scheme version", and that it is "achievable on
Cardano through collaborative, multi-party transaction building [...] left to a future
extension". The facilitator advertises `areFeesSponsored: false`.

That has two effects on a buyer paying in a stablecoin (USDM, USDCx):

- **It must hold spare ADA.** An agent funded with USDC-type money cannot pay at all until it buys
  ADA. On Base and Solana it never touches the gas token: the facilitator pays gas (EIP-3009
  authorizations, a facilitator fee payer).
- **Every payment hands the seller about 1.17 ADA of the buyer's.** The `payTo` output must carry
  its min-UTxO, about 1.17 ADA for a USDM or USDCx output at `coinsPerUtxoByte` 4310, and the
  buyer funds it. With the fee of about 0.17 ADA, a payment costs the buyer about 1.34 ADA
  (~$0.34 at $0.256) on top of the price, and 1.17 ADA of that ends up as the seller's.

## 2. The idea

The seller pays, with ADA that stays its own. The 402 offers one of the seller's ADA-only UTxOs.
The buyer's transaction spends it next to the buyer's token UTxO(s). The sponsor's ADA pays the
fee and the min-ada of the `payTo` output, and that output is the seller's own address. The
seller signs for its UTxO at settlement.

| Per payment | Plain `exact` today | Seller-sponsored |
|---|---|---|
| Buyer gives up | price + ~1.17 ADA min-ada + ~0.17 ADA fee | **the price only** |
| Seller receives | price + ~1.17 ADA | price + (sponsor UTxO − fee) of its own ADA back |
| Seller's net cost | none | **the network fee, ~0.18 ADA (~$0.046)** |
| ADA the buyer must hold | fee + min-ada, spare | **none beyond what arrived with its tokens** |

The buyer's ADA is not touched. A token UTxO always carries its own min-ada, which came with the
tokens; in the sponsored transaction that ADA passes straight into the buyer's change output,
which holds the remaining tokens. A buyer whose wallet is one UTxO of USDCx plus its min-ada can
keep paying until the USDCx runs out.

## 3. Wire format

### 3.1 Facilitator capability

A facilitator that can finish a sponsored transaction says so in its `/supported` kind for
`exact` on a Cardano network, next to what `@x402/cardano` already advertises:

```json
{ "assetTransferMethods": ["default", "masumi", "script"], "areFeesSponsored": false,
  "l1Confirmations": { "minimum": 0, "maximum": 20 }, "acceptsSponsorWitnesses": true }
```

`areFeesSponsored` stays `false`: the facilitator itself pays nothing. `acceptsSponsorWitnesses`
means it merges the seller's witnesses from the settlement payload (3.3). A resource server makes
offers only to a facilitator that advertises it; any other facilitator would broadcast the
transaction without the seller's witness, the node would reject it, and the protected handler
would already have run.

### 3.2 The offer, in `PaymentRequirements.extra`

Only on the `default` asset transfer method, and only for native-asset prices. `masumi` and
`script` stay unsponsored in this draft. A lovelace price is excluded because the sponsor's ADA
sits in the `payTo` output: it would count towards the price, and the seller would be paying
itself.

```json
"extra": {
  "areFeesSponsored": true,
  "feeSponsor": {
    "input": "8c8e48…d1#3",
    "address": "addr_test1vq…",
    "lovelace": "1500000",
    "maxFee": "300000",
    "expiresAt": "1790513000000"
  }
}
```

| Field | Meaning |
|---|---|
| `input` | the sponsor UTxO, `txHash#index`; ADA-only, at a key-credential address |
| `address` | its address, so the client can build without a chain lookup |
| `lovelace` | its exact value |
| `maxFee` | the largest network fee the sponsor pays; the rest of `lovelace` goes to `payTo` |
| `expiresAt` | POSIX ms; the transaction's validity upper bound must not be later |

`areFeesSponsored: true` appears only on an accept that carries an offer. Without an offer the
accept is plain `exact`, and says `false` as today.

### 3.3 Payload and settlement

The client's `PaymentPayload.payload` is unchanged: `{ transaction, nonce }`. The transaction is
signed by the buyer only, and the nonce is one of the buyer's inputs, so the facilitator still
resolves the payer from it.

At settlement the resource server adds one key, through `@x402/core`'s scheme hook
`enrichSettlementPayload`, whose additions may not overwrite client keys:

```json
"payload": { "transaction": "…", "nonce": "…#0", "sponsorWitnesses": "a100d9010281825820…" }
```

`sponsorWitnesses` is a CBOR witness set, hex, with the seller's vkey witness for the sponsor
input. The facilitator merges it into the transaction's witness set (the body, and so the
transaction id, does not change), then verifies and broadcasts as usual.

## 4. The flow against `@x402/core` 2.27

1. **402.** The server scheme's `enrichPaymentRequiredResponse` adds `feeSponsor` to each
   sponsorable Cardano `exact` accept. Core calls it for the paid request too, and the paid payload
   is not passed in. It is read from `transportContext` as `@x402/cardano`'s Masumi issuer does,
   and, since core fills `request.paymentHeader` only when the calling framework sets it, from the
   adapter's `PAYMENT-SIGNATURE` header. When the paid payload names a live offer for this accept,
   the same offer is served again, byte for byte, so core's `findMatchingRequirements` matches it.
   Otherwise a fresh one.
2. **Client.** A sponsor-aware signer builds the transaction in section 5 and signs its own inputs.
   A client that ignores `feeSponsor` pays the plain way and still matches, since it echoes the
   accept as served.
3. **Verify.** The facilitator's usual checks pass on the buyer-signed transaction: inputs are not
   restricted to the payer, the payer is the nonce's owner, and signature validity is checked for
   the witnesses present. The facilitator adds F1 (section 7).
4. **Bind.** The server's `onAfterVerify` hook: if the transaction spends the offered input, it
   runs S1–S9 (section 6), computes its witness, and binds the offer to this transaction id. A
   failure aborts before the handler runs, with a fresh 402.
5. **Handler** runs.
6. **Settle.** `enrichSettlementPayload` returns the stored witness for the bound transaction.
   The facilitator merges, re-verifies and broadcasts.
7. **After.** `onAfterSettle` retires the UTxO. A cancelled payment releases the binding. On the
   client, an `onPaymentResponse` hook gives a payment's inputs back to the wallet unless it
   settled. `@x402/fetch` retries a recovered payment with the *first* 402, whose offer is the one
   that failed, so a buyer whose offer was taken asks again rather than recovering in place.

## 5. The transaction the buyer builds

```
inputs:   buyer token UTxO(s) holding ≥ amount of the asset     (one of them is the nonce)
          the sponsor UTxO                                        (feeSponsor.input)
outputs:  buyer change: all remaining tokens + all the buyer's input lovelace
          payTo:        amount of the asset + (feeSponsor.lovelace − fee) lovelace
fee:      paid out of the sponsor's lovelace, ≤ maxFee
validity: upper bound ≤ min(now + maxTimeoutSeconds, expiresAt)
```

With `@evolution-sdk/evolution` 0.5.14 this is `collectFrom` of those inputs, one explicit
`payToAddress` for the buyer's change, and `build({ changeAddress: payTo, availableUtxos: [] })`:
the builder's change *is* the payment output, and its fee estimate already includes a fake
witness for every key-locked input, the sponsor's too (`buildFakeWitnessSet` in
`internal/txBuilder.js`). `partialSign` gives the buyer's witness only.

Client rules:

- **C1** `feeSponsor.address` is a key-credential address on the payment's network.
- **C2** `expiresAt` is in the future, with at least a few seconds to spare.
- **C3** Buyer inputs hold only ADA and the payment asset, where the wallet has such UTxOs (no
  stranger tokens dragged along).
- **C4** No ADA-only buyer inputs, and nothing but the two outputs above. `autoMinUtxo` stays off
  for the buyer's change: bumping it would take the sponsor's ADA, which S4 refuses.
- **C5** If the build fails (buyer change under its min-UTxO, fee over `maxFee`), pay the plain way
  if the wallet can, else fail.

The client risks nothing by trusting the offer. Its signature covers a body that pays exactly
`amount` to `payTo` and returns everything else of its own to itself. If the offer lies about
the sponsor UTxO, the body does not balance and the ledger refuses it.

## 6. What the seller checks before signing

The seller's witness authorizes every input at the sponsor key, and value is conserved across the
whole transaction, so the checks are about where the sponsor's ADA can go:

- **S1** The transaction spends `feeSponsor.input`, the offer is live, and it is bound to no other
  transaction id.
- **S2** No other input is at the sponsor's payment key. Every input's owner is looked up on chain;
  a UTxO sent to the sponsor address after the pool's last read cannot slip in.
- **S3** No collateral inputs, no collateral return, no redeemers, no scripts in the witness set.
- **S4** Lovelace to `payTo` + fee ≥ `feeSponsor.lovelace`. With value conservation this means
  outputs to anyone else carry at most what the other inputs brought: the buyer cannot take the
  sponsor's ADA.
- **S5** fee ≤ `maxFee`.
- **S6** No `mint`, withdrawals, certificates, proposals, votes, donation or treasury value. A
  deposit could otherwise route the sponsor's ADA to a credential the buyer controls.
- **S7** The validity upper bound is set and not after `expiresAt`.
- **S8** An output pays at least `amount` of the asset to `payTo` (the facilitator checks this
  too; the seller will not sponsor a transaction that does not pay it).
- **S9** The fee covers the ledger floor with the seller's witness merged in: the seller signs
  here, before the handler, and checks the real merged size.

## 7. What the facilitator adds

- **F1** Verify, sponsored and not yet witnessed: run the usual checks, then the fee floor
  against the size with one more vkey witness (a placeholder merged in, only to measure; +101
  bytes), plus S4 and S5 as defence in depth.
- **F2** Settle with `sponsorWitnesses`: merge with `Transaction.addVKeyWitnessesHex`, which keeps
  the exact body bytes, then the usual verify, claim, broadcast and evidence path. The
  duplicate-settlement store is keyed by transaction id, which merging does not change.
- **F3** Settle of a transaction that spends an offered input but has no seller witness: refuse
  before broadcasting, rather than send what the node must reject.

## 8. Offers and binding

Offers are soft: serving one locks nothing. Binding is exclusive: the seller signs at most one
transaction per sponsor UTxO. Only a transaction the seller signed can spend the UTxO, so an
offer that is never used, or a payment that fails before settlement, leaves it unspent and
reusable.

- An offer runs for the accept's `maxTimeoutSeconds` by default. It bounds the transaction's
  validity, and preprod has shown a 172 s gap between blocks: a 120 s offer let a submitted
  payment expire in the mempool.
- The pool serves the least recently offered UTxO, so concurrent 402s usually get different ones.
  An empty pool, or none at the right size, means the 402 carries no offer and the accept stays
  plain `exact`.
- Two buyers may build on the same UTxO. The first to reach `onAfterVerify` binds it; the second
  is aborted and gets a fresh 402. Nothing is lost but a round trip.
- Because offers lock nothing, requesting 402s without paying cannot drain the pool.
- A binding is released when the payment is cancelled or its settlement is definitively rejected.
  After an ambiguous submission it holds until the validity bound has passed and the chain shows
  the UTxO still unspent.
- A settled payment retires the UTxO. The pool re-reads the sponsor address periodically and after
  each settlement; refilling splits a larger UTxO into offer-sized ones.

## 9. Compatibility

| Client | Server | Facilitator | Result |
|---|---|---|---|
| sponsor-aware | offers | accepts witnesses | sponsored |
| plain | offers | accepts witnesses | plain payment; the offer goes unused |
| sponsor-aware | no offer | any | plain payment |
| any | offers only if the facilitator accepts witnesses | plain | never offered |

## 10. Security notes

- **Blast radius.** The sponsor key is a separate hot key, not the `payTo` key, and holds only the
  pool. A leak loses the pool, no more.
- **The seller's witness stays with the seller** until settlement, when it goes to the facilitator
  inside the settlement payload. The client never sees it. If the payment is cancelled, the witness
  is dropped, and the transaction it would complete cannot land without it.
- **Replay.** Unchanged: the nonce is the buyer's input, and the settlement store keys on the
  transaction id.
- **Facilitator trust.** As in plain `exact`, the facilitator is trusted to verify and broadcast.
  It gains the ability to submit the one sponsored transaction the seller signed, which pays the
  seller.
- **What S4 does not cover.** It bounds lovelace, not tokens. The sponsor UTxO is ADA-only, so it
  has no tokens to divert.

## 11. Costs (measured on preprod)

- Sponsored transaction: 2 inputs, 2 outputs, 2 witnesses, 529 bytes, and a fee of 178,657
  lovelace, exactly the floor (155,381 + 44 × size). Estimated beforehand: about 530 bytes and
  0.179 ADA.
- Offer size: min-UTxO of the `payTo` output (~1.17 ADA) + `maxFee` (0.3 ADA) → 1.5 ADA.
  `payTo` receives about 1.32 ADA with each payment, which the seller recovers when it
  consolidates.
- For a price of $1 the seller's fee is 4.6%. Below about $0.50, x402 `batch-settlement` over
  channels is the better tool (subbit-x402); its channel openings are where sponsorship goes next
  (section 13).

## 12. Alternatives considered

- **The facilitator sponsors from its own ADA.** The `payTo` min-ada would be the facilitator's
  loss on every payment unless charged back. It would also need keys: `@x402/cardano`'s facilitator
  never holds keys, and the Cardano Foundation's says "never signs".
- **The facilitator holds a delegated seller key** (subbit-x402 step 9 does this for claims). This
  works, but it puts seller keys in a shared service. The seller-signs flow keeps the facilitator
  keyless; delegation can be layered on later for keyless servers.
- **A Plutus sponsor script** (spendable by anyone if its ADA goes to `payTo`): needs no seller
  signature, but every script transaction needs VKey-locked collateral from the builder, the buyer,
  and a token UTxO with ~1.2 ADA cannot cover collateral plus a collateral return above min-UTxO.
- **Two round trips** (the facilitator builds, the client signs): no reservation needed, but it
  breaks x402's single paid retry.
- **Wait for CIP-118 nested transactions (Babel fees).** The Dijkstra hard fork is expected
  between December 2026 and March 2027. Even then, a transaction with sub-transactions cannot run
  PlutusV1–V3 scripts, so channel transactions (Subbit's validator is PlutusV3) still need
  co-signing. The offer and its rules (sections 3, 6, 8) stay the same if the construction later
  moves to a sub-transaction.

## 13. Next: channel openings (milestone 2, sketch)

A `batch-settlement` channel opening in USDCx needs about 2.13 ADA of reserve plus the fee, which
a USDCx-only buyer lacks. The same offer can fund it: the sponsor's ADA becomes the channel's
reserve. In the cooperative refund, which the seller co-signs anyway, the reserve goes back to the
seller, and the seller can put up the refund's collateral. In a unilateral exit the buyer keeps
the reserve, so the seller's exposure is about 2.1 ADA per channel. This goes into subbit-x402
after milestone 1.

## 14. Milestone 1 (passed on preprod, 2026-09-27)

Code:

| Module | What |
|---|---|
| `src/offer.ts` | the offer's type, parsing and checks shared by all three roles |
| `src/rules.ts` | S1–S9 over a decoded transaction, and the fee-floor arithmetic |
| `src/pool.ts` | the sponsor wallet's UTxOs, soft offers, exclusive bindings, refill |
| `src/server.ts` | a `SchemeNetworkServer` wrapping `@x402/cardano`'s server scheme |
| `src/facilitator.ts` | `@x402/cardano`'s facilitator scheme extended with F1–F3 |
| `src/client.ts` | a `ClientCardanoSigner` that takes offers and falls back to the reference signer |

Done means, on preprod, with `@x402/core`'s own HTTP server and `@x402/fetch`:

1. A buyer whose wallet is one UTxO of tUSDM and its min-ada pays several requests in a row. Its
   ADA is unchanged at the end, to the lovelace.
2. The seller's net ADA change equals minus the sum of the fees, reconciled across `payTo` and the
   sponsor address.
3. A plain `@x402/cardano` client pays the same 402 the plain way, and the offer goes unused.
4. Two sponsored buyers pay at the same time.
5. Build-only negatives, never submitted: a transaction breaking each of S2–S7 is refused by the
   seller, and a settlement without the witness is refused by the facilitator.

Chain-free tests cover the rules, the offer and binding store, the paid-request offer lookup and
the witness merge.

## 15. Open questions

- `extra` or `extensions`? The offer is per accept and per network, which suits `extra`; x402's EVM
  gas-sponsoring extensions live in `extensions`, and the Cardano spec reserves `extra` for
  payment semantics. An upstream version would have to settle this with the maintainers.
- Should the seller be able to recoup the fee in the payment asset (an extra output to itself)?
  Pricing it in is simpler; left out.
- Offer sizing for `payTo` addresses of different lengths: computed from the actual `payTo` and
  asset at pool setup rather than assumed.
