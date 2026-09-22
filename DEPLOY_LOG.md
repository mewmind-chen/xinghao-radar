# 部署记录

本文件只记录生产版本元数据，不保存生产数据、日志、密钥或环境变量真实值。记录规范见《开发到生产_PR部署流程规范.md》§12；每次生产部署后追加一条，顺序为「新的在上」。

---

## AI 导入通道当前状态（2026-09-11 11:38 CST 核验）

生产链路已配置为 `command-code,deepseek-api,openrouter`，服务已重载。使用生产进程配置执行合成报价提取，主链命中 `command-code`；独立验证进程移除主通道凭据后，备用命中 `deepseek-api`。验证未写入业务数据，不代表每个上游持续可用。

| 通道 | 所需环境变量 | 生产现状 |
| --- | --- | --- |
| `command-code`（主力） | `COMMAND_CODE_API_KEY` | 已写入 plist；真实提取成功 |
| `opencode-go` | `OPENCODE_GO_API_KEY`、`OPENCODE_SESSION_ID` | 本次显式排除（此前验证月额度用尽） |
| `deepseek-api`（备用） | `DEEPSEEK_API_KEY` | 已写入 plist；独立降级验证成功 |
| `openrouter`（观察位） | `OPENROUTER_API_KEY` | ✅ 已配置（**在 launchd GUI 域，plist 内没有**） |
| 链路顺序 | `IMPORT_CHAIN` | `command-code,deepseek-api,openrouter`；预算 180000ms |

机制说明（避免再次误判）：

- 引擎按 `IMPORT_CHAIN` 逐通道尝试（未配置时用内置默认链 `command-code,opencode-go,deepseek-api,openrouter`）；每个通道的 `available()` **只认 `process.env[<apiKeyEnv>]`**，取不到即判不可用并**静默跳过**，不打日志、不报错。
- **生产进程读 env 的唯一来源是 launchd**：plist 的 `EnvironmentVariables` + 继承 GUI 域。`scripts/serve-production.mjs` 不加载 dotenv；生产目录只有 `.env.example`（无 `.env`）。代码**不会**去读 `~/.commandcode/auth.json` / `~/.dsh/.credentials.yaml` / `~/.deepseek/config.toml`。
- 因此 **任何代码 PR 都不可能让生产自动获得 key**（密钥又受规范 §9 禁止入库）。必须执行一次
  `./scripts/set-import-keys.sh --apply --reload --chain=command-code,deepseek-api,openrouter`（该脚本会写 plist 并 `launchctl unload/load`，**生产服务会中断数秒**）。写进 plist 的键**不会被后续自动部署冲掉**（`activateRelease()` 只 `plutil -replace` `RADAR_OUTPUT_DIR` / `RADAR_RELEASE` 两个键，失败时整份 plist 备份回滚）。
- `OPENROUTER_API_KEY` 仍只在 GUI 域、plist 里没有；机器重启后该兜底可能缺失。两个已持久化的直连通道不受此影响。
- ⚠️ `IMPORT_MODEL` 仍是 `google/gemini-3.8-flash`；prompt v2 只在 DeepSeek 系做过回归，gemini 上未单独验证。
- **如何验证链路真的切过去了**：导入一次后查服务端 `runs[].channel`，或看预览标题 `· <通道名> AI 识别`。⚠️ 该标题在 PR23 之前的线上版本里是**写死的「OpenRouter AI 识别」**，不能当作判据。
- 当前运行 release 仍是 PR23 的 `20260911-030851-main-0c889fc2dbd3`；健康接口的通道可见性修复随本分支的代码 PR 发布 —— `/healthz` 将新增 `importChain` / `importChannels` / `importReady` / `importSummary` / `importWarnings`，部署完成前它仍只返回 `{ ok, release }`，不要据此判断通道状态。

### 配置变更记录

- 脚本预演通过；显式链路排除了 OpenCode Go，因此不读取其凭据文件。
- 生产配置备份：`~/Library/LaunchAgents/com.xinghao-radar.vite-dev.plist.bak-20260911-113636-17890`（启用前）和 `*.bak-20260911-113737-18526`（重跑前），权限 600。
- 两次执行间修复了一处成功提示的 shell 变量边界问题；最终脚本完整执行退出 0，健康检查通过。
- 公网 `/healthz` 正常；定时自动部署任务已恢复。

---

## 2026-09-22 PR31

| 字段 | 值 |
| --- | --- |
| 部署时间 | 2026-09-22 13:14（本地 CST，取 release 目录 mtime） |
| PR | [PR31](https://github.com/mewmind-chen/xinghao-radar/pull/31)：feat(parts) 删除「人工校准」功能，保留型号分析展示 |
| 合并时间 | 2026-09-22 01:02（CST；GitHub `mergedAt` 2026-09-21T17:02:15Z） |
| 部署前 SHA | `866916a27aaa351826061f53df2774edae11632e` |
| 部署后 SHA（= `main`） | `ae47acc1785567d52cc993163066458d230bc094` |
| 生产 release | `20260922-051328-main-ae47acc17855` |
| 操作者 | **人工放行**（用户在本机终端执行 `AUTO_DEPLOY_ALLOW_MIGRATIONS=true AUTO_DEPLOY_RUN_TESTS=true node scripts/auto-deploy.mjs`；原因见备注 2） |
| 数据库 migration | **有**：`0011_drop_part_analysis_review.sql`（`drop table if exists part_analysis_reviews`）。执行前目标表 3 行（全 `accept`，最新 2026-09-14）；`applied_at` 2026-09-22T05:14:13Z |
| 构建 | 成功（changed=6；隔离 worktree 内 typecheck + test + build） |
| 服务重启 | 是（13:01–13:14 期间服务处于停止状态） |
| 验证结果 | 本地与公网 `/healthz` 均返回新 release；`importReady=3`、链路 `command-code,deepseek-api,openrouter`；库副本核对 `_migrations` 含 0011 且 `part_analysis_reviews` 已不存在，业务表完好（`parts` 18 行 / `part_analyses` 14 行）；生产仓库 HEAD = `ae47acc` 且工作树干净 |
| 回滚点 | 上一 release `20260921-135042-main-866916a27aaa`；plist 备份 `backups/launchd-2026-09-22T05-14-07-446Z.plist`；库备份 `backups/pr31-pre-migration-20260922-125223`、`backups/pr31-pre-deploy-20260922-125650`（各 1105 文件 / 40M） |

**备注**

1. **迁移护栏挡了约 12 小时**：PR31 携带 `migrations/0011`，自动部署按设计拒绝执行（`auto-deploy.err.log` 中该条拒绝出现 279 次），必须人工放行。放行前先核查目标表数据量（3 行，随迁移删除，已存两份额外备份）。
2. **⚠️ 放行部署不得在 WorkBuddy 进程内执行**：本机 launchd 域写入对 WorkBuddy 受限——`launchctl bootstrap` / `load` 一律报 `5: Input/output error`，而 **legacy `load` 失败时仍返回退出码 0**，`scripts/auto-deploy.mjs` 的 `startService` 据退出码判定为成功。后果链：`unload` 生效（服务被停）→ `load` 静默失败 → `waitForHealth` 45 次全失败 → 回滚的 `load` 同样静默失败 → 服务彻底不在 launchd 域内。**本次因此在 13:01–13:14 造成约 13 分钟公网 502**；随后改用用户终端执行（先 `launchctl load` 恢复站点，再跑放行部署）一次通过。
3. **待修（代码级根因）**：`startService` 未校验 legacy `load` 的真实结果，应补 `isServiceLoaded` 复查，否则同类事故会重演。
4. **数据完整性**：迁移前的两份完整 PGlite 备份均保留；`part_analysis_reviews` 的 3 行记录现仅存在于备份中。
5. 本次过程中另产生两个同提交的孤儿 release 目录（`20260922-045331-main-ae47acc17855`、`20260922-050001-main-ae47acc17855`，均未启用、未被 plist 引用），**当前保留未清理**。
6. 已知文档缺口（本次未处理）：`DEPLOY_LOG.md` 中 PR29（2026-09-14）、PR30（2026-09-21）两条部署记录缺失，导致 PR31 的「部署前 SHA」在本文档内无对应条目。

---

## 2026-09-11 PR27

| 字段 | 值 |
| --- | --- |
| 部署时间 | 2026-09-11 12:25（本地 CST） |
| PR | [PR27](https://github.com/mewmind-chen/xinghao-radar/pull/27)：移除 max_tokens 硬上限（推理模型被截断成空内容，导致链路降级到 OpenRouter） |
| 合并时间 | 2026-09-11 12:20 |
| 部署前 SHA | `65b6d7667f5624bbf2883bed27dd63af40f97d61` |
| 部署后 SHA（= `main`） | `877d6f1aaeedce0cf94674cca2089b6bb582e313` |
| 生产 release | `20260911-042448-main-877d6f1aaeed` |
| 操作者 | 自动部署（`scripts/auto-deploy.mjs`） |
| 数据库 migration | 无 |
| 构建 | 成功（changed=5） |
| 服务重启 | 是（PID 31836 → 46465） |
| 验证结果 | 本地与公网 `/healthz` 均返回新 release；`importReady=3`、链路 `command-code,deepseek-api,openrouter`；**线上产物 `max_tokens` 出现 0 次（上一版 3 次）**；CI 6/6 通过；`npm test` 334 项 / 332 pass / 0 fail / 2 skipped，引擎 30/30，lint 与 typecheck 0 error |
| 回滚点 | 上一 release `20260911-035846-main-5e3b8f4074b5` |
| 备注 | **修复「AI 识别实际走 OpenRouter」的真正根因**：mapping 模式的 `max_tokens: 2500` 对推理模型致命 —— 思考 token 也计入额度，2500 全被 reasoning 吃光，`finish_reason=length`、`content=""`，引擎判 `empty_or_error` 后降级到 openrouter 兜底。用真实文件复现确认，删除限制后 `command-code` 命中（35.7s / 314 行 / `route=model_mapping`）。三处硬上限全部移除（含 `harness-import` 图片兜底路径的 3500）。**教训：不得给推理模型设 max_tokens，直连通道的输出上限交给上游。** |

## 2026-09-11 PR25

| 字段 | 值 |
| --- | --- |
| 部署时间 | 2026-09-11 11:59（本地 CST） |
| PR | [PR25](https://github.com/mewmind-chen/xinghao-radar/pull/25)：AI 导入通道可见性（`/healthz` + 部署巡检）与 key 配置脚本加固 |
| 合并时间 | 2026-09-11 11:54 |
| 部署前 SHA | `0e1cc8d5ce860a9d5842dfef34794c90d8d3d769` |
| 部署后 SHA（= `main`） | `5e3b8f4074b56e0fcb5d8f16f3c6e3956cf052cc` |
| 生产 release | `20260911-035846-main-5e3b8f4074b5` |
| 操作者 | 自动部署（`scripts/auto-deploy.mjs`，launchd 每 300s 轮询 `main`） |
| 数据库 migration | 无 |
| 构建 | 成功（隔离环境 typecheck + build；changed=10） |
| 服务重启 | 是（PID 18595 → 31836） |
| 验证结果 | 本地与公网 `/healthz` 均返回新字段：`importChain=command-code,deepseek-api,openrouter`、`importReady=3`、逐通道明细与 `importSummary`；启动日志输出 `import_chain=` / `import_status=`；CI 6/6 通过；本地验收 `npm test` 334 项 / 332 pass / 0 fail / 2 skipped，引擎 30/30，lint 与 typecheck 0 error |
| 回滚点 | 上一 release `20260911-030851-main-0c889fc2dbd3`；plist 备份 `backups/launchd-2026-09-11T03-59-34-879Z.plist` |
| 备注 | **可见性缺口已闭合**：`/healthz` 现透出通道就绪状态，`auto-deploy` 每次巡检记录 `import_status=` 并在零可用时打 WARN。`auto-deploy.out.log` 的 `import_status=` 行自下一个巡检周期起出现（本轮激活执行的是切换前的旧脚本）。本 PR 同时把 11:36/11:37 实际用于生产激活的 `set-import-keys.sh` 加固版本入库（含 6 条测试） |

## 2026-09-11 PR23

| 字段 | 值 |
| --- | --- |
| 部署时间 | 2026-09-11 11:09（本地 CST） |
| PR | [PR23](https://github.com/mewmind-chen/xinghao-radar/pull/23)：修正 `extractOrigin` 误判，并让预览显示真实命中的 AI 通道 |
| 合并时间 | 2026-09-11 11:04 |
| 部署前 SHA | `bc322ab91f8af29bedb2a98397b54a3c3a14155a` |
| 部署后 SHA（= `main`） | `0c889fc2dbd3d8238de9e41f53284d89ae50de04` |
| 生产 release | `20260911-030851-main-0c889fc2dbd3` |
| 操作者 | 自动部署（`scripts/auto-deploy.mjs`，launchd 每 300s 轮询 `main`） |
| 数据库 migration | 无 |
| 构建 | 成功（隔离环境 typecheck + build） |
| 服务重启 | 是（legacy `launchctl unload/load`） |
| 验证结果 | 本地与公网 `/healthz` 均 200、release 标识正确；CI 6/6 通过（typecheck / lint / test / build / migration rehearsal / production PGlite rehearsal）；本地验收 `npm test` 318 项 / 316 pass / 0 fail / 2 skipped，引擎 28/28，lint 与 typecheck 0 error |
| 回滚点 | 上一 release `20260911-023226-main-bc322ab91f8a`；plist 备份 `backups/launchd-2026-09-11T03-10-05-193Z.plist` |
| 备注 | 纯代码变更，**无 key / 配置变更** → AI 导入仍走 OpenRouter，见顶部「AI 导入通道当前状态」。修复内容：`extractOrigin` 弃用 `runs.length > 0`（降级链给失败通道也记 run → 恒真 → 纯本地识别被误标成 AI），改用引擎权威字段 `result.route`；新增 `extractChannel` 透出真实命中通道 |

## 2026-09-11 PR21 + PR22

| 字段 | 值 |
| --- | --- |
| 部署时间 | 2026-09-11 10:32（本地 CST） |
| PR | [PR21](https://github.com/mewmind-chen/xinghao-radar/pull/21)：修复客户询价智能导入与 TP 写入；[PR22](https://github.com/mewmind-chen/xinghao-radar/pull/22)：AI 导入直连降级链与 prompt v2 自足化 |
| 合并时间 | PR21 = 2026-09-10 22:41；PR22 = 2026-09-11 09:40 |
| 部署前 SHA | `3bbb75475671230f60186db5fc3ad2255c3a1ff5` |
| 部署后 SHA（= `main`） | `bc322ab91f8af29bedb2a98397b54a3c3a14155a` |
| 生产 release | `20260911-023226-main-bc322ab91f8a` |
| 操作者 | **人工放行**（突破 migration 护栏，非自动部署） |
| 数据库 migration | ✅ `0010_customer_inquiry_tp.sql`（已执行；生产快照核对记录 1 次，两个 TP 列均存在） |
| 部署前备份 | `xinghao-radar-deploy/backups/pr21-pr22-llUBLWnZ/data`（停服拷贝，递归比对通过） |
| 迁移演练 | 24 张表行数不变；TP 迁移连续执行 2 次均成功 |
| 构建 | 成功（隔离环境 typecheck + build）；306 tests pass / 0 fail / 2 skipped |
| 服务重启 | 是（PID 2898 → 57839） |
| 验证结果 | 本地与公网 `/healthz` 返回新 release；公网登录与鉴权会话接口 HTTP 200；自动部署恢复同步（remote/source/deployed 一致，changed=0，exit 0） |
| 回滚点 | `20260909-174006-main-3bbb75475671`；plist 备份 `backups/launchd-2026-09-11T02-33-11-700Z.plist`；旧 release 全部保留 |
| 部署产物验证 | `releases/20260911-023226-main-bc322ab91f8a/DEPLOYMENT_VERIFICATION.md` |
| 备注 | **被 migration 护栏挡了约 12 小时**：PR21 引入 `migrations/0010_*.sql` 后，auto-deploy 每 5 分钟检测到 `remote=bc322ab source=3bbb754 changed=26`，但一律 `FAILED: migration files changed; automatic deployment is blocked`，直到人工停服备份 + 放行。**验证时未执行真实 AI 提取**；新直连通道凭证缺失被跳过 → 实际仍走 OpenRouter |

## 2026-09-10 PR19 / PR18 / 3bbb754（回填，元数据来自 `releases/*/release.json`）

| 部署时间（本地） | PR / commit | 生产 SHA | 生产 release | migration | 说明 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-10 01:40 | `3bbb754`（无 PR 号，直接提交） | `3bbb7547567123` | `20260909-174006-main-3bbb75475671` | 无 | `fix: remove workbench smart import shortcut`；**此版本即 PR21+PR22 的部署前基线** |
| 2026-09-10 00:49 | [PR19](https://github.com/mewmind-chen/xinghao-radar/pull/19) `f6778bb` | `f6778bbc11db` | `20260909-164905-main-f6778bbc11db` | 无 | `fix: support legacy launchctl service reload` |
| 2026-09-10 00:45 | [PR18](https://github.com/mewmind-chen/xinghao-radar/pull/18) `0570a2c` | `0570a2cb6587` | `20260909-164437-main-0570a2cb6587` | 无 | `fix: isolate auto-deploy test environment`；日志中只有构建记录、无激活记录（随即被 PR19 覆盖） |

> 回填说明：以上三条仅从 release 目录元数据还原，**未找到对应的验证报告**，故不记录验证结果。

## 2026-09-09 PR15（回填）

| 字段 | 值 |
| --- | --- |
| 部署时间 | 2026-09-09 18:27（本地 CST） |
| PR | [PR15](https://github.com/mewmind-chen/xinghao-radar/pull/15)：release hardening for PR13 backend integrity |
| 生产 SHA | `6a926d89`（对应 commit `6a926d8`） |
| 生产 release | `20260909-102737-pr15-6a926d8` |
| 备注 | 回填条目；release 命名沿用旧的手工格式（本地时间），09-09 之后的自动部署 release 名改用 UTC |

## 2026-09-08 PR12

| 字段                | 值                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------- |
| PR                  | [PR12](https://github.com/mewmind-chen/xinghao-radar/pull/12)                           |
| 合并后的 `main` SHA | `d0ed911ce393b533ad58745c5ffa7af60474e651`                                              |
| 生产 release        | `20260908-221004-pr12-d0ed911`                                                          |
| 生产源码            | `/Users/ylf/Desktop/型号追踪/xinghao-radar-production`                                  |
| 构建产物            | `/Users/ylf/Desktop/型号追踪/xinghao-radar-deploy/releases/20260908-221004-pr12/output` |
| 数据目录            | `/Users/ylf/Desktop/型号追踪/xinghao-radar-deploy/data/pglite`                          |
| 服务                | `com.xinghao-radar.vite-dev`，端口 `8082`                                               |
| 数据库迁移          | 无新增生产迁移；当前使用 PGlite                                                         |
| 导入配置            | V2，`google/gemini-3.8-flash`                                                           |
| 验证结果            | 本地与公网 `/healthz` 返回 200，release 标识正确                                        |
| 备注                | PR13 未部署；旧 release 保留，可用于应急回滚                                            |

---

## 自动部署

自动拉取/部署脚本位于 `scripts/auto-deploy.mjs`，Mac launchd 配置模板位于 `ops/com.xinghao-radar.auto-deploy.plist.example`。它只轮询已合并的 `main`，构建通过后才创建新 release 并重启服务；**文档变更不触发线上重启，数据库迁移默认阻断**（`AUTO_DEPLOY_ALLOW_MIGRATIONS` 放行，放行前必须停服备份）。

- 轮询间隔：`300` 秒。
- 环境变量保留：`activateRelease()` 只 `plutil -replace` 以下两个键，**其余环境变量（含手写进 plist 的 key）保持不动**：
  - `EnvironmentVariables.RADAR_OUTPUT_DIR`
  - `EnvironmentVariables.RADAR_RELEASE`
- 健康检查范围：`GET /healthz` 比对 `ok: true` 与 `release` 标识；**并透出 AI 导入通道就绪状态** —— `importChain` / `importChannels` / `importReady` / `importSummary` / `importWarnings`。`auto-deploy` 每次巡检记录一行 `import_status=`，通道零可用时打 WARN；激活新 release 后同样报告（随本分支代码 PR 发布，部署后生效）。
- release 命名：`<UTC yyyyMMdd-HHmmss>-<branch>-<sha12>`；BRANCH 为 `main`。旧的 PR12/PR15 release 用的是手工本地时间命名。

详细目录边界、核验命令和发布规则见 [生产运营说明](docs/PRODUCTION_OPERATIONS.md)。
