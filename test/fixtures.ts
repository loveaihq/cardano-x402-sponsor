// Offline transactions for the chain-free tests: deterministic keys, preprod-style addresses, and
// transactions built from parts and signed for real, so the rules and the witness merge run on the
// same bytes a wallet would produce.
import {
  Address,
  Assets,
  KeyHash,
  PrivateKey,
  Transaction,
  TransactionBody,
  TransactionHash,
  TransactionInput,
  TransactionWitnessSet,
  TxOut,
  UTxO,
  VKey,
} from "@evolution-sdk/evolution";
import type { FeeSponsorOffer } from "../src/offer.ts";

export const NETWORK = "cardano:preprod";
export const POLICY = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9";
export const NAME = "0014df10745553444d";
export const ASSET = `${POLICY}.${NAME}`;
export const FEES = { minFeeA: 44n, minFeeB: 155_381n };

export interface Party {
  key: PrivateKey.PrivateKey;
  keyHash: string;
  address: Address.Address;
  bech32: string;
}

export function party(seed: number): Party {
  const key = PrivateKey.fromBytes(new Uint8Array(32).fill(seed));
  const kh = KeyHash.fromPrivateKey(key);
  const address = new Address.Address({ networkId: 0, paymentCredential: kh });
  return { key, keyHash: KeyHash.toHex(kh).toLowerCase(), address, bech32: Address.toBech32(address) };
}

export const buyer = party(1);
export const sponsor = party(2);
export const seller = party(3);
export const stranger = party(4);

export const txid = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
export const input = (n: number, index = 0) => new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txid(n)), index: BigInt(index) });
export const refOf = (n: number, index = 0) => `${txid(n)}#${index}`;

export const tokens = (amount: bigint, lovelace: bigint) => Assets.fromHexStrings(POLICY, NAME, amount, lovelace);
export const out = (to: Party, assets: Assets.Assets) => new TxOut.TransactionOutput({ address: to.address, assets });

export function utxo(n: number, index: number, owner: Party, assets: Assets.Assets): UTxO.UTxO {
  return new UTxO.UTxO({ transactionId: TransactionHash.fromHex(txid(n)), index: BigInt(index), address: owner.address, assets });
}

/** A preprod slot that maps to `ms` (1 s slots from the preprod zero point). */
export function slotAt(ms: number): bigint {
  return BigInt(Math.floor((ms - 1_655_769_600_000) / 1000)) + 86_400n;
}

export interface TxParts {
  inputs: TransactionInput.TransactionInput[];
  outputs: TxOut.TransactionOutput[];
  fee: bigint;
  ttl?: bigint;
  extra?: Partial<ConstructorParameters<typeof TransactionBody.TransactionBody>[0]>;
}

export function unsignedHex(p: TxParts): string {
  const body = new TransactionBody.TransactionBody({ inputs: p.inputs, outputs: p.outputs, fee: p.fee, ...(p.ttl !== undefined ? { ttl: p.ttl } : {}), ...p.extra });
  const tx = new Transaction.Transaction({ body, witnessSet: TransactionWitnessSet.empty(), isValid: true, auxiliaryData: null });
  return Transaction.toCBORHex(tx);
}

/** A vkey witness set (CBOR hex) by `signers` over the transaction's body. */
export function witnesses(txHex: string, ...signers: Party[]): string {
  const hash = TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(Buffer.from(txHex, "hex")));
  const ws = signers.map(
    (s) => new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromPrivateKey(s.key), signature: PrivateKey.sign(s.key, hash.hash) }),
  );
  return TransactionWitnessSet.toCBORHex(TransactionWitnessSet.fromVKeyWitnesses(ws));
}

export function signed(txHex: string, ...signers: Party[]): string {
  return Transaction.addVKeyWitnessesHex(txHex, witnesses(txHex, ...signers));
}

export const SPONSOR_LOVELACE = 1_500_000n;
export const BUYER_LOVELACE = 1_200_000n;
export const AMOUNT = 1_000_000n;

export function offer(over: Partial<FeeSponsorOffer> = {}): FeeSponsorOffer {
  return {
    input: refOf(0xa0, 3),
    address: sponsor.bech32,
    lovelace: SPONSOR_LOVELACE.toString(),
    maxFee: "300000",
    expiresAt: String(Date.now() + 120_000),
    ...over,
  };
}

/**
 * The sponsored payment of DESIGN.md section 5 with a fee that covers both witnesses, and optional
 * changes for the negative cases. Returns the buyer-signed hex.
 */
export function sponsoredTx(o: FeeSponsorOffer, change: (p: TxParts) => TxParts = (p) => p, sign = true): string {
  const [txHash, index] = o.input.split("#") as [string, string];
  const sponsorIn = new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txHash), index: BigInt(index) });
  const draft = (fee: bigint): TxParts =>
    change({
      inputs: [input(0xb0, 1), sponsorIn],
      outputs: [out(buyer, tokens(19_000_000n, BUYER_LOVELACE)), out(seller, tokens(AMOUNT, BigInt(o.lovelace) - fee))],
      fee,
      ttl: slotAt(Number(o.expiresAt) - 30_000),
    });
  // Two passes: size with both witnesses, then the fee for that size.
  let fee = 200_000n;
  for (let i = 0; i < 3; i++) {
    const hex = signed(unsignedHex(draft(fee)), buyer, sponsor);
    fee = FEES.minFeeA * BigInt(hex.length / 2) + FEES.minFeeB;
  }
  const hex = unsignedHex(draft(fee));
  return sign ? signed(hex, buyer) : hex;
}
