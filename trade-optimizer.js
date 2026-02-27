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
  
  // 初始化交易优化器
  function init(state, summary) {
    appState = state;
    currentSummary = summary;
    selectedStock = null;
    
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
  function trySelectStockFromInput() {
    const searchInput = document.getElementById('stock-search');
    if (!searchInput) return;
    
    const query = searchInput.value.trim();
    if (!query) return;
    
    // 查找匹配的股票
    const results = searchStocks(query);
    if (results.length > 0) {
      // 选择第一个匹配的股票
      const stock = results[0];
      selectStock(stock.code, stock.name);
    } else {
      // 没有找到匹配的股票，尝试规范化代码
      const normalizedCode = normalizeCode(query);
      if (normalizedCode !== query) {
        // 代码被规范化了，重新搜索
        const retryResults = searchStocks(normalizedCode);
        if (retryResults.length > 0) {
          const stock = retryResults[0];
          selectStock(stock.code, stock.name);
        } else {
          // 还是没有找到，清空选择
          selectedStock = null;
          updateHoldingInfo();
        }
      } else {
        // 没有匹配，清空选择
        selectedStock = null;
        updateHoldingInfo();
      }
    }
    
    hideSuggestions();
  }
  }
  
  // 显示股票建议
  function showStockSuggestions(query) {
    const suggestions = document.getElementById('stock-suggestions');
    if (!suggestions) return;
    
    const results = searchStocks(query);
    
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
    
    const normalizedQuery = query.toLowerCase();
    const results = [];
    
    // 1. 搜索持仓股票
    currentSummary.holdings.forEach(holding => {
      // 检查代码匹配（支持带后缀和不带后缀）
      const codeWithoutSuffix = holding.code.replace(/\.(SZ|SH|BJ)$/, '');
      const codeMatches = holding.code.toLowerCase().includes(normalizedQuery) || 
                         codeWithoutSuffix.toLowerCase().includes(normalizedQuery);
      
      // 检查名称匹配
      const nameMatches = holding.name.toLowerCase().includes(normalizedQuery);
      
      if (codeMatches || nameMatches) {
        results.push({
          code: holding.code, // 返回完整的规范化代码
          name: holding.name,
          holding: holding,
          priority: 1 // 持仓股票优先级高
        });
      }
    });
    
    // 2. 搜索历史交易股票
    const tradedStocks = new Set();
    currentSummary.tradeRows.forEach(trade => {
      if (!tradedStocks.has(trade.code)) {
        // 检查代码匹配（支持带后缀和不带后缀）
        const codeWithoutSuffix = trade.code.replace(/\.(SZ|SH|BJ)$/, '');
        const codeMatches = trade.code.toLowerCase().includes(normalizedQuery) || 
                           codeWithoutSuffix.toLowerCase().includes(normalizedQuery);
        
        // 检查名称匹配
        const nameMatches = trade.name.toLowerCase().includes(normalizedQuery);
        
        if (codeMatches || nameMatches) {
          results.push({
            code: trade.code, // 返回完整的规范化代码
            name: trade.name,
            holding: currentSummary.holdings.find(h => h.code === trade.code),
            priority: 2
          });
          tradedStocks.add(trade.code);
        }
      }
    });
    
    // 按优先级排序
    return results.sort((a, b) => a.priority - b.priority);
  }
  
  // 选择股票
  function selectStock(code, name) {
    selectedStock = { code, name };
    
    // 更新搜索框
    const searchInput = document.getElementById('stock-search');
    if (searchInput) {
      searchInput.value = `${code} ${name}`;
    }
    
    // 更新隐藏的代码和名称字段（向后兼容）
    const codeInput = document.getElementById('trade-code');
    const nameInput = document.getElementById('trade-name');
    if (codeInput) codeInput.value = code;
    if (nameInput) nameInput.value = name;
    
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
    
    // 查找持仓，支持带后缀和不带后缀的匹配
    const holding = currentSummary.holdings.find(h => {
      // 完全匹配
      if (h.code === selectedStock.code) return true;
      
      // 去掉后缀后匹配
      const hCodeWithoutSuffix = h.code.replace(/\.(SZ|SH|BJ)$/, '');
      const selectedCodeWithoutSuffix = selectedStock.code.replace(/\.(SZ|SH|BJ)$/, '');
      return hCodeWithoutSuffix === selectedCodeWithoutSuffix;
    });
    const isSell = document.getElementById('trade-type-sell')?.checked;
    
    if (holding) {
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
              <div class="holding-metric-value">${formatCurrency(holding.costPrice)}</div>
            </div>
            <div class="holding-metric">
              <div class="holding-metric-label">当前市值</div>
              <div class="holding-metric-value">${formatCurrency(holding.marketValue)}</div>
            </div>
            <div class="holding-metric">
              <div class="holding-metric-label">持仓盈亏</div>
              <div class="holding-metric-value ${holding.pnl >= 0 ? 'positive' : 'negative'}">
                ${formatCurrency(holding.pnl)} (${holding.pnlPercent.toFixed(2)}%)
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
    
    // 首先尝试直接匹配
    let price = number(appState.prices[code]) || 0;
    if (price > 0) return price;
    
    // 如果没有找到，尝试去掉后缀匹配
    const codeWithoutSuffix = code.replace(/\.(SZ|SH|BJ)$/, '');
    for (const [priceCode, priceValue] of Object.entries(appState.prices)) {
      const priceCodeWithoutSuffix = priceCode.replace(/\.(SZ|SH|BJ)$/, '');
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
      const holding = currentSummary?.holdings.find(h => h.code === selectedStock.code);
      if (!holding || holding.quantity <= 0) {
        statusElement.className = 'trade-status error';
        statusElement.innerHTML = '<p class="hint">该股票当前无可卖出仓位</p>';
        submitButton.disabled = true;
        return;
      }
      
      if (quantity > holding.quantity + 1e-8) {
        statusElement.className = 'trade-status error';
        statusElement.innerHTML = `<p class="hint">可卖出上限为 ${formatUnits(holding.quantity, 3)} 股</p>`;
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
    const holdingText = isSell ? `，卖出后剩余 ${formatUnits(Math.max(0, (holding?.quantity || 0) - quantity), 3)} 股` : '';
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