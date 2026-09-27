# cardano-x402-sponsor

Seller-sponsored network fees for x402's `exact` scheme on Cardano: a buyer that holds only a
stablecoin (USDM, USDCx) can pay, and the seller's only cost is the network fee.

Today a Cardano `exact` payment needs spare ADA from the buyer: the fee, about 0.17 ADA, and the
min-ada of the output that pays the seller, about 1.18 ADA, which the seller keeps. The
[spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md)
says fee sponsorship "is not supported by this scheme version" and leaves it "to a future
extension". This is one, built on `@x402/cardano` 2.27.0 without changing it.

**How.** The 402 offers one of the seller's ADA-only UTxOs. The buyer's transaction spends it
next to the buyer's token UTxO. The sponsor's ADA pays the fee and the min-ada of the payment
output, and that output is the seller's own address. The buyer's own ADA only passes through to
its change. The seller checks the transaction and signs for its UTxO before the handler runs. The
facilitator, which still holds no keys, merges the seller's witness at settlement.

**Status: a prototype, preprod only.** Milestone 1 of [DESIGN.md](DESIGN.md) passed on preprod on
2026-09-27; every transaction and figure is in [RESULTS.md](RESULTS.md). Nothing has run on
mainnet, and nothing here has been audited.

## What it showed

- Two buyers holding one UTxO each, 20 tUSDM plus its exact min-ada (1.176630 tADA), made 6
  sponsored payments, 2 of them at the same moment. Both ended with exactly the ADA they started
  with.
- Each sponsored payment is 529 B with a fee of 0.178657 tADA. Across the seller's two addresses,
  its net ADA on those payments is minus the fees, to the lovelace.
- A plain `@x402/cardano` client paid the same 402 the usual way, and the offer went unused.
- Transactions that try to divert the sponsor's ADA, spend another sponsor UTxO, put up
  collateral, underpay the fee or outlive the offer were all refused, and none landed.

## What is here

| Path | What |
|---|---|
| [`DESIGN.md`](DESIGN.md) | the design: wire format, the flow against `@x402/core` hooks, the seller's checks S1–S9, the facilitator's F1–F3 |
| `src/offer.ts` | the offer in `PaymentRequirements.extra.feeSponsor` and its checks |
| `src/rules.ts` | S1–S9 over a decoded transaction; fee-floor arithmetic |
| `src/pool.ts` | the sponsor key's UTxOs: soft offers, exclusive bindings |
| `src/server.ts` | `SponsoredExactCardanoServer`, a `SchemeNetworkServer` around `@x402/cardano`'s |
| `src/facilitator.ts` | `SponsoredExactCardanoFacilitator`, `@x402/cardano`'s facilitator plus witness merging |
| `src/client.ts` | `toSponsoredClientSigner` and `SponsoredExactCardanoClient` for buyers |
| `spike/` | the preprod runs (`feasibility.ts`, `fund.ts`, `e2e.ts`) and two read-only helpers (`inspect.ts`, `cborsize.ts`) |
| `test/` | 39 chain-free tests on real-signed offline transactions |

## Running it

```bash
npm install
npm test
npm run typecheck
```

The preprod runs need `BLOCKFROST_PROJECT_ID` and `WALLET_MNEMONIC` in the environment. They use
the public "abandon … art" test mnemonic: accounts 0 and 3 fund the others, 1 is the seller, 5
and 7 the buyers, 6 the sponsor key.

```bash
npm run fund -- buyers
npm run fund -- sponsor
npm run e2e -- sponsored 3
npm run e2e -- plain
npm run e2e -- concurrent
npm run e2e -- negatives
npm run e2e -- report
```

## Limits

- Only the `default` transfer method and native-asset prices are sponsored.
- The resource server holds the sponsor key, a separate hot key whose UTxOs are the pool.
- `@x402/fetch` retries a failed payment with the first 402, so a buyer whose offer was taken asks
  again to get a fresh one.
- The pool and its bindings live in memory, for one server process.
- Channel openings for `batch-settlement` ([subbit-x402](https://github.com/loveaihq/subbit-x402))
  are the next step, sketched in DESIGN.md section 13.

## License

Apache-2.0.
