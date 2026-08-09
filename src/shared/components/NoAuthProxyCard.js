"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
  { value: "weighted", label: "Weighted (health)" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [modelOverridesText, setModelOverridesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
      setModelOverridesText(
        Object.entries(override.modelPoolOverrides || {})
          .map(([m, p]) => `${m}:${p}`)
          .join("\n")
      );
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const parseModelOverrides = (text) => {
    const out = {};
    text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
      const idx = line.indexOf(":");
      if (idx <= 0) return;
      const model = line.slice(0, idx).trim();
      const pool = line.slice(idx + 1).trim();
      if (model && pool) out[model] = pool;
    });
    return out;
  };

  const save = useCallback(async (poolId, strategy, overridesText = modelOverridesText) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      const parsed = parseModelOverrides(overridesText);
      if (Object.keys(parsed).length === 0) delete override.modelPoolOverrides;
      else override.modelPoolOverrides = parsed;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId, modelOverridesText]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={isRotation ? "Pool selector is ignored when rotation is active — all active pools are used." : undefined}
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through all ${proxyPools.length} active pools in order. State is in-memory (resets on restart).`
                : rotateStrategy === "weighted"
                  ? `Picking a pool weighted by health score (success rate + latency) from ${proxyPools.length} active pools.`
                  : `Picking a random pool from ${proxyPools.length} active pools each request.`
              : `Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.`}
        </p>
      </div>

      <div className="mt-4">
        <label className="text-sm font-medium text-text-main block mb-1">Model → Pool overrides</label>
        <textarea
          value={modelOverridesText}
          onChange={(e) => setModelOverridesText(e.target.value)}
          onBlur={() => save(proxyPoolId, rotateStrategy)}
          placeholder={"gpt-4o:pool-id-1\nclaude-3-5-sonnet:pool-id-2"}
          disabled={saving}
          className="w-full min-h-[70px] px-3 py-2 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        />
        <p className="text-xs text-text-muted mt-1">
          Format: <code>modelName:poolId</code> per line (pool id from the Proxy Pools page). Applies only to requests with that exact model. Saves on blur.
        </p>
      </div>
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
