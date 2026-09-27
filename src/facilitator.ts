// The facilitator's side (DESIGN.md section 7): @x402/cardano's facilitator scheme, which advertises
// that it merges seller witnesses, merges them at settlement (F2), checks a sponsored transaction's
// fee against the size it will have once witnessed (F1), and refuses to broadcast one that is
// missing the seller's witness (F3). It holds no keys.
import { KeyHash, Transaction, TransactionWitnessSet } from "@evolution-sdk/evolution";
import type { FacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme as CardanoFacilitatorScheme } from "@x402/cardano/exact/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { CAPABILITY_KEY, WITNESS_KEY, offerIn, offerKeyHash, type FeeSponsorOffer } from "./offer.ts";
import { checkSponsoredTx, spendsOffer } from "./rules.ts";

export const ERR_SPONSOR_WITNESS_INVALID = "fee_sponsor_witness_invalid";
export const ERR_SPONSOR_WITNESS_MISSING = "fee_sponsor_witness_missing";
export const ERR_SPONSOR_REFUSED = "fee_sponsor_refused";

type Config = ConstructorParameters<typeof CardanoFacilitatorScheme>[1];

const hexOf = (b64: unknown) => (typeof b64 === "string" ? Buffer.from(b64, "base64").toString("hex") : "");

/** Key hashes (lowercase hex) of every vkey witness on a transaction. */
export function witnessKeyHashes(txHex: string): string[] {
  return (Transaction.fromCBORHex(txHex).witnessSet.vkeyWitnesses ?? []).map((w) => KeyHash.toHex(KeyHash.fromVKey(w.vkey)).toLowerCase());
}

export class SponsoredExactCardanoFacilitator extends CardanoFacilitatorScheme {
  constructor(
    private readonly chain: FacilitatorCardanoSigner,
    config?: Config,
  ) {
    super(chain, config);
  }

  getExtra(network: string): Record<string, unknown> | undefined {
    return { ...super.getExtra(network), [CAPABILITY_KEY]: true };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const merged = this.merge(payload, requirements);
    if ("error" in merged) return { isValid: false, invalidReason: merged.error, invalidMessage: merged.message, payer: "" };
    const base = await super.verify(merged.payload, requirements);
    if (!base.isValid) return base;
    const f1 = await this.checkSponsored(merged.payload, requirements);
    return f1 ? { isValid: false, invalidReason: f1.reason, invalidMessage: f1.message, payer: base.payer ?? "" } : base;
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const merged = this.merge(payload, requirements);
    const fail = (errorReason: string, errorMessage: string): SettleResponse => ({ success: false, errorReason, errorMessage, transaction: "", network: requirements.network });
    if ("error" in merged) return fail(merged.error, merged.message);
    const sponsored = this.offerSpentBy(merged.payload, requirements);
    if (sponsored && !witnessKeyHashes(sponsored.txHex).includes(sponsored.keyHash)) {
      // F3: the node would refuse it for the missing witness, after the handler already ran.
      return fail(ERR_SPONSOR_WITNESS_MISSING, `the transaction spends the offered ${sponsored.offer.input} without the seller's witness`);
    }
    return super.settle(merged.payload, requirements);
  }

  /**
   * F2: the payload with the seller's witnesses merged into the transaction and the extra key
   * dropped. The body, and so the transaction id, is unchanged. Only witnesses for the offer's key
   * are taken.
   */
  private merge(payload: PaymentPayload, requirements: PaymentRequirements): { payload: PaymentPayload } | { error: string; message: string } {
    const inner = payload.payload as Record<string, unknown>;
    const witnesses = inner[WITNESS_KEY];
    if (witnesses === undefined) return { payload };
    const invalid = (message: string) => ({ error: ERR_SPONSOR_WITNESS_INVALID, message });
    if (typeof witnesses !== "string" || !/^[0-9a-f]+$/i.test(witnesses)) return invalid(`${WITNESS_KEY} is not CBOR hex`);
    let offer: FeeSponsorOffer | undefined;
    let keyHash: string | undefined;
    try {
      offer = offerIn(requirements.extra);
      keyHash = offer ? offerKeyHash(offer, requirements.network) : undefined;
    } catch (e) {
      return invalid((e as Error).message);
    }
    if (!offer || !keyHash) return invalid(`${WITNESS_KEY} given for requirements without a usable offer`);
    let ws: TransactionWitnessSet.TransactionWitnessSet;
    try {
      ws = TransactionWitnessSet.fromCBORHex(witnesses);
    } catch (e) {
      return invalid(`${WITNESS_KEY} does not decode: ${(e as Error).message}`);
    }
    const keys = (ws.vkeyWitnesses ?? []).map((w) => KeyHash.toHex(KeyHash.fromVKey(w.vkey)).toLowerCase());
    if (!keys.length || keys.some((k) => k !== keyHash)) return invalid(`${WITNESS_KEY} must hold vkey witnesses for the offer's key only`);
    const txHex = hexOf(inner.transaction);
    let mergedHex: string;
    try {
      mergedHex = Transaction.addVKeyWitnessesHex(txHex, witnesses);
    } catch (e) {
      return invalid(`could not merge ${WITNESS_KEY}: ${(e as Error).message}`);
    }
    const { [WITNESS_KEY]: _merged, ...rest } = inner;
    return { payload: { ...payload, payload: { ...rest, transaction: Buffer.from(mergedHex, "hex").toString("base64") } } };
  }

  private offerSpentBy(payload: PaymentPayload, requirements: PaymentRequirements): { offer: FeeSponsorOffer; keyHash: string; txHex: string } | undefined {
    let offer: FeeSponsorOffer | undefined;
    let keyHash: string | undefined;
    try {
      offer = offerIn(requirements.extra);
      keyHash = offer ? offerKeyHash(offer, requirements.network) : undefined;
    } catch {
      return undefined;
    }
    const txHex = hexOf((payload.payload as Record<string, unknown>).transaction);
    if (!offer || !keyHash || !txHex || !spendsOffer(txHex, offer)) return undefined;
    return { offer, keyHash, txHex };
  }

  /**
   * F1: for a transaction that spends the offer, S3–S9 as defence in depth, with the fee floor
   * measured on the size it will have once the seller's witness is in. S2 (no other input at the
   * sponsor's key) protects the seller from itself and stays with the seller, who signs.
   */
  private async checkSponsored(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ reason: string; message: string } | undefined> {
    const s = this.offerSpentBy(payload, requirements);
    if (!s) return undefined;
    const pp = await this.chain.getProtocolParameters?.(requirements.network);
    if (!pp) return { reason: ERR_SPONSOR_REFUSED, message: "no protocol parameters to size the sponsored fee against" };
    const witnessed = witnessKeyHashes(s.txHex).includes(s.keyHash);
    const r = await checkSponsoredTx({
      txHex: s.txHex,
      offer: s.offer,
      network: requirements.network,
      payTo: requirements.payTo,
      asset: requirements.asset,
      amount: BigInt(requirements.amount),
      sponsorKeyHash: s.keyHash,
      ownerOf: async () => ({ exists: true }),
      fees: { minFeeA: pp.minFeeCoefficient, minFeeB: pp.minFeeConstant },
      missingWitnesses: witnessed ? 0 : 1,
    });
    return r.ok ? undefined : { reason: ERR_SPONSOR_REFUSED, message: `${r.rule}: ${r.detail}` };
  }
}
