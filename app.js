(function initFundLedgerApp(global) {
  const storage = global.LedgerStorage || {};
  const core = global.LedgerCore || {};

  const REQUIRED_STORAGE_APIS = ["uid", "number", "dateKeyOf", "createEmptyState", "normalizeState", "loadState", "saveState", "addLog"];
  const REQUIRED_CORE_APIS = ["round", "normalizeCode", "normalizeMembers", "computeSummary", "createDailyBaseline"];

  const missingStorage = REQUIRED_STORAGE_APIS.filter((name) => typeof storage[name] !== "function");
  const missingCore = REQUIRED_CORE_APIS.filter((name) => typeof core[name] !== "function");

  if (missingStorage.length || missingCore.length) {
    throw new Error(`关键模块未加载: storage(${missingStorage.join(",")}) core(${missingCore.join(",")})`);
  }

  const { uid, number, dateKeyOf, createEmptyState, normalizeState, loadState, saveState, addLog } = storage;
  const { round, normalizeCode, computeSummary, createDailyBaseline } = core;

  let appState = normalizeState(loadState());
  let fileHandle = null;
  let fileSaveInFlight = false;
  let fileSaveQueued = false;
  let saveStatusTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      maximumFractionDigits: 2,
    }).format(number(value));
  }

  function formatUnits(value, digits = 4) {
    return new Intl.NumberFormat("zh-CN", {
      maximumFractionDigits: digits,
    }).format(number(value));
  }

  function formatPercent(value) {
    return `${number(value).toFixed(2)}%`;
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

  function toTencentSymbol(rawCode) {
    const code = normalizeCode(rawCode);
    if (/^(SH|SZ|BJ)\d{6}$/.test(code)) return code.toLowerCase();

    const match = code.match(/(\d{6})/);
    if (!match) return null;

    const digits = match[1];
    if (/^[659]/.test(digits)) return `sh${digits}`;
    if (/^[03]/.test(digits)) return `sz${digits}`;
    if (/^[48]/.test(digits)) return `bj${digits}`;
    return null;
  }

  function parseTencentQuote(raw, symbol) {
    const payload = String(raw || "").trim();
    if (!payload || !payload.includes("~")) {
      throw new Error("行情返回为空或格式异常");
    }

    const body = payload.replace(/^"+|"+$/g, "");
    const parts = body.split("~");
    const name = String(parts[1] || "").trim();
    const code = normalizeCode(parts[2] || symbol.replace(/^[a-z]+/i, ""));
    const price = number(parts[3]);

    if (price <= 0) throw new Error("行情价格无效");
    return { code, name, price };
  }

  function fetchTencentQuote(symbol) {
    return new Promise((resolve, reject) => {
      const variableName = `v_${symbol}`;
      const script = document.createElement("script");
      let timeoutId = null;

      function cleanup() {
        script.onerror = null;
        script.onload = null;
        script.remove();
        if (timeoutId) clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error("行情请求超时"));
      }, 8000);

      delete window[variableName];
      script.src = `https://qt.gtimg.cn/q=${symbol}&_=${Date.now()}`;
      script.charset = "gbk";

      script.onload = () => {
        const payload = window[variableName];
        cleanup();
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

  async function fetchQuoteByCode(rawCode) {
    const symbol = toTencentSymbol(rawCode);
    if (!symbol) throw new Error("代码格式不正确");
    return fetchTencentQuote(symbol);
  }

  function setText(id, value) {
    const el = byId(id);
    if (el) el.textContent = value;
  }

  function setPositiveNegative(el, value) {
    if (!el) return;
    el.classList.toggle("positive", number(value) >= 0);
    el.classList.toggle("negative", number(value) < 0);
  }

  function clearPositiveNegative(el) {
    if (!el) return;
    el.classList.remove("positive", "negative");
  }

  function isEmptyLedger(summary) {
    return (
      summary.members.length === 0 &&
      summary.subscriptions.length === 0 &&
      (summary.withdrawals || []).length === 0 &&
      summary.trades.length === 0 &&
      summary.totalShares <= 0
    );
  }

  function showSaveStatus(text) {
    const el = byId("save-status");
    if (!el) return;
    el.textContent = text;
    clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => {
      el.textContent = "已保存到本地";
    }, 1500);
  }

  function setFileStatus(text) {
    const el = byId("file-status");
    if (el) el.textContent = text;
  }

  function supportsFsAccess() {
    return typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";
  }

  async function writeStateToConnectedFile() {
    if (!fileHandle) return;

    if (fileSaveInFlight) {
      fileSaveQueued = true;
      return;
    }

    fileSaveInFlight = true;
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(normalizeState(appState), null, 2));
      await writable.close();
      setFileStatus(`本地文件已更新：${fileHandle.name || "ledger_data.json"}`);
    } catch (error) {
      console.warn("写入本地文件失败", error);
      setFileStatus(`本地文件写入失败：${error?.message || "未知错误"}`);
    } finally {
      fileSaveInFlight = false;
      if (fileSaveQueued) {
        fileSaveQueued = false;
        writeStateToConnectedFile();
      }
    }
  }

  function downloadJsonFile(filename, content) {
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function persistState({ notice = "已保存到本地" } = {}) {
    appState.updatedAt = new Date().toISOString();
    appState = saveState(appState);
    writeStateToConnectedFile();
    renderAll();
    if (notice) showSaveStatus(notice);
  }

  function ensureTodayBaseline(summary) {
    if (!appState.dailyBaselines || typeof appState.dailyBaselines !== "object") {
      appState.dailyBaselines = {};
    }

    const key = dateKeyOf();
    if (!appState.dailyBaselines[key]) {
      appState.dailyBaselines[key] = createDailyBaseline(summary);
      appState = saveState(appState);
      writeStateToConnectedFile();
    }

    return appState.dailyBaselines[key];
  }

  function computeTodaySummary(summary) {
    const baseline = ensureTodayBaseline(summary);
    const rows = summary.memberRows.map((member) => {
      const baseAsset = number(baseline.memberAssets?.[member.id]);
      const baseInvested = number(baseline.memberInvested?.[member.id]);
      const netFlowToday = member.invested - baseInvested;
      const todayProfit = member.asset - baseAsset - netFlowToday;

      return {
        ...member,
        baseAsset,
        baseInvested,
        netFlowToday,
        todayProfit,
      };
    });

    const totalTodayProfit = rows.reduce((sum, row) => sum + row.todayProfit, 0);
    const baselineAsset = number(baseline.totalAsset);
    const todayRate = baselineAsset > 0 ? (totalTodayProfit / baselineAsset) * 100 : 0;

    return {
      key: dateKeyOf(),
      baseline,
      rows,
      totalTodayProfit,
      todayRate,
      baselineAsset,
    };
  }

  function memberNameOf(memberId, summary) {
    return summary.members.find((member) => member.id === memberId)?.name || "未分配成员";
  }

  function renderDashboard(summary, todaySummary) {
    if (!byId("dashboard-page")) return;

    const emptyLedger = isEmptyLedger(summary);

    setText("dash-total-asset", formatCurrency(summary.totalAsset));
    setText("dash-total-profit", formatCurrency(summary.totalProfit));
    setText(
      "dash-nav",
      emptyLedger ? "基金净值：未建立（请先在操作页记录首笔入金）" : `基金净值：${formatUnits(summary.nav, 8)}`
    );
    setText(
      "dash-total-invested",
      emptyLedger ? "累计净入金：¥0.00（暂无资金记录）" : `累计净入金：${formatCurrency(summary.totalInvested)}`
    );
    setText("dash-total-subscribed", `累计入金：${formatCurrency(summary.totalSubscribedAmount || 0)}`);
    setText("dash-total-withdrawn", `累计出金：${formatCurrency(summary.totalWithdrawnAmount || 0)}`);
    setText(
      "dash-total-shares",
      emptyLedger ? "总份额：0.00000000（未发行）" : `总份额：${formatUnits(summary.totalShares, 8)}`
    );
    setText("dash-cash", `账户现金：${formatCurrency(summary.cash)}`);
    setText(
      "dash-holding-market",
      emptyLedger ? "股票市值：¥0.00（暂无持仓）" : `股票市值：${formatCurrency(summary.holdingMarketValueTotal)}`
    );
    setText("dash-updated-at", formatDate(appState.updatedAt));
    setText(
      "dash-empty-tip",
      emptyLedger
        ? "当前无数据，请前往操作页先新增成员并记录首笔入金。"
        : "展示口径：成员资产与收益均按份额自动分配。"
    );

    const totalProfitEl = byId("dash-total-profit");
    if (emptyLedger) {
      clearPositiveNegative(totalProfitEl);
    } else {
      setPositiveNegative(totalProfitEl, summary.totalProfit);
    }

    setText("dash-today-profit", formatCurrency(todaySummary.totalTodayProfit));
    setText("dash-today-rate", emptyLedger ? "今日收益率：—" : `今日收益率：${formatPercent(todaySummary.todayRate)}`);
    setText(
      "dash-today-base",
      emptyLedger ? "当日基线总资产：—（首笔入金后自动建立）" : `当日基线总资产：${formatCurrency(todaySummary.baselineAsset)}`
    );
    if (emptyLedger) {
      clearPositiveNegative(byId("dash-today-profit"));
    } else {
      setPositiveNegative(byId("dash-today-profit"), todaySummary.totalTodayProfit);
    }

    const memberBody = byId("dash-member-body");
    if (memberBody) {
      memberBody.innerHTML = "";
      if (!todaySummary.rows.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="8">暂无成员与资金记录</td>';
        memberBody.appendChild(row);
      } else {
        todaySummary.rows.forEach((member) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${member.name}</td>
            <td>${formatCurrency(member.invested)}</td>
            <td>${formatUnits(member.shares, 8)}</td>
            <td>${formatPercent(member.ownershipRatio * 100)}</td>
            <td>${formatCurrency(member.asset)}</td>
            <td class="profit-cell">${formatCurrency(member.totalProfit)}</td>
            <td class="today-cell">${formatCurrency(member.todayProfit)}</td>
            <td>${formatCurrency(member.netFlowToday)}</td>
          `;
          setPositiveNegative(row.querySelector(".profit-cell"), member.totalProfit);
          setPositiveNegative(row.querySelector(".today-cell"), member.todayProfit);
          memberBody.appendChild(row);
        });
      }
    }

    const holdingBody = byId("dash-holdings-body");
    if (holdingBody) {
      holdingBody.innerHTML = "";
      if (!summary.holdings.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="8">暂无股票持仓</td>';
        holdingBody.appendChild(row);
      } else {
        summary.holdings.forEach((holding) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${holding.code}</td>
            <td>${holding.name || holding.code}</td>
            <td>${formatUnits(holding.quantity, 3)}</td>
            <td>${formatCurrency(holding.avgCost)}</td>
            <td>${formatCurrency(holding.currentPrice)}</td>
            <td>${formatCurrency(holding.costValue)}</td>
            <td>${formatCurrency(holding.marketValue)}</td>
            <td class="pnl-cell">${formatCurrency(holding.pnl)}</td>
          `;
          setPositiveNegative(row.querySelector(".pnl-cell"), holding.pnl);
          holdingBody.appendChild(row);
        });
      }
    }

    const logBody = byId("dash-log-body");
    if (logBody) {
      logBody.innerHTML = "";
      const logs = Array.isArray(appState.logs) ? appState.logs.slice(0, 20) : [];
      if (!logs.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="3">暂无记录</td>';
        logBody.appendChild(row);
      } else {
        logs.forEach((log) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${formatDate(log.at)}</td>
            <td>${log.type}</td>
            <td>${log.detail}</td>
          `;
          logBody.appendChild(row);
        });
      }
    }
  }

  function renderOperation(summary, todaySummary) {
    if (!byId("operation-page")) return;

    const emptyLedger = isEmptyLedger(summary);
    setText(
      "op-total-asset",
      emptyLedger ? "总资产：¥0.00（暂无数据）" : `总资产：${formatCurrency(summary.totalAsset)}`
    );
    setText(
      "op-nav",
      emptyLedger ? "基金净值：未建立（无份额）" : `基金净值：${formatUnits(summary.nav, 8)}`
    );
    setText("op-cash", `账户现金：${formatCurrency(summary.cash)}`);
    setText("op-total-profit", `累计总收益：${formatCurrency(summary.totalProfit)}`);
    setText(
      "op-holding-market",
      emptyLedger ? "股票市值：¥0.00（暂无持仓）" : `股票市值：${formatCurrency(summary.holdingMarketValueTotal)}`
    );
    setText(
      "op-total-invested",
      emptyLedger ? "累计净入金：¥0.00（暂无资金记录）" : `累计净入金：${formatCurrency(summary.totalInvested)}`
    );
    setText("op-total-subscribed", `累计入金：${formatCurrency(summary.totalSubscribedAmount || 0)}`);
    setText("op-total-withdrawn", `累计出金：${formatCurrency(summary.totalWithdrawnAmount || 0)}`);
    setText("op-updated-at", `更新时间：${formatDate(appState.updatedAt)}`);
    setText(
      "op-overview-tip",
      emptyLedger
        ? "当前是空账本。请按顺序：新增成员 → 记录入金 → 记录交易 → 更新现价。"
        : "当前概览会根据入金/出金份额、交易与现价自动计算，无需手动填写收益。"
    );
    if (emptyLedger) {
      clearPositiveNegative(byId("op-total-profit"));
    } else {
      setPositiveNegative(byId("op-total-profit"), summary.totalProfit);
    }

    setText("op-today-total", `当日总收益：${formatCurrency(todaySummary.totalTodayProfit)}`);
    setText("op-today-rate", emptyLedger ? "今日收益率：—" : `今日收益率：${formatPercent(todaySummary.todayRate)}`);
    if (emptyLedger) {
      clearPositiveNegative(byId("op-today-total"));
    } else {
      setPositiveNegative(byId("op-today-total"), todaySummary.totalTodayProfit);
    }

    const memberBody = byId("member-body");
    if (memberBody) {
      memberBody.innerHTML = "";
      if (!todaySummary.rows.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="7">暂无成员</td>';
        memberBody.appendChild(row);
      } else {
        todaySummary.rows.forEach((member) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${member.name}</td>
            <td>${formatCurrency(member.invested)}</td>
            <td>${formatUnits(member.shares, 8)}</td>
            <td>${formatCurrency(member.asset)}</td>
            <td class="profit-cell">${formatCurrency(member.totalProfit)}</td>
            <td class="today-cell">${formatCurrency(member.todayProfit)}</td>
            <td>${formatCurrency(member.netFlowToday)}</td>
          `;
          setPositiveNegative(row.querySelector(".profit-cell"), member.totalProfit);
          setPositiveNegative(row.querySelector(".today-cell"), member.todayProfit);
          memberBody.appendChild(row);
        });
      }
    }

    const fundFlowMemberSelect = byId("fund-flow-member");
    const fundFlowDirectionSelect = byId("fund-flow-direction");
    const fundFlowSubmitButton = byId("fund-flow-submit");
    const sourceSelect = byId("trade-source-member");
    const optionHtml = summary.members.map((member) => `<option value="${member.id}">${member.name}</option>`).join("");
    if (fundFlowMemberSelect) {
      const previous = fundFlowMemberSelect.value;
      fundFlowMemberSelect.innerHTML = optionHtml || '<option value="">请先新增成员</option>';
      if (summary.members.some((member) => member.id === previous)) {
        fundFlowMemberSelect.value = previous;
      } else if (!summary.members.length) {
        fundFlowMemberSelect.value = "";
      }
    }
    if (sourceSelect) {
      const previous = sourceSelect.value;
      sourceSelect.innerHTML = `<option value="pool">统一资金池</option>${optionHtml}`;
      sourceSelect.value = previous || "pool";
      if (!sourceSelect.value) sourceSelect.value = "pool";
    }

    const flowDirection = fundFlowDirectionSelect?.value === "out" ? "out" : "in";
    const flowAmount = number(byId("fund-flow-amount")?.value);
    const flowMemberId = String(fundFlowMemberSelect?.value || "").trim();
    const flowMember = summary.memberRows.find((member) => member.id === flowMemberId);
    const navNow = summary.nav > 0 ? summary.nav : 1;
    const flowShares = flowAmount > 0 && navNow > 0 ? flowAmount / navNow : 0;

    if (fundFlowSubmitButton) {
      fundFlowSubmitButton.textContent = flowDirection === "out" ? "记录出金" : "记录入金";
      fundFlowSubmitButton.classList.toggle("ghost", flowDirection === "out");
    }

    if (!summary.members.length) {
      setText("fund-flow-preview", "请先新增成员，再记录资金操作。");
    } else if (!flowMemberId || !flowMember) {
      setText("fund-flow-preview", "请选择成员。");
    } else if (flowDirection === "in") {
      if (summary.totalShares <= 0) {
        setText(
          "fund-flow-preview",
          `当前为初始阶段，首笔入金按净值 1.00000000 发行份额；本次预计份额 ${formatUnits(flowShares, 8)}。`
        );
      } else {
        setText(
          "fund-flow-preview",
          `本次入金将按当前净值 ${formatUnits(navNow, 8)} 购买 ${formatUnits(flowShares, 8)} 份权益。`
        );
      }
    } else if (summary.totalShares <= 0) {
      setText("fund-flow-preview", "当前无已发行份额，无法出金。");
    } else if (flowMember.shares <= 0) {
      setText("fund-flow-preview", "该成员当前无可赎回份额。");
    } else if (flowAmount <= 0) {
      setText("fund-flow-preview", `该成员可赎回资产约 ${formatCurrency(flowMember.asset)}。`);
    } else if (flowAmount > summary.cash + 1e-8) {
      setText("fund-flow-preview", `出金金额超过账户现金，可用现金 ${formatCurrency(summary.cash)}。`);
    } else if (flowShares > flowMember.shares + 1e-8) {
      setText(
        "fund-flow-preview",
        `预计赎回份额 ${formatUnits(flowShares, 8)} 超过成员可用份额 ${formatUnits(flowMember.shares, 8)}。`
      );
    } else {
      setText(
        "fund-flow-preview",
        `本次出金将按当前净值 ${formatUnits(navNow, 8)} 赎回 ${formatUnits(flowShares, 8)} 份权益。`
      );
    }

    const tradeType = byId("trade-type")?.value === "sell" ? "sell" : "buy";
    const tradePrice = number(byId("trade-price")?.value);
    const tradeQty = number(byId("trade-quantity")?.value);
    const tradeAmount = tradePrice * tradeQty;
    if (summary.cash <= 0 && tradeType === "buy") {
      setText("trade-preview", "请先记录入金，建立可用资金后再买入股票。");
    } else {
      setText(
        "trade-preview",
        tradeAmount > 0
          ? `${tradeType === "buy" ? "买入" : "卖出"}金额：${formatCurrency(tradeAmount)}；当前可用现金：${formatCurrency(summary.cash)}`
          : "填写价格和数量后可预览交易金额。"
      );
    }

    const priceBody = byId("price-body");
    if (priceBody) {
      priceBody.innerHTML = "";
      if (!summary.holdings.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="6">暂无持仓，无法更新价格</td>';
        priceBody.appendChild(row);
      } else {
        summary.holdings.forEach((holding) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${holding.code}</td>
            <td>${holding.name || holding.code}</td>
            <td>${formatUnits(holding.quantity, 3)}</td>
            <td>${formatCurrency(holding.currentPrice)}</td>
            <td>
              <input class="price-input" data-code="${holding.code}" type="number" min="0" step="0.001" value="${holding.currentPrice}" />
            </td>
            <td>
              <div class="row-actions">
                <button type="button" class="quote-refresh price-auto" data-code="${holding.code}">自动获取</button>
                <button type="button" class="price-save" data-code="${holding.code}">保存</button>
              </div>
            </td>
          `;
          priceBody.appendChild(row);
        });
      }
    }

    const subHistoryBody = byId("sub-history-body");
    if (subHistoryBody) {
      subHistoryBody.innerHTML = "";
      const fundFlowRows = [
        ...summary.subscriptionRows.map((sub) => ({
          ...sub,
          flowType: "in",
          navAtFlow: sub.navAtSubscription,
        })),
        ...(summary.withdrawalRows || []).map((wd) => ({
          ...wd,
          flowType: "out",
          navAtFlow: wd.navAtWithdrawal,
        })),
      ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

      if (!fundFlowRows.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="7">暂无资金进出记录</td>';
        subHistoryBody.appendChild(row);
      } else {
        fundFlowRows.slice(0, 120).forEach((flow) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${formatDate(flow.at)}</td>
            <td>${memberNameOf(flow.memberId, summary)}</td>
            <td class="${flow.flowType === "in" ? "positive" : "negative"}">${flow.flowType === "in" ? "入金" : "出金"}</td>
            <td>${formatCurrency(flow.amount)}</td>
            <td>${formatUnits(flow.navAtFlow, 8)}</td>
            <td>${formatUnits(flow.shares, 8)}</td>
            <td>${flow.note || "-"}</td>
          `;
          subHistoryBody.appendChild(row);
        });
      }
    }

    const tradeHistoryBody = byId("trade-history-body");
    if (tradeHistoryBody) {
      tradeHistoryBody.innerHTML = "";
      if (!summary.tradeRows.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="9">暂无交易记录</td>';
        tradeHistoryBody.appendChild(row);
      } else {
        summary.tradeRows.slice(0, 120).forEach((trade) => {
          const row = document.createElement("tr");
          const amount = trade.price * trade.quantity;
          const sourceText = trade.sourceMemberId === "pool" ? "统一资金池" : memberNameOf(trade.sourceMemberId, summary);
          row.innerHTML = `
            <td>${formatDate(trade.at)}</td>
            <td>${trade.type === "buy" ? "买入" : "卖出"}</td>
            <td>${trade.code}</td>
            <td>${trade.name || trade.code}</td>
            <td>${formatCurrency(trade.price)}</td>
            <td>${formatUnits(trade.quantity, 3)}</td>
            <td>${formatCurrency(amount)}</td>
            <td>${sourceText}</td>
            <td>${trade.note || "-"}</td>
          `;
          tradeHistoryBody.appendChild(row);
        });
      }
    }

    const noteBody = byId("note-body");
    if (noteBody) {
      noteBody.innerHTML = "";
      const notes = Array.isArray(appState.notes) ? appState.notes.slice(0, 80) : [];
      if (!notes.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="2">暂无管理员备注</td>';
        noteBody.appendChild(row);
      } else {
        notes.forEach((note) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${formatDate(note.at)}</td>
            <td>${note.text}</td>
          `;
          noteBody.appendChild(row);
        });
      }
    }

    const logBody = byId("op-log-body");
    if (logBody) {
      logBody.innerHTML = "";
      const logs = Array.isArray(appState.logs) ? appState.logs.slice(0, 120) : [];
      if (!logs.length) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="3">暂无操作历史</td>';
        logBody.appendChild(row);
      } else {
        logs.forEach((log) => {
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${formatDate(log.at)}</td>
            <td>${log.type}</td>
            <td>${log.detail}</td>
          `;
          logBody.appendChild(row);
        });
      }
    }
  }

  function renderAll() {
    const summary = computeSummary(appState);
    const todaySummary = computeTodaySummary(summary);

    renderDashboard(summary, todaySummary);
    renderOperation(summary, todaySummary);
  }

  function addMember() {
    const input = byId("new-member-name");
    const name = String(input?.value || "").trim();
    if (!name) {
      showSaveStatus("请输入成员名称");
      return;
    }

    const exists = appState.members.some((member) => member.name === name);
    if (exists) {
      showSaveStatus("成员名称已存在");
      return;
    }

    appState.members.push({ id: uid(), name });
    addLog(appState, { type: "成员管理", detail: `新增成员：${name}` });
    if (input) input.value = "";
    persistState({ notice: "成员已新增" });
  }

  function applyFundFlow(directionOverride = null) {
    const summary = computeSummary(appState);
    const selectedDirection = byId("fund-flow-direction")?.value === "out" ? "out" : "in";
    const direction = directionOverride === "out" ? "out" : directionOverride === "in" ? "in" : selectedDirection;
    const memberId = String(byId("fund-flow-member")?.value || "").trim();
    const amount = number(byId("fund-flow-amount")?.value);
    const note = String(byId("fund-flow-note")?.value || "").trim();

    if (!memberId || !summary.members.some((member) => member.id === memberId)) {
      showSaveStatus("请选择成员");
      return;
    }
    if (amount <= 0) {
      showSaveStatus("请输入大于 0 的金额");
      return;
    }

    const navNow = summary.nav > 0 ? summary.nav : 1;
    const shares = amount / navNow;
    const memberName = memberNameOf(memberId, summary);

    if (direction === "in") {
      appState.subscriptions.push({
        id: uid(),
        memberId,
        amount: round(amount, 6),
        shares: round(shares, 8),
        navAtSubscription: round(navNow, 8),
        at: new Date().toISOString(),
        note,
      });

      addLog(appState, {
        type: "成员入金",
        detail: `${memberName} 入金 ${formatCurrency(amount)}，净值 ${formatUnits(navNow, 8)}，份额 ${formatUnits(shares, 8)}${
          note ? `；备注：${note}` : ""
        }`,
      });
    } else {
      if (summary.totalShares <= 0) {
        showSaveStatus("当前无已发行份额，无法出金");
        return;
      }

      const memberRow = summary.memberRows.find((member) => member.id === memberId);
      if (!memberRow || memberRow.shares <= 0) {
        showSaveStatus("该成员当前无可赎回份额");
        return;
      }
      if (amount > summary.cash + 1e-8) {
        showSaveStatus(`账户现金不足，当前可用 ${formatCurrency(summary.cash)}`);
        return;
      }
      if (shares > memberRow.shares + 1e-8) {
        showSaveStatus(`可赎回上限约为 ${formatCurrency(memberRow.asset)}`);
        return;
      }

      appState.withdrawals = Array.isArray(appState.withdrawals) ? appState.withdrawals : [];
      appState.withdrawals.push({
        id: uid(),
        memberId,
        amount: round(amount, 6),
        shares: round(shares, 8),
        navAtWithdrawal: round(navNow, 8),
        at: new Date().toISOString(),
        note,
      });

      addLog(appState, {
        type: "成员出金",
        detail: `${memberName} 出金 ${formatCurrency(amount)}，净值 ${formatUnits(navNow, 8)}，赎回份额 ${formatUnits(shares, 8)}${
          note ? `；备注：${note}` : ""
        }`,
      });
    }

    const amountInput = byId("fund-flow-amount");
    const noteInput = byId("fund-flow-note");
    if (amountInput) amountInput.value = "";
    if (noteInput) noteInput.value = "";

    persistState({ notice: direction === "out" ? "出金记录已保存" : "入金记录已保存" });
  }

  function applySubscription() {
    applyFundFlow("in");
  }

  function applyWithdrawal() {
    applyFundFlow("out");
  }

  function applyTrade() {
    const summary = computeSummary(appState);
    const type = byId("trade-type")?.value === "sell" ? "sell" : "buy";
    const code = normalizeCode(byId("trade-code")?.value);
    const name = String(byId("trade-name")?.value || code).trim() || code;
    const price = number(byId("trade-price")?.value);
    const quantity = number(byId("trade-quantity")?.value);
    const sourceMemberId = String(byId("trade-source-member")?.value || "pool").trim() || "pool";
    const note = String(byId("trade-note")?.value || "").trim();

    if (!code) {
      showSaveStatus("请输入股票代码");
      return;
    }
    if (price <= 0 || quantity <= 0) {
      showSaveStatus("请输入有效的价格和数量");
      return;
    }

    const amount = price * quantity;
    if (type === "buy" && amount > summary.cash + 1e-8) {
      showSaveStatus(`可用现金不足，当前可用 ${formatCurrency(summary.cash)}`);
      return;
    }

    if (type === "sell") {
      const holding = summary.holdings.find((item) => item.code === code);
      const maxSell = number(holding?.quantity);
      if (maxSell <= 0) {
        showSaveStatus("该股票当前无可卖出仓位");
        return;
      }
      if (quantity > maxSell + 1e-8) {
        showSaveStatus(`可卖出上限为 ${formatUnits(maxSell, 3)} 股`);
        return;
      }
    }

    appState.trades.push({
      id: uid(),
      type,
      code,
      name,
      price: round(price, 6),
      quantity: round(quantity, 6),
      sourceMemberId,
      at: new Date().toISOString(),
      note,
    });

    if (!appState.prices || typeof appState.prices !== "object") appState.prices = {};
    if (!number(appState.prices[code])) {
      appState.prices[code] = round(price, 6);
    }

    const sourceText = sourceMemberId === "pool" ? "统一资金池" : memberNameOf(sourceMemberId, summary);
    addLog(appState, {
      type: type === "buy" ? "股票买入" : "股票卖出",
      detail: `${type === "buy" ? "买入" : "卖出"} ${code} ${formatUnits(quantity, 3)} 股，价格 ${formatCurrency(
        price
      )}，金额 ${formatCurrency(amount)}，资金来源记录：${sourceText}${note ? `；备注：${note}` : ""}`,
    });

    const priceInput = byId("trade-price");
    const qtyInput = byId("trade-quantity");
    const noteInput = byId("trade-note");
    if (priceInput) priceInput.value = "";
    if (qtyInput) qtyInput.value = "";
    if (noteInput) noteInput.value = "";

    persistState({ notice: `交易记录已保存（${type === "buy" ? "买入" : "卖出"}）` });
  }

  function applyPriceUpdate(code, price, { notice = null, log = true, source = "手动", persist = true } = {}) {
    if (!code) {
      showSaveStatus("未识别股票代码");
      return;
    }
    if (price <= 0) {
      showSaveStatus("请输入有效现价");
      return;
    }

    if (!appState.prices || typeof appState.prices !== "object") appState.prices = {};
    appState.prices[code] = round(price, 6);
    if (log) {
      addLog(appState, { type: "价格更新", detail: `${code} ${source}更新现价为 ${formatCurrency(price)}` });
    }
    if (persist) {
      persistState({ notice: notice === null ? `${code} 价格已更新` : notice });
    }
  }

  async function refreshQuoteForCode(code, { silent = false, persist = true } = {}) {
    const normalizedCode = normalizeCode(code);
    if (!normalizedCode) return { ok: false, message: "代码为空" };

    try {
      const quote = await fetchQuoteByCode(normalizedCode);
      applyPriceUpdate(normalizedCode, quote.price, {
        notice: silent ? "" : `${normalizedCode} 自动获取现价成功`,
        log: persist,
        source: "自动",
        persist,
      });
      return { ok: true, quote };
    } catch (error) {
      if (!silent) {
        showSaveStatus(`${normalizedCode} 自动获取失败：${error?.message || "未知错误"}`);
      }
      return { ok: false, message: error?.message || "未知错误" };
    }
  }

  async function refreshAllQuotes() {
    const summary = computeSummary(appState);
    const holdings = summary.holdings || [];
    if (!holdings.length) {
      showSaveStatus("暂无持仓，无法自动获取现价");
      return;
    }

    const button = byId("price-refresh-all-btn");
    const originalText = button?.textContent || "自动获取全部现价";
    if (button) {
      button.disabled = true;
      button.textContent = "获取中...";
    }

    if (!appState.prices || typeof appState.prices !== "object") appState.prices = {};

    let success = 0;
    let failed = 0;
    for (const holding of holdings) {
      const result = await refreshQuoteForCode(holding.code, { silent: true, persist: false });
      if (result.ok) {
        appState.prices[normalizeCode(holding.code)] = round(result.quote.price, 6);
        success += 1;
      } else {
        failed += 1;
      }
    }

    if (success > 0) {
      addLog(appState, {
        type: "价格更新",
        detail: `自动获取现价完成：成功 ${success} 条，失败 ${failed} 条`,
      });
      persistState({
        notice:
          failed > 0 ? `自动获取完成：成功 ${success} 条，失败 ${failed} 条` : `自动获取完成：成功 ${success} 条`,
      });
    } else {
      renderAll();
      showSaveStatus("自动获取失败：未获取到有效现价");
    }

    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function addAdminNote() {
    const text = String(byId("admin-note")?.value || "").trim();
    if (!text) {
      showSaveStatus("请输入管理员备注内容");
      return;
    }

    appState.notes = Array.isArray(appState.notes) ? appState.notes : [];
    appState.notes.unshift({
      id: uid(),
      at: new Date().toISOString(),
      text,
    });
    if (appState.notes.length > 500) appState.notes = appState.notes.slice(0, 500);

    addLog(appState, { type: "管理员备注", detail: text });

    const input = byId("admin-note");
    if (input) input.value = "";

    persistState({ notice: "管理员备注已记录" });
  }

  function clearAllData() {
    const typed = String(prompt('该操作会清空全部本地数据。请输入“清空全部”确认：') || "").trim();
    if (typed !== "清空全部") {
      showSaveStatus("已取消清空");
      return;
    }

    appState = createEmptyState();
    appState = saveState(appState);
    writeStateToConnectedFile();
    renderAll();
    showSaveStatus("已清空全部数据");
  }

  async function connectLocalFile() {
    if (!supportsFsAccess()) {
      setFileStatus("当前浏览器不支持文件直连，请使用导入/导出功能");
      return;
    }

    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "JSON 数据文件",
            accept: { "application/json": [".json"] },
          },
        ],
      });

      if (!handle) return;

      fileHandle = handle;
      const file = await handle.getFile();
      const text = await file.text();

      if (text.trim()) {
        const parsed = JSON.parse(text);
        appState = normalizeState(parsed);
        appState = saveState(appState);
        renderAll();
        showSaveStatus("已从本地文件载入数据");
      }

      setFileStatus(`已连接文件：${handle.name}`);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setFileStatus(`连接文件失败：${error?.message || "未知错误"}`);
    }
  }

  async function saveToLocalFile(forcePick = false) {
    if (!supportsFsAccess()) {
      const filename = `fund-ledger-${dateKeyOf()}.json`;
      downloadJsonFile(filename, JSON.stringify(normalizeState(appState), null, 2));
      setFileStatus("浏览器不支持文件直连，已下载导出文件");
      return;
    }

    try {
      if (!fileHandle || forcePick) {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: `fund-ledger-${dateKeyOf()}.json`,
          types: [
            {
              description: "JSON 数据文件",
              accept: { "application/json": [".json"] },
            },
          ],
        });
      }

      await writeStateToConnectedFile();
      setFileStatus(`已保存到文件：${fileHandle?.name || "ledger.json"}`);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setFileStatus(`保存文件失败：${error?.message || "未知错误"}`);
    }
  }

  async function loadFromConnectedFile() {
    if (!fileHandle) {
      setFileStatus("请先连接本地文件");
      return;
    }

    try {
      const file = await fileHandle.getFile();
      const text = await file.text();
      if (!text.trim()) {
        setFileStatus("文件为空，未载入");
        return;
      }

      appState = normalizeState(JSON.parse(text));
      appState = saveState(appState);
      renderAll();
      showSaveStatus("已从连接文件刷新数据");
      setFileStatus(`已从文件载入：${fileHandle.name}`);
    } catch (error) {
      setFileStatus(`载入文件失败：${error?.message || "未知错误"}`);
    }
  }

  function importFromFileInput(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        appState = normalizeState(parsed);
        appState = saveState(appState);
        renderAll();
        showSaveStatus("已导入本地文件数据");
        setFileStatus(`已导入文件：${file.name}`);
      } catch (error) {
        setFileStatus(`导入失败：${error?.message || "文件格式错误"}`);
      }
    };
    reader.onerror = () => {
      setFileStatus("导入失败：读取文件时发生错误");
    };
    reader.readAsText(file, "utf-8");
  }

  function bindOperationEvents() {
    if (!byId("operation-page")) return;

    byId("add-member-btn")?.addEventListener("click", addMember);

    byId("fund-flow-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      applyFundFlow();
    });

    byId("trade-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      applyTrade();
    });

    byId("price-body")?.addEventListener("click", async (event) => {
      const autoButton = event.target.closest("button.price-auto");
      if (autoButton) {
        const code = normalizeCode(autoButton.dataset.code || "");
        const originalText = autoButton.textContent;
        autoButton.disabled = true;
        autoButton.textContent = "获取中...";

        const result = await refreshQuoteForCode(code);
        if (result.ok) {
          const row = autoButton.closest("tr");
          const input = row?.querySelector("input.price-input");
          if (input) input.value = String(result.quote.price);
        }

        autoButton.disabled = false;
        autoButton.textContent = originalText;
        return;
      }

      const saveButton = event.target.closest("button.price-save");
      if (!saveButton) return;
      const code = normalizeCode(saveButton.dataset.code || "");
      const row = saveButton.closest("tr");
      const input = row?.querySelector("input.price-input");
      const price = number(input?.value);
      applyPriceUpdate(code, price, { source: "手动" });
    });

    byId("price-refresh-all-btn")?.addEventListener("click", () => {
      refreshAllQuotes();
    });

    byId("note-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      addAdminNote();
    });

    byId("clear-all-btn")?.addEventListener("click", clearAllData);

    byId("file-connect-btn")?.addEventListener("click", () => {
      connectLocalFile();
    });
    byId("file-save-btn")?.addEventListener("click", () => {
      saveToLocalFile(false);
    });
    byId("file-save-as-btn")?.addEventListener("click", () => {
      saveToLocalFile(true);
    });
    byId("file-load-btn")?.addEventListener("click", () => {
      loadFromConnectedFile();
    });
    byId("file-export-btn")?.addEventListener("click", () => {
      const filename = `fund-ledger-${dateKeyOf()}.json`;
      downloadJsonFile(filename, JSON.stringify(normalizeState(appState), null, 2));
      setFileStatus(`已导出文件：${filename}`);
    });

    const importInput = byId("file-import-input");
    byId("file-import-btn")?.addEventListener("click", () => {
      importInput?.click();
    });
    importInput?.addEventListener("change", () => {
      const file = importInput.files?.[0];
      importFromFileInput(file);
      importInput.value = "";
    });

    byId("fund-flow-direction")?.addEventListener("change", renderAll);
    byId("fund-flow-amount")?.addEventListener("input", renderAll);
    byId("fund-flow-member")?.addEventListener("change", renderAll);
    byId("trade-price")?.addEventListener("input", renderAll);
    byId("trade-quantity")?.addEventListener("input", renderAll);
    byId("trade-type")?.addEventListener("change", renderAll);
  }

  function init() {
    bindOperationEvents();
    renderAll();

    if (byId("operation-page")) {
      setFileStatus("当前模式：本地存储（可连接/导入 JSON 文件）");
      showSaveStatus("已加载本地数据");
    }
  }

  global.LedgerApp = {
    getState: () => normalizeState(appState),
    replaceState: (nextState) => {
      appState = normalizeState(nextState);
      appState = saveState(appState);
      renderAll();
      return normalizeState(appState);
    },
    addMember,
    applyFundFlow,
    applySubscription,
    applyWithdrawal,
    applyTrade,
    applyPriceUpdate,
    addAdminNote,
    clearAllData,
    renderAll,
  };

  init();
})(window);
