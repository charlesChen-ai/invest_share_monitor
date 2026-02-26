function renderDashboardHoldings(rows, members) {
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
      ownerText(h.owner, members),
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
  const memberRows = summary.memberRows;

  setText("updated-at-text", formatDate(state.updatedAt));
  setText("current-asset", formatCurrency(summary.currentTotalAsset));
  setText(
    "current-asset-composition-hint",
    `总资产口径：股票账户快照 ${formatCurrency(summary.stockSnapshotAsset)} + 基金市值 ${formatCurrency(summary.fundMarketValueTotal)}`
  );
  setText("total-principal-hint", `总本金：${formatCurrency(summary.totalPrincipal)}`);

  const totalProfit = summary.totalProfit;
  const totalProfitBase = summary.totalPrincipal + summary.fundCostTotal;
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

  renderMemberTextRows(
    "member-principal-list",
    memberRows.map((member) => ({
      text: `${member.name}本金：${formatCurrency(member.principal)} · 占比 ${(member.principalRatio * 100).toFixed(2)}%`,
    }))
  );

  setText("net-value-line", `股票账户净值：${summary.netValue.toFixed(4)}`);
  setText(
    "net-value-formula",
    `${formatCurrency(summary.stockSnapshotAsset)} ÷ ${formatCurrency(summary.totalPrincipal)} = ${summary.netValue.toFixed(4)}`
  );

  const allocationBase = memberRows.reduce((sum, member) => sum + member.displayAsset, 0);
  const allocationContainer = byId("member-allocation-list");
  if (allocationContainer) {
    allocationContainer.innerHTML = "";
    memberRows.forEach((member, index) => {
      const allocation = allocationBase > 0 ? (member.displayAsset / allocationBase) * 100 : 0;
      const correction = member.displayAsset - (member.assignedAssetStock + member.assignedAssetFund);
      const correctionText =
        Math.abs(correction) > 0.01 ? ` + 校准项 ${formatCurrency(correction)}` : "";
      const formula = `股票账户资产 ${formatCurrency(member.assignedAssetStock)} + 基金归属资产 ${formatCurrency(
        member.assignedAssetFund
      )}${correctionText} = ${formatCurrency(member.displayAsset)}`;
      const idBase = `dashboard-alloc-${member.id}-${index}`;
      const wrapper = document.createElement("div");
      wrapper.className = "alloc-item";
      wrapper.innerHTML = `
        <div class="calc-group">
          <button id="${idBase}-line" class="calc-toggle alloc-toggle" type="button" data-formula-id="${idBase}-formula" aria-expanded="false">
            ${textEscape(member.name)}资产：${textEscape(formatCurrency(member.displayAsset))} · 占比 ${textEscape(allocation.toFixed(2))}%
          </button>
          <p id="${idBase}-formula" class="calc-formula">${textEscape(formula)}</p>
        </div>
        <div class="alloc-track${index % 2 === 1 ? " alt" : ""}">
          <i style="width:${Math.max(0, Math.min(100, allocation)).toFixed(2)}%"></i>
        </div>
      `;
      allocationContainer.appendChild(wrapper);
      const allocLine = byId(`${idBase}-line`);
      const allocFormula = byId(`${idBase}-formula`);
      setPositiveNegative(allocLine, member.assignedProfit);
      allocLine?.addEventListener("click", () => {
        const expanded = allocLine.getAttribute("aria-expanded") === "true";
        allocLine.setAttribute("aria-expanded", expanded ? "false" : "true");
        allocFormula?.classList.toggle("open", !expanded);
      });
    });
  }

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

  setText("structure-profit-badge", `累计收益（账户口径）：${formatCurrency(totalProfit)}`);
  setPositiveNegative(byId("structure-profit-badge"), totalProfit);
  const topOwners = [...memberRows]
    .sort((a, b) => b.assignedAsset - a.assignedAsset)
    .slice(0, 3)
    .map((member) => `${member.name} ${formatCurrency(member.assignedAsset)}`)
    .join(" · ");
  setText("structure-owner-badge", `归属资产：${topOwners || "暂无"}`);

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

  renderMemberCalcRows(
    "member-profit-list",
    memberRows.map((member) => ({
      memberId: member.id,
      line: `${member.name}收益：${formatCurrency(member.assignedProfit)}`,
      formula: `股票收益 ${formatCurrency(member.assignedProfitStock)} + 基金收益 ${formatCurrency(
        member.assignedProfitFund
      )} = ${formatCurrency(member.assignedProfit)}`,
      value: member.assignedProfit,
    }))
  );

  const todayBaseline = getTodayProfitBaseline(state, summary);
  const todaySummary = computeTodayProfitByMember(summary, todayBaseline);
  const todayByMember = todaySummary.rows;
  const todayTotalProfit = todaySummary.totalProfit;
  const todayBaseAsset = todaySummary.baseAsset;
  const todayTotalProfitRate = todaySummary.rate;

  setText("today-profit-total-value", formatCurrency(todayTotalProfit));
  setText("today-profit-total-rate", `当日收益率（股票）：${todayTotalProfitRate.toFixed(2)}%`);
  renderMemberTextRows(
    "today-profit-list",
    todayByMember.map((member) => ({
      text: `${member.name}：${formatCurrency(member.todayProfit)}`,
      value: member.todayProfit,
      className: "today-chip",
    }))
  );
  setText("today-profit-base-line", `当日基线股票市值：${formatCurrency(todayBaseAsset)}`);
  setPositiveNegative(byId("today-profit-total-value"), todayTotalProfit);
  setPositiveNegative(byId("today-profit-total-rate"), todayTotalProfitRate);

  setText("stock-total-line", `股票市值：${formatCurrency(summary.stockMarketValueTotal)}`);
  setText("fund-total-line", `基金市值：${formatCurrency(summary.fundMarketValueTotal)}`);
  setText("cash-line", `持有现金：${formatCurrency(state.cashAmount)}`);
  setText("holding-total-line", `持仓市值合计：${formatCurrency(summary.holdingMarketValueTotal)}`);
  setText("holding-total-formula", "按各资产行：份额/股数 × 当前净值/市价，加总得到持仓市值");
  setText("estimated-total-line", `估算资产合计（持仓+现金）：${formatCurrency(summary.estimatedTotal)}`);
  setText("estimated-total-formula", `${formatCurrency(summary.holdingMarketValueTotal)} + ${formatCurrency(state.cashAmount)} = ${formatCurrency(summary.estimatedTotal)}`);
  renderMemberTextRows(
    "owner-summary-list",
    memberRows.map((member) => ({
      text: `${member.name}归属资产：股票账户 ${formatCurrency(member.assignedAssetStock)} + 基金 ${formatCurrency(
        member.assignedAssetFund
      )} = ${formatCurrency(member.assignedAsset)}`,
    }))
  );

  setText("gap-line", `核算差额：${formatCurrency(summary.gap)}`);
  setText("gap-formula", `${formatCurrency(summary.currentTotalAsset)} - ${formatCurrency(summary.estimatedTotal)} = ${formatCurrency(summary.gap)}`);
  setPositiveNegative(byId("gap-line"), -summary.gap);

  renderProfitCurve(state, summary);
  renderDashboardHoldings(summary.holdingsWithCalc, summary.members);
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

window.DashboardUI = {
  renderDashboardHoldings,
  renderDashboard,
  renderProfitCurve,
};
