import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Camera, ClipboardPaste, FileSpreadsheet, Image, Mic } from "lucide-react";
import { confirmImport, parseImport, type ParseImportInput } from "@/lib/server/import";
import { listImportBatches, undoImportBatch } from "@/lib/server/settings";
import { formatWhen } from "@/lib/domain";
import { sampleImportText, parseQty, correctTradeText } from "@/lib/domain";
import type { CostTax, Currency, ImportKind, ImportRow, ImportSource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAppAccess } from "@/lib/auth/use-app-access";
import { resolveDateCode } from "@/lib/inventory/date-code";

export const Route = createFileRoute("/import")({ component: ImportPage });

function ImportPage() {
  const qc = useQueryClient();
  const access = useAppAccess();
  const canMarketImport = access.can("market.write");
  const canStockImport = access.can("inventory.import");
  const canPotentialImport = access.can("potential.write");
  const batches = useQuery({ queryKey: ["import-batches"], queryFn: () => listImportBatches() });
  const [kind, setKind] = useState<ImportKind>("offer");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [rowFilter, setRowFilter] = useState<"all" | "selected" | "review" | "duplicate">("all");
  const [rowQuery, setRowQuery] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [importStatus, setImportStatus] = useState<"draft" | "preview" | "writing" | "success" | "failed">("draft");
  const [usedAi, setUsedAi] = useState(false);
  const [extractOrigin, setExtractOrigin] = useState<string | null>(null);
  const [extractState, setExtractState] = useState<string | null>(null);
  const [extractMessage, setExtractMessage] = useState<string | null>(null);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [channel, setChannel] = useState("");
  const [customer, setCustomer] = useState("");
  const [supplier, setSupplier] = useState("");
  const [currency, setCurrency] = useState<Currency>("CNY");
  const [tax, setTax] = useState<CostTax>("exclusive");
  const [warehouseId, setWarehouseId] = useState("");
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; code: string }[]>([]);
  const [summary, setSummary] = useState<null | {
    identified: number;
    hit: number;
    stock: number;
    inquiry: number;
    dual: number;
    potential?: number;
    batchId: string;
  }>(null);
  const [filename, setFilename] = useState<string | undefined>();
  const [sourceType, setSourceType] = useState<ImportSource>("text");
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("kind");
    if (preset === "stock" || preset === "transit" || preset === "offer" || preset === "inquiry" || preset === "potential" || preset === "mixed") {
      setKind(preset);
    }
    const draft = sessionStorage.getItem("import-draft");
    if (draft) {
      sessionStorage.removeItem("import-draft");
      setText(correctTradeText(draft));
    }
  }, []);

  useEffect(() => {
    if (!canMarketImport && canStockImport && (kind === "offer" || kind === "inquiry" || kind === "mixed")) {
      setKind("stock");
    } else if (!canStockImport && (kind === "stock" || kind === "transit")) {
      setKind("offer");
    } else if (!canPotentialImport && kind === "potential") {
      setKind(canMarketImport ? "offer" : "stock");
    }
  }, [canMarketImport, canStockImport, canPotentialImport, kind]);

  const parseMut = useMutation({
    mutationFn: (input: ParseImportInput) => parseImport({ data: input }),
    onSuccess: (r) => {
      setSubmissionId(crypto.randomUUID());
      setImportStatus("preview");
      const fallbackWarehouseCode = r.warehouses.find((w) => w.id === (warehouseId || r.warehouses[0]?.id))?.code ?? null;
      setRows(r.rows.map((row) => kind === "stock" ? {
        ...row,
        warehouse: row.warehouse ?? fallbackWarehouseCode,
        channel: (row.channel ?? supplier) || null,
        costCurrency: row.costAmount == null ? row.costCurrency : row.costCurrency ?? currency,
        costTax: row.costAmount == null ? row.costTax : row.costTax ?? tax,
      } : row));
      setUsedAi(r.usedAi);
      setExtractOrigin(r.extractOrigin ?? null);
      setExtractState(r.extractState ?? null);
      setExtractMessage(r.extractMessage ?? null);
      setAiAvailable(r.aiAvailable);
      setChannels(r.channels);
      setCustomers(r.customers);
      setWarehouses(r.warehouses);
      if (!channel && r.channels[0]) setChannel(r.channels[0].name);
      if (!customer && r.customers[0]) setCustomer(r.customers[0].name);
      if (!warehouseId && r.warehouses[0]) setWarehouseId(r.warehouses[0].id);
      if ((r.extractState === "vision_unavailable" || r.extractState === "provider_unavailable" || r.extractState === "provider_error") && r.rows.length === 0) {
        toast.error(r.extractMessage || "当前无法识别图片");
      } else if (r.extractState === "needs_mapping" || r.extractState === "needs_review") {
        toast.error(r.extractMessage || "需要智能列映射");
      } else if (r.extractState === "platform_unavailable" && r.rows.length === 0) {
        toast.error(r.extractMessage || "Platform 暂不可用");
      } else if ((r.extractState === "invalid_input" || r.extractState === "unsupported") && r.rows.length === 0) {
        toast.error(r.extractMessage || "文件无法解析");
      } else if (r.rows.length === 0) {
        toast.error(r.extractMessage || "没有识别到型号");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const confirmMut = useMutation({
    mutationFn: async () => {
      if (!rows) throw new Error("请先预览");
      return confirmImport({
        data: {
          kind,
          sourceType,
          filename,
          excerpt: text.slice(0, 500),
          defaultChannel: channel || undefined,
          defaultCustomer: customer || undefined,
          defaultWarehouseId: warehouseId || undefined,
          defaultSupplier: supplier || undefined,
          defaultCurrency: currency,
          defaultTax: tax,
          submissionId,
          rows,
        },
      });
    },
    onSuccess: (r) => {
      qc.invalidateQueries();
      setImportStatus("success");
      setSummary({ ...r.summary, batchId: r.batchId });
      toast.success(kind === "potential"
        ? `已加入 ${r.summary.potential ?? r.summary.identified} 个潜力型号`
        : `识别 ${r.summary.identified}；命中 ${r.summary.hit}；库 ${r.summary.stock} · 客 ${r.summary.inquiry} · 双命中 ${r.summary.dual}`);
    },
    onError: (e: Error) => { setImportStatus("failed"); toast.error(e.message); },
  });

  async function onFile(file: File, src: ImportSource) {
    if (file.size > 20 * 1024 * 1024) {
      toast.error("文件超过 20MB 限制");
      return;
    }
    setFilename(file.name);
    setSourceType(src);
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const b64 = toBase64(bytes);
    if (src === "csv") {
      const t = new TextDecoder().decode(buf);
      setText(t);
    } else setText("");
    parseMut.mutate({
      kind,
      sourceType: src,
      defaultWarehouseId: warehouseId || undefined,
      defaultSupplier: supplier || undefined,
      defaultCurrency: currency,
      defaultTax: tax,
      filename: file.name,
      fileBase64: b64,
      mime: file.type,
      text: src === "csv" ? new TextDecoder().decode(buf) : undefined,
    });
  }

  async function pasteClipboardImage() {
    if (!navigator.clipboard?.read) {
      toast.error("当前浏览器不支持直接读取剪贴板图片，请在下方输入框按 Ctrl+V 粘贴截图");
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const item = items.find((candidate) => candidate.types.some((type) => type.startsWith("image/")));
      if (!item) {
        toast.message("剪贴板里没有图片，请先在聊天或邮件界面截图并复制");
        return;
      }
      const mime = item.types.find((type) => type.startsWith("image/")) || "image/png";
      const blob = await item.getType(mime);
      const extension = mime.split("/")[1]?.replace("jpeg", "jpg") || "png";
      await onFile(new File([blob], `clipboard-screenshot.${extension}`, { type: mime }), "image");
    } catch {
      toast.error("读取截图失败，请先复制截图，再回到输入框按 Ctrl+V");
    }
  }

  function listen() {
    const SR = (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition
      || (window as unknown as { SpeechRecognition?: new () => SpeechRec }).SpeechRecognition;
    if (!SR) {
      toast.error("当前浏览器不支持语音，请粘贴转写文本");
      return;
    }
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.onresult = (ev: { results: { 0: { 0: { transcript: string } } } }) => {
      const t = correctTradeText(ev.results[0][0].transcript);
      setText((prev) => (prev ? prev + "\n" + t : t));
    };
    rec.start();
    toast.message("正在听…");
  }

  function stockRowError(row: ImportRow): string | null {
    if (kind !== "stock" && row.kind !== "stock") return null;
    if (!row.mpn.trim()) return "型号为空";
    if (row.qty == null || !Number.isInteger(row.qty) || row.qty <= 0) return "数量必须为正整数";
    if (!row.warehouse && !warehouseId) return "缺少仓库";
    if (row.dateCode && resolveDateCode(row.dateCode, row.qty, row.standardPack).warning) return "DC 无法确认，请补充标准装量或拆分包数";
    if (row.costAmount == null) return row.costCurrency || row.costTax ? "成本为空时不能保留币种或税别" : null;
    if (!Number.isFinite(row.costAmount) || row.costAmount < 0) return "成本无效";
    const rowCurrency = row.costCurrency ?? currency;
    const rowTax = row.costTax ?? tax;
    if (!rowCurrency) return "缺少币种";
    if (rowCurrency === "USD" && rowTax !== "none") return "美元税别必须为无";
    if (rowCurrency === "CNY" && rowTax !== "exclusive" && rowTax !== "inclusive") return "人民币请选择含或未";
    return null;
  }

  const selectedCount = rows?.filter((r) => r.selected).length ?? 0;
  const blockingCount = rows?.filter((r) => r.selected && stockRowError(r)).length ?? 0;
  const visibleRows = rows
    ?.map((row, idx) => ({ row, idx }))
    .filter(({ row }) => {
      const matchesQuery = !rowQuery.trim() || [row.mpn, row.brand, row.dateCode, row.warehouse, row.channel, row.customer]
        .filter(Boolean).join(" ").toUpperCase().includes(rowQuery.trim().toUpperCase());
      const matchesFilter = rowFilter === "all"
        || (rowFilter === "selected" && row.selected)
        || (rowFilter === "review" && Boolean(row.warning || stockRowError(row)))
        || (rowFilter === "duplicate" && row.duplicate);
      return matchesQuery && matchesFilter;
    }) ?? [];

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4">
      <div>
        <h1 className="text-xl font-medium">智能导入</h1>
        <p className="text-sm text-muted-foreground">
          支持文本、Excel/CSV、图片、PDF 和 DOCX。先预览再入库，模型不会擅自改写型号；人工修改后必须重新勾选。
        </p>
      </div>

      {summary && (
        <div className="rounded-xl bg-hit px-4 py-3 text-hit-foreground">
          {kind === "potential"
            ? `已加入 ${summary.potential ?? summary.identified} 个潜力型号`
            : <>识别 {summary.identified} 个型号；命中 {summary.hit}；库 {summary.stock} · 客{" "}
              {summary.inquiry} · 双命中 {summary.dual}</>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" asChild>
              <Link to="/">看工作台</Link>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-hit-foreground"
              onClick={() => {
                setSummary(null);
                setRows(null);
                setImportStatus("draft");
                setSubmissionId(crypto.randomUUID());
              }}
            >
              再导一份
            </Button>
          </div>
        </div>
      )}

      {batches.data && batches.data.length > 0 && (
        <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
          <h2 className="mb-2 text-sm font-medium">导入批次</h2>
          <ul className="space-y-2 text-xs">
            {batches.data.map((batch) => (
              <li key={batch.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">
                  {labelKind(batch.kind)} · {batch.sourceType} {batch.filename ?? ""} · {formatWhen(batch.createdAt)}
                  <span className="ml-2">{batch.status === "writing" ? "写入中" : batch.status === "failed" ? "失败" : "成功"}</span>
                  {batch.undoneAt && <span className="ml-2 text-muted-foreground">已撤销</span>}
                </span>
                {batch.canRevoke && !batch.undoneAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => undoImportBatch({ data: { id: batch.id } }).then(() => { void qc.invalidateQueries({ queryKey: ["import-batches"] }); toast.success("批次已撤销"); }).catch((err: Error) => toast.error(err.message))}
                  >撤销</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label>导入为</Label>
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
              {canMarketImport && <>
                <option value="offer">渠道推货</option>
                <option value="inquiry">客户询价</option>
              </>}
              {canStockImport && <>
                <option value="stock">入库</option>
                <option value="transit">在途</option>
              </>}
              {canPotentialImport && <option value="potential">潜力型号</option>}
              {canMarketImport && canStockImport && <option value="mixed">自动判断</option>}
            </NativeSelect>
            {kind === "potential" && <p className="mt-1 text-xs text-muted-foreground">只加入潜力型号关注池，不写入库存、渠道或客户数据。</p>}
          </div>
          {(kind === "offer" || kind === "mixed") && (
            <div>
              <Label>默认渠道（文本里没有时）</Label>
              <Input list="imp-ch" value={channel} onChange={(e) => setChannel(e.target.value)} />
              <datalist id="imp-ch">
                {channels.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </div>
          )}
          {(kind === "inquiry" || kind === "mixed") && (
            <div>
              <Label>默认客户</Label>
              <Input list="imp-cu" value={customer} onChange={(e) => setCustomer(e.target.value)} />
              <datalist id="imp-cu">
                {customers.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </div>
          )}
          {(kind === "stock" || kind === "mixed") && (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label>默认仓库</Label>
                <NativeSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">请选择</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div>
                <Label>默认供应商</Label>
                <Input list="imp-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
                <datalist id="imp-supplier">
                  {channels.map((c) => <option key={c.id} value={c.name} />)}
                </datalist>
              </div>
              <div>
                <Label>默认币种</Label>
                <ChoiceButtons
                  value={currency}
                  options={[{ value: "USD", label: "USD" }, { value: "CNY", label: "CNY" }]}
                  onChange={(v) => {
                    const next = v as Currency;
                    setCurrency(next);
                    if (next === "USD") setTax("none");
                  }}
                />
              </div>
              <div>
                <Label>人民币税别</Label>
                <ChoiceButtons
                  value={currency === "USD" ? "none" : tax}
                  options={[{ value: "none", label: "无" }, { value: "exclusive", label: "未" }, { value: "inclusive", label: "含" }]}
                  disabled={currency === "USD"}
                  onChange={(v) => setTax(v as CostTax)}
                />
              </div>
            </div>
          )}
        </div>
        <Textarea
          className="mt-3 min-h-36 font-mono text-sm"
          placeholder={kind === "potential" ? "粘贴型号清单、聊天记录或截图文字…" : "粘贴聊天记录、货期、型号清单…"}
          value={text}
          onPaste={(event) => {
            const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
            if (!image) return;
            event.preventDefault();
            void onFile(image, "image");
          }}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={parseMut.isPending || !text.trim()}
            onClick={() => {
              setSourceType("text");
              setFilename(undefined);
              parseMut.mutate({
                kind,
                sourceType: "text",
                text,
                defaultWarehouseId: warehouseId || undefined,
                defaultSupplier: supplier || undefined,
                defaultCurrency: currency,
                defaultTax: tax,
              });
            }}
          >
            <ClipboardPaste className="size-4" />
            识别预览
          </Button>
          <Button variant="outline" onClick={() => setText(sampleImportText())}>
            填入示例
          </Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <FileSpreadsheet className="size-4" />
            导入文件
          </Button>
          <Button variant="outline" onClick={() => camRef.current?.click()}>
            <Camera className="size-4" />
            拍照
          </Button>
          <Button variant="outline" onClick={() => albumRef.current?.click()}>
            <Image className="size-4" />
            相册
          </Button>
          <Button variant="outline" onClick={() => void pasteClipboardImage()}>
            <ClipboardPaste className="size-4" />
            粘贴截图
          </Button>
          <Button variant="outline" onClick={listen}>
            <Mic className="size-4" />
            语音
          </Button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".xlsx,.xls,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,.pdf,.doc,.docx"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const name = f.name.toLowerCase();
              if (f.type.startsWith("image/")) {
                void onFile(f, "image");
                return;
              }
              const src: ImportSource = name.endsWith(".csv")
                ? "csv"
                : name.endsWith(".pdf")
                  ? "pdf"
                  : name.endsWith(".doc") || name.endsWith(".docx")
                    ? "word"
                    : "excel";
              void onFile(f, src);
            }}
          />
          <input
            ref={camRef}
            type="file"
            className="hidden"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void onFile(f, "image");
            }}
          />
          <input
            ref={albumRef}
            type="file"
            className="hidden"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void onFile(f, "image");
            }}
          />
        </div>
        {!aiAvailable && (
          <p className="mt-2 text-xs text-muted-foreground">
            固定内部模板与受控格式仍可本地识别。陌生表格与聊天文本需要智能抽取，不会再用猜测表头冒充成功。
          </p>
        )}
      </section>

      {rows && (
        <section className="rounded-xl bg-card p-3 shadow-[var(--shadow-border)] md:p-4">
          <div className="sticky top-[57px] z-10 -mx-3 mb-3 border-b border-border bg-card/95 px-3 pb-3 backdrop-blur-sm md:-mx-4 md:px-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              预览 {rows.length} 行
              {extractOrigin === "engine_deterministic"
                ? " · 本地确定性识别"
                : extractOrigin === "engine_ai"
                  ? " · OpenRouter AI 识别"
                  : extractOrigin === "trusted_template"
                ? " · 固定模板"
                : extractOrigin === "controlled_text"
                  ? " · 受控格式"
                  : extractOrigin === "local_fallback"
                    ? extractState === "vision_unavailable"
                      ? " · 本地视觉降级"
                      : " · 本地降级"
                    : extractOrigin === "platform" || usedAi
                      ? " · AI 识别（Platform）"
                      : ""}
            </h2>
            <Button className="hidden md:inline-flex" disabled={confirmMut.isPending || importStatus === "writing" || importStatus === "success" || selectedCount === 0 || blockingCount > 0} onClick={() => { setImportStatus("writing"); confirmMut.mutate(); }}>
              {importStatus === "success" ? "✓ 已成功导入" : importStatus === "writing" || confirmMut.isPending ? `正在写入 ${selectedCount} 行…` : `确认写入 ${selectedCount} 行`}
            </Button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ReviewStat label="总行数" value={rows.length} />
              <ReviewStat label="待写入" value={selectedCount} />
              <ReviewStat label="待检查" value={rows.filter((row) => Boolean(row.warning || stockRowError(row))).length} />
              <ReviewStat label="疑似重复" value={rows.filter((row) => row.duplicate).length} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Input className="h-8 min-w-48 flex-1 text-xs" value={rowQuery} onChange={(event) => setRowQuery(event.target.value)} placeholder="搜索型号、DC、仓库…" />
              <NativeSelect className="h-8 w-28 text-xs" value={rowFilter} onChange={(event) => setRowFilter(event.target.value as typeof rowFilter)}>
                <option value="all">全部行</option>
                <option value="selected">待写入</option>
                <option value="review">待检查</option>
                <option value="duplicate">疑似重复</option>
              </NativeSelect>
            </div>
            {importStatus === "writing" && <p className="mt-2 text-xs text-muted-foreground">写入中…按钮已锁定，服务端会按幂等键处理重复请求。</p>}
            {importStatus === "success" && <p className="mt-2 rounded-md bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-700">写入成功。本次提交结果已保留，重复点击不会重复入库。</p>}
            {importStatus === "failed" && <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">写入失败。请检查错误并重新生成一份新预览。</p>}
          </div>
          <details className="mb-3 rounded-lg border border-border px-3 py-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">查看原始证据（仅预览，不会自动写入）</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{text || filename || "当前来源没有可展示的文本摘要"}</pre>
          </details>
          <p className="mb-3 text-xs text-muted-foreground">
            型号请人工核对。疑似重复已勾掉，若确为新事件可重新勾选。
            {extractMessage ? ` ${extractMessage}` : ""}
            {blockingCount > 0 ? ` 有 ${blockingCount} 行存在阻断错误，修正后才能确认。` : ""}
          </p>
          <div className="hidden border-y border-border pb-2 text-[10px] text-muted-foreground md:grid md:grid-cols-[28px_minmax(180px,1.3fr)_90px_90px_110px_100px_110px] md:gap-2 md:px-3 md:pt-2">
            <span /> <span>型号 / 状态</span><span>业务类型</span><span>数量</span><span>DC</span><span>仓库</span><span>成本 / 供应商</span>
          </div>
          <ul className="min-w-0 space-y-2 md:space-y-0 md:divide-y md:divide-border">
            {visibleRows.map(({ row, idx }) => (
              <li
                key={row.id}
                className={cn(
                  "min-w-0 overflow-hidden rounded-lg border border-border px-3 py-2 md:grid md:grid-cols-[28px_minmax(180px,1.3fr)_90px_90px_110px_100px_110px] md:items-start md:gap-2 md:rounded-none md:border-0 md:px-3 md:py-2",
                  row.duplicate && "border-warn/40 bg-warn/5",
                )}
              >
                <div className="flex items-start gap-2 md:contents">
                  <Checkbox
                    checked={row.selected}
                    onCheckedChange={(v) =>
                      setRows((rs) =>
                        rs?.map((r, i) => (i === idx ? { ...r, selected: Boolean(v) } : r)) ?? null,
                      )
                    }
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1 md:contents">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="min-w-48 max-w-full">
                        <span className="sr-only">型号（人工核对）</span>
                        <Input
                          className="h-7 w-56 max-w-full px-2 font-mono text-xs"
                          value={row.mpn}
                          onChange={(e) => patch(idx, { mpn: e.target.value, selected: false, warning: "型号已人工修改，请再次核对" })}
                          aria-label="型号（人工核对）"
                        />
                      </label>
                      {kind === "mixed" ? (
                        <NativeSelect
                          className="h-7 w-auto min-w-24 px-1 text-[11px]"
                          value={row.kind}
                          onChange={(e) => {
                            const nextKind = e.target.value as ImportKind;
                            const warning = row.warning
                              ?.split("；")
                              .filter((message) => !message.includes("业务类型无法确定"))
                              .join("；") || null;
                            patch(idx, {
                              kind: nextKind,
                              selected: false,
                              warning: [warning, "业务类型已人工修改，请复核写入"].filter(Boolean).join("；"),
                            });
                          }}
                          aria-label={`${row.mpn} 业务类型`}
                        >
                          <option value="mixed">请选择类型</option>
                          <option value="offer">推货</option>
                          <option value="inquiry">询价</option>
                          <option value="stock">入库</option>
                          <option value="transit">在途</option>
                        </NativeSelect>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">{labelKind(kind === "stock" ? "stock" : row.kind)}</span>
                      )}
                      {row.duplicate && (
                        <span className="text-[11px] text-warn">{row.duplicateReason}</span>
                      )}
                    </div>
                    {kind === "potential" ? (
                      <div className="hidden mt-2 text-xs text-muted-foreground md:col-span-5 md:mt-0 md:block">
                        仅建立潜力型号关注，不写入库存、渠道或客户事件。
                      </div>
                    ) : (kind === "stock" || row.kind === "stock") ? (
                      <div className="hidden mt-2 min-w-0 grid-cols-2 gap-2 md:col-span-5 md:mt-0 md:grid md:grid-cols-6">
                        <Mini label="数量" value={row.qtyRaw ?? (row.qty != null ? String(row.qty) : "")} onChange={(v) => patch(idx, { qtyRaw: v, qty: parseQty(v) })} />
                        <Mini label="DC" value={row.dateCode ?? ""} onChange={(v) => patch(idx, { dateCode: v })} />
                        <Mini label="标准装量" value={row.standardPack ?? ""} onChange={(v) => patch(idx, { standardPack: v || null, selected: false })} />
                        <Mini label="供应商" value={row.channel ?? ""} onChange={(v) => patch(idx, { channel: v })} />
                        <label className="block"><span className="text-[10px] text-muted-foreground">仓库</span><NativeSelect className="mt-0.5 h-8 w-full text-xs" value={row.warehouse ?? ""} onChange={(e) => patch(idx, { warehouse: e.target.value || null })}><option value="">默认仓库</option>{warehouses.map((w) => <option key={w.id} value={w.code}>{w.code}</option>)}</NativeSelect></label>
                        <Mini label="成本金额" value={row.costAmount == null ? "" : String(row.costAmount)} onChange={(v) => patch(idx, { costAmount: v.trim() === "" ? null : Number(v) })} />
                        <label className="block min-w-0"><span className="text-[10px] text-muted-foreground">币种 / 税</span><div className="mt-0.5 grid min-w-0 grid-cols-2 gap-1"><NativeSelect className="h-8 min-w-0 px-1 text-xs" value={row.costCurrency ?? ""} onChange={(e) => patch(idx, { costCurrency: (e.target.value || null) as Currency | null, costTax: e.target.value === "USD" ? "none" : row.costTax })}><option value="">—</option><option value="USD">USD</option><option value="CNY">CNY</option></NativeSelect><NativeSelect className="h-8 min-w-0 px-1 text-xs" value={row.costCurrency === "USD" ? "none" : row.costTax ?? ""} disabled={row.costCurrency === "USD"} onChange={(e) => patch(idx, { costTax: (e.target.value || null) as CostTax | null })}><option value="">—</option><option value="none">无</option><option value="exclusive">未</option><option value="inclusive">含</option></NativeSelect></div></label>
                      </div>
                    ) : (
                      <div className="hidden mt-2 grid-cols-2 gap-2 md:col-span-5 md:mt-0 md:grid md:grid-cols-4">
                        <Mini label="数量" value={row.qtyRaw ?? (row.qty != null ? String(row.qty) : "")} onChange={(v) => patch(idx, { qtyRaw: v, qty: parseQty(v) })} />
                        <Mini label="DC" value={row.dateCode ?? ""} onChange={(v) => patch(idx, { dateCode: v })} />
                        <Mini label="渠道" value={row.channel ?? ""} onChange={(v) => patch(idx, { channel: v })} />
                        <Mini label="客户" value={row.customer ?? ""} onChange={(v) => patch(idx, { customer: v })} />
                      </div>
                    )}
                    {row.note && <p className="mt-1 truncate text-[11px] text-muted-foreground">{row.note}</p>}
                    {row.warning && <p className="mt-1 text-[11px] text-warn">{row.warning}</p>}
                    <Button className="mt-2 md:hidden" size="sm" variant="outline" onClick={() => setEditingIdx(idx)}>编辑本行</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {visibleRows.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">没有符合当前筛选的行。</p>}
          <div className="fixed inset-x-3 bottom-16 z-20 md:hidden">
            <Button className="w-full shadow-lg" disabled={confirmMut.isPending || importStatus === "writing" || importStatus === "success" || selectedCount === 0 || blockingCount > 0} onClick={() => { setImportStatus("writing"); confirmMut.mutate(); }}>
              {importStatus === "success" ? "✓ 已成功导入" : importStatus === "writing" || confirmMut.isPending ? `正在写入 ${selectedCount} 行…` : `确认写入 ${selectedCount} 行`}
            </Button>
          </div>
        </section>
      )}

      <Sheet open={editingIdx != null} onOpenChange={(value) => { if (!value) setEditingIdx(null); }}>
        <SheetContent side="bottom" className="max-h-[82dvh] overflow-y-auto md:hidden">
          {editingIdx != null && rows?.[editingIdx] && <MobileRowEditor row={rows[editingIdx]!} warehouses={warehouses} onPatch={(partial) => patch(editingIdx, partial)} />}
        </SheetContent>
      </Sheet>

      {extractOrigin === "local_fallback" && (
        <section className="rounded-xl border border-amber-300/70 bg-amber-50 p-4 text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="text-sm font-medium">本地降级结果</p>
          <p className="mt-1 text-xs leading-5">
            这是降级信息，不是 Platform Intelligence。已使用本地数据。事实、写库和最终决定仍由工作台与人工负责。
          </p>
        </section>
      )}
    </div>
  );

  function patch(idx: number, partial: Partial<ImportRow>) {
    setRows((rs) => rs?.map((r, i) => (i === idx ? { ...r, ...partial } : r)) ?? null);
  }
}

function Mini({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
      />
    </label>
  );
}

function ReviewStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-mono text-sm tabular">{value}</div>
    </div>
  );
}

function MobileRowEditor({
  row,
  warehouses,
  onPatch,
}: {
  row: ImportRow;
  warehouses: { id: string; code: string }[];
  onPatch: (partial: Partial<ImportRow>) => void;
}) {
  return (
    <div className="space-y-3 pr-6">
      <div>
        <h2 className="text-base font-medium">编辑本行</h2>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{row.mpn}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {row.kind !== "potential" && <>
          <Mini label="数量" value={row.qtyRaw ?? (row.qty == null ? "" : String(row.qty))} onChange={(value) => onPatch({ qtyRaw: value, qty: parseQty(value), selected: false })} />
          <Mini label="DC" value={row.dateCode ?? ""} onChange={(value) => onPatch({ dateCode: value, selected: false })} />
          {row.kind === "stock" && <Mini label="标准装量" value={row.standardPack ?? ""} onChange={(value) => onPatch({ standardPack: value || null, selected: false })} />}
          <Mini label="供应商 / 渠道" value={row.channel ?? ""} onChange={(value) => onPatch({ channel: value, selected: false })} />
          {row.kind === "stock" && <label className="block"><span className="text-[10px] text-muted-foreground">仓库</span><NativeSelect className="mt-0.5 h-8 w-full text-xs" value={row.warehouse ?? ""} onChange={(event) => onPatch({ warehouse: event.target.value || null, selected: false })}><option value="">默认仓库</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.code}>{warehouse.code}</option>)}</NativeSelect></label>}
          {row.kind === "inquiry" && <Mini label="客户" value={row.customer ?? ""} onChange={(value) => onPatch({ customer: value, selected: false })} />}
        </>}
      </div>
      <p className="text-[11px] text-muted-foreground">{row.kind === "potential" ? "确认后只加入当前登录用户的潜力型号关注池。" : "修改后默认取消勾选，请重新核对并勾选；保存按钮只保存当前草稿，不会写入业务数据。"}</p>
    </div>
  );
}

function ChoiceButtons({
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 max-w-full rounded-md border border-input bg-background p-0.5", disabled && "opacity-50")}>
      {options.map((option) => (
        <button
          key={option.value || "empty"}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-8 min-w-0 flex-1 truncate rounded px-2 text-xs text-muted-foreground",
            compact && "min-w-0 px-0.5 text-[10px]",
            value === option.value && "bg-secondary font-medium text-foreground shadow-sm",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function labelKind(k: string) {
  return ({ offer: "推货", inquiry: "询价", stock: "入库", transit: "在途", potential: "潜力型号", mixed: "混合" } as Record<string, string>)[k] ?? k;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

type SpeechRec = {
  lang: string;
  start: () => void;
  onresult: ((ev: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
};
