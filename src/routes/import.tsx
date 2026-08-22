import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Camera, ClipboardPaste, FileSpreadsheet, Image, Mic } from "lucide-react";
import { confirmImport, parseImport } from "@/lib/server/import";
import { sampleImportText, parseQty, correctTradeText } from "@/lib/domain";
import type { ImportKind, ImportRow, ImportSource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Mpn } from "@/components/mpn";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/import")({ component: ImportPage });

function ImportPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<ImportKind>("offer");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [usedAi, setUsedAi] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [channel, setChannel] = useState("");
  const [customer, setCustomer] = useState("");
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
    const draft = sessionStorage.getItem("import-draft");
    if (draft) {
      sessionStorage.removeItem("import-draft");
      setText(correctTradeText(draft));
    }
  }, []);

  const parseMut = useMutation({
    mutationFn: (input: Parameters<typeof parseImport>[0]["data"]) => parseImport({ data: input }),
    onSuccess: (r) => {
      setRows(r.rows);
      setUsedAi(r.usedAi);
      setAiAvailable(r.aiAvailable);
      setChannels(r.channels);
      setCustomers(r.customers);
      setWarehouses(r.warehouses);
      if (!channel && r.channels[0]) setChannel(r.channels[0].name);
      if (!customer && r.customers[0]) setCustomer(r.customers[0].name);
      if (!warehouseId && r.warehouses[0]) setWarehouseId(r.warehouses[0].id);
      if (r.rows.length === 0) toast.error("没有识别到型号");
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

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label>导入为</Label>
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
              <option value="offer">渠道推货</option>
              <option value="inquiry">客户询价</option>
              <option value="stock">入库</option>
              <option value="transit">在途</option>
              <option value="mixed">自动判断</option>
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
            <div>
              <Label>默认仓库</Label>
              <NativeSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                  </option>
                ))}
              </NativeSelect>
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
              parseMut.mutate({ kind, sourceType: "text", text });
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
          <p className="mt-2 text-xs text-muted-foreground">当前环境无 AI，将用规则解析 Excel / 文本。</p>
        )}
      </section>

      {rows && (
        <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">
              预览 {rows.length} 行{usedAi ? " · AI" : " · 规则"}
            </h2>
            <Button disabled={confirmMut.isPending} onClick={() => confirmMut.mutate()}>
              确认写入
            </Button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            型号请人工核对。疑似重复已勾掉，若确为新事件可重新勾选。
          </p>
          <ul className="space-y-2">
            {rows.map((row, idx) => (
              <li
                key={row.id}
                className={cn(
                  "rounded-lg border border-border px-3 py-2",
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
                      <span className="text-[11px] text-muted-foreground">{labelKind(row.kind)}</span>
                      {row.duplicate && (
                        <span className="text-[11px] text-warn">{row.duplicateReason}</span>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                      <Mini label="数量" value={row.qtyRaw ?? (row.qty != null ? String(row.qty) : "")} onChange={(v) => patch(idx, { qtyRaw: v, qty: parseQty(v) })} />
                      <Mini label="DC" value={row.dateCode ?? ""} onChange={(v) => patch(idx, { dateCode: v })} />
                      <Mini label="渠道" value={row.channel ?? ""} onChange={(v) => patch(idx, { channel: v })} />
                      <Mini label="客户" value={row.customer ?? ""} onChange={(v) => patch(idx, { customer: v })} />
                    </div>
                    {row.note && <p className="mt-1 truncate text-[11px] text-muted-foreground">{row.note}</p>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
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

function labelKind(k: ImportKind) {
  return { offer: "推货", inquiry: "询价", stock: "入库", transit: "在途", mixed: "混合" }[k];
}

type SpeechRec = {
  lang: string;
  start: () => void;
  onresult: ((ev: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
};
