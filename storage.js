(function initLedgerStorage(global) {
  const STORAGE_KEY = "equity_ledger_rmb_v2";
  const MAX_LOG_ENTRIES = 300;
  const MAX_SNAPSHOTS = 480;
  const DEFAULT_STATE_ROW_ID = "shared-ledger";
  const CLOUD_TABLE = "ledger_states";

  const HOLDING_TYPES = new Set(["stock", "fund"]);
  const HOLDING_OWNERS = new Set(["proportional", "memberA", "memberB"]);

  function uid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function dateKeyOf(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function normalizeHolding(raw = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    const assetType = HOLDING_TYPES.has(source.assetType) ? source.assetType : "stock";
    const owner = HOLDING_OWNERS.has(source.owner) ? source.owner : "proportional";

    return {
      id: source.id || uid(),
      assetType,
      owner,
      code: source.code || "",
      name: source.name || "",
      quantity: number(source.quantity),
      avgCost: number(source.avgCost),
      currentPrice: number(source.currentPrice),
    };
  }

  function normalizeMembers(rawMembers, defaultMembers) {
    if (!Array.isArray(rawMembers) || rawMembers.length !== 2) return defaultMembers;

    return rawMembers.map((member, index) => {
      const fallback = defaultMembers[index] || { name: `成员${index === 0 ? "A" : "B"}`, principal: 0 };
      const safeMember = member && typeof member === "object" ? member : {};
      const name = String(safeMember.name || "").trim() || fallback.name;
      const principal = number(safeMember.principal);
      return { name, principal };
    });
  }

  function cloudConfig() {
    const raw = global.LEDGER_CONFIG && typeof global.LEDGER_CONFIG === "object" ? global.LEDGER_CONFIG : {};
    const supabaseUrl = String(raw.supabaseUrl || "").trim().replace(/\/+$/, "");
    const supabaseAnonKey = String(raw.supabaseAnonKey || "").trim();
    const stateRowId = String(raw.stateRowId || DEFAULT_STATE_ROW_ID).trim() || DEFAULT_STATE_ROW_ID;
    return { supabaseUrl, supabaseAnonKey, stateRowId };
  }

  function isCloudEnabled() {
    const cfg = cloudConfig();
    return Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
  }

  function normalizeLoadedState(parsed, defaults) {
    const source = parsed && typeof parsed === "object" ? parsed : {};
    const merged = {
      ...defaults,
      ...source,
      members: normalizeMembers(source.members, defaults.members),
      holdings: Array.isArray(source.holdings) ? source.holdings.map((h) => normalizeHolding(h)) : defaults.holdings,
      logs: Array.isArray(source.logs) ? source.logs : defaults.logs,
      dailyBaselines:
        source.dailyBaselines && typeof source.dailyBaselines === "object"
          ? source.dailyBaselines
          : defaults.dailyBaselines,
      snapshots: Array.isArray(source.snapshots) ? source.snapshots : [],
    };

    if (!merged.snapshots.length) {
      merged.snapshots = [toSnapshotPoint(merged, merged.updatedAt || new Date().toISOString())];
    }

    const latestSnapshot = merged.snapshots[merged.snapshots.length - 1];
    if (number(merged.currentTotalAsset) <= 0 && latestSnapshot && number(latestSnapshot.totalAsset) > 0) {
      merged.currentTotalAsset = number(latestSnapshot.totalAsset);
    }

    return merged;
  }

  function toSnapshotPoint(state, at = new Date().toISOString()) {
    const principalA = number(state.members?.[0]?.principal);
    const principalB = number(state.members?.[1]?.principal);
    const totalPrincipal = principalA + principalB;
    const totalAsset = number(state.currentTotalAsset);
    const netValue = totalPrincipal > 0 ? totalAsset / totalPrincipal : 0;

    return {
      at,
      totalAsset,
      assetA: netValue * principalA,
      assetB: netValue * principalB,
    };
  }

  function createDefaultState() {
    const now = new Date().toISOString();
    const initialTotalAsset = 176754.95;
    const initialAssetA = 31573;
    const initialAssetB = 145182;

    return {
      members: [
        { name: "成员一", principal: 31573 },
        { name: "成员二", principal: 145182 },
      ],
      currentTotalAsset: initialTotalAsset,
      cashAmount: 4122.55,
      updatedAt: now,
      holdings: [
        {
          id: uid(),
          assetType: "stock",
          owner: "proportional",
          code: "300807",
          name: "天迈科技",
          quantity: 3100,
          avgCost: 52.598,
          currentPrice: 55.1,
        },
      ],
      logs: [
        {
          id: uid(),
          at: now,
          type: "初始化",
          detail: "账本已创建",
        },
      ],
      dailyBaselines: {},
      snapshots: [
        {
          at: now,
          totalAsset: initialTotalAsset,
          assetA: initialAssetA,
          assetB: initialAssetB,
        },
      ],
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultState();

      const parsed = JSON.parse(raw);
      const defaults = createDefaultState();
      return normalizeLoadedState(parsed, defaults);
    } catch {
      return createDefaultState();
    }
  }

  async function loadCloudState() {
    if (!isCloudEnabled()) return null;
    if (typeof fetch !== "function") return null;

    const { supabaseUrl, supabaseAnonKey, stateRowId } = cloudConfig();
    const query = `id=eq.${encodeURIComponent(stateRowId)}&select=payload&limit=1`;
    const url = `${supabaseUrl}/rest/v1/${CLOUD_TABLE}?${query}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
        },
      });

      if (!response.ok) {
        console.warn("读取云端账本失败。", response.status);
        return null;
      }

      const rows = await response.json();
      const payload = Array.isArray(rows) && rows[0] ? rows[0].payload : null;
      if (!payload || typeof payload !== "object") return null;

      return normalizeLoadedState(payload, createDefaultState());
    } catch (error) {
      console.warn("读取云端账本异常。", error);
      return null;
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      console.warn("保存账本数据失败，已继续使用内存数据。", error);
      return false;
    }
  }

  async function saveCloudState(state) {
    if (!isCloudEnabled()) return false;
    if (typeof fetch !== "function") return false;

    const { supabaseUrl, supabaseAnonKey, stateRowId } = cloudConfig();
    const url = `${supabaseUrl}/rest/v1/${CLOUD_TABLE}`;
    const now = new Date().toISOString();
    const payload = [{ id: stateRowId, payload: state, updated_at: now }];

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        console.warn("写入云端账本失败。", response.status, text);
        return false;
      }

      return true;
    } catch (error) {
      console.warn("写入云端账本异常。", error);
      return false;
    }
  }

  function addLog(state, { type, detail, at }) {
    state.logs = [
      {
        id: uid(),
        at: at || new Date().toISOString(),
        type,
        detail,
      },
      ...(state.logs || []),
    ].slice(0, MAX_LOG_ENTRIES);
  }

  function ensureTodayBaseline(state) {
    if (!state.dailyBaselines || typeof state.dailyBaselines !== "object") {
      state.dailyBaselines = {};
    }

    const key = dateKeyOf();
    if (state.dailyBaselines[key]) return false;

    state.dailyBaselines[key] = toSnapshotPoint(state);
    return true;
  }

  function pushSnapshot(state, { force = false } = {}) {
    if (!Array.isArray(state.snapshots)) {
      state.snapshots = [];
    }

    const now = new Date().toISOString();
    const next = toSnapshotPoint(state, now);
    const last = state.snapshots[state.snapshots.length - 1];

    if (last) {
      const sameValue =
        Math.abs(number(last.totalAsset) - next.totalAsset) < 0.01 &&
        Math.abs(number(last.assetA) - next.assetA) < 0.01 &&
        Math.abs(number(last.assetB) - next.assetB) < 0.01;
      const timeDelta = Math.abs(new Date(now).getTime() - new Date(last.at).getTime());

      if (!force && sameValue && timeDelta < 5 * 60 * 1000) {
        return false;
      }
    }

    state.snapshots.push(next);
    if (state.snapshots.length > MAX_SNAPSHOTS) {
      state.snapshots.splice(0, state.snapshots.length - MAX_SNAPSHOTS);
    }

    return true;
  }

  global.LedgerStorage = {
    uid,
    number,
    dateKeyOf,
    normalizeHolding,
    createDefaultState,
    loadState,
    loadCloudState,
    saveState,
    saveCloudState,
    addLog,
    ensureTodayBaseline,
    pushSnapshot,
    isCloudEnabled,
  };
})(window);
