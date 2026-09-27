// The facilitator on offline transactions, with @x402/cardano's own verification underneath: the
// capability, F1 (fee sized for the missing witness), F2 (merge) and F3 (no broadcast without it).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ERR_INVALID_SIGNATURE, type CardanoUtxoSnapshot, type FacilitatorCardanoSigner } from "@x402/cardano";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ERR_SPONSOR_REFUSED, ERR_SPONSOR_WITNESS_INVALID, ERR_SPONSOR_WITNESS_MISSING, SponsoredExactCardanoFacilitator, witnessKeyHashes } from "../src/facilitator.ts";
import { txIdOf } from "../src/rules.ts";
import { AMOUNT, ASSET, BUYER_LOVELACE, NETWORK, SPONSOR_LOVELACE, buyer, offer as offerOf, out, refOf, seller, slotAt, sponsor, sponsoredTx, stranger, tokens, witnesses } from "./fixtures.ts";

const TOKENS_IN = 20_000_000n;

function chain() {
  const submitted: string[] = [];
  const signer: FacilitatorCardanoSigner = {
    getAddresses: () => [],
    async getUtxo(ref: string): Promise<CardanoUtxoSnapshot> {
      if (ref === refOf(0xb0, 1)) return { exists: true, address: buyer.bech32, paymentKeyHash: buyer.keyHash, coin: BUYER_LOVELACE, assets: { [ASSET]: TOKENS_IN } };
      if (ref === refOf(0xa0, 3)) return { exists: true, address: sponsor.bech32, paymentKeyHash: sponsor.keyHash, coin: SPONSOR_LOVELACE, assets: {} };
      return { exists: false };
    },
    async getCurrentSlot() {
      return slotAt(Date.now());
    },
    async submitTransaction(b64: string) {
      const hex = Buffer.from(b64, "base64").toString("hex");
      submitted.push(hex);
      return { txHash: txIdOf(hex), status: "confirmed" };
    },
    async getProtocolParameters() {
      return { coinsPerUtxoByte: 4310n, minFeeCoefficient: 44n, minFeeConstant: 155_381n };
    },
  };
  return { signer, submitted };
}

const o = offerOf();
const requirements: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: ASSET,
  amount: AMOUNT.toString(),
  payTo: seller.bech32,
  maxTimeoutSeconds: 300,
  // No evidence hook in this stand-in chain, so settle at inclusion.
  extra: { confirmationPolicy: { l1Confirmations: 0 }, areFeesSponsored: true, feeSponsor: o },
};

const payload = (hex: string, extra: Record<string, unknown> = {}): PaymentPayload =>
  ({ x402Version: 2, accepted: requirements, payload: { transaction: Buffer.from(hex, "hex").toString("base64"), nonce: refOf(0xb0, 1), ...extra } }) as PaymentPayload;

test("it advertises that it merges seller witnesses, and still pays no fees itself", () => {
  const f = new SponsoredExactCardanoFacilitator(chain().signer);
  const extra = f.getExtra(NETWORK)!;
  assert.equal(extra.acceptsSponsorWitnesses, true);
  assert.equal(extra.areFeesSponsored, false);
});

test("verify accepts the buyer-signed sponsored transaction", async () => {
  const f = new SponsoredExactCardanoFacilitator(chain().signer);
  const r = await f.verify(payload(sponsoredTx(o)), requirements);
  assert.deepEqual(r, { isValid: true, payer: buyer.bech32 });
});

test("F1: a fee sized for the buyer's witness alone passes @x402/cardano's check but not this one", async () => {
  const short = sponsoredTx(o, (p) => ({ ...p, fee: p.fee - 44n * 101n, outputs: [p.outputs[0]!, out(seller, tokens(AMOUNT, BigInt(o.lovelace) - p.fee + 44n * 101n))] }));
  const f = new SponsoredExactCardanoFacilitator(chain().signer);
  const r = await f.verify(payload(short), requirements);
  assert.equal(r.isValid, false);
  assert.equal(r.invalidReason, ERR_SPONSOR_REFUSED);
  assert.match(r.invalidMessage ?? "", /^S9/);
});

test("F3: settlement without the seller's witness is refused and nothing is broadcast", async () => {
  const c = chain();
  const f = new SponsoredExactCardanoFacilitator(c.signer);
  const r = await f.settle(payload(sponsoredTx(o)), requirements);
  assert.equal(r.success, false);
  assert.equal(r.errorReason, ERR_SPONSOR_WITNESS_MISSING);
  assert.equal(c.submitted.length, 0);
});

test("F2: with the seller's witness it merges, verifies and broadcasts the same transaction id", async () => {
  const c = chain();
  const f = new SponsoredExactCardanoFacilitator(c.signer);
  const hex = sponsoredTx(o);
  const r = await f.settle(payload(hex, { sponsorWitnesses: witnesses(hex, sponsor) }), requirements);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.transaction, txIdOf(hex));
  assert.equal(c.submitted.length, 1);
  assert.deepEqual(new Set(witnessKeyHashes(c.submitted[0]!)), new Set([buyer.keyHash, sponsor.keyHash]));
});

test("witnesses for any other key, or a bad signature, are refused", async () => {
  const c = chain();
  const f = new SponsoredExactCardanoFacilitator(c.signer);
  const hex = sponsoredTx(o);
  const wrongKey = await f.settle(payload(hex, { sponsorWitnesses: witnesses(hex, stranger) }), requirements);
  assert.equal(wrongKey.errorReason, ERR_SPONSOR_WITNESS_INVALID);
  const otherBody = sponsoredTx(o, (p) => ({ ...p, ttl: slotAt(Number(o.expiresAt) - 40_000) }));
  const badSig = await f.settle(payload(hex, { sponsorWitnesses: witnesses(otherBody, sponsor) }), requirements);
  assert.equal(badSig.success, false);
  assert.equal(badSig.errorReason, ERR_INVALID_SIGNATURE);
  assert.equal(c.submitted.length, 0);
});

test("a buyer who ignores the offer and pays its own fee settles as usual, with no witness asked for", async () => {
  const c = chain();
  const RICH = 5_000_000n;
  c.signer.getUtxo = async (ref: string): Promise<CardanoUtxoSnapshot> =>
    ref === refOf(0xb0, 1) ? { exists: true, address: buyer.bech32, paymentKeyHash: buyer.keyHash, coin: RICH, assets: { [ASSET]: TOKENS_IN } } : { exists: false };
  // Spends only its own input; its lovelace funds the fee and payTo's min-ada.
  const plain = sponsoredTx(o, (p) => ({
    ...p,
    inputs: [p.inputs[0]!],
    outputs: [out(buyer, tokens(TOKENS_IN - AMOUNT, RICH - 1_300_000n - p.fee)), out(seller, tokens(AMOUNT, 1_300_000n))],
  }));
  const f = new SponsoredExactCardanoFacilitator(c.signer);
  assert.deepEqual(await f.verify(payload(plain), requirements), { isValid: true, payer: buyer.bech32 });
  const r = await f.settle(payload(plain), requirements);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(witnessKeyHashes(c.submitted[0]!), [buyer.keyHash]);
});
