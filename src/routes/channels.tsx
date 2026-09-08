import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { Plus, Settings2 } from "lucide-react";
import {
  createOffer,
  listOffers,
  setChannelActive,
  setOfferValid,
  softDeleteOffers,
  upsertChannel,
} from "@/lib/server/market";
import { formatCost, formatOfferLine, formatQty, formatWhen, parseQty } from "@/lib/domain";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useAppAccess } from "@/lib/auth/use-app-access";
import { Sheet, SheetContent } from "@/components/ui/sheet";

export const Route = createFileRoute("/channels")({ component: ChannelsPage });

function ChannelsPage() {
  const qc = useQueryClient();
  const access = useAppAccess();
  const canWrite = access.can("market.write");
  const [scope, setScope] = useState<"valid" | "history" | "all">("valid");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["offers", scope, q],
    queryFn: () => listOffers({ data: { scope, q: q || undefined } }),
  });
  const items = list.data?.items ?? [];
  const channels = list.data?.channels ?? [];
  const activeChannels =
    list.data?.activeChannels ?? channels.filter((channel) => channel.isActive);
  const disabledChannels =
    list.data?.disabledChannels ?? channels.filter((channel) => !channel.isActive);

  function toggle(id: string) {
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  const selectedVisibleCount = items.filter((item) => sel.includes(item.id)).length;
  const allVisibleSelected = items.length > 0 && selectedVisibleCount === items.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  function toggleAllVisible(next: boolean) {
    const ids = items.map((item) => item.id);
    setSel((current) =>
      next ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id)),
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">渠道货源</h1>
          <p className="text-sm text-muted-foreground">只记货源事实。无效退出匹配，历史仍在。</p>
        </div>
        {canWrite && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            记一笔
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          className="w-32"
          value={scope}
          onChange={(e) => setScope(e.target.value as typeof scope)}
        >
          <option value="valid">当前有效</option>
          <option value="history">历史无效</option>
          <option value="all">全部</option>
        </NativeSelect>
        <Input
          className="max-w-xs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="型号 / 品牌 / 渠道"
        />
      </div>
      {canWrite && sel.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-lg bg-secondary px-3 py-2 text-sm">
          已选 {sel.length}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setOfferValid({ data: { ids: sel, isValid: false } }).then(() => {
                qc.invalidateQueries();
                setSel([]);
                toast.success("已批量无效");
              })
            }
          >
            设为无效
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setOfferValid({ data: { ids: sel, isValid: true } }).then(() => {
                qc.invalidateQueries();
                setSel([]);
              })
            }
          >
            恢复有效
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              softDeleteOffers({ data: { ids: sel } }).then(() => {
                qc.invalidateQueries();
                setSel([]);
                toast.success("已删除（录错才删）");
              })
            }
          >
            删除
          </Button>
        </div>
      )}
      <div className="overflow-hidden rounded-xl bg-card shadow-[var(--shadow-border)]">
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[1020px] w-full table-fixed border-collapse text-xs">
            <colgroup>
              <col className="w-12" />
              <col className="w-[220px]" />
              <col className="w-[150px]" />
              <col className="w-[95px]" />
              <col className="w-[110px]" />
              <col className="w-[140px]" />
              <col className="w-[150px]" />
              <col className="w-[150px]" />
              <col className="w-[90px]" />
            </colgroup>
            <thead className="bg-secondary/40 text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="border-b border-border px-3 py-2">
                  <Checkbox
                    checked={
                      allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
                    }
                    onCheckedChange={(value) => toggleAllVisible(value === true)}
                    aria-label="全选当前货源"
                  />
                </th>
                <th className="border-b border-border px-3 py-2">型号 / 品牌</th>
                <th className="border-b border-border px-3 py-2">渠道</th>
                <th className="border-b border-border px-3 py-2">数量</th>
                <th className="border-b border-border px-3 py-2">DC</th>
                <th className="border-b border-border px-3 py-2">价格</th>
                <th className="border-b border-border px-3 py-2">更新时间</th>
                <th className="border-b border-border px-3 py-2">库存状态</th>
                <th className="border-b border-border px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <Fragment key={it.id}>
                  <tr
                    key={it.id}
                    className="cursor-pointer border-b border-border last:border-b-0 hover:bg-secondary/30"
                    onClick={() => setExpandedId((current) => (current === it.id ? null : it.id))}
                  >
                    <td
                      className="px-3 py-2 align-top"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Checkbox
                        checked={sel.includes(it.id)}
                        onCheckedChange={() => toggle(it.id)}
                        aria-label={`选择 ${it.mpn}`}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Link
                        to="/parts/$partId"
                        params={{ partId: it.partId }}
                        search={{ from: "parts" }}
                        className="block min-w-0"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Mpn value={it.mpn} />
                          <span className="truncate text-muted-foreground">
                            {it.brandCode || "—"}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <HitBadges flags={it.flags} />
                          {!it.isValid && (
                            <span className="text-[11px] text-muted-foreground">无效</span>
                          )}
                        </div>
                      </Link>
                    </td>
                    <td className="truncate px-3 py-2 align-top">{it.channelName}</td>
                    <td className="px-3 py-2 align-top">
                      {it.qty == null ? "TP" : formatQty(it.qty)}
                    </td>
                    <td className="px-3 py-2 align-top">{it.dateCode || "—"}</td>
                    <td className="px-3 py-2 align-top">
                      {it.isTp
                        ? "TP"
                        : formatCost(it.priceAmount, it.priceCurrency, it.priceTax) || "—"}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {formatWhen(it.offeredAt)}
                    </td>
                    <td className="truncate px-3 py-2 align-top text-muted-foreground">
                      {it.stockLine || "—"}
                    </td>
                    <td className="px-3 py-2 align-top text-primary">
                      {expandedId === it.id ? "收起" : "详情"}
                    </td>
                  </tr>
                  {expandedId === it.id && (
                    <tr key={`${it.id}-detail`} className="border-b border-border bg-secondary/20">
                      <td colSpan={9} className="px-3 py-3">
                        <div className="grid gap-2 text-xs sm:grid-cols-4">
                          <span>渠道：{it.channelName}</span>
                          <span>货源事实：{formatOfferLine(it) || "—"}</span>
                          <span>更新时间：{formatWhen(it.offeredAt)}</span>
                          <span>库存：{it.stockLine || "暂无"}</span>
                        </div>
                        <Link
                          to="/parts/$partId"
                          params={{ partId: it.partId }}
                          search={{ from: "parts" }}
                          className="mt-2 inline-block text-primary underline"
                        >
                          打开型号详情
                        </Link>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-border md:hidden">
          <div className="flex items-center justify-between gap-2 bg-secondary/30 px-3 py-2 text-xs">
            <label className="flex items-center gap-2 font-medium">
              <Checkbox
                checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                onCheckedChange={(value) => toggleAllVisible(value === true)}
                aria-label="全选当前货源"
              />
              全选当前结果
            </label>
            <span className="text-muted-foreground">已选 {sel.length}</span>
          </div>
          {items.map((it) => (
            <article key={it.id} className="px-3 py-3">
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <Checkbox
                  checked={sel.includes(it.id)}
                  onCheckedChange={() => toggle(it.id)}
                  aria-label={`选择 ${it.mpn}`}
                  className="mt-1"
                />
                <Link
                  to="/parts/$partId"
                  params={{ partId: it.partId }}
                  search={{ from: "parts" }}
                  className="min-w-0"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Mpn value={it.mpn} />
                    <span className="truncate text-xs text-muted-foreground">
                      {it.brandCode || "—"}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {it.channelName} · {it.qty == null ? "TP" : formatQty(it.qty)} ·{" "}
                    {it.dateCode || "无 DC"}
                  </p>
                </Link>
                <span className="whitespace-nowrap text-sm font-medium">
                  {it.isTp
                    ? "TP"
                    : formatCost(it.priceAmount, it.priceCurrency, it.priceTax) || "—"}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 pl-6 text-[11px] text-muted-foreground">
                <span className="truncate">
                  {it.stockLine || "暂无库存状态"} · {formatWhen(it.offeredAt)}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-primary underline"
                  onClick={() => setExpandedId((current) => (current === it.id ? null : it.id))}
                >
                  {expandedId === it.id ? "收起" : "详情"}
                </button>
              </div>
              {expandedId === it.id && (
                <div className="mt-2 ml-6 rounded-md bg-secondary/40 px-2 py-2 text-xs">
                  货源事实：{formatOfferLine(it) || "—"}
                  <br />
                  <Link
                    to="/parts/$partId"
                    params={{ partId: it.partId }}
                    search={{ from: "parts" }}
                    className="mt-1 inline-block text-primary underline"
                  >
                    打开型号详情
                  </Link>
                </div>
              )}
            </article>
          ))}
          {!items.length && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              暂无符合条件的货源。
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        <span>
          {activeChannels.length ? `当前启用 ${activeChannels.length} 个渠道` : "暂无启用渠道"} ·
          停用渠道不参与匹配和新增
        </span>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setManageOpen(true)}>
            <Settings2 className="size-4" />
            管理渠道
          </Button>
        )}
      </div>
      {canWrite && (
        <OfferDialog
          open={open}
          onOpenChange={setOpen}
          channels={activeChannels.map((c) => c.name)}
        />
      )}
      {canWrite && (
        <ChannelManager
          open={manageOpen}
          onOpenChange={setManageOpen}
          activeChannels={activeChannels}
          disabledChannels={disabledChannels}
        />
      )}
    </div>
  );
}

function ChannelManager({
  open,
  onOpenChange,
  activeChannels,
  disabledChannels,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  activeChannels: { id: string; name: string; isActive: boolean }[];
  disabledChannels: { id: string; name: string; isActive: boolean }[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const add = useMutation({
    mutationFn: () => upsertChannel({ data: { name } }),
    onSuccess: (channel) => {
      void qc.invalidateQueries({ queryKey: ["offers"] });
      setName("");
      if (channel.isActive) toast.success("渠道已加入启用列表");
      else toast.message("同名渠道已停用，请在下方恢复后再使用");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) => setChannelActive({ data: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["offers"] }),
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-sm overflow-y-auto max-md:inset-y-auto max-md:bottom-0 max-md:h-auto max-md:max-h-[85dvh] max-md:w-full max-md:max-w-none max-md:rounded-t-xl sm:w-96"
      >
        <div className="pr-6">
          <h2 className="text-base font-medium">管理渠道</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            启用渠道会参与匹配，也会出现在新增/导入候选中。停用只退出当前匹配，历史货源保留。
          </p>
        </div>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="新增渠道名称"
          />
          <Button size="sm" disabled={!name.trim() || add.isPending}>
            添加
          </Button>
        </form>
        <div className="mt-5 space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            启用中 · {activeChannels.length}
          </div>
          {activeChannels.map((channel) => (
            <div
              key={channel.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <span className="min-w-0 truncate text-sm">{channel.name}</span>
              <Switch
                checked={channel.isActive}
                onCheckedChange={(isActive) => toggle.mutate({ id: channel.id, isActive })}
              />
            </div>
          ))}
          {!activeChannels.length && (
            <p className="text-xs text-muted-foreground">暂无启用渠道。</p>
          )}
        </div>
        <div className="mt-6 border-t border-border pt-4">
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setShowDisabled((value) => !value)}
          >
            {showDisabled ? "收起停用渠道" : `显示停用渠道 · ${disabledChannels.length}`}
          </button>
          {showDisabled && (
            <div className="mt-2 space-y-2">
              {disabledChannels.map((channel) => (
                <div
                  key={channel.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-secondary/50 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm text-muted-foreground">
                    {channel.name}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toggle.mutate({ id: channel.id, isActive: true })}
                  >
                    恢复
                  </Button>
                </div>
              ))}
              {!disabledChannels.length && (
                <p className="text-xs text-muted-foreground">暂无停用渠道。</p>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function OfferDialog({
  open,
  onOpenChange,
  channels,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  channels: string[];
}) {
  const qc = useQueryClient();
  const [channel, setChannel] = useState(channels[0] ?? "");
  const [mpn, setMpn] = useState("");
  const [qty, setQty] = useState("");
  const [dc, setDc] = useState("");
  const [tp, setTp] = useState(true);
  const [lt, setLt] = useState("");
  const uniq = useMemo(() => [...new Set(channels)], [channels]);
  const mut = useMutation({
    mutationFn: async () => {
      const n = qty ? parseQty(qty) : null;
      const r = await createOffer({
        data: {
          channel,
          mpn,
          qty: n,
          dateCode: dc || undefined,
          isTp: tp,
          leadTimeText: lt || undefined,
        },
      });
      return r;
    },
    onSuccess: (r) => {
      toast.success(
        r.flags.isHit
          ? `已记 · 命中 ${r.flags.inquiryCount ? "客" + r.flags.inquiryCount : ""}`
          : "已记",
      );
      qc.invalidateQueries();
      onOpenChange(false);
      setMpn("");
      setQty("");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>记一笔推货</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>渠道</Label>
            <Input list="ch-list" value={channel} onChange={(e) => setChannel(e.target.value)} />
            <datalist id="ch-list">
              {uniq.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <Label>型号</Label>
            <Input className="font-mono" value={mpn} onChange={(e) => setMpn(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>数量</Label>
              <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="20K" />
            </div>
            <div>
              <Label>DC</Label>
              <Input value={dc} onChange={(e) => setDc(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>货期 LT</Label>
            <Input value={lt} onChange={(e) => setLt(e.target.value)} placeholder="LT 4周" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={tp} onCheckedChange={(v) => setTp(Boolean(v))} />
            无报价，记为 TP
          </label>
          <Button disabled={mut.isPending || !mpn || !channel} onClick={() => mut.mutate()}>
            确认
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
