# Import Agent Routing — test evidence

Source of truth: `tests/import-agent-routing/routing.test.mjs`  
Harness companion: `scripts/harness-import.test.mjs`

| Case | Input | Must not | Must |
|---|---|---|---|
| known template | 表头 `型号,品牌,数量,...` | 调用 Platform | `extractOrigin=trusted_template`，行来自 `tableToRows` |
| unknown supplier Excel | `Part Number, Maker, Available, Target, Leadtime` | `headerKey` 当成功 | `needs_mapping`，0 行 |
| unknown Chinese Excel | `货号,品牌,库存数,含税单价` | 白名单误判 | `needs_mapping` |
| chat text | 老陈 / 还有一批 / 一块一美金左右 | `heuristicParse` 当主结果 | Platform semantic / `needs_mapping` |
| controlled text | `TPS7A4700RGWR  20K  ...` | 调 Platform | `extractOrigin=controlled_text` |
| image vision_unavailable | HTTP 422 + `error=vision_unavailable` | 当成普通空 candidates 失败 | `extractState=vision_unavailable`；本地降级则 `origin=local_fallback` |
| platform unavailable | `status=0` / `network_error` | 未知 Excel regex 成功 | 页面仍可解析返回；0 行 |
| ambiguous MPN | `TPS54560DDA?` | 补成 `TPS54560DDAR` | 原样保留 |
| needsAgent empty candidates | `needsAgent=true, candidates=[]` | 再进任意 Excel header regex 并成功 | `needs_mapping`，`rows=[]` |

`headerKey("Part Number") === "mpn"` 作为 helper 仍然成立；路由层不得用它让 unbounded 表成功。
