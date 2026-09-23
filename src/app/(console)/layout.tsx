import Link from "next/link";
import { listBrands, selectedBrandId } from "@/core/brand";
import { listIntegrations, isCapabilityReady } from "@/core/integrations";
import { jobCounts, workerStatus } from "@/core/jobs";
import { isSystemPaused } from "@/core/settings";
import { CAP } from "@/core/types";
import { logoutAction } from "@/app/actions";
import { requirePageSession, systemDetailsOn } from "@/lib/session";
import { BrandSelect } from "@/components/BrandSelect";
import { CommandBox } from "@/components/CommandBox";
import { SystemDetailsToggle } from "@/components/SystemDetailsToggle";
import { NavLinks } from "./NavLinks";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  await requirePageSession();
  const brandId = selectedBrandId();
    const ints = listIntegrations().filter((i) => i.def.external && i.id !== CAP.DRIVE);
  const connected = ints.filter((i) => i.state === "CONNECTED").length;
  const w = workerStatus();
  const counts = jobCounts();
  const paused = isSystemPaused();
  const sd = await systemDetailsOn();
  const opLabel = paused ? "Automation paused" : !w.alive ? "Worker not running" : `Worker · ${counts.QUEUED + counts.RETRYING} queued · ${counts.BLOCKED} blocked`;
  const opColor = paused || !w.alive ? "#e5a54b" : "#4cc38a";
  return (
    <>
      <header className="hdr">
        <Link href="/" className="wordmark">OUTLIER MEDIA OS</Link>
        <BrandSelect brands={listBrands().map((b) => ({ id: b.id, name: b.name, status: b.status }))} selected={brandId} />
        <div className="hdr-pill" title={w.lastBeat ? `Last worker heartbeat ${w.lastBeat}` : "No worker heartbeat recorded"}>
          <span className="dot" style={{ background: opColor }} />
          {opLabel}
        </div>
        <Link href="/system#connections" className="hdr-pill" style={{ textDecoration: "none" }} title="Required external connections that passed a live test">
          <span className="dot" style={{ background: connected === ints.length ? "#4cc38a" : "#e5484d" }} />
          Connections {connected} / {ints.length}
        </Link>
        <CommandBox aiConnected={isCapabilityReady(CAP.AI)} />
        <SystemDetailsToggle on={sd} />
      </header>
      <NavLinks>
        <form action={logoutAction} style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
          <button className="btn-link small muted" type="submit">Sign out</button>
        </form>
      </NavLinks>
      {children}
    </>
  );
}
