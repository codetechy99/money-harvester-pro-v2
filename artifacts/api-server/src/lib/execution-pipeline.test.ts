import test from "node:test";
import assert from "node:assert/strict";

function getPriceTolerance(symbol: string) {
  const activeSymbol = symbol.toUpperCase();
  return activeSymbol.includes("XAU") || activeSymbol.includes("GOLD")
    ? 0.5
    : activeSymbol.includes("US30") || activeSymbol.includes("NAS") || activeSymbol.includes("US100") || activeSymbol.includes("DJ30")
      ? 5.0
      : 0.0005;
}

function verifyProtection(
  currentSl: number | null,
  currentTp: number | null,
  expectedSl: number,
  expectedTp: number,
  symbol: string,
) {
  const tolerance = getPriceTolerance(symbol);
  const slOk = currentSl !== null && Math.abs(currentSl - expectedSl) <= tolerance;
  const tpOk = currentTp !== null && Math.abs(currentTp - expectedTp) <= tolerance;
  return { slOk, tpOk };
}

test("verifyProtection correctly validates attached SL/TP within tolerance", () => {
  const eurusdResult = verifyProtection(1.08300, 1.08900, 1.08302, 1.08898, "EURUSD");
  assert.equal(eurusdResult.slOk, true);
  assert.equal(eurusdResult.tpOk, true);

  const goldResult = verifyProtection(2700.0, 2750.0, 2700.3, 2750.2, "XAUUSD");
  assert.equal(goldResult.slOk, true);
  assert.equal(goldResult.tpOk, true);

  const missingSlResult = verifyProtection(null, 1.08900, 1.08300, 1.08900, "EURUSD");
  assert.equal(missingSlResult.slOk, false);
  assert.equal(missingSlResult.tpOk, true);
});
