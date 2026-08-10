"use client";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";

export interface ChartSeries {
  key: string;
  label?: string;
  color?: string;
}

export interface TrendChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: ChartSeries[];
  type?: "line" | "bar";
  height?: number;
  valueFormatter?: (value: number) => string;
}

const palette = ["#5d22a8", "#f59d19", "#11885b", "#2563c9", "#c92f3f"];

export default function TrendChart({ data, xKey, series, type = "line", height = 260, valueFormatter }: TrendChartProps) {
  const format = valueFormatter ?? ((value: number) => String(value));
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        {type === "line" ? (
          <LineChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e9e1f4" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} stroke="#8b818f" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis stroke="#8b818f" fontSize={11} tickLine={false} axisLine={false} width={44} tickFormatter={format} />
            <Tooltip formatter={(value: number) => format(value)} contentStyle={{ borderRadius: 12, border: "1px solid #e9e1f4", fontSize: 12 }} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label ?? s.key} stroke={s.color ?? palette[i % palette.length]} strokeWidth={2.5} dot={false} />
            ))}
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e9e1f4" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} stroke="#8b818f" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis stroke="#8b818f" fontSize={11} tickLine={false} axisLine={false} width={44} tickFormatter={format} />
            <Tooltip formatter={(value: number) => format(value)} contentStyle={{ borderRadius: 12, border: "1px solid #e9e1f4", fontSize: 12 }} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={s.color ?? palette[i % palette.length]} radius={[6, 6, 0, 0]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
