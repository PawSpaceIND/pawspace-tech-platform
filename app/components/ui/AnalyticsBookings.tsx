"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { BookingSlice } from "../../../lib/analytics-bookings";
import css from "./visual-analytics.module.css";
type Result = { rows: { id: string; service_code: string; status: string; scheduled_start: string; total_amount: number; currency: string }[]; total: number; pageSize: number; cityId: string | null };
export default function AnalyticsBookings({ slice, onClose }: { slice: BookingSlice; onClose: () => void }) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => { region.current?.focus(); region.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, []);
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ ...slice, offset: String(offset) }).toString();
  const [state, setState] = useState<{ key: string; data?: Result; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/company-analytics/bookings?${query}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(response.status === 403 ? "Booking details require booking-management access. Your reporting access is unchanged." : body.error || "Booking details unavailable.");
      if (!controller.signal.aborted) setState({ key: query, data: body });
    }).catch(error => { if (!controller.signal.aborted) setState({ key: query, error: error.message }); });
    return () => controller.abort();
  }, [query]);
  const data = state?.key === query ? state.data : undefined;
  return <section ref={region} className={css.chart} aria-label="Booking details" tabIndex={-1}>
    <div className={css.header}><h3>Bookings behind the numbers</h3><button className={css.action} onClick={onClose}>Close booking details</button></div>
    <p className={css.muted}>{slice.from} → {slice.to} · {slice.serviceCode || "All services"} · {slice.status || "all"}. Booking values below include the displayed statuses.</p>
    {state?.key !== query ? <p role="status">Loading bookings…</p> : state.error ? <p role="alert">{state.error}</p> : data && <>
      <p role="status">{data.total} matching bookings{data.cityId ? ` within your permitted city (${data.cityId}); company-wide totals may differ` : ""}.</p>
      <div className={css.table}><table><thead><tr><th>Booking</th><th>Scheduled</th><th>Service</th><th>Status</th><th>Booking value</th></tr></thead><tbody>{data.rows.map(row => <tr key={row.id}><td><Link href={`/booking-command-center?bookingId=${encodeURIComponent(row.id)}`}>{row.id}</Link></td><td>{row.scheduled_start.slice(0, 10)}</td><td>{row.service_code}</td><td>{row.status}</td><td>{row.currency} {Number(row.total_amount).toLocaleString("en-IN")}</td></tr>)}</tbody></table></div>
      <div className={css.controls}><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous page</button><span>{data.total ? offset + 1 : 0}–{Math.min(offset + 50, data.total)} of {data.total}</span><button disabled={offset + 50 >= data.total} onClick={() => setOffset(offset + 50)}>Next page</button></div>
    </>}
  </section>;
}
