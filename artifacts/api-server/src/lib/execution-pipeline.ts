import { logger } from "./logger";
import {
  executeMetaApiTrade,
  getLiveAccountSnapshot,
  getMetaApiSymbolPrice,
  getMetaApiSymbolSpecification,
  modifyMetaApiPosition,
  type MetaApiPosition,
} from "./metaapi";
import { supabaseRequest } from "./supabase";

export type ExecutionPipelineInput = {
  accountId: string;
  symbol: string;
  realSymbol?: string;
  direction: "BUY" | "SELL";
  lot: number;
  sl: number;
  tp: number;
  poiType?: string;
  bosMssTag?: string;
  leverage: number;
  marginUsed: number;
};

export type ExecutionPipelineResult = {
  success: boolean;
  orderId: string | null;
  positionId: string | null;
  verifiedPosition: MetaApiPosition | null;
  slVerified: boolean;
  tpVerified: boolean;
  error?: string;
  logs: string[];
};

function getPriceTolerance(symbol: string) {
  const activeSymbol = symbol.toUpperCase();
  return activeSymbol.includes("XAU") || activeSymbol.includes("GOLD")
    ? 0.5
    : activeSymbol.includes("US30") || activeSymbol.includes("NAS") || activeSymbol.includes("US100") || activeSymbol.includes("DJ30")
      ? 5.0
      : 0.0005;
}

export async function runPostExecutionPipeline(
  input: ExecutionPipelineInput,
): Promise<ExecutionPipelineResult> {
  const logs: string[] = [];
  logs.push(`Initiating order request for ${input.symbol} (${input.direction} ${input.lot} lots)`);

  // Step 1: Execute Order via MetaApi
  let orderResult: Awaited<ReturnType<typeof executeMetaApiTrade>>;
  try {
    orderResult = await executeMetaApiTrade({
      accountId: input.accountId,
      actionType: input.direction === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      symbol: input.realSymbol ?? input.symbol,
      volume: input.lot,
      stopLoss: input.sl,
      takeProfit: input.tp,
    });
    logs.push(`Broker accepted order request (orderId: ${orderResult.orderId ?? "N/A"}, positionId: ${orderResult.positionId ?? "N/A"})`);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logs.push(`Order request rejected by broker: ${err}`);
    return {
      success: false,
      orderId: null,
      positionId: null,
      verifiedPosition: null,
      slVerified: false,
      tpVerified: false,
      error: err,
      logs,
    };
  }

  const orderId = typeof orderResult.orderId === "string" ? orderResult.orderId : null;
  const initialPositionId = typeof orderResult.positionId === "string" ? orderResult.positionId : null;

  // Step 2: Post-execution position verification with retries (up to 3 attempts over 1.5s)
  let verifiedPosition: MetaApiPosition | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const snapshot = await getLiveAccountSnapshot(input.accountId);
      const targetSymbol = input.realSymbol ?? input.symbol;
      const matched = snapshot.positions.find((p) => {
        if (initialPositionId && p.id === initialPositionId) return true;
        return (
          p.symbol === targetSymbol &&
          Boolean(p.type?.toUpperCase().includes(input.direction)) &&
          Math.abs((p.volume ?? 0) - input.lot) < 0.0001
        );
      });
      if (matched) {
        verifiedPosition = matched;
        logs.push(`Position verified on broker snapshot (Attempt ${attempt}): ID ${matched.id ?? "N/A"}`);
        break;
      }
    } catch (err) {
      logs.push(`Broker snapshot verification attempt ${attempt} warning: ${String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!verifiedPosition) {
    logs.push("CRITICAL: Order accepted but position not found in live account snapshot!");
    return {
      success: true, // Order succeeded, but protection verification needs attention
      orderId,
      positionId: initialPositionId,
      verifiedPosition: null,
      slVerified: false,
      tpVerified: false,
      error: "Position registered but unverified on snapshot",
      logs,
    };
  }

  // Step 3: Verification of Symbol, Direction, Volume, SL, TP
  const tolerance = getPriceTolerance(input.symbol);
  let slVerified = verifiedPosition.stopLoss !== null && verifiedPosition.stopLoss !== undefined && Math.abs(verifiedPosition.stopLoss - input.sl) <= tolerance;
  let tpVerified = verifiedPosition.takeProfit !== null && verifiedPosition.takeProfit !== undefined && Math.abs(verifiedPosition.takeProfit - input.tp) <= tolerance;

  logs.push(`Protection Check -> SL attached: ${verifiedPosition.stopLoss ?? "NONE"} (Expected: ${input.sl}), TP attached: ${verifiedPosition.takeProfit ?? "NONE"} (Expected: ${input.tp})`);

  // Step 4: Emergency Correction if SL/TP attachment failed or drifted
  if ((!slVerified || !tpVerified) && verifiedPosition.id) {
    logs.push("UNPROTECTED POSITION DETECTED! Triggering emergency position protection modification...");
    try {
      await modifyMetaApiPosition({
        accountId: input.accountId,
        positionId: verifiedPosition.id,
        stopLoss: input.sl,
        takeProfit: input.tp,
      });
      logs.push("Emergency protection correction request transmitted successfully");

      // Re-verify correction
      const reSnapshot = await getLiveAccountSnapshot(input.accountId);
      const reMatched = reSnapshot.positions.find((p) => p.id === verifiedPosition?.id);
      if (reMatched) {
        verifiedPosition = reMatched;
        slVerified = reMatched.stopLoss !== null && reMatched.stopLoss !== undefined && Math.abs(reMatched.stopLoss - input.sl) <= tolerance;
        tpVerified = reMatched.takeProfit !== null && reMatched.takeProfit !== undefined && Math.abs(reMatched.takeProfit - input.tp) <= tolerance;
        logs.push(`Emergency Correction Verification -> SL: ${reMatched.stopLoss ?? "NONE"}, TP: ${reMatched.takeProfit ?? "NONE"}`);
      }
    } catch (err) {
      logs.push(`CRITICAL: Emergency protection modification failed: ${String(err)}`);
    }
  }

  // Step 5: Register in Supabase Journal
  try {
    await supabaseRequest("journal", {
      method: "POST",
      prefer: "return=representation",
      body: {
        account_id: input.accountId,
        symbol: input.symbol,
        real_symbol: input.realSymbol ?? input.symbol,
        direction: input.direction,
        entry: verifiedPosition.openPrice ?? 0,
        sl: verifiedPosition.stopLoss ?? input.sl,
        initial_sl: input.sl,
        tp: verifiedPosition.takeProfit ?? input.tp,
        lot: input.lot,
        pnl: 0,
        r_multiple: 0,
        status: "OPEN",
        broker_position_id: verifiedPosition.id ?? initialPositionId,
        broker_order_id: orderId,
        broker_status: "OPEN",
        poi_type: input.poiType ?? null,
        bos_mss_tag: input.bosMssTag ?? null,
        htf_bias: null,
        leverage: input.leverage,
        margin_used: input.marginUsed,
      },
    });
    logs.push("Position registered in persistent journal");
  } catch (err) {
    logs.push(`Journal registration warning: ${String(err)}`);
  }

  return {
    success: true,
    orderId,
    positionId: verifiedPosition.id ?? initialPositionId,
    verifiedPosition,
    slVerified,
    tpVerified,
    logs,
  };
}
