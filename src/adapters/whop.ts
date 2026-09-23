import { WhopClient } from "@whop/sdk";
import { getSecret } from "@/core/settings";

const SANDBOX_API = "https://sandbox-api.whop.com/api/v1";
const PRODUCTION_API = "https://api.whop.com/api/v1";

function client() {
  const token = getSecret("WHOP_COMPANY_API_KEY");
  if (!token) throw new Error("WHOP_COMPANY_API_KEY is not configured.");
  return new WhopClient({
    token,
    baseUrl: getSecret("WHOP_SANDBOX") === "true" ? SANDBOX_API : PRODUCTION_API,
    maxRetries: 0,
  });
}

export async function testWhop() {
  const companyId = getSecret("WHOP_COMPANY_ID");
  if (!companyId) throw new Error("WHOP_COMPANY_ID is not configured.");
  const account = await client().accounts.retrieve({ id: companyId });
  return { ok: true as const, detail: `Whop company ${account.id} is available`, capabilities: ["checkout", "payments", "webhooks"] };
}
