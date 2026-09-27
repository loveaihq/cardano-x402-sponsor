// Read-only: a transaction's CBOR size from Blockfrost, its fee, and the ledger floor for that size.
import { bf, log } from "./env.ts";
for (const h of process.argv.slice(2)) {
  const c = await bf<{ cbor: string }>(`/txs/${h}/cbor`);
  const t = await bf<{ fees: string; size: number }>(`/txs/${h}`);
  const bytes = c!.cbor.length / 2;
  log(`${h.slice(0, 16)}… cbor ${bytes} B (Blockfrost size ${t!.size}), fee ${t!.fees}, floor ${155_381 + 44 * bytes}`);
}
