import { createServer } from "vite";

process.env.DATABASE_URL = "";
process.env.DATA_DIR ||=
  "C:/Users/13537/AppData/Local/xinghao-radar/preview-import-experience-8080";
const email = process.env.PREVIEW_EMAIL || "preview.boss@example.com";
const password = process.env.PREVIEW_PASSWORD;
if (!password) {
  throw new Error("请通过 PREVIEW_PASSWORD 提供本地预览密码");
}
process.env.AUTH_INITIAL_BOSS_EMAIL ||= email;
process.env.VITE_AUTH_ENABLED ||= "true";

const vite = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const auth = await vite.ssrLoadModule("/src/lib/auth/server.ts?local-preview-seed");
  const db = await vite.ssrLoadModule("/src/lib/db.ts?local-preview-seed");
  const sql = await db.getSql();
  const existing = await sql`select id from "user" where email = ${email} limit 1`;
  let user = existing[0];
  if (!user) {
    const context = await auth.auth.$context;
    user = await context.internalAdapter.createUser({
      email,
      name: "本地预览老板",
      image: null,
      emailVerified: false,
    });
    const hash = await context.password.hash(password);
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: hash,
    });
  }
  await sql`
    insert into app_users (user_id, email, display_name, role, status)
    values (${user.id}, ${email}, '本地预览老板', '老板', 'active')
    on conflict (user_id) do update set role = '老板', status = 'active', email = excluded.email, display_name = excluded.display_name, updated_at = now()
  `;
  console.log(JSON.stringify({ ok: true, email, userId: String(user.id), role: "老板" }));
} finally {
  await vite.close();
}
