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

  function formatSignedPercent(value) {
    const n = number(value);
    const prefix = n > 0 ? "+" : "";
    return `${prefix}${n.toFixed(2)}%`;
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

  function setQuoteStatus(text) {
    setText("price-sync-status", text);
    setText("dash-holdings-status", text);
  }

  function setRefreshAllButtonBusy(isBusy) {
    const button = byId("price-refresh-all-btn");
    if (!button) return;
    button.disabled = isBusy;
    button.classList.toggle("is-loading", isBusy);
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
    const summary = computeSummary(appState);
    appendOverviewSeriesPoint(summary, { at: appState.updatedAt });
    appState = saveState(appState);
    writeStateToConnectedFile();
    renderAll();
    if (notice) showSaveStatus(notice);
  }

  function appendOverviewSeriesPoint(summary, { at = null, force = false } = {}) {
    if (!summary || typeof summary !== "object") return false;
    if (!Array.isArray(appState.overviewSeries)) appState.overviewSeries = [];

    const point = {
      at: at || new Date().toISOString(),
      totalAsset: round(summary.totalAsset, 6),
      nav: round(summary.nav, 8),
      totalProfit: round(summary.totalProfit, 6),
    };

    const series = appState.overviewSeries;
    const last = series[series.length - 1];
    if (last) {
      const sameValue =
        Math.abs(number(last.totalAsset) - point.totalAsset) < 0.01 &&
        Math.abs(number(last.nav) - point.nav) < 0.00000001 &&
        Math.abs(number(last.totalProfit) - point.totalProfit) < 0.01;
      const timeDelta = Math.abs(new Date(point.at).getTime() - new Date(last.at).getTime());
      if (!force && sameValue && timeDelta < 2 * 60 * 1000) {
        return false;
      }
    }

    series.push(point);
    if (series.length > 1200) series.splice(0, series.length - 1200);
    return true;
  }

  function ensureOverviewSeriesInitialized(summary) {
    if (!Array.isArray(appState.overviewSeries)) appState.overviewSeries = [];
    if (appState.overviewSeries.length > 0) return false;
    return appendOverviewSeriesPoint(summary, { at: appState.updatedAt || new Date().toISOString(), force: true });
  }

  function buildLineAreaPath(values, width, height, padding = 10) {
    if (!Array.isArray(values) || !values.length) {
      return { line: "", area: "" };
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const usableW = Math.max(1, width - padding * 2);
    const usableH = Math.max(1, height - padding * 2);

    const points = values.map((value, index) => {
      const ratioX = values.length === 1 ? 0 : index / (values.length - 1);
      const x = padding + ratioX * usableW;
      const y = padding + ((max - value) / span) * usableH;
      return { x, y };
    });

    const line = points.map((p, index) => `${index === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
    const first = points[0];
    const last = points[points.length - 1];
    const baseY = (height - padding).toFixed(2);
    const area = `${line} L${last.x.toFixed(2)} ${baseY} L${first.x.toFixed(2)} ${baseY} Z`;

    return { line, area };
  }

  function startOfLocalDay(date = new Date()) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function findPreviousClosePoint(dayStart) {
    const targetTime = dayStart.getTime();
    const series = Array.isArray(appState.overviewSeries) ? appState.overviewSeries : [];

    for (let i = series.length - 1; i >= 0; i -= 1) {
      const point = series[i];
      const pointTime = new Date(point?.at).getTime();
      if (!Number.isFinite(pointTime)) continue;
      if (pointTime < targetTime) {
        return {
          at: point.at,
          totalAsset: round(point.totalAsset, 6),
          nav: round(point.nav, 8),
        };
      }
    }

    return null;
  }

  function buildTodayBaseline(summary) {
    const dayStart = startOfLocalDay();
    const previousClose = findPreviousClosePoint(dayStart);
    if (!previousClose || previousClose.nav <= 0) {
      const fallback = createDailyBaseline(summary);
      return {
        ...fallback,
        totalInvested: round(summary.totalInvested, 6),
        nav: round(summary.nav, 8),
      };
    }

    const memberAssets = {};
    const memberInvested = {};
    const memberShares = {};
    const validMemberIds = new Set(summary.members.map((member) => member.id));
    let totalInvested = 0;

    summary.members.forEach((member) => {
      memberAssets[member.id] = 0;
      memberInvested[member.id] = 0;
      memberShares[member.id] = 0;
    });

    const subs = Array.isArray(appState.subscriptions) ? appState.subscriptions : [];
    subs.forEach((sub) => {
      const memberId = String(sub?.memberId || "").trim();
      const atTime = new Date(sub?.at).getTime();
      if (!validMemberIds.has(memberId) || !Number.isFinite(atTime) || atTime >= dayStart.getTime()) return;
      memberInvested[memberId] += number(sub.amount);
      memberShares[memberId] += number(sub.shares);
      totalInvested += number(sub.amount);
    });

    const withdrawals = Array.isArray(appState.withdrawals) ? appState.withdrawals : [];
    withdrawals.forEach((wd) => {
      const memberId = String(wd?.memberId || "").trim();
      const atTime = new Date(wd?.at).getTime();
      if (!validMemberIds.has(memberId) || !Number.isFinite(atTime) || atTime >= dayStart.getTime()) return;
      memberInvested[memberId] -= number(wd.amount);
      memberShares[memberId] -= number(wd.shares);
      totalInvested -= number(wd.amount);
    });

    summary.members.forEach((member) => {
      memberAssets[member.id] = round(Math.max(0, memberShares[member.id]) * previousClose.nav, 6);
      memberInvested[member.id] = round(memberInvested[member.id], 6);
      memberShares[member.id] = round(Math.max(0, memberShares[member.id]), 8);
    });

    return {
      at: previousClose.at,
      totalAsset: round(previousClose.totalAsset, 6),
      totalInvested: round(totalInvested, 6),
      nav: round(previousClose.nav, 8),
      memberAssets,
      memberInvested,
      memberShares,
    };
  }

  function computeTodaySummary(summary) {
    const baseline = buildTodayBaseline(summary);
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
    const baselineInvestedTotal = number(baseline.totalInvested);
    const totalNetFlowToday = round(summary.totalInvested - baselineInvestedTotal, 6);
    const adjustedBaselineAsset = round(baselineAsset + totalNetFlowToday, 6);
    const todayRate = adjustedBaselineAsset > 0 ? (totalTodayProfit / adjustedBaselineAsset) * 100 : 0;

    return {
      key: dateKeyOf(),
      baseline,
      rows,
      totalTodayProfit,
      todayRate,
      baselineAsset,
      adjustedBaselineAsset,
      totalNetFlowToday,
    };
  }

  function memberNameOf(memberId, summary) {
    return summary.members.find((member) => member.id === memberId)?.name || "未分配成员";
  }

  function renderOverviewCurve() {
    const lineEl = byId("dash-overview-curve-line");
    const areaEl = byId("dash-overview-curve-area");
    if (!lineEl || !areaEl) return;

    const emptyEl = byId("dash-overview-curve-empty");
    const changeEl = byId("dash-overview-nav-change");
    const raw = Array.isArray(appState.overviewSeries) ? appState.overviewSeries : [];
    const series = raw
      .slice(-120)
      .map((item) => ({
        at: item?.at,
        nav: number(item?.nav),
      }))
      .filter((item) => item.nav > 0 && !Number.isNaN(new Date(item.at).getTime()));

    const count = series.length;
    if (!count) {
      lineEl.setAttribute("d", "");
      areaEl.setAttribute("d", "");
      setText("dash-overview-start-nav", "起始净值：—");
      setText("dash-overview-end-nav", "当前净值：—");
      setText("dash-overview-point-count", "历史点数：0");
      setText("dash-overview-nav-change", "区间变化：—");
      clearPositiveNegative(changeEl);
      if (emptyEl) emptyEl.classList.remove("hidden");
      return;
    }

    const values = count === 1 ? [series[0].nav, series[0].nav] : series.map((item) => item.nav);
    const path = buildLineAreaPath(values, 420, 150, 10);
    lineEl.setAttribute("d", path.line);
    areaEl.setAttribute("d", path.area);
    if (emptyEl) emptyEl.classList.add("hidden");

    const startNav = series[0].nav;
    const endNav = series[count - 1].nav;
    setText("dash-overview-start-nav", `起始净值：${formatUnits(startNav, 8)}`);
    setText("dash-overview-end-nav", `当前净值：${formatUnits(endNav, 8)}`);
    setText("dash-overview-point-count", `历史点数：${count}`);

    if (count >= 2 && startNav > 0) {
      const navChange = ((endNav / startNav) - 1) * 100;
      setText("dash-overview-nav-change", `区间变化：${formatSignedPercent(navChange)}`);
      setPositiveNegative(changeEl, navChange);
    } else {
      setText("dash-overview-nav-change", "区间变化：—");
      clearPositiveNegative(changeEl);
    }
  }

  function renderOperationMiniCurve(summary) {
    const lineEl = byId("op-mini-curve-line");
    const areaEl = byId("op-mini-curve-area");
    const emptyEl = byId("op-mini-curve-empty");
    const changeEl = byId("op-mini-curve-change");
    if (!lineEl || !areaEl) return;

    const totalAsset = Math.max(0, number(summary?.totalAsset));
    const stockRatio = totalAsset > 0 ? number(summary?.holdingMarketValueTotal) / totalAsset : 0;
    const cashRatio = totalAsset > 0 ? number(summary?.cash) / totalAsset : 0;
    setText("op-stock-ratio", formatPercent(stockRatio * 100));
    setText("op-cash-ratio", formatPercent(cashRatio * 100));

    const stockSeg = byId("op-stock-seg");
    const cashSeg = byId("op-cash-seg");
    if (stockSeg) stockSeg.style.width = `${Math.max(0, Math.min(100, stockRatio * 100)).toFixed(2)}%`;
    if (cashSeg) cashSeg.style.width = `${Math.max(0, Math.min(100, cashRatio * 100)).toFixed(2)}%`;

    const raw = Array.isArray(appState.overviewSeries) ? appState.overviewSeries : [];
    const series = raw
      .map((item) => ({ at: item?.at, totalAsset: number(item?.totalAsset) }))
      .filter((item) => item.totalAsset >= 0)
      .slice(-96);

    if (!series.length) {
      lineEl.setAttribute("d", "");
      areaEl.setAttribute("d", "");
      setText("op-mini-curve-change", "—");
      clearPositiveNegative(changeEl);
      if (emptyEl) emptyEl.classList.remove("hidden");
      return;
    }

    const values =
      series.length === 1 ? [series[0].totalAsset, series[0].totalAsset] : series.map((item) => item.totalAsset);
    const path = buildLineAreaPath(values, 340, 96, 6);
    lineEl.setAttribute("d", path.line);
    areaEl.setAttribute("d", path.area);
    if (emptyEl) emptyEl.classList.add("hidden");

    const startAsset = values[0];
    const endAsset = values[values.length - 1];
    if (series.length >= 2 && startAsset > 0) {
      const change = ((endAsset / startAsset) - 1) * 100;
      setText("op-mini-curve-change", formatSignedPercent(change));
      setPositiveNegative(changeEl, change);
    } else {
      setText("op-mini-curve-change", "—");
      clearPositiveNegative(changeEl);
    }
  }

  function renderDashboard(summary, todaySummary) {
    if (!byId("dashboard-page")) return;

    const emptyLedger = isEmptyLedger(summary);

    setText("dash-total-asset", formatCurrency(summary.totalAsset));
    setText("dash-total-profit", formatCurrency(summary.totalProfit));
    setText(
      "dash-nav",
      emptyLedger ? "基金净值：—" : `基金净值：${formatUnits(summary.nav, 8)}`
    );
    setText(
      "dash-total-invested",
      emptyLedger ? "累计净入金：¥0.00" : `累计净入金：${formatCurrency(summary.totalInvested)}`
    );
    setText("dash-total-subscribed", `累计入金：${formatCurrency(summary.totalSubscribedAmount || 0)}`);
    setText("dash-total-withdrawn", `累计出金：${formatCurrency(summary.totalWithdrawnAmount || 0)}`);
    setText(
      "dash-total-shares",
      emptyLedger ? "总份额：—" : `总份额：${formatUnits(summary.totalShares, 8)}`
    );
    setText("dash-cash", `账户现金：${formatCurrency(summary.cash)}`);
    setText(
      "dash-holding-market",
      emptyLedger ? "股票市值：¥0.00" : `股票市值：${formatCurrency(summary.holdingMarketValueTotal)}`
    );
    setText("dash-updated-at", formatDate(appState.updatedAt));
    const emptyTipEl = byId("dash-empty-tip");
    if (emptyTipEl) {
      emptyTipEl.textContent = emptyLedger ? "暂无可展示数据" : "";
      emptyTipEl.classList.toggle("hidden", !emptyLedger);
    }
    renderOverviewCurve();

    const totalProfitEl = byId("dash-total-profit");
    if (emptyLedger) {
      clearPositiveNegative(totalProfitEl);
    } else {
      setPositiveNegative(totalProfitEl, summary.totalProfit);
    }

    const totalRate = summary.totalInvested > 0 ? (summary.totalProfit / summary.totalInvested) * 100 : 0;
    setText("dash-total-profit-invested", formatCurrency(summary.totalInvested));
    setText("dash-total-profit-rate", emptyLedger ? "—" : formatSignedPercent(totalRate));
    setText("dash-total-profit-badge", emptyLedger ? "收益率 —" : `收益率 ${formatSignedPercent(totalRate)}`);
    setText("dash-total-profit-sub", emptyLedger ? "暂无收益记录" : "截至当前");
    if (emptyLedger) {
      clearPositiveNegative(byId("dash-total-profit-rate"));
      clearPositiveNegative(byId("dash-total-profit-badge"));
    } else {
      setPositiveNegative(byId("dash-total-profit-rate"), totalRate);
      setPositiveNegative(byId("dash-total-profit-badge"), totalRate);
    }

    const totalBar = byId("dash-total-profit-bar");
    if (totalBar) {
      const width = emptyLedger ? 0 : Math.min(100, Math.max(8, Math.abs(totalRate)));
      totalBar.style.width = `${width}%`;
      totalBar.classList.toggle("loss", summary.totalProfit < 0);
      totalBar.classList.toggle("gain", summary.totalProfit >= 0);
    }

    setText("dash-today-profit", formatCurrency(todaySummary.totalTodayProfit));
    setText("dash-today-rate", emptyLedger ? "今日收益率：—" : `今日收益率：${formatPercent(todaySummary.todayRate)}`);
    setText("dash-today-base-asset", emptyLedger ? "—" : formatCurrency(todaySummary.adjustedBaselineAsset));
    const todayShareOfTotal =
      Math.abs(summary.totalProfit) > 0 ? (todaySummary.totalTodayProfit / Math.abs(summary.totalProfit)) * 100 : 0;
    setText("dash-today-share-of-total", emptyLedger ? "—" : formatSignedPercent(todayShareOfTotal));
    setText(
      "dash-today-profit-badge",
      emptyLedger ? "当日基线 —" : `当日基线 ${formatCurrency(todaySummary.adjustedBaselineAsset)}`
    );
    if (emptyLedger) {
      clearPositiveNegative(byId("dash-today-profit"));
      clearPositiveNegative(byId("dash-today-share-of-total"));
      clearPositiveNegative(byId("dash-today-profit-badge"));
    } else {
      setPositiveNegative(byId("dash-today-profit"), todaySummary.totalTodayProfit);
      setPositiveNegative(byId("dash-today-share-of-total"), todayShareOfTotal);
      setPositiveNegative(byId("dash-today-profit-badge"), todaySummary.totalTodayProfit);
    }

    const todayBar = byId("dash-today-profit-bar");
    if (todayBar) {
      const width = emptyLedger ? 0 : Math.min(100, Math.max(8, Math.abs(todaySummary.todayRate) * 2));
      todayBar.style.width = `${width}%`;
      todayBar.classList.toggle("loss", todaySummary.totalTodayProfit < 0);
      todayBar.classList.toggle("gain", todaySummary.totalTodayProfit >= 0);
    }

    const memberCards = byId("dash-member-cards");
    if (memberCards) {
      memberCards.innerHTML = "";
      if (!todaySummary.rows.length) {
        const empty = document.createElement("p");
        empty.className = "member-card-empty";
        empty.textContent = "暂无成员数据";
        memberCards.appendChild(empty);
      } else {
        todaySummary.rows.forEach((member) => {
          const memberProfitRate = member.invested > 0 ? (member.totalProfit / member.invested) * 100 : 0;
          const memberProfitRateText = member.invested > 0 ? formatSignedPercent(memberProfitRate) : "—";
          const card = document.createElement("article");
          card.className = `member-profit-card ${member.totalProfit >= 0 ? "gain" : "loss"}`;
          card.innerHTML = `
            <div class="member-card-head">
              <p class="member-card-name">${member.name}</p>
            </div>
            <div class="member-card-profit-hero">
              <span>当前应得总收益</span>
              <strong class="member-total-profit member-total-profit-lg">${formatCurrency(member.totalProfit)}</strong>
            </div>
            <div class="member-card-today">
              <span>今日收益</span>
              <strong class="member-today-profit member-today-profit-lg">${formatCurrency(member.todayProfit)}</strong>
            </div>
            <div class="member-card-rate">
              <span>收益率（按净入金）</span>
              <strong class="member-profit-rate">${memberProfitRateText}</strong>
            </div>
            <details class="member-card-details">
              <summary>收益明细</summary>
              <div class="member-card-meta">
                <p><span>当前资产</span><strong>${formatCurrency(member.asset)}</strong></p>
                <p><span>累计净入金</span><strong>${formatCurrency(member.invested)}</strong></p>
                <p><span>持有份额</span><strong>${formatUnits(member.shares, 8)}</strong></p>
                <p><span>份额占比</span><strong>${formatPercent(member.ownershipRatio * 100)}</strong></p>
                <p><span>今日净入金</span><strong>${formatCurrency(member.netFlowToday)}</strong></p>
              </div>
            </details>
          `;

          setPositiveNegative(card.querySelector(".member-total-profit"), member.totalProfit);
          setPositiveNegative(card.querySelector(".member-today-profit"), member.todayProfit);
          if (member.invested > 0) {
            setPositiveNegative(card.querySelector(".member-profit-rate"), memberProfitRate);
          } else {
            clearPositiveNegative(card.querySelector(".member-profit-rate"));
          }
          memberCards.appendChild(card);
        });
      }
    }

    const holdingList = byId("dash-holdings-list");
    if (holdingList) {
      holdingList.innerHTML = "";
      if (!summary.holdings.length) {
        const empty = document.createElement("p");
        empty.className = "dash-holding-empty";
        empty.textContent = "暂无持仓数据";
        holdingList.appendChild(empty);
      } else {
        summary.holdings.forEach((holding) => {
          const card = document.createElement("article");
          card.className = "dash-holding-card";
          card.innerHTML = `
            <div class="dash-holding-head">
              <span class="dash-holding-code">${holding.code}</span>
              <p class="dash-holding-name">${holding.name || holding.code}</p>
            </div>
            <div class="dash-holding-main">
              <p class="dash-holding-market">
                <span>持仓市值</span>
                <strong>${formatCurrency(holding.marketValue)}</strong>
              </p>
              <p class="dash-holding-pnl-wrap">
                <span>浮动收益</span>
                <strong class="dash-holding-pnl">${formatCurrency(holding.pnl)}</strong>
              </p>
            </div>
            <div class="dash-holding-meta">
              <p><span>现价</span><strong>${formatCurrency(holding.currentPrice)}</strong></p>
              <p><span>数量</span><strong>${formatUnits(holding.quantity, 3)}</strong></p>
              <p><span>成本价</span><strong>${formatCurrency(holding.avgCost)}</strong></p>
            </div>
          `;
          setPositiveNegative(card.querySelector(".dash-holding-pnl"), holding.pnl);
          holdingList.appendChild(card);
        });
      }
    }

  }

  function renderOperation(summary, todaySummary) {
    if (!byId("operation-page")) return;

    const emptyLedger = isEmptyLedger(summary);
    setText("op-total-asset", formatCurrency(summary.totalAsset));
    setText("op-nav", emptyLedger ? "—" : formatUnits(summary.nav, 8));
    setText("op-cash", formatCurrency(summary.cash));
    setText("op-total-profit", formatCurrency(summary.totalProfit));
    setText("op-holding-market", formatCurrency(summary.holdingMarketValueTotal));
    setText("op-total-invested", formatCurrency(summary.totalInvested));
    setText("op-total-subscribed", formatCurrency(summary.totalSubscribedAmount || 0));
    setText("op-total-withdrawn", formatCurrency(summary.totalWithdrawnAmount || 0));
    setText("op-updated-at", formatDate(appState.updatedAt));
    setText("op-overview-tip", emptyLedger ? "当前无有效记录" : "");
    byId("op-overview-tip")?.classList.toggle("hidden", !emptyLedger);
    if (emptyLedger) {
      clearPositiveNegative(byId("op-total-profit"));
    } else {
      setPositiveNegative(byId("op-total-profit"), summary.totalProfit);
    }

    setText("op-today-total", formatCurrency(todaySummary.totalTodayProfit));
    setText("op-today-rate", emptyLedger ? "—" : formatPercent(todaySummary.todayRate));
    if (emptyLedger) {
      clearPositiveNegative(byId("op-today-total"));
    } else {
      setPositiveNegative(byId("op-today-total"), todaySummary.totalTodayProfit);
    }

    renderOperationMiniCurve(summary);

    const memberShareList = byId("member-share-list");
    if (memberShareList) {
      memberShareList.innerHTML = "";
      if (!todaySummary.rows.length) {
        const empty = document.createElement("p");
        empty.className = "member-share-empty";
        empty.textContent = "暂无成员";
        memberShareList.appendChild(empty);
      } else {
        todaySummary.rows.forEach((member) => {
          const card = document.createElement("article");
          card.className = `member-share-item ${member.totalProfit >= 0 ? "gain" : "loss"}`;
          card.innerHTML = `
            <div class="member-share-head">
              <p class="member-share-name">${member.name}</p>
              <p class="member-share-chip">份额 ${formatUnits(member.shares, 4)}</p>
            </div>
            <div class="member-share-focus">
              <p>
                <span>累计净入金</span>
                <strong>${formatCurrency(member.invested)}</strong>
              </p>
              <p>
                <span>总收益</span>
                <strong class="member-share-total-profit">${formatCurrency(member.totalProfit)}</strong>
              </p>
            </div>
            <details class="member-share-detail">
              <summary>查看其他信息</summary>
              <div class="member-share-meta">
                <p><span>当前资产</span><strong>${formatCurrency(member.asset)}</strong></p>
                <p><span>当日收益</span><strong class="member-share-today-profit">${formatCurrency(member.todayProfit)}</strong></p>
                <p><span>今日净入金</span><strong>${formatCurrency(member.netFlowToday)}</strong></p>
                <p><span>份额占比</span><strong>${formatPercent(member.ownershipRatio * 100)}</strong></p>
              </div>
            </details>
          `;
          setPositiveNegative(card.querySelector(".member-share-total-profit"), member.totalProfit);
          setPositiveNegative(card.querySelector(".member-share-today-profit"), member.todayProfit);
          memberShareList.appendChild(card);
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
      fundFlowMemberSelect.innerHTML = optionHtml || '<option value="">暂无成员</option>';
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
      setText("fund-flow-preview", "暂无成员");
    } else if (!flowMemberId || !flowMember) {
      setText("fund-flow-preview", "请选择成员。");
    } else if (flowDirection === "in") {
      if (summary.totalShares <= 0) {
        setText("fund-flow-preview", `预计份额 ${formatUnits(flowShares, 8)}`);
      } else {
        setText(
          "fund-flow-preview",
          `净值 ${formatUnits(navNow, 8)} / 预计份额 ${formatUnits(flowShares, 8)}`
        );
      }
    } else if (summary.totalShares <= 0) {
      setText("fund-flow-preview", "暂无可赎回份额");
    } else if (flowMember.shares <= 0) {
      setText("fund-flow-preview", "该成员暂无可赎回份额");
    } else if (flowAmount <= 0) {
      setText("fund-flow-preview", `可赎回约 ${formatCurrency(flowMember.asset)}`);
    } else if (flowAmount > summary.cash + 1e-8) {
      setText("fund-flow-preview", `现金不足（可用 ${formatCurrency(summary.cash)}）`);
    } else if (flowShares > flowMember.shares + 1e-8) {
      setText("fund-flow-preview", `超出可赎回份额（上限 ${formatUnits(flowMember.shares, 8)}）`);
    } else {
      setText("fund-flow-preview", `净值 ${formatUnits(navNow, 8)} / 赎回份额 ${formatUnits(flowShares, 8)}`);
    }

    const tradeType = byId("trade-type")?.value === "sell" ? "sell" : "buy";
    const tradePrice = number(byId("trade-price")?.value);
    const tradeQty = number(byId("trade-quantity")?.value);
    const tradeAmount = tradePrice * tradeQty;
    if (summary.cash <= 0 && tradeType === "buy") {
      setText("trade-preview", "可用现金不足");
    } else {
      setText(
        "trade-preview",
        tradeAmount > 0
          ? `${tradeType === "buy" ? "买入" : "卖出"}金额 ${formatCurrency(tradeAmount)} / 可用现金 ${formatCurrency(summary.cash)}`
          : "输入价格与数量后显示成交金额"
      );
    }

    const priceCardList = byId("price-card-list");
    if (priceCardList) {
      priceCardList.innerHTML = "";
      if (!summary.holdings.length) {
        const empty = document.createElement("p");
        empty.className = "price-card-empty";
        empty.textContent = "暂无持仓";
        priceCardList.appendChild(empty);
        setText("price-sync-status", "暂无持仓，无法获取现价");
        setQuoteStatus("暂无持仓，无法获取现价");
      } else {
        setQuoteStatus(`当前持仓 ${summary.holdings.length} 只，可刷新最新股价`);
        summary.holdings.forEach((holding) => {
          const card = document.createElement("article");
          card.className = "price-card";
          card.dataset.code = holding.code;
          card.innerHTML = `
            <div class="price-card-head">
              <div>
                <p class="price-card-code">${holding.code}</p>
                <p class="price-card-name">${holding.name || holding.code}</p>
              </div>
              <button type="button" class="quote-refresh price-auto" data-code="${holding.code}">网络刷新</button>
            </div>
            <div class="price-card-metrics">
              <p><span>持仓数量</span><strong>${formatUnits(holding.quantity, 3)} 股</strong></p>
              <p><span>当前现价</span><strong>${formatCurrency(holding.currentPrice)}</strong></p>
              <p><span>持仓市值</span><strong>${formatCurrency(holding.marketValue)}</strong></p>
            </div>
            <div class="price-fallback-row">
              <input class="price-input" data-code="${holding.code}" type="number" min="0" step="0.001" value="${holding.currentPrice}" />
              <button type="button" class="ghost price-save" data-code="${holding.code}">保存本地现价</button>
            </div>
            <p class="price-card-tip">网络失败时可使用本地现价兜底</p>
          `;
          priceCardList.appendChild(card);
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
        row.innerHTML = '<td colspan="7">暂无记录</td>';
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
        row.innerHTML = '<td colspan="9">暂无记录</td>';
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
        row.innerHTML = '<td colspan="2">暂无记录</td>';
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

  function renderAll() {
    const summary = computeSummary(appState);
    const initialized = ensureOverviewSeriesInitialized(summary);
    if (initialized) {
      appState = saveState(appState);
      writeStateToConnectedFile();
    }
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
      setQuoteStatus("暂无持仓，无法刷新股价");
      return;
    }

    setRefreshAllButtonBusy(true);
    setQuoteStatus("正在拉取最新股价...");

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
          failed > 0
            ? `网络刷新完成：成功 ${success} 条，失败 ${failed} 条（失败项沿用本地现价）`
            : `网络刷新完成：成功 ${success} 条`,
      });
      setQuoteStatus(
        failed > 0 ? `网络刷新成功 ${success} 条，失败 ${failed} 条，已保留本地现价` : `网络刷新成功 ${success} 条`
      );
    } else {
      renderAll();
      showSaveStatus("网络刷新失败：未获取到有效现价，已保留本地现价");
      setQuoteStatus("网络刷新失败，当前使用本地现价");
    }

    setRefreshAllButtonBusy(false);
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

    byId("price-card-list")?.addEventListener("click", async (event) => {
      const autoButton = event.target.closest("button.price-auto");
      if (autoButton) {
        const code = normalizeCode(autoButton.dataset.code || "");
        const originalText = autoButton.textContent;
        autoButton.disabled = true;
        autoButton.textContent = "刷新中...";

        const result = await refreshQuoteForCode(code, { silent: true });
        if (result.ok) {
          const card = byId("price-card-list")?.querySelector(`.price-card[data-code="${code}"]`);
          const input = card?.querySelector("input.price-input");
          const tip = card?.querySelector(".price-card-tip");
          if (input) input.value = String(result.quote.price);
          if (tip) {
            tip.textContent = `网络刷新成功，现价 ${formatCurrency(result.quote.price)}`;
            tip.classList.remove("fallback");
          }
          setQuoteStatus(`${code} 网络刷新成功`);
        } else {
          const card = autoButton.closest(".price-card");
          const tip = card?.querySelector(".price-card-tip");
          if (tip) {
            tip.textContent = "网络获取失败，已保留本地现价";
            tip.classList.add("fallback");
          }
          showSaveStatus(`${code} 网络获取失败，已保留本地现价`);
          setQuoteStatus(`${code} 网络失败，使用本地现价`);
        }

        autoButton.disabled = false;
        autoButton.textContent = originalText;
        return;
      }

      const saveButton = event.target.closest("button.price-save");
      if (!saveButton) return;
      const code = normalizeCode(saveButton.dataset.code || "");
      const card = saveButton.closest(".price-card");
      const input = card?.querySelector("input.price-input");
      const tip = card?.querySelector(".price-card-tip");
      const price = number(input?.value);
      applyPriceUpdate(code, price, { source: "本地" });
      if (tip) {
        tip.textContent = `本地现价已保存：${formatCurrency(price)}`;
        tip.classList.remove("fallback");
      }
      setQuoteStatus(`${code} 本地现价已保存`);
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

  function bindDashboardEvents() {
    if (!byId("dashboard-page")) return;

    byId("price-refresh-all-btn")?.addEventListener("click", () => {
      refreshAllQuotes();
    });
  }

  function init() {
    bindDashboardEvents();
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
