# 型号雷达

电子元器件型号追踪系统：以型号主档为中心，把库存流水、渠道推货、客户询价交叉匹配，工作台自动汇总今日命中。

面向华强北贸易台面：贴微信、Excel、拍照导入，型号字符只做 trim / 大小写 / NFKC，禁止改字。

## 功能

| 模块 | 说明 |
| --- | --- |
| 工作台 | 今日询价 / 推货 / 库存·在途 / 双命中自动汇总 |
| 型号库 | 型号主档 1 : N 事件；详情看库存、渠道、询价时间线 |
| 我的库存 | 资产流水：入 / 出 / 调 / 修 / 途→仓，禁止直接改当前数量 |
| 渠道货源 | 渠道报价与推货；停用只关门闩，不删历史 |
| 客户询价 | 客户询价窗口匹配渠道货与库存 |
| 潜力型号 | 关注池 |
| 智能导入 | 粘贴 / 拍照 / Excel，必须预览确认后才入库 |
| 设置 | 仓库、渠道、客户、匹配窗口 |

## 业务内核

- 型号主档 1 : N 事件（库存批次、在途、渠道推货、客户询价、潜力）
- 库存是资产流水，不是可改的“当前数量”
- 在途不是仓库；途转入库是状态迁移，总敞口不变
- 匹配 = 交叉命中，禁止用本条事件命中自己
- 停用渠道 / 客户只把门闩上；重新启用不批量恢复历史无效记录
- 导入必须预览；型号字符只做规范化，禁止 AI 改字

产品需求见 [`attachments/电子元器件型号追踪系统_PRD_V1.0.docx`](attachments/电子元器件型号追踪系统_PRD_V1.0.docx)。

## 技术栈

- React 19 + TanStack Start / Router / Query
- Tailwind CSS v4
- PGLite（本地）/ Postgres（部署）
- Vite 8 + Nitro

默认不开启登录。部署到带 `DATABASE_URL` 的 Postgres 环境即可持久化。

## 本地运行

需要 Node 22+。

```bash
npm install
npm run dev
```

开发服务默认监听 `0.0.0.0:8080`。

```bash
npm run typecheck   # 类型检查
npm run build       # 生产构建 + 迁移
npm run preview     # 预览构建产物
```

数据库迁移在 `migrations/`。首次启动会自动应用 schema 并写入演示数据。

## 智能能力边界与部署

Radar 只把“型号理解、研究与建议”交给 `electronics-agent-platform`；库存、询价、匹配规则、写库和最终操作仍由 Radar 的确定性业务代码与用户确认负责。每次型号研究会按精确 MPN 生成一个只读、聚合后的上下文快照（在库、在途、仓库汇总、询价计数），不发送客户、成本、批次、渠道明细等数据。

部署拓扑为 `Radar → electronics-agent-platform → 公开研究源`，并保留 `Radar → Huaqiangbei Workbench /api/agent/lookup.full` 作为事实检索降级链路。上下文提供器异常、平台超时、401 或 5xx 都会记录安全的降级事件，再无上下文调用平台或直接回退 Workbench；它们不会阻断 Radar 的核心业务。

从 [`.env.example`](.env.example) 复制为 `.env` 后按环境填写：

- `AGENT_API_URL`：Platform 服务地址，默认 `http://127.0.0.1:8787`。
- `ELECTRONICS_AGENT_PLATFORM_TOKEN`：仅供 Radar 调用 Platform 的专用服务端 token。生产环境必须单独签发；不兼容、也不回退读取泛用的 `AGENT_API_TOKEN`。
- `HQB_BASE_URL`：Workbench 降级服务地址，默认 `http://127.0.0.1:8081`。
- `DATABASE_URL`：生产 Postgres 连接；未设置时使用本地 PGLite。型号分析结果也写入该同一持久层的 `part_analyses` 表：部署时由 `npm run build` 的迁移创建，冷启动实例可直接读取；离线开发则保存在 `<DATA_DIR>/pglite`，不再使用 serverless 本地 SQLite 文件。旧版 `data/analyses.db` 可先运行 `node scripts/import-legacy-analyses.mjs` 只读预检，再用 `node scripts/import-legacy-analyses.mjs --apply` 幂等导入；源文件始终保留，不会自动删除。

不要将 token 放入 `VITE_*` 变量、浏览器代码、截图或日志。服务日志只记录诸如 `platform_unavailable / timeout` 的粗粒度原因，不输出凭据、URL 或上游响应内容。

## 目录

```
src/routes/          页面：工作台 / 型号 / 库存 / 渠道 / 询价 / 潜力 / 导入 / 设置
src/lib/domain.ts    业务规则（规范化、匹配窗口、数量格式）
src/lib/server/      服务端查询与写入
migrations/          SQL schema
attachments/         PRD
```

## 许可

私有仓库，未授权请勿分发。
