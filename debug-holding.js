// 持仓数据调试脚本
console.log('=== 持仓数据调试 ===');

// 模拟一些测试数据
const testState = {
  members: [{ id: 'test', name: '测试用户' }],
  trades: [
    { id: '1', type: 'buy', code: '300807.SZ', name: '天迈科技', price: 25.5, quantity: 1000, sourceMemberId: 'pool', at: new Date().toISOString() },
    { id: '2', type: 'buy', code: '600519.SH', name: '贵州茅台', price: 1800, quantity: 100, sourceMemberId: 'pool', at: new Date().toISOString() }
  ],
  prices: {
    '300807.SZ': 26.8,
    '600519.SH': 1850.5
  },
  logs: []
};

// 模拟computeSummary函数
function computeSummary(state) {
  // 简化的持仓计算
  const holdings = [];
  const tradeMap = new Map();
  
  // 按股票代码分组交易
  state.trades.forEach(trade => {
    if (!tradeMap.has(trade.code)) {
      tradeMap.set(trade.code, {
        code: trade.code,
        name: trade.name,
        quantity: 0,
        costValue: 0,
        trades: []
      });
    }
    
    const stock = tradeMap.get(trade.code);
    if (trade.type === 'buy') {
      stock.quantity += trade.quantity;
      stock.costValue += trade.price * trade.quantity;
    } else if (trade.type === 'sell') {
      stock.quantity -= trade.quantity;
      stock.costValue -= trade.price * trade.quantity;
    }
    stock.trades.push(trade);
  });
  
  // 转换为持仓数组
  tradeMap.forEach((stock, code) => {
    if (stock.quantity > 0) {
      const currentPrice = state.prices[code] || 0;
      const marketValue = currentPrice * stock.quantity;
      const costPrice = stock.costValue / stock.quantity;
      const pnl = marketValue - stock.costValue;
      const pnlPercent = stock.costValue > 0 ? (pnl / stock.costValue) * 100 : 0;
      
      holdings.push({
        code: code,
        name: stock.name,
        quantity: stock.quantity,
        costPrice: costPrice,
        marketValue: marketValue,
        pnl: pnl,
        pnlPercent: pnlPercent,
        currentPrice: currentPrice
      });
    }
  });
  
  return {
    holdings: holdings,
    tradeRows: state.trades,
    members: state.members,
    cash: 50000,
    totalAsset: 50000 + holdings.reduce((sum, h) => sum + h.marketValue, 0)
  };
}

// 测试搜索
const summary = computeSummary(testState);
console.log('持仓数据:', summary.holdings);
console.log('\n搜索测试:');

// 测试不同格式的查询
const testQueries = ['300807', '300807.SZ', '300807.sz', '天迈', '天迈科技'];

testQueries.forEach(query => {
  console.log(`\n查询: "${query}"`);
  const normalizedQuery = query.toLowerCase();
  
  // 搜索持仓
  const holdingResults = summary.holdings.filter(holding => 
    holding.code.toLowerCase().includes(normalizedQuery) || 
    holding.name.toLowerCase().includes(normalizedQuery)
  );
  
  console.log('匹配的持仓:', holdingResults.map(h => h.code));
  
  // 搜索交易
  const tradeResults = summary.tradeRows.filter(trade =>
    trade.code.toLowerCase().includes(normalizedQuery) ||
    trade.name.toLowerCase().includes(normalizedQuery)
  );
  
  console.log('匹配的交易:', [...new Set(tradeResults.map(t => t.code))]);
});

// 测试代码匹配
console.log('\n=== 代码匹配测试 ===');
const userInput = '300807';
const normalizedInput = userInput.toUpperCase();

summary.holdings.forEach(holding => {
  const exactMatch = holding.code === normalizedInput;
  const partialMatch = holding.code.includes(normalizedInput);
  const withoutSuffix = holding.code.replace(/\.(SZ|SH|BJ)$/, '');
  const suffixMatch = withoutSuffix === normalizedInput;
  
  console.log(`持仓: ${holding.code}, 用户输入: ${userInput}`);
  console.log(`  完全匹配: ${exactMatch}`);
  console.log(`  部分匹配: ${partialMatch}`);
  console.log(`  去掉后缀匹配: ${suffixMatch} (${withoutSuffix})`);
});

// 建议的解决方案
console.log('\n=== 问题分析和解决方案 ===');
console.log('问题: 用户输入"300807"，但持仓代码是"300807.SZ"，无法直接匹配');
console.log('\n解决方案:');
console.log('1. 在搜索时去掉代码的后缀进行比较');
console.log('2. 或者要求用户输入完整的代码（包括后缀）');
console.log('3. 或者在显示时自动添加后缀建议');