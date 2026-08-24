import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateToImportRow } from "../src/lib/server/agent-platform.ts";
import { platformPartToHqb, mapHqbResponse } from "../src/lib/server/knowledge-map.ts";

test("platform candidate becomes Radar preview row; write flags stay local", () => {
  const row = candidateToImportRow(
    { kind: "offer", mpn: "TPS54560DDAR", qty: 10000, warnings: [{ message: "qty conflict" }] },
    "offer",
  );
  assert.equal(row.mpn, "TPS54560DDAR");
  assert.equal(row.qty, 10000);
  assert.equal(row.selected, true);
  assert.equal(row.duplicate, false);
  assert.match(row.warning ?? "", /qty conflict/);
});

test("platform part research maps into existing knowledge panel fields", () => {
  const mapped = mapHqbResponse(
    platformPartToHqb({
      ok: true,
      identity: { mpn: "NE555P", brand: "TI", lcscUrl: "https://item.szlcsc.com/1.html", lcscStock: 10 },
      offers: [{ sourceKey: "lcsc", stock: 10, price: 1.2 }],
      dossier: { headline: "555 timer", extra: { what: "通用定时器" } },
    }),
  );
  assert.equal(mapped.ok, true);
  assert.equal(mapped.resolvedMpn, "NE555P");
  assert.equal(mapped.lcsc?.stock, 10);
});
