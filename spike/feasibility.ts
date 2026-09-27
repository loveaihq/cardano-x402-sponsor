// Build-only feasibility check on preprod, nothing submitted: can the buyer's wallet build the
// sponsored transaction of DESIGN.md section 5 with evolution-sdk, does the fee cover the seller's
// witness, does the seller's signTx add exactly one witness, and does @x402/cardano's own
// facilitator verify accept the buyer-signed and the fully signed transaction?
import {
  Address,
  Assets,
  Client,
  Transaction,
  TransactionWitnessSet,
  UTxO,
  preprod,
} from "@evolution-sdk/evolution";
import { ExactCardanoScheme as ExactFacilitator } from "@x402/cardano/exact/facilitator";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const BF_BASE = "https://cardano-preprod.blockfrost.io/api/v0";
const NETWORK = "cardano:preprod";
const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
const SDK_UNIT = TUSDM.replace(".", "");
const AMOUNT = 1_000_000n; // 1 tUSDM

const must = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const projectId = must("BLOCKFROST_PROJECT_ID");
const mnemonic = must("WALLET_MNEMONIC");
const wallet = (accountIndex: number) =>
  Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId }).withSeed({ mnemonic, accountIndex });

const buyer = wallet(0);
const seller = wallet(1); // payTo
const sponsor = wallet(3); // stands in for the sponsor pool's key in this check
const ada = (l: bigint) => (Number(l) / 1e6).toFixed(6);
const ref = (u: UTxO.UTxO) => UTxO.toOutRefString(u);

async function main() {
  const buyerAddr = await buyer.address();
  const payTo = await seller.address();
  const sponsorAddr = await sponsor.address();
  console.log(`buyer   ${Address.toBech32(buyerAddr)}`);
  console.log(`payTo   ${Address.toBech32(payTo)}`);
  console.log(`sponsor ${Address.toBech32(sponsorAddr)}`);

  const mine = await buyer.getWalletUtxos();
  const holding = mine
    .filter((u) => Assets.getByUnit(u.assets, SDK_UNIT) > 0n)
    .sort((a, b) => Number(Assets.getByUnit(b.assets, SDK_UNIT) - Assets.getByUnit(a.assets, SDK_UNIT)));
  const clean = holding.filter((u) => Assets.getUnits(u.assets).every((x) => x === "lovelace" || x === SDK_UNIT));
  // Account 0's tUSDM sits with tokens strangers sent to the public test address; this check
  // takes them along into the buyer's change when there is no clean UTxO.
  const tokenUtxos = clean.length ? clean : holding;
  if (!tokenUtxos.length) throw new Error("buyer holds no tUSDM");
  const inputs: UTxO.UTxO[] = [];
  let have = 0n;
  for (const u of tokenUtxos) {
    if (have >= AMOUNT) break;
    inputs.push(u);
    have += Assets.getByUnit(u.assets, SDK_UNIT);
  }
  const buyerIn = inputs.reduce((s, u) => Assets.merge(s, u.assets), Assets.zero);
  console.log(`buyer inputs ${inputs.map(ref).join(", ")}: ${ada(Assets.lovelaceOf(buyerIn))} tADA + ${Number(Assets.getByUnit(buyerIn, SDK_UNIT)) / 1e6} tUSDM`);

  const sponsorUtxos = (await sponsor.getWalletUtxos())
    .filter((u) => Assets.hasOnlyLovelace(u.assets) && Assets.lovelaceOf(u.assets) >= 1_500_000n)
    .sort((a, b) => Number(Assets.lovelaceOf(a.assets) - Assets.lovelaceOf(b.assets)));
  const sp = sponsorUtxos[0];
  if (!sp) throw new Error("sponsor has no ADA-only UTxO of 1.5 tADA or more");
  const s = Assets.lovelaceOf(sp.assets);
  console.log(`sponsor input ${ref(sp)}: ${ada(s)} tADA`);

  // The buyer's change: every token and every lovelace the buyer brought, less the payment.
  const [policy, name] = TUSDM.split(".") as [string, string];
  const change = Assets.subtract(buyerIn, Assets.fromHexStrings(policy, name, AMOUNT, 0n));
  const ttl = BigInt(Date.now()) + 300_000n;
  const built = await buyer
    .newTx()
    .collectFrom({ inputs: [...inputs, sp] })
    .payToAddress({ address: buyerAddr, assets: change })
    .setValidity({ to: ttl })
    .build({ changeAddress: payTo, availableUtxos: [] });
  const unsigned = await built.toTransaction();
  const body = unsigned.body;
  console.log(`\nbuilt: ${body.inputs.length} inputs, ${body.outputs.length} outputs, fee ${ada(body.fee)} tADA`);
  body.outputs.forEach((o, i) =>
    console.log(`  out ${i}: ${Address.toBech32(o.address).slice(0, 24)}… ${ada(Assets.lovelaceOf(o.assets))} tADA + ${Number(Assets.getByUnit(o.assets, SDK_UNIT)) / 1e6} tUSDM`),
  );

  const unsignedHex = Transaction.toCBORHex(unsigned);
  const buyerWs = await built.partialSign();
  const buyerSigned = Transaction.addVKeyWitnessesHex(unsignedHex, TransactionWitnessSet.toCBORHex(buyerWs));
  // The seed wallet signs only for inputs found in `utxos` (or for required signers): hand it the
  // one sponsor UTxO it is meant to sign for, and nothing else.
  const sellerWs = await sponsor.signTx(buyerSigned, { utxos: [sp] });
  const full = Transaction.addVKeyWitnessesHex(buyerSigned, TransactionWitnessSet.toCBORHex(sellerWs));
  const pp = await buyer.getProtocolParameters();
  const minFee = (hex: string) => BigInt(pp.minFeeA) * BigInt(hex.length / 2) + BigInt(pp.minFeeB);
  console.log(`buyer witnesses ${buyerWs.vkeyWitnesses?.length ?? 0}, seller witnesses ${sellerWs.vkeyWitnesses?.length ?? 0}`);
  console.log(`sizes: unsigned ${unsignedHex.length / 2} B, buyer-signed ${buyerSigned.length / 2} B, full ${full.length / 2} B`);
  console.log(`fee ${body.fee} vs floor for the full tx ${minFee(full)}: ${body.fee >= minFee(full) ? "covered" : "SHORT"}`);

  const payToOut = body.outputs.filter((o) => Address.toBech32(o.address) === Address.toBech32(payTo));
  const toPayTo = payToOut.reduce((t, o) => t + Assets.lovelaceOf(o.assets), 0n);
  console.log(`S4: lovelace to payTo ${toPayTo} + fee ${body.fee} = ${toPayTo + body.fee} vs sponsor ${s}: ${toPayTo + body.fee >= s ? "ok" : "DIVERTED"}`);
  console.log(`buyer ADA in ${Assets.lovelaceOf(buyerIn)} vs buyer change ADA ${Assets.lovelaceOf(body.outputs[0]!.assets)}`);

  // @x402/cardano's own facilitator, provider-only, as a resource server would reach it.
  const facilitator = new ExactFacilitator(
    toFacilitatorCardanoSigner({ network: NETWORK, provider: { blockfrost: { baseUrl: BF_BASE, projectId } } }),
  );
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: TUSDM,
    amount: AMOUNT.toString(),
    payTo: Address.toBech32(payTo),
    maxTimeoutSeconds: 600,
    extra: {},
  };
  const payload = (hex: string): PaymentPayload => ({
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: Buffer.from(hex, "hex").toString("base64"), nonce: ref(inputs[0]!) },
  });
  console.log(`\nfacilitator verify, buyer-signed only: ${JSON.stringify(await facilitator.verify(payload(buyerSigned), requirements))}`);
  console.log(`facilitator verify, both witnesses:   ${JSON.stringify(await facilitator.verify(payload(full), requirements))}`);
}

// process.exit right after a fetch can abort inside libuv on Windows; set the code instead.
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
