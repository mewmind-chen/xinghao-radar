# 生产运营说明

本文档说明型号雷达在 Mac 生产端的代码、构建产物、业务数据和服务边界，供开发机和后续发布使用。路径是当前 Mac 的本地路径；其他机器需要按实际目录调整。本文档不包含生产数据库、上传文件、日志内容、环境变量真实值或任何密钥。

## 当前生产状态

| 项目                         | 当前值                                             |
| ---------------------------- | -------------------------------------------------- |
| GitHub 仓库                  | `https://github.com/mewmind-chen/xinghao-radar`    |
| 最近核验的 GitHub `main` SHA | `6a926d8a2301dae11d46579dccc11a4a6413f1a4`         |
| 生产源码 SHA                 | `6a926d8a2301dae11d46579dccc11a4a6413f1a4`         |
| 线上运行代码 SHA             | `6a926d8a2301dae11d46579dccc11a4a6413f1a4`         |
| 线上 release                 | `20260909-102737-pr15-6a926d8`                     |
| 生产服务                     | `com.xinghao-radar.vite-dev`                       |
| 监听端口                     | `8082`                                             |
| 公网地址                     | `https://radar.newmindchen.com`                    |
| 数据库后端                   | 本机 PGlite；当前生产没有 `DATABASE_URL`           |
| 导入引擎                     | V2 已启用                                          |
| 导入模型                     | `google/gemini-3.8-flash`                          |
| 最近核验                     | 2026-09-09 18:28 CST；本地和公网 `/healthz` 均正常 |

当前生产源码和线上运行代码均为 PR15；后续文档提交可能只推进生产源码镜像，不自动改变当前 release。

## 三类目录

```text
/Users/ylf/Desktop/型号追踪/
├── xinghao-radar/                 开发区
├── xinghao-radar-production/     生产源码快照
└── xinghao-radar-deploy/          生产运营目录
    ├── releases/                  构建产物，每个版本独立保存
    ├── data/pglite/                生产业务数据
    └── logs/                      生产日志
```

### 开发区

`/Users/ylf/Desktop/型号追踪/xinghao-radar` 是唯一开发区。新任务从最新 `main` 创建 feature/fix 分支，在此修改、测试、commit、push 和创建 PR。

### 生产源码

`/Users/ylf/Desktop/型号追踪/xinghao-radar-production` 是当前 `main` 的干净生产源码镜像。它不是开发目录，不在里面直接修改业务代码。当前 launchd 的 `WorkingDirectory` 指向这里，生产启动脚本也来自这里；线上实际加载的构建产物由 `RADAR_OUTPUT_DIR` 独立决定。

### 生产运营目录

`/Users/ylf/Desktop/型号追踪/xinghao-radar-deploy` 保存运行时状态，不作为开发仓库使用：

- `releases/` 保存构建后的可运行版本；当前服务使用 `releases/20260909-102737-pr15-6a926d8/output`。
- `data/pglite/` 保存业务数据，发布和回滚都不能删除、覆盖或提交到 Git。
- `logs/` 保存服务日志，不提交到 Git。

生产运营目录中历史遗留的源码、构建文件和未跟踪文件不得通过 `git clean` 清理；需要新版本时建立新的干净源码快照和新的 release 目录。

## 自动拉取与自动部署

生产 Mac 使用独立的 launchd 任务定时拉取 `origin/main`，配置模板为：

`ops/com.xinghao-radar.auto-deploy.plist.example`

安装后的任务标签是 `com.xinghao-radar.auto-deploy`，默认每 300 秒检查一次。它只跟踪已合并的 `main`，不会拉取或部署 feature 分支。

流程如下：

```text
fetch origin/main
    │
    ├─ 生产源码有未提交修改 → 中止，不覆盖
    ├─ 非快进历史 → 中止，等待人工处理
    ├─ 只有文档/测试/CI 变化 → 同步生产源码，不重启线上
    ├─ migrations/ 变化 → 默认阻断，需显式批准
    └─ 普通运行时代码变化
         → 临时 worktree
         → npm ci + typecheck + test + build
         → 校验 Nitro/PGlite 构建产物
         → 新 release 目录
         → 更新服务 plist 并重启
         → /healthz 必须返回新 release
         → 失败则恢复旧 plist、源码和线上 release
```

自动部署器不会把 `OPENROUTER_API_KEY`、平台 Token、数据库连接串或业务数据带入构建环境。依赖安装、类型检查和测试使用 `NODE_ENV=test`，正式构建使用 `NODE_ENV=production`；生产数据仍只位于 `data/pglite/`，不进入 Git。涉及数据库迁移时，必须先完成数据备份和迁移评审，再设置 `AUTO_DEPLOY_ALLOW_MIGRATIONS=true` 执行一次。

生产 Mac 上的核验命令：

```bash
launchctl print gui/$(id -u)/com.xinghao-radar.auto-deploy
tail -n 100 /Users/ylf/Desktop/型号追踪/xinghao-radar-deploy/logs/auto-deploy.out.log
AUTO_DEPLOY_DRY_RUN=true node /Users/ylf/Desktop/型号追踪/xinghao-radar-production/scripts/auto-deploy.mjs
```

手工回滚或排障时，先暂停 `com.xinghao-radar.auto-deploy`，避免它在人工操作期间再次拉取并覆盖生产状态。

## 服务配置位置

launchd 配置文件：

`/Users/ylf/Library/LaunchAgents/com.xinghao-radar.vite-dev.plist`

关键配置关系：

```text
WorkingDirectory  = /Users/ylf/Desktop/型号追踪/xinghao-radar-production
RADAR_OUTPUT_DIR  = /Users/ylf/Desktop/型号追踪/xinghao-radar-deploy/releases/20260909-102737-pr15-6a926d8/output
DATA_DIR          = /Users/ylf/Desktop/型号追踪/xinghao-radar-deploy/data
StandardOutPath   = /Users/ylf/Desktop/型号追踪/xinghao-radar-deploy/logs/production.out.log
StandardErrorPath = /Users/ylf/Desktop/型号追踪/xinghao-radar-deploy/logs/production.err.log
```

运行参数中的 `IMPORT_ENGINE_V2_ENABLED`、`IMPORT_MODEL` 等非敏感配置可以记录；OpenRouter 密钥只能留在生产环境，不能写入本仓库。

## 只读核验

在生产 Mac 上可以用以下命令确认远端、生产源码和线上 release：

```bash
git -C /Users/ylf/Desktop/型号追踪/xinghao-radar ls-remote origin refs/heads/main
git -C /Users/ylf/Desktop/型号追踪/xinghao-radar-production rev-parse HEAD
git -C /Users/ylf/Desktop/型号追踪/xinghao-radar-production status --porcelain
launchctl print gui/$(id -u)/com.xinghao-radar.vite-dev | rg 'state =|pid =|RADAR_OUTPUT_DIR|RADAR_RELEASE'
curl -fsS https://radar.newmindchen.com/healthz
```

通过标准：生产源码为 clean，SHA 与已确认的 `main` 一致，健康检查返回 `ok: true` 且 release 标识正确。

## 发布和回滚边界

1. 开发机从最新 `main` 创建分支并完成测试。
2. GitHub PR 目标必须是 `main`，审查和 CI 通过后才合并。
3. Mac 只部署已合并的 `main` SHA，不直接运行 feature 分支。
4. 新版本使用新的生产源码快照和新的 `releases/<release>/output`，保留旧 release。
5. 发布后检查进程、健康接口、关键功能和日志，并记录线上 SHA。
6. 紧急回滚只能临时切回已知稳定 release；随后仍应在 GitHub `main` 上通过 revert 或修复恢复一致。

禁止将以下内容推送到 GitHub：生产 `data/`、上传文件、`logs/`、`.env`、API Key、Token、SSH 私钥、数据库连接串和真实业务数据。

## PR15 状态

PR15 已合并并部署。它修复了 PR13 的 UTC 测试问题，明确生产数据库模式为 `pglite`，并通过迁移演练和生产 PGlite 演练后在真实生产数据上执行了 `0009_integrity_audit.sql`。上线前备份保存在生产运营目录的 `backups/` 下。
