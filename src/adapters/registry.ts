import { audit } from "@/core/audit";
import { defFor, getIntegration, setIntegrationState } from "@/core/integrations";
import { CAP } from "@/core/types";
import { AppError, nowIso, redact } from "@/core/util";
import { testAnthropic } from "./anthropic";
import { testBrave } from "./brave";
import { testDrive, testGa4 } from "./google";
import { ProviderError } from "./http";
import { testWordPress } from "./wordpress";
import { testWhop } from "./whop";

type TestFn = () => Promise<{ ok: true; detail: string; capabilities: string[] }>;

const TESTS: Record<string, TestFn> = {
  [CAP.AI]: testAnthropic,
  [CAP.RESEARCH]: testBrave,
  [CAP.DRIVE]: testDrive,
  [CAP.PUBLISH]: testWordPress,
  [CAP.ANALYTICS]: testGa4,
  [CAP.COMMERCE]: testWhop,
};

/**
 * Runs the real, read-only acceptance check for an integration. CONNECTED is only set on success.
 * Tests never publish, spend beyond a metadata call, or modify remote state.
 */
export async function testIntegration(id: string, actor: string): Promise<{ ok: boolean; detail: string }> {
  const def = defFor(id);
  const fn = TESTS[id];
  if (!fn || !def.external) throw new AppError("NOT_APPLICABLE", `${id} has no external test.`);
  const prev = getIntegration(id);
  if (prev.state === "DISABLED") throw new AppError("BAD_STATE", "Integration is disabled. Resume it first.");
  setIntegrationState(id, "TESTING");
  try {
    const r = await fn();
    setIntegrationState(id, "CONNECTED", {
      last_test_at: nowIso(),
      last_test_result: redact(r.detail),
      last_success_at: nowIso(),
      last_error_json: null,
      verified_capabilities_json: JSON.stringify(r.capabilities),
    });
    audit({ actor, action: "integration.test", subjectType: "integration", subjectId: id, summary: `${id} test passed: ${r.detail}` });
    return { ok: true, detail: r.detail };
  } catch (e) {
    const pe = e instanceof ProviderError ? e : null;
    const message = redact((e as Error).message);
    const next = prev.state === "CONNECTED" || prev.state === "DEGRADED" ? "DEGRADED" : "CONFIGURING";
    setIntegrationState(id, prev.state === "PAUSED" ? "PAUSED" : next, {
      last_test_at: nowIso(),
      last_test_result: "FAILED",
      last_error_json: JSON.stringify({ code: pe?.code ?? "ERROR", message, status: pe?.status, at: nowIso() }),
      verified_capabilities_json: "[]",
    });
    audit({ actor, action: "integration.test", subjectType: "integration", subjectId: id, summary: `${id} test failed: ${message}`, level: "WARN" });
    return { ok: false, detail: message };
  }
}
