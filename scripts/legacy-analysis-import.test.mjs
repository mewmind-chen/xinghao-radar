import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importLegacyRows, readLegacyRows } from "./import-legacy-analyses.mjs";

test("legacy analysis import is read-only at source and keeps the newest target row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-legacy-analysis-"));
  const source = join(dir, "analyses.db");
  try {
    const legacy = new DatabaseSync(source);
    legacy.exec("create table part_analyses (mpn_key text primary key, mpn text, analyzed_at text, source_url text, analysis text)");
    legacy.prepare("insert into part_analyses values (?, ?, ?, ?, ?)").run(
      "NE555P", "NE555P", "2026-08-23T00:00:00.000Z", null, '{"legacy":true}',
    );
    legacy.close();

    const writes = [];
    const count = await importLegacyRows(readLegacyRows(source), {
      async query(sql, params) { writes.push({ sql, params }); },
    });
    assert.equal(count, 1);
    assert.equal(writes[0].params[0], "NE555P");
    assert.match(writes[0].sql, /where part_analyses\.analyzed_at <= excluded\.analyzed_at/i);

    const verify = new DatabaseSync(source, { readOnly: true });
    assert.equal(verify.prepare("select count(*) as n from part_analyses").get().n, 1);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
