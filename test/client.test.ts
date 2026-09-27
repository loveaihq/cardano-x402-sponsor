// The client scheme's hook: a payment that did not settle gives its inputs back to the wallet.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { SponsoredExactCardanoClient, type SponsoredClientSigner } from "../src/client.ts";
import { offer, sponsoredTx } from "./fixtures.ts";

function fakeSigner() {
  const released: string[] = [];
  const signer: SponsoredClientSigner = {
    getAddress: () => "addr_test1",
    buildAndSignPaymentTransaction: async () => ({ transaction: "", nonce: "" }),
    last: () => undefined,
    release: (hex) => void released.push(hex),
  };
  return { signer, released };
}

const ctx = (hex: string, success?: boolean) =>
  ({
    paymentPayload: { x402Version: 2, accepted: {} as PaymentRequirements, payload: { transaction: Buffer.from(hex, "hex").toString("base64"), nonce: "" } } as PaymentPayload,
    requirements: {} as PaymentRequirements,
    ...(success === undefined ? {} : { settleResponse: { success, transaction: "", network: "cardano:preprod" } }),
  }) as never;

test("a settled payment keeps its inputs spent; a refused one releases them", async () => {
  const { signer, released } = fakeSigner();
  const scheme = new SponsoredExactCardanoClient(signer);
  const hex = sponsoredTx(offer());
  await scheme.schemeHooks.onPaymentResponse!(ctx(hex, true));
  assert.deepEqual(released, []);
  await scheme.schemeHooks.onPaymentResponse!(ctx(hex));
  await scheme.schemeHooks.onPaymentResponse!(ctx(hex, false));
  assert.deepEqual(released, [hex, hex]);
  assert.equal(scheme.scheme, "exact");
});
