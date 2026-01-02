"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Reading = {
  device_id: string;
  sensor_id: string;
  sensor_name: string;
  temp_c: number;
  ts_utc: string;
};

const DEVICE_ID = process.env.NEXT_PUBLIC_DEVICE_ID || "pi4";
const TIME_ZONE = "America/Chicago";

function formatChicago(isoUtc: string) {
  const d = new Date(isoUtc);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(d);
}

export default function Home() {
  const [latestBySensor, setLatestBySensor] = useState<Record<string, Reading>>(
    {}
  );
  const [status, setStatus] = useState<string>("Connecting…");

  const rows = useMemo(() => {
    return Object.values(latestBySensor).sort((a, b) =>
      a.sensor_name.localeCompare(b.sensor_name)
    );
  }, [latestBySensor]);

  async function loadInitial() {
    setStatus("Loading…");
    const { data, error } = await supabase
      .from("temperature_readings")
      .select("device_id,sensor_id,sensor_name,temp_c,ts_utc")
      .eq("device_id", DEVICE_ID)
      .order("ts_utc", { ascending: false })
      .limit(100);

    if (error) {
      setStatus(`Error: ${error.message}`);
      return;
    }

    const map: Record<string, Reading> = {};
    for (const r of data as Reading[]) {
      if (!map[r.sensor_name]) map[r.sensor_name] = r;
    }
    setLatestBySensor(map);
    setStatus("Live ✅");
  }

useEffect(() => {
  let channel: any = null;
  let pollTimer: any = null;

  const subscribe = () => {
    // Clean up old channel if any
    if (channel) supabase.removeChannel(channel);

    channel = supabase
      .channel("temps-live")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "temperature_readings",
          filter: `device_id=eq.${DEVICE_ID}`,
        },
        (payload) => {
          const r = payload.new as Reading;
          setLatestBySensor((prev) => {
            const current = prev[r.sensor_name];
            if (current && new Date(current.ts_utc) >= new Date(r.ts_utc)) return prev;
            return { ...prev, [r.sensor_name]: r };
          });
        }
      )
      .subscribe((s) => setStatus(String(s)));
  };

  const refresh = () => {
    // Pull latest values (works even if websockets are paused)
    loadInitial();
  };

  const handleResume = () => {
    // When phone returns to foreground / regains network:
    if (document.visibilityState !== "visible") return;
    setStatus("Reconnecting…");
    refresh();
    subscribe();
  };

  // Initial load + subscribe
  refresh();
  subscribe();

  // Auto-reconnect triggers
  document.addEventListener("visibilitychange", handleResume);
  window.addEventListener("focus", handleResume);
  window.addEventListener("online", handleResume);

  // Polling fallback (every 5 seconds)
  // This ensures temps still update even if realtime drops silently.
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, 5000);

  // Cleanup
  return () => {
    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("online", handleResume);

    if (pollTimer) clearInterval(pollTimer);
    if (channel) supabase.removeChannel(channel);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

  return (
    <main style={{ padding: 16, maxWidth: 720, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Live Temperatures</h1>
      <div style={{ opacity: 0.75, marginBottom: 16 }}>
        Device: <b>{DEVICE_ID}</b> • Time zone: <b>{TIME_ZONE}</b> • Status: <b>{status}</b>
      </div>

      {rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No data yet. Make sure your Pi uploader is running.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((r) => (
            <div
              key={r.sensor_name}
              style={{
                border: "1px solid rgba(0,0,0,0.15)",
                borderRadius: 16,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 700 }}>{r.sensor_name}</div>
              <div style={{ fontSize: 42, fontWeight: 800, marginTop: 6 }}>
                {Number(r.temp_c).toFixed(2)} °C
              </div>
              <div style={{ marginTop: 8, opacity: 0.75, fontSize: 14 }}>
                Updated: <b>{formatChicago(r.ts_utc)}</b>
              </div>
              <div style={{ marginTop: 4, opacity: 0.6, fontSize: 12 }}>
                sensor_id: {r.sensor_id}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
