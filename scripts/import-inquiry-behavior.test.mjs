import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestHandler } from "@tanstack/start-server-core";
import { createServer } from "vite";
import { runWithStartContext } from "@tanstack/start-storage-context";

test("inquiry import keeps the selected kind and writes multiple exact customers", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "xinghao-radar-inquiry-import-"));
  process.env.DATABASE_URL = "";
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_INITIAL_BOSS_EMAIL = "inquiry.owner@local.test";
  process.env.VITE_AUTH_ENABLED = "true";

  const vite = await createServer({
    root: process.cwd(),
    server: { middlewareMode: true },
    appType: "custom",
  });
  const contextFor = (request) => ({
    getRouter: () => ({}),
    request,
    startOptions: {},
    contextAfterGlobalMiddlewares: {},
    executedRequestMiddlewares: new Set(),
    handlerType: "serverFn",
  });
  let sessionToken;
  const invoke = async (fn, data) => {
    let envelope;
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
    });
    const handler = requestHandler((requestIn) =>
      runWithStartContext(contextFor(requestIn), async () => {
        envelope = await fn({ data });
        return new Response(JSON.stringify(envelope));
      }),
    );
    await handler(request);
    if (envelope?.error) throw envelope.error;
    return envelope?.result ?? envelope;
  };
  const row = (mpn, kind, customer, qty = 1) => ({
    id: crypto.randomUUID(),
    kind,
    mpn,
    brand: null,
    qty,
    qtyRaw: String(qty),
    dateCode: null,
    priceAmount: null,
    priceCurrency: null,
    priceTax: null,
    isTp: false,
    leadTimeText: null,
    etaText: null,
    warehouse: null,
    channel: null,
    customer,
    package: null,
    standardPack: null,
    packState: null,
    costAmount: null,
    costCurrency: null,
    costTax: null,
    note: null,
    duplicate: false,
    duplicateReason: null,
    selected: true,
    warning: null,
  });

  try {
    const auth = await vite.ssrLoadModule("/src/lib/auth/server.ts?inquiry-import-behavior");
    const imports = await vite.ssrLoadModule(
      "/src/lib/server/import.ts?tss-serverfn-split&inquiry-import-behavior",
    );
    const settings = await vite.ssrLoadModule(
      "/src/lib/server/settings.ts?tss-serverfn-split&inquiry-import-behavior",
    );
    const db = await vite.ssrLoadModule("/src/lib/db.ts?inquiry-import-behavior");
    const sql = await db.getSql();
    const authContext = await auth.auth.$context;
    const owner = await authContext.internalAdapter.createUser({
      email: "inquiry.owner@local.test",
      name: "Inquiry Import Owner",
      image: null,
      emailVerified: false,
    });
    await sql`insert into app_users (user_id, email, display_name, role, status) values (${owner.id}, ${owner.email}, ${owner.name}, '老板', 'active')`;
    sessionToken = (await authContext.internalAdapter.createSession(owner.id)).token;

    const inquiryImport = await invoke(imports.confirmImport_createServerFn_handler, {
      kind: "inquiry",
      sourceType: "text",
      defaultCustomer: "只补空客户",
      rows: [
        row("BEHAVIOR-INQUIRY-A", "offer", "精确客户甲", 2),
        row("BEHAVIOR-INQUIRY-B", "inquiry", "精确客户乙", 3),
      ],
    });
    assert.equal(inquiryImport.writtenCount, 2);
    assert.equal(inquiryImport.writtenByKind.inquiry, 2);
    assert.equal(inquiryImport.writtenByKind.offer, 0);
    assert.equal(inquiryImport.customerCount, 2);
    assert.equal(
      Number(
        (
          await sql.query(
            "select count(*)::int as n from customer_inquiries where import_batch_id = $1",
            [inquiryImport.batchId],
          )
        )[0].n,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          await sql.query(
            "select count(*)::int as n from channel_offers where import_batch_id = $1",
            [inquiryImport.batchId],
          )
        )[0].n,
      ),
      0,
    );
    const customerNames = await sql.query(
      "select c.name from customer_inquiries i join customers c on c.id = i.customer_id where i.import_batch_id = $1 order by c.name",
      [inquiryImport.batchId],
    );
    assert.deepEqual(
      new Set(customerNames.map((item) => item.name)),
      new Set(["精确客户甲", "精确客户乙"]),
    );
    const batches = await invoke(settings.listImportBatches_createServerFn_handler);
    const listedInquiry = batches.find((batch) => batch.id === inquiryImport.batchId);
    assert.equal(listedInquiry.writtenRows, 2);
    assert.match(listedInquiry.context, /^客户：精确客户[甲乙]等2个$/);

    const offerImport = await invoke(imports.confirmImport_createServerFn_handler, {
      kind: "offer",
      sourceType: "text",
      defaultChannel: "行为渠道",
      rows: [row("BEHAVIOR-OFFER-A", "inquiry", "误判客户", 4)],
    });
    assert.equal(offerImport.writtenCount, 1);
    assert.equal(offerImport.writtenByKind.offer, 1);
    assert.equal(offerImport.writtenByKind.inquiry, 0);
    assert.equal(
      Number(
        (
          await sql.query(
            "select count(*)::int as n from channel_offers where import_batch_id = $1",
            [offerImport.batchId],
          )
        )[0].n,
      ),
      1,
    );

    await assert.rejects(
      () =>
        invoke(imports.confirmImport_createServerFn_handler, {
          kind: "inquiry",
          sourceType: "text",
          rows: [row("BEHAVIOR-INQUIRY-MISSING", "inquiry", null)],
        }),
      /缺少客户/,
    );
  } finally {
    await vite.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
