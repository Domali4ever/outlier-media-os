"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { act } from "@/app/actions";

export function BrandSelect({ brands, selected }: { brands: { id: string; name: string; status: string }[]; selected: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <label className="dark-field" style={{ fontSize: 13 }}>
      <span style={{ color: "#a6a39b" }}>Brand</span>
      <select
        aria-label="Selected brand"
        value={selected}
        disabled={pending}
        onChange={(e) => {
          const fd = new FormData();
          fd.set("op", "select_brand");
          fd.set("id", e.target.value);
          start(async () => {
            await act({ ok: true, message: "" }, fd);
            router.refresh();
          });
        }}
        style={{ fontWeight: 600, fontSize: 13 }}
      >
        {brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} · {b.status}
          </option>
        ))}
      </select>
    </label>
  );
}
