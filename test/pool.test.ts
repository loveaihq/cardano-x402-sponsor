// The pool: which UTxOs it offers, soft offers, exclusive bindings, and how bindings end.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Assets, TransactionWitnessSet, UTxO } from "@evolution-sdk/evolution";
import type { FeeSponsorOffer } from "../src/offer.ts";
import { SponsorPool, type SponsorWallet } from "../src/pool.ts";
import { ASSET, NAME, POLICY, offer as offerOf, refOf, sponsor, sponsoredTx, utxo, witnesses } from "./fixtures.ts";

interface FakeWallet extends SponsorWallet {
  utxos: UTxO.UTxO[];
  signedFor: string[][];
  witnessesPerSign: number;
}

function wallet(utxos: UTxO.UTxO[]): FakeWallet {
  const w: FakeWallet = {
    utxos,
    signedFor: [] as string[][],
    witnessesPerSign: 1,
    async address() {
      return sponsor.address;
    },
    async getWalletUtxos() {
      return w.utxos;
    },
    async signTx(txHex: string, ctx: { utxos: UTxO.UTxO[] }) {
      w.signedFor.push(ctx.utxos.map((u) => UTxO.toOutRefString(u)));
      if (w.witnessesPerSign === 0) return TransactionWitnessSet.empty();
      return TransactionWitnessSet.fromCBORHex(witnesses(txHex, sponsor));
    },
  };
  return w;
}

const ada = (n: number) => Assets.fromLovelace(BigInt(Math.round(n * 1e6)));
const clock = (start = 1_800_000_000_000) => {
  const c = { t: start, now: () => c.t };
  return c;
};

test("offers only ADA-only UTxOs between the minimum and maximum size", async () => {
  const w = wallet([
    utxo(0xa0, 0, sponsor, ada(1.5)),
    utxo(0xa0, 1, sponsor, ada(1.0)),
    utxo(0xa0, 2, sponsor, ada(10)),
    utxo(0xa0, 3, sponsor, Assets.fromHexStrings(POLICY, NAME, 5n, 2_000_000n)),
    utxo(0xa0, 4, sponsor, ada(4.9)),
  ]);
  const pool = new SponsorPool({ wallet: w });
  await pool.refresh();
  assert.deepEqual(pool.size(), { utxos: 2, bound: 0 });
  const offered = new Set([(await pool.offer(60_000))!.input, (await pool.offer(60_000))!.input]);
  assert.deepEqual(offered, new Set([refOf(0xa0, 0), refOf(0xa0, 4)]));
  assert.ok(ASSET.startsWith(POLICY));
});

test("offers rotate least recently offered first, and lock nothing", async () => {
  const c = clock();
  const pool = new SponsorPool({ wallet: wallet([utxo(0xa0, 0, sponsor, ada(1.5)), utxo(0xa0, 1, sponsor, ada(1.5))]), now: c.now });
  await pool.refresh();
  const a = await pool.offer(60_000);
  c.t += 1;
  const b = await pool.offer(60_000);
  c.t += 1;
  const again = await pool.offer(60_000);
  assert.notEqual(a!.input, b!.input);
  assert.equal(again!.input, a!.input);
  // Both offers on the same UTxO stay payable until one is bound.
  assert.ok(pool.isLive(a!) && pool.isLive(again!));
  assert.equal(a!.maxFee, "300000");
  assert.equal(a!.address, sponsor.bech32);
  assert.equal(a!.lovelace, "1500000");
});

test("binding is exclusive: the first transaction wins, the same one may retry, a release frees it", async () => {
  const c = clock();
  const pool = new SponsorPool({ wallet: wallet([utxo(0xa0, 0, sponsor, ada(1.5))]), now: c.now });
  await pool.refresh();
  const o = (await pool.offer(60_000))!;
  assert.ok(pool.bind(o, "tx1", c.t + 60_000));
  assert.ok(pool.bind(o, "tx1", c.t + 60_000));
  assert.equal(pool.bind(o, "tx2", c.t + 60_000), false);
  assert.ok(pool.isLive(o, "tx1"));
  assert.equal(pool.isLive(o, "tx2"), false);
  assert.equal(await pool.offer(60_000), undefined, "a bound UTxO is not offered again");
  pool.release(o.input, "tx2");
  assert.equal(pool.bind(o, "tx2", c.t + 60_000), false, "someone else's release is ignored");
  pool.release(o.input, "tx1");
  assert.ok(pool.bind(o, "tx2", c.t + 60_000));
});

test("an offer stops being live when it expires or was never made", async () => {
  const c = clock();
  const pool = new SponsorPool({ wallet: wallet([utxo(0xa0, 0, sponsor, ada(1.5))]), now: c.now });
  await pool.refresh();
  const o = (await pool.offer(60_000))!;
  assert.equal(pool.isLive({ ...o, expiresAt: String(Number(o.expiresAt) + 1) }), false);
  assert.equal(pool.isLive({ ...o, lovelace: "1500001" }), false);
  c.t += 60_000;
  assert.equal(pool.isLive(o), false);
  assert.equal(pool.bind(o, "tx1", c.t), false);
});

test("sign: only the bound UTxO is handed to the wallet, one witness, kept for settlement", async () => {
  const c = clock(Date.now());
  const w = wallet([utxo(0xa0, 3, sponsor, ada(1.5))]);
  const pool = new SponsorPool({ wallet: w, now: c.now });
  await pool.refresh();
  const o = (await pool.offer(60_000))!;
  const hex = sponsoredTx(offerOf({ ...o }));
  await assert.rejects(pool.sign(o, "tx1", hex), /not bound/);
  assert.ok(pool.bind(o, "tx1", c.t + 60_000));
  const witness = await pool.sign(o, "tx1", hex);
  assert.deepEqual(w.signedFor, [[refOf(0xa0, 3)]]);
  assert.equal(await pool.sign(o, "tx1", hex), witness, "signed once");
  assert.equal(w.signedFor.length, 1);
  assert.equal(pool.witnessFor(o, "tx2"), undefined);
  assert.equal(pool.witnessFor(o, "tx1"), witness);
  // Handed to settlement: a plain release no longer ends it, a definitive rejection does.
  pool.release(o.input, "tx1");
  assert.equal(pool.size().bound, 1);
  pool.release(o.input, "tx1", true);
  assert.equal(pool.size().bound, 0);
});

test("sign refuses a wallet that does not produce exactly one witness", async () => {
  const w = wallet([utxo(0xa0, 3, sponsor, ada(1.5))]);
  w.witnessesPerSign = 0;
  const pool = new SponsorPool({ wallet: w });
  await pool.refresh();
  const o = (await pool.offer(60_000))!;
  assert.ok(pool.bind(o, "tx1", Date.now() + 60_000));
  await assert.rejects(pool.sign(o, "tx1", sponsoredTx(o)), /0 witnesses/);
});

test("refresh: spent UTxOs retire, a bound one the listing lost is kept, a stale binding is released", async () => {
  const c = clock();
  const [u0, u1, u2, u3] = [0, 1, 2, 3].map((i) => utxo(0xa0, i, sponsor, ada(1.5)));
  const w = wallet([u0!, u1!, u2!, u3!]);
  const pool = new SponsorPool({ wallet: w, now: c.now });
  await pool.refresh();
  const offers: FeeSponsorOffer[] = [];
  for (let i = 0; i < 4; i++) {
    offers.push((await pool.offer(600_000))!);
    c.t += 1;
  }
  const byInput = (r: string) => offers.find((o) => o.input === r)!;
  // u1: bound, never settled. u2: bound and handed to settlement. u3: bound, then its window passed.
  assert.ok(pool.bind(byInput(refOf(0xa0, 1)), "t1", c.t + 60_000));
  assert.ok(pool.bind(byInput(refOf(0xa0, 2)), "t2", c.t + 60_000));
  assert.ok(pool.bind(byInput(refOf(0xa0, 3)), "t3", c.t + 10_000));
  (pool as unknown as { bindings: Map<string, { witness?: string }> }).bindings.get(refOf(0xa0, 2))!.witness = "00";
  pool.witnessFor(byInput(refOf(0xa0, 2)), "t2");
  w.utxos = [u3!];
  c.t += 10_000 + 120_001;
  await pool.refresh();
  // u0 (unbound, gone) and u2 (submitted, gone) retired; u1 kept bound; u3 present, binding released.
  assert.deepEqual(pool.size(), { utxos: 2, bound: 1 });
  assert.ok(pool.isLive(byInput(refOf(0xa0, 3)), "someone-else"));
});
