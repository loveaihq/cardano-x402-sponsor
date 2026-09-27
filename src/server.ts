// The resource server's side (DESIGN.md section 4): offers in the 402, the seller's checks and
// witness after verify, the witness handed to the facilitator at settlement, and the pool kept in
// step with how each payment ends. Wraps @x402/cardano's own server scheme, which keeps parsing
// prices and issuing Masumi quotes.
import { Transaction } from "@evolution-sdk/evolution";
import {
  ERR_SETTLEMENT_DEFINITIVELY_REJECTED,
  normalizeCardanoNetwork,
  paymentPayloadFromTransportContext,
  slotToPosixMs,
  type FacilitatorCardanoSigner,
} from "@x402/cardano";
import { ExactCardanoScheme as CardanoServerScheme } from "@x402/cardano/exact/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
  SettleContext,
  SupportedKind,
  VerifyResultContext,
} from "@x402/core/types";
import { CAPABILITY_KEY, OFFER_KEY, WITNESS_KEY, offerIn, type FeeSponsorOffer } from "./offer.ts";
import type { SponsorPool } from "./pool.ts";
import { checkSponsoredTx, feeFloor, spendsOffer, txIdOf } from "./rules.ts";

export interface SponsoredServerConfig {
  /** The one Cardano network this instance serves; register one instance per network. */
  network: string;
  pool: SponsorPool;
  /** Chain reads: input owners for S2 and live fee parameters for S9 (a provider-only facilitator signer has both). */
  chain: {
    getUtxo: FacilitatorCardanoSigner["getUtxo"];
    getProtocolParameters: NonNullable<FacilitatorCardanoSigner["getProtocolParameters"]>;
  };
  /**
   * The longest an offer runs, capped by each accept's `maxTimeoutSeconds`, which is the default.
   * The offer bounds the transaction's validity, and preprod has shown a 172 s gap between blocks:
   * a 120 s offer let a submitted payment expire in the mempool.
   */
  offerTtlSeconds?: number;
  /** Re-read the sponsor address at most this often while serving 402s. Default 20 s. */
  refreshMs?: number;
  /** @x402/cardano's server scheme, when it needs configuring (Masumi). */
  inner?: CardanoServerScheme;
  log?: (line: string) => void;
}

/**
 * The paid payload read from the request itself. Core's HTTP server passes `paymentHeader` in its
 * request context only when the calling framework set it; the adapter always has the header.
 */
function paymentFromAdapter(transportContext: unknown): PaymentPayload | undefined {
  const adapter = (transportContext as { request?: { adapter?: { getHeader?(name: string): string | undefined } } } | undefined)?.request?.adapter;
  const header = adapter?.getHeader?.("payment-signature") ?? adapter?.getHeader?.("PAYMENT-SIGNATURE");
  if (!header) return undefined;
  try {
    return decodePaymentSignatureHeader(header);
  } catch {
    return undefined;
  }
}

type Abort = { abort: true; reason: string; message: string };
const abort = (reason: string, message: string): Abort => ({ abort: true, reason, message });
const hexOf = (b64: unknown) => (typeof b64 === "string" ? Buffer.from(b64, "base64").toString("hex") : "");

export class SponsoredExactCardanoServer implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod: string;
  readonly paymentFlows: CardanoServerScheme["paymentFlows"];
  readonly schemeHooks: SchemeServerHooks;
  private readonly inner: CardanoServerScheme;
  private readonly network: string;
  /** Whether the facilitator for this network merges seller witnesses (section 3.1). */
  private capable = false;
  private lastRefresh = 0;

  constructor(private readonly cfg: SponsoredServerConfig) {
    this.inner = cfg.inner ?? new CardanoServerScheme();
    this.network = normalizeCardanoNetwork(cfg.network);
    this.defaultAssetTransferMethod = this.inner.defaultAssetTransferMethod;
    this.paymentFlows = this.inner.paymentFlows;
    const inner = this.inner.schemeHooks;
    this.schemeHooks = {
      ...inner,
      onAfterVerify: async (ctx) => (await inner.onAfterVerify?.(ctx)) ?? this.bind(ctx),
      onAfterSettle: async (ctx) => {
        await inner.onAfterSettle?.(ctx);
        const s = this.sponsored(ctx);
        if (!s) return;
        if (ctx.result.success) this.cfg.pool.retire(s.offer.input);
        else if (ctx.result.errorReason === ERR_SETTLEMENT_DEFINITIVELY_REJECTED) this.cfg.pool.release(s.offer.input, s.txHash, true);
        this.log(`settle ${ctx.result.success ? "ok" : ctx.result.errorReason} ${s.txHash.slice(0, 16)}… on ${s.offer.input.slice(0, 16)}…`);
      },
      onSettleFailure: async (ctx) => {
        const r = await inner.onSettleFailure?.(ctx);
        const s = this.sponsored(ctx);
        const reason = (ctx.error as { response?: { errorReason?: string } } | undefined)?.response?.errorReason;
        if (s && reason === ERR_SETTLEMENT_DEFINITIVELY_REJECTED) this.cfg.pool.release(s.offer.input, s.txHash, true);
        return r;
      },
      onVerifiedPaymentCanceled: async (ctx) => {
        await inner.onVerifiedPaymentCanceled?.(ctx);
        const s = this.sponsored(ctx);
        if (s) this.cfg.pool.release(s.offer.input, s.txHash);
      },
    };
  }

  parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    return this.inner.parsePrice(price, network);
  }

  getAssetDecimals(asset: string, network: Network): number | undefined {
    return this.inner.getAssetDecimals(asset, network);
  }

  /**
   * The inner scheme's requirements. Where the facilitator merges seller witnesses, a sponsorable
   * accept leaves `areFeesSponsored` unset here: each 402 decides it, with or without an offer.
   */
  async enhancePaymentRequirements(req: PaymentRequirements, kind: SupportedKind, extensions: string[]): Promise<PaymentRequirements> {
    const out = await this.inner.enhancePaymentRequirements(req, kind, extensions);
    if (!this.sponsorable(out) || (kind.extra as Record<string, unknown> | undefined)?.[CAPABILITY_KEY] !== true) return out;
    this.capable = true;
    const { areFeesSponsored: _decidedPer402, ...extra } = out.extra ?? {};
    return { ...out, extra };
  }

  /**
   * Adds an offer to each sponsorable accept. A paid request that names a live offer gets the same
   * offer back, so core matches its `accepted`; anything else gets a fresh one (section 4, step 1).
   */
  async enrichPaymentRequiredResponse(ctx: SchemePaymentRequiredContext): Promise<PaymentRequirements[] | void> {
    const fromInner = await this.inner.enrichPaymentRequiredResponse(ctx);
    if (!this.capable) return fromInner;
    const accepts = fromInner ?? ctx.requirements;
    const paid = (ctx.paymentPayload as PaymentPayload | undefined) ?? paymentPayloadFromTransportContext(ctx.transportContext) ?? paymentFromAdapter(ctx.transportContext);
    let changed = false;
    const out: PaymentRequirements[] = [];
    for (const req of accepts) {
      if (!this.sponsorable(req) || Object.prototype.hasOwnProperty.call(req.extra ?? {}, "areFeesSponsored")) {
        out.push(req);
        continue;
      }
      await this.refreshSometimes();
      const ttlSeconds = Math.min(this.cfg.offerTtlSeconds ?? req.maxTimeoutSeconds, req.maxTimeoutSeconds);
      const offer = this.reuse(paid, req) ?? (await this.cfg.pool.offer(ttlSeconds * 1000));
      out.push({ ...req, extra: { ...req.extra, areFeesSponsored: offer !== undefined, ...(offer ? { [OFFER_KEY]: offer } : {}) } });
      changed = true;
    }
    return changed ? out : fromInner;
  }

  /** The seller's witness for the bound transaction, as the additive settlement-payload key. */
  enrichSettlementPayload = async (ctx: SettleContext): Promise<Record<string, unknown> | void> => {
    const s = this.sponsored(ctx);
    if (!s) return;
    const witness = this.cfg.pool.witnessFor(s.offer, s.txHash);
    if (!witness) throw new Error(`fee sponsor: transaction ${s.txHash} spends ${s.offer.input} but is not the one bound to it`);
    return { [WITNESS_KEY]: witness };
  };

  /** S1–S9, then bind and sign, before the handler runs (section 4, step 4). */
  private async bind(ctx: VerifyResultContext): Promise<void | Abort> {
    if (!ctx.result.isValid) return;
    const req = ctx.requirements as PaymentRequirements;
    if (!this.sponsorable(req)) return;
    let offer: FeeSponsorOffer | undefined;
    try {
      offer = offerIn(req.extra);
    } catch (e) {
      return abort("fee_sponsor_invalid", (e as Error).message);
    }
    if (!offer) return;
    const txHex = hexOf((ctx.paymentPayload.payload as Record<string, unknown>).transaction);
    if (!txHex || !spendsOffer(txHex, offer)) return; // paid the plain way; the offer goes unused
    const me = await this.cfg.pool.identity();
    if (offer.address !== me.address) return abort("fee_sponsor_invalid", "the offer is not this seller's");
    const pp = await this.cfg.chain.getProtocolParameters(this.network);
    const fees = { minFeeA: pp.minFeeCoefficient, minFeeB: pp.minFeeConstant };
    const check = await checkSponsoredTx({
      txHex,
      offer,
      network: this.network,
      payTo: req.payTo,
      asset: req.asset,
      amount: BigInt(req.amount),
      sponsorKeyHash: me.keyHash,
      ownerOf: (ref) => this.cfg.chain.getUtxo(ref, this.network),
      fees,
      missingWitnesses: 1,
    });
    if (!check.ok) {
      this.log(`refused ${check.rule}: ${check.detail}`);
      return abort(`fee_sponsor_${check.rule}`, check.detail);
    }
    const ttl = Transaction.fromCBORHex(txHex).body.ttl!;
    if (!this.cfg.pool.bind(offer, check.txHash, slotToPosixMs(this.network, ttl))) {
      return abort("fee_sponsor_taken", "the offered UTxO is bound to another transaction; pay again with a fresh offer");
    }
    try {
      const witness = await this.cfg.pool.sign(offer, check.txHash, txHex);
      const merged = Transaction.addVKeyWitnessesHex(txHex, witness);
      const floor = feeFloor(merged.length / 2, fees);
      if (check.fee < floor) throw new Error(`fee ${check.fee} is below the floor ${floor} once witnessed`);
    } catch (e) {
      this.cfg.pool.release(offer.input, check.txHash);
      return abort("fee_sponsor_S9", (e as Error).message);
    }
    this.log(`bound ${offer.input.slice(0, 16)}… to ${check.txHash.slice(0, 16)}…, fee ${check.fee}, payTo gets ${check.toPayTo} lovelace`);
  }

  private reuse(paid: PaymentPayload | undefined, req: PaymentRequirements): FeeSponsorOffer | undefined {
    const a = paid?.accepted;
    if (!a || a.scheme !== req.scheme || a.payTo !== req.payTo || a.amount !== req.amount || a.asset !== req.asset || a.maxTimeoutSeconds !== req.maxTimeoutSeconds) return undefined;
    if (normalizeCardanoNetwork(a.network) !== normalizeCardanoNetwork(req.network)) return undefined;
    let offer: FeeSponsorOffer | undefined;
    try {
      offer = offerIn(a.extra);
    } catch {
      return undefined;
    }
    if (!offer) return undefined;
    let txHash: string | undefined;
    try {
      txHash = txIdOf(hexOf((paid!.payload as Record<string, unknown>).transaction));
    } catch {
      // Not a transaction; the offer can still be served, the payment will fail on its own.
    }
    return this.cfg.pool.isLive(offer, txHash) ? offer : undefined;
  }

  /** The offer and transaction when this settlement or cancellation concerns a sponsored payment. */
  private sponsored(ctx: SettleContext): { offer: FeeSponsorOffer; txHash: string } | undefined {
    const req = ctx.requirements as PaymentRequirements;
    if (!this.sponsorable(req)) return undefined;
    try {
      const offer = offerIn(req.extra);
      const txHex = hexOf((ctx.paymentPayload.payload as Record<string, unknown>).transaction);
      if (!offer || !txHex || !spendsOffer(txHex, offer)) return undefined;
      return { offer, txHash: txIdOf(txHex) };
    } catch {
      return undefined;
    }
  }

  /** Cardano `exact`, this network, the default transfer method, and a native-asset price. */
  private sponsorable(req: PaymentRequirements): boolean {
    if (req.scheme !== "exact") return false;
    let net: string;
    try {
      net = normalizeCardanoNetwork(req.network);
    } catch {
      return false;
    }
    const method = (req.extra as Record<string, unknown> | undefined)?.assetTransferMethod ?? "default";
    return net === this.network && method === "default" && req.asset !== "lovelace";
  }

  /** Re-reads the pool now and then. A failed read keeps what the pool knew and is retried next 402. */
  private async refreshSometimes(): Promise<void> {
    if (Date.now() - this.lastRefresh < (this.cfg.refreshMs ?? 20_000)) return;
    try {
      await this.cfg.pool.refresh();
      this.lastRefresh = Date.now();
    } catch (e) {
      this.log(`pool refresh failed, serving from what it last read: ${(e as Error).message}`);
    }
  }

  private log(line: string): void {
    this.cfg.log?.(`[sponsor] ${line}`);
  }
}
