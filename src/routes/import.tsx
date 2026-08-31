import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Camera, ClipboardPaste, FileSpreadsheet, Image, Mic } from "lucide-react";
import { confirmImport, parseImport } from "@/lib/server/import";
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
import { Mpn } from "@/components/mpn";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAppAccess } from "@/lib/auth/use-app-access";

export const Route = createFileRoute("/import")({ component: ImportPage });

function ImportPage() {
  const qc = useQueryClient();
  const access = useAppAccess();
  const canMarketImport = access.can("market.write");
  const canStockImport = access.can("inventory.import");
  const batches = useQuery({ queryKey: ["import-batches"], queryFn: () => listImportBatches() });
  const [kind, setKind] = useState<ImportKind>("offer");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
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
    batchId: string;
  }>(null);
  const [filename, setFilename] = useState<string | undefined>();
  const [sourceType, setSourceType] = useState<ImportSource>("text");
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("kind");
    if (preset === "stock" || preset === "transit" || preset === "offer" || preset === "inquiry" || preset === "mixed") {
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
    }
  }, [canMarketImport, canStockImport, kind]);

  const parseMut = useMutation({
    mutationFn: (input: Parameters<typeof parseImport>[0]["data"]) => parseImport({ data: input }),
    onSuccess: (r) => {
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
      if (r.extractState === "vision_unavailable" && r.rows.length === 0) {
        toast.error(r.extractMessage || "当前无法识别图片");
      } else if (r.extractState === "needs_mapping") {
        toast.error(r.extractMessage || "需要智能列映射");
      } else if (r.extractState === "platform_unavailable" && r.rows.length === 0) {
        toast.error(r.extractMessage || "Platform 暂不可用");
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
          rows,
        },
      });
    },
    onSuccess: (r) => {
      qc.invalidateQueries();
      setSummary({ ...r.summary, batchId: r.batchId });
      toast.success(
        `识别 ${r.summary.identified}；命中 ${r.summary.hit}；库 ${r.summary.stock} · 客 ${r.summary.inquiry} · 双命中 ${r.summary.dual}`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function onFile(file: File, src: ImportSource) {
    setFilename(file.name);
    setSourceType(src);
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    if (src === "csv") {
      const t = new TextDecoder().decode(buf);
      setText(t);
    }
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

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-medium">智能导入</h1>
        <p className="text-sm text-muted-foreground">
          先预览再入库。型号字符不会被擅自改写。
        </p>
      </div>

      {summary && (
        <div className="rounded-xl bg-hit px-4 py-3 text-hit-foreground">
          识别 {summary.identified} 个型号；命中 {summary.hit}；库 {summary.stock} · 客{" "}
          {summary.inquiry} · 双命中 {summary.dual}
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
                  {batch.kind} · {batch.sourceType} {batch.filename ?? ""} · {formatWhen(batch.createdAt)}
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
              {canMarketImport && canStockImport && <option value="mixed">自动判断</option>}
            </NativeSelect>
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
          placeholder="粘贴聊天记录、货期、型号清单…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={parseMut.isPending || !text.trim()}
            onClick={() => {
              setSourceType("text");
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
            Excel / CSV
          </Button>
          <Button variant="outline" onClick={() => camRef.current?.click()}>
            <Camera className="size-4" />
            拍照
          </Button>
          <Button variant="outline" onClick={() => albumRef.current?.click()}>
            <Image className="size-4" />
            相册/截图
          </Button>
          <Button variant="outline" onClick={listen}>
            <Mic className="size-4" />
            语音
          </Button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".xlsx,.xls,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,.pdf,.doc,.docx,image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const name = f.name.toLowerCase();
              if (name.endsWith(".pdf") || name.endsWith(".doc") || name.endsWith(".docx")) {
                toast.error("PDF / Word 请截图或复制文本后导入，型号才不会被猜错。");
                e.target.value = "";
                return;
              }
              if (f.type.startsWith("image/")) {
                void onFile(f, "image");
                return;
              }
              const src: ImportSource = name.endsWith(".csv") ? "csv" : "excel";
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
        <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">
              预览 {rows.length} 行
              {extractOrigin === "trusted_template"
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
            <Button disabled={confirmMut.isPending || selectedCount === 0 || blockingCount > 0} onClick={() => confirmMut.mutate()}>
              确认写入 {selectedCount} 行
            </Button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            型号请人工核对。疑似重复已勾掉，若确为新事件可重新勾选。
            {extractMessage ? ` ${extractMessage}` : ""}
            {blockingCount > 0 ? ` 有 ${blockingCount} 行存在阻断错误，修正后才能确认。` : ""}
          </p>
          <ul className="min-w-0 space-y-2">
            {rows.map((row, idx) => (
              <li
                key={row.id}
                className={cn(
                  "min-w-0 overflow-hidden rounded-lg border border-border px-3 py-2",
                  row.duplicate && "border-warn/40 bg-warn/5",
                )}
              >
                <div className="flex items-start gap-2">
                  <Checkbox
                    checked={row.selected}
                    onCheckedChange={(v) =>
                      setRows((rs) =>
                        rs?.map((r, i) => (i === idx ? { ...r, selected: Boolean(v) } : r)) ?? null,
                      )
                    }
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Mpn value={row.mpn} />
                      <span className="text-[11px] text-muted-foreground">{labelKind(kind === "stock" ? "stock" : row.kind)}</span>
                      {row.duplicate && (
                        <span className="text-[11px] text-warn">{row.duplicateReason}</span>
                      )}
                    </div>
                    {(kind === "stock" || row.kind === "stock") ? (
                      <div className="mt-2 grid min-w-0 grid-cols-2 gap-2 md:grid-cols-6">
                        <Mini label="数量" value={row.qtyRaw ?? (row.qty != null ? String(row.qty) : "")} onChange={(v) => patch(idx, { qtyRaw: v, qty: parseQty(v) })} />
                        <Mini label="DC" value={row.dateCode ?? ""} onChange={(v) => patch(idx, { dateCode: v })} />
                        <Mini label="供应商" value={row.channel ?? ""} onChange={(v) => patch(idx, { channel: v })} />
                        <label className="block"><span className="text-[10px] text-muted-foreground">仓库</span><NativeSelect className="mt-0.5 h-8 w-full text-xs" value={row.warehouse ?? ""} onChange={(e) => patch(idx, { warehouse: e.target.value || null })}><option value="">默认仓库</option>{warehouses.map((w) => <option key={w.id} value={w.code}>{w.code}</option>)}</NativeSelect></label>
                        <Mini label="成本金额" value={row.costAmount == null ? "" : String(row.costAmount)} onChange={(v) => patch(idx, { costAmount: v.trim() === "" ? null : Number(v) })} />
                        <label className="block min-w-0"><span className="text-[10px] text-muted-foreground">币种 / 税</span><div className="mt-0.5 grid min-w-0 grid-cols-2 gap-1"><NativeSelect className="h-8 min-w-0 px-1 text-xs" value={row.costCurrency ?? ""} onChange={(e) => patch(idx, { costCurrency: (e.target.value || null) as Currency | null, costTax: e.target.value === "USD" ? "none" : row.costTax })}><option value="">—</option><option value="USD">USD</option><option value="CNY">CNY</option></NativeSelect><NativeSelect className="h-8 min-w-0 px-1 text-xs" value={row.costCurrency === "USD" ? "none" : row.costTax ?? ""} disabled={row.costCurrency === "USD"} onChange={(e) => patch(idx, { costTax: (e.target.value || null) as CostTax | null })}><option value="">—</option><option value="none">无</option><option value="exclusive">未</option><option value="inclusive">含</option></NativeSelect></div></label>
                      </div>
                    ) : (
                      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                        <Mini label="数量" value={row.qtyRaw ?? (row.qty != null ? String(row.qty) : "")} onChange={(v) => patch(idx, { qtyRaw: v, qty: parseQty(v) })} />
                        <Mini label="DC" value={row.dateCode ?? ""} onChange={(v) => patch(idx, { dateCode: v })} />
                        <Mini label="渠道" value={row.channel ?? ""} onChange={(v) => patch(idx, { channel: v })} />
                        <Mini label="客户" value={row.customer ?? ""} onChange={(v) => patch(idx, { customer: v })} />
                      </div>
                    )}
                    {row.note && <p className="mt-1 truncate text-[11px] text-muted-foreground">{row.note}</p>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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

function labelKind(k: ImportKind) {
  return { offer: "推货", inquiry: "询价", stock: "入库", transit: "在途", mixed: "混合" }[k];
}

type SpeechRec = {
  lang: string;
  start: () => void;
  onresult: ((ev: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
};
