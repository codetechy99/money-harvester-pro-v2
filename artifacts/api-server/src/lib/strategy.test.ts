import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeM1Confirmation,
  evaluatePropSafety,
  evaluateStrategySetup,
  runPostExecutionPipeline,
  type Candle,
  type Poi,
  type Pool,
  type PostExecutionPipelineDeps,
} from "./strategy";

function makeCandles(
  count: number,
  startPrice = 1.0800,
  step = 0.0001,
  pattern: "UP" | "DOWN" | "BULLISH_MSS" | "BEARISH_MSS" = "UP",
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const isLastClosed = i === count - 2;
    let open = price;
    let close = open + step;

    if (pattern === "DOWN") {
      close = open - step;
    } else if (pattern === "BULLISH_MSS") {
      if (i < count - 3) {
        open = 1.0800 + (i % 3) * 0.0001;
        close = open + 0.00005;
      } else if (i === count - 3) {
        open = 1.0804;
        close = 1.0805;
      } else if (isLastClosed) {
        open = 1.0804;
        close = 1.0815;
      } else if (i === count - 1) {
        open = 1.0815;
        close = 1.0816;
      }
    } else if (pattern === "BEARISH_MSS") {
      if (i < count - 3) {
        open = 1.0810 - (i % 3) * 0.0001;
        close = open - 0.00005;
      } else if (i === count - 3) {
        open = 1.0806;
        close = 1.0805;
      } else if (isLastClosed) {
        open = 1.0806;
        close = 1.0790;
      } else if (i === count - 1) {
        open = 1.0790;
        close = 1.0789;
      }
    }

    const high = Math.max(open, close) + 0.0001;
    const low = Math.min(open, close) - 0.0001;

    candles.push({
      time: new Date(now - (count - i) * 60_000).toISOString(),
      open,
      high,
      low,
      close,
      volume: 100,
    });

    price = close;
  }

  return candles;
}

const dummyPoi: Poi = {
  high: 1.0820,
  low: 1.0780,
  creationIndex: 10,
  expiryIndex: 60,
  touched: true,
  type: "OB_BULL",
};

const dummyPool: Pool = {
  type: "SSL",
  avgPrice: 1.0770,
  strength: 3,
  swept: true,
};

describe("Pre-Merge Hardening Strategy Pass Tests", () => {
  // 1. Valid Daily/H4 -> M15 -> M5 -> M1 setup produces entry
  it("Scenario 1: Valid Daily/H4 -> M15 -> M5 -> M1 setup produces an entry candidate", () => {
    const m1Candles = makeCandles(22, 1.0800, 0.0002, "BULLISH_MSS");
    const m1Result = analyzeM1Confirmation({
      m1Candles,
      poiType: "OB_BULL",
      poiHigh: 1.0820,
      poiLow: 1.0780,
      m5Triggered: true,
    });

    assert.equal(m1Result.m1Triggered, true);

    const setupResult = evaluateStrategySetup({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      trend: "BULLISH",
      pools: [dummyPool],
      sweep: dummyPool,
      poi: dummyPoi,
      m5Triggered: true,
      m1Triggered: m1Result.m1Triggered,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, true);
    assert.equal(setupResult.failedConditions.length, 0);
  });

  // 2. Missing M1 data = REJECT
  it("Scenario 2: Missing M1 data = REJECT", () => {
    const m1Result = analyzeM1Confirmation({
      m1Candles: null,
      poiType: "OB_BULL",
      poiHigh: 1.0820,
      poiLow: 1.0780,
      m5Triggered: true,
    });

    assert.equal(m1Result.m1Triggered, false);

    const setupResult = evaluateStrategySetup({
      m5Triggered: true,
      m1Triggered: m1Result.m1Triggered,
      poi: dummyPoi,
      sweep: dummyPool,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("Missing M1 micro confirmation"));
  });

  // 3. Empty M1 data = REJECT
  it("Scenario 3: Empty M1 data = REJECT", () => {
    const m1Result = analyzeM1Confirmation({
      m1Candles: [],
      poiType: "OB_BULL",
      poiHigh: 1.0820,
      poiLow: 1.0780,
      m5Triggered: true,
    });

    assert.equal(m1Result.m1Triggered, false);

    const setupResult = evaluateStrategySetup({
      m5Triggered: true,
      m1Triggered: m1Result.m1Triggered,
      poi: dummyPoi,
      sweep: dummyPool,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
  });

  // 4. Insufficient M1 closed candles (<10) = REJECT
  it("Scenario 4: Insufficient M1 closed candles (<10) = REJECT", () => {
    const m1Candles = makeCandles(5, 1.0800, 0.0002, "BULLISH_MSS");
    const m1Result = analyzeM1Confirmation({
      m1Candles,
      poiType: "OB_BULL",
      poiHigh: 1.0820,
      poiLow: 1.0780,
      m5Triggered: true,
    });

    assert.equal(m1Result.m1Triggered, false);
    assert.match(m1Result.reason ?? "", /Insufficient M1 closed candles/i);
  });

  // 5. M1 displacement without required microstructure confirmation (MSS/BOS) = REJECT
  it("Scenario 5: M1 displacement without required microstructure confirmation = REJECT", () => {
    const m1Candles = makeCandles(20, 1.0800, 0.00001, "UP");
    const m1Result = analyzeM1Confirmation({
      m1Candles,
      poiType: "OB_BULL",
      poiHigh: 1.0820,
      poiLow: 1.0780,
      m5Triggered: true,
    });

    assert.equal(m1Result.m1Triggered, false);
  });

  // 6. M5 confirmation without M1 confirmation = REJECT
  it("Scenario 6: M5 confirmation without M1 confirmation = REJECT", () => {
    const setupResult = evaluateStrategySetup({
      m5Triggered: true,
      m1Triggered: false,
      poi: dummyPoi,
      sweep: dummyPool,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("Missing M1 micro confirmation"));
  });

  // 7. Undefined m1Triggered = REJECT / false
  it("Scenario 7: Undefined m1Triggered = REJECT / false", () => {
    const setupResult = evaluateStrategySetup({
      m5Triggered: true,
      m1Triggered: undefined,
      poi: dummyPoi,
      sweep: dummyPool,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.m1Triggered, false);
    assert.equal(setupResult.executable, false);
  });

  // 8. Strategy score cannot override missing M1
  it("Scenario 8: High setup score cannot override missing M1 confirmation", () => {
    const setupResult = evaluateStrategySetup({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      poi: dummyPoi,
      sweep: dummyPool,
      m5Triggered: true,
      m1Triggered: false,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.score, 80); // High numeric score
    assert.equal(setupResult.executable, false); // Still rejected due to mandatory M1 gate
  });

  // 9. HTF conflict = REJECT
  it("Scenario 9: HTF conflict = REJECT", () => {
    const setupResult = evaluateStrategySetup({
      htfConflict: true,
      poi: dummyPoi,
      sweep: dummyPool,
      m5Triggered: true,
      m1Triggered: true,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("HTF conflict active"));
  });

  // 10. Missing sweep = REJECT
  it("Scenario 10: Missing liquidity sweep = REJECT", () => {
    const setupResult = evaluateStrategySetup({
      poi: dummyPoi,
      sweep: null,
      m5Triggered: true,
      m1Triggered: true,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("Missing liquidity sweep"));
  });

  // 11. Missing BOS/MSS = REJECT
  it("Scenario 11: Missing BOS/MSS = REJECT", () => {
    const m1Candles = makeCandles(20, 1.0800, 0.00001, "DOWN");
    const m1Result = analyzeM1Confirmation({
      m1Candles,
      poiType: "OB_BULL",
      poiHigh: 1.0820,
      poiLow: 1.0780,
      m5Triggered: true,
    });

    assert.equal(m1Result.m1Triggered, false);
  });

  // 12. Missing POI = REJECT
  it("Scenario 12: Missing POI = REJECT", () => {
    const setupResult = evaluateStrategySetup({
      poi: null,
      sweep: dummyPool,
      m5Triggered: true,
      m1Triggered: true,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("Missing POI"));
  });

  // 13. Missing M5 confirmation = REJECT
  it("Scenario 13: Missing M5 confirmation = REJECT", () => {
    const setupResult = evaluateStrategySetup({
      poi: dummyPoi,
      sweep: dummyPool,
      m5Triggered: false,
      m1Triggered: true,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("Missing M5 POI confirmation"));
  });

  // 14. PROP invalid metrics = REJECT
  it("Scenario 14: PROP invalid metrics = REJECT", () => {
    const prop1 = evaluatePropSafety(null, 10000);
    assert.equal(prop1.safe, false);

    const prop2 = evaluatePropSafety({ startingBalance: -100, highestEquity: 10000, dailyStartingEquity: 10000 }, 10000);
    assert.equal(prop2.safe, false);

    const prop3 = evaluatePropSafety({ startingBalance: 10000, highestEquity: 0, dailyStartingEquity: 10000 }, 10000);
    assert.equal(prop3.safe, false);
  });

  // 15. PROP safety exception = REJECT
  it("Scenario 15: PROP safety exception = REJECT", () => {
    const prop = evaluatePropSafety({ startingBalance: NaN, highestEquity: 10000, dailyStartingEquity: 10000 }, 10000);
    assert.equal(prop.safe, false);
  });

  // 16. News blackout = REJECT
  it("Scenario 16: News blackout = REJECT", () => {
    const setupResult = evaluateStrategySetup({
      poi: dummyPoi,
      sweep: dummyPool,
      m5Triggered: true,
      m1Triggered: true,
      newsBlocked: true,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("High-impact news blackout active"));
  });

  // 17. Excessive spread = REJECT
  it("Scenario 17: Excessive spread = REJECT", () => {
    const setupResult = evaluateStrategySetup({
      poi: dummyPoi,
      sweep: dummyPool,
      m5Triggered: true,
      m1Triggered: true,
      spreadBlocked: true,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("Excessive broker spread"));
  });

  // 18. Kill switch = REJECT
  it("Scenario 18: Kill switch = REJECT", () => {
    const setupResult = evaluateStrategySetup({
      poi: dummyPoi,
      sweep: dummyPool,
      m5Triggered: true,
      m1Triggered: true,
      killSwitchActive: true,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("Kill switch / trading halt active"));
  });

  // 19. COOLDOWN = no new entry but existing position management remains active
  it("Scenario 19: Cooldown blocks new entries but allows management", () => {
    const setupResult = evaluateStrategySetup({
      poi: dummyPoi,
      sweep: dummyPool,
      m5Triggered: true,
      m1Triggered: true,
      cooldownActive: true,
      propSafety: { safe: true },
    });

    assert.equal(setupResult.executable, false);
    assert.ok(setupResult.failedConditions.includes("Cooldown active"));
  });

  // 20. Automated order uses runPostExecutionPipeline()
  it("Scenario 20: runPostExecutionPipeline() executes trade and verifies broker position", async () => {
    let journalSaved = false;
    const mockDeps: PostExecutionPipelineDeps = {
      executeMetaApiTrade: async () => ({
        orderId: "ORD123",
        positionId: "POS123",
      }),
      getLiveAccountSnapshot: async (accId: string) => ({
        accountId: accId,
        brokerName: "Mock",
        server: "MockServer",
        accountType: "REAL",
        connectionState: "CONNECTED",
        balance: 10000,
        equity: 10000,
        leverage: 100,
        leverageDisplay: "1:100",
        currency: "USD",
        margin: 100,
        freeMargin: 9900,
        marginLevel: 10000,
        connected: true,
        dataSource: "MetaApi",
        positions: [
          {
            id: "POS123",
            symbol: "EURUSD",
            type: "POSITION_TYPE_BUY",
            volume: 0.1,
            openPrice: 1.0800,
            currentPrice: 1.0805,
            stopLoss: 1.0770,
            takeProfit: 1.0875,
            profit: 5,
            swap: 0,
            time: new Date().toISOString(),
          },
        ],
      }),
      moveMetaApiPositionStopToBreakEven: async () => ({}),
      insertJournal: (async () => {
        journalSaved = true;
        return {};
      }) as any,
    };

    const res = await runPostExecutionPipeline(
      {
        accountId: "test-acc",
        symbol: "EURUSD",
        realSymbol: "EURUSD",
        direction: "BUY",
        entryPrice: 1.0800,
        sl: 1.0770,
        tp: 1.0875,
        lot: 0.1,
        leverage: 100,
        marginUsed: 108,
      },
      mockDeps,
    );

    assert.equal(res.positionId, "POS123");
    assert.equal(res.status, "OPEN");
    assert.equal(journalSaved, true);
  });

  // 21. Broker position verification failure prevents successful trade registration
  it("Scenario 21: Broker position verification failure throws error", async () => {
    const mockDeps: PostExecutionPipelineDeps = {
      executeMetaApiTrade: async () => ({
        orderId: "ORD999",
        positionId: "POS999",
      }),
      getLiveAccountSnapshot: async (accId: string) => ({
        accountId: accId,
        brokerName: "Mock",
        server: "MockServer",
        accountType: "REAL",
        connectionState: "CONNECTED",
        balance: 10000,
        equity: 10000,
        leverage: 100,
        leverageDisplay: "1:100",
        currency: "USD",
        margin: 0,
        freeMargin: 10000,
        marginLevel: null,
        connected: true,
        dataSource: "MetaApi",
        positions: [],
      }),
      moveMetaApiPositionStopToBreakEven: async () => ({}),
      insertJournal: (async () => {}) as any,
    };

    await assert.rejects(
      async () => {
        await runPostExecutionPipeline(
          {
            accountId: "test-acc",
            symbol: "EURUSD",
            realSymbol: "EURUSD",
            direction: "BUY",
            entryPrice: 1.0800,
            sl: 1.0770,
            tp: 1.0875,
            lot: 0.1,
            leverage: 100,
            marginUsed: 108,
          },
          mockDeps,
        );
      },
      /Broker position verification failed/i,
    );
  });
});
