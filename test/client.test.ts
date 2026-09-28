// The buyer's side: the client scheme's hook, which gives a payment that did not settle its inputs
// back, and C6, the signer reading the offered UTxO itself before it builds with it.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Address, Assets, PlutusV3, TransactionHash, UTxO } from "@evolution-sdk/evolution";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { SponsoredExactCardanoClient, toSponsoredClientSigner, type BuyerWallet, type SponsoredClientSigner } from "../src/client.ts";
import { offerOnChainProblem, type FeeSponsorOffer } from "../src/offer.ts";
import { AMOUNT, ASSET, BUYER_LOVELACE, NETWORK, SPONSOR_LOVELACE, buyer, offer, seller, sponsor, sponsoredTx, stranger, tokens, utxo, type Party } from "./fixtures.ts";

function fakeSigner() {
  const released: string[] = [];
  const signer: SponsoredClientSigner = {
    getAddress: () => "addr_test1",
    buildAndSignPaymentTransaction: async () => ({ transaction: "", nonce: "" }),
    last: () => undefined,
    release: (hex) => void released.push(hex),
  };
  return { signer, released };
}

const ctx = (hex: string, success?: boolean) =>
  ({
    paymentPayload: { x402Version: 2, accepted: {} as PaymentRequirements, payload: { transaction: Buffer.from(hex, "hex").toString("base64"), nonce: "" } } as PaymentPayload,
    requirements: {} as PaymentRequirements,
    ...(success === undefined ? {} : { settleResponse: { success, transaction: "", network: "cardano:preprod" } }),
  }) as never;

test("a settled payment keeps its inputs spent; a refused one releases them", async () => {
  const { signer, released } = fakeSigner();
  const scheme = new SponsoredExactCardanoClient(signer);
  const hex = sponsoredTx(offer());
  await scheme.schemeHooks.onPaymentResponse!(ctx(hex, true));
  assert.deepEqual(released, []);
  await scheme.schemeHooks.onPaymentResponse!(ctx(hex));
  await scheme.schemeHooks.onPaymentResponse!(ctx(hex, false));
  assert.deepEqual(released, [hex, hex]);
  assert.equal(scheme.scheme, "exact");
});

// ---- C6: the buyer reads the offered UTxO itself ----

const atOffer = (o: FeeSponsorOffer, owner: Party, assets: Assets.Assets, extra: { scriptRef?: PlutusV3.PlutusV3 } = {}) => {
  const [h, i] = o.input.split("#") as [string, string];
  return new UTxO.UTxO({ transactionId: TransactionHash.fromHex(h), index: BigInt(i), address: owner.address, assets, ...extra });
};

test("C6: an offer is built with only as the chain holds it, and never when it names the buyer's own UTxO", () => {
  const o = offer();
  assert.equal(offerOnChainProblem(o, atOffer(o, sponsor, Assets.fromLovelace(SPONSOR_LOVELACE)), buyer.keyHash), undefined);
  // The buyer's own UTxO under the sponsor's address: its body would balance, and the buyer's one
  // witness would spend it (RESULTS.md section 8).
  assert.equal(offerOnChainProblem(o, atOffer(o, buyer, Assets.fromLovelace(SPONSOR_LOVELACE)), buyer.keyHash), "the offered UTxO is this wallet's own");
  const staked: Party = { ...buyer, address: new Address.Address({ networkId: 0, paymentCredential: buyer.address.paymentCredential, stakingCredential: stranger.address.paymentCredential }) };
  assert.equal(offerOnChainProblem({ ...o, address: Address.toBech32(staked.address) }, atOffer(o, staked, Assets.fromLovelace(SPONSOR_LOVELACE)), buyer.keyHash), "the offered UTxO is this wallet's own");
  const cases: Array<[UTxO.UTxO | undefined, RegExp]> = [
    [undefined, /not on chain/],
    [atOffer(o, stranger, Assets.fromLovelace(SPONSOR_LOVELACE)), /another address/],
    [atOffer(o, sponsor, tokens(1n, SPONSOR_LOVELACE)), /holds tokens/],
    [atOffer(o, sponsor, Assets.fromLovelace(SPONSOR_LOVELACE + 1n)), /holds 1500001 lovelace, not the 1500000 offered/],
    [atOffer(o, sponsor, Assets.fromLovelace(SPONSOR_LOVELACE), { scriptRef: new PlutusV3.PlutusV3({ bytes: new Uint8Array([0x46, 0x01, 0x00, 0x00, 0x22, 0x22, 0x01]) }) }), /reference script/],
  ];
  for (const [u, why] of cases) assert.match(offerOnChainProblem(o, u, buyer.keyHash) ?? "(none)", why);
});

test("C6: the signer reads the offered UTxO before building, and pays the plain way, or not at all, when it is the buyer's", async () => {
  const o = offer();
  let reads = 0;
  let builds = 0;
  const wallet = (held: UTxO.UTxO | undefined) =>
    ({
      address: async () => buyer.address,
      getWalletUtxos: async () => [utxo(0xb0, 1, buyer, tokens(20_000_000n, BUYER_LOVELACE))],
      getUtxosByOutRef: async () => (reads++, held ? [held] : []),
      newTx: () => {
        builds++;
        throw new Error("not in this test");
      },
    }) as unknown as BuyerWallet;
  const input = { network: NETWORK, payTo: seller.bech32, asset: ASSET, amount: AMOUNT.toString(), maxTimeoutSeconds: 300, extra: { feeSponsor: o } };
  const own = atOffer(o, buyer, Assets.fromLovelace(SPONSOR_LOVELACE));
  await assert.rejects(async () => toSponsoredClientSigner({ wallet: wallet(own), address: buyer.bech32 }).buildAndSignPaymentTransaction(input), /cannot pay without the offer \(the offered UTxO is this wallet's own\)/);
  assert.equal(reads, 1);
  assert.equal(builds, 0);
  let plain = 0;
  const s = toSponsoredClientSigner({
    wallet: wallet(own),
    address: buyer.bech32,
    plain: { getAddress: () => buyer.bech32, buildAndSignPaymentTransaction: async () => (plain++, { transaction: "", nonce: "" }) },
  });
  await s.buildAndSignPaymentTransaction(input);
  assert.equal(plain, 1);
  assert.deepEqual(s.last(), { sponsored: false, reason: "the offered UTxO is this wallet's own" });
  // The sponsor's own UTxO, as offered, goes on to the build.
  await assert.rejects(async () => toSponsoredClientSigner({ wallet: wallet(atOffer(o, sponsor, Assets.fromLovelace(SPONSOR_LOVELACE))), address: buyer.bech32 }).buildAndSignPaymentTransaction(input), /sponsored build failed: not in this test/);
  assert.equal(builds, 1);
});
