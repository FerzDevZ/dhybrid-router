"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;
const fmtMs = (n) => (n ? `${fmt(n)}ms` : "—");
const fmtRate = (n) => `${((n || 0) * 100).toFixed(2)}%`;

export default function OverviewCards({ stats }) {
  const latency = stats.latency || {};
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-7 sm:gap-4">
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Requests</span>
        <span className="truncate text-2xl font-bold">{fmt(stats.totalRequests)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Input Tokens</span>
        <span className="truncate text-2xl font-bold text-primary">{fmt(stats.totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Cached Tokens</span>
        <span className="truncate text-2xl font-bold text-info">{fmt(stats.totalCachedTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Output Tokens</span>
        <span className="truncate text-2xl font-bold text-success">{fmt(stats.totalCompletionTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Est. Cost</span>
        <span className="truncate text-2xl font-bold text-warning">~{fmtCost(stats.totalCost)}</span>
        <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Latency p50 / p99</span>
        <span className="truncate text-2xl font-bold text-info">{fmtMs(latency.p50)} / {fmtMs(latency.p99)}</span>
        <span className="text-[10px] text-text-muted">{latency.samples ? `${fmt(latency.samples)} samples` : "No latency data yet"}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Error Rate</span>
        <span className={`truncate text-2xl font-bold ${(stats.errorRate || 0) > 0.05 ? "text-error" : "text-success"}`}>{fmtRate(stats.errorRate)}</span>
        <span className="text-[10px] text-text-muted">{fmt(stats.errorCount)} failed requests</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
