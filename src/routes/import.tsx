import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  Camera,
  ClipboardPaste,
  FileSpreadsheet,
  Image,
  LoaderCircle,
  Mic,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
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

type ActivityState = "idle" | "received" | "reading" | "recognizing" | "preview" | "failed";
type ImportActivity = { state: ActivityState; label: string; detail?: string };
type ImportAttachment = {
  file: File;
  source: ImportSource;
  previewUrl: string | null;
  status: string;
};

function fileSource(file: File): ImportSource | null {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) return "image";
  if (name.endsWith(".csv") || file.type === "text/csv") return "csv";
  if (name.endsWith(".txt") || file.type.startsWith("text/plain")) return "text";
  if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (/\.docx?$/i.test(name) || file.type.includes("word")) return "word";
  if (/\.xlsx?$/i.test(name) || file.type.includes("sheet") || file.type.includes("excel"))
    return "excel";
  return null;
}

function fileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function compositeMpnReason(mpn: string): string | null {
  return /\s+(?:\/|\||或)\s+/.test(mpn.trim()) || /[／｜]/.test(mpn.trim())
    ? "型号包含多个候选，请拆分为一行一个型号"
    : null;
}

function shortStatus(
  row: ImportRow,
  blocking: string | null,
): { label: string; detail: string | null; tone: string } {
  if (row.brandConflict)
    return {
      label: "品牌冲突",
      detail: row.brandConflict,
      tone: "border-destructive/40 bg-destructive/10 text-destructive",
    };
  if (blocking)
    return { label: "需核对", detail: blocking, tone: "border-warn/40 bg-warn/10 text-warn" };
  if (row.duplicate)
    return {
      label: "疑似重复",
      detail: row.duplicateReason,
      tone: "border-warn/40 bg-warn/10 text-warn",
    };
  if (row.warning)
    return { label: "需核对", detail: row.warning, tone: "border-warn/40 bg-warn/10 text-warn" };
  return {
    label: "可写入",
    detail: null,
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  };
}

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
  const [importStatus, setImportStatus] = useState<
    "draft" | "preview" | "writing" | "success" | "failed"
  >("draft");
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
  const [activity, setActivity] = useState<ImportActivity>({ state: "idle", label: "等待输入" });
  const [attachment, setAttachment] = useState<ImportAttachment | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [voiceState, setVoiceState] = useState<
    "idle" | "recording" | "stopped" | "recognized" | "unsupported" | "permission-failed"
  >("idle");
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef<SpeechRec | null>(null);
  const lastPasteRef = useRef<{ fingerprint: string; at: number } | null>(null);

  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("kind");
    if (
      preset === "stock" ||
      preset === "transit" ||
      preset === "offer" ||
      preset === "inquiry" ||
      preset === "potential" ||
      preset === "mixed"
    ) {
      setKind(preset);
    }
    const draft = sessionStorage.getItem("import-draft");
    if (draft) {
      sessionStorage.removeItem("import-draft");
      setText(correctTradeText(draft));
    }
  }, []);

  useEffect(() => {
    if (
      !canMarketImport &&
      canStockImport &&
      (kind === "offer" || kind === "inquiry" || kind === "mixed")
    ) {
      setKind("stock");
    } else if (!canStockImport && (kind === "stock" || kind === "transit")) {
      setKind("offer");
    } else if (!canPotentialImport && kind === "potential") {
      setKind(canMarketImport ? "offer" : "stock");
    }
  }, [canMarketImport, canStockImport, canPotentialImport, kind]);

  const parseMut = useMutation({
    mutationFn: (input: ParseImportInput) => parseImport({ data: input }),
    onMutate: () =>
      setActivity((current) => ({ ...current, state: "recognizing", label: "正在识别…" })),
    onSuccess: (r) => {
      setSubmissionId(crypto.randomUUID());
      setImportStatus("preview");
      const fallbackWarehouseCode =
        r.warehouses.find((w) => w.id === (warehouseId || r.warehouses[0]?.id))?.code ?? null;
      setRows(
        r.rows.map((row) =>
          kind === "stock"
            ? {
                ...row,
                warehouse: row.warehouse ?? fallbackWarehouseCode,
                channel: (row.channel ?? supplier) || null,
                costCurrency:
                  row.costAmount == null ? row.costCurrency : (row.costCurrency ?? currency),
                costTax: row.costAmount == null ? row.costTax : (row.costTax ?? tax),
              }
            : row,
        ),
      );
      setUsedAi(r.usedAi);
      setExtractOrigin(r.extractOrigin ?? null);
      setExtractState(r.extractState ?? null);
      setExtractMessage(r.extractMessage ?? null);
      setAiAvailable(r.aiAvailable);
      setChannels(r.channels);
      setCustomers(r.customers);
      setWarehouses(r.warehouses);
      setAttachment((current) => (current ? { ...current, status: "预览完成" } : current));
      setActivity({
        state: "preview",
        label: r.rows.length ? "预览完成，可人工校对" : "识别完成，但没有识别到型号",
        detail: r.extractMessage ?? undefined,
      });
      if (!channel && r.channels[0]) setChannel(r.channels[0].name);
      if (!customer && r.customers[0]) setCustomer(r.customers[0].name);
      if (!warehouseId && r.warehouses[0]) setWarehouseId(r.warehouses[0].id);
      if (
        (r.extractState === "vision_unavailable" ||
          r.extractState === "provider_unavailable" ||
          r.extractState === "provider_error") &&
        r.rows.length === 0
      ) {
        toast.error(r.extractMessage || "当前无法识别图片");
      } else if (r.extractState === "needs_mapping" || r.extractState === "needs_review") {
        toast.error(r.extractMessage || "需要智能列映射");
      } else if (r.extractState === "platform_unavailable" && r.rows.length === 0) {
        toast.error(r.extractMessage || "Platform 暂不可用");
      } else if (
        (r.extractState === "invalid_input" || r.extractState === "unsupported") &&
        r.rows.length === 0
      ) {
        toast.error(r.extractMessage || "文件无法解析");
      } else if (r.rows.length === 0) {
        toast.error(r.extractMessage || "没有识别到型号");
      }
    },
    onError: (e: Error) => {
      setActivity({ state: "failed", label: "识别失败", detail: e.message });
      toast.error(e.message);
    },
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
      toast.success(
        kind === "potential"
          ? `已加入 ${r.summary.potential ?? r.summary.identified} 个潜力型号`
          : `识别 ${r.summary.identified}；命中 ${r.summary.hit}；库 ${r.summary.stock} · 客 ${r.summary.inquiry} · 双命中 ${r.summary.dual}`,
      );
    },
    onError: (e: Error) => {
      setImportStatus("failed");
      toast.error(e.message);
    },
  });

  async function onFile(file: File, src: ImportSource) {
    const detectedSource = src || fileSource(file);
    if (!detectedSource) {
      const message = "不支持的文件类型。请使用 Excel、CSV、TXT、PDF、DOC/DOCX 或图片";
      setActivity({ state: "failed", label: "无法接收文件", detail: message });
      toast.error(message);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setActivity({
        state: "failed",
        label: "文件过大",
        detail: `${file.name} 为 ${fileSize(file.size)}，上限 20 MB`,
      });
      toast.error("文件超过 20MB 限制");
      return;
    }
    setFilename(file.name);
    setSourceType(detectedSource);
    setRows(null);
    setImportStatus("draft");
    const previewUrl = detectedSource === "image" ? URL.createObjectURL(file) : null;
    setAttachment({ file, source: detectedSource, previewUrl, status: "已接收，等待识别" });
    setActivity({
      state: "received",
      label: "已接收，等待识别",
      detail: `${file.name} · ${detectedSource.toUpperCase()} · ${fileSize(file.size)}`,
    });
    try {
      setAttachment((current) => (current ? { ...current, status: "正在读取" } : current));
      setActivity({
        state: "reading",
        label: "正在读取…",
        detail: `${file.name} · ${fileSize(file.size)}`,
      });
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const b64 = toBase64(bytes);
      const fileText =
        detectedSource === "csv" || detectedSource === "text"
          ? new TextDecoder().decode(buf)
          : undefined;
      if (fileText != null) setText(fileText);
      else setText("");
      setAttachment((current) => (current ? { ...current, status: "正在识别" } : current));
      setActivity({
        state: "recognizing",
        label: "正在识别…",
        detail: `${file.name} · 识别完成前不会写入业务数据`,
      });
      parseMut.mutate({
        kind,
        sourceType: detectedSource,
        defaultWarehouseId: warehouseId || undefined,
        defaultSupplier: supplier || undefined,
        defaultCurrency: currency,
        defaultTax: tax,
        filename: file.name,
        fileBase64: b64,
        mime: file.type,
        text: fileText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "文件读取失败";
      setAttachment((current) => (current ? { ...current, status: "读取失败" } : current));
      setActivity({ state: "failed", label: "读取失败", detail: message });
      toast.error(message);
    }
  }

  function removeAttachment() {
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    setAttachment(null);
    setFilename(undefined);
    setActivity({ state: "idle", label: "等待输入" });
  }

  async function retryAttachment() {
    if (!attachment) return;
    await onFile(attachment.file, attachment.source);
  }

  function checkPastedImage(file: File): boolean {
    const fingerprint = `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
    const previous = lastPasteRef.current;
    const now = Date.now();
    if (previous && previous.fingerprint === fingerprint && now - previous.at < 3000) {
      const message = "检测到短时间内重复粘贴同一张图片，已跳过重复识别";
      setActivity({ state: "failed", label: "重复图片已跳过", detail: message });
      toast.message(message);
      return false;
    }
    lastPasteRef.current = { fingerprint, at: now };
    return true;
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      const message = files.length ? "一次只能处理一个文件，请重新拖入" : "没有收到文件，请重试";
      setActivity({ state: "failed", label: "拖放失败", detail: message });
      toast.error(message);
      return;
    }
    const source = fileSource(files[0]);
    if (!source) {
      const message = "不支持的文件类型。请使用 Excel、CSV、TXT、PDF、DOC/DOCX 或图片";
      setActivity({ state: "failed", label: "无法接收文件", detail: message });
      toast.error(message);
      return;
    }
    void onFile(files[0], source);
  }

  async function pasteClipboardImage() {
    if (!navigator.clipboard?.read) {
      toast.error("当前浏览器不支持直接读取剪贴板图片，请在下方输入框按 Ctrl+V 粘贴截图");
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const item = items.find((candidate) =>
        candidate.types.some((type) => type.startsWith("image/")),
      );
      if (!item) {
        toast.message("剪贴板里没有图片，请先在聊天或邮件界面截图并复制");
        return;
      }
      const mime = item.types.find((type) => type.startsWith("image/")) || "image/png";
      const blob = await item.getType(mime);
      const extension = mime.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const file = new File([blob], `clipboard-screenshot.${extension}`, { type: mime });
      if (!checkPastedImage(file)) return;
      await onFile(file, "image");
    } catch {
      toast.error("读取截图失败，请先复制截图，再回到输入框按 Ctrl+V");
    }
  }

  function stopListening() {
    voiceRef.current?.stop?.();
    setVoiceState("stopped");
    setActivity({
      state: "received",
      label: "录音已停止，请点击识别预览",
      detail: text.trim() ? "转写文字已保留在输入框" : "没有转写文字",
    });
  }

  function listen() {
    if (voiceState === "recording") return;
    const SR =
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec })
        .webkitSpeechRecognition ||
      (window as unknown as { SpeechRecognition?: new () => SpeechRec }).SpeechRecognition;
    if (!SR) {
      setVoiceState("unsupported");
      setActivity({
        state: "failed",
        label: "语音不可用",
        detail: "当前浏览器不支持语音，请粘贴转写文本",
      });
      toast.error("当前浏览器不支持语音，请粘贴转写文本");
      return;
    }
    const rec = new SR();
    voiceRef.current = rec;
    rec.lang = "zh-CN";
    rec.onresult = (ev: { results: { 0: { 0: { transcript: string } } } }) => {
      const t = correctTradeText(ev.results[0][0].transcript);
      setText((prev) => (prev ? prev + "\n" + t : t));
      setVoiceState("recognized");
      setActivity({
        state: "received",
        label: "语音识别完成，请点击识别预览",
        detail: "转写文字已进入输入框，尚未写入业务数据",
      });
    };
    rec.onerror = (event: { error?: string }) => {
      const permission = event.error === "not-allowed" || event.error === "service-not-allowed";
      setVoiceState(permission ? "permission-failed" : "stopped");
      setActivity({
        state: "failed",
        label: permission ? "麦克风权限失败" : "语音识别失败",
        detail: "可重试，或直接粘贴转写文本",
      });
    };
    rec.onend = () => {
      setVoiceState((current) => (current === "recording" ? "stopped" : current));
    };
    try {
      setVoiceState("recording");
      setActivity({
        state: "received",
        label: "正在录音…",
        detail: "说完后点击停止，转写文字仍需点击识别预览",
      });
      rec.start();
    } catch {
      setVoiceState("permission-failed");
      setActivity({ state: "failed", label: "无法开始录音", detail: "请检查麦克风权限后重试" });
    }
  }

  function stockRowError(row: ImportRow): string | null {
    if (kind !== "stock" && row.kind !== "stock") return null;
    if (!row.mpn.trim()) return "型号为空";
    if (row.qty == null || !Number.isInteger(row.qty) || row.qty <= 0) return "数量必须为正整数";
    if (!row.warehouse && !warehouseId) return "缺少仓库";
    if (row.dateCode && resolveDateCode(row.dateCode, row.qty, row.standardPack).warning)
      return "DC 无法确认，请补充标准装量或拆分包数";
    if (row.costAmount == null)
      return row.costCurrency || row.costTax ? "成本为空时不能保留币种或税别" : null;
    if (!Number.isFinite(row.costAmount) || row.costAmount < 0) return "成本无效";
    const rowCurrency = row.costCurrency ?? currency;
    const rowTax = row.costTax ?? tax;
    if (!rowCurrency) return "缺少币种";
    if (rowCurrency === "USD" && rowTax !== "none") return "美元税别必须为无";
    if (rowCurrency === "CNY" && rowTax !== "exclusive" && rowTax !== "inclusive")
      return "人民币请选择含或未";
    return null;
  }

  function rowBlockingReason(row: ImportRow): string | null {
    if (!row.mpn.trim()) return "型号为空";
    if (compositeMpnReason(row.mpn)) return compositeMpnReason(row.mpn);
    if (row.warning?.includes("多个型号候选")) return row.warning;
    if (row.brandConflict) return row.brandConflict;
    if (row.kind === "mixed") return "业务类型未确定";
    return stockRowError(row);
  }

  const selectedCount = rows?.filter((r) => r.selected).length ?? 0;
  const blockingCount = rows?.filter((r) => r.selected && rowBlockingReason(r)).length ?? 0;
  const visibleRows =
    rows
      ?.map((row, idx) => ({ row, idx }))
      .filter(({ row }) => {
        const matchesQuery =
          !rowQuery.trim() ||
          [row.mpn, row.brand, row.dateCode, row.warehouse, row.channel, row.customer]
            .filter(Boolean)
            .join(" ")
            .toUpperCase()
            .includes(rowQuery.trim().toUpperCase());
        const matchesFilter =
          rowFilter === "all" ||
          (rowFilter === "selected" && row.selected) ||
          (rowFilter === "review" && Boolean(row.warning || rowBlockingReason(row))) ||
          (rowFilter === "duplicate" && row.duplicate);
        return matchesQuery && matchesFilter;
      }) ?? [];
  const eligibleVisibleRows = visibleRows.filter(({ row }) => !rowBlockingReason(row));
  const selectedVisibleCount = eligibleVisibleRows.filter(({ row }) => row.selected).length;
  const allVisibleSelected =
    eligibleVisibleRows.length > 0 && selectedVisibleCount === eligibleVisibleRows.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  function toggleAllVisible(next: boolean) {
    const ids = new Set(eligibleVisibleRows.map(({ row }) => row.id));
    setRows(
      (current) =>
        current?.map((row) => (ids.has(row.id) ? { ...row, selected: next } : row)) ?? null,
    );
  }

  function clearSelection() {
    setRows((current) => current?.map((row) => ({ ...row, selected: false })) ?? null);
  }
  const inputBusy = parseMut.isPending || voiceState === "recording";

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4">
      <div>
        <h1 className="text-xl font-medium">智能导入</h1>
        <p className="text-sm text-muted-foreground">
          支持文本、Excel/CSV、图片、PDF 和
          DOCX。先预览再入库，模型不会擅自改写型号；人工修改后必须重新勾选。
        </p>
      </div>

      {summary && (
        <div className="rounded-xl bg-hit px-4 py-3 text-hit-foreground">
          {kind === "potential" ? (
            `已加入 ${summary.potential ?? summary.identified} 个潜力型号`
          ) : (
            <>
              识别 {summary.identified} 个型号；命中 {summary.hit}；库 {summary.stock} · 客{" "}
              {summary.inquiry} · 双命中 {summary.dual}
            </>
          )}
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
          <details>
            <summary className="cursor-pointer list-none text-sm font-medium">
              最近导入 {batches.data.length} 批 ·{" "}
              <span className="text-muted-foreground">查看记录</span>
            </summary>
            <ul className="mt-3 space-y-2 text-xs">
              {batches.data.map((batch) => (
                <li key={batch.id} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                        <span>{labelKind(batch.kind)}</span>
                        <span className="text-muted-foreground">
                          {batch.status === "writing"
                            ? "写入中"
                            : batch.status === "failed"
                              ? "失败"
                              : "成功"}
                        </span>
                        {batch.undoneAt && <span className="text-muted-foreground">已撤销</span>}
                      </div>
                      <p className="mt-1 truncate text-muted-foreground">
                        来源：{batch.sourceType}
                        {batch.filename ? ` · ${batch.filename}` : ""} ·{" "}
                        {formatWhen(batch.createdAt)}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        写入 {batch.writtenRows == null ? "—" : `${batch.writtenRows} 行`}
                        {batch.context ? ` · ${batch.context}` : ""}
                      </p>
                    </div>
                    {batch.canRevoke && !batch.undoneAt && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (
                            !window.confirm(
                              "确认撤销该导入批次？历史记录会保留，已发生后续库存动作的批次不可撤销。",
                            )
                          )
                            return;
                          void undoImportBatch({ data: { id: batch.id } })
                            .then(() => {
                              void qc.invalidateQueries({ queryKey: ["import-batches"] });
                              toast.success("批次已撤销");
                            })
                            .catch((err: Error) => toast.error(err.message));
                        }}
                      >
                        撤销批次
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label>导入为</Label>
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
              {canMarketImport && (
                <>
                  <option value="offer">渠道推货</option>
                  <option value="inquiry">客户询价</option>
                </>
              )}
              {canStockImport && (
                <>
                  <option value="stock">入库</option>
                  <option value="transit">在途</option>
                </>
              )}
              {canPotentialImport && <option value="potential">潜力型号</option>}
              {canMarketImport && canStockImport && <option value="mixed">自动判断</option>}
            </NativeSelect>
            {kind === "potential" && (
              <p className="mt-1 text-xs text-muted-foreground">
                只加入潜力型号关注池，不写入库存、渠道或客户数据。
              </p>
            )}
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
                <Input
                  list="imp-supplier"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                />
                <datalist id="imp-supplier">
                  {channels.map((c) => (
                    <option key={c.id} value={c.name} />
                  ))}
                </datalist>
              </div>
              <div>
                <Label>默认币种</Label>
                <ChoiceButtons
                  value={currency}
                  options={[
                    { value: "USD", label: "USD" },
                    { value: "CNY", label: "CNY" },
                  ]}
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
                  options={[
                    { value: "none", label: "无" },
                    { value: "exclusive", label: "未" },
                    { value: "inclusive", label: "含" },
                  ]}
                  disabled={currency === "USD"}
                  onChange={(v) => setTax(v as CostTax)}
                />
              </div>
            </div>
          )}
        </div>
        <div
          className={cn(
            "mt-3 rounded-lg border-2 border-dashed border-transparent p-1 transition-colors",
            isDragging && "border-primary bg-primary/5",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            if (!inputBusy) setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
              <UploadCloud className="size-4" />
              松开即可导入
            </div>
          )}
          <Textarea
            className="min-h-36 font-mono text-sm"
            placeholder={
              kind === "potential"
                ? "粘贴型号清单、聊天记录或截图文字…"
                : "粘贴聊天记录、货期、型号清单…"
            }
            value={text}
            disabled={inputBusy}
            onPaste={(event) => {
              const image = Array.from(event.clipboardData.files).find((file) =>
                file.type.startsWith("image/"),
              );
              if (!image) return;
              event.preventDefault();
              if (checkPastedImage(image)) void onFile(image, "image");
            }}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value.trim())
                setActivity({
                  state: "received",
                  label: "已收到文字，点击识别预览",
                  detail: `${e.target.value.trim().length} 个字符`,
                });
            }}
          />
        </div>
        {attachment && (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2">
            {attachment.previewUrl ? (
              <img
                src={attachment.previewUrl}
                alt="待识别图片缩略图"
                className="size-12 rounded-md object-cover"
              />
            ) : (
              <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{attachment.file.name}</p>
              <p className="text-xs text-muted-foreground">
                {attachment.source.toUpperCase()} · {fileSize(attachment.file.size)} ·{" "}
                {attachment.status}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={inputBusy}
              onClick={() => void retryAttachment()}
              title="重试识别"
              aria-label="重试识别"
            >
              <RefreshCw className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={inputBusy}
              onClick={removeAttachment}
              title="删除文件"
              aria-label="删除文件"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={inputBusy || !text.trim()}
            onClick={() => {
              setSourceType("text");
              setFilename(undefined);
              setAttachment(null);
              setRows(null);
              setImportStatus("draft");
              setActivity({
                state: "recognizing",
                label: "正在识别…",
                detail: "文本已收到，正在生成可编辑预览",
              });
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
            {parseMut.isPending ? "正在识别…" : "识别预览"}
          </Button>
          <Button
            variant="outline"
            disabled={inputBusy}
            onClick={() => {
              const sample = sampleImportText();
              setText(sample);
              setActivity({ state: "received", label: "示例文字已填入，点击识别预览" });
            }}
          >
            填入示例
          </Button>
          <Button
            variant="outline"
            disabled={inputBusy}
            onClick={() => {
              if (fileRef.current) fileRef.current.value = "";
              fileRef.current?.click();
            }}
          >
            <FileSpreadsheet className="size-4" />
            导入文件
          </Button>
          <Button
            variant="outline"
            disabled={inputBusy}
            onClick={() => {
              if (camRef.current) camRef.current.value = "";
              camRef.current?.click();
            }}
          >
            <Camera className="size-4" />
            拍照
          </Button>
          <Button
            variant="outline"
            disabled={inputBusy}
            onClick={() => {
              if (albumRef.current) albumRef.current.value = "";
              albumRef.current?.click();
            }}
          >
            <Image className="size-4" />
            相册
          </Button>
          <Button variant="outline" disabled={inputBusy} onClick={() => void pasteClipboardImage()}>
            <ClipboardPaste className="size-4" />
            粘贴截图
          </Button>
          <Button
            variant="outline"
            disabled={parseMut.isPending}
            onClick={voiceState === "recording" ? stopListening : listen}
          >
            <Mic className="size-4" />
            {voiceState === "recording" ? "停止录音" : "语音"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".xlsx,.xls,.csv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,.pdf,.doc,.docx,image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const src = fileSource(f);
              if (src) void onFile(f, src);
              e.currentTarget.value = "";
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
              e.currentTarget.value = "";
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
              e.currentTarget.value = "";
            }}
          />
        </div>
        {activity.state !== "idle" && (
          <div
            className={cn(
              "mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
              activity.state === "failed"
                ? "border-destructive/30 bg-destructive/5 text-destructive"
                : "border-border bg-secondary/30",
            )}
          >
            {activity.state === "reading" || activity.state === "recognizing" ? (
              <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" />
            ) : (
              <span className="mt-0.5 size-2 shrink-0 rounded-full bg-primary" />
            )}
            <div>
              <p className="font-medium">{activity.label}</p>
              {activity.detail && <p className="mt-0.5 text-muted-foreground">{activity.detail}</p>}
            </div>
          </div>
        )}
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
              <Button
                className="hidden md:inline-flex"
                disabled={
                  confirmMut.isPending ||
                  importStatus === "writing" ||
                  importStatus === "success" ||
                  selectedCount === 0 ||
                  blockingCount > 0
                }
                onClick={() => {
                  setImportStatus("writing");
                  confirmMut.mutate();
                }}
              >
                {importStatus === "success"
                  ? "✓ 已成功导入"
                  : importStatus === "writing" || confirmMut.isPending
                    ? `正在写入 ${selectedCount} 行…`
                    : `确认写入 ${selectedCount} 行`}
              </Button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ReviewStat label="总行数" value={rows.length} />
              <ReviewStat label="待写入" value={selectedCount} />
              <ReviewStat
                label="待检查"
                value={rows.filter((row) => Boolean(row.warning || stockRowError(row))).length}
              />
              <ReviewStat label="疑似重复" value={rows.filter((row) => row.duplicate).length} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Input
                className="h-8 min-w-48 flex-1 text-xs"
                value={rowQuery}
                onChange={(event) => setRowQuery(event.target.value)}
                placeholder="搜索型号、DC、仓库…"
              />
              <NativeSelect
                className="h-8 w-28 text-xs"
                value={rowFilter}
                onChange={(event) => setRowFilter(event.target.value as typeof rowFilter)}
              >
                <option value="all">全部行</option>
                <option value="selected">待写入</option>
                <option value="review">待检查</option>
                <option value="duplicate">疑似重复</option>
              </NativeSelect>
            </div>
            {importStatus === "writing" && (
              <p className="mt-2 text-xs text-muted-foreground">
                写入中…按钮已锁定，服务端会按幂等键处理重复请求。
              </p>
            )}
            {importStatus === "success" && (
              <p className="mt-2 rounded-md bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-700">
                写入成功。本次提交结果已保留，重复点击不会重复入库。
              </p>
            )}
            {importStatus === "failed" && (
              <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                写入失败。请检查错误并重新生成一份新预览。
              </p>
            )}
          </div>
          <details className="mb-3 rounded-lg border border-border px-3 py-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              查看原始证据（仅预览，不会自动写入）
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
              {text || filename || "当前来源没有可展示的文本摘要"}
            </pre>
          </details>
          <p className="mb-3 text-xs text-muted-foreground">
            型号请人工核对。疑似重复已勾掉，若确为新事件可重新勾选。
            {extractMessage ? ` ${extractMessage}` : ""}
            {blockingCount > 0 ? ` 有 ${blockingCount} 行存在阻断错误，修正后才能确认。` : ""}
          </p>
          <ImportReviewTable
            visibleRows={visibleRows}
            kind={kind}
            warehouses={warehouses}
            rowBlockingReason={rowBlockingReason}
            onPatch={patch}
            onToggle={(idx, selected) => patch(idx, { selected })}
            onEdit={setEditingIdx}
            allVisibleSelected={allVisibleSelected}
            someVisibleSelected={someVisibleSelected}
            onToggleAll={toggleAllVisible}
            onClearSelection={clearSelection}
            selectedCount={selectedCount}
            blockingCount={blockingCount}
            importStatus={importStatus}
            confirmPending={confirmMut.isPending}
            onConfirm={() => {
              setImportStatus("writing");
              confirmMut.mutate();
            }}
          />
        </section>
      )}

      <Sheet
        open={editingIdx != null}
        onOpenChange={(value) => {
          if (!value) setEditingIdx(null);
        }}
      >
        <SheetContent side="bottom" className="max-h-[82dvh] overflow-y-auto md:hidden">
          {editingIdx != null && rows?.[editingIdx] && (
            <MobileRowEditor
              row={rows[editingIdx]!}
              warehouses={warehouses}
              onPatch={(partial) => patch(editingIdx, partial)}
            />
          )}
        </SheetContent>
      </Sheet>

      {extractOrigin === "local_fallback" && (
        <section className="rounded-xl border border-amber-300/70 bg-amber-50 p-4 text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="text-sm font-medium">本地降级结果</p>
          <p className="mt-1 text-xs leading-5">
            这是降级信息，不是 Platform
            Intelligence。已使用本地数据。事实、写库和最终决定仍由工作台与人工负责。
          </p>
        </section>
      )}
    </div>
  );

  function patch(idx: number, partial: Partial<ImportRow>) {
    setRows((rs) => rs?.map((r, i) => (i === idx ? { ...r, ...partial } : r)) ?? null);
  }
}

function ImportReviewTable({
  visibleRows,
  kind,
  warehouses,
  rowBlockingReason,
  onPatch,
  onToggle,
  onEdit,
  allVisibleSelected,
  someVisibleSelected,
  onToggleAll,
  onClearSelection,
  selectedCount,
  blockingCount,
  importStatus,
  confirmPending,
  onConfirm,
}: {
  visibleRows: { row: ImportRow; idx: number }[];
  kind: ImportKind;
  warehouses: { id: string; code: string }[];
  rowBlockingReason: (row: ImportRow) => string | null;
  onPatch: (idx: number, partial: Partial<ImportRow>) => void;
  onToggle: (idx: number, selected: boolean) => void;
  onEdit: (idx: number) => void;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  onToggleAll: (next: boolean) => void;
  onClearSelection: () => void;
  selectedCount: number;
  blockingCount: number;
  importStatus: "draft" | "preview" | "writing" | "success" | "failed";
  confirmPending: boolean;
  onConfirm: () => void;
}) {
  const disabled = importStatus === "writing" || importStatus === "success" || confirmPending;
  const confirmDisabled = disabled || selectedCount === 0 || blockingCount > 0;

  function rowKind(row: ImportRow): ImportKind {
    return kind === "stock" ? "stock" : row.kind;
  }

  function patchText(idx: number, field: keyof ImportRow, value: string) {
    const partial: Partial<ImportRow> = {
      [field]: value || null,
      selected: false,
    } as Partial<ImportRow>;
    if (field === "mpn") partial.warning = "型号已人工修改，请再次核对";
    if (field === "brand") {
      partial.brandConflict = null;
      partial.warning = "品牌已人工修改，请再次核对";
    }
    onPatch(idx, partial);
  }

  function patchKind(idx: number, row: ImportRow, value: string) {
    const warning =
      row.warning
        ?.split("；")
        .filter((message) => !message.includes("业务类型无法确定"))
        .join("；") || null;
    onPatch(idx, {
      kind: value as ImportKind,
      selected: false,
      warning: [warning, "业务类型已人工修改，请复核写入"].filter(Boolean).join("；"),
    });
  }

  function quantityCell(row: ImportRow, idx: number) {
    if (rowKind(row) === "potential") return <span className="text-muted-foreground">—</span>;
    return (
      <Input
        className="h-8 min-w-20 text-xs"
        value={row.qtyRaw ?? (row.qty == null ? "" : String(row.qty))}
        onChange={(event) =>
          onPatch(idx, {
            qtyRaw: event.target.value,
            qty: parseQty(event.target.value),
            selected: false,
          })
        }
        aria-label={`${row.mpn} 数量`}
      />
    );
  }

  function businessKindCell(row: ImportRow, idx: number) {
    if (kind !== "mixed")
      return <span className="text-xs text-muted-foreground">{labelKind(rowKind(row))}</span>;
    return (
      <NativeSelect
        className="h-8 min-w-24 text-xs"
        value={row.kind}
        onChange={(event) => patchKind(idx, row, event.target.value)}
        aria-label={`${row.mpn} 业务类型`}
      >
        <option value="mixed">请选择类型</option>
        <option value="offer">推货</option>
        <option value="inquiry">询价</option>
        <option value="stock">入库</option>
        <option value="transit">在途</option>
      </NativeSelect>
    );
  }

  return (
    <>
      <div className="mb-2 hidden items-center justify-between gap-3 rounded-lg border border-border bg-secondary/20 px-3 py-2 text-xs md:flex">
        <label className="flex items-center gap-2 font-medium">
          <Checkbox
            checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
            onCheckedChange={(value) => onToggleAll(value === true)}
            aria-label="选择当前筛选结果"
          />
          选择当前筛选结果
        </label>
        <span className="text-muted-foreground">
          已选 {selectedCount} 行 · 阻断 {blockingCount} 行
        </span>
        <Button size="sm" variant="ghost" disabled={selectedCount === 0} onClick={onClearSelection}>
          清除全部选择
        </Button>
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="min-w-[1240px] w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-12" />
            <col className="w-[205px]" />
            <col className="w-[110px]" />
            <col className="w-[100px]" />
            <col className="w-[100px]" />
            <col className="w-[110px]" />
            <col className="w-[140px]" />
            <col className="w-[125px]" />
            <col className="w-[100px]" />
            <col className="w-[150px]" />
            <col className="w-[110px]" />
          </colgroup>
          <thead className="bg-secondary/40 text-left text-[11px] text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-[1] border-b border-border bg-secondary/70 px-2 py-2">
                <Checkbox
                  checked={
                    allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
                  }
                  onCheckedChange={(value) => onToggleAll(value === true)}
                  aria-label="全选当前可写入行"
                />
              </th>
              <th className="sticky left-12 z-[1] border-b border-border bg-secondary/70 px-2 py-2">
                型号
              </th>
              <th className="border-b border-border px-2 py-2">品牌</th>
              <th className="border-b border-border px-2 py-2">业务类型</th>
              <th className="border-b border-border px-2 py-2">数量</th>
              <th className="border-b border-border px-2 py-2">DC</th>
              <th className="border-b border-border px-2 py-2">渠道 / 供应商</th>
              <th className="border-b border-border px-2 py-2">客户</th>
              <th className="border-b border-border px-2 py-2">仓库</th>
              <th className="border-b border-border px-2 py-2">价格 / 成本</th>
              <th className="border-b border-border px-2 py-2">状态</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ row, idx }) => {
              const blocking = rowBlockingReason(row);
              const status = shortStatus(row, blocking);
              const isStock = rowKind(row) === "stock";
              return (
                <tr
                  key={row.id}
                  className={cn(
                    "border-b border-border last:border-b-0",
                    row.duplicate && "bg-warn/5",
                  )}
                >
                  <td className="sticky left-0 z-[1] bg-card px-2 py-2 align-top">
                    <Checkbox
                      checked={row.selected}
                      disabled={Boolean(blocking) || disabled}
                      onCheckedChange={(value) => onToggle(idx, value === true)}
                      aria-label={`选择 ${row.mpn}`}
                    />
                  </td>
                  <td className="sticky left-12 z-[1] bg-card px-2 py-2 align-top">
                    <Input
                      className="h-8 w-full min-w-0 px-2 font-mono text-xs"
                      value={row.mpn}
                      onChange={(event) => patchText(idx, "mpn", event.target.value)}
                      aria-label="型号（人工核对）"
                    />
                  </td>
                  <td className="px-2 py-2 align-top">
                    <Input
                      className="h-8 w-full min-w-0 px-2 text-xs"
                      value={row.brand ?? ""}
                      onChange={(event) => patchText(idx, "brand", event.target.value)}
                      aria-label={`${row.mpn} 品牌`}
                    />
                  </td>
                  <td className="px-2 py-2 align-top">{businessKindCell(row, idx)}</td>
                  <td className="px-2 py-2 align-top">{quantityCell(row, idx)}</td>
                  <td className="px-2 py-2 align-top">
                    <Input
                      className="h-8 w-full min-w-0 px-2 text-xs"
                      value={row.dateCode ?? ""}
                      onChange={(event) => patchText(idx, "dateCode", event.target.value)}
                      aria-label={`${row.mpn} DC`}
                    />
                  </td>
                  <td className="px-2 py-2 align-top">
                    <Input
                      className="h-8 w-full min-w-0 px-2 text-xs"
                      value={row.channel ?? ""}
                      onChange={(event) => patchText(idx, "channel", event.target.value)}
                      aria-label={`${row.mpn} 渠道或供应商`}
                    />
                  </td>
                  <td className="px-2 py-2 align-top">
                    <Input
                      className="h-8 w-full min-w-0 px-2 text-xs"
                      value={row.customer ?? ""}
                      onChange={(event) => patchText(idx, "customer", event.target.value)}
                      aria-label={`${row.mpn} 客户`}
                    />
                  </td>
                  <td className="px-2 py-2 align-top">
                    {isStock ? (
                      <NativeSelect
                        className="h-8 w-full min-w-0 px-1 text-xs"
                        value={row.warehouse ?? ""}
                        onChange={(event) =>
                          onPatch(idx, { warehouse: event.target.value || null, selected: false })
                        }
                        aria-label={`${row.mpn} 仓库`}
                      >
                        <option value="">默认仓库</option>
                        {warehouses.map((warehouse) => (
                          <option key={warehouse.id} value={warehouse.code}>
                            {warehouse.code}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 align-top">
                    <Input
                      className="h-8 w-full min-w-0 px-2 text-xs"
                      value={
                        isStock
                          ? row.costAmount == null
                            ? ""
                            : String(row.costAmount)
                          : row.priceAmount == null
                            ? ""
                            : String(row.priceAmount)
                      }
                      onChange={(event) =>
                        onPatch(
                          idx,
                          isStock
                            ? {
                                costAmount:
                                  event.target.value.trim() === ""
                                    ? null
                                    : Number(event.target.value),
                                selected: false,
                              }
                            : {
                                priceAmount:
                                  event.target.value.trim() === ""
                                    ? null
                                    : Number(event.target.value),
                                selected: false,
                              },
                        )
                      }
                      aria-label={`${row.mpn} 价格或成本`}
                      placeholder={isStock ? "成本" : "价格"}
                    />
                  </td>
                  <td className="px-2 py-2 align-top">
                    <details>
                      <summary
                        className={cn(
                          "inline-flex cursor-pointer list-none rounded-full border px-2 py-1 text-[11px]",
                          status.tone,
                        )}
                      >
                        {status.label}
                      </summary>
                      {status.detail && (
                        <p className="mt-2 min-w-40 max-w-56 whitespace-normal rounded-md bg-secondary/50 p-2 text-[11px] leading-5 text-foreground">
                          {status.detail}
                        </p>
                      )}
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 pb-20 md:hidden">
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-2 text-xs">
          <label className="flex items-center gap-2 font-medium">
            <Checkbox
              checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
              onCheckedChange={(value) => onToggleAll(value === true)}
              aria-label="选择当前筛选结果"
            />
            当前筛选可写入行
          </label>
          <button
            type="button"
            className="text-muted-foreground underline"
            disabled={selectedCount === 0}
            onClick={onClearSelection}
          >
            清除选择
          </button>
        </div>
        {visibleRows.map(({ row, idx }) => {
          const blocking = rowBlockingReason(row);
          const status = shortStatus(row, blocking);
          const isStock = rowKind(row) === "stock";
          return (
            <article
              key={row.id}
              className={cn(
                "rounded-lg border border-border bg-card p-3",
                row.duplicate && "border-warn/40 bg-warn/5",
              )}
            >
              <div className="flex items-start gap-2">
                <Checkbox
                  checked={row.selected}
                  disabled={Boolean(blocking) || disabled}
                  onCheckedChange={(value) => onToggle(idx, value === true)}
                  aria-label={`选择 ${row.mpn}`}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1">
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                    <Input
                      className="h-8 min-w-0 px-2 font-mono text-xs"
                      value={row.mpn}
                      onChange={(event) => patchText(idx, "mpn", event.target.value)}
                      aria-label="型号（人工核对）"
                    />
                    <span
                      className={cn(
                        "whitespace-nowrap rounded-full border px-2 py-1 text-[11px]",
                        status.tone,
                      )}
                    >
                      {status.label}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <label className="min-w-0">
                      <span className="text-[10px] text-muted-foreground">品牌</span>
                      <Input
                        className="mt-0.5 h-8 px-2 text-xs"
                        value={row.brand ?? ""}
                        onChange={(event) => patchText(idx, "brand", event.target.value)}
                      />
                    </label>
                    <label className="min-w-0">
                      <span className="text-[10px] text-muted-foreground">数量</span>
                      {quantityCell(row, idx)}
                    </label>
                    <label className="min-w-0">
                      <span className="text-[10px] text-muted-foreground">DC</span>
                      <Input
                        className="mt-0.5 h-8 px-2 text-xs"
                        value={row.dateCode ?? ""}
                        onChange={(event) => patchText(idx, "dateCode", event.target.value)}
                      />
                    </label>
                    <label className="min-w-0">
                      <span className="text-[10px] text-muted-foreground">
                        {isStock ? "供应商" : "渠道"}
                      </span>
                      <Input
                        className="mt-0.5 h-8 px-2 text-xs"
                        value={row.channel ?? ""}
                        onChange={(event) => patchText(idx, "channel", event.target.value)}
                      />
                    </label>
                    {isStock && (
                      <label className="min-w-0">
                        <span className="text-[10px] text-muted-foreground">仓库</span>
                        <NativeSelect
                          className="mt-0.5 h-8 w-full px-1 text-xs"
                          value={row.warehouse ?? ""}
                          onChange={(event) =>
                            onPatch(idx, { warehouse: event.target.value || null, selected: false })
                          }
                        >
                          <option value="">默认仓库</option>
                          {warehouses.map((warehouse) => (
                            <option key={warehouse.id} value={warehouse.code}>
                              {warehouse.code}
                            </option>
                          ))}
                        </NativeSelect>
                      </label>
                    )}
                    <label className="min-w-0">
                      <span className="text-[10px] text-muted-foreground">
                        {isStock ? "成本" : "价格"}
                      </span>
                      <Input
                        className="mt-0.5 h-8 px-2 text-xs"
                        value={
                          isStock
                            ? row.costAmount == null
                              ? ""
                              : String(row.costAmount)
                            : row.priceAmount == null
                              ? ""
                              : String(row.priceAmount)
                        }
                        onChange={(event) =>
                          onPatch(
                            idx,
                            isStock
                              ? {
                                  costAmount:
                                    event.target.value.trim() === ""
                                      ? null
                                      : Number(event.target.value),
                                  selected: false,
                                }
                              : {
                                  priceAmount:
                                    event.target.value.trim() === ""
                                      ? null
                                      : Number(event.target.value),
                                  selected: false,
                                },
                          )
                        }
                      />
                    </label>
                  </div>
                  {kind === "mixed" && <div className="mt-2">{businessKindCell(row, idx)}</div>}
                  {status.detail && (
                    <p className="mt-2 rounded-md bg-secondary/50 px-2 py-1.5 text-[11px] leading-5">
                      {status.detail}
                    </p>
                  )}
                  <Button className="mt-2" size="sm" variant="outline" onClick={() => onEdit(idx)}>
                    编辑更多字段
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {visibleRows.length === 0 && (
        <p className="py-8 text-center text-xs text-muted-foreground">没有符合当前筛选的行。</p>
      )}
      <div className="fixed inset-x-3 bottom-16 z-20 md:hidden">
        <Button className="w-full shadow-lg" disabled={confirmDisabled} onClick={onConfirm}>
          {importStatus === "success"
            ? "✓ 已成功导入"
            : importStatus === "writing" || confirmPending
              ? `正在写入 ${selectedCount} 行…`
              : `确认写入 ${selectedCount} 行`}
        </Button>
      </div>
    </>
  );
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
        <Mini
          label="型号"
          value={row.mpn}
          onChange={(value) =>
            onPatch({ mpn: value, selected: false, warning: "型号已人工修改，请再次核对" })
          }
        />
        <Mini
          label="品牌"
          value={row.brand ?? ""}
          onChange={(value) =>
            onPatch({
              brand: value || null,
              brandConflict: null,
              selected: false,
              warning: "品牌已人工修改，请再次核对",
            })
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {row.kind !== "potential" && (
          <>
            <Mini
              label="数量"
              value={row.qtyRaw ?? (row.qty == null ? "" : String(row.qty))}
              onChange={(value) =>
                onPatch({ qtyRaw: value, qty: parseQty(value), selected: false })
              }
            />
            <Mini
              label="DC"
              value={row.dateCode ?? ""}
              onChange={(value) => onPatch({ dateCode: value, selected: false })}
            />
            {row.kind === "stock" && (
              <Mini
                label="标准装量"
                value={row.standardPack ?? ""}
                onChange={(value) => onPatch({ standardPack: value || null, selected: false })}
              />
            )}
            <Mini
              label="供应商 / 渠道"
              value={row.channel ?? ""}
              onChange={(value) => onPatch({ channel: value, selected: false })}
            />
            {row.kind === "stock" && (
              <label className="block">
                <span className="text-[10px] text-muted-foreground">仓库</span>
                <NativeSelect
                  className="mt-0.5 h-8 w-full text-xs"
                  value={row.warehouse ?? ""}
                  onChange={(event) =>
                    onPatch({ warehouse: event.target.value || null, selected: false })
                  }
                >
                  <option value="">默认仓库</option>
                  {warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.code}>
                      {warehouse.code}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            {row.kind === "inquiry" && (
              <Mini
                label="客户"
                value={row.customer ?? ""}
                onChange={(value) => onPatch({ customer: value, selected: false })}
              />
            )}
          </>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {row.kind === "potential"
          ? "确认后只加入当前登录用户的潜力型号关注池。"
          : "修改后默认取消勾选，请重新核对并勾选；保存按钮只保存当前草稿，不会写入业务数据。"}
      </p>
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
    <div
      className={cn(
        "flex min-w-0 max-w-full rounded-md border border-input bg-background p-0.5",
        disabled && "opacity-50",
      )}
    >
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
  return (
    (
      {
        offer: "推货",
        inquiry: "询价",
        stock: "入库",
        transit: "在途",
        potential: "潜力型号",
        mixed: "混合",
      } as Record<string, string>
    )[k] ?? k
  );
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
  stop?: () => void;
  onresult: ((ev: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
  onerror?: ((event: { error?: string }) => void) | null;
  onend?: (() => void) | null;
};
