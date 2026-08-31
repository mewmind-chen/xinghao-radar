import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";

const startContextModule = new URL(
  "../node_modules/.pnpm/node_modules/@tanstack/start-storage-context/dist/esm/index.js",
  import.meta.url,
);
const requestResponseModule = new URL(
  "../node_modules/.pnpm/node_modules/@tanstack/start-server-core/dist/esm/request-response.js",
  import.meta.url,
);

test("user lifecycle uses real auth sessions, fixed role groups, and last-boss protection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "xinghao-radar-user-lifecycle-"));
  process.env.DATABASE_URL = "";
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_INITIAL_BOSS_EMAIL = "owner@local.test";
  process.env.VITE_AUTH_ENABLED = "true";

  const { runWithStartContext } = await import(startContextModule.href);
  const { requestHandler } = await import(requestResponseModule.href);
  const vite = await createServer({
    root: process.cwd(),
    server: { middlewareMode: true },
    appType: "custom",
  });

  const passwordFor = (label) => `Lifecycle-${label}-260901!`;
  const users = new Map();

  try {
    const auth = await vite.ssrLoadModule("/src/lib/auth/server.ts?user-lifecycle-test");
    const db = await vite.ssrLoadModule("/src/lib/db.ts?user-lifecycle-test");
    const serverAuth = await vite.ssrLoadModule("/src/lib/server/auth.ts?tss-serverfn-split&user-lifecycle-test");
    const sql = await db.getSql();
    const authContext = await auth.auth.$context;

    async function seedUser(email, name, role, password, status = "active") {
      const user = await authContext.internalAdapter.createUser({ email, name, image: null, emailVerified: false });
      const hash = await authContext.password.hash(password);
      await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
      await sql`insert into app_users (user_id, email, display_name, role, status) values (${user.id}, ${email}, ${name}, ${role}, ${status})`;
      users.set(email, { ...user, email, password });
      return user;
    }

    async function sessionFor(userId) {
      return authContext.internalAdapter.createSession(userId);
    }

    function contextFor(request, token) {
      return {
        getRouter: () => ({}),
        request,
        startOptions: {},
        contextAfterGlobalMiddlewares: { bearerToken: token },
        executedRequestMiddlewares: new Set(),
        handlerType: "serverFn",
      };
    }

    async function invoke(fn, data, session) {
      const token = session?.token;
      const request = new Request("http://localhost:8086/", {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      let envelope;
      const handler = requestHandler((requestIn) => runWithStartContext(
        contextFor(requestIn, token),
        async () => {
          envelope = await fn({ data });
          return new Response(JSON.stringify(envelope));
        },
      ));
      await handler(request);
      if (envelope?.error) throw envelope.error;
      return envelope?.result ?? envelope;
    }

    async function expectRejected(action, pattern) {
      await assert.rejects(action, (error) => {
        assert.match(String(error?.message ?? error), pattern);
        return true;
      });
    }

    async function authRequest(path, body) {
      const response = await auth.auth.handler(new Request(`http://localhost:8086${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8086" },
        body: JSON.stringify(body),
      }));
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* keep non-JSON response as status evidence */ }
      return { response, parsed };
    }

    const owner = await seedUser("owner@local.test", "本地老板", "老板", passwordFor("owner"));
    const ownerSession = await sessionFor(owner.id);

    // Public sign-up is closed: all business users are created by the boss API.
    const publicSignup = await authRequest("/api/auth/sign-up/email", {
      name: "Public Signup",
      email: "public-signup@local.test",
      password: passwordFor("public"),
    });
    assert.ok(publicSignup.response.status >= 400, "public sign-up must not create users");

    const created = {};
    for (const [role, suffix] of [["最高督察", "inspector"], ["主管", "manager"], ["跟进人", "follower"], ["跟进人", "follower-two"]]) {
      const email = `${suffix}@local.test`;
      const result = await invoke(serverAuth.createAppUser_createServerFn_handler, {
        name: `新建${suffix}`,
        email,
        password: passwordFor(suffix),
        passwordConfirmation: passwordFor(suffix),
        role,
        status: "active",
      }, ownerSession);
      assert.equal(result.role, role);
      assert.equal(result.permissionGroupName, `${role}权限组`);
      assert.equal(Object.keys(result).some((key) => /password|hash/i.test(key)), false);
      created[email] = result;
    }
    await expectRejected(() => invoke(serverAuth.createAppUser_createServerFn_handler, {
      name: "Duplicate",
      email: " MANAGER@LOCAL.TEST ",
      password: passwordFor("duplicate"),
      passwordConfirmation: passwordFor("duplicate"),
      role: "主管",
      status: "active",
    }, ownerSession), /登录账号已存在/);
    await expectRejected(() => invoke(serverAuth.createAppUser_createServerFn_handler, {
      name: "Mismatch",
      email: "mismatch@local.test",
      password: passwordFor("mismatch"),
      passwordConfirmation: passwordFor("other"),
      role: "主管",
      status: "active",
    }, ownerSession), /不一致/);
    await expectRejected(() => invoke(serverAuth.createAppUser_createServerFn_handler, {
      name: "Missing Role",
      email: "missing-role@local.test",
      password: passwordFor("missing-role"),
      passwordConfirmation: passwordFor("missing-role"),
      role: null,
      status: "active",
    }, ownerSession), /角色/);

    const regularSession = await sessionFor(created["manager@local.test"].userId);
    await expectRejected(() => invoke(serverAuth.createAppUser_createServerFn_handler, {
      name: "Attacker",
      email: "attacker@local.test",
      password: passwordFor("attacker"),
      passwordConfirmation: passwordFor("attacker"),
      role: "老板",
      status: "active",
    }, regularSession), /老板|无权/);
    await expectRejected(() => invoke(serverAuth.setUserPassword_createServerFn_handler, {
      targetUserId: created["follower@local.test"].userId,
      newPassword: passwordFor("attack-password"),
      newPasswordConfirmation: passwordFor("attack-password"),
    }, regularSession), /老板|无权/);
    await expectRejected(() => invoke(serverAuth.updateAppUser_createServerFn_handler, {
      userId: created["follower@local.test"].userId,
      role: "老板",
    }, regularSession), /老板|无权/);
    await expectRejected(() => invoke(serverAuth.updateAppUser_createServerFn_handler, {
      userId: created["manager@local.test"].userId,
      status: "disabled",
    }, regularSession), /老板|无权/);
    await expectRejected(() => invoke(serverAuth.updateAppUser_createServerFn_handler, {
      userId: created["manager@local.test"].userId,
      role: "老板",
      permissions: ["users.manage"],
    }, ownerSession), /参数|用户/);
    await expectRejected(() => invoke(serverAuth.updatePermissionGroup_createServerFn_handler, {
      role: "跟进人",
      permissions: ["model.read"],
      userId: created["manager@local.test"].userId,
    }, ownerSession), /权限组/);
    await expectRejected(() => invoke(serverAuth.updateAppUser_createServerFn_handler, {
      userId: owner.id,
      role: "主管",
    }, ownerSession), /自己的角色或状态/);

    // Profile edits keep the stable user id and fixed role-group mapping.
    const beforeEdit = created["follower@local.test"].userId;
    const edited = await invoke(serverAuth.updateAppUser_createServerFn_handler, {
      userId: beforeEdit,
      name: "改名跟进人",
      email: "renamed-follower@local.test",
      role: "最高督察",
      status: "active",
    }, ownerSession);
    assert.equal(edited.userId, beforeEdit);
    assert.equal(edited.displayName, "改名跟进人");
    assert.equal(edited.email, "renamed-follower@local.test");
    assert.equal(edited.permissionGroupName, "最高督察权限组");
    assert.equal((await sql`select user_id from app_users where user_id = ${beforeEdit}`)[0].user_id, beforeEdit);

    // A boss-assigned password is immediately usable; old password is rejected.
    const target = created["manager@local.test"];
    const targetOldSession = await sessionFor(target.userId);
    const assignedPassword = passwordFor("assigned");
    await invoke(serverAuth.setUserPassword_createServerFn_handler, {
      targetUserId: target.userId,
      newPassword: assignedPassword,
      newPasswordConfirmation: assignedPassword,
    }, ownerSession);
    const oldLogin = await authRequest("/api/auth/sign-in/email", { email: target.email, password: target.password });
    assert.ok(oldLogin.response.status >= 400, "old password must stop working");
    const newLogin = await authRequest("/api/auth/sign-in/email", { email: target.email, password: assignedPassword });
    assert.equal(newLogin.response.status, 200, "boss-assigned password must log in directly");
    await expectRejected(() => invoke(serverAuth.getCurrentAccess_createServerFn_handler, {}, targetOldSession), /Unauthorized|会话/);

    // Self-service password change verifies the current password and revokes all sessions.
    const targetFreshSession = await sessionFor(target.userId);
    const selfPassword = passwordFor("self-change");
    await expectRejected(() => invoke(serverAuth.changeOwnPassword_createServerFn_handler, {
      currentPassword: passwordFor("wrong-current"),
      newPassword: selfPassword,
      newPasswordConfirmation: selfPassword,
    }, targetFreshSession), /当前密码/);
    await invoke(serverAuth.changeOwnPassword_createServerFn_handler, {
      currentPassword: assignedPassword,
      newPassword: selfPassword,
      newPasswordConfirmation: selfPassword,
    }, targetFreshSession);
    await expectRejected(() => invoke(serverAuth.getCurrentAccess_createServerFn_handler, {}, targetFreshSession), /Unauthorized|会话/);
    const oldSelfLogin = await authRequest("/api/auth/sign-in/email", { email: target.email, password: assignedPassword });
    assert.ok(oldSelfLogin.response.status >= 400);
    const freshSelfLogin = await authRequest("/api/auth/sign-in/email", { email: target.email, password: selfPassword });
    assert.equal(freshSelfLogin.response.status, 200);

    // Disable/re-enable revokes sessions and preserves the user row.
    const follower = created["follower-two@local.test"];
    const followerSession = await sessionFor(follower.userId);
    await invoke(serverAuth.updateAppUser_createServerFn_handler, { userId: follower.userId, status: "disabled" }, ownerSession);
    await expectRejected(() => invoke(serverAuth.getCurrentAccess_createServerFn_handler, {}, followerSession), /Unauthorized|停用|会话/);
    await invoke(serverAuth.updateAppUser_createServerFn_handler, { userId: follower.userId, status: "active" }, ownerSession);
    const reenabledSession = await sessionFor(follower.userId);
    const reenabledAccess = await invoke(serverAuth.getCurrentAccess_createServerFn_handler, {}, reenabledSession);
    assert.equal(reenabledAccess.status, "active");
    assert.equal((await sql`select user_id from app_users where user_id = ${follower.userId}`)[0].user_id, follower.userId);

    // Two valid bosses race to demote each other: one operation succeeds, one
    // is rejected after the transaction re-counts active bosses.
    const secondBoss = await invoke(serverAuth.createAppUser_createServerFn_handler, {
      name: "并发老板",
      email: "second-owner@local.test",
      password: passwordFor("second-owner"),
      passwordConfirmation: passwordFor("second-owner"),
      role: "老板",
      status: "active",
    }, ownerSession);
    const secondBossSession = await sessionFor(secondBoss.userId);
    const [raceA, raceB] = await Promise.allSettled([
      invoke(serverAuth.updateAppUser_createServerFn_handler, { userId: owner.id, role: "主管" }, secondBossSession),
      invoke(serverAuth.updateAppUser_createServerFn_handler, { userId: secondBoss.userId, role: "主管" }, ownerSession),
    ]);
    assert.equal([raceA, raceB].filter((result) => result.status === "fulfilled").length, 1);
    assert.equal([raceA, raceB].filter((result) => result.status === "rejected").length, 1);
    const bossCount = await sql`select count(*)::int as count from app_users where role = '老板' and status = 'active'`;
    assert.equal(Number(bossCount[0].count), 1, "concurrent demotion must retain one active boss");

    const listed = await invoke(serverAuth.listAppUsers_createServerFn_handler, {}, ownerSession).catch(async () => invoke(serverAuth.listAppUsers_createServerFn_handler, {}, secondBossSession));
    const listedText = JSON.stringify(listed);
    assert.equal(/password|passwordHash|hash/i.test(listedText), false, "user API must not return password fields");
    assert.ok(listed.some((user) => user.permissionGroupName === "跟进人权限组"));
  } finally {
    await vite.close();
  }
});
