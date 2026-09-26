"use client";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";

export interface ChartSeries {
  key: string;
  label?: string;
  color?: string;
  dashed?: boolean;
}

export interface TrendChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: ChartSeries[];
  type?: "line" | "bar";
  height?: number;
  valueFormatter?: (value: number) => string;
  axisValueFormatter?: (value: number) => string;
}

const palette = ["var(--staff-primary, var(--paw-primary, #11885b))", "var(--staff-gold, var(--paw-gold, #eab648))", "#497bc1", "#b35da2", "var(--staff-danger, var(--paw-danger, #af3444))"];

export default function TrendChart({ data, xKey, series, type = "line", height = 260, valueFormatter, axisValueFormatter }: TrendChartProps) {
  const format = valueFormatter ?? ((value: number) => String(value));
  if (!data.length) return <p role="status" style={{ padding: 24, color: "var(--staff-muted, var(--paw-muted))" }}>No data for this chart.</p>;
  return (
    <div style={{ width: "100%", minWidth: 0 }}>
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {type === "line" ? (
          <LineChart accessibilityLayer data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--staff-line, var(--paw-line, #ddd))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} stroke="var(--staff-muted, var(--paw-muted, #68716b))" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis stroke="var(--staff-muted, var(--paw-muted, #68716b))" fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={axisValueFormatter ?? format} />
            <Tooltip formatter={(value) => format(Number(value))} contentStyle={{ borderRadius: 12, border: "1px solid var(--staff-bg, var(--paw-bg))", fontSize: 12, background: "var(--staff-surface, var(--paw-surface, #fff))", color: "var(--staff-text, var(--paw-text, #182c25))" }} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label ?? s.key} stroke={s.color ?? palette[i % palette.length]} strokeDasharray={s.dashed ? "5 4" : undefined} strokeWidth={2.5} dot={data.length === 1} isAnimationActive={false} />
            ))}
          </LineChart>
        ) : (
          <BarChart accessibilityLayer data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--staff-line, var(--paw-line, #ddd))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} stroke="var(--staff-muted, var(--paw-muted, #68716b))" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis stroke="var(--staff-muted, var(--paw-muted, #68716b))" fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={axisValueFormatter ?? format} />
            <Tooltip formatter={(value) => format(Number(value))} contentStyle={{ borderRadius: 12, border: "1px solid var(--staff-bg, var(--paw-bg))", fontSize: 12, background: "var(--staff-surface, var(--paw-surface, #fff))", color: "var(--staff-text, var(--paw-text, #182c25))" }} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={s.color ?? palette[i % palette.length]} radius={[6, 6, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
    <details style={{ marginTop: 10, fontSize: 12, overflowX: "auto" }}><summary style={{ cursor: "pointer" }}>View chart data</summary><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><th scope="col">{xKey}</th>{series.map(s => <th scope="col" key={s.key}>{s.label ?? s.key}</th>)}</tr></thead><tbody>{data.map((row, index) => <tr key={index}><th scope="row">{String(row[xKey] ?? "—")}</th>{series.map(s => <td key={s.key} style={{ textAlign: "center", padding: 6 }}>{row[s.key] == null ? "Unavailable" : format(Number(row[s.key]))}</td>)}</tr>)}</tbody></table></details>
    </div>
  );
}
