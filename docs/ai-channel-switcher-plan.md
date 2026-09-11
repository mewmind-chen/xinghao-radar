# 型号雷达 · AI 识别通道「可视化切换」设计与实施计划

> 版本：1.0（草案，待评审）
> 日期：2026-09-10
> 关联文档：`docs/import-agent-routing.md`、`docs/PRODUCTION_OPERATIONS.md`、《开发到生产 PR 部署流程规范》
> 参考实现：todo-app `agent-recognition-v1` 分支（7 通道可视化切换，2026-09-09）

---

## 0. 目标

让生产系统（型号雷达）的导入识别 AI 通道，像 todo-app 一样可以在设置页**可视化切换**：

```text
AI 识别通道（通道 = 本机已有的 agents 和直连 API）
  当前生效：google/gemini-3.8-flash · OpenRouter

  主通道   [OpenRouter ▾]  [google/gemini-3.8-flash ▾]             已就绪
  备用通道 [已启用 ▾] [opencode CLI ▾] [deepseek-v4-flash-vision-exp ▾]  已就绪

  [保存]（立即生效，无需重启）   [测试识别]
```

与 todo-app 的关键事实：**雷达生产运行在同一台 Mac 上，与本机所有 CLI agents 同机部署**——
因此本机已装的 CLI agents（claude / deepseek / opencode / gemini / codex）可以像 todo-app 在本机
调用 CLI 那样，直接作为雷达的切换通道。通道结构 = 「CLI 类 + API 直连类」的组合，
与 todo-app 的通道体系一一对应。

本机 AI 资产已全部实测完毕（2026-09-10，详见工作区《本地可用AI盘点.md》）：

- **CLI 类**（登录态直连、免 key）：claude、deepseek、opencode（128 模型）、gemini、codex（5 个全部实测在线，2026-09-10 晚完成修复）
- **API 直连类**：OpenRouter×2、免费模型池（:4000）、Groq、NVIDIA、Gemini API、DeepSeek 官方
- **本地服务**：华强北工作台（:8081，事实检索）

---

## 1. 现状盘点（事实）

### 1.1 当前调用链（全系统唯一 AI 调用点）

```text
src/routes/import.tsx
  → src/lib/server/import.ts（parseImport，V2 开关 IMPORT_ENGINE_V2_ENABLED=true）
  → src/lib/server/import-engine-adapter.ts（resolveImportWithEngine）
  → packages/import-engine/src/extract.ts（extractImport：确定性提取优先）
  → packages/import-engine/src/provider.ts（OpenRouterProvider，唯一的 Provider 实现）
```

- 除导入识别外，雷达其余能力（匹配、查重、提醒、库存、日志）全部是确定性代码，不调模型。
- 模型调用参数：`temperature: 0`、`reasoning_effort: low`、strict JSON Schema
  （`response_format: json_schema, strict: true`）、图片走 `image_url`、PDF 走 `file` part、
  90 秒超时、瞬时错误重试 1 次。

### 1.2 当前切换成本（要解决的问题）

| 事项 | 现状 |
|---|---|
| 换模型 | 改 plist `IMPORT_MODEL` 或 `launchctl setenv` + 重启 launchd 服务 |
| 换密钥 | `launchctl setenv OPENROUTER_API_KEY`（GUI 域全局环境），无 UI |
| 备用通道 | 无。主通道故障 → 直接 `provider_error` |
| 变更审计 | 无。不知道谁在什么时候改过模型 |
| 变更验证 | 无。改完只能等真实导入出问题 |

### 1.3 已有的可复用基础（好消息）

- `ExtractionProvider` 接口（`types.ts`）本就是插槽式：`name / model / available() / extract()`。
- `runs: ModelRun[]` 本就为多次运行记录设计（provider、model、upstreamProvider、耗时、token、成本、error）。
- `ExtractRequest.modelMode: "primary" | "compare"` 字段已预留（未实现）——说明原设计就为多通道留了位置。
- 设置页三件套齐全：`src/routes/settings.tsx` + `settings.manage` 权限 + `app_settings` KV 表 + `logOp` 审计。
- `defaultImportProvider()` 在**每次导入请求时**才构造 provider —— 天然的热更新点，换配置无需重启。
- 老路径 `IMPORT_ENGINE_V2_ENABLED=false` 的 legacy 分支继续保留，不受本方案影响。

### 1.4 生产端可用 AI 资产（2026-09-10 实测，详见工作区《本地可用AI盘点.md》）

**CLI 类**（登录态直连、免 key；与雷达生产同机）：

| 资产 | 非交互调用 | 状态 |
|---|---|---|
| claude CLI | `claude -p "..."` | ✅ 实测通过 |
| deepseek CLI | `deepseek exec "..."` | ✅ 实测通过 |
| opencode CLI | `opencode run "..." -m <model> --format json [-f 附件]` | ✅ 配置齐全（4 凭据 / 128 模型，含视觉），终端验证一次即用 |
| gemini CLI | `gemini -p "..."` | ✅ 实测通过（2026-09-10 修复：API key 模式；OAuth 已被 Google 停用） |
| codex CLI | `codex exec` | ✅ 实测通过（2026-09-10 修复：重装 v0.154.0；非 git 目录加 `--skip-git-repo-check`） |

**API 直连类**：

| 资产 | 位置 | 状态 |
|---|---|---|
| OpenRouter key（主号） | launchctl GUI 域 `OPENROUTER_API_KEY` | ✅ 已用于当前通道（额度 $9.88） |
| 免费模型池 keys（Groq / NVIDIA / OpenRouter free） | `免费模型/.env`，LiteLLM `http://127.0.0.1:4000/v1` | ✅ key 实测有效；池服务未运行，可一键拉起 |
| Gemini API / DeepSeek 官方 key | `免费模型/.env` / `~/.deepseek/config.toml` | ✅ 实测有效，可选补充 |

**本机服务类**：华强北工作台（:8081，运行中）；pi-part-agent（:8790，可启动）。

---

## 2. 设计原则

1. **通道 = 「CLI 类」+「API 直连类」双结构**（对齐 todo-app）。雷达生产与本机 CLI agents
   同机部署，CLI 类通道（对齐 todo-app：qoder / opencode / codex / deepseek，另有 claude / gemini）以子进程方式调用，复用系统登录态、免 key；
   API 直连类（OpenRouter / 免费池 / DeepSeek 官方等）走 OpenAI 兼容端点；`custom` 通道支持
   任何 OpenAI 兼容端点，本机服务（pi-part-agent 等）也可登记为通道。
2. **配置落 DB，不落 plist / 仓库**。复用 `app_settings` KV（零 schema 迁移，不触发自动部署的
   迁移阻断），配置跨 release 存续、可审计、页面可改。
3. **保存即生效**。provider 链在每次导入请求时按当前配置构造；保存后下一个导入即生效，不重启服务。
4. **模型显式固定**。沿用现有立场（不因 provider 更新别名而静默换模型）：UI 上显示什么模型，
   请求里就是什么模型 ID；下拉列表都支持手填模型名。
5. **就绪可视化、不静默降级**。每个通道显示「已就绪 / 缺少密钥 / 地址未配置」；能力差异
   （视觉 / PDF / 严格 Schema）在 UI 上可见，输入类型与通道能力不匹配时明确提示。
6. **诚实失败语义保持**。所有通道不可用时保持现有 `provider_unavailable` / `provider_error`
   文案与行为，不伪造成功（这是现有引擎的核心设计立场，必须保留）。
7. **向后兼容、生产零风险**。DB 未配置时行为与现状完全一致（env 驱动 OpenRouter）；
   回滚 = 清掉 `ai_import.*` 配置键，无需回滚代码。
8. **密钥只写不回显**。UI 掩码（尾 4 位）、审计脱敏、密钥密文落库（防备份/快照外泄）。

---

## 3. 目标架构

```text
┌─ 设置页「AI 识别通道」卡片（settings.tsx 新增）
│    主通道 [通道▾][模型▾]   备用通道 [开关][通道▾][模型▾]   [保存][测试识别]
└──────────────┬───────────────────────────────────────────────
               │ saveAiChannelSettings（settings.manage + logOp）
               ▼
        app_settings（PGlite，xinghao-radar-deploy/data/pglite）
          ai_import.primary   = {"channel":"openrouter","model":"google/gemini-3.8-flash"}
          ai_import.fallback  = {"channel":"opencode","model":"deepseek-v4-flash-vision-exp"} | null
          ai_import.keys      = { "<channel>": {v,iv,tag,data,last4} }   ← AES-256-GCM
          ai_import.custom    = {"baseUrl":"...","label":"..."}
               │
               │ 无配置时 → env 回退：OPENROUTER_API_KEY / IMPORT_MODEL（= 现状）
               ▼
        resolveImportWithEngine（每次请求读取配置，构造 provider 链）
               ▼
        extractImport(request, [primary, fallback])
           ├─ 确定性提取优先（不变）
           └─ 需要模型时：primary → 失败记 failed run → fallback 重试 → 记 completed run
               ▼
        候选行 + runs[]（通道/模型/耗时/token/成本/接管情况 → 导入页徽标展示）
```

---

## 4. 通道注册表（拟）

> 命名与 todo-app 7 通道对齐（`qoder` / `opencode` / `codex` / `deepseek` / `glm` / `deepseek-api` / `openrouter`），
> 便于两边配置互通、经验直接复制；`claude` / `gemini` / `litellm-local` / `custom` 为本机扩展通道。

### 4.1 CLI 类通道（登录态直连、免 key，与雷达同机）——对应 todo-app 前 4 通道

| id | 名称 | 调用方式（复用 todo-app 实测参数） | 模型清单 | 本机状态 |
|---|---|---|---|---|
| `qoder` | Qoder CLI | `qoderclicn -p --tools '' -m <model> --attachment <img> --system-prompt <p>` | CLI 内置（Qwen3.8-Max 等） | ❌ 未安装；macOS 可装（`npm i -g @qoder-ai/qodercli` 或官方脚本），登录即用 |
| `opencode` | opencode CLI | `opencode run --format json -m <provider/model> -f <img>` | 动态（`opencode models`，本机 128 个） | ✅ 已装，配置齐全（含视觉 `deepseek-v4-flash-vision-exp`） |
| `codex` | Codex CLI | `codex exec --skip-git-repo-check` | CLI 内置 | ✅ 已修复（v0.154.0 重装），实测通过 |
| `deepseek` | DeepSeek CLI | `deepseek-tui exec --json --model <m> '<prompt+data:image>'` | `deepseek-v4-flash-vision-exp` 等 | ✅ 已装（`deepseek` / `deepseek-tui`），实测通过 |
| `claude` | Claude Code CLI（扩展） | `claude -p` | CLI 内置 | ✅ 实测通过 |
| `gemini` | Gemini CLI（扩展） | `gemini -p`（非信任目录加 `--skip-trust`） | CLI 内置（默认 `gemini-3.5-flash-lite`） | ✅ 已修复（API key 模式），实测通过 |

### 4.2 API 直连类通道——对应 todo-app 后 3 通道

| id | 名称 | 直连地址 | 密钥 | 模型清单 | 本机状态 |
|---|---|---|---|---|---|
| `glm` | 智谱 GLM 直连 | `https://open.bigmodel.cn/api/paas/v4` | 页面填 | 固定清单 + 手填（glm-4v-plus / 4.1v-thinking-flash / 4.5v / 4.6v） | ❌ 本机缺智谱 key（已彻查）；申请即用，过渡期可经 OpenRouter `z-ai/glm-*` 或 opencode `glm-5.3` |
| `deepseek-api` | DeepSeek 官方直连 | `https://api.deepseek.com/v1` | env / 页面填 | 动态 `/models` | ✅ key 实测有效（`~/.deepseek/config.toml`） |
| `openrouter` | OpenRouter 直连 | `https://openrouter.ai/api/v1` | env / 页面填 | 动态拉取 `/models` + 手填 | ✅ 现役通道（`google/gemini-3.8-flash`） |
| `litellm-local` | 本机免费池（扩展） | `http://127.0.0.1:4000/v1` | env / 页面填 | 动态 `/models`（`free-fast` 等别名） | ⚪ 未常驻，可一键拉起 |
| `custom` | 自定义 OpenAI 兼容（扩展） | 手填 baseUrl | 手填 | 手填 | 扩展位 |

说明：

- 首批建议 **`openrouter`（主）+ CLI 类实测可用者（备：`codex` / `gemini` / `opencode` / `deepseek` / `claude`，5 个全部实测在线，可直接进首批）+ `deepseek-api`**；
  `qoder` / `glm` 补齐后开关即纳入；`litellm-local` 视是否常驻决定。
- 环境变量名约定（API 类）：`OPENROUTER_API_KEY`、`DEEPSEEK_API_KEY`（可选）、`LITELLM_MASTER_KEY`；
  CLI 类无 key（复用系统登录态），就绪检查 = 可执行文件存在 + 探测调用成功。
- 能力矩阵由 P0 探测脚本实测输出（见 §10），不凭猜测写死；UI 上逐通道标注。
- CLI 调用参数直接复用 todo-app 的实测经验（`-p --attachment`、`--format json`、`--tools ''` 禁工具、data URI 内嵌图等）。

---

## 5. 引擎改造（packages/import-engine）

现状：`extractImport(request, provider)` 单 provider；`OpenRouterProvider` 硬编码端点与模型。

改造点：

1. **通用 Provider**：新增 `OpenAiCompatibleProvider`（吃 `{ baseUrl, apiKey, model, headers?,
   extraBody?, capabilities }`）；`OpenRouterProvider` 保留为预设（带 `HTTP-Referer` / `X-Title`
   头与 `provider.require_parameters` 参数）。`defaultImportProvider()` 保留，供测试与回退使用。
2. **CLI Provider**：新增 `CliAgentProvider`（吃 `{ command, args 模板, model?, attachments? }`），
   以子进程调用本机 CLI（`qoder -p --attachment` / `opencode run --format json -m <model> -f` /
   `codex exec` / `deepseek-tui exec --json` / `claude -p`）；
   prompt 经 stdin 或参数传入，stdout 提取 JSON（优先 `--format json` 结构化输出，其余走 JSON 块提取）；
   图片/PDF 传参方式：opencode `-f` / qoder `--attachment` / deepseek data URI 内嵌。
   `available()` = 二进制存在 + 登录态探测（结果短缓存）。
   注意 launchd 环境的 PATH 差异：命令路径在注册表内写绝对路径或显式补 PATH。
3. **Provider 链**：`extractImport` 接受 `ExtractionProvider | ExtractionProvider[]`：
   - 按序尝试；`available() === false` 的通道跳过（全部不可用 → `provider_unavailable`，文案
     列出缺失项）；
   - 每次真实调用都写一条 run：失败也写（含 error），成功写耗时 / token / 成本；
   - 主通道失败自动尝试备用（todo-app 的 fallback 语义）。
4. **状态语义不变**：全部失败 → `provider_error`；无可用通道 → `provider_unavailable`。
   不新增状态、不改变任何现有文案结构（界面文案改为动态带上通道名）。
5. **测试**：现有 12 例（`scripts/import-engine.test.mjs`）保持全绿（单 provider 路径行为不变）；
   新增链式用例：主失败备接管 / 全失败 / 全不可用 / runs 记录完整性；CLI Provider 用 mock 子进程测。

不触碰：`confirmImport` 唯一写库边界、确定性优先分流、防幻觉三层校验。

---

## 6. 配置与密钥（src/lib/server）

新文件 `src/lib/server/ai-channels.ts`（注册表 + 配置读写 + 密钥加密 + 模型清单缓存）：

### 6.1 配置键（app_settings KV）

| 键 | 内容 |
|---|---|
| `ai_import.primary` | `{"channel":"openrouter","model":"google/gemini-3.8-flash"}` |
| `ai_import.fallback` | 同结构 或 不存在（= 未启用备用） |
| `ai_import.keys` | `{ "<channel>": {v:1, iv, tag, data, last4} }`（AES-256-GCM 密文） |
| `ai_import.custom` | `{"baseUrl":"...","label":"..."}`（custom 通道专用） |

### 6.2 密钥策略

- 优先级：**页面配置（DB） > 环境变量**（launchctl / plist 现有渠道继续有效）。
- 加密：AES-256-GCM，主密钥来自 launchctl `RADAR_AI_SECRET`（一次性设置：
  `launchctl setenv RADAR_AI_SECRET "$(openssl rand -hex 32)"`，服务需重启一次生效，此后永久热更新）。
  未设置主密钥时禁止保存新密钥（有明确提示），不影响现有 env 通道使用。
- 威胁模型如实说明：防的是 DB 快照 / 备份泄密；不防本机已失陷（与现状 launchctl 全局 key 同级）。
  备选方案：密钥继续全部走 env（页面只切通道/模型，不做 key 输入框）——见 §13 决策点 2。

### 6.3 模型清单

- 动态拉取：OpenRouter `/models`（免 key）、DeepSeek `/models`、LiteLLM `/v1/models`（需 key）；
  CLI 类：执行本地命令拉取（如 `opencode models`）；`custom`：手填 + 探测按钮。
- 5 分钟内存缓存 + 手动 ⟳ 强刷（对齐 todo-app）；任何通道都允许手填模型 ID。

---

## 7. 服务端接口（server fn，复用现有模式）

| 接口 | 权限 | 说明 |
|---|---|---|
| `getAiChannelSettings` | settings.manage | 通道注册表（就绪状态、密钥来源[页面/环境/无]、尾 4 位掩码）、当前 primary/fallback、模型清单 |
| `saveAiChannelSettings` | settings.manage | 校验（通道合法、模型非空、主备不重复）+ 写库 + `logOp`（before/after，密钥打码） |
| `testAiChannel` | settings.manage | 用内置样例文本走**已保存配置**真实识别一次，返回 status/通道/模型/耗时/token/结果摘要；限流 10 秒/次 |
| `refreshAiChannelModels` | settings.manage | 强制刷新模型清单 |

---

## 8. UI 设计

### 8.1 设置页（settings.tsx 新增「AI 识别通道」卡片）

- 主通道行：`[通道 ▾] [模型 ▾] [⟳] [就绪徽标]`，两级联动（通道 → 模型），模型项含「自定义…」。
- 备用通道行：额外带启用开关；关闭时存 `null`。
- 密钥输入：password 框；placeholder 提示「已从环境变量检测到」或「未配置」；保存后仅显示 `••••尾4位`。
- 就绪徽标：`已就绪` / `缺少密钥` / `地址未配置`。
- 操作：`[保存]`（提示"保存后立即生效，无需重启"）、`[测试识别]` → 结果面板
  （通道 / 模型 / 耗时 / token / 样例候选行数 / 失败原因）。
- 变更历史：走现有 logs 页（`update settings ai_channel` 事件）。

### 8.2 导入页（import.tsx）

- 识别结果区增加通道徽标：「识别：OpenRouter · google/gemini-3.8-flash」。
- 备用接管时显示：「主通道失败，备用通道接管（opencode CLI · deepseek-v4-flash-vision-exp）」（通道名 · 模型名 动态填充）。
- 数据来源：引擎 `runs[]`（adapter 提炼为 `modelLabel` 字段返回）。

---

## 9. 安全与审计

- 密钥：只写不回显、尾 4 位掩码、密文落库、审计脱敏、错误消息不含密钥。
- 权限：读写统一 `settings.manage`；测试接口限流。
- 审计事件：保存（before/after）、测试（结果状态）、模型刷新。
- 恢复说明：主密钥只在 launchctl，不进备份；恢复 DB 快照后需重设主密钥并重填密钥——写入运维文档。

---

## 10. 实施分期

### P0 能力矩阵实测（先行，决定通道集）

- 新增 `scripts/ai-channel-probe.mjs`：对候选通道 × 候选模型跑 3 类样例
  （微信文本 / 陌生表头 Excel 列映射 / 图片），输出矩阵：严格 JSON Schema 支持、视觉、PDF、
  延迟、成本、备注。CLI 类通道一并进矩阵（探测 `claude -p` / `deepseek exec` / `opencode run`
  的非交互可用性、JSON 输出稳定性、附件支持）。
- 复用手头资产：launchctl 里的 OpenRouter key、`免费模型/.env` 的 Groq / NVIDIA key、
  todo-app 的实测经验（如 `deepseek-v4-flash-vision-exp` 视觉可用）。
- 产出：能力矩阵表（追加到本文档附录）→ 决定首批通道与默认备用。

### P1 引擎多通道

- 范围：`OpenAiCompatibleProvider` + provider 链 + runs 记录 + 单测。
- 验收：现有 12 例全绿；新增 4 例链式用例通过。

### P2 配置层与密钥

- 范围：`ai-channels.ts`（注册表/配置/加密/模型缓存）+ 4 个 server fn + env 回退 + `.env.example` 更新。
- 验收：未配置时行为与现状一致（回归）；保存 → DB 可见；密钥密文落库；审计记录出现。

### P3 UI

- 范围：settings 卡片 + 测试按钮 + import 页徽标。
- 验收：浏览器实测四场景（就绪 / 缺 key / 切换生效 / 备用接管）。

### P4 上线与验收（走既有 PR 流程）

- 一次性准备：`RADAR_AI_SECRET` 设置 + 服务重启一次 + 设置页保存一次配置。
- 逐条跑 §11 验收清单。
- 回滚预案：清掉 `ai_import.*` 键即回到 env 模式。

---

## 11. 验收清单

1. 未配置任何内容：导入回归全绿；行为与现状一致（env 驱动 OpenRouter）。
2. 保存 `primary = openrouter / google/gemini-3.8-flash` → 下一次导入 `runs[0].model` 一致；无重启。
3. 保存 `primary = deepseek / <视觉模型>`（填 key）→ 导入走 DeepSeek；导入页徽标一致。
4. 主通道人为失效（清 key）+ 备用可用（含 CLI 类通道实测在线）→ 导入成功；`runs` 两条（failed + completed）；徽标显示备用接管。
5. 两通道都不可用 → 诚实失败文案；不写库。
6. 保存动作在 logs 页可审计；密钥显示为掩码。
7. 测试按钮：就绪通道 30 秒内返回；不可用通道给出明确原因；10 秒限流生效。
8. 重启生产服务 / 自动部署新 release 后：配置仍生效（DB 持久）。
9. DB 检查：密钥字段为密文；UI 无明文回显。
10. 图片/PDF 输入 × 不支持该能力的通道 → 预览页明确提示（不静默降级）。

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 各通道严格 JSON Schema 支持不一 | P0 矩阵实测；UI 标注能力徽标；引擎已有结构校验兜底（`invalid_model_output` → needs_review） |
| CLI 通道输出混入日志 / 非结构化 | 优先 `--format json` 结构化输出；其余走 JSON 块提取 + 引擎结构校验兜底；prompt 固定"只输出 JSON"约束 |
| CLI 登录态过期 / launchd 环境 PATH 差异 | `available()` 含真实探测 + 短缓存；就绪徽标区分「未安装 / 未登录」；命令在注册表写绝对路径或显式补 PATH；文档写明重登步骤 |
| PDF 直连支持面窄（`file` part 主要是 OpenRouter 系） | 能力标注；PDF 场景仅对支持的通道可选；提示可转图片 |
| 本机免费池不稳定 / 未常驻 | 定位为低成本备用而非主链；就绪检查；默认不启用 |
| 密钥进 DB | 加密 + 掩码 + 审计 + 恢复文档；威胁模型如实说明 |
| 配置错误导致识别质量退化 | 测试按钮 + 审计 + 一键清回 env 模式；保留导入质量回归脚本 |
| 与自动部署冲突 | 零 schema 迁移（KV 复用），不触发迁移阻断；配置在 DB 不随 release 走 |

---

## 13. 待决策（4 点）

1. **首批通道集**：建议 `openrouter`（主）+ CLI 类（备，`codex` / `gemini` / `opencode` / `deepseek` / `claude` 全部实测在线）
   + `deepseek-api`（官方 key 已实测有效）+ `custom`（扩展位）先行；`qoder` / `glm`
   补齐后开关即纳入；`litellm-local` 视是否常驻决定？
2. **密钥落位**：推荐 DB 加密（页面可填新通道 key）；若希望密钥继续只走 launchctl / env，
   则页面只做「切换已配置通道」，可砍掉 key 输入框（工作量约 -20%）。CLI 类通道无 key，不受此决策影响。
3. **双跑对比（compare）**：引擎有预留字段，是否本次一并实现（同一输入主备各跑一次、记录差异，
   用于验证期评估）？
4. **本机侧通道纳入范围**：CLI 类（对齐 todo-app：qoder / opencode / codex / deepseek，另有
   claude / gemini）与 pi-part-agent（:8790）等本机服务，本次纳入哪些、还是先 API 直连类、
   二期再上？（CLI 类与 todo-app 模式相同、免 key 零成本，是本机最现成的资产）

---

## 附录 A：相关文件索引

| 用途 | 路径 |
|---|---|
| 引擎 Provider | `packages/import-engine/src/provider.ts` |
| 引擎编排 | `packages/import-engine/src/extract.ts` |
| 引擎类型（接口定义） | `packages/import-engine/src/types.ts` |
| 导入服务端 | `src/lib/server/import.ts` |
| 引擎适配器 | `src/lib/server/import-engine-adapter.ts` |
| 设置服务端 | `src/lib/server/settings.ts` |
| 设置页 UI | `src/routes/settings.tsx` |
| 导入页 UI | `src/routes/import.tsx` |
| 引擎测试 | `scripts/import-engine.test.mjs`（12 例） |
| 生产服务 plist | `~/Library/LaunchAgents/com.xinghao-radar.vite-dev.plist` |
| 生产数据 | `xinghao-radar-deploy/data/pglite` |
| 参考实现（todo-app） | `agent-recognition-v1` 分支：`src/settings.js`、`public/app.js` 设置弹窗 |
