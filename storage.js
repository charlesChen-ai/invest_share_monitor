(function initLedgerStorage(global) {
  const STORAGE_KEY = "equity_fund_local_v3";

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

  function normalizeMember(raw, index = 0) {
    const source = raw && typeof raw === "object" ? raw : {};
    const id = String(source.id || source.memberId || `member-${index + 1}`).trim() || `member-${index + 1}`;
    const name = String(source.name || "").trim() || `成员${index + 1}`;
    return { id, name };
  }

  function normalizeSubscription(raw, members = []) {
    const source = raw && typeof raw === "object" ? raw : {};
    const memberId = String(source.memberId || "").trim();
    const validMemberId = members.some((member) => member.id === memberId) ? memberId : members[0]?.id || "";
    return {
      id: String(source.id || uid()),
      memberId: validMemberId,
      amount: Math.max(0, number(source.amount)),
      shares: Math.max(0, number(source.shares)),
      navAtSubscription: Math.max(0, number(source.navAtSubscription)),
      at: source.at || new Date().toISOString(),
      note: String(source.note || "").trim(),
    };
  }

  function normalizeWithdrawal(raw, members = []) {
    const source = raw && typeof raw === "object" ? raw : {};
    const memberId = String(source.memberId || "").trim();
    const validMemberId = members.some((member) => member.id === memberId) ? memberId : members[0]?.id || "";
    return {
      id: String(source.id || uid()),
      memberId: validMemberId,
      amount: Math.max(0, number(source.amount)),
      shares: Math.max(0, number(source.shares)),
      navAtWithdrawal: Math.max(0, number(source.navAtWithdrawal)),
      at: source.at || new Date().toISOString(),
      note: String(source.note || "").trim(),
    };
  }

  function normalizeTrade(raw, members = []) {
    const source = raw && typeof raw === "object" ? raw : {};
    const code = String(source.code || "").trim().toUpperCase();
    const type = source.type === "sell" ? "sell" : "buy";
    const sourceMemberId = String(source.sourceMemberId || "").trim();
    const validSourceMemberId =
      sourceMemberId === "pool" || members.some((member) => member.id === sourceMemberId) ? sourceMemberId : "pool";

    return {
      id: String(source.id || uid()),
      type,
      code,
      name: String(source.name || "").trim(),
      price: Math.max(0, number(source.price)),
      quantity: Math.max(0, number(source.quantity)),
      sourceMemberId: validSourceMemberId,
      at: source.at || new Date().toISOString(),
      note: String(source.note || "").trim(),
    };
  }

  function normalizeNote(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      id: String(source.id || uid()),
      at: source.at || new Date().toISOString(),
      text: String(source.text || "").trim(),
    };
  }

  function normalizeLog(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      id: String(source.id || uid()),
      at: source.at || new Date().toISOString(),
      type: String(source.type || "操作").trim() || "操作",
      detail: String(source.detail || "").trim(),
    };
  }

  function normalizePriceMap(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const output = {};
    Object.keys(source).forEach((key) => {
      const code = String(key || "").trim().toUpperCase();
      if (!code) return;
      const price = number(source[key]);
      if (price > 0) output[code] = price;
    });
    return output;
  }

  function normalizeOverviewSeries(raw) {
    const source = Array.isArray(raw) ? raw : [];
    return source
      .map((item) => {
        const row = item && typeof item === "object" ? item : {};
        const at = String(row.at || "").trim() || new Date().toISOString();
        return {
          at,
          totalAsset: number(row.totalAsset),
          nav: Math.max(0, number(row.nav)),
          totalProfit: number(row.totalProfit),
        };
      })
      .filter((row) => !Number.isNaN(new Date(row.at).getTime()))
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
      .slice(-1200);
  }

  function createEmptyState() {
    return {
      schemaVersion: 1,
      members: [],
      subscriptions: [],
      withdrawals: [],
      trades: [],
      prices: {},
      notes: [],
      logs: [],
      dailyBaselines: {},
      overviewSeries: [],
      updatedAt: new Date().toISOString(),
    };
  }

  function normalizeDailyBaselines(raw, members) {
    const source = raw && typeof raw === "object" ? raw : {};
    const output = {};

    Object.keys(source).forEach((dateKey) => {
      const base = source[dateKey] && typeof source[dateKey] === "object" ? source[dateKey] : {};
      const memberAssets = {};
      const memberInvested = {};

      members.forEach((member) => {
        const id = member.id;
        memberAssets[id] = number(base.memberAssets?.[id]);
        memberInvested[id] = number(base.memberInvested?.[id]);
      });

      output[dateKey] = {
        at: base.at || new Date().toISOString(),
        totalAsset: number(base.totalAsset),
        memberAssets,
        memberInvested,
      };
    });

    return output;
  }

  function normalizeState(raw) {
    const defaults = createEmptyState();
    const source = raw && typeof raw === "object" ? raw : {};

    const membersRaw = Array.isArray(source.members) ? source.members : [];
    const members = membersRaw.map((member, index) => normalizeMember(member, index));
    const uniqueMembers = [];
    const seenIds = new Set();
    members.forEach((member) => {
      if (seenIds.has(member.id)) return;
      seenIds.add(member.id);
      uniqueMembers.push(member);
    });

    const subscriptions = (Array.isArray(source.subscriptions) ? source.subscriptions : [])
      .map((item) => normalizeSubscription(item, uniqueMembers))
      .filter((item) => item.memberId && item.amount > 0 && item.shares > 0)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    const withdrawals = (Array.isArray(source.withdrawals) ? source.withdrawals : [])
      .map((item) => normalizeWithdrawal(item, uniqueMembers))
      .filter((item) => item.memberId && item.amount > 0 && item.shares > 0)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    const trades = (Array.isArray(source.trades) ? source.trades : [])
      .map((item) => normalizeTrade(item, uniqueMembers))
      .filter((item) => item.code && item.price > 0 && item.quantity > 0)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    const notes = (Array.isArray(source.notes) ? source.notes : [])
      .map((item) => normalizeNote(item))
      .filter((item) => item.text)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 500);

    const logs = (Array.isArray(source.logs) ? source.logs : [])
      .map((item) => normalizeLog(item))
      .filter((item) => item.detail)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 800);

    const prices = normalizePriceMap(source.prices);
    const dailyBaselines = normalizeDailyBaselines(source.dailyBaselines, uniqueMembers);
    const overviewSeries = normalizeOverviewSeries(source.overviewSeries);

    return {
      ...defaults,
      schemaVersion: 1,
      members: uniqueMembers,
      subscriptions,
      withdrawals,
      trades,
      prices,
      notes,
      logs,
      dailyBaselines,
      overviewSeries,
      updatedAt: source.updatedAt || defaults.updatedAt,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createEmptyState();
      const parsed = JSON.parse(raw);
      return normalizeState(parsed);
    } catch {
      return createEmptyState();
    }
  }

  function saveState(state) {
    try {
      const normalized = normalizeState(state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    } catch {
      return normalizeState(state);
    }
  }

  function addLog(state, { type = "操作", detail = "", at = null } = {}) {
    const text = String(detail || "").trim();
    if (!text) return;
    const log = {
      id: uid(),
      at: at || new Date().toISOString(),
      type: String(type || "操作").trim() || "操作",
      detail: text,
    };
    if (!Array.isArray(state.logs)) state.logs = [];
    state.logs.unshift(log);
    if (state.logs.length > 800) state.logs = state.logs.slice(0, 800);
  }

  global.LedgerStorage = {
    STORAGE_KEY,
    uid,
    number,
    dateKeyOf,
    createEmptyState,
    normalizeState,
    loadState,
    saveState,
    addLog,
  };
})(window);
