"use client";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function ScanChart({ data }: { data: { date: string; count: number }[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) {
    return <p className="py-10 text-center text-sm text-ink-muted">No scans in the last 30 days.</p>;
  }
  return (
    <div className="h-64 w-full" role="img" aria-label={`Scans per day over the last 30 days, ${total} in total`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-line" />
          <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }} minTickGap={24} stroke="currentColor" className="text-ink-muted" />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="currentColor" className="text-ink-muted" />
          <Tooltip formatter={(v) => [String(v), "Scans"]} labelFormatter={(l) => String(l)} />
          <Line type="monotone" dataKey="count" stroke="#4f46e5" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
