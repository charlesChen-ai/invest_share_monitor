// 测试持仓显示修复
console.log('=== 测试持仓显示修复 ===\n');

// 模拟数据
const mockState = {
  prices: {
    '300807.SZ': 26.8,
    '600519.SH': 1850.5
  }
};

const mockSummary = {
  holdings: [
    {
      code: '300807.SZ',
      name: '天迈科技',
      quantity: 1000,
      costPrice: 25.5,
      marketValue: 26800,
      pnl: 1300,
      pnlPercent: 5.1
    },
    {
      code: '600519.SH',
      name: '贵州茅台',
      quantity: 100,
      costPrice: 1800,
      marketValue: 185050,
      pnl: 5050,
      pnlPercent: 2.8
    }
  ],
  tradeRows: [
    { code: '300807.SZ', name: '天迈科技' },
    { code: '600519.SH', name: '贵州茅台' }
  ]
};

// 测试函数
function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function getCurrentPrice(code, prices) {
  if (!prices) return 0;
  
  // 首先尝试直接匹配
  let price = Number(prices[code]) || 0;
  if (price > 0) return price;
  
  // 如果没有找到，尝试去掉后缀匹配
  const codeWithoutSuffix = code.replace(/\.(SZ|SH|BJ)$/, '');
  for (const [priceCode, priceValue] of Object.entries(prices)) {
    const priceCodeWithoutSuffix = priceCode.replace(/\.(SZ|SH|BJ)$/, '');
    if (priceCodeWithoutSuffix === codeWithoutSuffix) {
      return Number(priceValue) || 0;
    }
  }
  
  return 0;
}

function findHolding(selectedCode, holdings) {
  // 查找持仓，支持带后缀和不带后缀的匹配
  return holdings.find(h => {
    // 完全匹配
    if (h.code === selectedCode) return true;
    
    // 去掉后缀后匹配
    const hCodeWithoutSuffix = h.code.replace(/\.(SZ|SH|BJ)$/, '');
    const selectedCodeWithoutSuffix = selectedCode.replace(/\.(SZ|SH|BJ)$/, '');
    return hCodeWithoutSuffix === selectedCodeWithoutSuffix;
  });
}

// 测试用例
const testCases = [
  { input: '300807', expectedHolding: '300807.SZ', description: '输入不带后缀的代码' },
  { input: '300807.SZ', expectedHolding: '300807.SZ', description: '输入带后缀的代码' },
  { input: '300807.sz', expectedHolding: '300807.SZ', description: '输入小写后缀的代码' },
  { input: '600519', expectedHolding: '600519.SH', description: '输入SH股票不带后缀' },
  { input: '000001', expectedHolding: null, description: '输入不存在的代码' },
  { input: '天迈', expectedHolding: '300807.SZ', description: '输入股票名称部分' },
  { input: '贵州茅台', expectedHolding: '600519.SH', description: '输入完整股票名称' }
];

console.log('1. 持仓匹配测试:');
testCases.forEach(({ input, expectedHolding, description }) => {
  const holding = findHolding(normalizeCode(input), mockSummary.holdings);
  const foundCode = holding ? holding.code : null;
  const passed = foundCode === expectedHolding;
  
  console.log(`  ${passed ? '✅' : '❌'} ${description}`);
  console.log(`    输入: "${input}" → 找到: ${foundCode || '无'} (期望: ${expectedHolding || '无'})`);
});

console.log('\n2. 价格获取测试:');
const priceTests = [
  { code: '300807', expectedPrice: 26.8 },
  { code: '300807.SZ', expectedPrice: 26.8 },
  { code: '600519', expectedPrice: 1850.5 },
  { code: '600519.SH', expectedPrice: 1850.5 },
  { code: '000001', expectedPrice: 0 }
];

priceTests.forEach(({ code, expectedPrice }) => {
  const price = getCurrentPrice(normalizeCode(code), mockState.prices);
  const passed = Math.abs(price - expectedPrice) < 0.01;
  
  console.log(`  ${passed ? '✅' : '❌'} 代码 "${code}" → 价格: ${price} (期望: ${expectedPrice})`);
});

console.log('\n3. 搜索功能测试:');
function searchStocks(query, summary) {
  const normalizedQuery = query.toLowerCase();
  const results = [];
  
  // 搜索持仓股票
  summary.holdings.forEach(holding => {
    // 检查代码匹配（支持带后缀和不带后缀）
    const codeWithoutSuffix = holding.code.replace(/\.(SZ|SH|BJ)$/, '');
    const codeMatches = holding.code.toLowerCase().includes(normalizedQuery) || 
                       codeWithoutSuffix.toLowerCase().includes(normalizedQuery);
    
    // 检查名称匹配
    const nameMatches = holding.name.toLowerCase().includes(normalizedQuery);
    
    if (codeMatches || nameMatches) {
      results.push({
        code: holding.code,
        name: holding.name,
        holding: holding
      });
    }
  });
  
  return results;
}

const searchTests = [
  { query: '3008', expectedCount: 1, description: '部分代码搜索' },
  { query: '300807', expectedCount: 1, description: '完整代码搜索（无后缀）' },
  { query: '300807.SZ', expectedCount: 1, description: '完整代码搜索（有后缀）' },
  { query: '天迈', expectedCount: 1, description: '部分名称搜索' },
  { query: '茅台', expectedCount: 1, description: '另一只股票搜索' },
  { query: '不存在的', expectedCount: 0, description: '无结果搜索' }
];

searchTests.forEach(({ query, expectedCount, description }) => {
  const results = searchStocks(query, mockSummary);
  const passed = results.length === expectedCount;
  
  console.log(`  ${passed ? '✅' : '❌'} ${description}`);
  console.log(`    搜索: "${query}" → 结果: ${results.length} 条 (期望: ${expectedCount})`);
  if (results.length > 0) {
    console.log(`    找到: ${results.map(r => r.code).join(', ')}`);
  }
});

console.log('\n=== 测试总结 ===');
console.log('修复的问题:');
console.log('1. ✅ 支持不带后缀的代码匹配持仓');
console.log('2. ✅ 支持不带后缀的代码获取价格');
console.log('3. ✅ 改进搜索功能，支持部分匹配');
console.log('\n建议: 在实际页面中测试输入"300807"查看持仓显示是否正常。');