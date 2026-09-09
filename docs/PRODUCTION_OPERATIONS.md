# 生产运营说明

本文档说明型号雷达在 Mac 生产端的代码、构建产物、业务数据和服务边界，供开发机和后续发布使用。路径是当前 Mac 的本地路径；其他机器需要按实际目录调整。本文档不包含生产数据库、上传文件、日志内容、环境变量真实值或任何密钥。

## 当前生产状态

| 项目 | 当前值 |
| --- | --- |
| GitHub 仓库 | `https://github.com/mewmind-chen/xinghao-radar` |
| GitHub `main` SHA | `d0ed911ce393b533ad58745c5ffa7af60474e651` |
| 生产源码 SHA | `d0ed911ce393b533ad58745c5ffa7af60474e651` |
| 线上 release | `20260908-221004-pr12-d0ed911` |
| 生产服务 | `com.xinghao-radar.vite-dev` |
| 监听端口 | `8082` |
| 公网地址 | `https://radar.newmindchen.com` |
| 数据库后端 | 本机 PGlite；当前生产没有 `DATABASE_URL` |
| 导入引擎 | V2 已启用 |
| 导入模型 | `google/gemini-3.8-flash` |
| 最近核验 | 2026-09-09 17:58 CST；本地和公网 `/healthz` 均正常 |

当前生产运行的是 PR12 合并后的 `main`，PR13 尚未部署。

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

`/Users/ylf/Desktop/型号追踪/xinghao-radar-production` 是当前生产源码的干净快照，锁定到线上 SHA。它不是开发目录，不在里面直接修改业务代码。当前 launchd 的 `WorkingDirectory` 指向这里，生产启动脚本也来自这里。

### 生产运营目录

`/Users/ylf/Desktop/型号追踪/xinghao-radar-deploy` 保存运行时状态，不作为开发仓库使用：

- `releases/` 保存构建后的可运行版本；当前服务使用 `releases/20260908-221004-pr12/output`。
- `data/pglite/` 保存业务数据，发布和回滚都不能删除、覆盖或提交到 Git。
- `logs/` 保存服务日志，不提交到 Git。

生产运营目录中历史遗留的源码、构建文件和未跟踪文件不得通过 `git clean` 清理；需要新版本时建立新的干净源码快照和新的 release 目录。

## 服务配置位置

launchd 配置文件：

`/Users/ylf/Library/LaunchAgents/com.xinghao-radar.vite-dev.plist`

关键配置关系：

```text
WorkingDirectory  = /Users/ylf/Desktop/型号追踪/xinghao-radar-production
RADAR_OUTPUT_DIR  = /Users/ylf/Desktop/型号追踪/xinghao-radar-deploy/releases/20260908-221004-pr12/output
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

## PR13 状态

PR13 当前未部署。它的 GitHub `quality` 检查在 UTC 环境下因日期格式测试失败；同时 PR13 强制生产运行必须配置 `DATABASE_URL`，而当前生产使用 PGlite。修复 CI、明确数据库迁移方案并完成数据安全评估前，不得将 PR13 合并或部署。
