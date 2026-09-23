export const STAGES = ["IDEA", "RESEARCH", "SCRIPT", "QA", "APPROVAL", "READY", "PUBLISHED", "MEASURE"] as const;
export type Stage = (typeof STAGES)[number];

export const INTENTS = ["LOW", "MEDIUM", "HIGH"] as const;
export type Intent = (typeof INTENTS)[number];

export const RISKS = ["LOW", "MEDIUM", "HIGH", "BLOCKED"] as const;
export type Risk = (typeof RISKS)[number];

export const APPROVAL_STATES = ["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const FACT_STATUSES = ["VERIFIED", "UNVERIFIED", "NOT_APPLICABLE", "BLOCKED"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const CLAIM_TYPES = [
  "GENERAL",
  "SAFETY",
  "ELECTRICAL",
  "COMPATIBILITY",
  "AIRLINE",
  "MANUFACTURER",
  "MEDICAL",
  "COMMERCIAL",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
/** Claim types that block content until backed by dated, sourced evidence. */
export const HIGH_RISK_CLAIMS: ClaimType[] = ["SAFETY", "ELECTRICAL", "COMPATIBILITY", "AIRLINE", "MANUFACTURER", "MEDICAL"];

export const BRAND_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type BrandStatus = (typeof BRAND_STATUSES)[number];

export const JOB_STATES = [
  "QUEUED",
  "BLOCKED",
  "RUNNING",
  "RETRYING",
  "COMPLETE",
  "FAILED",
  "NEEDS_ATTENTION",
  "CANCELLED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const INTEGRATION_STATES = [
  "NOT_CONNECTED",
  "CONFIGURING",
  "TESTING",
  "CONNECTED",
  "DEGRADED",
  "PAUSED",
  "DISABLED",
  "OUT_OF_SCOPE",
  "LOCAL",
] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

export const RECOMMENDATION_TYPES = ["SCALE", "MAINTAIN", "MODIFY", "KILL", "INVESTIGATE"] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const COMMERCIAL_CRITERIA = [
  "relevance",
  "geography",
  "publisher_eligibility",
  "traffic_channels",
  "ai_video_policy",
  "product_eligibility",
  "attribution",
  "commission",
  "payout_terms",
  "reversals",
  "disclosure",
  "prohibited_methods",
] as const;
export type CommercialCriterion = (typeof COMMERCIAL_CRITERIA)[number];

export const PERMISSION_LEVELS = {
  OBSERVE: 0,
  PREPARE: 1,
  REVERSIBLE: 2,
  COMMERCIAL: 3,
  HUMAN_APPROVAL: 4,
} as const;
export type PermissionLevel = 0 | 1 | 2 | 3 | 4;

/** Capability keys used by integrations, job dependencies and readiness checks. */
export const CAP = {
  AI: "ai.structured_generation",
  RESEARCH: "research.retrieval",
  DRIVE: "docs.google_drive",
  PUBLISH: "publish.primary",
  ANALYTICS: "analytics.primary",
  AFFILIATE_REPORTING: "affiliate.reporting",
  COMMERCE: "commerce.primary",
  MEDIA: "media.voice_video",
} as const;
export type Capability = (typeof CAP)[keyof typeof CAP];

export type Actor = "operator" | "worker" | "system" | "command" | "import" | string;
