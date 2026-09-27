// The sponsor wallet's offer-sized UTxOs (DESIGN.md section 8): soft offers that lock nothing,
// exclusive bindings (the seller signs at most one transaction per UTxO), and what ends them.
import { Address, Assets, TransactionWitnessSet, UTxO } from "@evolution-sdk/evolution";
import { keyHashOf, type FeeSponsorOffer } from "./offer.ts";

/** What the pool needs from the sponsor's wallet; an evolution-sdk seed client has all of it. */
export interface SponsorWallet {
  address(): Promise<Address.Address>;
  getWalletUtxos(): Promise<ReadonlyArray<UTxO.UTxO>>;
  signTx(txHex: string, context: { utxos: UTxO.UTxO[] }): Promise<TransactionWitnessSet.TransactionWitnessSet>;
}

export interface SponsorPoolConfig {
  wallet: SponsorWallet;
  /** Smallest UTxO worth offering: the `payTo` output's min-UTxO plus `maxFee`. Default 1.5 ADA. */
  minOfferLovelace?: bigint;
  /** Largest UTxO the pool offers; bigger ones are left for splitting. Default 5 ADA. */
  maxOfferLovelace?: bigint;
  /** Default 0.3 ADA. */
  maxFee?: bigint;
  /** Clock, for tests. */
  now?: () => number;
}

interface Slot {
  utxo: UTxO.UTxO;
  lovelace: bigint;
  lastOffered: number;
}

interface Binding {
  txHash: string;
  /** The seller's witness set, CBOR hex, once signed. */
  witness?: string;
  /** Set once settlement was attempted: the transaction may be on its way to the chain. */
  submitted: boolean;
  /** POSIX ms after which, if the UTxO is still unspent, nothing can spend it any more. */
  validUntil: number;
}

const ref = (u: UTxO.UTxO) => UTxO.toOutRefString(u).toLowerCase();
const sameOffer = (a: FeeSponsorOffer, b: FeeSponsorOffer) =>
  a.input === b.input && a.address === b.address && a.lovelace === b.lovelace && a.maxFee === b.maxFee && a.expiresAt === b.expiresAt;

/** How long after a binding's validity bound it is held before the chain is trusted to show the outcome. */
const GRACE_MS = 120_000;

export class SponsorPool {
  readonly maxFee: bigint;
  private readonly minOffer: bigint;
  private readonly maxOffer: bigint;
  private readonly now: () => number;
  private address?: string;
  private keyHash?: string;
  private readonly slots = new Map<string, Slot>();
  /** Offers made and not yet expired, by input. Several can be out for one UTxO. */
  private readonly offers = new Map<string, FeeSponsorOffer[]>();
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly cfg: SponsorPoolConfig) {
    this.maxFee = cfg.maxFee ?? 300_000n;
    this.minOffer = cfg.minOfferLovelace ?? 1_500_000n;
    this.maxOffer = cfg.maxOfferLovelace ?? 5_000_000n;
    this.now = cfg.now ?? Date.now;
    if (this.maxFee >= this.minOffer) throw new Error("maxFee must be below minOfferLovelace");
  }

  /** The sponsor's bech32 address and payment key hash. */
  async identity(): Promise<{ address: string; keyHash: string }> {
    if (!this.address) {
      const a = await this.cfg.wallet.address();
      const kh = keyHashOf(a);
      if (!kh) throw new Error("the sponsor wallet's address has no key payment credential");
      this.address = Address.toBech32(a);
      this.keyHash = kh;
    }
    return { address: this.address, keyHash: this.keyHash! };
  }

  /**
   * Re-reads the sponsor address. New offer-sized ADA-only UTxOs join; a slot whose UTxO is gone was
   * spent (by a transaction the seller signed, since nothing else can spend it) and is retired with
   * its binding; a binding whose transaction can no longer land is released.
   */
  async refresh(): Promise<void> {
    await this.identity();
    const seen = new Set<string>();
    for (const u of await this.listing()) {
      const lovelace = Assets.lovelaceOf(u.assets);
      if (!Assets.hasOnlyLovelace(u.assets) || lovelace < this.minOffer || lovelace > this.maxOffer) continue;
      const r = ref(u);
      seen.add(r);
      if (!this.slots.has(r)) this.slots.set(r, { utxo: u, lovelace, lastOffered: 0 });
    }
    for (const r of [...this.slots.keys()]) {
      if (seen.has(r)) continue;
      // Gone from the listing. Unbound, or bound and handed to settlement: it was spent. Bound and
      // never settled, nothing but the seller could have spent it, so the listing is behind: keep.
      const b = this.bindings.get(r);
      if (!b || b.submitted) this.retire(r);
    }
    const now = this.now();
    for (const [r, b] of this.bindings) if (now > b.validUntil + GRACE_MS && this.slots.has(r)) this.bindings.delete(r);
    for (const [r, list] of this.offers) {
      const live = list.filter((o) => Number(o.expiresAt) > now);
      if (live.length) this.offers.set(r, live);
      else this.offers.delete(r);
    }
  }

  /** The sponsor address's UTxOs, with a few retries: a provider hiccup must not empty the pool. */
  private async listing(): Promise<ReadonlyArray<UTxO.UTxO>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.cfg.wallet.getWalletUtxos();
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1_500 * attempt));
      }
    }
  }

  /** How many UTxOs the pool holds, and how many are bound. */
  size(): { utxos: number; bound: number } {
    return { utxos: this.slots.size, bound: this.bindings.size };
  }

  /**
   * A fresh offer running `ttlMs`, on the unbound UTxO offered least recently, or undefined when
   * there is none. Offers lock nothing (section 8), so an unpaid 402 cannot drain the pool.
   */
  async offer(ttlMs: number): Promise<FeeSponsorOffer | undefined> {
    const { address } = await this.identity();
    const free = [...this.slots.entries()].filter(([r]) => !this.bindings.has(r)).sort((a, b) => a[1].lastOffered - b[1].lastOffered);
    const pick = free[0];
    if (!pick) return undefined;
    const [r, slot] = pick;
    const now = this.now();
    slot.lastOffered = now;
    const o: FeeSponsorOffer = {
      input: r,
      address,
      lovelace: slot.lovelace.toString(),
      maxFee: this.maxFee.toString(),
      expiresAt: String(now + ttlMs),
    };
    this.offers.set(r, [...(this.offers.get(r) ?? []), o]);
    return o;
  }

  /**
   * Whether `o` is an offer this pool made that can still be paid with: not expired, its UTxO still
   * held, and not bound to a transaction other than `txHash` (when given).
   */
  isLive(o: FeeSponsorOffer, txHash?: string): boolean {
    if (Number(o.expiresAt) <= this.now()) return false;
    if (!this.slots.has(o.input)) return false;
    if (!(this.offers.get(o.input) ?? []).some((x) => sameOffer(x, o))) return false;
    const b = this.bindings.get(o.input);
    return !b || b.txHash === txHash;
  }

  /** Binds the offer's UTxO to `txHash`. False when it is bound to another transaction. */
  bind(o: FeeSponsorOffer, txHash: string, validUntil: number): boolean {
    if (!this.isLive(o, txHash)) return false;
    const b = this.bindings.get(o.input);
    if (!b) this.bindings.set(o.input, { txHash, submitted: false, validUntil });
    return true;
  }

  /** Signs `txHex` for the bound UTxO, exactly one vkey witness, and keeps it with the binding. */
  async sign(o: FeeSponsorOffer, txHash: string, txHex: string): Promise<string> {
    const b = this.bindings.get(o.input);
    const slot = this.slots.get(o.input);
    if (!b || b.txHash !== txHash || !slot) throw new Error("the offer is not bound to this transaction");
    if (b.witness) return b.witness;
    const ws = await this.cfg.wallet.signTx(txHex, { utxos: [slot.utxo] });
    if (ws.vkeyWitnesses?.length !== 1) throw new Error(`the sponsor wallet produced ${ws.vkeyWitnesses?.length ?? 0} witnesses, expected 1`);
    b.witness = TransactionWitnessSet.toCBORHex(ws);
    return b.witness;
  }

  /** The stored witness for the transaction bound to the offer's UTxO; marks it submitted. */
  witnessFor(o: FeeSponsorOffer, txHash: string): string | undefined {
    const b = this.bindings.get(o.input);
    if (!b || b.txHash !== txHash || !b.witness) return undefined;
    b.submitted = true;
    return b.witness;
  }

  /**
   * Ends a binding whose transaction cannot have landed: the payment was cancelled before
   * settlement, or the node definitively rejected it. Ignored for another transaction's binding.
   */
  release(input: string, txHash: string, definitive = false): void {
    const b = this.bindings.get(input);
    if (b && b.txHash === txHash && (!b.submitted || definitive)) this.bindings.delete(input);
  }

  /** The UTxO was spent: drop it, its offers and its binding. */
  retire(input: string): void {
    this.slots.delete(input);
    this.offers.delete(input);
    this.bindings.delete(input);
  }
}
