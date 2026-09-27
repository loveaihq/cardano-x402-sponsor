// What the seller checks before its witness goes on a sponsored transaction (DESIGN.md section 6,
// S1–S9), and the fee arithmetic the facilitator shares (F1). Pure apart from the owner lookup.
import {
  Address,
  Assets,
  Ed25519Signature,
  Transaction,
  TransactionBody,
  TransactionHash,
  TransactionWitnessSet,
  VKey,
} from "@evolution-sdk/evolution";
import { slotToPosixMs } from "@x402/cardano";
import type { FeeSponsorOffer } from "./offer.ts";

/** Where an input sits: whether it is unspent, and its payment key hash when it has one. */
export type OwnerLookup = (ref: string) => Promise<{ exists: boolean; paymentKeyHash?: string }>;

export interface FeeParameters {
  minFeeA: bigint;
  minFeeB: bigint;
}

export interface SponsoredCheck {
  /** The transaction as it will be broadcast, less the witnesses still to come. */
  txHex: string;
  offer: FeeSponsorOffer;
  network: string;
  /** bech32 */
  payTo: string;
  /** `policy.assetNameHex`; offers are made for native-asset prices only. */
  asset: string;
  amount: bigint;
  /** The sponsor's payment key hash, lowercase hex. */
  sponsorKeyHash: string;
  ownerOf: OwnerLookup;
  fees: FeeParameters;
  /** Vkey witnesses still to be merged before broadcast: 1 before the seller signs, 0 after. */
  missingWitnesses: number;
}

export type RuleResult =
  | { ok: true; txHash: string; fee: bigint; toPayTo: bigint }
  | { ok: false; rule: string; detail: string };

const refOf = (i: { transactionId: TransactionHash.TransactionHash; index: bigint }) =>
  `${TransactionHash.toHex(i.transactionId).toLowerCase()}#${Number(i.index)}`;

/** The transaction id (body hash) of a transaction given as CBOR hex. */
export function txIdOf(txHex: string): string {
  const body = Transaction.extractBodyBytes(Buffer.from(txHex, "hex"));
  return TransactionHash.toHex(TransactionBody.toHashFromBytes(body)).toLowerCase();
}

/** Whether the transaction spends the offered input. */
export function spendsOffer(txHex: string, offer: Pick<FeeSponsorOffer, "input">): boolean {
  return Transaction.fromCBORHex(txHex).body.inputs.some((i) => refOf(i) === offer.input);
}

/** The ledger's fee floor for a transaction of `sizeBytes`, scripts aside. */
export function feeFloor(sizeBytes: number, fees: FeeParameters): bigint {
  return fees.minFeeA * BigInt(sizeBytes) + fees.minFeeB;
}

/**
 * The size the transaction will have once `n` more vkey witnesses are merged, measured by merging
 * placeholders (distinct keys, zero signatures) exactly as the real ones will be.
 */
export function sizeWith(txHex: string, n: number): number {
  if (n === 0) return txHex.length / 2;
  const placeholders = Array.from({ length: n }, (_, i) => {
    const key = new Uint8Array(32);
    key[0] = 0xfe;
    key[1] = i;
    return new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromBytes(key), signature: Ed25519Signature.fromBytes(new Uint8Array(64)) });
  });
  const merged = Transaction.addVKeyWitnessesHex(txHex, TransactionWitnessSet.toCBORHex(TransactionWitnessSet.fromVKeyWitnesses(placeholders)));
  return merged.length / 2;
}

const bad = (rule: string, detail: string): RuleResult => ({ ok: false, rule, detail });
const present = (v: unknown) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

/**
 * S1–S9. The binding part of S1 (the offer is live and bound to no other transaction) is the
 * pool's; this checks what the transaction itself can show.
 */
export async function checkSponsoredTx(c: SponsoredCheck): Promise<RuleResult> {
  let tx: Transaction.Transaction;
  try {
    tx = Transaction.fromCBORHex(c.txHex);
  } catch (e) {
    return bad("decode", (e as Error).message);
  }
  const b = tx.body;
  const w = tx.witnessSet;
  const refs = b.inputs.map(refOf);

  // S1: it spends the offered input.
  if (!refs.includes(c.offer.input)) return bad("S1", "the transaction does not spend the offered input");

  // S3: nothing that runs a script or puts up collateral.
  if (present(b.collateralInputs) || present(b.collateralReturn) || present(b.totalCollateral)) return bad("S3", "collateral is not allowed");
  if (present(b.scriptDataHash) || present(w.redeemers) || present(w.plutusV1Scripts) || present(w.plutusV2Scripts) || present(w.plutusV3Scripts) || present(w.nativeScripts)) {
    return bad("S3", "scripts and redeemers are not allowed");
  }
  if (tx.isValid === false) return bad("S3", "the transaction is marked phase-2 invalid");

  // S6: nothing that moves value outside inputs and outputs.
  if (present(b.mint)) return bad("S6", "mint is not allowed");
  if (present(b.withdrawals)) return bad("S6", "withdrawals are not allowed");
  if (present(b.certificates)) return bad("S6", "certificates are not allowed");
  if (present(b.votingProcedures) || present(b.proposalProcedures)) return bad("S6", "governance actions are not allowed");
  if (present(b.donation) || present(b.currentTreasuryValue)) return bad("S6", "treasury fields are not allowed");

  // S5: the fee the sponsor pays is bounded.
  const fee = b.fee;
  if (fee > BigInt(c.offer.maxFee)) return bad("S5", `fee ${fee} exceeds maxFee ${c.offer.maxFee}`);

  // S4: the sponsor's lovelace ends at payTo or as the fee. With value conservation, outputs to
  // anyone else carry at most what the other inputs brought.
  let toPayTo = 0n;
  let paid = 0n;
  const [policy, name] = c.asset.split(".") as [string, string];
  if (!policy || name === undefined || c.asset === "lovelace") return bad("S8", "offers are made for native-asset prices only");
  for (const o of b.outputs) {
    if (Address.toBech32(o.address) !== c.payTo) continue;
    toPayTo += Assets.lovelaceOf(o.assets);
    const q = Assets.getByUnit(o.assets, policy + name);
    if (q > paid) paid = q;
  }
  if (toPayTo + fee < BigInt(c.offer.lovelace)) {
    return bad("S4", `payTo gets ${toPayTo} lovelace and the fee is ${fee}: ${BigInt(c.offer.lovelace) - toPayTo - fee} of the sponsor's ${c.offer.lovelace} would go elsewhere`);
  }

  // S8: it pays the price. Tokens can only come from the buyer: the sponsor UTxO is ADA-only.
  if (paid < c.amount) return bad("S8", `no output pays ${c.amount} of the asset to payTo (best ${paid})`);

  // S7: it cannot outlive the offer.
  if (b.ttl === undefined) return bad("S7", "the transaction has no validity upper bound");
  if (slotToPosixMs(c.network, b.ttl) > Number(c.offer.expiresAt)) return bad("S7", "the validity upper bound is after the offer expires");

  // S9: the fee covers the floor with every witness merged.
  const floor = feeFloor(sizeWith(c.txHex, c.missingWitnesses), c.fees);
  if (fee < floor) return bad("S9", `fee ${fee} is below the floor ${floor} for the fully witnessed transaction`);

  // S2: no other input at the sponsor's key. Looked up on chain, so a UTxO that reached the sponsor
  // address after the pool last read it cannot slip in; an input that cannot be resolved fails.
  for (const ref of refs) {
    if (ref === c.offer.input) continue;
    let owner: Awaited<ReturnType<OwnerLookup>>;
    try {
      owner = await c.ownerOf(ref);
    } catch (e) {
      return bad("S2", `could not look up ${ref}: ${(e as Error).message}`);
    }
    if (!owner.exists) return bad("S2", `input ${ref} is spent or unknown`);
    if (owner.paymentKeyHash?.toLowerCase() === c.sponsorKeyHash) return bad("S2", `input ${ref} is at the sponsor's key too`);
  }

  return { ok: true, txHash: txIdOf(c.txHex), fee, toPayTo };
}
