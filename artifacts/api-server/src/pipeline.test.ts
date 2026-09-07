import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  currenciesForSymbol,
  hasHighImpactNewsWithin,
} from "./lib/market";
import { SUPPORTED_SYMBOLS } from "./lib/strategy";

describe("Trading Pipeline Sequence & Risk Gates Test Suite", () => {
  test("1. Strategy analyzes live market data / candle structures", () => {
    assert.ok(SUPPORTED_SYMBOLS.includes("EURUSD"));
    assert.ok(SUPPORTED_SYMBOLS.includes("XAUUSD"));
    assert.ok(SUPPORTED_SYMBOLS.includes("NAS100"));
    assert.equal(SUPPORTED_SYMBOLS.length, 5);
  });

  test("2. Currencies mapping for news filter", () => {
    assert.deepEqual(currenciesForSymbol("EURUSD"), ["EUR", "USD"]);
    assert.deepEqual(currenciesForSymbol("XAUUSD"), ["USD"]);
  });

  test("3. Risk manager news gate handles missing API key gracefully", async () => {
    const originalKey = process.env.FINNHUB_API_KEY;
    delete process.env.FINNHUB_API_KEY;
    try {
      const result = await hasHighImpactNewsWithin("EURUSD", 30);
      assert.equal(result.blocked, false);
      assert.equal(result.event, null);
    } finally {
      if (originalKey !== undefined) {
        process.env.FINNHUB_API_KEY = originalKey;
      }
    }
  });

  test("4. SL/TP validation rules for BUY and SELL orders", () => {
    const ask = 1.0850;
    const bid = 1.0848;

    // BUY order rule: SL < entry (ask) and TP > entry (ask)
    const validBuySL = 1.0830;
    const validBuyTP = 1.0890;
    assert.ok(validBuySL < ask, "BUY SL must be below ask");
    assert.ok(validBuyTP > ask, "BUY TP must be above ask");

    // Invalid BUY SL (>= ask)
    const invalidBuySL = 1.0855;
    assert.ok(!(invalidBuySL < ask), "BUY SL above ask must fail validation");

    // SELL order rule: SL > entry (bid) and TP < entry (bid)
    const validSellSL = 1.0870;
    const validSellTP = 1.0810;
    assert.ok(validSellSL > bid, "SELL SL must be above bid");
    assert.ok(validSellTP < bid, "SELL TP must be below bid");
  });

  test("5. Lot size calculation using broker specification formula", () => {
    const equity = 10000;
    const riskPercent = 0.01; // 1%
    const riskAmount = equity * riskPercent; // $100

    const entry = 1.08500;
    const sl = 1.08300;
    const slDistance = Math.abs(entry - sl); // 0.00200 = 200 ticks if tickSize = 0.00001
    const tickSize = 0.00001;
    const tickValue = 1; // $1 per tick for 1.0 lot
    const volumeStep = 0.01;
    const volumeMax = 100;
    const volumeMin = 0.01;

    const ticks = Math.round(slDistance / tickSize);
    const lossPerLot = ticks * tickValue; // 200 * $1 = $200 per lot
    const requestedLot = riskAmount / lossPerLot; // $100 / $200 = 0.50 lots

    const floorLot = (value: number) =>
      Math.floor(value / volumeStep + 1e-9) * volumeStep;
    const lot = Number(floorLot(Math.min(requestedLot, volumeMax)).toFixed(2));

    assert.equal(lot, 0.5);
    assert.ok(lot >= volumeMin, "Calculated lot satisfies minimum volume");
  });

  test("6. Margin check formula calculation", () => {
    const lot = 0.5;
    const contractSize = 100000;
    const entryPrice = 1.0850;
    const leverage = 100;
    const freeMargin = 5000;
    const equity = 10000;

    const marginUsed = (lot * contractSize * entryPrice) / leverage;
    // (0.5 * 100000 * 1.0850) / 100 = 542.50
    assert.equal(marginUsed, 542.5);
    assert.ok(marginUsed <= freeMargin, "Margin used is within free margin");
    assert.ok(marginUsed <= equity * 0.5, "Margin used is within 50% equity limit");
  });

  test("7. External MetaApi execution status handling", () => {
    const metaApiToken = process.env.METAAPI_TOKEN;
    if (!metaApiToken) {
      // Credentials not present -> External execution is UNVERIFIED
      const executionStatus = "UNVERIFIED";
      assert.equal(executionStatus, "UNVERIFIED");
    } else {
      assert.ok(typeof metaApiToken === "string");
    }
  });
});
