// The resource server: offers in the 402, the same offer back to a paid retry, the seller's checks
// and witness after verify, the witness at settlement, and cancellations.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Assets, Transaction, TransactionWitnessSet, UTxO } from "@evolution-sdk/evolution";
import type { PaymentPayload, PaymentRequirements, SettleContext, SupportedKind } from "@x402/core/types";
import { offerIn, type FeeSponsorOffer } from "../src/offer.ts";
import { SponsorPool } from "../src/pool.ts";
import { txIdOf } from "../src/rules.ts";
import { SponsoredExactCardanoServer } from "../src/server.ts";
import { witnessKeyHashes } from "../src/facilitator.ts";
import { AMOUNT, ASSET, BUYER_LOVELACE, NETWORK, buyer, out, refOf, seller, sponsor, sponsoredTx, tokens, utxo, witnesses } from "./fixtures.ts";

const kind = (capable: boolean): SupportedKind => ({
  x402Version: 2,
  scheme: "exact",
  network: NETWORK,
  extra: {
    assetTransferMethods: ["default", "masumi", "script"],
    areFeesSponsored: false,
    l1Confirmations: { minimum: 0, maximum: 20 },
    ...(capable ? { acceptsSponsorWitnesses: true } : {}),
  },
});

const base: PaymentRequirements = { scheme: "exact", network: NETWORK, asset: ASSET, amount: AMOUNT.toString(), payTo: seller.bech32, maxTimeoutSeconds: 300, extra: {} };

function setup(sponsorUtxos = [utxo(0xa0, 3, sponsor, Assets.fromLovelace(1_500_000n)), utxo(0xa0, 4, sponsor, Assets.fromLovelace(1_500_000n))]) {
  const wallet = {
    async address() {
      return sponsor.address;
    },
    async getWalletUtxos() {
      return sponsorUtxos;
    },
    async signTx(txHex: string, _ctx: { utxos: UTxO.UTxO[] }) {
      return TransactionWitnessSet.fromCBORHex(witnesses(txHex, sponsor));
    },
  };
  const pool = new SponsorPool({ wallet });
  const chain = {
    async getUtxo(ref: string) {
      if (ref === refOf(0xb0, 1)) return { exists: true, paymentKeyHash: buyer.keyHash };
      return { exists: false };
    },
    async getProtocolParameters() {
      return { coinsPerUtxoByte: 4310n, minFeeCoefficient: 44n, minFeeConstant: 155_381n };
    },
  };
  const server = new SponsoredExactCardanoServer({ network: NETWORK, pool, chain });
  return { server, pool };
}

const resourceInfo = { url: "http://localhost/data", description: "", mimeType: "" };
async function required(server: SponsoredExactCardanoServer, accepts: PaymentRequirements[], paid?: PaymentPayload): Promise<PaymentRequirements[]> {
  const transportContext = paid ? { request: { paymentHeader: Buffer.from(JSON.stringify(paid)).toString("base64") } } : undefined;
  const ctx = { requirements: accepts, resourceInfo, paymentRequiredResponse: { x402Version: 2, resource: resourceInfo, accepts }, transportContext };
  return (await server.enrichPaymentRequiredResponse(ctx as never)) ?? accepts;
}

function paidWith(accepted: PaymentRequirements, txHex: string): PaymentPayload {
  return { x402Version: 2, accepted, payload: { transaction: Buffer.from(txHex, "hex").toString("base64"), nonce: refOf(0xb0, 1) } } as PaymentPayload;
}

test("with a capable facilitator each 402 carries an offer; without one it stays plain", async () => {
  const { server } = setup();
  const plain = await server.enhancePaymentRequirements(base, kind(false), []);
  assert.equal(plain.extra.areFeesSponsored, false);
  assert.deepEqual(await required(server, [plain]), [plain]);

  const { server: s2 } = setup();
  const enhanced = await s2.enhancePaymentRequirements(base, kind(true), []);
  assert.equal("areFeesSponsored" in enhanced.extra, false, "decided per 402");
  const [a] = await required(s2, [enhanced]);
  assert.equal(a!.extra.areFeesSponsored, true);
  const o = offerIn(a!.extra)!;
  assert.equal(o.address, sponsor.bech32);
  assert.equal(o.lovelace, "1500000");
});

test("a lovelace price, or another transfer method, gets no offer", async () => {
  const { server } = setup();
  const ada = await server.enhancePaymentRequirements({ ...base, asset: "lovelace" }, kind(true), []);
  assert.deepEqual(await required(server, [ada]), [ada]);
  const script = await server.enhancePaymentRequirements({ ...base, extra: { assetTransferMethod: "script", scriptHash: "00".repeat(28) } }, kind(true), []);
  assert.equal(script.extra.areFeesSponsored, false);
  assert.deepEqual(await required(server, [script]), [script]);
});

test("the paid payload is found in the request header when the framework passed no paymentHeader", async () => {
  const { server } = setup();
  const enhanced = await server.enhancePaymentRequirements(base, kind(true), []);
  const [first] = await required(server, [enhanced]);
  const o = offerIn(first!.extra)!;
  const header = Buffer.from(JSON.stringify(paidWith(first!, sponsoredTx(o)))).toString("base64");
  const adapter = { getHeader: (name: string) => (name.toLowerCase() === "payment-signature" ? header : undefined) };
  const ctx = { requirements: [enhanced], resourceInfo, paymentRequiredResponse: { x402Version: 2, resource: resourceInfo, accepts: [enhanced] }, transportContext: { request: { adapter } } };
  const [again] = ((await server.enrichPaymentRequiredResponse(ctx as never)) ?? []) as PaymentRequirements[];
  assert.deepEqual(again, first);
});

test("a paid retry naming a live offer gets that offer back verbatim; an unknown one gets a fresh offer", async () => {
  const { server } = setup();
  const enhanced = await server.enhancePaymentRequirements(base, kind(true), []);
  const [first] = await required(server, [enhanced]);
  const o = offerIn(first!.extra)!;
  const [again] = await required(server, [enhanced], paidWith(first!, sponsoredTx(o)));
  assert.deepEqual(again, first);

  const forged: FeeSponsorOffer = { ...o, expiresAt: String(Number(o.expiresAt) + 1) };
  const [fresh] = await required(server, [enhanced], paidWith({ ...first!, extra: { ...first!.extra, feeSponsor: forged } }, sponsoredTx(forged)));
  assert.notDeepEqual(offerIn(fresh!.extra), forged);
});

async function verified(server: SponsoredExactCardanoServer, accepted: PaymentRequirements, txHex: string) {
  const payload = paidWith(accepted, txHex);
  return server.schemeHooks.onAfterVerify!({ paymentPayload: payload, requirements: accepted, declaredExtensions: {}, result: { isValid: true, payer: buyer.bech32 } } as never);
}

function settleCtx(accepted: PaymentRequirements, txHex: string): SettleContext {
  return { paymentPayload: paidWith(accepted, txHex), requirements: accepted, declaredExtensions: {}, phase: "afterHandler" } as unknown as SettleContext;
}

test("after verify the seller checks, binds and signs; at settlement it hands over one witness for its key", async () => {
  const { server, pool } = setup();
  const [accepted] = await required(server, [await server.enhancePaymentRequirements(base, kind(true), [])]);
  const o = offerIn(accepted!.extra)!;
  const hex = sponsoredTx(o);
  assert.equal(await verified(server, accepted!, hex), undefined);
  assert.equal(pool.size().bound, 1);
  const enrichment = (await server.enrichSettlementPayload(settleCtx(accepted!, hex))) as Record<string, string>;
  const merged = Transaction.addVKeyWitnessesHex(hex, enrichment.sponsorWitnesses!);
  assert.equal(txIdOf(merged), txIdOf(hex));
  assert.deepEqual(new Set(witnessKeyHashes(merged)), new Set([buyer.keyHash, sponsor.keyHash]));
});

test("a second transaction on a bound offer is aborted before the handler runs", async () => {
  const { server } = setup();
  const [accepted] = await required(server, [await server.enhancePaymentRequirements(base, kind(true), [])]);
  const o = offerIn(accepted!.extra)!;
  assert.equal(await verified(server, accepted!, sponsoredTx(o)), undefined);
  const other = sponsoredTx(o, (p) => ({ ...p, outputs: [out(buyer, tokens(18_999_999n, BUYER_LOVELACE)), out(seller, tokens(AMOUNT + 1n, BigInt(o.lovelace) - p.fee))] }));
  const r = await verified(server, accepted!, other);
  assert.deepEqual(r && "abort" in r ? { abort: r.abort, reason: r.reason } : r, { abort: true, reason: "fee_sponsor_taken" });
});

test("a transaction breaking a rule is aborted with the rule's name, and nothing stays bound", async () => {
  const { server, pool } = setup();
  const [accepted] = await required(server, [await server.enhancePaymentRequirements(base, kind(true), [])]);
  const o = offerIn(accepted!.extra)!;
  const diverted = sponsoredTx(o, (p) => ({ ...p, outputs: [out(buyer, tokens(19_000_000n, BUYER_LOVELACE + 1n)), out(seller, tokens(AMOUNT, BigInt(o.lovelace) - p.fee - 1n))] }));
  const r = (await verified(server, accepted!, diverted)) as { abort: boolean; reason: string };
  assert.equal(r.reason, "fee_sponsor_S4");
  assert.equal(pool.size().bound, 0);
});

test("a buyer who ignores the offer pays the plain way: nothing is bound, nothing is added at settlement", async () => {
  const { server, pool } = setup();
  const [accepted] = await required(server, [await server.enhancePaymentRequirements(base, kind(true), [])]);
  const o = offerIn(accepted!.extra)!;
  const plain = sponsoredTx({ ...o, input: refOf(0xb0, 9) });
  assert.equal(await verified(server, accepted!, plain), undefined);
  assert.equal(pool.size().bound, 0);
  assert.equal(await server.enrichSettlementPayload(settleCtx(accepted!, plain)), undefined);
});

test("a cancelled payment releases its binding; a settled one retires the UTxO", async () => {
  const { server, pool } = setup();
  const [accepted] = await required(server, [await server.enhancePaymentRequirements(base, kind(true), [])]);
  const o = offerIn(accepted!.extra)!;
  const hex = sponsoredTx(o);
  assert.equal(await verified(server, accepted!, hex), undefined);
  await server.schemeHooks.onVerifiedPaymentCanceled!({ ...(settleCtx(accepted!, hex)), reason: "handler_failed", settledPhases: [] } as never);
  assert.equal(pool.size().bound, 0);

  assert.equal(await verified(server, accepted!, hex), undefined);
  await server.enrichSettlementPayload(settleCtx(accepted!, hex));
  await server.schemeHooks.onAfterSettle!({ ...(settleCtx(accepted!, hex)), result: { success: true, transaction: txIdOf(hex), network: NETWORK } } as never);
  assert.deepEqual(pool.size(), { utxos: 1, bound: 0 });
});
