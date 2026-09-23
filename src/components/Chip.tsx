const MAP: Record<string, string> = {
  MEASURED: "c-ok", CONNECTED: "c-ok", COMPLETE: "c-ok", APPROVED: "c-ok", VERIFIED: "c-ok", PASS: "c-ok", ACTIVE: "c-ok", QUALIFIED: "c-ok", CLEARED: "c-ok", VALID: "c-ok", CONFIRMED: "c-ok", MANUAL_CONFIRMED: "c-ok", LOCAL: "c-ok", LOW: "c-ok", SUFFICIENT: "c-ok", IMPLEMENTED: "c-ok", LOCAL_VERIFIED: "c-ok", CONTRACT_TESTED: "c-ok", LIVE_VERIFIED: "c-ok",
  BLOCKED: "c-block", FAILED: "c-block", REJECTED: "c-block", FAIL: "c-block", HIGH: "c-block", DISQUALIFIED: "c-block", NOT_CONNECTED_BLOCK: "c-block", DECLINED: "c-block", INVALID: "c-block", KILL: "c-block",
  UNVERIFIED: "c-warn", PARTIAL: "c-warn", STALE: "c-warn", WARN: "c-warn", MEDIUM: "c-warn", NEEDS_ATTENTION: "c-warn", DEGRADED: "c-warn", EXPIRED: "c-warn", RETRYING: "c-warn", DRAFT_ACTIVE: "c-warn", NOT_CALCULABLE: "c-warn", AMBIGUOUS: "c-warn", MODIFY: "c-warn", INSUFFICIENT: "c-warn",
  PENDING: "c-info", QUEUED: "c-info", RUNNING: "c-info", TESTING: "c-info", CONFIGURING: "c-info", INVESTIGATE: "c-info", SCALE: "c-ok", MAINTAIN: "c-off", ESTIMATED: "c-info", DISCOVERED: "c-warn", APPLIED: "c-info",
};

export function Chip({ v, label, cls }: { v: string; label?: string; cls?: string }) {
  return <span className={`chip ${cls ?? MAP[v] ?? "c-off"}`}>{(label ?? v).replace(/_/g, " ")}</span>;
}
