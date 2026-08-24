/**
 * @xinghao/harness-import —— DeepSeek Harness V1 插件化 AI 输入处理层。
 *
 * Profile: xinghao-radar-import（方案第 17 节）
 * 包含：model plugin / files / vision / document parser / xinghao domain adapter
 * 不包含：market research / browser automation / supplier crawling /
 *         autonomous scheduling / write actions
 */

export { runImportAgent, runImportAgentWith, IMPORT_SYSTEM_PROMPT } from "./agent.ts";
export type { AgentInput, AgentOutcome } from "./agent.ts";

export { routeInput } from "./input-router.ts";
export type { InputPlugin, RouteDecision } from "./input-router.ts";

export {
  OpenAICompatibleProvider,
  defaultProviders,
  pickProvider,
  parseModelJson,
  asCurrency,
  asCostTax,
  asPackState,
} from "./model-adapter.ts";
export type { ImportModelProvider, ProviderConfig, ProviderExtract } from "./model-adapter.ts";

export { rawRowsToImportRows, verifyMpnProvenance } from "./domain-adapter.ts";
export { heuristicParse } from "./rule-parser.ts";
export { headerKey, tableToRows } from "./table.ts";
export { isTrustedImportTable, isControlledImportText, isTrustedMpnHeader, TRUSTED_MPN_HEADERS } from "./input-class.ts";
export { validateImportRows, isImportKind, IMPORT_KINDS } from "./schema.ts";
export type {
  ImportKind,
  ImportSource,
  ImportRow,
  RawExtractedRow,
} from "./schema.ts";

export { extractTextLines } from "./plugins/text-extractor.ts";
export { toImageDataUrl } from "./plugins/vision-extractor.ts";
export { extractDocumentText } from "./plugins/document-parser.ts";
export { parseExcel } from "./plugins/excel-parser.ts";
export { parseCsv } from "./plugins/csv-parser.ts";
