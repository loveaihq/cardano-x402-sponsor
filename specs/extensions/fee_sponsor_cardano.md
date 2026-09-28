# Extension: `feeSponsor` (seller-sponsored fees for `exact` on Cardano)

> **Draft for discussion, not yet proposed upstream.** A reference implementation,
> [loveaihq/cardano-x402-sponsor](https://github.com/loveaihq/cardano-x402-sponsor), passed on
> Cardano preprod with `@x402/core` 2.27 and `@x402/cardano` 2.27, unmodified. Nothing has run on
> mainnet, and nothing has been audited.

## Summary

The `feeSponsor` extension lets a **resource server** pay the network fee and the min-ada of an
[`exact` payment on Cardano](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md), so that a client holding
only a stablecoin can pay.

On Cardano's `exact` scheme the client builds and signs the whole transaction. It pays the fee
(about 0.17 ADA), and it funds the min-ada of the output that pays `payTo` (about 1.17 ADA for a
USDM or USDCx output). A client whose wallet holds only a stablecoin cannot pay until it buys ADA.
The scheme says fee sponsorship "is left to a future extension" and requires
`areFeesSponsored: false`.

With this extension:

- The **resource server** (the seller) offers one of its own ADA-only UTxOs in the `402`.
- The **client** builds the payment transaction with that UTxO as a second input. The sponsor's
  ADA pays the fee and the min-ada of the `payTo` output, and that output is the seller's own.
  The client's own ADA only passes through to its change, and the client signs its own inputs.
- The **resource server** checks the transaction and signs for its UTxO before the protected
  handler runs.
- The **facilitator**, which still holds no keys, merges the seller's witness at settlement.

The offer travels in the `402` the client already receives, so no extra round trip is needed, and
x402's single paid retry is kept. A client that ignores the offer pays the plain way, and the
payment completes as it does today. The seller's net cost per payment is the network fee: the rest
of the sponsor's ADA lands in its own `payTo` output.

| Per payment | Plain `exact` | With `feeSponsor` |
|---|---|---|
| The client gives up | price + ~1.17 ADA min-ada + ~0.17 ADA fee | the price |
| ADA the client must hold | fee + min-ada, spare | none beyond what came with its tokens |
| The seller's net cost | none | the network fee |

---

## Facilitator capability

A facilitator that can complete a sponsored transaction advertises `acceptsSponsorWitnesses:
true` in the `extra` of its `/supported` kind for `exact` on a Cardano network, next to what
`@x402/cardano` already advertises there:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "cardano:preprod",
  "extra": {
    "assetTransferMethods": ["default", "masumi", "script"],
    "areFeesSponsored": false,
    "l1Confirmations": { "minimum": 0, "maximum": 20 },
    "acceptsSponsorWitnesses": true
  }
}
```

`areFeesSponsored` stays `false` there: the facilitator itself pays nothing. A resource server
MUST NOT make an offer through a facilitator that does not advertise `acceptsSponsorWitnesses`.
Such a facilitator would broadcast the transaction without the seller's witness, and the ledger
would reject it after the protected handler had already run.

---

## PaymentRequired: the offer

A resource server MAY add an offer to an accept that uses the `default` asset transfer method and
whose `asset` is a native asset. It MUST NOT add one to an accept priced in lovelace: the
sponsor's ADA in the `payTo` output would count towards the price. `masumi` and `script` are out
of scope for this draft.

An accept that carries an offer sets `extra.areFeesSponsored` to `true`:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/report", "mimeType": "application/json" },
  "accepts": [
    {
      "scheme": "exact",
      "network": "cardano:preprod",
      "amount": "1000000",
      "asset": "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d",
      "payTo": "addr_test1qrxchm0g4la6hqfd9wq6vuuldx7l20az52t7lvgpgujr8pvwmpzru5kuf4mpmvtaf0hlsjtz7t4r2h7tj9v3c02dhljq0wqkef",
      "maxTimeoutSeconds": 300,
      "extra": {
        "assetTransferMethod": "default",
        "areFeesSponsored": true,
        "feeSponsor": {
          "input": "f58285a937208bb195f1b85650d5a9426b0801a503510e291e8a8b99d22b0a04#3",
          "address": "addr_test1qpvgra3sn7ktn2xs330altfrytnca2dejn4xw29wk0eqdtrmmekuzls3wf2s7wk90tjxqsc4z7lgx0c5hy84szqu742shv57rj",
          "lovelace": "1500000",
          "maxFee": "300000",
          "expiresAt": "1790513000000"
        }
      }
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `input` | string | the sponsor UTxO, lowercase `txHash#index`. It MUST be ADA-only, at a key-credential address |
| `address` | string | its bech32 address, on the accept's network |
| `lovelace` | string (integer) | its exact value in lovelace |
| `maxFee` | string (integer) | the largest network fee the sponsor pays. `0 < maxFee < lovelace` |
| `expiresAt` | string (integer) | POSIX milliseconds. The transaction's validity upper bound MUST NOT be later |

An offer is a claim by the resource server, not a fact about the chain. The client MUST check it
against the chain before building with it (rule C6 below).

An offer SHOULD run for the accept's `maxTimeoutSeconds`. A shorter one can expire while a
submitted transaction waits for a block: preprod has shown 172 seconds between two blocks.

---

## The transaction the client builds

```
inputs:   the client's UTxO(s) holding at least `amount` of the asset   (one of them is the nonce)
          the sponsor UTxO                                                (feeSponsor.input)
outputs:  the client's change: every remaining token, and all of the client's input lovelace
          payTo: `amount` of the asset + (feeSponsor.lovelace − fee) lovelace
fee:      out of the sponsor's lovelace, at most `maxFee`
validity: upper bound at most min(now + maxTimeoutSeconds, expiresAt)
```

The fee MUST cover the ledger's minimum for the transaction's size with both witnesses, the
client's and the sponsor's. The client signs its own inputs only.

### Client rules

- **C1** `feeSponsor.address` is a key-credential address on the payment's network.
- **C2** `expiresAt` is in the future, with a few seconds to spare.
- **C3** The client's inputs SHOULD hold only ADA and the payment asset, where the wallet has such
  UTxOs, so that no other token is moved.
- **C4** The client adds no ADA-only input of its own, and no output besides the two above.
- **C5** If the build fails (the change under its min-ada, a fee over `maxFee`), the client pays
  the plain way if it can, and otherwise fails.
- **C6** Before building, the client reads `feeSponsor.input` from the chain. It MUST NOT build
  with the offer unless the chain holds an unspent, ADA-only UTxO there, at exactly
  `feeSponsor.address`, with exactly `feeSponsor.lovelace`, and **not at the client's own payment
  key**. It builds with the UTxO the chain returned.

C6 is not a formality. The offer's address never enters the transaction body: the ledger asks for
the witness of the UTxO's real owner. If the offered input were one of the client's own UTxOs,
the body would balance, the client's own signature would authorize the input, and its ADA would
go to `payTo` as a sponsor's would. The reference implementation's first milestone lacked C6. It
was found and fixed after milestone 1, and the fix is covered by its tests.

---

## PaymentPayload

The client's `PaymentPayload.payload` is unchanged from `exact`: `{ transaction, nonce }`. The
transaction carries the client's witness only. The nonce is one of the client's inputs, so the
facilitator resolves the payer as it does today.

---

## Verification Logic

### Facilitator

The facilitator runs the `exact` verification rules. Inputs are not restricted to the payer's,
and signatures are checked for the witnesses present. In addition:

- **F1** For a transaction that spends an input the facilitator cannot see a witness for, and
  whose accept carries a `feeSponsor` naming that input, the fee floor is computed for the size
  with one more vkey witness (101 bytes). The facilitator MAY also check S3–S9 below, as the
  reference implementation does.

### Resource server, before the protected handler

The resource server signs only after its own checks. Its witness authorizes every input at the
sponsor's key, and value is conserved across the whole transaction, so the rules bound where the
sponsor's ADA can go:

- **S1** The transaction spends `feeSponsor.input`. The offer is one the server made, it has not
  expired, and it is bound to no other transaction.
- **S2** No other input is at the sponsor's payment key. Every input's owner is looked up on the
  chain, so a UTxO sent to the sponsor's address after the pool last read it cannot slip in.
- **S3** No collateral inputs, no collateral return, no redeemers, and no scripts in the witness
  set.
- **S4** The lovelace to `payTo`, plus the fee, is at least `feeSponsor.lovelace`. With value
  conservation, outputs to anyone else carry at most what the other inputs brought, so the client
  cannot take the sponsor's ADA.
- **S5** The fee is at most `maxFee`.
- **S6** No minting, withdrawals, certificates, proposals, votes, donation or treasury value. A
  deposit could otherwise route the sponsor's ADA to a credential the client controls.
- **S7** A validity upper bound is set, no later than `expiresAt`.
- **S8** An output pays at least `amount` of the asset to `payTo`.
- **S9** The fee covers the ledger's minimum with the server's witness merged in.

A failure aborts the request before the handler runs, and the client gets a fresh `402`. On
success the server binds the offer to the transaction's id and keeps its witness until
settlement.

### Offers and binding

- Offers are soft: serving one locks nothing, so requesting `402`s without paying cannot drain the
  pool.
- Binding is exclusive. The server signs at most one transaction per sponsor UTxO. When two
  clients build on the same offer, the second is aborted and gets a fresh `402`.
- A paid request that echoes an offer the server made, and that has not expired, gets that same
  offer back in the `402` it is matched against, byte for byte. Otherwise matching the accept
  would fail.
- A binding is released when the payment is cancelled, or its settlement definitively fails.
  After an ambiguous submission it holds until the validity bound has passed and the chain shows
  the UTxO still unspent. A settled payment retires the UTxO.

---

## Settlement Logic

At settlement the resource server adds the seller's witness to the settlement payload under
`sponsorWitnesses`, a CBOR-encoded transaction witness set in hex. It uses an additive hook, so
the client's keys are never overwritten:

```json
{
  "transaction": "hKQA2QECgoJYI…",
  "nonce": "200d0c9223929cd3b481e89d0821dbb3814a9d1a8fcb70a68377a88368c164c3#1",
  "sponsorWitnesses": "a100d9010281825820…"
}
```

`transaction` stays base64, as in `exact`. `sponsorWitnesses` is hex because the reference
implementation has it so; one encoding for both is for the maintainers to choose.

- **F2** The facilitator merges `sponsorWitnesses` into the transaction's witness set, keeping the
  body's bytes and so the transaction's id. It then verifies, broadcasts and reports as in
  `exact`. Duplicate-settlement mitigation keys on the transaction id, which the merge does not
  change.
- **F3** A transaction that spends an offered input without the seller's witness MUST NOT be
  broadcast: the ledger would reject it.

---

## Compatibility

| Client | Resource server | Facilitator | Result |
|---|---|---|---|
| uses offers | offers | `acceptsSponsorWitnesses` | sponsored |
| ignores offers | offers | `acceptsSponsorWitnesses` | a plain `exact` payment; the offer goes unused |
| uses offers | no offer | any | a plain `exact` payment |
| any | would offer | without the capability | no offer is made |

A client that ignores `feeSponsor` echoes the accept as served, so it still matches.

---

## Security Considerations

- **The client's side.** C6. Without it, a resource server could name one of the client's own
  UTxOs as the sponsor's, and the client's own signature would pay that UTxO's ADA to `payTo`.
- **The seller's side.** S1–S9 bound the sponsor's ADA to the fee and the seller's own `payTo`.
  The sponsor key SHOULD be a separate hot key holding only the pool, not the `payTo` key. A leak
  then loses the pool and nothing else.
- **The seller's witness** stays with the resource server until settlement. The client never sees
  it. A cancelled payment's transaction cannot land without it.
- **Replay** is unchanged: the nonce is the client's input, and settlement is keyed by the
  transaction id.
- **Facilitator trust** is unchanged. The facilitator can only submit the one transaction the
  seller signed, which pays the seller.

---

## Placement: `extra` or `extensions`

This draft puts the offer in the accept's `extra`, as the reference implementation does. The
offer is per accept and per network, `areFeesSponsored` already lives in `extra`, and a resource
server can make or withhold an offer per accept.

The scheme, explaining why `assetTransferMethod` is not an extension, calls extensions "ignorable
by construction". `feeSponsor` is ignorable in that sense: a client that ignores it still pays
correctly. x402's EVM
gas-sponsoring extensions (`erc20ApprovalGasSponsoring`, `eip2612GasSponsoring`) live in
`extensions`. Moving the offer there would change its wire location, but not its rules. This is
for the maintainers to decide.

---

## Related

- [subbit-x402](https://github.com/loveaihq/subbit-x402)'s `SPONSORSHIP.md` uses the same offer for
  `batch-settlement` channel openings, top-ups and refunds on Cardano, where the sponsor's ADA also
  becomes the channel's reserve. It was run on preprod, including a buyer holding only tUSDM.
- CIP-118 nested transactions (Dijkstra hard fork, expected December 2026 to March 2027) may later
  offer another construction. The offer and the rules above would carry over.

## Reference implementation and results

- Code: `src/offer.ts` (the offer and C6), `src/rules.ts` (S1–S9), `src/pool.ts` (offers and
  binding), `src/server.ts`, `src/facilitator.ts` (F1–F3), `src/client.ts`, in
  loveaihq/cardano-x402-sponsor. 41 chain-free tests.
- Preprod, 2026-09-27: six sponsored payments from two clients holding only tUSDM and its min-ada.
  Their ADA was unchanged to the lovelace. Each transaction was 529 bytes with a fee of 178,657
  lovelace, exactly the ledger's floor. The seller's net ADA was minus the fees. A plain
  `@x402/cardano` client paid the same `402` the plain way. Nine crafted transactions were refused,
  and none landed. See that repository's RESULTS.md.
