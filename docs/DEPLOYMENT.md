# 型号雷达部署说明

## 数据库模式

数据库模式由 `RADAR_DB_MODE` 明确决定，允许值只有：

- `pglite`：使用持久化 PGlite，数据库目录是 `<DATA_DIR>/pglite`。
- `postgres`：使用 Postgres，必须提供 `DATABASE_URL`。

生产环境必须显式配置 `RADAR_DB_MODE`。`RADAR_RUNTIME=production` 只表达运行环境，
不能单独决定数据库类型。PGlite 模式不得同时配置 `DATABASE_URL`，避免部署误连另一套库。

## 生产 PGlite

生产使用 PGlite 时：

1. `RADAR_DB_MODE=pglite`。
2. `DATA_DIR` 指向已经存在、可读写且稳定的共享数据根目录。
3. 应用实际打开 `<DATA_DIR>/pglite`；release 目录必须与 data 目录分开。
4. 更新 release 只能替换构建产物，不得删除或替换 data 目录。
5. 缺少目录、目录不是目录、无权限、数据库打不开或迁移失败时，进程必须失败；不会创建临时库、内存库或新的空库。
6. 首次切换前先备份整个 data 目录，并在副本上演练迁移和重启。

示例环境变量（路径由部署方填写，不写入源码）：

```text
RADAR_RUNTIME=production
RADAR_DB_MODE=pglite
DATA_DIR=/srv/xinghao-radar/data
RADAR_PORT=8082
```

## Postgres

使用 Postgres 时：

```text
RADAR_RUNTIME=production
RADAR_DB_MODE=postgres
DATABASE_URL=postgres://...
```

缺少 `DATABASE_URL` 会拒绝启动。PGlite 到 Postgres 的迁移不是变量切换，必须另行完成备份、
转换、逐项核对、回滚演练和上线后核实。

## 构建、迁移和启动

```bash
npm ci
npm run build
npm run serve:production
```

`npm run build` 在 Postgres 模式下执行 `DATABASE_URL` 迁移；PGlite 模式的迁移在应用启动时
对指定的持久目录执行。迁移按 `_migrations` 记录，重复启动不会重复执行。

## launchd 建议

launchd 应在 `EnvironmentVariables` 中保留或增加 `RADAR_RUNTIME`、`RADAR_DB_MODE`、
`DATA_DIR`、`RADAR_PORT`、`RADAR_HOST`、`RADAR_OUTPUT_DIR` 和 `RADAR_RELEASE`。真实 plist
应由部署方在目标机器上人工修改和复核；本仓库只提供变量约定，不直接修改生产服务。

上线前应检查：`/healthz`、登录会话、现有数据可读、写入一条无敏感测试数据后重启仍存在，
并确认服务日志没有输出密码或完整连接字符串。
