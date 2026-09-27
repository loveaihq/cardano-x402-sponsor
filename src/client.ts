// The buyer's side (DESIGN.md section 5): a ClientCardanoSigner for @x402/cardano's client scheme
// that takes a fee-sponsorship offer when the 402 carries one it can use, and otherwise hands the
// payment to a plain signer. The buyer's own ADA only passes through to its change.
import {
  Address,
  Assets,
  Transaction,
  TransactionHash,
  TransactionWitnessSet,
  UTxO,
  type Client,
} from "@evolution-sdk/evolution";
import { ExactCardanoScheme, parseAssetUnit, parseUtxoRef, type ClientCardanoSignInput, type ClientCardanoSignResult, type ClientCardanoSigner } from "@x402/cardano";
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeClientHooks, SchemeNetworkClient } from "@x402/core/types";
import { offerIn, offerProblem, type FeeSponsorOffer } from "./offer.ts";

/** What the signer needs from the buyer's wallet; an evolution-sdk seed client has it. */
export type BuyerWallet = Pick<Client.SigningClient, "address" | "getWalletUtxos" | "newTx">;

export interface SponsoredClientSignerConfig {
  wallet: BuyerWallet;
  /** The wallet's bech32 address, for the synchronous `getAddress()`. */
  address: string;
  /** Pays accepts without a usable offer, e.g. @x402/cardano's `toClientCardanoSigner`. */
  plain?: ClientCardanoSigner;
  /** How long a UTxO this signer spent stays out of selection while the index catches up. Default 5 min. */
  spentHoldMs?: number;
  /** How long to wait for the wallet's own change to be listed before giving up. Default 90 s. */
  indexWaitMs?: number;
  log?: (line: string) => void;
}

/** What the signer did for the last payment, for callers that report on it. */
export interface SponsoredPaymentInfo {
  sponsored: boolean;
  reason?: string;
  txHash?: string;
  fee?: bigint;
}

export interface SponsoredClientSigner extends ClientCardanoSigner {
  last(): SponsoredPaymentInfo | undefined;
  /** The payment in `txHex` did not go through: its inputs are the wallet's to spend again. */
  release(txHex: string): void;
}

const refOf = (u: UTxO.UTxO) => UTxO.toOutRefString(u).toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function toSponsoredClientSigner(cfg: SponsoredClientSignerConfig): SponsoredClientSigner {
  const spent = new Map<string, number>();
  const holdMs = cfg.spentHoldMs ?? 300_000;
  let lastInfo: SponsoredPaymentInfo | undefined;
  const log = (s: string) => cfg.log?.(`[buyer] ${s}`);

  const plainOr = async (input: ClientCardanoSignInput, reason: string): Promise<ClientCardanoSignResult> => {
    if (!cfg.plain) throw new Error(`cannot pay without the offer (${reason}) and no plain signer is configured`);
    log(`paying the plain way: ${reason}`);
    lastInfo = { sponsored: false, reason };
    return cfg.plain.buildAndSignPaymentTransaction(input);
  };

  /** The wallet's UTxOs, less those this signer spent recently. */
  const usable = async (): Promise<UTxO.UTxO[]> => {
    const now = Date.now();
    for (const [r, until] of spent) if (until < now) spent.delete(r);
    return [...(await cfg.wallet.getWalletUtxos())].filter((u) => !spent.has(refOf(u)));
  };

  async function sponsored(input: ClientCardanoSignInput, offer: FeeSponsorOffer): Promise<ClientCardanoSignResult> {
    const { policyId, assetNameHex } = parseAssetUnit(input.asset);
    const unit = policyId + assetNameHex;
    const amount = BigInt(input.amount);
    const me = await cfg.wallet.address();

    // C3: token UTxOs holding only ADA and the asset first, largest first; others only if needed.
    // C4: no ADA-only UTxOs. Waits for the wallet's own change after a payment moments ago.
    let inputs: UTxO.UTxO[] = [];
    const deadline = Date.now() + (cfg.indexWaitMs ?? 90_000);
    for (;;) {
      const holding = (await usable()).filter((u) => Assets.getByUnit(u.assets, unit) > 0n);
      const clean = holding.filter((u) => Assets.getUnits(u.assets).every((x) => x === "lovelace" || x === unit));
      const byAmount = (a: UTxO.UTxO, b: UTxO.UTxO) => Number(Assets.getByUnit(b.assets, unit) - Assets.getByUnit(a.assets, unit));
      const ordered = [...clean.sort(byAmount), ...holding.filter((u) => !clean.includes(u)).sort(byAmount)];
      inputs = [];
      let have = 0n;
      for (const u of ordered) {
        if (have >= amount) break;
        inputs.push(u);
        have += Assets.getByUnit(u.assets, unit);
      }
      if (have >= amount) break;
      if (spent.size === 0 || Date.now() > deadline) throw new Error(`the wallet holds ${have} of ${input.asset}, ${amount} needed`);
      await sleep(5_000);
    }

    const { txHash, index } = parseUtxoRef(offer.input);
    const sponsorUtxo = new UTxO.UTxO({
      transactionId: TransactionHash.fromHex(txHash),
      index: BigInt(index),
      address: Address.fromBech32(offer.address),
      assets: Assets.fromLovelace(BigInt(offer.lovelace)),
    });
    const brought = inputs.reduce((s, u) => Assets.merge(s, u.assets), Assets.zero);
    const change = Assets.subtract(brought, Assets.fromHexStrings(policyId, assetNameHex, amount, 0n));
    const ttl = BigInt(Math.min(Date.now() + input.maxTimeoutSeconds * 1000, Number(offer.expiresAt)));
    const payTo = Address.fromBech32(input.payTo);

    // Section 5: the builder's change output is the payment, holding the sponsor's lovelace less the
    // fee; the fee estimate already counts a witness for the sponsor's key.
    const built = await cfg.wallet
      .newTx()
      .collectFrom({ inputs: [...inputs, sponsorUtxo] })
      .payToAddress({ address: me, assets: change })
      .setValidity({ to: ttl })
      .build({ changeAddress: payTo, availableUtxos: [] });
    const unsigned = await built.toTransaction();
    const b = unsigned.body;

    // The transaction must be exactly what section 5 describes before the buyer signs it.
    if (b.outputs.length !== 2) throw new Error(`built ${b.outputs.length} outputs, expected 2`);
    const [mine, pay] = b.outputs as [(typeof b.outputs)[number], (typeof b.outputs)[number]];
    if (Address.toBech32(mine.address) !== Address.toBech32(me) || Assets.lovelaceOf(mine.assets) !== Assets.lovelaceOf(brought)) {
      throw new Error("the change output does not return exactly the buyer's own lovelace");
    }
    if (Address.toBech32(pay.address) !== input.payTo || Assets.getByUnit(pay.assets, unit) !== amount) throw new Error("the payment output is not as offered");
    if (b.fee > BigInt(offer.maxFee)) throw new Error(`fee ${b.fee} exceeds the offer's maxFee ${offer.maxFee}`);
    if (Assets.lovelaceOf(pay.assets) + b.fee !== BigInt(offer.lovelace)) throw new Error("the payment output does not carry the sponsor's lovelace less the fee");

    const ws = await built.partialSign();
    const signed = Transaction.addVKeyWitnessesHex(Transaction.toCBORHex(unsigned), TransactionWitnessSet.toCBORHex(ws));
    const hold = Date.now() + holdMs;
    for (const u of inputs) spent.set(refOf(u), hold);
    lastInfo = { sponsored: true, fee: b.fee };
    log(`sponsored payment: ${inputs.length} input(s) + ${offer.input.slice(0, 16)}…, fee ${b.fee} paid by the seller`);
    return { transaction: Buffer.from(signed, "hex").toString("base64"), nonce: refOf(inputs[0]!) };
  }

  return {
    getAddress(): string {
      return cfg.address;
    },

    last: () => lastInfo,

    release(txHex: string): void {
      try {
        for (const i of Transaction.fromCBORHex(txHex).body.inputs) spent.delete(`${TransactionHash.toHex(i.transactionId).toLowerCase()}#${Number(i.index)}`);
      } catch {
        // Not a transaction this signer could have built; nothing to release.
      }
    },

    async buildAndSignPaymentTransaction(input: ClientCardanoSignInput): Promise<ClientCardanoSignResult> {
      let offer: FeeSponsorOffer | undefined;
      try {
        offer = offerIn(input.extra);
      } catch (e) {
        return plainOr(input, `malformed offer: ${(e as Error).message}`);
      }
      if (!offer) return plainOr(input, "no offer");
      if (input.asset === "lovelace") return plainOr(input, "the price is in lovelace");
      const method = input.extra?.assetTransferMethod ?? "default";
      if (method !== "default") return plainOr(input, `transfer method ${String(method)}`);
      const problem = offerProblem(offer, input.network, Date.now()); // C1, C2
      if (problem) return plainOr(input, problem);
      try {
        return await sponsored(input, offer);
      } catch (e) {
        return plainOr(input, `sponsored build failed: ${(e as Error).message}`); // C5
      }
    },
  };
}

/**
 * @x402/cardano's client scheme over a sponsor-aware signer, with a hook that gives a failed
 * payment's inputs back to the wallet. A payment refused because its offer was taken is not retried
 * here: @x402/fetch retries with the first 402, whose offer is the one that failed, so the caller
 * requests again and gets a fresh offer.
 */
export class SponsoredExactCardanoClient implements SchemeNetworkClient {
  readonly scheme = "exact";
  readonly schemeHooks: SchemeClientHooks;
  private readonly inner: ExactCardanoScheme;

  constructor(private readonly signer: SponsoredClientSigner) {
    this.inner = new ExactCardanoScheme(signer);
    this.schemeHooks = {
      onPaymentResponse: async (ctx) => {
        if (ctx.settleResponse?.success) return;
        const tx = (ctx.paymentPayload.payload as Record<string, unknown>).transaction;
        if (typeof tx === "string") this.signer.release(Buffer.from(tx, "base64").toString("hex"));
      },
    };
  }

  findDefaultAsset(...args: Parameters<ExactCardanoScheme["findDefaultAsset"]>) {
    return this.inner.findDefaultAsset(...args);
  }

  createPaymentPayload(x402Version: number, requirements: PaymentRequirements, context?: PaymentPayloadContext): Promise<PaymentPayloadResult> {
    return this.inner.createPaymentPayload(x402Version, requirements, context);
  }
}
