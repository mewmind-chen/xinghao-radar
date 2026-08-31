import { ScanSearch } from "lucide-react";

type IdentityCheckPillProps = {
  displayName: string;
  exiting: boolean;
  onExit: () => void;
};

export function IdentityCheckPill({ displayName, exiting, onExit }: IdentityCheckPillProps) {
  return (
    <div
      data-testid="identity-check-pill"
      className="hidden h-8 min-w-0 max-w-[min(42vw,320px)] shrink-0 items-center gap-1.5 rounded-full border border-amber-200/80 bg-amber-50/70 px-2.5 text-xs text-slate-800 md:flex"
      title={`检查中 · ${displayName}`}
    >
      <ScanSearch className="size-3.5 shrink-0 text-amber-700" aria-hidden="true" />
      <span className="shrink-0">检查中 ·</span>
      <span className="min-w-0 truncate" title={displayName}>{displayName}</span>
      <button
        type="button"
        className="shrink-0 rounded-full px-1.5 py-0.5 font-medium text-slate-700 hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60"
        onClick={onExit}
        disabled={exiting}
      >
        {exiting ? "退出中" : "退出"}
      </button>
    </div>
  );
}
