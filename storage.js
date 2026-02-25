(function initLedgerStorage(global) {
  const STORAGE_KEY = "equity_ledger_rmb_v2";
  const MAX_LOG_ENTRIES = 300;
  const MAX_SNAPSHOTS = 480;

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
        { name: "曾", principal: 31573 },
        { name: "陈", principal: 145182 },
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

      const merged = {
        ...defaults,
        ...parsed,
        members: normalizeMembers(parsed.members, defaults.members),
        holdings: Array.isArray(parsed.holdings) ? parsed.holdings.map((h) => normalizeHolding(h)) : defaults.holdings,
        logs: Array.isArray(parsed.logs) ? parsed.logs : defaults.logs,
        dailyBaselines:
          parsed.dailyBaselines && typeof parsed.dailyBaselines === "object"
            ? parsed.dailyBaselines
            : defaults.dailyBaselines,
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      };

      if (!merged.snapshots.length) {
        merged.snapshots = [toSnapshotPoint(merged, merged.updatedAt || new Date().toISOString())];
      }

      const latestSnapshot = merged.snapshots[merged.snapshots.length - 1];
      if (number(merged.currentTotalAsset) <= 0 && latestSnapshot && number(latestSnapshot.totalAsset) > 0) {
        merged.currentTotalAsset = number(latestSnapshot.totalAsset);
      }

      return merged;
    } catch {
      return createDefaultState();
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
    saveState,
    addLog,
    ensureTodayBaseline,
    pushSnapshot,
  };
})(window);
