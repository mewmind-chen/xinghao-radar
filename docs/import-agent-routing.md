# Radar Import Agent Routing

本文件记录 Radar 对 `POST /v1/import/extract` 的合同解释修正。不修改 Platform Contract、Plugin、Workbench。

## 1. 修改前链路

```
用户输入
  → import.tsx / 工作台粘贴
  → parseImport
  → extractViaPlatform (mode=auto)
  → 若 candidates.length === 0：
        把 needsAgent 当成 Platform 失败（返回 null）
  → runImportAgent
  → 仍无行：parseExcel / parseCsv + tableToRows(headerKey)
  → 仍无行：heuristicParse
  → Preview → Human Confirm → confirmImport → DB
```

图片：`postJson` 在 HTTP 非 2xx 时丢弃 body，`422 vision_unavailable` 被当成普通失败。

## 2. 问题根因

立项问题是：

> 陌生供应商 Excel / 文本不能因为本地 parser 看起来能识别，就绕过 Agent semantic extraction。

Platform import-core 对未知表格返回：

- `needsAgent: true`
- `reason: table_mapping_required`
- `candidates: []`
- `preview: { header, sample }`

这表示 **Platform 已成功理解：不能走固定 mapping，需要 Agent schema mapping**。不是失败。

Radar 旧判断是 `candidates.length > 0` 才算成功。空 candidates + needsAgent → `extractViaPlatform` 返回 `null` → 本地 `headerKey("Part Number") === "mpn"` / `heuristicParse` 抽出一行 → UI 显示识别成功 → AI 被跳过。

`422 vision_unavailable` 的 JSON 也被丢掉，图片失败被显示成“没有识别到型号”。

## 3. 输入分类

| 类别 | 判定 | 主路径 |
|---|---|---|
| Trusted deterministic table | 表头精确为 `型号` / `mpn` / `料号` | 本地 `tableToRows`，不调 Platform |
| Unbounded table | 任意供应商列名（`Part Number`、`货号`、`Available`…） | Platform；禁止 headerKey 成功 |
| Controlled text | 每行 `MPN + 数量单位(K/万/W)`，且无叙事词 | 本地 `heuristicParse` fast-path |
| Unbounded text | 微信/聊天/叙事（`那边`、`还有一批`、`左右`…） | Platform semantic extraction |
| Image | `sourceType=image` | Platform；`vision_unavailable` 可本地视觉降级并标记 |
| PDF / Word | 按 Platform 真实能力 | Agent 不可用则诚实失败 / 已有 fallback；本阶段不补 PDF Agent |

`headerKey` / `tableToRows` / `heuristicParse` 仍存在，但是 **helper / validator / 受信 fast-path / 明确 fallback**，不是无界输入的成功入口。

## 4. Platform response state machine

Radar `interpretPlatformExtract`（不改 Contract 字段）：

| 条件 | ExtractState | Radar 行为 |
|---|---|---|
| 有效 `candidates` | `completed` | Preview，`extractOrigin=platform` |
| `needsAgent` + 空 candidates（如 `table_mapping_required` / `unstructured_required`） | `needs_mapping` | 0 行 + 明确文案；**禁止** headerKey / heuristic 主成功 |
| `error/reason/fallbackFrom = agent_unavailable` | `agent_unavailable` | 未知表 0 行；不伪装成功 |
| `error = vision_unavailable`（含 422 body） | `vision_unavailable` | 可 `runLocalImageFallback`，必须 `extractOrigin=local_fallback` |
| 校验失败 / 无效请求 | `invalid` | 用户可理解错误 |
| 超时 / 网络 / 401 / 5xx | `platform_unavailable` | 未知 Excel 不 regex 成功；受控模板仍可本地；无界文本仅作 **标记过的** heuristic fallback |

不再使用：`candidates.length > 0` 才算 Platform 成功。

## 5. deterministic vs Agent 边界

- **有界、稳定、已知格式** → 确定性代码（内部模板、受控行情行、数量/价格/NFKC、重复检测、写库）。
- **无界、变化、不可穷举的语义** → Agent（未知列名、微信叙述、图片视觉）。
- **事实约束** → `verifyMpnProvenance` / validator；禁止补型号、改型号、猜型号。
- **最终确认** → Human Confirm。Agent / Platform / fallback 都不写 Radar DB。

## 6. fallback 规则

| 场景 | 允许 | 禁止 |
|---|---|---|
| 内部模板 | 本地 `tableToRows` | 调 LLM |
| 未知 Excel + needsAgent | 等待 Platform mapping/candidates | headerKey 当成功 |
| 未知 Excel + Platform 挂了 | 页面仍可用（仓库/渠道列表）；0 行 + 说明 | 用 Part Number regex 冒充成功 |
| 微信文本 + needsAgent | semantic extraction | heuristic 抢先当主结果 |
| 微信文本 + Platform 挂了 | heuristic，`extractOrigin=local_fallback` | 显示成 Platform AI 成功 |
| 图片 vision_unavailable | 现有 xAI `runImportAgent`，标记 fallback | 显示成识别成功 / 普通空结果 |
| PDF/Word agent_unavailable | 诚实失败或已有业务 fallback | 本阶段补 PDF Agent |

## 7. MPN provenance

- 展示 MPN：仅 NFKC + trim（`displayMpn`）。
- `normalizeMpn` 大写只作 lookup key。
- 歧义 `TPS54560DDA?` 不得补成 `TPS54560DDAR`。
- AI 抽出原文没有的 MPN → `verifyMpnProvenance` warning，值不动。

## 8. Preview / confirm 边界

无论 `platform` / `trusted_template` / `controlled_text` / `local_fallback`：

```
ImportCandidate / ImportRow
  → Radar Preview（含 origin 标签）
  → Human Confirm
  → confirmImport
  → DB
```

`confirmImport` 本阶段零逻辑改动。

## 9. 测试案例

见 `tests/import-agent-routing/routing.test.mjs` 与 `tests/import-agent-routing/EVIDENCE.md`。

1. 固定内部 Excel → deterministic，不调 Platform  
2. `Part Number / Maker / Available` → 不能 headerKey 成功 → `needs_mapping`  
3. `货号 / 库存数 / 含税单价` → 同样 unbounded  
4. 微信文本 → heuristic 不得当主结果  
5. 受控行情行 → 本地 fast-path  
6. `vision_unavailable` → 可本地降级并标记  
7. Platform 网络不可用 → 未知 Excel 不 regex 成功；页面仍返回 preview 结构  
8. 歧义 MPN 不补全  
9. **needsAgent + empty candidates 不再进入任意 Excel regex 成功**

## 10. 修改后完整链路

```
用户输入
  → sourceType + 表格/文本分类
      A. trusted table     → tableToRows → origin=trusted_template
      B. controlled text   → heuristicParse → origin=controlled_text
      C. unbounded / image / document
            → POST /v1/import/extract (mode=auto)  [body 在 4xx 也保留]
            → interpretPlatformExtract
                 completed + candidates → origin=platform → Preview
                 needs_mapping          → 0 行，明确需要智能映射
                 agent_unavailable      → 0 行（未知表禁止 regex）
                 vision_unavailable     → 可选本地视觉，origin=local_fallback
                 platform_unavailable   → 未知表 0 行；无界文本可标记 heuristic
  → markDuplicates（本地）
  → Preview（origin 对用户可见）
  → Human Confirm
  → confirmImport
  → DB
```

`packages/harness-import` 仍参与：受信 Excel/CSV、受控文本、图片本地 fallback。不再作为无界输入的 heuristic-first 主链。
