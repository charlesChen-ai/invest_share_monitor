// 交易界面优化模块
// 提供智能股票搜索、持仓提示、实时价格参考等功能

(function initTradeOptimizerModule(global) {
  const storage = global.LedgerStorage || {};
  const core = global.LedgerCore || {};
  
  // 从storage获取number函数，因为core中没有导出
  const number = storage.number || ((value) => Number(value) || 0);
  const { round, normalizeCode } = core;
  
  let appState = null;
  let currentSummary = null;
  let selectedStock = null;
  let searchTimeout = null;
  let searchRequestId = 0;
  let remoteSearchVersion = 0;
  const remoteSearchCache = new Map();
  const STOCK_SUFFIX_RE = /\.(SZ|SH|BJ)$/i;
  const DEBUG_PREFIX = '[TradeOptimizer]';
  
  function logDebug(message, payload = null) {
    if (payload === null) {
      console.log(`${DEBUG_PREFIX} ${message}`);
      return;
    }
    console.log(`${DEBUG_PREFIX} ${message}`, payload);
  }
  
  function normalizeStockCode(value) {
    if (typeof normalizeCode === 'function') {
      return normalizeCode(value);
    }
    return String(value || '').trim().toUpperCase();
  }
  
  function stripStockSuffix(value) {
    return normalizeStockCode(value).replace(STOCK_SUFFIX_RE, '');
  }
  
  function isCodeLikeInput(value) {
    return /^\d{4,6}(\.(SZ|SH|BJ))?$/i.test(normalizeStockCode(value));
  }
  
  function guessSuffixByCode(codeWithoutSuffix) {
    if (/^[689]/.test(codeWithoutSuffix)) return '.SH';
    if (/^[03]/.test(codeWithoutSuffix)) return '.SZ';
    if (/^[48]/.test(codeWithoutSuffix)) return '.BJ';
    return '';
  }
  
  function getHoldings() {
    return Array.isArray(currentSummary?.holdings) ? currentSummary.holdings : [];
  }
  
  function getTradeRows() {
    return Array.isArray(currentSummary?.tradeRows) ? currentSummary.tradeRows : [];
  }
  
  function extractInputCodeCandidate(inputValue) {
    const normalizedInput = normalizeStockCode(inputValue);
    if (!normalizedInput) return '';
    
    const [firstToken = ''] = normalizedInput.split(/\s+/);
    if (isCodeLikeInput(firstToken)) return firstToken;
    
    const matched = normalizedInput.match(/\d{6}(?:\.(?:SZ|SH|BJ))?/i);
    return matched ? normalizeStockCode(matched[0]) : '';
  }
  
  function findHoldingByCode(code) {
    const normalizedCode = normalizeStockCode(code);
    if (!normalizedCode) return null;
    
    const targetWithoutSuffix = stripStockSuffix(normalizedCode);
    const holdings = getHoldings();
    
    return (
      holdings.find((holding) => {
        const holdingCode = normalizeStockCode(holding.code);
        if (!holdingCode) return false;
        if (holdingCode === normalizedCode) return true;
        return stripStockSuffix(holdingCode) === targetWithoutSuffix;
      }) || null
    );
  }
  
  function findTradeByCode(code) {
    const normalizedCode = normalizeStockCode(code);
    if (!normalizedCode) return null;
    
    const targetWithoutSuffix = stripStockSuffix(normalizedCode);
    const tradeRows = getTradeRows();
    
    return (
      tradeRows.find((trade) => {
        const tradeCode = normalizeStockCode(trade.code);
        if (!tradeCode) return false;
        if (tradeCode === normalizedCode) return true;
        return stripStockSuffix(tradeCode) === targetWithoutSuffix;
      }) || null
    );
  }
  
  function findStockNameByCode(code) {
    const holding = findHoldingByCode(code);
    if (holding?.name) return String(holding.name).trim();
    
    const trade = findTradeByCode(code);
    if (trade?.name) return String(trade.name).trim();
    
    return '';
  }

  function dedupeStockResults(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const output = [];
    const indexMap = new Map();
    const isGenericName = (name, code) => {
      const text = String(name || '').trim();
      if (!text) return true;
      const normalizedName = normalizeStockCode(text);
      const normalizedCode = normalizeStockCode(code);
      return normalizedName === normalizedCode || stripStockSuffix(normalizedName) === stripStockSuffix(normalizedCode);
    };
    list.forEach((item) => {
      const code = normalizeStockCode(item?.code);
      if (!code) return;
      const incomingName = String(item?.name || '').trim() || code;
      const incomingHolding = item?.holding || findHoldingByCode(code) || null;
      const existingIndex = indexMap.get(code);

      if (existingIndex === undefined) {
        output.push({
          code,
          name: incomingName,
          holding: incomingHolding
        });
        indexMap.set(code, output.length - 1);
        return;
      }

      const existing = output[existingIndex];
      if (!existing) return;

      if (isGenericName(existing.name, code) && !isGenericName(incomingName, code)) {
        existing.name = incomingName;
      }
      if (!existing.holding && incomingHolding) {
        existing.holding = incomingHolding;
      }
    });
    return output;
  }

  function mergeStockResults(localRows, remoteRows) {
    const merged = [];
    const pushRows = (rows = [], isRemote = false) => {
      rows.forEach((item) => {
        merged.push({
          code: normalizeStockCode(item?.code),
          name: String(item?.name || '').trim(),
          holding: item?.holding || null,
          isRemote
        });
      });
    };

    pushRows(localRows, false);
    pushRows(remoteRows, true);
    return dedupeStockResults(merged);
  }

  function toTencentSymbol(rawCode) {
    const code = normalizeStockCode(rawCode);
    if (!code) return '';
    if (/^(SH|SZ|BJ)\d{6}$/i.test(code)) {
      return `${code.slice(0, 2).toLowerCase()}${code.slice(2)}`;
    }
    const digits = stripStockSuffix(code);
    if (!/^\d{6}$/.test(digits)) return '';
    if (/^[659]/.test(digits)) return `sh${digits}`;
    if (/^[03]/.test(digits)) return `sz${digits}`;
    if (/^[48]/.test(digits)) return `bj${digits}`;
    return '';
  }

  function fetchTencentQuoteByCode(rawCode) {
    return new Promise((resolve, reject) => {
      const symbol = toTencentSymbol(rawCode);
      if (!symbol) {
        reject(new Error('无效代码'));
        return;
      }

      const variableName = `v_${symbol}`;
      const script = document.createElement('script');
      let timeoutId = null;

      const cleanup = () => {
        script.onerror = null;
        script.onload = null;
        script.remove();
        if (timeoutId) clearTimeout(timeoutId);
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('腾讯行情超时'));
      }, 7000);

      delete window[variableName];
      script.src = `https://qt.gtimg.cn/q=${symbol}&_=${Date.now()}`;
      script.charset = 'gbk';

      script.onload = () => {
        const payload = String(window[variableName] || '').trim();
        cleanup();
        const body = payload.replace(/^"+|"+$/g, '');
        const parts = body.split('~');
        const name = String(parts[1] || '').trim();
        const code = normalizeStockCode(parts[2] || stripStockSuffix(rawCode));
        if (!code || !name) {
          reject(new Error('腾讯行情缺少名称'));
          return;
        }
        resolve({ code, name });
      };

      script.onerror = () => {
        cleanup();
        reject(new Error('腾讯行情失败'));
      };

      document.head.appendChild(script);
    });
  }

  function parseSinaSuggestPayload(raw) {
    const body = String(raw || '').trim();
    if (!body) return [];

    const rows = body.split(';').map((row) => row.trim()).filter(Boolean);
    const result = [];

    rows.forEach((row) => {
      const parts = row.split(',').map((part) => String(part || '').trim());
      if (!parts.length) return;

      const codeIndex = parts.findIndex((part) => /^\d{6}$/.test(part) || /^(?:sh|sz|bj)\d{6}$/i.test(part));
      if (codeIndex < 0) return;

      const rawCode = parts[codeIndex];
      const code = normalizeStockCode(rawCode).replace(/^(SH|SZ|BJ)/i, '');
      if (!/^\d{6}$/.test(code)) return;

      const candidateName = parts.slice(codeIndex + 1).find((part) => {
        if (!part) return false;
        if (/^\d+$/.test(part)) return false;
        if (/^(?:sh|sz|bj)\d{6}$/i.test(part)) return false;
        if (/^\d{6}$/.test(part)) return false;
        return /[\u4e00-\u9fa5A-Za-z]/.test(part);
      });

      const name = String(candidateName || '').trim();
      if (!name) return;

      result.push({ code, name });
    });

    return dedupeStockResults(result);
  }

  function fetchSinaSuggestions(query) {
    return new Promise((resolve, reject) => {
      const keyword = String(query || '').trim();
      if (!keyword) {
        resolve([]);
        return;
      }

      const callbackName = `suggestdata_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const script = document.createElement('script');
      let timeoutId = null;

      const cleanup = () => {
        script.onerror = null;
        script.onload = null;
        script.remove();
        if (timeoutId) clearTimeout(timeoutId);
        try {
          delete window[callbackName];
        } catch {
          window[callbackName] = undefined;
        }
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('新浪联想超时'));
      }, 7000);

      script.src = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(keyword)}&name=${callbackName}`;
      script.charset = 'gbk';

      script.onload = () => {
        const payload = window[callbackName];
        cleanup();
        resolve(parseSinaSuggestPayload(payload));
      };

      script.onerror = () => {
        cleanup();
        reject(new Error('新浪联想失败'));
      };

      document.head.appendChild(script);
    });
  }

  async function searchStocksRemote(query) {
    const rawQuery = String(query || '').trim();
    if (rawQuery.length < 2) return [];

    const cacheKey = normalizeStockCode(rawQuery);
    if (remoteSearchCache.has(cacheKey)) {
      return remoteSearchCache.get(cacheKey);
    }

    const codeCandidate = extractInputCodeCandidate(rawQuery);
    const remoteRows = [];

    try {
      const list = await fetchSinaSuggestions(rawQuery);
      remoteRows.push(...list);
    } catch (error) {
      logDebug('新浪搜索失败，降级处理', { query: rawQuery, message: error?.message || String(error) });
    }

    if (codeCandidate) {
      const pureCode = stripStockSuffix(codeCandidate);
      const exists = remoteRows.some((item) => stripStockSuffix(item.code) === pureCode);
      if (!exists) {
        try {
          const quote = await fetchTencentQuoteByCode(codeCandidate);
          remoteRows.push({ code: quote.code, name: quote.name });
        } catch (error) {
          logDebug('腾讯代码补全失败', { query: rawQuery, message: error?.message || String(error) });
        }
      }
    }

    const output = dedupeStockResults(remoteRows).slice(0, 20);
    remoteSearchCache.set(cacheKey, output);
    return output;
  }
  
  // 初始化交易优化器
  function init(state, summary) {
    appState = state;
    currentSummary = summary;
    selectedStock = null;
    remoteSearchVersion += 1;
    remoteSearchCache.clear();
    
    setupTradeTypeSelector();
    setupStockSearch();
    setupTradeInputListeners();
    setupClearFormButton();
    updateTradeSubmitButton();
    updateCashBalance();
    
    // 初始化资金来源选择器
    updateSourceMemberOptions();
  }
  
  // 设置交易类型选择器
  function setupTradeTypeSelector() {
    const buyRadio = document.getElementById('trade-type-buy');
    const sellRadio = document.getElementById('trade-type-sell');
    
    if (buyRadio && sellRadio) {
      const updateTradeType = () => {
        const isSell = sellRadio.checked;
        updateTradeSubmitButton();
        updateStockSearchPlaceholder();
        updateHoldingInfo();
        updateTradeValidation();
      };
      
      buyRadio.addEventListener('change', updateTradeType);
      sellRadio.addEventListener('change', updateTradeType);
      
      // 初始更新
      updateTradeType();
    }
  }
  
  // 设置股票搜索
  function setupStockSearch() {
    const searchInput = document.getElementById('stock-search');
    const suggestions = document.getElementById('stock-suggestions');
    
    if (!searchInput || !suggestions) return;
    
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        const query = searchInput.value.trim();
        if (query.length >= 2) {
          showStockSuggestions(query);
        } else {
          hideSuggestions();
        }
      }, 300);
    });
    
    searchInput.addEventListener('focus', () => {
      const query = searchInput.value.trim();
      if (query.length >= 2) {
        showStockSuggestions(query);
      }
    });
    
    // 点击外部隐藏建议
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !suggestions.contains(e.target)) {
        hideSuggestions();
      }
    });
    
    // 键盘导航
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideSuggestions();
      } else if (e.key === 'Enter') {
        // 按Enter键时尝试选择股票
        e.preventDefault();
        trySelectStockFromInput();
      }
    });
    
    // 失去焦点时尝试选择股票
    searchInput.addEventListener('blur', () => {
      setTimeout(() => {
        trySelectStockFromInput();
      }, 200); // 延迟一点，让点击建议有时间处理
    });
  }
  
  // 尝试从输入框选择股票
  async function trySelectStockFromInput() {
    const searchInput = document.getElementById('stock-search');
    if (!searchInput) return;
    
    const rawQuery = searchInput.value.trim();
    if (!rawQuery) return;
    const localVersion = remoteSearchVersion;
    
    const normalizedQuery = normalizeStockCode(rawQuery);
    const queryLower = rawQuery.toLowerCase();
    const codeCandidate = extractInputCodeCandidate(rawQuery);
    const targetCode = codeCandidate || normalizedQuery;
    const targetWithoutSuffix = stripStockSuffix(targetCode);
    
    logDebug('尝试根据输入自动选择股票', {
      rawQuery,
      normalizedQuery,
      codeCandidate
    });
    
    const localResults = searchStocks(rawQuery);
    const remoteResults = await searchStocksRemote(rawQuery);
    if (localVersion !== remoteSearchVersion) return;
    if (searchInput.value.trim() !== rawQuery) return;
    let results = mergeStockResults(localResults, remoteResults);
    
    const pickBestResult = () => {
      if (!results.length) return null;
      const exactMatch = results.find((item) => {
        const itemCode = normalizeStockCode(item.code);
        return itemCode === targetCode || stripStockSuffix(itemCode) === targetWithoutSuffix;
      });
      if (exactMatch) return exactMatch;
      const exactName = results.find((item) => String(item.name || '').trim().toLowerCase() === queryLower);
      if (exactName) return exactName;
      const prefixName = results.find((item) => String(item.name || '').trim().toLowerCase().startsWith(queryLower));
      return prefixName || results[0];
    };
    
    let matchedStock = pickBestResult();
    
    if (!matchedStock && codeCandidate) {
      const codeWithSuffix = tryAddStockSuffix(codeCandidate);
      if (codeWithSuffix && codeWithSuffix !== codeCandidate) {
        logDebug('首次搜索未命中，补后缀后重试', {
          inputCode: codeCandidate,
          codeWithSuffix
        });
        const localRetry = searchStocks(codeWithSuffix);
        const remoteRetry = await searchStocksRemote(codeWithSuffix);
        if (localVersion !== remoteSearchVersion) return;
        if (searchInput.value.trim() !== rawQuery) return;
        results = mergeStockResults(localRetry, remoteRetry);
        matchedStock = results.find((item) => {
          const itemCode = normalizeStockCode(item.code);
          return itemCode === codeWithSuffix || stripStockSuffix(itemCode) === stripStockSuffix(codeWithSuffix);
        }) || results[0] || null;
      }
    }
    
    if (matchedStock) {
      logDebug('自动选择股票成功', {
        selectedCode: matchedStock.code,
        selectedName: matchedStock.name
      });
      selectStock(matchedStock.code, matchedStock.name);
    } else {
      logDebug('自动选择股票失败，清空当前选择', { rawQuery });
      selectedStock = null;
      updateHoldingInfo();
      updatePriceReference();
      updateTradeValidation();
    }
    
    hideSuggestions();
  }
  
  // 尝试为股票代码添加后缀
  function tryAddStockSuffix(code) {
    const normalized = normalizeStockCode(code);
    if (!normalized) return '';
    
    // 如果已经包含后缀，直接返回
    if (STOCK_SUFFIX_RE.test(normalized)) {
      return normalized;
    }
    
    const baseCode = stripStockSuffix(normalized);
    const candidates = [];
    
    getHoldings().forEach((holding, index) => {
      const holdingCode = normalizeStockCode(holding.code);
      if (stripStockSuffix(holdingCode) === baseCode) {
        candidates.push({ code: holdingCode, source: 'holding', priority: 1, index });
      }
    });
    
    getTradeRows().forEach((trade, index) => {
      const tradeCode = normalizeStockCode(trade.code);
      if (stripStockSuffix(tradeCode) === baseCode) {
        candidates.push({ code: tradeCode, source: 'trade', priority: 2, index });
      }
    });
    
    if (appState?.prices && typeof appState.prices === 'object') {
      Object.keys(appState.prices).forEach((priceCode, index) => {
        const normalizedPriceCode = normalizeStockCode(priceCode);
        if (stripStockSuffix(normalizedPriceCode) === baseCode) {
          candidates.push({ code: normalizedPriceCode, source: 'price', priority: 3, index });
        }
      });
    }
    
    if (candidates.length) {
      candidates.sort((a, b) => a.priority - b.priority || a.index - b.index);
      const bestMatch = candidates[0].code;
      logDebug('根据已有数据匹配到股票后缀', {
        inputCode: normalized,
        matchedCode: bestMatch,
        candidateCount: candidates.length
      });
      return bestMatch;
    }
    
    // 向后兼容：没有已知数据时按常见规则猜测后缀
    const guessedSuffix = guessSuffixByCode(baseCode);
    if (guessedSuffix) {
      const guessedCode = `${baseCode}${guessedSuffix}`;
      logDebug('未命中持仓/交易，按规则推断后缀', {
        inputCode: normalized,
        guessedCode
      });
      return guessedCode;
    }
    
    logDebug('无法推断后缀，保留原始代码', { inputCode: normalized });
    return normalized;
  }
  
  // 显示股票建议
  async function showStockSuggestions(query) {
    const suggestions = document.getElementById('stock-suggestions');
    if (!suggestions) return;
    const currentRequestId = ++searchRequestId;
    
    suggestions.innerHTML = '<div class="stock-suggestion-item">检索中...</div>';
    suggestions.style.display = 'block';

    const localResults = searchStocks(query);
    const remoteResults = await searchStocksRemote(query);
    if (currentRequestId !== searchRequestId) return;
    const results = mergeStockResults(localResults, remoteResults);
    
    if (results.length === 0) {
      suggestions.innerHTML = '<div class="stock-suggestion-item">未找到匹配的股票</div>';
    } else {
      suggestions.innerHTML = results.map(stock => `
        <div class="stock-suggestion-item" data-code="${stock.code}" data-name="${stock.name}">
          <div>
            <div class="stock-suggestion-code">${stock.code}</div>
            <div class="stock-suggestion-name">${stock.name}</div>
          </div>
          ${stock.holding ? `<div class="stock-suggestion-holding">持仓: ${formatUnits(stock.holding.quantity, 3)}股</div>` : ''}
        </div>
      `).join('');
      
      // 添加点击事件
      suggestions.querySelectorAll('.stock-suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
          const code = item.dataset.code;
          const name = item.dataset.name;
          selectStock(code, name);
          hideSuggestions();
        });
      });
    }
    
    suggestions.style.display = 'block';
  }
  
  // 搜索股票
  function searchStocks(query) {
    if (!currentSummary) return [];
    
    const rawQuery = String(query || '').trim();
    if (!rawQuery) return [];
    
    const normalizedQuery = normalizeStockCode(rawQuery);
    const queryLower = normalizedQuery.toLowerCase();
    const queryCodeCandidate = extractInputCodeCandidate(rawQuery);
    const queryWithoutSuffix = stripStockSuffix(queryCodeCandidate || normalizedQuery);
    
    const resultMap = new Map();
    
    const pushIfMatched = ({ code, name, holding, priority }) => {
      const normalizedCode = normalizeStockCode(code);
      if (!normalizedCode) return;
      
      const codeWithoutSuffix = stripStockSuffix(normalizedCode);
      const stockName = String(name || '').trim() || normalizedCode;
      
      const codeMatches = normalizedCode.toLowerCase().includes(queryLower) ||
        codeWithoutSuffix.toLowerCase().includes(queryLower) ||
        (queryCodeCandidate && codeWithoutSuffix === queryWithoutSuffix);
      const nameMatches = stockName.toLowerCase().includes(queryLower);
      
      if (!codeMatches && !nameMatches) return;
      
      const exactCodeMatch = normalizedCode === normalizedQuery || codeWithoutSuffix === queryWithoutSuffix;
      const score = priority * 10 + (exactCodeMatch ? 0 : 1);
      const existing = resultMap.get(normalizedCode);
      
      if (!existing || score < existing.score) {
        resultMap.set(normalizedCode, {
          code: normalizedCode,
          name: stockName,
          holding: holding || findHoldingByCode(normalizedCode),
          priority,
          score
        });
      }
    };
    
    getHoldings().forEach((holding) => {
      pushIfMatched({
        code: holding.code,
        name: holding.name,
        holding,
        priority: 1
      });
    });
    
    getTradeRows().forEach((trade) => {
      pushIfMatched({
        code: trade.code,
        name: trade.name,
        holding: findHoldingByCode(trade.code),
        priority: 2
      });
    });
    
    const sortedResults = [...resultMap.values()]
      .sort((a, b) => a.score - b.score || a.code.localeCompare(b.code, 'zh-CN'))
      .map(({ score, ...item }) => item);
    
    logDebug('股票搜索结果', {
      query: rawQuery,
      normalizedQuery,
      resultCount: sortedResults.length,
      topCodes: sortedResults.slice(0, 5).map((item) => item.code)
    });
    
    return sortedResults;
  }
  
  // 选择股票
  function selectStock(code, name) {
    const normalizedInputCode = normalizeStockCode(code);
    const canonicalCode = tryAddStockSuffix(normalizedInputCode) || normalizedInputCode;
    const canonicalName = String(name || '').trim() || findStockNameByCode(canonicalCode) || canonicalCode;
    
    selectedStock = { code: canonicalCode, name: canonicalName };
    
    const holding = findHoldingByCode(canonicalCode);
    logDebug('已选择股票', {
      inputCode: code,
      normalizedInputCode,
      selectedCode: canonicalCode,
      selectedName: canonicalName,
      holdingMatched: !!holding
    });
    
    // 更新搜索框
    const searchInput = document.getElementById('stock-search');
    if (searchInput) {
      searchInput.value = `${selectedStock.code} ${selectedStock.name}`;
    }
    
    // 更新隐藏的代码和名称字段（向后兼容）
    const codeInput = document.getElementById('trade-code');
    const nameInput = document.getElementById('trade-name');
    if (codeInput) codeInput.value = selectedStock.code;
    if (nameInput) nameInput.value = selectedStock.name;
    
    // 更新持仓信息
    updateHoldingInfo();
    
    // 更新价格参考
    updatePriceReference();
    
    // 更新交易验证
    updateTradeValidation();
  }
  
  // 更新持仓信息
  function updateHoldingInfo() {
    const holdingInfo = document.getElementById('current-holding-info');
    const quantityDisplay = document.getElementById('current-holding-quantity');
    const sellableLabel = document.getElementById('sellable-quantity-label');
    
    if (!holdingInfo || !quantityDisplay) return;
    
    if (!selectedStock || !currentSummary) {
      holdingInfo.innerHTML = '<div class="holding-info-placeholder"><span>选择股票后显示持仓信息</span></div>';
      quantityDisplay.textContent = '0';
      if (sellableLabel) sellableLabel.innerHTML = '可卖: <strong>0</strong> 股';
      return;
    }
    
    const holding = findHoldingByCode(selectedStock.code);
    const isSell = document.getElementById('trade-type-sell')?.checked;
    
    logDebug('更新持仓显示', {
      selectedCode: selectedStock.code,
      matchedHoldingCode: holding?.code || null
    });
    
    if (holding) {
      const quantity = number(holding.quantity);
      const costPrice = number(
        holding.costPrice !== undefined && holding.costPrice !== null
          ? holding.costPrice
          : holding.avgCost
      );
      const pnl = number(holding.pnl);
      const marketValue = number(holding.marketValue);
      const costValueFromRow = number(holding.costValue);
      const costValue = costValueFromRow > 0 ? costValueFromRow : costPrice * quantity;
      const pnlPercent = Number.isFinite(Number(holding.pnlPercent))
        ? number(holding.pnlPercent)
        : (costValue > 0 ? (pnl / costValue) * 100 : 0);
      
      quantityDisplay.textContent = formatUnits(holding.quantity, 3);
      
      if (sellableLabel) {
        sellableLabel.innerHTML = `可卖: <strong>${formatUnits(holding.quantity, 3)}</strong> 股`;
      }
      
      holdingInfo.innerHTML = `
        <div class="holding-info-active">
          <div class="holding-stock-header">
            <div>
              <div class="holding-stock-code">${holding.code}</div>
              <div class="holding-stock-name">${holding.name}</div>
            </div>
            <div class="stock-suggestion-holding">已持仓</div>
          </div>
          <div class="holding-metrics">
            <div class="holding-metric">
              <div class="holding-metric-label">持仓数量</div>
              <div class="holding-metric-value">${formatUnits(holding.quantity, 3)} 股</div>
            </div>
            <div class="holding-metric">
              <div class="holding-metric-label">成本均价</div>
              <div class="holding-metric-value">${formatCurrency(costPrice)}</div>
            </div>
            <div class="holding-metric">
              <div class="holding-metric-label">当前市值</div>
              <div class="holding-metric-value">${formatCurrency(marketValue)}</div>
            </div>
            <div class="holding-metric">
              <div class="holding-metric-label">持仓盈亏</div>
              <div class="holding-metric-value ${pnl >= 0 ? 'positive' : 'negative'}">
                ${formatCurrency(pnl)} (${pnlPercent.toFixed(2)}%)
              </div>
            </div>
          </div>
        </div>
      `;
    } else {
      quantityDisplay.textContent = '0';
      if (sellableLabel) sellableLabel.innerHTML = '可卖: <strong>0</strong> 股';
      
      holdingInfo.innerHTML = `
        <div class="holding-info-active">
          <div class="holding-stock-header">
            <div>
              <div class="holding-stock-code">${selectedStock.code}</div>
              <div class="holding-stock-name">${selectedStock.name}</div>
            </div>
            <div style="color: #7f8c8d; font-size: 0.85rem;">未持仓</div>
          </div>
          <div class="holding-metrics">
            <div class="holding-metric">
              <div class="holding-metric-label">持仓状态</div>
              <div class="holding-metric-value">当前未持有该股票</div>
            </div>
            <div class="holding-metric">
              <div class="holding-metric-label">交易类型</div>
              <div class="holding-metric-value">仅可进行买入操作</div>
            </div>
          </div>
        </div>
      `;
      
      // 如果是卖出模式但未持仓，自动切换到买入模式
      if (isSell) {
        const buyRadio = document.getElementById('trade-type-buy');
        if (buyRadio) {
          buyRadio.checked = true;
          updateTradeSubmitButton();
        }
      }
    }
  }
  
  // 更新价格参考
  function updatePriceReference() {
    const priceRef = document.getElementById('latest-price-ref');
    const priceSource = document.getElementById('price-source');
    
    if (!priceRef || !priceSource || !selectedStock) {
      if (priceRef) priceRef.textContent = '-';
      if (priceSource) priceSource.textContent = '(本地价格)';
      return;
    }
    
    const currentPrice = getCurrentPrice(selectedStock.code);
    
    if (currentPrice > 0) {
      priceRef.textContent = formatCurrency(currentPrice);
      priceSource.textContent = '(本地价格)';
      
      // 设置价格输入框的placeholder
      const priceInput = document.getElementById('trade-price');
      if (priceInput && !priceInput.value) {
        priceInput.placeholder = `参考价: ${formatCurrency(currentPrice)}`;
      }
    } else {
      priceRef.textContent = '-';
      priceSource.textContent = '(无价格数据)';
    }
  }
  
  // 获取当前价格
  function getCurrentPrice(code) {
    if (!appState || !appState.prices) return 0;
    
    const normalizedCode = normalizeStockCode(code);
    
    // 首先尝试直接匹配
    let price = number(appState.prices[normalizedCode]) || 0;
    if (price > 0) return price;
    
    // 如果没有找到，尝试去掉后缀匹配
    const codeWithoutSuffix = stripStockSuffix(normalizedCode);
    for (const [priceCode, priceValue] of Object.entries(appState.prices)) {
      const priceCodeWithoutSuffix = stripStockSuffix(priceCode);
      if (priceCodeWithoutSuffix === codeWithoutSuffix) {
        return number(priceValue) || 0;
      }
    }
    
    return 0;
  }
  
  // 设置交易输入监听
  function setupTradeInputListeners() {
    const priceInput = document.getElementById('trade-price');
    const quantityInput = document.getElementById('trade-quantity');
    
    if (priceInput) {
      priceInput.addEventListener('input', updateTradeAmount);
    }
    
    if (quantityInput) {
      quantityInput.addEventListener('input', updateTradeAmount);
    }
  }
  
  // 更新交易金额
  function updateTradeAmount() {
    const price = number(document.getElementById('trade-price')?.value || 0);
    const quantity = number(document.getElementById('trade-quantity')?.value || 0);
    const amount = price * quantity;
    
    const amountDisplay = document.getElementById('trade-amount-preview');
    if (amountDisplay) {
      amountDisplay.textContent = formatCurrency(amount);
    }
    
    updateTradeValidation();
  }
  
  // 更新交易验证
  function updateTradeValidation() {
    const isSell = document.getElementById('trade-type-sell')?.checked;
    const price = number(document.getElementById('trade-price')?.value || 0);
    const quantity = number(document.getElementById('trade-quantity')?.value || 0);
    const amount = price * quantity;
    const selectedHolding = isSell && selectedStock ? findHoldingByCode(selectedStock.code) : null;
    
    const statusElement = document.getElementById('trade-status');
    const submitButton = document.getElementById('submit-trade-btn');
    
    if (!statusElement || !submitButton) return;
    
    // 重置状态
    statusElement.className = 'trade-status';
    submitButton.disabled = false;
    
    // 基本验证
    if (!selectedStock) {
      statusElement.innerHTML = '<p class="hint">请先选择股票</p>';
      submitButton.disabled = true;
      return;
    }
    
    if (price <= 0 || quantity <= 0) {
      statusElement.innerHTML = '<p class="hint">请输入有效的价格和数量</p>';
      submitButton.disabled = true;
      return;
    }
    
    // 卖出验证
    if (isSell) {
      if (!selectedHolding || selectedHolding.quantity <= 0) {
        statusElement.className = 'trade-status error';
        statusElement.innerHTML = '<p class="hint">该股票当前无可卖出仓位</p>';
        submitButton.disabled = true;
        return;
      }
      
      if (quantity > selectedHolding.quantity + 1e-8) {
        statusElement.className = 'trade-status error';
        statusElement.innerHTML = `<p class="hint">可卖出上限为 ${formatUnits(selectedHolding.quantity, 3)} 股</p>`;
        submitButton.disabled = true;
        return;
      }
    }
    
    // 买入验证
    if (!isSell && currentSummary) {
      if (amount > currentSummary.cash + 1e-8) {
        statusElement.className = 'trade-status error';
        statusElement.innerHTML = `<p class="hint">可用现金不足，当前可用 ${formatCurrency(currentSummary.cash)}</p>`;
        submitButton.disabled = true;
        return;
      }
    }
    
    // 验证通过
    const action = isSell ? '卖出' : '买入';
    const holdingText = isSell ? `，卖出后剩余 ${formatUnits(Math.max(0, (selectedHolding?.quantity || 0) - quantity), 3)} 股` : '';
    statusElement.className = 'trade-status success';
    statusElement.innerHTML = `<p class="hint">${action} ${selectedStock.code} ${formatUnits(quantity, 3)} 股，成交金额 ${formatCurrency(amount)}${holdingText}</p>`;
  }
  
  // 更新交易提交按钮
  function updateTradeSubmitButton() {
    const isSell = document.getElementById('trade-type-sell')?.checked;
    const submitButton = document.getElementById('submit-trade-btn');
    const submitText = document.getElementById('trade-submit-text');
    
    if (submitButton && submitText) {
      if (isSell) {
        submitText.textContent = '提交卖出交易';
        submitButton.className = 'trade-submit-btn sell-mode';
      } else {
        submitText.textContent = '提交买入交易';
        submitButton.className = 'trade-submit-btn';
      }
    }
  }
  
  // 更新搜索框placeholder
  function updateStockSearchPlaceholder() {
    const searchInput = document.getElementById('stock-search');
    const isSell = document.getElementById('trade-type-sell')?.checked;
    
    if (searchInput) {
      searchInput.placeholder = isSell 
        ? '输入股票代码或名称搜索（仅显示持仓股票）...' 
        : '输入股票代码或名称搜索...';
    }
  }
  
  // 设置清空表单按钮
  function setupClearFormButton() {
    const clearButton = document.getElementById('clear-trade-form');
    if (clearButton) {
      clearButton.addEventListener('click', clearTradeForm);
    }
  }
  
  // 清空交易表单
  function clearTradeForm() {
    selectedStock = null;
    
    // 清空搜索框
    const searchInput = document.getElementById('stock-search');
    if (searchInput) searchInput.value = '';
    
    // 清隐藏字段
    const codeInput = document.getElementById('trade-code');
    const nameInput = document.getElementById('trade-name');
    if (codeInput) codeInput.value = '';
    if (nameInput) nameInput.value = '';
    
    // 清空交易输入
    const priceInput = document.getElementById('trade-price');
    const quantityInput = document.getElementById('trade-quantity');
    const noteInput = document.getElementById('trade-note');
    if (priceInput) priceInput.value = '';
    if (quantityInput) quantityInput.value = '';
    if (noteInput) noteInput.value = '';
    
    // 重置持仓信息
    updateHoldingInfo();
    
    // 重置价格参考
    updatePriceReference();
    
    // 重置交易金额
    const amountDisplay = document.getElementById('trade-amount-preview');
    if (amountDisplay) amountDisplay.textContent = '¥0.00';
    
    // 重置状态
    const statusElement = document.getElementById('trade-status');
    if (statusElement) {
      statusElement.className = 'trade-status';
      statusElement.innerHTML = '<p class="hint">输入股票代码和价格查看交易详情</p>';
    }
    
    // 重置提交按钮
    const submitButton = document.getElementById('submit-trade-btn');
    if (submitButton) submitButton.disabled = false;
  }
  
  // 更新现金余额
  function updateCashBalance() {
    const cashDisplay = document.getElementById('available-cash');
    if (cashDisplay && currentSummary) {
      cashDisplay.textContent = formatCurrency(currentSummary.cash);
    }
  }
  
  // 更新资金来源选项
  function updateSourceMemberOptions() {
    const select = document.getElementById('trade-source-member');
    if (!select || !currentSummary) return;
    
    // 清空现有选项（保留第一个）
    while (select.options.length > 1) {
      select.remove(1);
    }
    
    // 添加成员选项
    currentSummary.members.forEach(member => {
      const option = document.createElement('option');
      option.value = member.id;
      option.textContent = member.name;
      select.appendChild(option);
    });
  }
  
  // 隐藏建议
  function hideSuggestions() {
    searchRequestId += 1;
    const suggestions = document.getElementById('stock-suggestions');
    if (suggestions) {
      suggestions.style.display = 'none';
    }
  }
  
  // 工具函数：格式化货币
  function formatCurrency(value) {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: 'CNY',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(number(value));
  }
  
  // 工具函数：格式化数量
  function formatUnits(value, digits = 4) {
    return new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits
    }).format(number(value));
  }
  
  // 获取选中的交易类型
  function getSelectedTradeType() {
    return document.getElementById('trade-type-sell')?.checked ? 'sell' : 'buy';
  }
  
  // 获取交易数据
  function getTradeData() {
    const price = number(document.getElementById('trade-price')?.value || 0);
    const quantity = number(document.getElementById('trade-quantity')?.value || 0);
    const sourceMemberId = document.getElementById('trade-source-member')?.value || 'pool';
    const note = document.getElementById('trade-note')?.value || '';
    
    return {
      type: getSelectedTradeType(),
      code: selectedStock?.code || '',
      name: selectedStock?.name || '',
      price,
      quantity,
      sourceMemberId,
      note
    };
  }
  
  // 验证交易数据
  function validateTradeData(tradeData) {
    if (!tradeData.code) {
      return { valid: false, message: '请选择股票' };
    }
    
    if (tradeData.price <= 0 || tradeData.quantity <= 0) {
      return { valid: false, message: '请输入有效的价格和数量' };
    }
    
    return { valid: true };
  }
  
  // 更新状态
  function updateState(state, summary) {
    appState = state;
    currentSummary = summary;
    remoteSearchVersion += 1;
    if (remoteSearchCache.size > 60) remoteSearchCache.clear();
    
    // 如果已选择股票，更新相关信息
    if (selectedStock) {
      updateHoldingInfo();
      updatePriceReference();
      updateCashBalance();
    }
    
    updateTradeValidation();
  }
  
  // 导出公共API
  global.TradeOptimizer = {
    init: init,
    updateState: updateState,
    getTradeData: getTradeData,
    validateTradeData: validateTradeData,
    clearForm: clearTradeForm
  };
  
})(window);
