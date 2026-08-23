import assert from "node:assert/strict";
import test from "node:test";
import { ALL_SEAPORT_ADDRESSES, SEAPORT_DEPLOYMENTS, seaportVersionForAddress } from "../../lib/market/multichain/seaport-deployments";

test("canonical Seaport history includes every version from 1.1 through 1.6", () => {
  assert.deepEqual(SEAPORT_DEPLOYMENTS.map((entry) => entry.version), ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"]);
  assert.equal(new Set(ALL_SEAPORT_ADDRESSES.map((address) => address.toLowerCase())).size, 6);
  assert.equal(seaportVersionForAddress("0x00000000000000adc04c56bf30ac9d3c0aaf14dc"), "1.5");
});
