import { hitText } from "@/lib/domain";
import type { MatchFlags } from "@/lib/types";
import { cn } from "@/lib/utils";

export function HitBadges({
  flags,
  className,
}: {
  flags?: MatchFlags | null;
  className?: string;
}) {
  if (!flags) return null;
  const text = hitText(flags);
  if (!text) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px] font-medium text-primary",
        flags.isDual && "bg-hit text-hit-foreground",
        className,
      )}
    >
      {text}
    </span>
  );
}
