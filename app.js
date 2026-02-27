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
  const FILE_HANDLE_DB_NAME = "equity_fund_file_handle_db";
  const FILE_HANDLE_STORE_NAME = "handles";
  const FILE_HANDLE_RECORD_KEY = "connected_file";
  const SIBLING_LEDGER_PATH = "./ledger.json";
  const LOCAL_BACKUP_KEY = "equity_fund_local_backup_latest";

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

  function parseTimeMs(value) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function isStateMeaningful(state) {
    const summary = computeSummary(state);
    return !isEmptyLedger(summary);
  }

  function pickMemberName(primary, fallback) {
    const p = String(primary || "").trim();
    const f = String(fallback || "").trim();
    if (!p) return f;
    if (!f) return p;
    const pGeneric = /^成员\d+$/u.test(p);
    const fGeneric = /^成员\d+$/u.test(f);
    if (pGeneric && !fGeneric) return f;
    return p;
  }

  function mergeMembers(baseMembers, incomingMembers) {
    const output = [];
    const byId = new Map();

    const upsert = (member) => {
      const id = String(member?.id || "").trim();
      if (!id) return;
      const existing = byId.get(id);
      if (!existing) {
        const row = { id, name: String(member?.name || "").trim() };
        byId.set(id, row);
        output.push(row);
        return;
      }
      existing.name = pickMemberName(existing.name, member?.name);
    };

    (Array.isArray(baseMembers) ? baseMembers : []).forEach(upsert);
    (Array.isArray(incomingMembers) ? incomingMembers : []).forEach(upsert);
    return output;
  }

  function mergeRowsById(baseRows, incomingRows) {
    const map = new Map();
    const output = [];

    const pushRow = (row) => {
      const item = row && typeof row === "object" ? { ...row } : null;
      if (!item) return;
      const id = String(item.id || "").trim();
      if (!id) {
        output.push(item);
        return;
      }
      if (!map.has(id)) {
        map.set(id, item);
        output.push(item);
      } else {
        const index = output.findIndex((r) => String(r?.id || "").trim() === id);
        if (index >= 0) output[index] = item;
        map.set(id, item);
      }
    };

    (Array.isArray(baseRows) ? baseRows : []).forEach(pushRow);
    (Array.isArray(incomingRows) ? incomingRows : []).forEach(pushRow);
    return output;
  }

  function mergePriceMap(basePrices, incomingPrices) {
    return {
      ...(basePrices && typeof basePrices === "object" ? basePrices : {}),
      ...(incomingPrices && typeof incomingPrices === "object" ? incomingPrices : {}),
    };
  }

  function mergeDailyBaselines(baseMap, incomingMap) {
    const output = {};
    const keys = new Set([
      ...Object.keys(baseMap && typeof baseMap === "object" ? baseMap : {}),
      ...Object.keys(incomingMap && typeof incomingMap === "object" ? incomingMap : {}),
    ]);

    keys.forEach((key) => {
      const base = baseMap?.[key] && typeof baseMap[key] === "object" ? baseMap[key] : {};
      const incoming = incomingMap?.[key] && typeof incomingMap[key] === "object" ? incomingMap[key] : {};
      output[key] = {
        ...base,
        ...incoming,
        memberAssets: {
          ...(base.memberAssets && typeof base.memberAssets === "object" ? base.memberAssets : {}),
          ...(incoming.memberAssets && typeof incoming.memberAssets === "object" ? incoming.memberAssets : {}),
        },
        memberInvested: {
          ...(base.memberInvested && typeof base.memberInvested === "object" ? base.memberInvested : {}),
          ...(incoming.memberInvested && typeof incoming.memberInvested === "object" ? incoming.memberInvested : {}),
        },
      };
    });

    return output;
  }

  function mergeOverviewSeries(baseSeries, incomingSeries) {
    const rows = [
      ...(Array.isArray(baseSeries) ? baseSeries : []),
      ...(Array.isArray(incomingSeries) ? incomingSeries : []),
    ];
    const seen = new Set();
    const unique = [];
    rows.forEach((row) => {
      const at = String(row?.at || "").trim();
      const key = `${at}|${number(row?.totalAsset)}|${number(row?.nav)}|${number(row?.totalProfit)}`;
      if (!at || seen.has(key)) return;
      seen.add(key);
      unique.push(row);
    });
    return unique.sort((a, b) => parseTimeMs(a?.at) - parseTimeMs(b?.at)).slice(-1200);
  }

  function mergeStatesPreservingData(localState, siblingState) {
    const local = normalizeState(localState);
    const sibling = normalizeState(siblingState);

    const merged = normalizeState({
      schemaVersion: 1,
      members: mergeMembers(local.members, sibling.members),
      subscriptions: mergeRowsById(local.subscriptions, sibling.subscriptions),
      withdrawals: mergeRowsById(local.withdrawals, sibling.withdrawals),
      trades: mergeRowsById(local.trades, sibling.trades),
      prices: mergePriceMap(local.prices, sibling.prices),
      notes: mergeRowsById(local.notes, sibling.notes),
      logs: mergeRowsById(local.logs, sibling.logs),
      dailyBaselines: mergeDailyBaselines(local.dailyBaselines, sibling.dailyBaselines),
      overviewSeries: mergeOverviewSeries(local.overviewSeries, sibling.overviewSeries),
      updatedAt: parseTimeMs(sibling.updatedAt) >= parseTimeMs(local.updatedAt) ? sibling.updatedAt : local.updatedAt,
    });

    return merged;
  }

  function backupLocalState(reason = "auto-merge") {
    try {
      const backup = {
        reason,
        at: new Date().toISOString(),
        state: normalizeState(appState),
      };
      localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(backup));
      return true;
    } catch {
      return false;
    }
  }

  async function loadSiblingLedgerFile() {
    if (typeof fetch !== "function") {
      return { ok: false, reason: "fetch-unavailable" };
    }

    try {
      const response = await fetch(SIBLING_LEDGER_PATH, { cache: "no-store" });
      if (!response.ok) return { ok: false, reason: `http-${response.status}` };
      const text = await response.text();
      if (!String(text || "").trim()) return { ok: false, reason: "empty-file" };
      const parsed = normalizeState(JSON.parse(text));
      return { ok: true, state: parsed };
    } catch (error) {
      return { ok: false, reason: String(error?.name || "fetch-error") };
    }
  }

  async function autoLoadSiblingLedgerOnInit({ silent = false } = {}) {
    const result = await loadSiblingLedgerFile();
    if (!result.ok || !result.state) return { loaded: false, reason: result.reason || "unavailable" };

    const siblingHasData = isStateMeaningful(result.state);
    const localHasData = isStateMeaningful(appState);

    if (!siblingHasData && !localHasData) return { loaded: false, reason: "both-empty" };

    if (localHasData) {
      backupLocalState("before-sibling-ledger-merge");
    }

    appState = mergeStatesPreservingData(appState, result.state);
    appState = saveState(appState);

    if (!silent) {
      showSaveStatus("已自动读取同级 ledger.json 并合并本地数据");
    }

    return { loaded: true, merged: localHasData, siblingHasData };
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

  function stockCodeDigits(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) return "";
    const matched = code.match(/(\d{6})/);
    return matched ? matched[1] : "";
  }

  function isNameMissingOrCodeLike(name, code) {
    const text = String(name || "").trim();
    if (!text) return true;

    const normalizedName = normalizeCode(text);
    if (/^\d{4,6}$/.test(normalizedName)) return true;
    if (/^(SH|SZ|BJ)\d{6}$/.test(normalizedName)) return true;
    if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalizedName)) return true;

    const codeDigits = stockCodeDigits(code);
    const nameDigits = stockCodeDigits(normalizedName);
    if (codeDigits && nameDigits && codeDigits === nameDigits) return true;

    return false;
  }

  async function repairTradeStockNames({ silent = true } = {}) {
    if (!Array.isArray(appState.trades) || appState.trades.length === 0) {
      return { fixedCount: 0, fetchedCount: 0, failedCount: 0 };
    }

    const knownNameByCode = new Map();
    const fallbackNameByCode = {
      "300807": "天迈科技",
    };
    const rememberName = (rawCode, rawName) => {
      const codeDigits = stockCodeDigits(rawCode);
      const nameText = String(rawName || "").trim();
      if (!codeDigits || isNameMissingOrCodeLike(nameText, rawCode)) return;
      if (!knownNameByCode.has(codeDigits)) {
        knownNameByCode.set(codeDigits, nameText);
      }
    };

    appState.trades.forEach((trade) => {
      rememberName(trade.code, trade.name);
    });

    const summary = computeSummary(appState);
    (summary.holdings || []).forEach((holding) => {
      rememberName(holding.code, holding.name);
    });

    const unknownCodes = new Set();
    let fixedCount = 0;

    appState.trades.forEach((trade) => {
      const codeDigits = stockCodeDigits(trade.code);
      if (!codeDigits) return;
      if (!isNameMissingOrCodeLike(trade.name, trade.code)) return;

      const knownName = knownNameByCode.get(codeDigits);
      if (knownName) {
        trade.name = knownName;
        fixedCount += 1;
      } else {
        unknownCodes.add(codeDigits);
      }
    });

    let fetchedCount = 0;
    let failedCount = 0;

    for (const codeDigits of unknownCodes) {
      const fallbackName = String(fallbackNameByCode[codeDigits] || "").trim();
      if (fallbackName && !isNameMissingOrCodeLike(fallbackName, codeDigits)) {
        knownNameByCode.set(codeDigits, fallbackName);
        fetchedCount += 1;
        continue;
      }

      try {
        const quote = await fetchQuoteByCode(codeDigits);
        const quoteName = String(quote?.name || "").trim();
        if (quoteName && !isNameMissingOrCodeLike(quoteName, codeDigits)) {
          knownNameByCode.set(codeDigits, quoteName);
          fetchedCount += 1;
        } else {
          failedCount += 1;
        }
      } catch {
        failedCount += 1;
      }
    }

    if (fetchedCount > 0) {
      appState.trades.forEach((trade) => {
        const codeDigits = stockCodeDigits(trade.code);
        if (!codeDigits) return;
        if (!isNameMissingOrCodeLike(trade.name, trade.code)) return;
        const knownName = knownNameByCode.get(codeDigits);
        if (knownName) {
          trade.name = knownName;
          fixedCount += 1;
        }
      });
    }

    if (fixedCount > 0) {
      addLog(appState, {
        type: "数据修复",
        detail: `自动修复股票名称 ${fixedCount} 条（网络补全 ${fetchedCount} 条）`,
      });
      persistState({
        notice: silent ? null : `已自动修复 ${fixedCount} 条股票名称`,
      });
    } else if (!silent && unknownCodes.size > 0) {
      showSaveStatus("未修复到有效股票名称（可稍后重试）");
    }

    return { fixedCount, fetchedCount, failedCount };
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

  function setPositiveNegativeOrNeutral(el, value, epsilon = 0.000001) {
    if (!el) return;
    const n = number(value);
    if (Math.abs(n) <= epsilon) {
      clearPositiveNegative(el);
      return;
    }
    setPositiveNegative(el, n);
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

  function supportsFileHandlePersistence() {
    return supportsFsAccess() && typeof indexedDB !== "undefined";
  }

  function openFileHandleDb() {
    return new Promise((resolve, reject) => {
      if (!supportsFileHandlePersistence()) {
        reject(new Error("当前环境不支持文件句柄持久化"));
        return;
      }

      const request = indexedDB.open(FILE_HANDLE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FILE_HANDLE_STORE_NAME)) {
          db.createObjectStore(FILE_HANDLE_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("打开句柄数据库失败"));
    });
  }

  async function persistConnectedFileHandle(handle) {
    if (!supportsFileHandlePersistence() || !handle) return false;
    let db = null;
    try {
      db = await openFileHandleDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_HANDLE_STORE_NAME, "readwrite");
        tx.objectStore(FILE_HANDLE_STORE_NAME).put(handle, FILE_HANDLE_RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("写入文件句柄失败"));
      });
      return true;
    } catch (error) {
      console.warn("持久化文件句柄失败", error);
      return false;
    } finally {
      if (db) db.close();
    }
  }

  async function loadPersistedFileHandle() {
    if (!supportsFileHandlePersistence()) return null;
    let db = null;
    try {
      db = await openFileHandleDb();
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_HANDLE_STORE_NAME, "readonly");
        const req = tx.objectStore(FILE_HANDLE_STORE_NAME).get(FILE_HANDLE_RECORD_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error("读取文件句柄失败"));
      });
      return handle || null;
    } catch (error) {
      console.warn("读取持久化文件句柄失败", error);
      return null;
    } finally {
      if (db) db.close();
    }
  }

  async function clearPersistedFileHandle() {
    if (!supportsFileHandlePersistence()) return false;
    let db = null;
    try {
      db = await openFileHandleDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_HANDLE_STORE_NAME, "readwrite");
        tx.objectStore(FILE_HANDLE_STORE_NAME).delete(FILE_HANDLE_RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("清除文件句柄失败"));
      });
      return true;
    } catch (error) {
      console.warn("清除持久化文件句柄失败", error);
      return false;
    } finally {
      if (db) db.close();
    }
  }

  async function queryFileHandlePermission(handle, mode = "readwrite") {
    if (!handle || typeof handle.queryPermission !== "function") return "granted";
    try {
      return await handle.queryPermission({ mode });
    } catch {
      return "prompt";
    }
  }

  async function requestFileHandlePermission(handle, mode = "readwrite") {
    if (!handle || typeof handle.requestPermission !== "function") return "granted";
    try {
      return await handle.requestPermission({ mode });
    } catch {
      return "denied";
    }
  }

  async function ensureFileHandlePermission(handle, { mode = "readwrite", request = false } = {}) {
    const current = await queryFileHandlePermission(handle, mode);
    if (current === "granted") return true;
    if (!request) return false;
    const next = await requestFileHandlePermission(handle, mode);
    return next === "granted";
  }

  async function disconnectPersistedFile(reason = "已断开连接文件") {
    fileHandle = null;
    await clearPersistedFileHandle();
    setFileStatus(reason);
  }

  async function writeStateToConnectedFile() {
    if (!fileHandle) return;

    if (fileSaveInFlight) {
      fileSaveQueued = true;
      return;
    }

    fileSaveInFlight = true;
    try {
      const granted = await ensureFileHandlePermission(fileHandle, { mode: "readwrite", request: true });
      if (!granted) {
        setFileStatus("连接文件未授权写入，请点击“链接文件”重新授权");
        return;
      }

      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(normalizeState(appState), null, 2));
      await writable.close();
      setFileStatus(`本地文件已更新：${fileHandle.name || "ledger_data.json"}`);
    } catch (error) {
      console.warn("写入本地文件失败", error);
      const name = String(error?.name || "");
      if (name === "NotFoundError") {
        await disconnectPersistedFile("连接文件不存在，请重新链接文件");
      } else if (name === "SecurityError" || name === "NotAllowedError") {
        setFileStatus("连接文件写入被拒绝，请点击“链接文件”重新授权");
      } else {
        setFileStatus(`本地文件写入失败：${error?.message || "未知错误"}`);
      }
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

  function collectTodayOperationStats(summary) {
    const dayStart = startOfLocalDay();
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const isToday = (value) => {
      const time = new Date(value).getTime();
      return Number.isFinite(time) && time >= dayStartMs && time < dayEndMs;
    };

    const subscriptions = (summary.subscriptions || []).filter((row) => isToday(row.at));
    const withdrawals = (summary.withdrawals || []).filter((row) => isToday(row.at));
    const trades = (summary.trades || []).filter((row) => isToday(row.at));
    const buyTrades = trades.filter((trade) => trade.type !== "sell");
    const sellTrades = trades.filter((trade) => trade.type === "sell");

    const subscribedAmount = round(subscriptions.reduce((sum, row) => sum + number(row.amount), 0), 6);
    const withdrawnAmount = round(withdrawals.reduce((sum, row) => sum + number(row.amount), 0), 6);
    const netFlow = round(subscribedAmount - withdrawnAmount, 6);
    const buyAmount = round(buyTrades.reduce((sum, row) => sum + number(row.price) * number(row.quantity), 0), 6);
    const sellAmount = round(sellTrades.reduce((sum, row) => sum + number(row.price) * number(row.quantity), 0), 6);

    return {
      dayStart,
      flowCount: subscriptions.length + withdrawals.length,
      tradeCount: trades.length,
      totalOps: subscriptions.length + withdrawals.length + trades.length,
      subscriptionsCount: subscriptions.length,
      withdrawalsCount: withdrawals.length,
      buyCount: buyTrades.length,
      sellCount: sellTrades.length,
      subscribedAmount,
      withdrawnAmount,
      netFlow,
      buyAmount,
      sellAmount,
    };
  }

  function buildDailyDigest(summary, todaySummary, emptyLedger = false) {
    const todayOps = collectTodayOperationStats(summary);
    const baselineNav = number(todaySummary?.baseline?.nav);
    const navChangePct = !emptyLedger && baselineNav > 0 ? ((number(summary.nav) / baselineNav) - 1) * 100 : 0;

    const holdings = Array.isArray(summary.holdings) ? summary.holdings : [];
    const riseCount = holdings.filter((row) => number(row.pnl) > 0).length;
    const fallCount = holdings.filter((row) => number(row.pnl) < 0).length;
    const upRatio = holdings.length > 0 ? riseCount / holdings.length : 0;

    const navSeries = (Array.isArray(appState.overviewSeries) ? appState.overviewSeries : [])
      .map((row) => ({ at: row?.at, nav: number(row?.nav) }))
      .filter((row) => row.nav > 0 && !Number.isNaN(new Date(row.at).getTime()))
      .slice(-10);

    let momentumPct = 0;
    if (navSeries.length >= 2 && navSeries[0].nav > 0) {
      momentumPct = ((navSeries[navSeries.length - 1].nav / navSeries[0].nav) - 1) * 100;
    }

    let trendScore = 0;
    if (todaySummary.totalTodayProfit > 0.01) trendScore += 1;
    if (todaySummary.totalTodayProfit < -0.01) trendScore -= 1;
    if (navChangePct > 0.15) trendScore += 1;
    if (navChangePct < -0.15) trendScore -= 1;
    if (momentumPct > 0.12) trendScore += 1;
    if (momentumPct < -0.12) trendScore -= 1;
    if (upRatio > 0.66) trendScore += 1;
    if (upRatio < 0.34 && holdings.length > 0) trendScore -= 1;

    let trendLabel = "区间震荡";
    let trendTone = "flat";
    let outlook = "短期方向尚未形成一致信号，建议继续观察净值连续性与仓位结构。";

    if (trendScore >= 2) {
      trendLabel = "短线偏强";
      trendTone = "up";
      outlook = "当前表现偏强，后续可重点跟踪强势持仓的持续性并控制仓位节奏。";
    } else if (trendScore <= -2) {
      trendLabel = "短线偏弱";
      trendTone = "down";
      outlook = "当前波动偏弱，建议优先控制回撤并关注仓位集中风险。";
    }

    let lead = "今日暂无新增记录，账户表现主要来自持仓价格波动。";
    if (emptyLedger) {
      lead = "暂无可统计的当日数据，记录入金与交易后将自动生成每日总结。";
    } else if (todayOps.totalOps > 0) {
      lead = `今日共 ${todayOps.totalOps} 笔操作（资金 ${todayOps.flowCount} 笔，交易 ${todayOps.tradeCount} 笔），资金净流入 ${formatCurrency(todayOps.netFlow)}。`;
    }

    const navSummaryText = emptyLedger || baselineNav <= 0
      ? "净值变化：—"
      : `净值由 ${formatUnits(baselineNav, 8)} 变为 ${formatUnits(summary.nav, 8)}（${formatSignedPercent(navChangePct)}）。`;

    const footnote = emptyLedger
      ? "当日收益将在有数据后按“昨日总资产 + 今日净入金”为基线计算。"
      : `当日收益按“当前总资产 - (昨日总资产 + 今日净入金)”计算；今日交易金额 ${formatCurrency(todayOps.buyAmount + todayOps.sellAmount)}。`;

    return {
      todayOps,
      lead,
      trendLabel,
      trendTone,
      outlook,
      navChangePct,
      navSummaryText,
      footnote,
      momentumPct,
      riseCount,
      fallCount,
      holdingsCount: holdings.length,
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

    const digest = buildDailyDigest(summary, todaySummary, emptyLedger);
    setText("dash-daily-summary-date", `统计日期：${formatDate(new Date())}`);
    setText("dash-daily-summary-lead", digest.lead);
    setText("dash-daily-summary-outlook", digest.outlook);
    setText("dash-daily-ops-count", `${digest.todayOps.totalOps} 笔`);
    setText("dash-daily-net-flow", formatCurrency(digest.todayOps.netFlow));
    setText("dash-daily-nav-change", emptyLedger ? "—" : formatSignedPercent(digest.navChangePct));
    setText("dash-daily-trade-breakdown", `买${digest.todayOps.buyCount} / 卖${digest.todayOps.sellCount}`);
    const riseText = digest.holdingsCount > 0 ? `上涨持仓 ${digest.riseCount}/${digest.holdingsCount}` : "暂无持仓";
    setText(
      "dash-daily-summary-trend",
      emptyLedger
        ? "趋势研判：—"
        : `趋势研判：${digest.trendLabel}（近段净值${formatSignedPercent(digest.momentumPct)}，${riseText}）`
    );
    setText("dash-daily-summary-footnote", `${digest.navSummaryText} ${digest.footnote}`);

    const trendEl = byId("dash-daily-summary-trend");
    if (trendEl) {
      trendEl.classList.remove("trend-up", "trend-down", "trend-flat");
      if (!emptyLedger) trendEl.classList.add(`trend-${digest.trendTone}`);
    }

    if (emptyLedger) {
      clearPositiveNegative(byId("dash-daily-net-flow"));
      clearPositiveNegative(byId("dash-daily-nav-change"));
    } else {
      setPositiveNegativeOrNeutral(byId("dash-daily-net-flow"), digest.todayOps.netFlow);
      setPositiveNegativeOrNeutral(byId("dash-daily-nav-change"), digest.navChangePct);
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
    
    // 更新交易优化器状态
    if (window.TradeOptimizer && window.TradeOptimizer.updateState) {
      try {
        window.TradeOptimizer.updateState(appState, summary);
      } catch (error) {
        console.warn('交易优化器状态更新失败:', error);
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
    
    // 初始化交易优化器
    if (window.TradeOptimizer && window.TradeOptimizer.init) {
      try {
        window.TradeOptimizer.init(appState, summary);
      } catch (error) {
        console.warn('交易优化器初始化失败:', error);
      }
    }
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
    
    // 使用交易优化器获取交易数据
    let tradeData;
    if (window.TradeOptimizer && window.TradeOptimizer.getTradeData) {
      tradeData = window.TradeOptimizer.getTradeData();
    } else {
      // 回退到旧逻辑
      tradeData = {
        type: byId("trade-type")?.value === "sell" ? "sell" : "buy",
        code: normalizeCode(byId("trade-code")?.value),
        name: String(byId("trade-name")?.value || "").trim(),
        price: number(byId("trade-price")?.value),
        quantity: number(byId("trade-quantity")?.value),
        sourceMemberId: String(byId("trade-source-member")?.value || "pool").trim() || "pool",
        note: String(byId("trade-note")?.value || "").trim()
      };
    }
    
    const { type, code, name, price, quantity, sourceMemberId, note } = tradeData;
    
    // 使用交易优化器验证数据
    let validation;
    if (window.TradeOptimizer && window.TradeOptimizer.validateTradeData) {
      validation = window.TradeOptimizer.validateTradeData(tradeData);
    } else {
      // 基本验证
      if (!code) {
        validation = { valid: false, message: "请输入股票代码" };
      } else if (price <= 0 || quantity <= 0) {
        validation = { valid: false, message: "请输入有效的价格和数量" };
      } else {
        validation = { valid: true };
      }
    }
    
    if (!validation.valid) {
      showSaveStatus(validation.message);
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

    // 清空交易表单
    if (window.TradeOptimizer && window.TradeOptimizer.clearForm) {
      window.TradeOptimizer.clearForm();
    } else {
      // 回退到旧逻辑
      const priceInput = byId("trade-price");
      const qtyInput = byId("trade-quantity");
      const noteInput = byId("trade-note");
      if (priceInput) priceInput.value = "";
      if (qtyInput) qtyInput.value = "";
      if (noteInput) noteInput.value = "";
    }

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
      await persistConnectedFileHandle(handle);
      const granted = await ensureFileHandlePermission(handle, { mode: "readwrite", request: true });
      if (!granted) {
        setFileStatus(`已记住文件：${handle.name}（请授权后自动同步）`);
        return;
      }

      const file = await handle.getFile();
      const text = await file.text();

      if (text.trim()) {
        const parsed = JSON.parse(text);
        appState = normalizeState(parsed);
        appState = saveState(appState);
        renderAll();
        showSaveStatus("已从本地文件载入数据");
      }

      setFileStatus(`已连接文件：${handle.name}（后续将自动同步）`);
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
        if (fileHandle) {
          await persistConnectedFileHandle(fileHandle);
        }
      }

      await writeStateToConnectedFile();
      setFileStatus(`已保存到文件：${fileHandle?.name || "ledger.json"}`);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setFileStatus(`保存文件失败：${error?.message || "未知错误"}`);
    }
  }

  async function loadFromConnectedFile({ silent = false, requestPermission = true } = {}) {
    if (!fileHandle) {
      setFileStatus("请先连接本地文件");
      return false;
    }

    try {
      const granted = await ensureFileHandlePermission(fileHandle, { mode: "read", request: requestPermission });
      if (!granted) {
        setFileStatus("连接文件未授权读取，请点击“链接文件”重新授权");
        return false;
      }

      const file = await fileHandle.getFile();
      const text = await file.text();
      if (!text.trim()) {
        setFileStatus("文件为空，未载入");
        return false;
      }

      appState = normalizeState(JSON.parse(text));
      appState = saveState(appState);
      renderAll();
      if (!silent) showSaveStatus("已从连接文件刷新数据");
      setFileStatus(`已从文件载入：${fileHandle.name}`);
      return true;
    } catch (error) {
      const name = String(error?.name || "");
      if (name === "NotFoundError") {
        await disconnectPersistedFile("连接文件不存在，请重新链接文件");
      } else {
        setFileStatus(`载入文件失败：${error?.message || "未知错误"}`);
      }
      return false;
    }
  }

  async function restoreConnectedFileOnInit() {
    if (!byId("operation-page")) return false;
    if (!supportsFileHandlePersistence()) return false;

    const handle = await loadPersistedFileHandle();
    if (!handle) return false;

    fileHandle = handle;
    const loaded = await loadFromConnectedFile({ silent: true, requestPermission: true });
    if (loaded) {
      setFileStatus(`已自动连接文件：${handle.name}`);
      return true;
    }

    return false;
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

  async function init() {
    bindDashboardEvents();
    bindOperationEvents();

    const operationPage = Boolean(byId("operation-page"));
    const siblingLoaded = await autoLoadSiblingLedgerOnInit({ silent: true });
    let autoLinked = false;

    if (operationPage) {
      if (siblingLoaded.loaded) {
        setFileStatus("已自动读取同级 ledger.json（如需改用其他文件，可手动连接）");
      } else {
        setFileStatus("正在检查已连接文件...");
        autoLinked = await restoreConnectedFileOnInit();
      }
    }

    renderAll();
    repairTradeStockNames({ silent: !operationPage });

    if (operationPage) {
      if (!autoLinked && !fileHandle) {
        if (!siblingLoaded.loaded) {
          setFileStatus("当前模式：本地存储（可连接/导入 JSON 文件）");
        }
      }
      if (siblingLoaded.loaded) {
        showSaveStatus("已自动加载同级 ledger.json");
      } else {
        showSaveStatus(autoLinked ? "已自动加载连接文件数据" : "已加载本地数据");
      }
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
    repairTradeStockNames,
    addAdminNote,
    clearAllData,
    renderAll,
  };

  init();
})(window);
