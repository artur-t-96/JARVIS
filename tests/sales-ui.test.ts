import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
const { salesAmount, salesAvailable, salesScaled } = await tsImport(
  "../web/src/Sales.tsx",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
  },
);
import type { Entity } from "../web/src/types.js";
test("sales form preserves decimal intent and offers no acceptance shortcut", () => {
  assert.equal(salesScaled("123,45", 2), 12345);
  assert.equal(salesScaled("0.125", 3), 125);
  assert.throws(() => salesScaled("1,234", 2));
  assert.throws(() => salesScaled("1e3", 2));
  assert.throws(() => salesScaled("-1", 2));
  assert.match(salesAmount(12345, "PLN"), /123,45 PLN/);
  const e = { data: { kind: "offer" }, status: "draft" } as Entity;
  assert.equal(salesAvailable(e, false).includes("acceptOffer"), false);
  assert.deepEqual(salesAvailable({ ...e, status: "sent" }, true), [
    "cancelOffer",
  ]);
  assert.equal(
    salesAvailable({ ...e, status: "accepted" }, false).includes("reviseOffer"),
    false,
  );
});
