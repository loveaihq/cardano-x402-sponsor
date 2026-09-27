// Preprod setup for the runs: two buyers that hold nothing but tUSDM and the exact min-ada that came
// with it, and a sponsor key with offer-sized UTxOs. `npm run fund -- status|buyers|sponsor`.
import { Address, Assets } from "@evolution-sdk/evolution";
import { ACCOUNT, NAME, POLICY, ada, bech32, holdingsAt, log, run, save, submit, usdm, wallet } from "./env.ts";

const BUYER_USDM = 20_000_000n; // 20 tUSDM each
const OFFER_UTXOS = 6;
const OFFER_LOVELACE = 1_500_000n;

async function status() {
  for (const [name, i] of Object.entries(ACCOUNT)) {
    const addr = await bech32(wallet(i));
    const h = await holdingsAt(addr);
    log(`account ${i} ${name.padEnd(11)} ${addr.slice(0, 22)}… ${h.utxos} utxos, ${ada(h.lovelace)} tADA, ${usdm(h.usdm)} tUSDM${h.dirty ? `, ${h.dirty} with other tokens` : ""}`);
  }
}

async function buyers() {
  const targets = [ACCOUNT.buyerA, ACCOUNT.buyerB];
  for (const i of targets) {
    const h = await holdingsAt(await bech32(wallet(i)));
    if (h.utxos) throw new Error(`account ${i} is not empty (${h.utxos} utxos); a buyer must start with tUSDM and its min-ada only`);
  }
  let tx = wallet(ACCOUNT.tokenFunder).newTx();
  for (const i of targets) {
    // autoMinUtxo: the output carries exactly its min-ada, the least any token UTxO can have.
    tx = tx.payToAddress({ address: await wallet(i).address(), assets: Assets.fromHexStrings(POLICY, NAME, BUYER_USDM, 0n), autoMinUtxo: true });
  }
  const hash = await submit("buyers funded", await tx.build());
  save("fund-buyers.json", { tx: hash, perBuyer: BUYER_USDM });
}

async function sponsor() {
  const target = wallet(ACCOUNT.sponsor);
  const h = await holdingsAt(await bech32(target));
  if (h.utxos) throw new Error(`the sponsor account already holds ${h.utxos} utxos`);
  let tx = wallet(ACCOUNT.adaFunder).newTx();
  const to: Address.Address = await target.address();
  for (let k = 0; k < OFFER_UTXOS; k++) tx = tx.payToAddress({ address: to, assets: Assets.fromLovelace(OFFER_LOVELACE) });
  const hash = await submit("sponsor funded", await tx.build());
  save("fund-sponsor.json", { tx: hash, utxos: OFFER_UTXOS, each: OFFER_LOVELACE });
}

run(async () => {
  const phase = process.argv[2] ?? "status";
  if (phase === "buyers") await buyers();
  else if (phase === "sponsor") await sponsor();
  else if (phase !== "status") throw new Error(`unknown phase ${phase}`);
  await status();
});
