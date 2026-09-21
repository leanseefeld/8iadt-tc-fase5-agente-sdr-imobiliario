"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../leads.module.css";

/**
 * FR-023: the queue updates over an agency-scoped SSE stream — no polling.
 * Every `changed` frame just says "something moved"; `router.refresh()`
 * re-runs the Server Component, which re-reads through `services/leads.ts`
 * scoped exactly as before, so scroll, filter, search and the toggle are
 * untouched (nothing here holds any list state itself).
 *
 * Two missed pulses trip the "Conexão perdida" strip (mirrors the widget's
 * own rule in `ChatWidget.tsx`). `EventSource` reconnects on its own; this
 * component only tracks staleness for the message.
 */
export function LiveLeads({ pulseIntervalMs }: { pulseIntervalMs: number }) {
  const router = useRouter();
  const [lost, setLost] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/leads/stream");
    let lastPulseAt = Date.now();

    source.addEventListener("pulse", () => {
      lastPulseAt = Date.now();
      setLost(false);
    });

    source.addEventListener("changed", () => {
      router.refresh();
    });

    const missedPulseCheck = setInterval(() => {
      if (Date.now() - lastPulseAt > pulseIntervalMs * 2) setLost(true);
    }, pulseIntervalMs);

    return () => {
      source.close();
      clearInterval(missedPulseCheck);
    };
  }, [pulseIntervalMs, router]);

  if (!lost) return null;
  return (
    <p className={styles.connectionLost} role="status">
      Conexão perdida. Reconectando…
    </p>
  );
}
