const STORAGE_KEY = "equity_ledger_rmb_v2";

function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createDefaultState() {
  return {
    members: [
      { name: "曾", principal: 31573 },
      { name: "陈", principal: 145182 },
    ],
    currentTotalAsset: 176754.95,
    cashAmount: 4122.55,
    updatedAt: "2026-02-25T12:41:00",
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
  };
}

const ui = {
  updatedAtText: document.getElementById("updated-at-text"),
  totalPrincipal: document.getElementById("total-principal"),
  currentAsset: document.getElementById("current-asset"),
  netValueLine: document.getElementById("net-value-line"),
  memberAPrincipalLine: document.getElementById("member-a-principal-line"),
  memberBPrincipalLine: document.getElementById("member-b-principal-line"),
  memberAAssetLine: document.getElementById("member-a-asset-line"),
  memberBAssetLine: document.getElementById("member-b-asset-line"),
  memberAProfitLine: document.getElementById("member-a-profit-line"),
  memberBProfitLine: document.getElementById("member-b-profit-line"),
  cashLine: document.getElementById("cash-line"),
  holdingTotalLine: document.getElementById("holding-total-line"),
  estimatedTotalLine: document.getElementById("estimated-total-line"),
  gapLine: document.getElementById("gap-line"),
  saveStatus: document.getElementById("save-status"),
  holdingsBody: document.getElementById("holdings-body"),
  holdingRowTemplate: document.getElementById("holding-row-template"),
  refreshQuotesBtn: document.getElementById("refresh-quotes"),
  addHoldingBtn: document.getElementById("add-holding"),
  setNowBtn: document.getElementById("set-now"),
  form: document.getElementById("ledger-form"),
  inputs: {
    memberAName: document.getElementById("member-a-name"),
    memberAPrincipal: document.getElementById("member-a-principal"),
    memberBName: document.getElementById("member-b-name"),
    memberBPrincipal: document.getElementById("member-b-principal"),
    currentTotalAsset: document.getElementById("current-total-asset"),
    cashAmount: document.getElementById("cash-amount"),
    updatedAt: document.getElementById("updated-at"),
  },
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function toDatetimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
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

  if (!Number.isFinite(price)) {
    throw new Error("行情价格无效");
  }

  return {
    name,
    code,
    price,
  };
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
    };

    return merged;
  } catch {
    return createDefaultState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createEmptyHolding() {
  return {
    id: uid(),
    code: "",
    name: "",
    quantity: 0,
    avgCost: 0,
    currentPrice: 0,
  };
}

function renderHoldingRows(holdings) {
  ui.holdingsBody.innerHTML = "";

  holdings.forEach((holding) => {
    const fragment = ui.holdingRowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    row.dataset.id = holding.id || uid();

    row.querySelector('[data-field="code"]').value = holding.code || "";
    row.querySelector('[data-field="name"]').value = holding.name || "";
    row.querySelector('[data-field="quantity"]').value = number(holding.quantity);
    row.querySelector('[data-field="avgCost"]').value = number(holding.avgCost);
    row.querySelector('[data-field="currentPrice"]').value = number(holding.currentPrice);

    ui.holdingsBody.appendChild(fragment);
  });

  updateHoldingRowsComputed();
}

function holdingsFromDom() {
  return [...ui.holdingsBody.querySelectorAll("tr")].map((row) => ({
    id: row.dataset.id || uid(),
    code: row.querySelector('[data-field="code"]').value.trim(),
    name: row.querySelector('[data-field="name"]').value.trim(),
    quantity: number(row.querySelector('[data-field="quantity"]').value),
    avgCost: number(row.querySelector('[data-field="avgCost"]').value),
    currentPrice: number(row.querySelector('[data-field="currentPrice"]').value),
  }));
}

function updateHoldingRowsComputed() {
  [...ui.holdingsBody.querySelectorAll("tr")].forEach((row) => {
    const quantity = number(row.querySelector('[data-field="quantity"]').value);
    const avgCost = number(row.querySelector('[data-field="avgCost"]').value);
    const currentPrice = number(row.querySelector('[data-field="currentPrice"]').value);

    const marketValue = quantity * currentPrice;
    const costValue = quantity * avgCost;
    const pnl = marketValue - costValue;

    row.querySelector('[data-field="marketValue"]').textContent = formatCurrency(marketValue);
    row.querySelector('[data-field="costValue"]').textContent = formatCurrency(costValue);

    const pnlCell = row.querySelector('[data-field="pnl"]');
    pnlCell.textContent = formatCurrency(pnl);
    pnlCell.classList.toggle("positive", pnl >= 0);
    pnlCell.classList.toggle("negative", pnl < 0);
  });
}

function collectStateFromDom() {
  const members = [
    {
      name: ui.inputs.memberAName.value.trim() || "成员A",
      principal: number(ui.inputs.memberAPrincipal.value),
    },
    {
      name: ui.inputs.memberBName.value.trim() || "成员B",
      principal: number(ui.inputs.memberBPrincipal.value),
    },
  ];

  const updatedAtInput = ui.inputs.updatedAt.value;

  return {
    members,
    currentTotalAsset: number(ui.inputs.currentTotalAsset.value),
    cashAmount: number(ui.inputs.cashAmount.value),
    updatedAt: updatedAtInput ? new Date(updatedAtInput).toISOString() : null,
    holdings: holdingsFromDom(),
  };
}

function fillEditor(state) {
  ui.inputs.memberAName.value = state.members[0]?.name || "";
  ui.inputs.memberAPrincipal.value = number(state.members[0]?.principal);
  ui.inputs.memberBName.value = state.members[1]?.name || "";
  ui.inputs.memberBPrincipal.value = number(state.members[1]?.principal);
  ui.inputs.currentTotalAsset.value = number(state.currentTotalAsset);
  ui.inputs.cashAmount.value = number(state.cashAmount);
  ui.inputs.updatedAt.value = toDatetimeLocalValue(state.updatedAt);

  renderHoldingRows(state.holdings);
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

  const holdingsWithCalc = state.holdings.map((h) => {
    const quantity = number(h.quantity);
    const avgCost = number(h.avgCost);
    const currentPrice = number(h.currentPrice);

    const marketValue = quantity * currentPrice;
    const costValue = quantity * avgCost;

    return {
      ...h,
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
    holdingMarketValueTotal,
    estimatedTotal,
    gap,
  };
}

function setProfitStyle(element, value) {
  element.classList.toggle("positive", value >= 0);
  element.classList.toggle("negative", value < 0);
}

function renderSummary(state) {
  const summary = computeSummary(state);

  ui.updatedAtText.textContent = formatDate(state.updatedAt);

  ui.totalPrincipal.textContent = formatCurrency(summary.totalPrincipal);
  ui.currentAsset.textContent = formatCurrency(summary.currentTotalAsset);
  ui.netValueLine.textContent = `当前净值 ${formatCurrency(summary.currentTotalAsset)}/${formatCurrency(summary.totalPrincipal)} = ${summary.netValue.toFixed(4)}`;

  ui.memberAPrincipalLine.textContent = `${summary.memberAName}本金：${formatCurrency(summary.principalA)}`;
  ui.memberBPrincipalLine.textContent = `${summary.memberBName}本金：${formatCurrency(summary.principalB)}`;

  ui.memberAAssetLine.textContent = `${summary.memberAName}资产：${summary.netValue.toFixed(4)} × ${formatCurrency(summary.principalA)} = ${formatCurrency(summary.assetA)}`;
  ui.memberBAssetLine.textContent = `${summary.memberBName}资产：${summary.netValue.toFixed(4)} × ${formatCurrency(summary.principalB)} = ${formatCurrency(summary.assetB)}`;

  ui.memberAProfitLine.textContent = `${summary.memberAName}收益：${formatCurrency(summary.assetA)} - ${formatCurrency(summary.principalA)} = ${formatCurrency(summary.profitA)}`;
  ui.memberBProfitLine.textContent = `${summary.memberBName}收益：${formatCurrency(summary.assetB)} - ${formatCurrency(summary.principalB)} = ${formatCurrency(summary.profitB)}`;

  setProfitStyle(ui.memberAProfitLine, summary.profitA);
  setProfitStyle(ui.memberBProfitLine, summary.profitB);

  ui.cashLine.textContent = `持有现金：${formatCurrency(state.cashAmount)}`;
  ui.holdingTotalLine.textContent = `持仓市值合计：${formatCurrency(summary.holdingMarketValueTotal)}`;
  ui.estimatedTotalLine.textContent = `持仓+现金：${formatCurrency(summary.estimatedTotal)}`;

  ui.gapLine.textContent = `账户总资产 - (持仓+现金)：${formatCurrency(summary.gap)}`;
  setProfitStyle(ui.gapLine, -summary.gap);
}

let saveNoticeTimer;

function showSaveStatus(text) {
  ui.saveStatus.textContent = text;
  clearTimeout(saveNoticeTimer);
  saveNoticeTimer = setTimeout(() => {
    ui.saveStatus.textContent = "数据已自动保存到本地";
  }, 1000);
}

function syncAndSave({ notice = "已保存" } = {}) {
  const nextState = collectStateFromDom();
  updateHoldingRowsComputed();
  renderSummary(nextState);
  saveState(nextState);
  showSaveStatus(notice);
}

async function refreshQuoteForRow(row, { silent = false } = {}) {
  const codeInput = row.querySelector('[data-field="code"]');
  const nameInput = row.querySelector('[data-field="name"]');
  const priceInput = row.querySelector('[data-field="currentPrice"]');
  const quoteBtn = row.querySelector(".quote-refresh");

  const symbol = toTencentSymbol(codeInput.value);
  if (!symbol) {
    if (!silent) showSaveStatus("股票代码格式不正确，示例：300807 或 sz300807");
    return false;
  }

  const originalText = quoteBtn.textContent;
  quoteBtn.disabled = true;
  quoteBtn.textContent = "刷新中";

  try {
    const quote = await fetchTencentQuote(symbol);
    if (!nameInput.value.trim() && quote.name) {
      nameInput.value = quote.name;
    }
    priceInput.value = quote.price;
    updateHoldingRowsComputed();
    return true;
  } catch (error) {
    if (!silent) showSaveStatus(`获取 ${symbol} 行情失败`);
    return false;
  } finally {
    quoteBtn.disabled = false;
    quoteBtn.textContent = originalText;
  }
}

function init() {
  const state = loadState();
  fillEditor(state);
  renderSummary(state);

  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    syncAndSave({ notice: "快照已保存" });
  });

  ui.form.addEventListener("input", () => {
    syncAndSave({ notice: "自动保存" });
  });

  ui.holdingsBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.classList.contains("remove")) {
      button.closest("tr")?.remove();
      syncAndSave({ notice: "已删除持仓并保存" });
      return;
    }

    if (button.classList.contains("quote-refresh")) {
      const row = button.closest("tr");
      if (!row) return;
      const ok = await refreshQuoteForRow(row);
      if (ok) {
        syncAndSave({ notice: "实时行情已更新" });
      }
    }
  });

  ui.holdingsBody.addEventListener("input", () => {
    syncAndSave({ notice: "持仓已更新" });
  });

  ui.addHoldingBtn.addEventListener("click", () => {
    const current = collectStateFromDom();
    current.holdings.push(createEmptyHolding());
    renderHoldingRows(current.holdings);
    syncAndSave({ notice: "已新增持仓行" });
  });

  ui.refreshQuotesBtn.addEventListener("click", async () => {
    const rows = [...ui.holdingsBody.querySelectorAll("tr")];
    if (!rows.length) {
      showSaveStatus("暂无持仓可刷新");
      return;
    }

    const originalText = ui.refreshQuotesBtn.textContent;
    ui.refreshQuotesBtn.disabled = true;
    ui.refreshQuotesBtn.textContent = "刷新中...";

    let successCount = 0;
    let failedCount = 0;

    for (const row of rows) {
      const ok = await refreshQuoteForRow(row, { silent: true });
      if (ok) {
        successCount += 1;
      } else {
        failedCount += 1;
      }
    }

    syncAndSave({
      notice:
        failedCount === 0
          ? `实时行情刷新完成：${successCount} 条`
          : `实时行情刷新完成：成功 ${successCount}，失败 ${failedCount}`,
    });

    ui.refreshQuotesBtn.disabled = false;
    ui.refreshQuotesBtn.textContent = originalText;
  });

  ui.setNowBtn.addEventListener("click", () => {
    ui.inputs.updatedAt.value = toDatetimeLocalValue(new Date().toISOString());
    syncAndSave({ notice: "已更新为当前时间" });
  });
}

init();
