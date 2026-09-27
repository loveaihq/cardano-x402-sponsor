// What the preprod runs share: the network, tUSDM, the test accounts, Blockfrost reads with
// retries, submitting and waiting, and the run's state files under out/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Address, Assets, Client, preprod, type TransactionHash, type UTxO } from "@evolution-sdk/evolution";

export const NETWORK = "cardano:preprod";
export const BF_BASE = "https://cardano-preprod.blockfrost.io/api/v0";
/** Moneta's preprod tUSDM, the asset @x402/cardano names; 6 decimals. */
export const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
export const [POLICY, NAME] = TUSDM.split(".") as [string, string];
/** The SDK's unit: policy and name run together. */
export const UNIT = POLICY + NAME;

export function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
}
export const projectId = must("BLOCKFROST_PROJECT_ID");
export const mnemonic = must("WALLET_MNEMONIC");
export const provider = { blockfrost: { baseUrl: BF_BASE, projectId } };

/**
 * Accounts of the public "abandon … art" test mnemonic. 0 holds tUSDM and funds the buyers, 3 funds
 * the sponsor, 1 is the seller's payTo, 6 the seller's sponsor key; 5 and 7 are buyers that hold
 * nothing but tUSDM and the ADA that came with it.
 */
export const ACCOUNT = { tokenFunder: 0, seller: 1, adaFunder: 3, buyerA: 5, sponsor: 6, buyerB: 7 } as const;
export const wallet = (accountIndex: number) =>
  Client.make(preprod).withBlockfrost({ baseUrl: BF_BASE, projectId }).withSeed({ mnemonic, accountIndex });
export type Wallet = ReturnType<typeof wallet>;
export const bech32 = async (w: Wallet) => Address.toBech32(await w.address());

export const ada = (l: bigint) => (Number(l) / 1e6).toFixed(6);
export const usdm = (q: bigint) => (Number(q) / 1e6).toString();
export const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Blockfrost GET, retried on network errors, 429 and 5xx; null on 404. */
export async function bf<T = unknown>(path: string): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${BF_BASE}${path}`, { headers: { project_id: projectId }, signal: AbortSignal.timeout(30_000) });
      if (r.status === 404) return null;
      if (r.ok) return (await r.json()) as T;
      if (r.status !== 429 && r.status < 500) throw new Error(`Blockfrost ${path}: ${r.status} ${await r.text()}`);
    } catch (e) {
      if (attempt >= 5 || (e as Error).message.startsWith("Blockfrost")) throw e;
    }
    await sleep(3_000 * attempt);
  }
}

/** Waits until Blockfrost knows the transaction in a block. */
export async function confirmed(txHash: string, what: string, timeoutMs = 600_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const tx = await bf<{ block_height: number }>(`/txs/${txHash}`);
    if (tx) return log(`${what} ${txHash} in block ${tx.block_height}`);
    await sleep(5_000);
  }
  throw new Error(`${what} ${txHash} not in a block after ${timeoutMs / 1000} s`);
}

export async function submit(what: string, sb: { sign(): Promise<{ submit(): Promise<TransactionHash.TransactionHash> }> }): Promise<string> {
  const signed = await sb.sign();
  const hash = await signed.submit();
  const hex = Buffer.from(hash.hash).toString("hex");
  log(`${what}: submitted ${hex}`);
  await confirmed(hex, what);
  return hex;
}

export interface Holdings {
  utxos: number;
  lovelace: bigint;
  usdm: bigint;
  /** UTxOs with tokens other than tUSDM. */
  dirty: number;
}

export function holdingsOf(utxos: ReadonlyArray<UTxO.UTxO>): Holdings {
  let lovelace = 0n;
  let q = 0n;
  let dirty = 0;
  for (const u of utxos) {
    lovelace += Assets.lovelaceOf(u.assets);
    q += Assets.getByUnit(u.assets, UNIT);
    if (Assets.getUnits(u.assets).some((x) => x !== "lovelace" && x !== UNIT)) dirty++;
  }
  return { utxos: utxos.length, lovelace, usdm: q, dirty };
}

/** An address's holdings from Blockfrost's index (what the chain shows, not a wallet's view). */
export async function holdingsAt(address: string): Promise<Holdings> {
  const rows: Array<{ amount: Array<{ unit: string; quantity: string }> }> = [];
  for (let page = 1; ; page++) {
    const got = (await bf<typeof rows>(`/addresses/${address}/utxos?page=${page}`)) ?? [];
    rows.push(...got);
    if (got.length < 100) break;
  }
  let lovelace = 0n;
  let q = 0n;
  let dirty = 0;
  for (const r of rows) {
    for (const a of r.amount) {
      if (a.unit === "lovelace") lovelace += BigInt(a.quantity);
      else if (a.unit === UNIT) q += BigInt(a.quantity);
    }
    if (r.amount.some((a) => a.unit !== "lovelace" && a.unit !== UNIT)) dirty++;
  }
  return { utxos: rows.length, lovelace, usdm: q, dirty };
}

export const OUT = new URL("../out/", import.meta.url);
export function load<T>(name: string, fallback: T): T {
  const f = new URL(name, OUT);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback;
}
export function save(name: string, v: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL(name, OUT), JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}

/** Runs a phase function, reporting errors without process.exit (which can abort in libuv on Windows). */
export function run(main: () => Promise<void>): void {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
