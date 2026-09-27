// S1–S9 on offline transactions, and the offer checks.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Assets, KeyHash, TransactionHash, TransactionInput } from "@evolution-sdk/evolution";
import { slotToPosixMs } from "@x402/cardano";
import { offerIn, offerKeyHash, offerProblem } from "../src/offer.ts";
import { checkSponsoredTx, feeFloor, sizeWith, spendsOffer, txIdOf, type OwnerLookup, type SponsoredCheck } from "../src/rules.ts";
import { AMOUNT, ASSET, BUYER_LOVELACE, FEES, NETWORK, buyer, input, offer, out, refOf, seller, slotAt, sponsor, sponsoredTx, stranger, tokens } from "./fixtures.ts";

const owners: OwnerLookup = async (ref) => {
  if (ref === refOf(0xb0, 1)) return { exists: true, paymentKeyHash: buyer.keyHash };
  if (ref === refOf(0xc0, 0)) return { exists: true, paymentKeyHash: sponsor.keyHash };
  if (ref === refOf(0xd0, 0)) return { exists: true, paymentKeyHash: stranger.keyHash };
  return { exists: false };
};

function check(txHex: string, over: Partial<SponsoredCheck> = {}): Promise<Awaited<ReturnType<typeof checkSponsoredTx>>> {
  const o = over.offer ?? offer();
  return checkSponsoredTx({
    txHex,
    offer: o,
    network: NETWORK,
    payTo: seller.bech32,
    asset: ASSET,
    amount: AMOUNT,
    sponsorKeyHash: sponsor.keyHash,
    ownerOf: owners,
    fees: FEES,
    missingWitnesses: 1,
    ...over,
  });
}

async function refused(txHex: string, rule: string, over: Partial<SponsoredCheck> = {}) {
  const r = await check(txHex, over);
  assert.equal(r.ok, false, `expected ${rule} to refuse`);
  if (!r.ok) assert.equal(r.rule, rule, r.detail);
}

test("the fixture's slots map back to wall-clock time", () => {
  const ms = 1_790_000_000_000;
  assert.equal(slotToPosixMs(NETWORK, slotAt(ms)), ms);
});

test("a sponsored payment passes, and payTo gets the sponsor's lovelace less the fee", async () => {
  const o = offer();
  const hex = sponsoredTx(o);
  assert.ok(spendsOffer(hex, o));
  const r = await check(hex, { offer: o });
  assert.ok(r.ok, r.ok ? "" : `${r.rule}: ${r.detail}`);
  if (r.ok) {
    assert.equal(r.toPayTo + r.fee, BigInt(o.lovelace));
    assert.equal(r.txHash, txIdOf(hex));
  }
});

test("adding one vkey witness grows a signed transaction by 101 bytes", () => {
  const hex = sponsoredTx(offer());
  assert.equal(sizeWith(hex, 1) - hex.length / 2, 101);
  assert.equal(sizeWith(hex, 0), hex.length / 2);
});

test("S1: a transaction that does not spend the offer", async () => {
  const hex = sponsoredTx(offer({ input: refOf(0xa1, 0) }));
  await refused(hex, "S1");
});

test("S2: another input at the sponsor's key is refused, and so is an input that cannot be resolved", async () => {
  const o = offer();
  await refused(sponsoredTx(o, (p) => ({ ...p, inputs: [...p.inputs, input(0xc0, 0)] })), "S2", { offer: o });
  await refused(sponsoredTx(o, (p) => ({ ...p, inputs: [...p.inputs, input(0xe0, 0)] })), "S2", { offer: o });
  const lookupFails: OwnerLookup = async () => {
    throw new Error("provider down");
  };
  await refused(sponsoredTx(o), "S2", { offer: o, ownerOf: lookupFails });
  // A stranger's input is fine: it only brings value (balancing is the ledger's check, not S2's).
  const withStranger = await check(sponsoredTx(o, (p) => ({ ...p, inputs: [...p.inputs, input(0xd0, 0)] })), { offer: o });
  assert.ok(withStranger.ok, withStranger.ok ? "" : `${withStranger.rule}: ${withStranger.detail}`);
});

test("S3: collateral is refused", async () => {
  const o = offer();
  await refused(sponsoredTx(o, (p) => ({ ...p, extra: { collateralInputs: [input(0xb0, 2)] } })), "S3", { offer: o });
  await refused(sponsoredTx(o, (p) => ({ ...p, extra: { totalCollateral: 500_000n } })), "S3", { offer: o });
});

test("S4: sponsor lovelace diverted to the buyer's change is refused", async () => {
  const o = offer();
  const diverted = sponsoredTx(o, (p) => ({
    ...p,
    outputs: [out(buyer, tokens(19_000_000n, BUYER_LOVELACE + 100_000n)), out(seller, tokens(AMOUNT, BigInt(o.lovelace) - p.fee - 100_000n))],
  }));
  await refused(diverted, "S4", { offer: o });
});

test("S5: a fee above maxFee is refused", async () => {
  const o = offer({ maxFee: "150000" });
  await refused(sponsoredTx(o), "S5", { offer: o });
});

test("S6: a certificate is refused (its deposit could route the sponsor's ADA to the buyer)", async () => {
  const o = offer();
  const kh = KeyHash.fromHex(stranger.keyHash);
  const { Certificate } = await import("@evolution-sdk/evolution");
  const reg = new Certificate.StakeRegistration({ stakeCredential: kh });
  await refused(sponsoredTx(o, (p) => ({ ...p, extra: { certificates: [reg] } })), "S6", { offer: o });
});

test("S7: no validity bound, or one past the offer, is refused", async () => {
  const o = offer();
  await refused(sponsoredTx(o, (p) => ({ ...p, ttl: undefined })), "S7", { offer: o });
  await refused(sponsoredTx(o, (p) => ({ ...p, ttl: slotAt(Number(o.expiresAt) + 60_000) })), "S7", { offer: o });
});

test("S8: paying less than the price, or a lovelace price, is refused", async () => {
  const o = offer();
  const short = sponsoredTx(o, (p) => ({
    ...p,
    outputs: [out(buyer, tokens(19_000_001n, BUYER_LOVELACE)), out(seller, tokens(AMOUNT - 1n, BigInt(o.lovelace) - p.fee))],
  }));
  await refused(short, "S8", { offer: o });
  await refused(sponsoredTx(o), "S8", { offer: o, asset: "lovelace" });
});

test("S9: a fee that covers the buyer's witness only is refused while the seller's is missing", async () => {
  const o = offer();
  // Fee sized for one witness: enough once, short by 101 bytes' worth when the seller signs.
  const oneWitness = sponsoredTx(o, (p) => ({ ...p, fee: p.fee - 44n * 101n, outputs: [p.outputs[0]!, out(seller, tokens(AMOUNT, BigInt(o.lovelace) - p.fee + 44n * 101n))] }));
  await refused(oneWitness, "S9", { offer: o });
  const r = await check(oneWitness, { offer: o, missingWitnesses: 0 });
  assert.ok(r.ok, r.ok ? "" : `${r.rule}: ${r.detail}`);
});

test("the floor is minFeeA × size + minFeeB", () => {
  assert.equal(feeFloor(1089, FEES), 203_297n);
});

test("offers: parsing and problems", () => {
  const o = offer();
  assert.equal(offerIn(undefined), undefined);
  assert.equal(offerIn({}), undefined);
  assert.deepEqual(offerIn({ feeSponsor: o }), o);
  assert.throws(() => offerIn({ feeSponsor: "x" }));
  assert.throws(() => offerIn({ feeSponsor: { ...o, lovelace: 1 } }));
  assert.throws(() => offerIn({ feeSponsor: { ...o, extra: "field" } }));
  const now = Date.now();
  assert.equal(offerProblem(o, NETWORK, now), undefined);
  assert.equal(offerKeyHash(o, NETWORK), sponsor.keyHash);
  assert.match(offerProblem({ ...o, input: o.input.toUpperCase() }, NETWORK, now)!, /lowercase/);
  assert.match(offerProblem(o, "cardano:mainnet", now)!, /another network/);
  assert.match(offerProblem({ ...o, maxFee: o.lovelace }, NETWORK, now)!, /maxFee/);
  assert.match(offerProblem({ ...o, expiresAt: String(now + 1_000) }, NETWORK, now)!, /expired/);
  assert.match(offerProblem({ ...o, lovelace: "01" }, NETWORK, now)!, /canonical/);
});

test("an input reference is lowercase txHash#index both ways", () => {
  const i = new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex("ab".repeat(32)), index: 7n });
  assert.equal(`${TransactionHash.toHex(i.transactionId)}#${Number(i.index)}`, `${"ab".repeat(32)}#7`);
  assert.equal(Assets.lovelaceOf(tokens(1n, 2n)), 2n);
});
