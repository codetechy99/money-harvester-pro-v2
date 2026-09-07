import test from "node:test";
import assert from "node:assert/strict";
import {
  getAccountCycleStatus,
  setEmergencyKillSwitch,
  updateAccountCycleConfig,
} from "./engine-scheduler";

test("getAccountCycleStatus manages active and cooldown states and kill switch", () => {
  const accountId = "test-cycle-acc-1";

  // Initial state check
  const status1 = getAccountCycleStatus(accountId);
  assert.equal(status1.state, "ACTIVE");
  assert.equal(status1.activeMinutes, 45);
  assert.equal(status1.cooldownMinutes, 20);
  assert.ok(status1.remainingActiveSeconds > 0);
  assert.equal(status1.remainingCooldownSeconds, 0);

  // Update config
  updateAccountCycleConfig(accountId, { activeMinutes: 60, cooldownMinutes: 30 });
  const status2 = getAccountCycleStatus(accountId);
  assert.equal(status2.activeMinutes, 60);
  assert.equal(status2.cooldownMinutes, 30);

  // Trigger emergency kill switch
  setEmergencyKillSwitch(accountId, true, "Manual user kill switch");
  const status3 = getAccountCycleStatus(accountId);
  assert.equal(status3.state, "EMERGENCY_STOP");
  assert.equal(status3.emergencyStop, true);
  assert.equal(status3.blockedReason, "Manual user kill switch");

  // Reset kill switch
  setEmergencyKillSwitch(accountId, false);
  const status4 = getAccountCycleStatus(accountId);
  assert.equal(status4.state, "ACTIVE");
  assert.equal(status4.emergencyStop, false);
});
