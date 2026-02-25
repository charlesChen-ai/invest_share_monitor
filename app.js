const STORAGE_KEY = "equity_ledger_rmb_v2";
const MAX_LOG_ENTRIES = 300;
const MAX_SNAPSHOTS = 480;

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

function formatDate(value) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未设置";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateKeyOf(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
      members: parsed.members?.length === 2 ? parsed.members : defaults.members,
      holdings: Array.isArray(parsed.holdings) ? parsed.holdings : defaults.holdings,
      logs: Array.isArray(parsed.logs) ? parsed.logs : defaults.logs,
      dailyBaselines:
        parsed.dailyBaselines && typeof parsed.dailyBaselines === "object"
          ? parsed.dailyBaselines
          : defaults.dailyBaselines,
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
    };

    if (!merged.snapshots.length) {
      const summary = computeSummary(merged);
      merged.snapshots = [
        {
          at: merged.updatedAt || new Date().toISOString(),
          totalAsset: summary.currentTotalAsset,
          assetA: summary.assetA,
          assetB: summary.assetB,
        },
      ];
    }

    return merged;
  } catch {
    return createDefaultState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  const memberA = state.members[0] || { name: "成员A", principal: 0 };
  const memberB = state.members[1] || { name: "成员B", principal: 0 };

  const principalA = number(memberA.principal);
  const principalB = number(memberB.principal);
  const totalPrincipal = principalA + principalB;
  const currentTotalAsset = number(state.currentTotalAsset);
  const netValue = totalPrincipal > 0 ? currentTotalAsset / totalPrincipal : 0;

  const assetA = netValue * principalA;
  const assetB = netValue * principalB;
  const profitA = assetA - principalA;
  const profitB = assetB - principalB;

  const holdingsWithCalc = (state.holdings || []).map((h) => {
    const quantity = number(h.quantity);
    const avgCost = number(h.avgCost);
    const currentPrice = number(h.currentPrice);
    const marketValue = quantity * currentPrice;
    const costValue = quantity * avgCost;

    return {
      ...h,
      quantity,
      avgCost,
      currentPrice,
      marketValue,
      costValue,
      pnl: marketValue - costValue,
    };
  });

  const holdingMarketValueTotal = holdingsWithCalc.reduce((sum, h) => sum + h.marketValue, 0);
  const estimatedTotal = holdingMarketValueTotal + number(state.cashAmount);
  const gap = currentTotalAsset - estimatedTotal;

  return {
    memberAName: memberA.name || "成员A",
    memberBName: memberB.name || "成员B",
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
  };
}

function ensureTodayBaseline(state) {
  if (!state.dailyBaselines || typeof state.dailyBaselines !== "object") {
    state.dailyBaselines = {};
  }

  const key = dateKeyOf();
  if (state.dailyBaselines[key]) return false;

  const summary = computeSummary(state);
  state.dailyBaselines[key] = {
    at: new Date().toISOString(),
    totalAsset: summary.currentTotalAsset,
    assetA: summary.assetA,
    assetB: summary.assetB,
  };

  return true;
}

function pushSnapshot(state, { force = false } = {}) {
  if (!Array.isArray(state.snapshots)) {
    state.snapshots = [];
  }

  const summary = computeSummary(state);
  const now = new Date().toISOString();
  const next = {
    at: now,
    totalAsset: summary.currentTotalAsset,
    assetA: summary.assetA,
    assetB: summary.assetB,
  };

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

function renderHistory(bodyId, logs) {
  const body = byId(bodyId);
  if (!body) return;

  body.innerHTML = "";
  if (!logs.length) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>--</td><td>--</td><td>暂无操作记录</td>";
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

function renderDashboardHoldings(rows) {
  const body = byId("dashboard-holdings-body");
  if (!body) return;

  body.innerHTML = "";

  if (!rows.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="8">暂无持仓</td>';
    body.appendChild(row);
    return;
  }

  rows.forEach((h) => {
    const row = document.createElement("tr");

    const cells = [
      h.code || "-",
      h.name || "-",
      String(h.quantity),
      formatCurrency(h.avgCost),
      formatCurrency(h.currentPrice),
      formatCurrency(h.marketValue),
      formatCurrency(h.costValue),
      formatCurrency(h.pnl),
    ];

    cells.forEach((cellText, index) => {
      const td = document.createElement("td");
      td.textContent = cellText;
      if (index === 7) setPositiveNegative(td, h.pnl);
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
  setText("total-principal-hint", `总本金：${formatCurrency(summary.totalPrincipal)}`);

  const totalProfit = summary.currentTotalAsset - summary.totalPrincipal;
  const totalProfitRate = summary.totalPrincipal > 0 ? (totalProfit / summary.totalPrincipal) * 100 : 0;
  setText("total-profit-value", formatCurrency(totalProfit));
  setText("total-profit-rate", `收益率：${totalProfitRate.toFixed(2)}%`);
  setText("total-profit-line", `总收益：${formatCurrency(totalProfit)}`);
  setText(
    "total-profit-formula",
    `${formatCurrency(summary.currentTotalAsset)} - ${formatCurrency(summary.totalPrincipal)} = ${formatCurrency(totalProfit)}`
  );
  setPositiveNegative(byId("total-profit-value"), totalProfit);
  setPositiveNegative(byId("total-profit-rate"), totalProfitRate);
  setPositiveNegative(byId("total-profit-line"), totalProfit);

  setText("member-a-principal-line", `${summary.memberAName}本金：${formatCurrency(summary.principalA)}`);
  setText("member-b-principal-line", `${summary.memberBName}本金：${formatCurrency(summary.principalB)}`);

  setText("net-value-line", `当前净值：${summary.netValue.toFixed(4)}`);
  setText("net-value-formula", `${formatCurrency(summary.currentTotalAsset)} ÷ ${formatCurrency(summary.totalPrincipal)} = ${summary.netValue.toFixed(4)}`);

  const allocationBase = summary.assetA + summary.assetB;
  const allocationA = allocationBase > 0 ? (summary.assetA / allocationBase) * 100 : 0;
  const allocationB = allocationBase > 0 ? (summary.assetB / allocationBase) * 100 : 0;
  const allocationAFormula =
    allocationBase > 0
      ? `${formatCurrency(summary.assetA)} ÷ ${formatCurrency(allocationBase)} = ${allocationA.toFixed(2)}%`
      : "总分配资产为 0，占比按 0.00% 处理";
  const allocationBFormula =
    allocationBase > 0
      ? `${formatCurrency(summary.assetB)} ÷ ${formatCurrency(allocationBase)} = ${allocationB.toFixed(2)}%`
      : "总分配资产为 0，占比按 0.00% 处理";
  setText("member-a-asset-line", `${summary.memberAName}资产：${formatCurrency(summary.assetA)} · 占比 ${allocationA.toFixed(2)}%`);
  setText(
    "member-a-asset-formula",
    `${summary.netValue.toFixed(4)} × ${formatCurrency(summary.principalA)} = ${formatCurrency(summary.assetA)}；${allocationAFormula}`
  );

  setText("member-b-asset-line", `${summary.memberBName}资产：${formatCurrency(summary.assetB)} · 占比 ${allocationB.toFixed(2)}%`);
  setText(
    "member-b-asset-formula",
    `${summary.netValue.toFixed(4)} × ${formatCurrency(summary.principalB)} = ${formatCurrency(summary.assetB)}；${allocationBFormula}`
  );

  const allocationABar = byId("member-a-alloc-bar");
  const allocationBBar = byId("member-b-alloc-bar");
  if (allocationABar) allocationABar.style.width = `${Math.max(0, Math.min(100, allocationA)).toFixed(2)}%`;
  if (allocationBBar) allocationBBar.style.width = `${Math.max(0, Math.min(100, allocationB)).toFixed(2)}%`;

  const recordedHolding = Math.max(0, summary.holdingMarketValueTotal);
  const recordedCash = Math.max(0, number(state.cashAmount));
  const structureBase = recordedHolding + recordedCash;
  const holdingShare = structureBase > 0 ? (recordedHolding / structureBase) * 100 : 0;
  const cashShare = structureBase > 0 ? (recordedCash / structureBase) * 100 : 0;
  setText("structure-holding-line", `持仓：${formatCurrency(recordedHolding)} · ${holdingShare.toFixed(2)}%`);
  setText("structure-cash-line", `现金：${formatCurrency(recordedCash)} · ${cashShare.toFixed(2)}%`);

  const holdingBar = byId("structure-holding-bar");
  const cashBar = byId("structure-cash-bar");
  if (holdingBar) holdingBar.style.width = `${Math.max(0, Math.min(100, holdingShare)).toFixed(2)}%`;
  if (cashBar) cashBar.style.width = `${Math.max(0, Math.min(100, cashShare)).toFixed(2)}%`;

  setText("structure-profit-badge", `累计收益：${formatCurrency(totalProfit)}`);
  setPositiveNegative(byId("structure-profit-badge"), totalProfit);

  let netState = "净值状态：相对平稳";
  if (summary.netValue >= 1.2) {
    netState = "净值状态：强势增长";
  } else if (summary.netValue >= 1.05) {
    netState = "净值状态：稳步增长";
  } else if (summary.netValue < 0.95) {
    netState = "净值状态：出现回撤";
  }
  const stateBadge = byId("structure-state-badge");
  setText("structure-state-badge", netState);
  if (stateBadge) {
    stateBadge.classList.remove("positive", "negative");
    if (summary.netValue >= 1.05) stateBadge.classList.add("positive");
    if (summary.netValue < 0.95) stateBadge.classList.add("negative");
  }

  setText("member-a-profit-line", `${summary.memberAName}收益：${formatCurrency(summary.profitA)}`);
  setText("member-a-profit-formula", `${formatCurrency(summary.assetA)} - ${formatCurrency(summary.principalA)} = ${formatCurrency(summary.profitA)}`);

  setText("member-b-profit-line", `${summary.memberBName}收益：${formatCurrency(summary.profitB)}`);
  setText("member-b-profit-formula", `${formatCurrency(summary.assetB)} - ${formatCurrency(summary.principalB)} = ${formatCurrency(summary.profitB)}`);

  setPositiveNegative(byId("member-a-profit-line"), summary.profitA);
  setPositiveNegative(byId("member-b-profit-line"), summary.profitB);

  const todayBaseline = state.dailyBaselines?.[dateKeyOf()] || {
    totalAsset: summary.currentTotalAsset,
    assetA: summary.assetA,
    assetB: summary.assetB,
  };

  const todayTotalProfit = summary.currentTotalAsset - number(todayBaseline.totalAsset);
  const todayAProfit = summary.assetA - number(todayBaseline.assetA);
  const todayBProfit = summary.assetB - number(todayBaseline.assetB);
  const todayBaseAsset = number(todayBaseline.totalAsset);
  const todayTotalProfitRate = todayBaseAsset > 0 ? (todayTotalProfit / todayBaseAsset) * 100 : 0;

  setText("today-profit-total-value", formatCurrency(todayTotalProfit));
  setText("today-profit-total-rate", `日内收益率：${todayTotalProfitRate.toFixed(2)}%`);
  setText("today-profit-a-line", `${summary.memberAName}：${formatCurrency(todayAProfit)}`);
  setText("today-profit-b-line", `${summary.memberBName}：${formatCurrency(todayBProfit)}`);
  setText("today-profit-base-line", `基准资产：${formatCurrency(todayBaseAsset)}`);
  setPositiveNegative(byId("today-profit-total-value"), todayTotalProfit);
  setPositiveNegative(byId("today-profit-total-rate"), todayTotalProfitRate);
  setPositiveNegative(byId("today-profit-a-line"), todayAProfit);
  setPositiveNegative(byId("today-profit-b-line"), todayBProfit);

  setText("cash-line", `持有现金：${formatCurrency(state.cashAmount)}`);
  setText("holding-total-line", `持仓市值合计：${formatCurrency(summary.holdingMarketValueTotal)}`);
  setText("holding-total-formula", "各持仓行 (数量 × 当前市价) 求和");
  setText("estimated-total-line", `持仓+现金：${formatCurrency(summary.estimatedTotal)}`);
  setText("estimated-total-formula", `${formatCurrency(summary.holdingMarketValueTotal)} + ${formatCurrency(state.cashAmount)} = ${formatCurrency(summary.estimatedTotal)}`);

  setText("gap-line", `账户差额：${formatCurrency(summary.gap)}`);
  setText("gap-formula", `${formatCurrency(summary.currentTotalAsset)} - ${formatCurrency(summary.estimatedTotal)} = ${formatCurrency(summary.gap)}`);
  setPositiveNegative(byId("gap-line"), -summary.gap);

  renderProfitCurve(state, summary);
  renderDashboardHoldings(summary.holdingsWithCalc);
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

  setText("curve-start-line", `起点：${formatCurrency(first.totalAsset)}`);
  setText("curve-end-line", `当前：${formatCurrency(last.totalAsset)}`);
  setText("curve-peak-line", `峰值：${formatCurrency(peak.totalAsset)}`);
  setText("curve-trough-line", `低点：${formatCurrency(trough.totalAsset)}`);

  setPositiveNegative(byId("curve-end-line"), last.totalAsset - first.totalAsset);
}

function createHoldingRowTemplate() {
  return {
    id: uid(),
    code: "",
    name: "",
    quantity: 0,
    avgCost: 0,
    currentPrice: 0,
  };
}

function renderEditorHoldingRows(holdings) {
  const body = byId("holdings-editor-body");
  const template = byId("holding-editor-row-template");
  if (!body || !template) return;

  body.innerHTML = "";

  holdings.forEach((holding) => {
    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector("tr");

    row.dataset.id = holding.id || uid();
    row.querySelector('[data-field="code"]').value = holding.code || "";
    row.querySelector('[data-field="name"]').value = holding.name || "";
    row.querySelector('[data-field="quantity"]').value = number(holding.quantity);
    row.querySelector('[data-field="avgCost"]').value = number(holding.avgCost);
    row.querySelector('[data-field="currentPrice"]').value = number(holding.currentPrice);

    body.appendChild(fragment);
  });

  updateEditorHoldingComputed();
}

function updateEditorHoldingComputed() {
  const rows = [...(byId("holdings-editor-body")?.querySelectorAll("tr") || [])];
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
  const rows = [...(byId("holdings-editor-body")?.querySelectorAll("tr") || [])];
  return rows.map((row) => ({
    id: row.dataset.id || uid(),
    code: row.querySelector('[data-field="code"]').value.trim(),
    name: row.querySelector('[data-field="name"]').value.trim(),
    quantity: number(row.querySelector('[data-field="quantity"]').value),
    avgCost: number(row.querySelector('[data-field="avgCost"]').value),
    currentPrice: number(row.querySelector('[data-field="currentPrice"]').value),
  }));
}

function collectOperationSnapshotFromDom(state) {
  return {
    members: [
      {
        name: byId("member-a-name")?.value.trim() || "成员A",
        principal: state.members[0]?.principal || 0,
      },
      {
        name: byId("member-b-name")?.value.trim() || "成员B",
        principal: state.members[1]?.principal || 0,
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

  const nameA = state.members[0]?.name || "成员A";
  const nameB = state.members[1]?.name || "成员B";

  const options = select.options;
  if (options[1]) options[1].textContent = `${nameA} 个人`;
  if (options[2]) options[2].textContent = `${nameB} 个人`;
}

function renderOperationPreview(state) {
  const preview = byId("capital-preview");
  if (!preview) return;

  const summary = computeSummary(state);
  const action = byId("capital-action")?.value || "deposit";
  const target = byId("capital-target")?.value || "proportional";
  const amount = number(byId("capital-amount")?.value);

  if (amount <= 0) {
    preview.textContent = "规则：操作金额 ÷ 当前净值 = 本金份额变化";
    return;
  }

  if (summary.totalPrincipal <= 0 || summary.netValue <= 0) {
    preview.textContent = "当前净值不可用。请先确保本金和总资产已初始化。";
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
  preview.textContent = `预览：${action === "deposit" ? "入金" : "出金"} ${formatCurrency(amount)}，净值 ${summary.netValue.toFixed(4)}，本金份额 ${sign}${formatCurrency(principalDelta)}（${summary.memberAName} ${sign}${formatCurrency(deltaA)}，${summary.memberBName} ${sign}${formatCurrency(deltaB)}）`;
}

function renderOperationSummary(state) {
  if (!byId("operation-page")) return;

  const summary = computeSummary(state);
  const totalProfit = summary.currentTotalAsset - summary.totalPrincipal;
  const principalRatio = summary.totalPrincipal > 0 ? (summary.currentTotalAsset / summary.totalPrincipal) * 100 : 0;
  const principalShareA = summary.totalPrincipal > 0 ? (summary.principalA / summary.totalPrincipal) * 100 : 0;
  const principalShareB = summary.totalPrincipal > 0 ? (summary.principalB / summary.totalPrincipal) * 100 : 0;

  setText("operation-updated-at", formatDate(state.updatedAt));
  setText("op-total-principal-value", formatCurrency(summary.totalPrincipal));
  setText("op-current-asset-value", formatCurrency(summary.currentTotalAsset));
  setText("op-net-value-value", summary.netValue.toFixed(4));
  setText("op-progress-caption", `资产/本金：${principalRatio.toFixed(2)}%`);
  setText("op-total-profit-chip", `累计收益：${formatCurrency(totalProfit)}`);
  setText(
    "op-member-a-line",
    `${summary.memberAName}本金：${formatCurrency(summary.principalA)} · 占比 ${principalShareA.toFixed(2)}%`
  );
  setText(
    "op-member-b-line",
    `${summary.memberBName}本金：${formatCurrency(summary.principalB)} · 占比 ${principalShareB.toFixed(2)}%`
  );
  setPositiveNegative(byId("op-total-profit-chip"), totalProfit);

  const progressFill = byId("op-progress-fill");
  if (progressFill) {
    progressFill.style.width = `${Math.max(0, Math.min(100, principalRatio)).toFixed(2)}%`;
  }

  const todayBaseline = state.dailyBaselines?.[dateKeyOf()] || {
    totalAsset: summary.currentTotalAsset,
    assetA: summary.assetA,
    assetB: summary.assetB,
  };
  const todayTotalProfit = summary.currentTotalAsset - number(todayBaseline.totalAsset);
  const todayAProfit = summary.assetA - number(todayBaseline.assetA);
  const todayBProfit = summary.assetB - number(todayBaseline.assetB);
  const todayBaseAsset = number(todayBaseline.totalAsset);
  const todayRate = todayBaseAsset > 0 ? (todayTotalProfit / todayBaseAsset) * 100 : 0;

  setText("op-today-total-chip", `今日收益：${formatCurrency(todayTotalProfit)} · ${todayRate.toFixed(2)}%`);
  setText("op-today-a-chip", `${summary.memberAName}：${formatCurrency(todayAProfit)}`);
  setText("op-today-b-chip", `${summary.memberBName}：${formatCurrency(todayBProfit)}`);
  setPositiveNegative(byId("op-today-total-chip"), todayTotalProfit);
  setPositiveNegative(byId("op-today-a-chip"), todayAProfit);
  setPositiveNegative(byId("op-today-b-chip"), todayBProfit);

  const holdingValue = Math.max(0, summary.holdingMarketValueTotal);
  const cashValue = Math.max(0, number(state.cashAmount));
  const structureBase = holdingValue + cashValue;
  const holdingShare = structureBase > 0 ? (holdingValue / structureBase) * 100 : 0;
  const cashShare = structureBase > 0 ? (cashValue / structureBase) * 100 : 0;

  setText("op-structure-holding-line", `持仓：${formatCurrency(holdingValue)} · ${holdingShare.toFixed(2)}%`);
  setText("op-structure-cash-line", `现金：${formatCurrency(cashValue)} · ${cashShare.toFixed(2)}%`);

  const structureHoldingBar = byId("op-structure-holding-bar");
  const structureCashBar = byId("op-structure-cash-bar");
  if (structureHoldingBar) structureHoldingBar.style.width = `${Math.max(0, Math.min(100, holdingShare)).toFixed(2)}%`;
  if (structureCashBar) structureCashBar.style.width = `${Math.max(0, Math.min(100, cashShare)).toFixed(2)}%`;

  const holdingsCount = summary.holdingsWithCalc.length;
  const logsCount = Array.isArray(state.logs) ? state.logs.length : 0;
  const snapshotsCount = Array.isArray(state.snapshots) ? state.snapshots.length : 0;
  setText("op-meta-holdings", `持仓数：${holdingsCount}`);
  setText("op-meta-logs", `历史条数：${logsCount}`);
  setText("op-meta-snapshots", `快照点：${snapshotsCount}`);

  renderOperationTargetOptions(state);
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
  saveState(appState);
}

function showSaveStatus(text) {
  const status = byId("save-status");
  if (!status) return;

  status.textContent = text;
  clearTimeout(saveNoticeTimer);
  saveNoticeTimer = setTimeout(() => {
    status.textContent = "数据已自动保存到本地";
  }, 1000);
}

function syncOperationAndSave({ notice = "已保存", logEntry = null } = {}) {
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
  saveState(appState);
  showSaveStatus(notice);
}

async function refreshQuoteForEditorRow(row, { silent = false } = {}) {
  const codeInput = row.querySelector('[data-field="code"]');
  const nameInput = row.querySelector('[data-field="name"]');
  const priceInput = row.querySelector('[data-field="currentPrice"]');
  const button = row.querySelector(".quote-refresh");

  const symbol = toTencentSymbol(codeInput.value);
  if (!symbol) {
    if (!silent) showSaveStatus("股票代码格式不正确，示例：300807 或 sz300807");
    return false;
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
    return true;
  } catch {
    if (!silent) showSaveStatus(`获取 ${symbol} 行情失败`);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function applyCapitalOperation() {
  if (!byId("operation-page")) return;

  syncOperationAndSave({ notice: "同步最新编辑数据" });

  const action = byId("capital-action")?.value || "deposit";
  const target = byId("capital-target")?.value || "proportional";
  const amount = number(byId("capital-amount")?.value);
  const note = byId("capital-note")?.value.trim() || "";

  if (amount <= 0) {
    showSaveStatus("操作金额必须大于 0");
    return;
  }

  const summary = computeSummary(appState);
  if (summary.totalPrincipal <= 0 || summary.netValue <= 0) {
    showSaveStatus("当前净值无效，无法执行资金操作");
    return;
  }

  if (action === "withdraw" && amount > summary.currentTotalAsset + 1e-8) {
    showSaveStatus("出金金额不能超过当前总资产");
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
      showSaveStatus(`${summary.memberAName} 可出金上限为 ${formatCurrency(summary.assetA)}`);
      return;
    }
    if (target === "memberB" && amount > summary.assetB + 1e-8) {
      showSaveStatus(`${summary.memberBName} 可出金上限为 ${formatCurrency(summary.assetB)}`);
      return;
    }

    appState.members[0].principal = round(Math.max(0, summary.principalA - deltaA));
    appState.members[1].principal = round(Math.max(0, summary.principalB - deltaB));
    appState.currentTotalAsset = round(Math.max(0, summary.currentTotalAsset - amount), 2);
  } else {
    appState.members[0].principal = round(summary.principalA + deltaA);
    appState.members[1].principal = round(summary.principalB + deltaB);
    appState.currentTotalAsset = round(summary.currentTotalAsset + amount, 2);
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
  saveState(appState);
  showSaveStatus(`${action === "deposit" ? "入金" : "出金"}已执行并记录`);
}

function bindOperationEvents() {
  if (!byId("operation-page")) return;

  const form = byId("ledger-form");
  const holdingsBody = byId("holdings-editor-body");
  const addHoldingBtn = byId("add-holding");
  const refreshQuotesBtn = byId("refresh-quotes");
  const capitalForm = byId("capital-form");
  const clearHistoryBtn = byId("clear-history");

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    syncOperationAndSave({
      notice: "快照已保存",
      logEntry: { type: "手动保存", detail: "更新账户快照" },
    });
  });

  form?.addEventListener("input", () => {
    syncOperationAndSave({ notice: "自动保存" });
  });

  holdingsBody?.addEventListener("input", () => {
    syncOperationAndSave({ notice: "持仓已更新" });
  });

  holdingsBody?.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.classList.contains("remove")) {
      button.closest("tr")?.remove();
      syncOperationAndSave({
        notice: "已删除持仓并保存",
        logEntry: { type: "持仓变更", detail: "删除一条持仓记录" },
      });
      return;
    }

    if (button.classList.contains("quote-refresh")) {
      const row = button.closest("tr");
      if (!row) return;
      const symbol = toTencentSymbol(row.querySelector('[data-field="code"]').value) || "未知代码";
      const ok = await refreshQuoteForEditorRow(row);
      if (ok) {
        syncOperationAndSave({
          notice: "实时行情已更新",
          logEntry: { type: "行情刷新", detail: `更新 ${symbol} 实时价格` },
        });
      }
    }
  });

  addHoldingBtn?.addEventListener("click", () => {
    const partial = collectOperationSnapshotFromDom(appState);
    partial.holdings.push(createHoldingRowTemplate());

    appState = {
      ...appState,
      ...partial,
      updatedAt: new Date().toISOString(),
    };

    renderEditorHoldingRows(appState.holdings);
    syncOperationAndSave({
      notice: "已新增持仓行",
      logEntry: { type: "持仓变更", detail: "新增一条持仓记录" },
    });
  });

  refreshQuotesBtn?.addEventListener("click", async () => {
    const rows = [...(holdingsBody?.querySelectorAll("tr") || [])];
    if (!rows.length) {
      showSaveStatus("暂无持仓可刷新");
      return;
    }

    const originalText = refreshQuotesBtn.textContent;
    refreshQuotesBtn.disabled = true;
    refreshQuotesBtn.textContent = "刷新中...";

    let successCount = 0;
    let failedCount = 0;

    for (const row of rows) {
      const ok = await refreshQuoteForEditorRow(row, { silent: true });
      if (ok) {
        successCount += 1;
      } else {
        failedCount += 1;
      }
    }

    syncOperationAndSave({
      notice:
        failedCount === 0
          ? `实时行情刷新完成：${successCount} 条`
          : `实时行情刷新完成：成功 ${successCount}，失败 ${failedCount}`,
      logEntry: {
        type: "行情刷新",
        detail: `批量刷新：成功 ${successCount}，失败 ${failedCount}`,
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
    saveState(appState);
    showSaveStatus("历史已清空");
  });
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
}

init();
