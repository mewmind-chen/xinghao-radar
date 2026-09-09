# 部署记录

本文件只记录生产版本元数据，不保存生产数据、日志、密钥或环境变量真实值。

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

## 自动部署

自动拉取/部署脚本位于 `scripts/auto-deploy.mjs`，Mac launchd 配置模板位于 `ops/com.xinghao-radar.auto-deploy.plist.example`。它只轮询已合并的 `main`，构建通过后才创建新 release 并重启服务；文档变更不触发线上重启，数据库迁移默认阻断。

详细目录边界、核验命令和发布规则见 [生产运营说明](docs/PRODUCTION_OPERATIONS.md)。
