"use client";

import { useRouter } from "next/navigation";

/** Persistent UI preference (cookie). It changes what is shown, never permissions or behaviour. */
export function SystemDetailsToggle({ on }: { on: boolean }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={on}
      onClick={() => {
        document.cookie = `omos_sd=${on ? "0" : "1"}; path=/; max-age=31536000; samesite=strict`;
        router.refresh();
      }}
    >
      <span className="track"><span className="knob" /></span>
      System details
    </button>
  );
}
