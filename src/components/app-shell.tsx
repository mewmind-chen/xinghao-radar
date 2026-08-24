import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ClipboardList,
  LayoutDashboard,
  Radar,
  Search,
  Settings,
  Star,
  Truck,
  Upload,
  Warehouse,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

const NAV = [
  { to: "/", label: "工作台", icon: LayoutDashboard },
  { to: "/parts", label: "型号库", icon: Radar },
  { to: "/stock", label: "我的库存", icon: Warehouse },
  { to: "/channels", label: "渠道货源", icon: Truck },
  { to: "/inquiries", label: "客户询价", icon: ClipboardList },
  { to: "/watchlist", label: "潜力型号", icon: Star },
  { to: "/import", label: "智能导入", icon: Upload },
  { to: "/settings", label: "设置", icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) {
      navigate({ to: "/parts" });
      return;
    }
    navigate({ to: "/parts", search: { q: query } });
  }

  function active(to: string) {
    if (to === "/") return pathname === "/";
    return pathname === to || pathname.startsWith(to + "/");
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-52 flex-col border-r border-border bg-card md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Radar className="size-4" />
          </span>
          <div>
            <div className="text-sm font-medium">型号雷达</div>
            <div className="text-[11px] text-muted-foreground">供需匹配 · 库存雷达</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground",
                active(item.to) && "bg-secondary text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="px-4 py-3 text-[11px] text-muted-foreground">型号唯一 · 事件无限</div>
      </aside>

      <div className="md:pl-52">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background/90 px-3 py-2 backdrop-blur-sm md:px-5">
          <div className="flex items-center gap-2 md:hidden">
            <Radar className="size-5 text-primary" />
            <span className="text-sm font-medium">型号雷达</span>
          </div>
          <form onSubmit={onSearch} className="min-w-0 flex-1">
            <div className="relative w-full max-w-xl">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="global-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜型号 / 品牌  ↵"
                className="h-10 bg-card pl-8"
              />
            </div>
          </form>
        </header>
        <main className="px-3 py-4 pb-24 md:px-6 md:pb-8">{children}</main>
      </div>

      {/* 移动端底部导航：单行横向可滚动 Tab 栏(8 项全可见可达，不挤不高) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="flex overflow-x-auto px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex w-[68px] shrink-0 flex-col items-center justify-center gap-1 py-2 text-[11px] leading-none text-muted-foreground active:bg-secondary/60",
                active(item.to) && "bg-secondary/60 text-foreground",
              )}
            >
              <item.icon className="size-5" />
              <span className="max-w-full truncate">{item.label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
