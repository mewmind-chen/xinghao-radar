import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  APP_ROLES,
  DEFAULT_PERMISSION_GROUPS,
  PERMISSION_GROUP_KEYS,
  PERMISSION_GROUP_LABELS,
  ROLE_TO_PERMISSION_GROUP,
  permissionsFromGroupRow,
  scopeForPermissions,
} from "../src/lib/auth/roles.ts";

async function schema() {
  const db = new PGlite();
  for (const file of [
    "migrations/auth/0001_auth.sql",
    "migrations/0002_schema.sql",
    "migrations/0003_part_analyses.sql",
    "migrations/0004_part_analysis_review.sql",
    "migrations/0005_inventory_lot_lineage.sql",
    "migrations/0006_auth_roles_potential.sql",
  ]) {
    await db.exec(await readFile(file, "utf8"));
  }
  return db;
}

test("空库创建四个固定同名权限组，用户表不保存个人权限覆盖", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  const groups = await db.query("select role_key, display_name, permissions from permission_groups order by role_key");
  assert.equal(groups.rows.length, 4);
  for (const role of APP_ROLES) {
    const key = ROLE_TO_PERMISSION_GROUP[role];
    const row = groups.rows.find((item) => item.role_key === key);
    assert.ok(row, `missing ${key}`);
    assert.equal(row.display_name, PERMISSION_GROUP_LABELS[key]);
    assert.deepEqual(permissionsFromGroupRow(role, row), [...DEFAULT_PERMISSION_GROUPS[key]]);
  }
  const columns = await db.query("select column_name from information_schema.columns where table_name = 'app_users'");
  assert.equal(columns.rows.some((row) => row.column_name === "potential_enabled"), false);
  assert.equal(columns.rows.some((row) => row.column_name === "permission_group_id"), false);
  assert.deepEqual(PERMISSION_GROUP_KEYS, ["boss", "inspector", "manager", "follower"]);
});

test("同角色多人共享数据库权限组，权限组变更后同时生效", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  await db.exec(`
    insert into "user" ("id", "name", "email", "emailVerified") values
      ('u-manager-1', '验收主管一', 'manager1@test.local', true),
      ('u-manager-2', '验收主管二', 'manager2@test.local', true),
      ('u-follower-1', '验收跟进一', 'follower1@test.local', true),
      ('u-follower-2', '验收跟进二', 'follower2@test.local', true);
    insert into app_users (user_id, email, display_name, role) values
      ('u-manager-1', 'manager1@test.local', '验收主管一', '主管'),
      ('u-manager-2', 'manager2@test.local', '验收主管二', '主管'),
      ('u-follower-1', 'follower1@test.local', '验收跟进一', '跟进人'),
      ('u-follower-2', 'follower2@test.local', '验收跟进二', '跟进人');
  `);

  const groupFor = async (role) => {
    const rows = await db.query("select role_key, display_name, permissions from permission_groups where role_key = $1", [ROLE_TO_PERMISSION_GROUP[role]]);
    return permissionsFromGroupRow(role, rows.rows[0]);
  };
  const managerBefore = await groupFor("主管");
  assert.ok(managerBefore.includes("market.write"));
  assert.deepEqual(await groupFor("主管"), managerBefore);
  await db.query("update permission_groups set permissions = $1::text[] where role_key = 'manager'", [["model.read", "stock.read"]]);
  const managerAfter = await groupFor("主管");
  assert.deepEqual(managerAfter, ["model.read", "stock.read"]);
  assert.equal(managerAfter.includes("market.write"), false);
  assert.equal((await db.query("select count(*)::int as n from app_users where role = '主管'")).rows[0].n, 2);

  const followerDefault = await groupFor("跟进人");
  assert.equal(followerDefault.includes("potential.read"), false);
  await db.query("update permission_groups set permissions = $1::text[] where role_key = 'follower'", [["model.read", "stock.read", "potential.read", "potential.write"]]);
  const followerAfter = await groupFor("跟进人");
  assert.equal(followerAfter.includes("potential.read"), true);
  assert.equal(scopeForPermissions("跟进人", followerAfter), "own");
  assert.equal((await db.query("select count(*)::int as n from app_users where role = '跟进人'")).rows[0].n, 2);
});

test("权限组必须严格匹配固定角色并在损坏时 fail closed", () => {
  const row = { role_key: "manager", display_name: "主管权限组", permissions: ["model.read"] };
  assert.deepEqual(permissionsFromGroupRow("主管", row), ["model.read"]);
  assert.equal(permissionsFromGroupRow("老板", row), null);
  assert.equal(permissionsFromGroupRow("主管", { ...row, display_name: "老板权限组" }), null);
  assert.equal(permissionsFromGroupRow("主管", { ...row, permissions: ["model.read", "not-a-permission"] }), null);
  assert.equal(permissionsFromGroupRow("主管", { ...row, permissions: ["model.read", "model.read"] }), null);
  assert.equal(permissionsFromGroupRow("主管", { ...row, permissions: "{model.read}" }), null);
  assert.equal(
    permissionsFromGroupRow("主管", { ...row, permissions: ["model.read", "settings.manage"] }),
    null,
    "系统设置管理权只能属于老板权限组",
  );
});
