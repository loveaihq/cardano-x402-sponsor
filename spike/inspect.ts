// Read-only: what the chain says about a transaction, and the blocks around a time window.
import { bf, log } from "./env.ts";

const [txHash, from, to] = process.argv.slice(2);
const tx = await bf<Record<string, unknown>>(`/txs/${txHash}`);
log(`tx ${txHash}: ${tx ? `in block ${tx.block_height} at ${new Date(Number(tx.block_time) * 1000).toISOString()}` : "not on chain"}`);
if (from && to) {
  const latest = (await bf<{ hash: string; height: number; time: number }>(`/blocks/latest`))!;
  const prev = (await bf<Array<{ height: number; time: number; tx_count: number }>>(`/blocks/${latest.hash}/previous?count=100`)) ?? [];
  const lo = Date.parse(from) / 1000;
  const hi = Date.parse(to) / 1000;
  let last = 0;
  for (const b of [...prev, latest as unknown as { height: number; time: number; tx_count: number }]) {
    if (b.time < lo || b.time > hi) continue;
    log(`block ${b.height} ${new Date(b.time * 1000).toISOString().slice(11, 19)} txs ${b.tx_count}${last ? ` gap ${b.time - last} s` : ""}`);
    last = b.time;
  }
}
