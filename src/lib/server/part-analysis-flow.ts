/**
 * Failure-tolerant orchestration for optional intelligence around Radar facts.
 * It deliberately owns neither database writes nor final business decisions.
 */
export type DegradedPartAnalysisEvent = "context_provider_unavailable" | "platform_unavailable";

export type PartAnalysisFlowDependencies<PlatformResult, FallbackResult, Context> = {
  getContext: (mpn: string) => Promise<Context | null>;
  researchPlatform: (mpn: string, context: Context | null) => Promise<{
    result: PlatformResult | null;
    failureReason?: string;
  }>;
  hasUsablePlatformResult: (result: PlatformResult) => boolean;
  lookupFallback: (mpn: string) => Promise<FallbackResult>;
  logDegraded: (event: DegradedPartAnalysisEvent, reason?: string) => void;
};

export type PartAnalysisFlowOutcome<PlatformResult, FallbackResult> =
  | { source: "platform"; mpn: string; platform: PlatformResult }
  | { source: "fallback"; mpn: string; fallback: FallbackResult };

export async function runPartAnalysisFlow<PlatformResult, FallbackResult, Context>(
  rawMpn: string,
  deps: PartAnalysisFlowDependencies<PlatformResult, FallbackResult, Context>,
): Promise<PartAnalysisFlowOutcome<PlatformResult, FallbackResult>> {
  const mpn = rawMpn.trim();
  let context: Context | null = null;
  try {
    context = await deps.getContext(mpn);
  } catch {
    deps.logDegraded("context_provider_unavailable");
  }

  try {
    const outcome = await deps.researchPlatform(mpn, context);
    if (outcome.failureReason) deps.logDegraded("platform_unavailable", outcome.failureReason);
    if (outcome.result && deps.hasUsablePlatformResult(outcome.result)) {
      return { source: "platform", mpn, platform: outcome.result };
    }
  } catch {
    deps.logDegraded("platform_unavailable", "network_error");
  }

  return { source: "fallback", mpn, fallback: await deps.lookupFallback(mpn) };
}
