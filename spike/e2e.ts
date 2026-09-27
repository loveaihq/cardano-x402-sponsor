// Milestone 1 on preprod (DESIGN.md section 14), through @x402/core's own HTTP resource server and
// @x402/fetch: `npm run e2e -- sponsored [n] | plain | concurrent | negatives | report`.
// State: out/e2e.json. Buyers A and B hold only tUSDM and the ADA that came with it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Address, Assets, Time, Transaction, TransactionBody, TransactionHash, TransactionInput, TransactionWitnessSet, TxOut, UTxO, preprod } from "@evolution-sdk/evolution";
import { ExactCardanoScheme as ExactClient, toClientCardanoSigner, toFacilitatorCardanoSigner, type FacilitatorCardanoSigner } from "@x402/cardano";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type HTTPAdapter, type RoutesConfig } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { SponsoredExactCardanoClient, toSponsoredClientSigner } from "../src/client.ts";
import { SponsoredExactCardanoFacilitator } from "../src/facilitator.ts";
import { offerIn, type FeeSponsorOffer } from "../src/offer.ts";
import { SponsorPool } from "../src/pool.ts";
import { checkSponsoredTx, feeFloor, sizeWith, txIdOf } from "../src/rules.ts";
import { SponsoredExactCardanoServer } from "../src/server.ts";
import { ACCOUNT, NAME, NETWORK, POLICY, TUSDM, UNIT, ada, bech32, bf, holdingsAt, load, log, mnemonic, provider, run, save, sleep, usdm, wallet } from "./env.ts";

const RES_PORT = 7420;
const FAC_PORT = 7421;
const URL_DATA = `http://127.0.0.1:${RES_PORT}/data`;
const PRICE = 1_000_000n; // 1 tUSDM

interface Payment {
  phase: string;
  buyer: string;
  status: number;
  tx?: string;
  sponsored?: boolean;
  fee?: string;
  offer?: string;
  ms: number;
  note?: string;
}
interface State {
  payments: Payment[];
  negatives: Array<{ case: string; http: string; facilitator?: string; seller?: string; landed: boolean }>;
  before?: Record<string, { lovelace: string; usdm: string; utxos: number }>;
}
const STATE = "e2e.json";
const state = (): State => load<State>(STATE, { payments: [], negatives: [] });
const record = (f: (s: State) => void) => {
  const s = state();
  f(s);
  save(STATE, s);
};

const chainSigner = (): FacilitatorCardanoSigner => toFacilitatorCardanoSigner({ network: NETWORK, provider: { ...provider, requestTimeoutMs: 30_000 } });

async function stack() {
  const payTo = await bech32(wallet(ACCOUNT.seller));
  const facilitatorChain = chainSigner();
  const facilitator = new x402Facilitator().register(NETWORK, new SponsoredExactCardanoFacilitator(facilitatorChain, { confirmationTimeoutMs: 120_000 }));
  const facServer = await listen(FAC_PORT, async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/supported") return json(res, 200, facilitator.getSupported());
    if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
      const { paymentPayload, paymentRequirements } = JSON.parse((await body(req)) || "{}");
      const out = url.pathname === "/verify" ? await facilitator.verify(paymentPayload, paymentRequirements) : await facilitator.settle(paymentPayload, paymentRequirements);
      const failed = (out as { isValid?: boolean }).isValid === false || (out as { success?: boolean }).success === false;
      if (failed) log(`  facilitator ${url.pathname}: ${JSON.stringify(out).slice(0, 300)}`);
      return json(res, 200, out);
    }
    json(res, 404, { error: "not found" });
  });

  const serverChain = chainSigner();
  const pool = new SponsorPool({ wallet: wallet(ACCOUNT.sponsor) });
  const scheme = new SponsoredExactCardanoServer({
    network: NETWORK,
    pool,
    chain: { getUtxo: (r, n) => serverChain.getUtxo(r, n), getProtocolParameters: (n) => serverChain.getProtocolParameters!(n) },
    log: (s) => log(`  ${s}`),
  });
  const resource = new x402ResourceServer(new HTTPFacilitatorClient({ url: `http://127.0.0.1:${FAC_PORT}`, timeoutMs: 300_000 })).register(NETWORK, scheme);
  const routes: RoutesConfig = {
    "GET /data": {
      accepts: { scheme: "exact", network: NETWORK, payTo, price: { asset: TUSDM, amount: PRICE.toString() }, maxTimeoutSeconds: 300, extra: { confirmationPolicy: { l1Confirmations: 0 } } },
      description: "one datum for 1 tUSDM",
    },
  };
  const http = new x402HTTPResourceServer(resource, routes);
  await http.initialize();
  let served = 0;
  const resServer = await listen(RES_PORT, async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${RES_PORT}`);
    if (url.pathname !== "/data") return json(res, 404, { error: "not found" });
    await body(req);
    const context = { adapter: adapter(req, url), path: url.pathname, method: req.method ?? "GET" };
    const result = await http.processHTTPRequest(context);
    if (result.type === "no-payment-required") return json(res, 200, { n: ++served });
    if (result.type === "payment-error") return send(res, result.response.status, result.response.headers, result.response.body ?? {});
    const payload = JSON.stringify({ n: ++served, at: new Date().toISOString() });
    const settle = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: context, responseBody: Buffer.from(payload) }, undefined, result.beforeHandlerSettlement);
    if (!settle.success) {
      log(`  resource: settlement failed ${settle.errorReason} ${settle.errorMessage ?? ""}`);
      return send(res, settle.response.status, { ...settle.headers, ...settle.response.headers }, settle.response.body ?? {});
    }
    send(res, 200, settle.headers, payload);
  });
  return {
    payTo,
    pool,
    facilitatorChain,
    close: async () => {
      await new Promise((r) => resServer.close(r));
      await new Promise((r) => facServer.close(r));
    },
  };
}

async function buyer(i: number, sponsorAware = true) {
  const w = wallet(i);
  const address = await bech32(w);
  const plain = toClientCardanoSigner({ mnemonic, network: NETWORK, provider, accountIndex: i });
  const signer = sponsorAware ? toSponsoredClientSigner({ wallet: w, address, plain, log: (s) => log(`  ${s}`) }) : undefined;
  const scheme = signer ? new SponsoredExactCardanoClient(signer) : new ExactClient(plain);
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:*", client: scheme }], spendControls: false });
  return { i, address, signer, pay: wrapFetchWithPayment(fetch, client) };
}
type Buyer = Awaited<ReturnType<typeof buyer>>;

/** Why a 402 came back: the payment-required header's error, or the settlement failure's body. */
function reasonOf(r: Response): string {
  const header = r.headers.get("payment-required");
  try {
    if (header) return decodePaymentRequiredHeader(header).error ?? "no reason given";
  } catch {
    // Not a PaymentRequired: a settlement failure carries its own header.
  }
  const settled = r.headers.get("payment-response");
  try {
    if (settled) {
      const d = decodePaymentResponseHeader(settled);
      return `${d.errorReason ?? "settlement failed"}${d.errorMessage ? `: ${d.errorMessage}` : ""}`;
    }
  } catch {
    // fall through
  }
  return `HTTP ${r.status}`;
}

async function payOnce(b: Buyer, phase: string): Promise<Payment> {
  const started = Date.now();
  let r: Response;
  try {
    r = await b.pay(URL_DATA);
  } catch (e) {
    const p: Payment = { phase, buyer: `account ${b.i}`, status: 0, ms: Date.now() - started, note: (e as Error).message.slice(0, 300) };
    log(`${phase} account ${b.i}: FAILED ${p.note}`);
    record((s) => s.payments.push(p));
    return p;
  }
  if (r.status === 402 && b.signer) {
    // The offer was taken, went stale, or its transaction missed its window: the signer released the
    // inputs, and asking again serves a fresh offer.
    log(`${phase} account ${b.i}: 402 (${reasonOf(r)}), paying again with a fresh offer`);
    r = await b.pay(URL_DATA);
  }
  const text = await r.text();
  const header = r.headers.get("payment-response");
  const response = header ? decodePaymentResponseHeader(header) : undefined;
  const info = b.signer?.last();
  const p: Payment = {
    phase,
    buyer: `account ${b.i}`,
    status: r.status,
    ...(response?.transaction ? { tx: response.transaction } : {}),
    sponsored: info?.sponsored ?? false,
    ...(info?.fee !== undefined ? { fee: info.fee.toString() } : {}),
    ms: Date.now() - started,
    ...(r.status !== 200 ? { note: text.slice(0, 300) } : {}),
  };
  log(`${phase} account ${b.i}: HTTP ${r.status}${p.tx ? ` tx ${p.tx}` : ""}${p.sponsored ? ` sponsored, fee ${p.fee}` : " plain"} in ${(p.ms / 1000).toFixed(1)} s`);
  record((s) => s.payments.push(p));
  return p;
}

async function snapshot(label: string) {
  const out: Record<string, { lovelace: string; usdm: string; utxos: number }> = {};
  for (const [name, i] of Object.entries(ACCOUNT)) {
    const h = await holdingsAt(await bech32(wallet(i)));
    out[name] = { lovelace: h.lovelace.toString(), usdm: h.usdm.toString(), utxos: h.utxos };
    log(`${label} account ${i} ${name.padEnd(11)} ${h.utxos} utxos, ${ada(h.lovelace)} tADA, ${usdm(h.usdm)} tUSDM`);
  }
  return out;
}

async function phaseSponsored(n: number) {
  if (!state().before) {
    const before = await snapshot("before");
    record((s) => (s.before = before));
  }
  const s = await stack();
  try {
    const a = await buyer(ACCOUNT.buyerA);
    for (let k = 0; k < n; k++) await payOnce(a, "sponsored");
  } finally {
    await s.close();
  }
}

async function phasePlain() {
  const s = await stack();
  try {
    // Account 0 with @x402/cardano's own reference signer: it ignores the offer and pays its fee and
    // payTo's min-ada itself.
    await payOnce(await buyer(ACCOUNT.tokenFunder, false), "plain");
  } finally {
    await s.close();
  }
}

async function phaseConcurrent() {
  const s = await stack();
  try {
    const [a, b] = [await buyer(ACCOUNT.buyerA), await buyer(ACCOUNT.buyerB)];
    await Promise.all([payOnce(a, "concurrent"), payOnce(b, "concurrent")]);
  } finally {
    await s.close();
  }
}

// ---- negatives: crafted transactions, never co-signed, so none can land ----

interface Parts {
  inputs: TransactionInput.TransactionInput[];
  outputs: TxOut.TransactionOutput[];
  fee: bigint;
  ttl?: bigint;
  extra?: Partial<ConstructorParameters<typeof TransactionBody.TransactionBody>[0]>;
}

const inputOf = (ref: string) => {
  const [h, i] = ref.split("#") as [string, string];
  return new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(h), index: BigInt(i) });
};
const unsigned = (p: Parts) =>
  Transaction.toCBORHex(
    new Transaction.Transaction({
      body: new TransactionBody.TransactionBody({ inputs: p.inputs, outputs: p.outputs, fee: p.fee, ...(p.ttl !== undefined ? { ttl: p.ttl } : {}), ...p.extra }),
      witnessSet: TransactionWitnessSet.empty(),
      isValid: true,
      auxiliaryData: null,
    }),
  );

async function fresh402(): Promise<PaymentRequirements> {
  const r = await fetch(URL_DATA);
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
  const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!);
  return pr.accepts[0] as PaymentRequirements;
}

async function phaseNegatives() {
  const s = await stack();
  const w = wallet(ACCOUNT.buyerA);
  const me = await w.address();
  const payTo = Address.fromBech32(s.payTo);
  const pp = await s.facilitatorChain.getProtocolParameters!(NETWORK);
  const fees = { minFeeA: pp.minFeeCoefficient, minFeeB: pp.minFeeConstant };
  try {
    const mine = (await w.getWalletUtxos()).filter((u) => Assets.getByUnit(u.assets, UNIT) >= PRICE);
    const bu = mine[0];
    if (!bu) throw new Error("buyer A holds no tUSDM UTxO");
    const buRef = UTxO.toOutRefString(bu);
    const bLovelace = Assets.lovelaceOf(bu.assets);
    const bTokens = Assets.getByUnit(bu.assets, UNIT);
    log(`negatives: buyer A input ${buRef}: ${ada(bLovelace)} tADA + ${usdm(bTokens)} tUSDM`);

    /** The legitimate sponsored transaction for this offer, with `change` applied, fee sized for both witnesses. */
    const craft = (o: FeeSponsorOffer, change: (p: Parts) => Parts = (p) => p, witnessesForFee = 2) => {
      const s0 = BigInt(o.lovelace);
      const draft = (fee: bigint): Parts =>
        change({
          inputs: [inputOf(buRef), inputOf(o.input)],
          outputs: [
            new TxOut.TransactionOutput({ address: me, assets: Assets.fromHexStrings(POLICY, NAME, bTokens - PRICE, bLovelace) }),
            new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromHexStrings(POLICY, NAME, PRICE, s0 - fee) }),
          ],
          fee,
          ttl: Time.unixTimeToSlot(BigInt(Math.min(Date.now() + 240_000, Number(o.expiresAt) - 5_000)), preprod.slotConfig),
        });
      let fee = 200_000n;
      for (let k = 0; k < 3; k++) fee = feeFloor(sizeWith(unsigned(draft(fee)), witnessesForFee), fees);
      return unsigned(draft(fee));
    };
    const buyerSigned = async (hex: string) => Transaction.addVKeyWitnessesHex(hex, TransactionWitnessSet.toCBORHex(await w.signTx(hex, { utxos: [bu] })));

    const tryCase = async (name: string, build: (o: FeeSponsorOffer, accepted: PaymentRequirements) => string | Promise<string>, opts: { accepted?: (a: PaymentRequirements) => PaymentRequirements } = {}) => {
      const served = await fresh402();
      const o = offerIn(served.extra)!;
      const accepted = opts.accepted ? opts.accepted(served) : served;
      const hex = await buyerSigned(await build(o, accepted));
      const payload: PaymentPayload = { x402Version: 2, accepted, payload: { transaction: Buffer.from(hex, "hex").toString("base64"), nonce: buRef } } as PaymentPayload;
      // The whole pipeline, as a client would reach it.
      const r = await fetch(URL_DATA, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
      const pr = r.headers.get("payment-required");
      const http = r.status === 200 ? "200 (PAID!)" : `${r.status} ${pr ? decodePaymentRequiredHeader(pr).error : (await r.text()).slice(0, 120)}`;
      // Each layer on its own: the facilitator's verify, and the seller's checks before it would sign.
      const fv = await (await fetch(`http://127.0.0.1:${FAC_PORT}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPayload: payload, paymentRequirements: accepted }) })).json();
      const facilitator = fv.isValid ? "valid" : `${fv.invalidReason}${fv.invalidMessage ? `: ${String(fv.invalidMessage).slice(0, 90)}` : ""}`;
      const me6 = await s.pool.identity();
      const sr = await checkSponsoredTx({
        txHex: hex,
        offer: o,
        network: NETWORK,
        payTo: s.payTo,
        asset: TUSDM,
        amount: PRICE,
        sponsorKeyHash: me6.keyHash,
        ownerOf: (ref) => s.facilitatorChain.getUtxo(ref, NETWORK),
        fees,
        missingWitnesses: 1,
      });
      const seller = sr.ok ? "passes" : `${sr.rule}: ${sr.detail.slice(0, 90)}`;
      await sleep(1_000);
      const landed = (await bf(`/txs/${txIdOf(hex)}`)) !== null;
      log(`negative ${name}: HTTP ${http} | facilitator ${facilitator} | seller ${seller} | landed ${landed}`);
      record((st) => st.negatives.push({ case: name, http, facilitator, seller, landed }));
    };

    const pool = (await wallet(ACCOUNT.sponsor).getWalletUtxos()).map((u) => ({ ref: UTxO.toOutRefString(u), lovelace: Assets.lovelaceOf(u.assets) }));

    await tryCase("S2 a second sponsor UTxO as input", (o) => {
      const extra = pool.find((p) => p.ref !== o.input)!;
      return craft(o, (p) => ({
        ...p,
        inputs: [...p.inputs, inputOf(extra.ref)],
        outputs: [p.outputs[0]!, new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromHexStrings(POLICY, NAME, PRICE, BigInt(o.lovelace) + extra.lovelace - p.fee) })],
      }));
    });
    await tryCase("S3 collateral input", (o) => craft(o, (p) => ({ ...p, extra: { collateralInputs: [inputOf(buRef)] } })));
    await tryCase("S4 0.1 tADA of the sponsor's to the buyer", (o) =>
      craft(o, (p) => ({
        ...p,
        outputs: [
          new TxOut.TransactionOutput({ address: me, assets: Assets.fromHexStrings(POLICY, NAME, bTokens - PRICE, bLovelace + 100_000n) }),
          new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromHexStrings(POLICY, NAME, PRICE, BigInt(o.lovelace) - p.fee - 100_000n) }),
        ],
      })),
    );
    await tryCase("S5 fee above maxFee", (o) =>
      craft(o, (p) => ({
        ...p,
        fee: 310_000n,
        outputs: [p.outputs[0]!, new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromHexStrings(POLICY, NAME, PRICE, BigInt(o.lovelace) - 310_000n) })],
      })),
    );
    await tryCase("S7 validity past the offer", (o) => craft(o, (p) => ({ ...p, ttl: p.ttl! + 125n })));
    await tryCase("S9 fee sized for one witness", (o) => craft(o, (p) => p, 1));
    await tryCase("S8 half the price", (o) =>
      craft(o, (p) => ({
        ...p,
        outputs: [
          new TxOut.TransactionOutput({ address: me, assets: Assets.fromHexStrings(POLICY, NAME, bTokens - PRICE / 2n, bLovelace) }),
          new TxOut.TransactionOutput({ address: payTo, assets: Assets.fromHexStrings(POLICY, NAME, PRICE / 2n, BigInt(o.lovelace) - p.fee) }),
        ],
      })),
    );
    await tryCase("forged offer (expiry moved)", (o) => craft({ ...o, expiresAt: String(Number(o.expiresAt) + 60_000) }), {
      accepted: (a) => ({ ...a, extra: { ...a.extra, feeSponsor: { ...offerIn(a.extra)!, expiresAt: String(Number(offerIn(a.extra)!.expiresAt) + 60_000) } } }),
    });

    // F3: straight to the facilitator's /settle, no seller witness. It must refuse before broadcasting.
    {
      const served = await fresh402();
      const o = offerIn(served.extra)!;
      const hex = await buyerSigned(craft(o));
      const payload = { x402Version: 2, accepted: served, payload: { transaction: Buffer.from(hex, "hex").toString("base64"), nonce: buRef } };
      const out = await (await fetch(`http://127.0.0.1:${FAC_PORT}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPayload: payload, paymentRequirements: served }) })).json();
      await sleep(20_000);
      const landed = (await bf(`/txs/${txIdOf(hex)}`)) !== null;
      log(`negative F3 settle without the seller's witness: ${out.success ? "SETTLED!" : out.errorReason} | landed ${landed}`);
      record((st) => st.negatives.push({ case: "F3 settle without the seller's witness", http: "-", facilitator: out.success ? "settled" : out.errorReason, landed }));
    }
  } finally {
    await s.close();
  }
}

// ---- report: every recorded transaction, reconciled per address from the chain ----

interface BfUtxos {
  inputs: Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }>;
  outputs: Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }>;
}
const q = (amount: Array<{ unit: string; quantity: string }>, unit: string) => BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");

async function phaseReport() {
  const st = state();
  const names: Record<string, string> = {};
  for (const [name, i] of Object.entries(ACCOUNT)) names[await bech32(wallet(i))] = name;
  const net: Record<string, { lovelace: bigint; usdm: bigint }> = {};
  const add = (addr: string, l: bigint, u: bigint) => {
    const k = names[addr] ?? addr.slice(0, 20);
    net[k] ??= { lovelace: 0n, usdm: 0n };
    net[k].lovelace += l;
    net[k].usdm += u;
  };
  let sponsoredFees = 0n;
  let allFees = 0n;
  const paid = st.payments.filter((p) => p.status === 200 && p.tx);
  for (const p of paid) {
    const u = (await bf<BfUtxos>(`/txs/${p.tx}/utxos`))!;
    const tx = (await bf<{ fees: string; size: number; block_height: number }>(`/txs/${p.tx}`))!;
    for (const i of u.inputs) add(i.address, -q(i.amount, "lovelace"), -q(i.amount, UNIT));
    for (const o of u.outputs) add(o.address, q(o.amount, "lovelace"), q(o.amount, UNIT));
    allFees += BigInt(tx.fees);
    const sponsoredOnChain = u.inputs.some((i) => names[i.address] === "sponsor");
    if (sponsoredOnChain) sponsoredFees += BigInt(tx.fees);
    log(`${p.phase.padEnd(10)} ${p.buyer}: ${p.tx} fee ${ada(BigInt(tx.fees))} size ${tx.size} B block ${tx.block_height}${sponsoredOnChain ? " sponsored" : " plain"} (${(p.ms / 1000).toFixed(1)} s)`);
  }
  log(`net per address over ${paid.length} payments (fees ${ada(allFees)}, of which the seller paid ${ada(sponsoredFees)}):`);
  for (const [k, v] of Object.entries(net)) log(`  ${k.padEnd(11)} ${v.lovelace >= 0n ? "+" : ""}${ada(v.lovelace)} tADA  ${v.usdm >= 0n ? "+" : ""}${usdm(v.usdm)} tUSDM`);
  const seller = (net.seller?.lovelace ?? 0n) + (net.sponsor?.lovelace ?? 0n);
  log(`seller (payTo + sponsor) net ADA ${ada(seller)}; fees it paid ${ada(sponsoredFees)}; plain buyers' min-ada it received ${ada(seller + sponsoredFees)}`);
  for (const n of st.negatives) log(`negative ${n.case}: ${n.http} | ${n.facilitator ?? "-"} | ${n.seller ?? "-"} | landed ${n.landed}`);
  if (st.before) {
    for (const who of ["buyerA", "buyerB"] as const) {
      const h = await holdingsAt(await bech32(wallet(ACCOUNT[who])));
      const b = st.before[who]!;
      log(`${who}: tADA ${ada(BigInt(b.lovelace))} → ${ada(h.lovelace)}, tUSDM ${usdm(BigInt(b.usdm))} → ${usdm(h.usdm)}, utxos ${b.utxos} → ${h.utxos}`);
    }
  }
}

// ---- HTTP plumbing ----

function listen(port: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<Server> {
  const srv = createServer((req, res) =>
    handler(req, res).catch((e) => {
      log(`  server ${port}: ${(e as Error).stack ?? String(e)}`);
      json(res, 500, { error: String(e) });
    }),
  );
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv)));
}

function adapter(req: IncomingMessage, url: URL): HTTPAdapter {
  return {
    getHeader: (name: string) => req.headers[name.toLowerCase()] as string | undefined,
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => (req.headers.accept as string) ?? "application/json",
    getUserAgent: () => (req.headers["user-agent"] as string) ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name: string) => url.searchParams.get(name) ?? undefined,
  };
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok, err) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => ok(s));
    req.on("error", err);
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, b: unknown) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof b === "string" ? b : JSON.stringify(b));
}
const json = (res: ServerResponse, status: number, b: unknown) => send(res, status, {}, b);

run(async () => {
  const phase = process.argv[2] ?? "report";
  if (phase === "sponsored") await phaseSponsored(Number(process.argv[3] ?? 3));
  else if (phase === "plain") await phasePlain();
  else if (phase === "concurrent") await phaseConcurrent();
  else if (phase === "negatives") await phaseNegatives();
  else if (phase !== "report") throw new Error(`unknown phase ${phase}`);
  if (phase === "report") await phaseReport();
});
