/**
 * Read-only Radar business-context provider for a single exact MPN.
 *
 * The returned snapshot deliberately contains only aggregate operational
 * signals. It is request-scoped input for the Agent Platform, never evidence.
 */
import type { MatchFlags } from "@/lib/types";

export type RadarPartContext = {
  inventory: {
    source: "radar";
    onHand: number;
    inTransit: number;
    warehouse: string;
  };
  quotation: {
    source: "radar";
    openCount: number;
    recentCount: number;
  };
};

type ContextFlags = Pick<
  MatchFlags,
  "onHand" | "inTransit" | "byWarehouse" | "inquiryCount"
>;

/** Reduce existing match aggregates to the approved platform context shape. */
export function radarContextFromFlags(flags: ContextFlags): RadarPartContext {
  return {
    inventory: {
      source: "radar",
      onHand: flags.onHand,
      inTransit: flags.inTransit,
      warehouse: flags.byWarehouse.map((item) => `${item.code} ${item.qty}`).join("；"),
    },
    quotation: {
      source: "radar",
      openCount: flags.inquiryCount,
      // Radar currently exposes one windowed, validity-filtered inquiry count.
      // Reuse that count for both contract fields instead of mixing in channel
      // offerCount, which describes supply rather than customer demand.
      recentCount: flags.inquiryCount,
    },
  };
}

/**
 * Find a Radar part by its normalized key and return an aggregate-only
 * snapshot. No match means no internal context is sent to the platform.
 */
export async function getRadarPartContext(mpn: string): Promise<RadarPartContext | null> {
  const [{ normalizeMpn }, { getSettings, matchFlagsForParts, sqlClient }] = await Promise.all([
    import("@/lib/domain"),
    import("./helpers"),
  ]);
  const mpnKey = normalizeMpn(mpn);
  if (!mpnKey) return null;

  const sql = await sqlClient();
  const parts = await sql<{ id: string }>`select id from parts where mpn_key = ${mpnKey} limit 1`;
  const part = parts[0];
  if (!part) return null;

  const settings = await getSettings(sql);
  const flags = await matchFlagsForParts(sql, [part.id], settings);
  const aggregate = flags.get(part.id);
  return aggregate ? radarContextFromFlags(aggregate) : null;
}
