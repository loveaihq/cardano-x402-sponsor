// The seller's fee-sponsorship offer (DESIGN.md section 3): its wire shape in an accept's
// `extra`, and the checks every role runs on it before relying on it.
import { Address, Assets, KeyHash, type UTxO } from "@evolution-sdk/evolution";
import { getCardanoNetworkId } from "@x402/cardano";

/** Key of the offer in `PaymentRequirements.extra`. */
export const OFFER_KEY = "feeSponsor";
/** Key a facilitator sets in its `/supported` kind `extra` when it merges seller witnesses. */
export const CAPABILITY_KEY = "acceptsSponsorWitnesses";
/** Key the resource server adds to the settlement payload: the seller's witness set, CBOR hex. */
export const WITNESS_KEY = "sponsorWitnesses";

export interface FeeSponsorOffer {
  /** The sponsor UTxO, `txHash#index`, lowercase: ADA-only, at a key-credential address. */
  input: string;
  /** Its bech32 address. */
  address: string;
  /** Its exact lovelace. */
  lovelace: string;
  /** The largest network fee the sponsor pays, in lovelace. */
  maxFee: string;
  /** POSIX ms; the transaction's validity upper bound may not be later. */
  expiresAt: string;
}

const REF = /^[0-9a-f]{64}#(0|[1-9][0-9]*)$/;
const INT = /^(0|[1-9][0-9]*)$/;
const FIELDS = ["input", "address", "lovelace", "maxFee", "expiresAt"] as const;

/**
 * The offer an accept's `extra` carries, or undefined when it carries none. Throws when the key is
 * present but the value is not an offer: a half-understood offer must not be acted on.
 */
export function offerIn(extra: Record<string, unknown> | undefined): FeeSponsorOffer | undefined {
  const raw = extra?.[OFFER_KEY];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${OFFER_KEY} is not an object`);
  const o = raw as Record<string, unknown>;
  for (const f of FIELDS) if (typeof o[f] !== "string") throw new Error(`${OFFER_KEY}.${f} is not a string`);
  const extraKeys = Object.keys(o).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extraKeys.length) throw new Error(`${OFFER_KEY} has unknown fields: ${extraKeys.join(", ")}`);
  return { input: o.input as string, address: o.address as string, lovelace: o.lovelace as string, maxFee: o.maxFee as string, expiresAt: o.expiresAt as string };
}

/**
 * Why this offer cannot be used on `network` at `nowMs`, or undefined when it can. `marginMs` is how
 * long the offer must still run: long enough to build, sign and send the paid request.
 */
export function offerProblem(offer: FeeSponsorOffer, network: string, nowMs: number, marginMs = 5_000): string | undefined {
  if (!REF.test(offer.input)) return "input is not a lowercase txHash#index";
  let keyHash: string | undefined;
  try {
    keyHash = offerKeyHash(offer, network);
  } catch (e) {
    return (e as Error).message;
  }
  if (!keyHash) return "address has no key payment credential";
  for (const f of ["lovelace", "maxFee", "expiresAt"] as const) if (!INT.test(offer[f])) return `${f} is not a canonical integer`;
  const lovelace = BigInt(offer.lovelace);
  const maxFee = BigInt(offer.maxFee);
  if (maxFee <= 0n || maxFee >= lovelace) return "maxFee must be positive and below lovelace";
  if (Number(offer.expiresAt) <= nowMs + marginMs) return "offer has expired";
  return undefined;
}

/**
 * The payment key hash (lowercase hex) of the offer's address, or undefined for a script address.
 * Throws when the address does not parse or belongs to another network.
 */
export function offerKeyHash(offer: Pick<FeeSponsorOffer, "address">, network: string): string | undefined {
  let a: Address.Address;
  try {
    a = Address.fromBech32(offer.address);
  } catch {
    throw new Error("address does not parse");
  }
  if (a.networkId !== getCardanoNetworkId(network)) throw new Error("address is on another network");
  return keyHashOf(a);
}

/** The payment key hash of an address, lowercase hex, or undefined for a script credential. */
export function keyHashOf(a: Address.Address): string | undefined {
  return a.paymentCredential instanceof KeyHash.KeyHash ? KeyHash.toHex(a.paymentCredential).toLowerCase() : undefined;
}

/**
 * C6: why the buyer must not build with `offer`, given what the chain holds at `offer.input`
 * (undefined when it holds nothing there), or undefined when it may. The offer's address never
 * enters the transaction: the ledger asks for the witness of the UTxO's real owner. So an offer
 * naming one of the buyer's own UTxOs, under any address, has the buyer's own signature spend it,
 * and its ADA goes to `payTo` as the sponsor's would. The buyer reads the UTxO itself.
 */
export function offerOnChainProblem(offer: FeeSponsorOffer, onChain: UTxO.UTxO | undefined, buyerKeyHash: string): string | undefined {
  if (!onChain) return "the offered UTxO is not on chain";
  const owner = keyHashOf(onChain.address);
  if (owner === buyerKeyHash.toLowerCase()) return "the offered UTxO is this wallet's own";
  if (Address.toBech32(onChain.address) !== offer.address) return "the offered UTxO is at another address than the offer names";
  if (!owner) return "the offered UTxO is not at a key";
  if (!Assets.hasOnlyLovelace(onChain.assets)) return "the offered UTxO holds tokens";
  if (Assets.lovelaceOf(onChain.assets) !== BigInt(offer.lovelace)) return `the offered UTxO holds ${Assets.lovelaceOf(onChain.assets)} lovelace, not the ${offer.lovelace} offered`;
  // Spending it would add the reference-script fee, which a fee built from the offer leaves out.
  if (onChain.scriptRef) return "the offered UTxO carries a reference script";
  return undefined;
}
