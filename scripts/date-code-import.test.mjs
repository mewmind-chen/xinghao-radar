import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDateCodeToken, resolveDateCode } from "../src/lib/inventory/date-code.ts";

test("DC normalization accepts YY+ and YYWW+ and rejects invalid weeks", () => {
  assert.equal(normalizeDateCodeToken("26+"), "26+");
  assert.equal(normalizeDateCodeToken("2607+"), "2607+");
  assert.equal(normalizeDateCodeToken("2653+"), "2653+");
  assert.equal(normalizeDateCodeToken("2654+"), null);
  assert.equal(normalizeDateCodeToken("2024年以后"), "24+");
  assert.equal(resolveDateCode("包装文字 2607+", 30000, "2000").dateCode, "2607+");
});

test("DC quantities split only when package evidence proves the total", () => {
  const split = resolveDateCode("6包2607+9包2548+", 30000, "2000");
  assert.equal(split.warning, null);
  assert.deepEqual(split.splits, [
    { dateCode: "2607+", qty: 12000 },
    { dateCode: "2548+", qty: 18000 },
  ]);

  const blocked = resolveDateCode("2607+2548+", 30000, "2000");
  assert.equal(blocked.splits.length, 0);
  assert.match(blocked.warning ?? "", /不能猜测/);
});
