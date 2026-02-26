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

function renderStockDealsTable(state) {
  const body = byId("stock-deals-body");
  if (!body) return;

  const members = normalizeMembersCollection(state.members);
  const deals = (Array.isArray(state.stockDeals) ? state.stockDeals : [])
    .map((deal) => normalizeStockDeal(deal, members))
    .slice()
    .reverse();

  body.innerHTML = "";
  if (!deals.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="9">暂无股票交易记录</td>';
    body.appendChild(row);
    return;
  }

  deals.forEach((deal) => {
    const row = document.createElement("tr");
    row.dataset.dealId = deal.id;
    const amount = deal.quantity * deal.price;
    row.innerHTML = `
      <td>${textEscape(formatDate(deal.at))}</td>
      <td>${textEscape(deal.type === "buy" ? "买入" : "卖出")}</td>
      <td>${textEscape(deal.code)}</td>
      <td>${textEscape(ownerText(deal.owner, members))}</td>
      <td>${textEscape(formatCurrency(deal.price))}</td>
      <td>${textEscape(formatUnits(deal.quantity))}</td>
      <td>${textEscape(formatCurrency(amount))}</td>
      <td>${textEscape(deal.note || "-")}</td>
      <td><button type="button" class="remove-stock-deal remove">删除</button></td>
    `;
    body.appendChild(row);
  });
}

function renderSnapshotDetail(snapshot) {
  const rollbackTrigger = byId("snapshot-rollback-trigger");
  const rollbackGuard = byId("snapshot-rollback-guard");
  const rollbackInput = byId("snapshot-rollback-input");

  if (rollbackInput) rollbackInput.value = "";
  rollbackGuard?.classList.add("hidden");

  if (!snapshot) {
    setText("snapshot-detail-title", "请选择左侧快照");
    setText("snapshot-detail-time", "时间：-");
    setText("snapshot-detail-asset", "总资产：-");
    setText("snapshot-detail-profit", "总收益：-");
    setText("snapshot-detail-net", "股票净值：-");
    renderMemberTextRows("snapshot-detail-members-list", [{ text: "成员信息：-" }]);
    setText("snapshot-detail-member-a", "成员一：-");
    setText("snapshot-detail-member-b", "成员二：-");
    setText("snapshot-detail-holdings", "持仓：-");
    setText("snapshot-detail-note", "说明：-");
    if (rollbackTrigger) rollbackTrigger.disabled = true;
    return;
  }

  const snapshotState = versionStateFromSnapshot(snapshot);
  const summary = computeSummary(snapshotState);

  setText("snapshot-detail-title", `${snapshot.type || "历史快照"} · ${formatCurrency(summary.currentTotalAsset)}`);
  setText("snapshot-detail-time", `时间：${formatDate(snapshot.at)}`);
  setText("snapshot-detail-asset", `总资产：${formatCurrency(summary.currentTotalAsset)}`);
  setText("snapshot-detail-profit", `总收益：${formatCurrency(summary.totalProfit)}`);
  setText("snapshot-detail-net", `股票净值：${summary.netValue.toFixed(4)}`);
  const snapshotMemberLines = summary.memberRows.map((member) => ({
    text: `${member.name}：本金 ${formatCurrency(member.principal)} · 展示资产 ${formatCurrency(member.displayAsset)}`,
  }));
  renderMemberTextRows("snapshot-detail-members-list", snapshotMemberLines);
  setText(
    "snapshot-detail-member-a",
    `${summary.memberAName}：本金 ${formatCurrency(summary.principalA)} · 归属资产 ${formatCurrency(summary.assignedAssetA)}`
  );
  setText(
    "snapshot-detail-member-b",
    `${summary.memberBName}：本金 ${formatCurrency(summary.principalB)} · 归属资产 ${formatCurrency(summary.assignedAssetB)}`
  );
  setText(
    "snapshot-detail-holdings",
    `持仓：${summary.holdingsWithCalc.length} 条（股票 ${summary.stockHoldingCount} / 基金 ${summary.fundHoldingCount}）`
  );
  setText("snapshot-detail-note", `说明：${snapshot.detail || "无"}`);
  setPositiveNegative(byId("snapshot-detail-profit"), summary.totalProfit);

  if (rollbackTrigger) rollbackTrigger.disabled = false;
}

function renderVersionHistory(state) {
  const body = byId("snapshot-history-body");
  if (!body) return;

  const confirmCode = byId("snapshot-rollback-code");
  if (confirmCode) confirmCode.textContent = SNAPSHOT_ROLLBACK_CONFIRM_TEXT;

  const history = [...getVersionHistory(state)].reverse();
  body.innerHTML = "";

  if (!history.length) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>--</td><td>--</td><td>--</td><td>--</td><td>暂无快照</td>";
    body.appendChild(row);
    renderSnapshotDetail(null);
    return;
  }

  const selectedExists = history.some((item) => item.id === selectedVersionSnapshotId);
  if (!selectedExists) {
    selectedVersionSnapshotId = history[0].id;
  }

  history.forEach((item) => {
    const snapshotState = versionStateFromSnapshot(item);
    const summary = computeSummary(snapshotState);
    const row = document.createElement("tr");
    row.dataset.versionId = item.id;
    if (item.id === selectedVersionSnapshotId) row.classList.add("selected");

    const timeCell = document.createElement("td");
    timeCell.textContent = formatDate(item.at);
    const typeCell = document.createElement("td");
    typeCell.textContent = item.type || "快照";
    const assetCell = document.createElement("td");
    assetCell.textContent = formatCurrency(summary.currentTotalAsset);
    const profitCell = document.createElement("td");
    profitCell.textContent = formatCurrency(summary.totalProfit);
    setPositiveNegative(profitCell, summary.totalProfit);
    const countCell = document.createElement("td");
    countCell.textContent = `${summary.holdingsWithCalc.length} 条`;

    row.appendChild(timeCell);
    row.appendChild(typeCell);
    row.appendChild(assetCell);
    row.appendChild(profitCell);
    row.appendChild(countCell);

    body.appendChild(row);
  });

  const active = history.find((item) => item.id === selectedVersionSnapshotId) || history[0];
  renderSnapshotDetail(active);
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

function renderEditorHoldingRows(holdings, members = []) {
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
    const ownerSelect = row.querySelector('[data-field="owner"]');
    ownerSelect.dataset.ownerValue = normalizedOwnerForMembers(normalized.owner, normalizeMembersCollection(members));
    ownerSelect.value = ownerSelect.dataset.ownerValue;
    row.querySelector('[data-field="code"]').value = normalized.code || "";
    row.querySelector('[data-field="name"]').value = normalized.name || "";
    row.querySelector('[data-field="quantity"]').value = number(normalized.quantity);
    row.querySelector('[data-field="avgCost"]').value = number(normalized.avgCost);
    row.querySelector('[data-field="currentPrice"]').value = number(normalized.currentPrice);
    if (!isFund) {
      row.dataset.stockKey = stockDealKey(normalized, normalizeMembersCollection(members));
    }

    (isFund ? fundBody : stockBody).appendChild(fragment);
  });

  renderHoldingOwnerOptions({ members });
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

function renderMemberEditorRows(members) {
  const body = byId("member-editor-body");
  if (!body) return;

  const normalizedMembers = normalizeMembersCollection(members);
  body.innerHTML = "";

  normalizedMembers.forEach((member) => {
    const row = document.createElement("tr");
    row.dataset.memberId = member.id;
    row.dataset.principal = String(round(member.principal, 4));
    row.innerHTML = `
      <td><input data-field="name" type="text" value="${textEscape(member.name)}" placeholder="成员名称" /></td>
      <td data-field="principal">${textEscape(formatCurrency(member.principal))}</td>
      <td>
        <select data-field="action">
          <option value="deposit">认购（入金）</option>
          <option value="withdraw">赎回（出金）</option>
        </select>
      </td>
      <td><input data-field="amount" type="number" min="0" step="0.01" placeholder="0.00" /></td>
      <td><input data-field="note" type="text" placeholder="可选备注" /></td>
      <td>
        <div class="row-actions">
          <button type="button" class="member-apply">执行</button>
          <button type="button" class="remove member-remove"${normalizedMembers.length <= 1 ? " disabled" : ""}>删除</button>
        </div>
      </td>
    `;
    body.appendChild(row);
  });
}

function collectMembersFromDom(state) {
  const rows = [...(byId("member-editor-body")?.querySelectorAll("tr") || [])];
  const fallbackMembers = normalizeMembersCollection(state.members);
  const fallbackById = new Map(fallbackMembers.map((member) => [member.id, member]));

  const members = rows.map((row, index) => {
    const id = String(row.dataset.memberId || `member-${index + 1}`).trim() || `member-${index + 1}`;
    const fallback = fallbackById.get(id) || {};
    const nameInput = row.querySelector('[data-field="name"]');
    const name = String(nameInput?.value || "").trim() || String(fallback.name || `成员${index + 1}`);
    const principal = Math.max(0, number(row.dataset.principal ?? fallback.principal));
    return { id, name, principal };
  });

  return members.length ? members : fallbackMembers;
}

function collectOperationSnapshotFromDom(state) {
  const holdings = collectEditorHoldingsFromDom();
  const stockPositions = holdings
    .filter((holding) => holding.assetType === "stock")
    .map((holding) => ({
      id: holding.id,
      owner: holding.owner,
      code: holding.code,
      name: holding.name,
      quantity: round(number(holding.quantity), 6),
      avgCost: round(number(holding.avgCost), 6),
      currentPrice: round(number(holding.currentPrice), 6),
    }));
  return {
    members: collectMembersFromDom(state),
    currentTotalAsset: number(state.currentTotalAsset),
    cashAmount: number(state.cashAmount),
    holdings,
    stockPositions,
    stockDeals: Array.isArray(state.stockDeals) ? [...state.stockDeals] : [],
  };
}

function renderOperationTargetOptions(state) {
  const select = byId("capital-target");
  if (!select) return;

  const members = normalizeMembersCollection(state.members);
  const previous = normalizedOwnerForMembers(select.value, members);
  select.innerHTML = buildOwnerOptionHtml(members, "capital");
  select.value = previous;
  if (!select.value) select.value = "proportional";
}

function renderStockDealOwnerOptions(state) {
  const select = byId("stock-deal-owner");
  if (!select) return;

  const members = normalizeMembersCollection(state.members);
  const previous = normalizedOwnerForMembers(select.value, members);
  select.innerHTML = buildOwnerOptionHtml(members, "holding");
  select.value = previous;
  if (!select.value) select.value = "proportional";
}

function renderHoldingOwnerOptions(state) {
  const members = normalizeMembersCollection(state.members);

  document
    .querySelectorAll('#stock-editor-body select[data-field="owner"], #fund-editor-body select[data-field="owner"]')
    .forEach((select) => {
      const previous = normalizedOwnerForMembers(select.value || select.dataset.ownerValue, members);
      select.innerHTML = buildOwnerOptionHtml(members, "holding");
      select.value = previous;
      if (!select.value) select.value = "proportional";
      select.dataset.ownerValue = select.value;
      if (select.closest("tr")?.dataset.assetType === "stock") {
        select.disabled = true;
      }
    });
}

function renderOperationPreview(state) {
  const preview = byId("capital-preview");
  if (!preview) return;

  const summary = computeSummary(state);
  const action = byId("capital-action")?.value || "deposit";
  const target = normalizedOwnerForMembers(byId("capital-target")?.value || "proportional", summary.members);
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
  const deltasByMember = resolveCapitalDeltas(summary, target, principalDelta);
  const deltaLines = summary.memberRows
    .map((member) => `${member.name} ${formatCurrency(number(deltasByMember[member.id]))}`)
    .join("，");

  const sign = action === "deposit" ? "+" : "-";
  preview.textContent = `预览：${action === "deposit" ? "入金" : "出金"} ${formatCurrency(amount)}，股票净值 ${summary.netValue.toFixed(
    4
  )}，本金份额 ${sign}${formatCurrency(principalDelta)}（${deltaLines}）`;
}

function renderStockDealPreview(state) {
  const preview = byId("stock-deal-preview");
  if (!preview) return;

  const summary = computeSummary(state);
  const type = byId("stock-deal-type")?.value === "sell" ? "sell" : "buy";
  const owner = normalizedOwnerForMembers(byId("stock-deal-owner")?.value || "proportional", summary.members);
  const codeRaw = String(byId("stock-deal-code")?.value || "").trim();
  const matchedCode = normalizeStockCode(codeRaw).match(/(\d{6})/);
  const code = matchedCode ? matchedCode[1] : normalizeStockCode(codeRaw);
  const quantity = number(byId("stock-deal-quantity")?.value);
  const price = number(byId("stock-deal-price")?.value);

  if (!code || quantity <= 0 || price <= 0) {
    preview.textContent = "通过交易记录生成仓位：累计买卖数量 -> 当前持仓，累计成本 -> 持仓均价";
    return;
  }

  const key = stockDealKey({ owner, code }, summary.members);
  const row = summary.holdingsWithCalc.find((item) => item.assetType === "stock" && stockDealKey(item, summary.members) === key);
  const currentQty = number(row?.quantity);
  const currentCost = number(row?.costValue);
  const nextQty = type === "buy" ? currentQty + quantity : Math.max(0, currentQty - quantity);
  const nextCost =
    type === "buy"
      ? currentCost + quantity * price
      : Math.max(0, currentCost - (currentQty > 0 ? (currentCost / currentQty) * Math.min(currentQty, quantity) : 0));
  const nextAvg = nextQty > 0 ? nextCost / nextQty : 0;

  preview.textContent = `预览：${type === "buy" ? "买入" : "卖出"} ${code} ${formatUnits(quantity)} 股，成交额 ${formatCurrency(
    quantity * price
  )}；交易后持仓 ${formatUnits(nextQty)} 股，持仓均价约 ${formatCurrency(nextAvg)}（归属：${ownerText(owner, summary.members)}）`;
}

function renderOperationSummary(state) {
  if (!byId("operation-page")) return;

  const summary = computeSummary(state);
  const totalProfit = summary.totalProfit;
  const principalRatio = summary.totalPrincipal > 0 ? (summary.currentTotalAsset / summary.totalPrincipal) * 100 : 0;
  const memberRows = summary.memberRows;

  setText("operation-updated-at", formatDate(state.updatedAt));
  setText("op-total-principal-value", formatCurrency(summary.totalPrincipal));
  setText("op-current-asset-value", formatCurrency(summary.currentTotalAsset));
  setText("op-net-value-value", summary.netValue.toFixed(4));
  setText("op-stock-snapshot-line", `股票资产快照：${formatCurrency(summary.stockSnapshotAsset)}`);
  setText("op-total-asset-formula", `总资产 = ${formatCurrency(summary.stockSnapshotAsset)} + ${formatCurrency(summary.fundMarketValueTotal)}`);
  setText("op-progress-caption", `资产本金比：${principalRatio.toFixed(2)}%`);
  setText("op-total-profit-chip", `累计收益：${formatCurrency(totalProfit)}`);
  renderMemberTextRows(
    "op-member-list",
    memberRows.map((member) => ({
      text: `${member.name}本金：${formatCurrency(member.principal)} · 占比 ${(member.principalRatio * 100).toFixed(
        2
      )}% · 归属资产 ${formatCurrency(member.assignedAsset)} · 总收益 ${formatCurrency(member.assignedProfit)}`,
      value: member.assignedProfit,
    }))
  );
  setText(
    "op-member-a-line",
    `${summary.memberAName}本金：${formatCurrency(summary.principalA)} · 占比 ${(summary.principalRatioA * 100).toFixed(2)}% · 归属持仓 ${formatCurrency(summary.assignedAssetA)}`
  );
  setText(
    "op-member-b-line",
    `${summary.memberBName}本金：${formatCurrency(summary.principalB)} · 占比 ${(summary.principalRatioB * 100).toFixed(2)}% · 归属持仓 ${formatCurrency(summary.assignedAssetB)}`
  );
  setPositiveNegative(byId("op-total-profit-chip"), totalProfit);

  const progressFill = byId("op-progress-fill");
  if (progressFill) {
    progressFill.style.width = `${Math.max(0, Math.min(100, principalRatio)).toFixed(2)}%`;
  }

  const todayBaseline = getTodayProfitBaseline(state, summary);
  const todaySummary = computeTodayProfitByMember(summary, todayBaseline);
  const todayTotalProfit = todaySummary.totalProfit;
  const todayRate = todaySummary.rate;

  setText("op-today-total-chip", `今日收益（股票）：${formatCurrency(todayTotalProfit)} · ${todayRate.toFixed(2)}%`);
  renderMemberTextRows(
    "op-today-member-list",
    todaySummary.rows.map((member) => ({
      text: `${member.name}：${formatCurrency(member.todayProfit)}`,
      value: member.todayProfit,
      className: "today-chip",
    }))
  );
  const todayAProfit = todaySummary.rows[0]?.todayProfit || 0;
  const todayBProfit = todaySummary.rows[1]?.todayProfit || 0;
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
  const stockDealsCount = Array.isArray(state.stockDeals) ? state.stockDeals.length : 0;
  const logsCount = Array.isArray(state.logs) ? state.logs.length : 0;
  const snapshotsCount = Array.isArray(state.snapshots) ? state.snapshots.length : 0;
  setText(
    "op-meta-holdings",
    `资产条目：${holdingsCount}（股${summary.stockHoldingCount} / 基${summary.fundHoldingCount}） · 股票交易 ${stockDealsCount} 条`
  );
  setText("op-meta-logs", `操作记录：${logsCount}`);
  setText("op-meta-snapshots", `快照数量：${snapshotsCount}`);

  renderOperationTargetOptions(state);
  renderStockDealOwnerOptions(state);
  renderHoldingOwnerOptions(state);
  renderOperationPreview(state);
  renderStockDealPreview(state);
  renderStockDealsTable(state);
  renderVersionHistory(state);
  renderHistory("history-body-operation", state.logs || []);
}

function fillOperationForm(state) {
  if (!byId("operation-page")) return;

  const totalAsset = byId("current-total-asset");
  const cash = byId("cash-amount");
  const summary = computeSummary(state);

  if (totalAsset) totalAsset.value = number(summary.stockEstimatedTotal);
  if (cash) cash.value = number(state.cashAmount);

  renderMemberEditorRows(state.members || []);
  renderEditorHoldingRows(state.holdings || [], state.members || []);
}

window.OperationUI = {
  renderHistory,
  renderStockDealsTable,
  renderSnapshotDetail,
  renderVersionHistory,
  createHoldingRowTemplate,
  renderEditorHoldingRows,
  updateEditorHoldingComputed,
  collectEditorHoldingsFromDom,
  renderMemberEditorRows,
  collectMembersFromDom,
  collectOperationSnapshotFromDom,
  renderOperationTargetOptions,
  renderStockDealOwnerOptions,
  renderHoldingOwnerOptions,
  renderOperationPreview,
  renderStockDealPreview,
  renderOperationSummary,
  fillOperationForm,
};
