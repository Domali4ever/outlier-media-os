"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "TODAY" },
  { href: "/pipeline", label: "PIPELINE" },
  { href: "/brand", label: "BRAND" },
  { href: "/system", label: "SYSTEM" },
];

export function NavLinks({ children }: { children?: React.ReactNode }) {
  const p = usePathname();
  return (
    <nav aria-label="Primary" className="nav">
      {ITEMS.map((i) => {
        const active = i.href === "/" ? p === "/" : p.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}>
            {i.label}
          </Link>
        );
      })}
      {children}
    </nav>
  );
}
