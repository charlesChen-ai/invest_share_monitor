function createFallbackLedgerStorage() {
  const STORAGE_KEY = "equity_ledger_rmb_v2";

  const uid = () =>
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const dateKeyOf = (date = new Date()) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };

  const normalizeHolding = (raw = {}) => ({
    id: raw.id || uid(),
    assetType: raw.assetType === "fund" ? "fund" : "stock",
    owner: raw.owner === "memberA" || raw.owner === "memberB" ? raw.owner : "proportional",
    code: raw.code || "",
    name: raw.name || "",
    quantity: number(raw.quantity),
    avgCost: number(raw.avgCost),
    currentPrice: number(raw.currentPrice),
  });

  const normalizeMembers = (rawMembers, defaultMembers) => {
    if (!Array.isArray(rawMembers) || rawMembers.length !== 2) return defaultMembers;

    return rawMembers.map((member, index) => {
      const fallback = defaultMembers[index] || { name: `成员${index === 0 ? "A" : "B"}`, principal: 0 };
      const safeMember = member && typeof member === "object" ? member : {};
      const name = String(safeMember.name || "").trim() || fallback.name;
      const principal = number(safeMember.principal);
      return { name, principal };
    });
  };

  const createDefaultState = () => {
    const now = new Date().toISOString();
    return {
      members: [
        { name: "成员一", principal: 31573 },
        { name: "成员二", principal: 145182 },
      ],
      currentTotalAsset: 176754.95,
      cashAmount: 4122.55,
      updatedAt: now,
      holdings: [
        normalizeHolding({
          code: "300807",
          name: "天迈科技",
          quantity: 3100,
          avgCost: 52.598,
          currentPrice: 55.1,
        }),
      ],
      logs: [{ id: uid(), at: now, type: "初始化", detail: "账本已创建" }],
      dailyBaselines: {},
      snapshots: [{ at: now, totalAsset: 176754.95, assetA: 31573, assetB: 145182 }],
    };
  };

  const loadState = () => {
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
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : defaults.snapshots,
      };

      const latestSnapshot = merged.snapshots[merged.snapshots.length - 1];
      if (number(merged.currentTotalAsset) <= 0 && latestSnapshot && number(latestSnapshot.totalAsset) > 0) {
        merged.currentTotalAsset = number(latestSnapshot.totalAsset);
      }

      return merged;
    } catch {
      return createDefaultState();
    }
  };

  const saveState = (state) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore fallback save errors
    }
  };

  const loadCloudState = async () => null;
  const saveCloudState = async () => false;
  const isCloudEnabled = () => false;

  const addLog = (state, { type, detail, at }) => {
    state.logs = [
      { id: uid(), at: at || new Date().toISOString(), type, detail },
      ...(state.logs || []),
    ].slice(0, 300);
  };

  const snapshotOf = (state) => {
    const principalA = number(state.members?.[0]?.principal);
    const principalB = number(state.members?.[1]?.principal);
    const totalPrincipal = principalA + principalB;
    const totalAsset = number(state.currentTotalAsset);
    const netValue = totalPrincipal > 0 ? totalAsset / totalPrincipal : 0;
    return {
      at: new Date().toISOString(),
      totalAsset,
      assetA: netValue * principalA,
      assetB: netValue * principalB,
    };
  };

  const ensureTodayBaseline = (state) => {
    if (!state.dailyBaselines || typeof state.dailyBaselines !== "object") state.dailyBaselines = {};
    const key = dateKeyOf();
    if (state.dailyBaselines[key]) return false;
    state.dailyBaselines[key] = snapshotOf(state);
    return true;
  };

  const pushSnapshot = (state, { force = false } = {}) => {
    if (!Array.isArray(state.snapshots)) state.snapshots = [];
    const next = snapshotOf(state);
    const last = state.snapshots[state.snapshots.length - 1];
    if (last) {
      const sameValue =
        Math.abs(number(last.totalAsset) - next.totalAsset) < 0.01 &&
        Math.abs(number(last.assetA) - next.assetA) < 0.01 &&
        Math.abs(number(last.assetB) - next.assetB) < 0.01;
      const timeDelta = Math.abs(new Date(next.at).getTime() - new Date(last.at).getTime());
      if (!force && sameValue && timeDelta < 5 * 60 * 1000) return false;
    }
    state.snapshots.push(next);
    if (state.snapshots.length > 480) {
      state.snapshots.splice(0, state.snapshots.length - 480);
    }
    return true;
  };

  return {
    uid,
    number,
    dateKeyOf,
    normalizeHolding,
    loadState,
    loadCloudState,
    saveState,
    saveCloudState,
    addLog,
    ensureTodayBaseline,
    pushSnapshot,
    isCloudEnabled,
  };
}

const REQUIRED_STORAGE_APIS = [
  "uid",
  "number",
  "dateKeyOf",
  "normalizeHolding",
  "loadState",
  "saveState",
  "addLog",
  "ensureTodayBaseline",
  "pushSnapshot",
];

const hasValidStorageApi =
  window.LedgerStorage &&
  REQUIRED_STORAGE_APIS.every((name) => typeof window.LedgerStorage[name] === "function");

if (!hasValidStorageApi) {
  console.warn("storage.js 未加载，使用 app.js 内置回退存储逻辑。");
  window.LedgerStorage = createFallbackLedgerStorage();
}

const {
  uid,
  number,
  dateKeyOf,
  normalizeHolding,
  loadState,
  loadCloudState = async () => null,
  saveState,
  saveCloudState = async () => false,
  addLog,
  ensureTodayBaseline,
  pushSnapshot,
  isCloudEnabled = () => false,
} = window.LedgerStorage;

function round(value, precision = 4) {
  const factor = 10 ** precision;
  return Math.round(number(value) * factor) / factor;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 2,
  }).format(number(value));
}

function formatUnits(value) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 3,
  }).format(number(value));
}

function formatDate(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value;
}

function setPositiveNegative(el, value) {
  if (!el) return;
  el.classList.toggle("positive", value >= 0);
  el.classList.toggle("negative", value < 0);
}

function assetTypeText(type) {
  return type === "fund" ? "基金" : "股票";
}

function ownerText(owner, memberAName = "成员一", memberBName = "成员二") {
  if (owner === "memberA") return memberAName;
  if (owner === "memberB") return memberBName;
  return "按本金比例";
}

function toTencentSymbol(rawCode) {
  const code = (rawCode || "").trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(code)) return code;

  const match = code.match(/(\d{6})/);
  if (!match) return null;

  const digits = match[1];
  if (/^[659]/.test(digits)) return `sh${digits}`;
  if (/^[03]/.test(digits)) return `sz${digits}`;
  if (/^[48]/.test(digits)) return `bj${digits}`;
  return null;
}

function parseTencentQuote(raw, symbol) {
  if (typeof raw !== "string" || !raw.includes("~")) {
    throw new Error("行情返回格式异常");
  }

  const body = raw.replace(/^"|"$/g, "");
  const parts = body.split("~");
  const name = (parts[1] || "").trim();
  const code = (parts[2] || symbol.replace(/^[a-z]+/i, "")).trim();
  const price = Number(parts[3]);

  if (!Number.isFinite(price)) throw new Error("行情价格无效");

  return { name, code, price };
}

function fetchTencentQuote(symbol) {
  return new Promise((resolve, reject) => {
    const variableName = `v_${symbol}`;
    const script = document.createElement("script");
    let timeoutId;

    function cleanup() {
      script.onerror = null;
      script.onload = null;
      script.remove();
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("行情请求超时"));
    }, 8000);

    script.src = `https://qt.gtimg.cn/q=${symbol}&_=${Date.now()}`;
    script.charset = "gbk";
    delete window[variableName];

    script.onload = () => {
      const payload = window[variableName];
      cleanup();

      if (!payload) {
        reject(new Error("未收到行情数据"));
        return;
      }

      try {
        resolve(parseTencentQuote(payload, symbol));
      } catch (error) {
        reject(error);
      }
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("行情请求失败"));
    };

    document.head.appendChild(script);
  });
}

function computeSummary(state) {
  const members = Array.isArray(state.members) ? state.members : [];
  const memberA = members[0] || { name: "成员一", principal: 0 };
  const memberB = members[1] || { name: "成员二", principal: 0 };

  const memberAName = String(memberA.name || "").trim() || "成员一";
  const memberBName = String(memberB.name || "").trim() || "成员二";
  const principalA = number(memberA.principal);
  const principalB = number(memberB.principal);
  const totalPrincipal = principalA + principalB;
  const rawStockSnapshotAsset = number(state.currentTotalAsset);

  const principalRatioA = totalPrincipal > 0 ? principalA / totalPrincipal : 0;
  const principalRatioB = totalPrincipal > 0 ? principalB / totalPrincipal : 0;

  const holdingsSource = Array.isArray(state.holdings) ? state.holdings : [];
  const holdingsWithCalc = holdingsSource.map((raw) => {
    const h = normalizeHolding(raw);
    const quantity = number(h.quantity);
    const avgCost = number(h.avgCost);
    const currentPrice = number(h.currentPrice);
    const marketValue = quantity * currentPrice;
    const costValue = quantity * avgCost;
    const ownerShareA = h.owner === "memberA" ? 1 : h.owner === "memberB" ? 0 : principalRatioA;
    const ownerShareB = h.owner === "memberB" ? 1 : h.owner === "memberA" ? 0 : principalRatioB;

    return {
      ...h,
      quantity,
      avgCost,
      currentPrice,
      marketValue,
      costValue,
      pnl: marketValue - costValue,
      ownerShareA,
      ownerShareB,
      ownerAssetA: marketValue * ownerShareA,
      ownerAssetB: marketValue * ownerShareB,
    };
  });

  const holdingMarketValueTotal = holdingsWithCalc.reduce((sum, h) => sum + h.marketValue, 0);
  const cashAmount = number(state.cashAmount);
  const stockRows = holdingsWithCalc.filter((h) => h.assetType === "stock");
  const fundRows = holdingsWithCalc.filter((h) => h.assetType === "fund");
  const stockHoldingCount = stockRows.length;
  const fundHoldingCount = fundRows.length;
  const stockMarketValueTotal = stockRows.reduce((sum, h) => sum + h.marketValue, 0);
  const fundMarketValueTotal = fundRows.reduce((sum, h) => sum + h.marketValue, 0);
  const stockCostTotal = stockRows.reduce((sum, h) => sum + h.costValue, 0);
  const fundCostTotal = fundRows.reduce((sum, h) => sum + h.costValue, 0);
  const stockHoldingPnlTotal = stockRows.reduce((sum, h) => sum + h.pnl, 0);
  const fundHoldingPnlTotal = fundRows.reduce((sum, h) => sum + h.pnl, 0);
  const stockEstimatedTotal = stockMarketValueTotal + cashAmount;
  const stockSnapshotAsset = rawStockSnapshotAsset > 0 ? rawStockSnapshotAsset : stockEstimatedTotal;
  const currentTotalAsset = stockSnapshotAsset + fundMarketValueTotal;
  const estimatedTotal = holdingMarketValueTotal + cashAmount;
  const gap = currentTotalAsset - estimatedTotal;
  const netValue = totalPrincipal > 0 ? stockSnapshotAsset / totalPrincipal : 0;
  const assetA = netValue * principalA;
  const assetB = netValue * principalB;
  const profitA = assetA - principalA;
  const profitB = assetB - principalB;
  const assignedAssetAStock = stockRows.reduce((sum, h) => sum + h.ownerAssetA, 0);
  const assignedAssetAFund = fundRows.reduce((sum, h) => sum + h.ownerAssetA, 0);
  const assignedAssetBStock = stockRows.reduce((sum, h) => sum + h.ownerAssetB, 0);
  const assignedAssetBFund = fundRows.reduce((sum, h) => sum + h.ownerAssetB, 0);
  const assignedProfitAStock = stockRows.reduce((sum, h) => sum + h.pnl * h.ownerShareA, 0);
  const assignedProfitAFund = fundRows.reduce((sum, h) => sum + h.pnl * h.ownerShareA, 0);
  const assignedProfitBStock = stockRows.reduce((sum, h) => sum + h.pnl * h.ownerShareB, 0);
  const assignedProfitBFund = fundRows.reduce((sum, h) => sum + h.pnl * h.ownerShareB, 0);
  const assignedAssetA = assignedAssetAStock + assignedAssetAFund;
  const assignedAssetB = assignedAssetBStock + assignedAssetBFund;
  const assignedAssetTotal = assignedAssetA + assignedAssetB;
  const allocationResidualAsset = currentTotalAsset - assignedAssetTotal;
  const displayAssetA = assignedAssetA + allocationResidualAsset * principalRatioA;
  const displayAssetB = assignedAssetB + allocationResidualAsset * principalRatioB;
  const memberTotalProfitA = assignedProfitAStock + assignedProfitAFund;
  const memberTotalProfitB = assignedProfitBStock + assignedProfitBFund;
  const stockTotalProfit = stockHoldingPnlTotal;
  const fundTotalProfit = fundHoldingPnlTotal;
  const totalProfit = stockTotalProfit + fundTotalProfit;
  const stockGap = stockSnapshotAsset - stockEstimatedTotal;

  return {
    memberAName,
    memberBName,
    principalA,
    principalB,
    totalPrincipal,
    currentTotalAsset,
    netValue,
    assetA,
    assetB,
    profitA,
    profitB,
    holdingsWithCalc,
    holdingMarketValueTotal,
    estimatedTotal,
    gap,
    stockHoldingCount,
    fundHoldingCount,
    stockSnapshotAsset,
    stockEstimatedTotal,
    stockGap,
    stockMarketValueTotal,
    fundMarketValueTotal,
    stockCostTotal,
    fundCostTotal,
    stockHoldingPnlTotal,
    fundHoldingPnlTotal,
    stockTotalProfit,
    fundTotalProfit,
    totalProfit,
    principalRatioA,
    principalRatioB,
    assignedAssetAStock,
    assignedAssetAFund,
    assignedAssetBStock,
    assignedAssetBFund,
    assignedProfitAStock,
    assignedProfitAFund,
    assignedProfitBStock,
    assignedProfitBFund,
    assignedAssetA,
    assignedAssetB,
    assignedAssetTotal,
    allocationResidualAsset,
    displayAssetA,
    displayAssetB,
    memberTotalProfitA,
    memberTotalProfitB,
  };
}

function getTodayProfitBaseline(state, summary) {
  if (!state.dailyBaselines || typeof state.dailyBaselines !== "object") {
    state.dailyBaselines = {};
  }

  const key = dateKeyOf();
  const baseline = state.dailyBaselines[key] && typeof state.dailyBaselines[key] === "object" ? state.dailyBaselines[key] : {};
  let changed = !state.dailyBaselines[key];

  const ensureNumericField = (field, value, precision = 4) => {
    const raw = baseline[field];
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return;
    baseline[field] = round(value, precision);
    changed = true;
  };

  ensureNumericField("totalProfit", summary.totalProfit, 4);
  ensureNumericField("memberTotalProfitA", summary.memberTotalProfitA, 4);
  ensureNumericField("memberTotalProfitB", summary.memberTotalProfitB, 4);
  const profitBaseAsset = summary.stockCostTotal + summary.fundCostTotal;
  ensureNumericField("profitBaseAsset", profitBaseAsset > 0 ? profitBaseAsset : summary.holdingMarketValueTotal, 2);

  if (changed) {
    state.dailyBaselines[key] = baseline;
    persistState(state);
  }

  return baseline;
}

function renderHistory(bodyId, logs) {
  const body = byId(bodyId);
  if (!body) return;

  body.innerHTML = "";
  if (!logs.length) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>--</td><td>--</td><td>暂无历史记录</td>";
    body.appendChild(row);
    return;
  }

  logs.forEach((log) => {
    const row = document.createElement("tr");
    const timeCell = document.createElement("td");
    const typeCell = document.createElement("td");
    const detailCell = document.createElement("td");

    timeCell.textContent = formatDate(log.at);
    typeCell.textContent = log.type || "操作";
    detailCell.textContent = log.detail || "";

    row.appendChild(timeCell);
    row.appendChild(typeCell);
    row.appendChild(detailCell);
    body.appendChild(row);
  });
}

function initCalcToggles() {
  document.querySelectorAll(".calc-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const formulaId = button.dataset.formulaId;
      if (!formulaId) return;
      const formula = byId(formulaId);
      if (!formula) return;

      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", expanded ? "false" : "true");
      formula.classList.toggle("open", !expanded);
    });
  });
}

function renderDashboardHoldings(rows, memberAName, memberBName) {
  const body = byId("dashboard-holdings-body");
  if (!body) return;

  body.innerHTML = "";

  if (!rows.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="10">暂无持仓数据</td>';
    body.appendChild(row);
    return;
  }

  rows.forEach((h) => {
    const row = document.createElement("tr");

    const cells = [
      assetTypeText(h.assetType),
      h.code || "-",
      h.name || "-",
      formatUnits(h.quantity),
      formatCurrency(h.avgCost),
      formatCurrency(h.currentPrice),
      formatCurrency(h.marketValue),
      formatCurrency(h.costValue),
      formatCurrency(h.pnl),
      ownerText(h.owner, memberAName, memberBName),
    ];

    cells.forEach((cellText, index) => {
      const td = document.createElement("td");
      td.textContent = cellText;
      if (index === 8) setPositiveNegative(td, h.pnl);
      row.appendChild(td);
    });

    body.appendChild(row);
  });
}

function renderDashboard(state) {
  if (!byId("dashboard-page")) return;

  const summary = computeSummary(state);

  setText("updated-at-text", formatDate(state.updatedAt));
  setText("current-asset", formatCurrency(summary.currentTotalAsset));
  setText(
    "current-asset-composition-hint",
    `总资产口径：股票账户快照 ${formatCurrency(summary.stockSnapshotAsset)} + 基金市值 ${formatCurrency(summary.fundMarketValueTotal)}`
  );
  setText("total-principal-hint", `总本金：${formatCurrency(summary.totalPrincipal)}`);

  const totalProfit = summary.totalProfit;
  const totalProfitBase = summary.stockCostTotal + summary.fundCostTotal;
  const totalProfitRate = totalProfitBase > 0 ? (totalProfit / totalProfitBase) * 100 : 0;
  setText("total-profit-value", formatCurrency(totalProfit));
  setText("total-profit-rate", `累计收益率：${totalProfitRate.toFixed(2)}%`);
  setText("total-profit-line", `累计收益：${formatCurrency(totalProfit)}`);
  setText(
    "total-profit-formula",
    `股票总收益 ${formatCurrency(summary.stockTotalProfit)} + 基金总收益 ${formatCurrency(summary.fundTotalProfit)} = ${formatCurrency(totalProfit)}`
  );
  setPositiveNegative(byId("total-profit-value"), totalProfit);
  setPositiveNegative(byId("total-profit-rate"), totalProfitRate);
  setPositiveNegative(byId("total-profit-line"), totalProfit);

  setText("member-a-principal-line", `${summary.memberAName}本金：${formatCurrency(summary.principalA)}`);
  setText("member-b-principal-line", `${summary.memberBName}本金：${formatCurrency(summary.principalB)}`);

  setText("net-value-line", `股票账户净值：${summary.netValue.toFixed(4)}`);
  setText(
    "net-value-formula",
    `${formatCurrency(summary.stockSnapshotAsset)} ÷ ${formatCurrency(summary.totalPrincipal)} = ${summary.netValue.toFixed(4)}`
  );

  const allocationBase = summary.displayAssetA + summary.displayAssetB;
  const allocationA = allocationBase > 0 ? (summary.displayAssetA / allocationBase) * 100 : 0;
  const allocationB = allocationBase > 0 ? (summary.displayAssetB / allocationBase) * 100 : 0;
  const allocationAFormula =
    allocationBase > 0
      ? `${formatCurrency(summary.displayAssetA)} ÷ ${formatCurrency(allocationBase)} = ${allocationA.toFixed(2)}%`
      : "当前可分配资产为 0，占比按 0.00% 处理";
  const allocationBFormula =
    allocationBase > 0
      ? `${formatCurrency(summary.displayAssetB)} ÷ ${formatCurrency(allocationBase)} = ${allocationB.toFixed(2)}%`
      : "当前可分配资产为 0，占比按 0.00% 处理";
  setText("member-a-asset-line", `${summary.memberAName}资产：${formatCurrency(summary.displayAssetA)} · 占比 ${allocationA.toFixed(2)}%`);
  setText(
    "member-a-asset-formula",
    `归属持仓 ${formatCurrency(summary.assignedAssetA)} + 剩余资产 ${formatCurrency(summary.allocationResidualAsset)} × 本金占比 ${(summary.principalRatioA * 100).toFixed(2)}% = ${formatCurrency(summary.displayAssetA)}；${allocationAFormula}`
  );

  setText("member-b-asset-line", `${summary.memberBName}资产：${formatCurrency(summary.displayAssetB)} · 占比 ${allocationB.toFixed(2)}%`);
  setText(
    "member-b-asset-formula",
    `归属持仓 ${formatCurrency(summary.assignedAssetB)} + 剩余资产 ${formatCurrency(summary.allocationResidualAsset)} × 本金占比 ${(summary.principalRatioB * 100).toFixed(2)}% = ${formatCurrency(summary.displayAssetB)}；${allocationBFormula}`
  );

  const allocationABar = byId("member-a-alloc-bar");
  const allocationBBar = byId("member-b-alloc-bar");
  if (allocationABar) allocationABar.style.width = `${Math.max(0, Math.min(100, allocationA)).toFixed(2)}%`;
  if (allocationBBar) allocationBBar.style.width = `${Math.max(0, Math.min(100, allocationB)).toFixed(2)}%`;

  const recordedStock = Math.max(0, summary.stockMarketValueTotal);
  const recordedFund = Math.max(0, summary.fundMarketValueTotal);
  const recordedCash = Math.max(0, number(state.cashAmount));
  const structureBase = recordedStock + recordedFund + recordedCash;
  const stockShare = structureBase > 0 ? (recordedStock / structureBase) * 100 : 0;
  const fundShare = structureBase > 0 ? (recordedFund / structureBase) * 100 : 0;
  const cashShare = structureBase > 0 ? (recordedCash / structureBase) * 100 : 0;
  setText("structure-stock-line", `股票：${formatCurrency(recordedStock)} · ${stockShare.toFixed(2)}%`);
  setText("structure-fund-line", `基金：${formatCurrency(recordedFund)} · ${fundShare.toFixed(2)}%`);
  setText("structure-cash-line", `现金：${formatCurrency(recordedCash)} · ${cashShare.toFixed(2)}%`);

  const stockBar = byId("structure-stock-bar");
  const fundBar = byId("structure-fund-bar");
  const cashBar = byId("structure-cash-bar");
  if (stockBar) stockBar.style.width = `${Math.max(0, Math.min(100, stockShare)).toFixed(2)}%`;
  if (fundBar) fundBar.style.width = `${Math.max(0, Math.min(100, fundShare)).toFixed(2)}%`;
  if (cashBar) cashBar.style.width = `${Math.max(0, Math.min(100, cashShare)).toFixed(2)}%`;

  setText("structure-profit-badge", `累计收益（持仓口径）：${formatCurrency(totalProfit)}`);
  setPositiveNegative(byId("structure-profit-badge"), totalProfit);
  setText(
    "structure-owner-badge",
    `归属资产：${summary.memberAName} ${formatCurrency(summary.assignedAssetA)} · ${summary.memberBName} ${formatCurrency(summary.assignedAssetB)}`
  );

  let netState = "净值状态：平稳";
  if (summary.netValue >= 1.2) {
    netState = "净值状态：显著上行";
  } else if (summary.netValue >= 1.05) {
    netState = "净值状态：温和上行";
  } else if (summary.netValue < 0.95) {
    netState = "净值状态：阶段回撤";
  }
  const stateBadge = byId("structure-state-badge");
  setText("structure-state-badge", netState);
  if (stateBadge) {
    stateBadge.classList.remove("positive", "negative");
    if (summary.netValue >= 1.05) stateBadge.classList.add("positive");
    if (summary.netValue < 0.95) stateBadge.classList.add("negative");
  }

  setText(
    "member-a-profit-line",
    `${summary.memberAName}收益：${formatCurrency(summary.memberTotalProfitA)}`
  );
  setText(
    "member-a-profit-formula",
    `股票收益 ${formatCurrency(summary.assignedProfitAStock)} + 基金收益 ${formatCurrency(summary.assignedProfitAFund)} = ${formatCurrency(summary.memberTotalProfitA)}`
  );

  setText(
    "member-b-profit-line",
    `${summary.memberBName}收益：${formatCurrency(summary.memberTotalProfitB)}`
  );
  setText(
    "member-b-profit-formula",
    `股票收益 ${formatCurrency(summary.assignedProfitBStock)} + 基金收益 ${formatCurrency(summary.assignedProfitBFund)} = ${formatCurrency(summary.memberTotalProfitB)}`
  );

  setPositiveNegative(byId("member-a-profit-line"), summary.memberTotalProfitA);
  setPositiveNegative(byId("member-b-profit-line"), summary.memberTotalProfitB);

  const todayBaseline = getTodayProfitBaseline(state, summary);

  const todayTotalProfit = summary.totalProfit - number(todayBaseline.totalProfit);
  const todayAProfit = summary.memberTotalProfitA - number(todayBaseline.memberTotalProfitA);
  const todayBProfit = summary.memberTotalProfitB - number(todayBaseline.memberTotalProfitB);
  const todayBaseAsset = number(todayBaseline.profitBaseAsset);
  const todayTotalProfitRate = todayBaseAsset > 0 ? (todayTotalProfit / todayBaseAsset) * 100 : 0;

  setText("today-profit-total-value", formatCurrency(todayTotalProfit));
  setText("today-profit-total-rate", `当日收益率：${todayTotalProfitRate.toFixed(2)}%`);
  setText("today-profit-a-line", `${summary.memberAName}：${formatCurrency(todayAProfit)}`);
  setText("today-profit-b-line", `${summary.memberBName}：${formatCurrency(todayBProfit)}`);
  setText("today-profit-base-line", `当日基线资产：${formatCurrency(todayBaseAsset)}`);
  setPositiveNegative(byId("today-profit-total-value"), todayTotalProfit);
  setPositiveNegative(byId("today-profit-total-rate"), todayTotalProfitRate);
  setPositiveNegative(byId("today-profit-a-line"), todayAProfit);
  setPositiveNegative(byId("today-profit-b-line"), todayBProfit);

  setText("stock-total-line", `股票市值：${formatCurrency(summary.stockMarketValueTotal)}`);
  setText("fund-total-line", `基金市值：${formatCurrency(summary.fundMarketValueTotal)}`);
  setText("cash-line", `持有现金：${formatCurrency(state.cashAmount)}`);
  setText("holding-total-line", `持仓市值合计：${formatCurrency(summary.holdingMarketValueTotal)}`);
  setText("holding-total-formula", "按各资产行：份额/股数 × 当前净值/市价，加总得到持仓市值");
  setText("estimated-total-line", `估算资产合计（持仓+现金）：${formatCurrency(summary.estimatedTotal)}`);
  setText("estimated-total-formula", `${formatCurrency(summary.holdingMarketValueTotal)} + ${formatCurrency(state.cashAmount)} = ${formatCurrency(summary.estimatedTotal)}`);
  setText(
    "owner-a-summary-line",
    `${summary.memberAName}归属资产：股票 ${formatCurrency(summary.assignedAssetAStock)} + 基金 ${formatCurrency(summary.assignedAssetAFund)} = ${formatCurrency(summary.assignedAssetA)}`
  );
  setText(
    "owner-b-summary-line",
    `${summary.memberBName}归属资产：股票 ${formatCurrency(summary.assignedAssetBStock)} + 基金 ${formatCurrency(summary.assignedAssetBFund)} = ${formatCurrency(summary.assignedAssetB)}`
  );

  setText("gap-line", `核算差额：${formatCurrency(summary.gap)}`);
  setText("gap-formula", `${formatCurrency(summary.currentTotalAsset)} - ${formatCurrency(summary.estimatedTotal)} = ${formatCurrency(summary.gap)}`);
  setPositiveNegative(byId("gap-line"), -summary.gap);

  renderProfitCurve(state, summary);
  renderDashboardHoldings(summary.holdingsWithCalc, summary.memberAName, summary.memberBName);
}

function renderProfitCurve(state, summary) {
  const curvePath = byId("profit-curve-path");
  const curveArea = byId("profit-curve-area");
  if (!curvePath || !curveArea) return;

  const rawPoints = Array.isArray(state.snapshots) ? [...state.snapshots] : [];
  if (!rawPoints.length) {
    rawPoints.push({
      at: state.updatedAt || new Date().toISOString(),
      totalAsset: summary.currentTotalAsset,
    });
  }

  const points = rawPoints
    .map((p) => ({
      at: p.at || state.updatedAt || new Date().toISOString(),
      totalAsset: number(p.totalAsset),
    }))
    .filter((p) => Number.isFinite(p.totalAsset))
    .slice(-60);

  if (!points.length) {
    curvePath.setAttribute("d", "");
    curveArea.setAttribute("d", "");
    return;
  }

  const width = 760;
  const height = 230;
  const left = 20;
  const right = 20;
  const top = 14;
  const bottom = 20;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const values = points.map((p) => p.totalAsset);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = Math.max(maxV - minV, Math.max(maxV * 0.01, 1));
  const yMin = minV - span * 0.12;
  const yMax = maxV + span * 0.12;
  const xStep = points.length > 1 ? plotW / (points.length - 1) : plotW;

  const toY = (v) => top + ((yMax - v) / (yMax - yMin)) * plotH;

  const coords = points.map((p, i) => ({
    x: left + xStep * i,
    y: toY(p.totalAsset),
    v: p.totalAsset,
  }));

  let line = "";
  coords.forEach((c, i) => {
    line += `${i === 0 ? "M" : "L"}${c.x.toFixed(2)},${c.y.toFixed(2)} `;
  });

  if (coords.length === 1) {
    line = `M${left},${coords[0].y.toFixed(2)} L${(left + plotW).toFixed(2)},${coords[0].y.toFixed(2)}`;
  }

  const lastX = coords.length === 1 ? left + plotW : coords[coords.length - 1].x;
  const firstX = coords[0].x;
  const baseY = top + plotH;
  const area = `${line} L${lastX.toFixed(2)},${baseY.toFixed(2)} L${firstX.toFixed(2)},${baseY.toFixed(2)} Z`;

  curvePath.setAttribute("d", line.trim());
  curveArea.setAttribute("d", area.trim());

  const first = points[0];
  const last = points[points.length - 1];
  const peak = points.reduce((acc, p) => (p.totalAsset > acc.totalAsset ? p : acc), points[0]);
  const trough = points.reduce((acc, p) => (p.totalAsset < acc.totalAsset ? p : acc), points[0]);

  setText("curve-start-line", `区间起点：${formatCurrency(first.totalAsset)}`);
  setText("curve-end-line", `当前值：${formatCurrency(last.totalAsset)}`);
  setText("curve-peak-line", `区间高点：${formatCurrency(peak.totalAsset)}`);
  setText("curve-trough-line", `区间低点：${formatCurrency(trough.totalAsset)}`);

  setPositiveNegative(byId("curve-end-line"), last.totalAsset - first.totalAsset);
}

function createHoldingRowTemplate(assetType = "stock") {
  return normalizeHolding({
    id: uid(),
    assetType,
    owner: "proportional",
    code: "",
    name: "",
    quantity: 0,
    avgCost: 0,
    currentPrice: 0,
  });
}

function renderEditorHoldingRows(holdings) {
  const stockBody = byId("stock-editor-body");
  const stockTemplate = byId("stock-editor-row-template");
  const fundBody = byId("fund-editor-body");
  const fundTemplate = byId("fund-editor-row-template");
  if (!stockBody || !stockTemplate || !fundBody || !fundTemplate) return;

  stockBody.innerHTML = "";
  fundBody.innerHTML = "";

  holdings.forEach((holding) => {
    const normalized = normalizeHolding(holding);
    const isFund = normalized.assetType === "fund";
    const fragment = (isFund ? fundTemplate : stockTemplate).content.cloneNode(true);
    const row = fragment.querySelector("tr");

    row.dataset.id = normalized.id || uid();
    row.dataset.assetType = normalized.assetType;
    row.querySelector('[data-field="owner"]').value = normalized.owner;
    row.querySelector('[data-field="code"]').value = normalized.code || "";
    row.querySelector('[data-field="name"]').value = normalized.name || "";
    row.querySelector('[data-field="quantity"]').value = number(normalized.quantity);
    row.querySelector('[data-field="avgCost"]').value = number(normalized.avgCost);
    row.querySelector('[data-field="currentPrice"]').value = number(normalized.currentPrice);

    (isFund ? fundBody : stockBody).appendChild(fragment);
  });

  updateEditorHoldingComputed();
}

function updateEditorHoldingComputed() {
  const rows = [...document.querySelectorAll("#stock-editor-body tr, #fund-editor-body tr")];
  rows.forEach((row) => {
    const quantity = number(row.querySelector('[data-field="quantity"]').value);
    const avgCost = number(row.querySelector('[data-field="avgCost"]').value);
    const currentPrice = number(row.querySelector('[data-field="currentPrice"]').value);

    const marketValue = quantity * currentPrice;
    const costValue = quantity * avgCost;
    const pnl = marketValue - costValue;

    row.querySelector('[data-field="marketValue"]').textContent = formatCurrency(marketValue);
    row.querySelector('[data-field="costValue"]').textContent = formatCurrency(costValue);

    const pnlEl = row.querySelector('[data-field="pnl"]');
    pnlEl.textContent = formatCurrency(pnl);
    setPositiveNegative(pnlEl, pnl);
  });
}

function collectEditorHoldingsFromDom() {
  const collectFromBody = (bodyId, assetType) => {
    const rows = [...(byId(bodyId)?.querySelectorAll("tr") || [])];
    return rows.map((row) =>
      normalizeHolding({
        id: row.dataset.id || uid(),
        assetType,
        owner: row.querySelector('[data-field="owner"]').value,
        code: row.querySelector('[data-field="code"]').value.trim(),
        name: row.querySelector('[data-field="name"]').value.trim(),
        quantity: number(row.querySelector('[data-field="quantity"]').value),
        avgCost: number(row.querySelector('[data-field="avgCost"]').value),
        currentPrice: number(row.querySelector('[data-field="currentPrice"]').value),
      })
    );
  };

  return [...collectFromBody("stock-editor-body", "stock"), ...collectFromBody("fund-editor-body", "fund")];
}

function collectOperationSnapshotFromDom(state) {
  const currentNameA = String(state.members?.[0]?.name || "").trim() || "成员一";
  const currentNameB = String(state.members?.[1]?.name || "").trim() || "成员二";

  return {
    members: [
      {
        name: byId("member-a-name")?.value.trim() || currentNameA,
        principal: state.members?.[0]?.principal || 0,
      },
      {
        name: byId("member-b-name")?.value.trim() || currentNameB,
        principal: state.members?.[1]?.principal || 0,
      },
    ],
    currentTotalAsset: number(byId("current-total-asset")?.value),
    cashAmount: number(byId("cash-amount")?.value),
    holdings: collectEditorHoldingsFromDom(),
  };
}

function renderOperationTargetOptions(state) {
  const select = byId("capital-target");
  if (!select) return;

  const nameA = String(state.members?.[0]?.name || "").trim() || "成员一";
  const nameB = String(state.members?.[1]?.name || "").trim() || "成员二";

  const optionA = select.querySelector('option[value="memberA"]');
  const optionB = select.querySelector('option[value="memberB"]');
  if (optionA) optionA.textContent = `${nameA} 个人`;
  if (optionB) optionB.textContent = `${nameB} 个人`;
}

function renderHoldingOwnerOptions(state) {
  const nameA = String(state.members?.[0]?.name || "").trim() || "成员一";
  const nameB = String(state.members?.[1]?.name || "").trim() || "成员二";

  document
    .querySelectorAll('#stock-editor-body select[data-field="owner"], #fund-editor-body select[data-field="owner"]')
    .forEach((select) => {
      const optionA = select.querySelector('option[value="memberA"]');
      const optionB = select.querySelector('option[value="memberB"]');
      if (optionA) optionA.textContent = nameA;
      if (optionB) optionB.textContent = nameB;
    });
}

function renderOperationPreview(state) {
  const preview = byId("capital-preview");
  if (!preview) return;

  const summary = computeSummary(state);
  const action = byId("capital-action")?.value || "deposit";
  const target = byId("capital-target")?.value || "proportional";
  const amount = number(byId("capital-amount")?.value);

  if (amount <= 0) {
    preview.textContent = "规则：操作金额 ÷ 股票账户净值 = 本金份额变化";
    return;
  }

  if (summary.totalPrincipal <= 0 || summary.netValue <= 0) {
    preview.textContent = "净值不可用，请先完成本金与股票账户快照初始化。";
    return;
  }

  const principalDelta = amount / summary.netValue;

  let deltaA = 0;
  let deltaB = 0;
  if (target === "memberA") {
    deltaA = principalDelta;
  } else if (target === "memberB") {
    deltaB = principalDelta;
  } else {
    const ratioA = summary.totalPrincipal > 0 ? summary.principalA / summary.totalPrincipal : 0;
    deltaA = principalDelta * ratioA;
    deltaB = principalDelta - deltaA;
  }

  const sign = action === "deposit" ? "+" : "-";
  preview.textContent = `预览：${action === "deposit" ? "入金" : "出金"} ${formatCurrency(amount)}，股票净值 ${summary.netValue.toFixed(4)}，本金份额 ${sign}${formatCurrency(principalDelta)}（${summary.memberAName} ${sign}${formatCurrency(deltaA)}，${summary.memberBName} ${sign}${formatCurrency(deltaB)}）`;
}

function renderOperationSummary(state) {
  if (!byId("operation-page")) return;

  const summary = computeSummary(state);
  const totalProfit = summary.totalProfit;
  const principalRatio = summary.totalPrincipal > 0 ? (summary.currentTotalAsset / summary.totalPrincipal) * 100 : 0;
  const principalShareA = summary.totalPrincipal > 0 ? (summary.principalA / summary.totalPrincipal) * 100 : 0;
  const principalShareB = summary.totalPrincipal > 0 ? (summary.principalB / summary.totalPrincipal) * 100 : 0;

  setText("operation-updated-at", formatDate(state.updatedAt));
  setText("op-total-principal-value", formatCurrency(summary.totalPrincipal));
  setText("op-current-asset-value", formatCurrency(summary.currentTotalAsset));
  setText("op-net-value-value", summary.netValue.toFixed(4));
  setText("op-stock-snapshot-line", `股票资产快照：${formatCurrency(summary.stockSnapshotAsset)}`);
  setText("op-total-asset-formula", `总资产 = ${formatCurrency(summary.stockSnapshotAsset)} + ${formatCurrency(summary.fundMarketValueTotal)}`);
  setText("op-progress-caption", `资产本金比：${principalRatio.toFixed(2)}%`);
  setText("op-total-profit-chip", `累计收益：${formatCurrency(totalProfit)}`);
  setText(
    "op-member-a-line",
    `${summary.memberAName}本金：${formatCurrency(summary.principalA)} · 占比 ${principalShareA.toFixed(2)}% · 归属持仓 ${formatCurrency(summary.assignedAssetA)}`
  );
  setText(
    "op-member-b-line",
    `${summary.memberBName}本金：${formatCurrency(summary.principalB)} · 占比 ${principalShareB.toFixed(2)}% · 归属持仓 ${formatCurrency(summary.assignedAssetB)}`
  );
  setPositiveNegative(byId("op-total-profit-chip"), totalProfit);

  const progressFill = byId("op-progress-fill");
  if (progressFill) {
    progressFill.style.width = `${Math.max(0, Math.min(100, principalRatio)).toFixed(2)}%`;
  }

  const todayBaseline = getTodayProfitBaseline(state, summary);
  const todayTotalProfit = summary.totalProfit - number(todayBaseline.totalProfit);
  const todayAProfit = summary.memberTotalProfitA - number(todayBaseline.memberTotalProfitA);
  const todayBProfit = summary.memberTotalProfitB - number(todayBaseline.memberTotalProfitB);
  const todayBaseAsset = number(todayBaseline.profitBaseAsset);
  const todayRate = todayBaseAsset > 0 ? (todayTotalProfit / todayBaseAsset) * 100 : 0;

  setText("op-today-total-chip", `今日收益：${formatCurrency(todayTotalProfit)} · ${todayRate.toFixed(2)}%`);
  setText("op-today-a-chip", `${summary.memberAName}：${formatCurrency(todayAProfit)}`);
  setText("op-today-b-chip", `${summary.memberBName}：${formatCurrency(todayBProfit)}`);
  setPositiveNegative(byId("op-today-total-chip"), todayTotalProfit);
  setPositiveNegative(byId("op-today-a-chip"), todayAProfit);
  setPositiveNegative(byId("op-today-b-chip"), todayBProfit);

  const stockValue = Math.max(0, summary.stockMarketValueTotal);
  const fundValue = Math.max(0, summary.fundMarketValueTotal);
  const cashValue = Math.max(0, number(state.cashAmount));
  const structureBase = stockValue + fundValue + cashValue;
  const stockShare = structureBase > 0 ? (stockValue / structureBase) * 100 : 0;
  const fundShare = structureBase > 0 ? (fundValue / structureBase) * 100 : 0;
  const cashShare = structureBase > 0 ? (cashValue / structureBase) * 100 : 0;

  setText("op-structure-stock-line", `股票：${formatCurrency(stockValue)} · ${stockShare.toFixed(2)}%`);
  setText("op-structure-fund-line", `基金：${formatCurrency(fundValue)} · ${fundShare.toFixed(2)}%`);
  setText("op-structure-cash-line", `现金：${formatCurrency(cashValue)} · ${cashShare.toFixed(2)}%`);

  const structureStockBar = byId("op-structure-stock-bar");
  const structureFundBar = byId("op-structure-fund-bar");
  const structureCashBar = byId("op-structure-cash-bar");
  if (structureStockBar) structureStockBar.style.width = `${Math.max(0, Math.min(100, stockShare)).toFixed(2)}%`;
  if (structureFundBar) structureFundBar.style.width = `${Math.max(0, Math.min(100, fundShare)).toFixed(2)}%`;
  if (structureCashBar) structureCashBar.style.width = `${Math.max(0, Math.min(100, cashShare)).toFixed(2)}%`;
  setText("op-estimated-total-line", `估算资产合计（股票+基金+现金）：${formatCurrency(summary.estimatedTotal)}`);
  setText("op-estimated-gap-line", `与当前总资产的核算差额：${formatCurrency(summary.gap)}（股票侧差额：${formatCurrency(summary.stockGap)}）`);
  setPositiveNegative(byId("op-estimated-gap-line"), -summary.gap);

  const holdingsCount = summary.holdingsWithCalc.length;
  const logsCount = Array.isArray(state.logs) ? state.logs.length : 0;
  const snapshotsCount = Array.isArray(state.snapshots) ? state.snapshots.length : 0;
  setText("op-meta-holdings", `资产条目：${holdingsCount}（股${summary.stockHoldingCount} / 基${summary.fundHoldingCount}）`);
  setText("op-meta-logs", `操作记录：${logsCount}`);
  setText("op-meta-snapshots", `快照数量：${snapshotsCount}`);

  renderOperationTargetOptions(state);
  renderHoldingOwnerOptions(state);
  renderOperationPreview(state);
  renderHistory("history-body-operation", state.logs || []);
}

function fillOperationForm(state) {
  if (!byId("operation-page")) return;

  const nameA = byId("member-a-name");
  const nameB = byId("member-b-name");
  const totalAsset = byId("current-total-asset");
  const cash = byId("cash-amount");

  if (nameA) nameA.value = state.members[0]?.name || "";
  if (nameB) nameB.value = state.members[1]?.name || "";
  if (totalAsset) totalAsset.value = number(state.currentTotalAsset);
  if (cash) cash.value = number(state.cashAmount);

  renderEditorHoldingRows(state.holdings || []);
}

let saveNoticeTimer;
let appState = loadState();
const seededToday = ensureTodayBaseline(appState);
const seededSnapshot = pushSnapshot(appState);
if (seededToday || seededSnapshot) {
  persistState(appState);
}

let cloudSaveTimer = null;
let cloudSaveInFlight = false;
let pendingCloudState = null;

function cloneState(state) {
  if (typeof structuredClone === "function") return structuredClone(state);
  return JSON.parse(JSON.stringify(state));
}

async function flushCloudSaveQueue() {
  if (!isCloudEnabled() || cloudSaveInFlight || !pendingCloudState) return;

  cloudSaveInFlight = true;
  const nextState = pendingCloudState;
  pendingCloudState = null;

  const ok = await saveCloudState(nextState);
  if (!ok) {
    console.warn("云端保存失败，已保留本地数据。");
  }

  cloudSaveInFlight = false;
  if (pendingCloudState) {
    flushCloudSaveQueue();
  }
}

function queueCloudSave(state, { immediate = false } = {}) {
  if (!isCloudEnabled()) return;

  pendingCloudState = cloneState(state);
  clearTimeout(cloudSaveTimer);

  if (immediate) {
    flushCloudSaveQueue();
    return;
  }

  cloudSaveTimer = setTimeout(() => {
    flushCloudSaveQueue();
  }, 900);
}

function persistState(state, { cloudImmediate = false } = {}) {
  saveState(state);
  queueCloudSave(state, { immediate: cloudImmediate });
}

function showSaveStatus(text) {
  const status = byId("save-status");
  if (!status) return;

  status.textContent = text;
  clearTimeout(saveNoticeTimer);
  saveNoticeTimer = setTimeout(() => {
    status.textContent = isCloudEnabled() ? "变更已保存（本地与云端已同步）" : "变更已保存到本地";
  }, 1000);
}

function syncOperationAndSave({ notice = "已保存最新变更", logEntry = null } = {}) {
  if (!byId("operation-page")) return;

  const partial = collectOperationSnapshotFromDom(appState);
  appState = {
    ...appState,
    ...partial,
    updatedAt: new Date().toISOString(),
  };

  if (logEntry) addLog(appState, logEntry);
  pushSnapshot(appState);

  updateEditorHoldingComputed();
  renderOperationSummary(appState);
  renderDashboard(appState);
  persistState(appState);
  showSaveStatus(notice);
}

async function refreshQuoteForEditorRow(row, { silent = false } = {}) {
  const assetType = row.dataset.assetType || "stock";
  const codeInput = row.querySelector('[data-field="code"]');
  const nameInput = row.querySelector('[data-field="name"]');
  const priceInput = row.querySelector('[data-field="currentPrice"]');
  const button = row.querySelector(".quote-refresh");

  if (assetType !== "stock") {
    if (!silent) showSaveStatus("基金暂不支持自动行情，请手动维护净值");
    return { ok: false, skipped: true };
  }

  const symbol = toTencentSymbol(codeInput.value);
  if (!symbol) {
    if (!silent) showSaveStatus("股票代码格式不正确，示例：300807 或 sz300807");
    return { ok: false, skipped: false };
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "刷新中";

  try {
    const quote = await fetchTencentQuote(symbol);
    if (!nameInput.value.trim() && quote.name) {
      nameInput.value = quote.name;
    }
    priceInput.value = quote.price;
    updateEditorHoldingComputed();
    return { ok: true, skipped: false };
  } catch {
    if (!silent) showSaveStatus(`获取 ${symbol} 行情失败，请稍后重试`);
    return { ok: false, skipped: false };
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function applyCapitalOperation() {
  if (!byId("operation-page")) return;

  syncOperationAndSave({ notice: "已同步当前编辑项" });

  const action = byId("capital-action")?.value || "deposit";
  const target = byId("capital-target")?.value || "proportional";
  const amount = number(byId("capital-amount")?.value);
  const note = byId("capital-note")?.value.trim() || "";

  if (amount <= 0) {
    showSaveStatus("请输入大于 0 的操作金额");
    return;
  }

  const summary = computeSummary(appState);
  if (summary.totalPrincipal <= 0 || summary.netValue <= 0) {
    showSaveStatus("当前净值无效，暂无法执行资金操作");
    return;
  }

  if (action === "withdraw" && amount > summary.stockSnapshotAsset + 1e-8) {
    showSaveStatus("出金金额不能超过当前股票账户资产");
    return;
  }

  const principalDelta = amount / summary.netValue;

  let deltaA = 0;
  let deltaB = 0;
  if (target === "memberA") {
    deltaA = principalDelta;
  } else if (target === "memberB") {
    deltaB = principalDelta;
  } else {
    const ratioA = summary.totalPrincipal > 0 ? summary.principalA / summary.totalPrincipal : 0;
    deltaA = principalDelta * ratioA;
    deltaB = principalDelta - deltaA;
  }

  if (action === "withdraw") {
    if (target === "memberA" && amount > summary.assetA + 1e-8) {
      showSaveStatus(`${summary.memberAName} 的可出金上限为 ${formatCurrency(summary.assetA)}`);
      return;
    }
    if (target === "memberB" && amount > summary.assetB + 1e-8) {
      showSaveStatus(`${summary.memberBName} 的可出金上限为 ${formatCurrency(summary.assetB)}`);
      return;
    }

    appState.members[0].principal = round(Math.max(0, summary.principalA - deltaA));
    appState.members[1].principal = round(Math.max(0, summary.principalB - deltaB));
    appState.currentTotalAsset = round(Math.max(0, summary.stockSnapshotAsset - amount), 2);
  } else {
    appState.members[0].principal = round(summary.principalA + deltaA);
    appState.members[1].principal = round(summary.principalB + deltaB);
    appState.currentTotalAsset = round(summary.stockSnapshotAsset + amount, 2);
  }

  appState.updatedAt = new Date().toISOString();

  const targetText =
    target === "memberA"
      ? summary.memberAName
      : target === "memberB"
        ? summary.memberBName
        : "按本金比例";

  addLog(appState, {
    type: action === "deposit" ? "入金" : "出金",
    detail: `${action === "deposit" ? "入金" : "出金"} ${formatCurrency(amount)}；归属：${targetText}；按净值折算本金份额 ${formatCurrency(principalDelta)}${note ? `；备注：${note}` : ""}`,
  });
  pushSnapshot(appState, { force: true });

  const totalAssetInput = byId("current-total-asset");
  if (totalAssetInput) totalAssetInput.value = number(appState.currentTotalAsset);

  const amountInput = byId("capital-amount");
  const noteInput = byId("capital-note");
  if (amountInput) amountInput.value = "";
  if (noteInput) noteInput.value = "";

  renderOperationSummary(appState);
  renderDashboard(appState);
  persistState(appState, { cloudImmediate: true });
  showSaveStatus(`${action === "deposit" ? "入金" : "出金"}已执行并写入记录`);
}

function bindOperationEvents() {
  if (!byId("operation-page")) return;

  const form = byId("ledger-form");
  const stockBody = byId("stock-editor-body");
  const fundBody = byId("fund-editor-body");
  const addStockBtn = byId("add-stock");
  const addFundBtn = byId("add-fund");
  const refreshQuotesBtn = byId("refresh-quotes");
  const capitalForm = byId("capital-form");
  const clearHistoryBtn = byId("clear-history");

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    syncOperationAndSave({
      notice: "账户快照已保存",
      logEntry: { type: "手动保存", detail: "更新账户快照" },
    });
  });

  form?.addEventListener("input", () => {
    syncOperationAndSave({ notice: "检测到修改，已自动保存" });
  });

  const onAssetRowsInput = () => {
    syncOperationAndSave({ notice: "持仓数据已更新" });
  };

  stockBody?.addEventListener("input", onAssetRowsInput);
  fundBody?.addEventListener("input", onAssetRowsInput);
  stockBody?.addEventListener("change", onAssetRowsInput);
  fundBody?.addEventListener("change", onAssetRowsInput);

  stockBody?.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.classList.contains("remove")) {
      button.closest("tr")?.remove();
      syncOperationAndSave({
        notice: "持仓已删除并保存",
        logEntry: { type: "持仓变更", detail: "删除一条持仓记录" },
      });
      return;
    }

    if (button.classList.contains("quote-refresh")) {
      const row = button.closest("tr");
      if (!row) return;
      const symbol = toTencentSymbol(row.querySelector('[data-field="code"]').value) || "未知代码";
      const result = await refreshQuoteForEditorRow(row);
      if (result.ok) {
        syncOperationAndSave({
          notice: "实时行情已更新并保存",
          logEntry: { type: "行情刷新", detail: `更新 ${symbol} 实时价格` },
        });
      }
    }
  });

  fundBody?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.classList.contains("remove")) {
      button.closest("tr")?.remove();
      syncOperationAndSave({
        notice: "基金记录已删除并保存",
        logEntry: { type: "持仓变更", detail: "删除一条基金记录" },
      });
    }
  });

  addStockBtn?.addEventListener("click", () => {
    const partial = collectOperationSnapshotFromDom(appState);
    partial.holdings.push(createHoldingRowTemplate("stock"));

    appState = {
      ...appState,
      ...partial,
      updatedAt: new Date().toISOString(),
    };

    renderEditorHoldingRows(appState.holdings);
    syncOperationAndSave({
      notice: "已新增股票条目",
      logEntry: { type: "持仓变更", detail: "新增一条股票记录" },
    });
  });

  addFundBtn?.addEventListener("click", () => {
    const partial = collectOperationSnapshotFromDom(appState);
    partial.holdings.push(createHoldingRowTemplate("fund"));

    appState = {
      ...appState,
      ...partial,
      updatedAt: new Date().toISOString(),
    };

    renderEditorHoldingRows(appState.holdings);
    syncOperationAndSave({
      notice: "已新增基金条目",
      logEntry: { type: "持仓变更", detail: "新增一条基金记录" },
    });
  });

  refreshQuotesBtn?.addEventListener("click", async () => {
    const rows = [...(stockBody?.querySelectorAll("tr") || [])];
    if (!rows.length) {
      showSaveStatus("当前无可刷新股票条目");
      return;
    }

    const originalText = refreshQuotesBtn.textContent;
    refreshQuotesBtn.disabled = true;
    refreshQuotesBtn.textContent = "刷新中...";

    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const row of rows) {
      const result = await refreshQuoteForEditorRow(row, { silent: true });
      if (result.ok) {
        successCount += 1;
      } else if (result.skipped) {
        skippedCount += 1;
      } else {
        failedCount += 1;
      }
    }

    syncOperationAndSave({
      notice:
        failedCount === 0
          ? skippedCount === 0
            ? `行情刷新完成：成功 ${successCount} 条`
            : `行情刷新完成：成功 ${successCount}，跳过 ${skippedCount}`
          : `行情刷新完成：成功 ${successCount}，失败 ${failedCount}，跳过 ${skippedCount}`,
      logEntry: {
        type: "行情刷新",
        detail: `股票批量刷新：成功 ${successCount}，失败 ${failedCount}，跳过 ${skippedCount}`,
      },
    });

    refreshQuotesBtn.disabled = false;
    refreshQuotesBtn.textContent = originalText;
  });

  byId("capital-action")?.addEventListener("change", () => renderOperationPreview(appState));
  byId("capital-target")?.addEventListener("change", () => renderOperationPreview(appState));
  byId("capital-amount")?.addEventListener("input", () => renderOperationPreview(appState));

  capitalForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    applyCapitalOperation();
  });

  clearHistoryBtn?.addEventListener("click", () => {
    appState.logs = [];
    addLog(appState, { type: "历史清空", detail: "已清空历史记录" });
    renderOperationSummary(appState);
    renderDashboard(appState);
    persistState(appState, { cloudImmediate: true });
    showSaveStatus("操作历史已清空");
  });
}

async function hydrateFromCloud() {
  if (!isCloudEnabled()) return;

  const cloudState = await loadCloudState();
  if (cloudState === undefined) {
    showSaveStatus("云端读取失败，已保留本地数据（未覆盖云端）");
    return;
  }

  if (!cloudState) {
    queueCloudSave(appState, { immediate: true });
    showSaveStatus("已初始化云端账本");
    return;
  }

  appState = cloudState;
  const seededCloudToday = ensureTodayBaseline(appState);
  const seededCloudSnapshot = pushSnapshot(appState);
  if (seededCloudToday || seededCloudSnapshot) {
    persistState(appState, { cloudImmediate: true });
  } else {
    saveState(appState);
  }

  if (byId("dashboard-page")) {
    renderDashboard(appState);
  }

  if (byId("operation-page")) {
    fillOperationForm(appState);
    renderOperationSummary(appState);
  }

  showSaveStatus("云端数据同步完成");
}

function init() {
  initCalcToggles();

  if (byId("dashboard-page")) {
    renderDashboard(appState);
  }

  if (byId("operation-page")) {
    fillOperationForm(appState);
    renderOperationSummary(appState);
    bindOperationEvents();
  }

  hydrateFromCloud().catch((error) => {
    console.warn("云端同步失败，继续使用本地数据。", error);
    showSaveStatus("云端同步失败，已切换为本地数据");
  });
}

init();
