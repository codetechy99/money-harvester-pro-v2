import test from "node:test";
import assert from "node:assert/strict";

function floorLot(value: number, volumeStep: number) {
  const steps = Math.floor(Math.round((value / volumeStep) * 1e8) / 1e8);
  const decimals = (volumeStep.toString().split(".")[1] || "").length;
  return Number((steps * volumeStep).toFixed(decimals));
}

function directionMatches(direction: unknown, positionType: string) {
  const normalizedDirection = String(direction ?? "").toUpperCase();
  const normalizedType = positionType.toUpperCase();
  return normalizedType.includes(normalizedDirection === "SELL" ? "SELL" : "BUY");
}

function getPriceTolerance(symbol: string) {
  const activeSymbol = symbol.toUpperCase();
  return activeSymbol.includes("XAU") || activeSymbol.includes("GOLD")
    ? 0.5
    : activeSymbol.includes("US30") || activeSymbol.includes("NAS") || activeSymbol.includes("US100") || activeSymbol.includes("DJ30")
      ? 5.0
      : 0.0005;
}

test("floorLot prevents IEEE 754 precision loss on min lot and step sizing", () => {
  assert.equal(floorLot(0.01, 0.01), 0.01);
  assert.equal(floorLot(0.010000000000000002, 0.01), 0.01);
  assert.equal(floorLot(0.05999999999999999, 0.01), 0.06);
  assert.equal(floorLot(0.1, 0.1), 0.1);
  assert.equal(floorLot(0.05, 0.1), 0.0);
});

test("directionMatches correctly checks position types", () => {
  assert.equal(directionMatches("BUY", "POSITION_TYPE_BUY"), true);
  assert.equal(directionMatches("SELL", "POSITION_TYPE_SELL"), true);
  assert.equal(directionMatches("BUY", "POSITION_TYPE_SELL"), false);
});

test("getPriceTolerance assigns symbol-specific tolerances", () => {
  assert.equal(getPriceTolerance("EURUSD"), 0.0005);
  assert.equal(getPriceTolerance("GBPUSD"), 0.0005);
  assert.equal(getPriceTolerance("XAUUSD"), 0.5);
  assert.equal(getPriceTolerance("GOLD.m"), 0.5);
  assert.equal(getPriceTolerance("US30"), 5.0);
  assert.equal(getPriceTolerance("NAS100"), 5.0);
});
