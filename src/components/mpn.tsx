import { cn } from "@/lib/utils";

export function Mpn({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <span className={cn("font-mono text-[13px] font-medium tracking-tight", className)}>
      {value}
    </span>
  );
}
