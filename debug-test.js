// 交易优化器调试测试
console.log('=== 交易优化器调试测试开始 ===');

// 1. 检查全局对象
console.log('1. 检查全局对象:');
console.log('window.TradeOptimizer:', typeof window.TradeOptimizer);
console.log('window.LedgerStorage:', typeof window.LedgerStorage);
console.log('window.LedgerCore:', typeof window.LedgerCore);

// 2. 模拟应用状态
const mockState = {
  members: [
    { id: 'member1', name: '测试用户1' },
    { id: 'member2', name: '测试用户2' }
  ],
  trades: [
    { id: 'trade1', type: 'buy', code: '600519.SH', name: '贵州茅台', price: 1800, quantity: 100, sourceMemberId: 'pool', at: new Date().toISOString() },
    { id: 'trade2', type: 'buy', code: '000001.SZ', name: '平安银行', price: 12.5, quantity: 1000, sourceMemberId: 'pool', at: new Date().toISOString() }
  ],
  prices: {
    '600519.SH': 1850.50,
    '000001.SZ': 13.20
  },
  logs: []
};

// 模拟核心计算函数
const mockCore = {
  number: (val) => Number(val) || 0,
  round: (val, digits) => Number(val.toFixed(digits)),
  normalizeCode: (code) => code ? String(code).toUpperCase() : ''
};

// 模拟存储函数
const mockStorage = {
  uid: () => 'test-' + Date.now()
};

// 3. 测试交易优化器初始化
console.log('\n2. 测试交易优化器初始化:');
try {
  // 设置全局对象
  window.LedgerCore = mockCore;
  window.LedgerStorage = mockStorage;
  
  // 模拟computeSummary函数
  window.computeSummary = (state) => {
    return {
      members: state.members,
      holdings: [
        { code: '600519.SH', name: '贵州茅台', quantity: 100, costPrice: 1800, marketValue: 185050, pnl: 5050, pnlPercent: 2.81 },
        { code: '000001.SZ', name: '平安银行', quantity: 1000, costPrice: 12.5, marketValue: 13200, pnl: 700, pnlPercent: 5.6 }
      ],
      tradeRows: state.trades,
      cash: 50000,
      totalAsset: 50000 + 185050 + 13200
    };
  };
  
  // 检查交易优化器是否已定义
  if (typeof window.TradeOptimizer !== 'undefined') {
    console.log('✅ TradeOptimizer 已定义');
    
    // 测试初始化
    const summary = window.computeSummary(mockState);
    try {
      window.TradeOptimizer.init(mockState, summary);
      console.log('✅ TradeOptimizer.init() 调用成功');
    } catch (initError) {
      console.error('❌ TradeOptimizer.init() 失败:', initError.message);
      console.error('错误堆栈:', initError.stack);
    }
    
    // 测试其他方法
    console.log('\n3. 测试其他方法:');
    const methods = ['getTradeData', 'validateTradeData', 'clearForm', 'updateState'];
    methods.forEach(method => {
      if (typeof window.TradeOptimizer[method] === 'function') {
        console.log(`✅ TradeOptimizer.${method}() 存在`);
      } else {
        console.log(`❌ TradeOptimizer.${method}() 不存在`);
      }
    });
    
  } else {
    console.log('❌ TradeOptimizer 未定义，检查trade-optimizer.js是否加载');
    
    // 尝试动态加载
    console.log('尝试动态加载trade-optimizer.js...');
    const script = document.createElement('script');
    script.src = 'trade-optimizer.js';
    script.onload = () => {
      console.log('✅ trade-optimizer.js 加载成功');
      console.log('window.TradeOptimizer:', typeof window.TradeOptimizer);
    };
    script.onerror = () => {
      console.error('❌ trade-optimizer.js 加载失败');
    };
    document.head.appendChild(script);
  }
  
} catch (error) {
  console.error('❌ 测试过程中发生错误:', error.message);
  console.error('错误堆栈:', error.stack);
}

// 4. 检查HTML元素
console.log('\n4. 检查HTML元素:');
const elements = [
  'stock-search',
  'current-holding-info',
  'trade-price',
  'trade-quantity',
  'trade-type-buy',
  'trade-type-sell',
  'submit-trade-btn'
];

elements.forEach(id => {
  const element = document.getElementById(id);
  console.log(`${id}: ${element ? '✅ 存在' : '❌ 缺失'}`);
});

// 5. 检查CSS类
console.log('\n5. 检查CSS类应用:');
const checkClass = (elementId, className) => {
  const element = document.getElementById(elementId);
  if (element && element.classList.contains(className)) {
    console.log(`${elementId} 有类 ${className}: ✅`);
  } else if (element) {
    console.log(`${elementId} 无类 ${className}: ⚠️`);
  }
};

// 检查关键元素
const keyElement = document.querySelector('.trade-panel');
console.log('.trade-panel:', keyElement ? '✅ 存在' : '❌ 缺失');

console.log('\n=== 调试测试完成 ===');

// 提供修复建议
console.log('\n=== 修复建议 ===');
if (!window.TradeOptimizer) {
  console.log('1. 检查trade-optimizer.js是否在app.js之前加载');
  console.log('2. 检查trade-optimizer.js是否有语法错误');
  console.log('3. 确保operation.html中正确引入了trade-optimizer.js');
}

if (!document.querySelector('.trade-panel')) {
  console.log('1. 检查operation.html中的交易面板HTML结构');
  console.log('2. 确保样式文件正确加载');
  console.log('3. 检查是否有JavaScript错误阻止了页面渲染');
}