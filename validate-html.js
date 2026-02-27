// HTML结构验证脚本
const fs = require('fs');
const path = require('path');

console.log('=== HTML结构验证 ===\n');

// 读取operation.html
const htmlPath = path.join(__dirname, 'operation.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

// 检查关键元素
const requiredElements = [
  { id: 'stock-search', desc: '股票搜索框' },
  { id: 'current-holding-info', desc: '持仓信息显示' },
  { id: 'trade-price', desc: '价格输入框' },
  { id: 'trade-quantity', desc: '数量输入框' },
  { id: 'trade-type-buy', desc: '买入单选按钮' },
  { id: 'trade-type-sell', desc: '卖出单选按钮' },
  { id: 'submit-trade-btn', desc: '提交按钮' },
  { id: 'trade-form', desc: '交易表单' }
];

console.log('1. 检查HTML元素:');
let allElementsFound = true;
requiredElements.forEach(({ id, desc }) => {
  const regex = new RegExp(`id=["']${id}["']`);
  const found = regex.test(htmlContent);
  console.log(`  ${found ? '✅' : '❌'} ${desc} (id="${id}")`);
  if (!found) allElementsFound = false;
});

// 检查CSS类
const requiredClasses = [
  'trade-panel',
  'stock-search-wrapper',
  'current-holding-info',
  'trade-details-grid',
  'trade-type-selector'
];

console.log('\n2. 检查CSS类:');
requiredClasses.forEach(className => {
  const regex = new RegExp(`class=["'][^"']*${className}[^"']*["']`);
  const found = regex.test(htmlContent);
  console.log(`  ${found ? '✅' : '❌'} .${className}`);
});

// 检查脚本引入
console.log('\n3. 检查脚本引入顺序:');
const scripts = [
  'storage.js',
  'ledger-core.js',
  'trade-optimizer.js',
  'app.js'
];

let lastIndex = -1;
let orderCorrect = true;
scripts.forEach(script => {
  const index = htmlContent.indexOf(`src="./${script}"`);
  console.log(`  ${index > lastIndex ? '✅' : '❌'} ${script} (位置: ${index})`);
  if (index <= lastIndex && lastIndex !== -1) {
    orderCorrect = false;
  }
  lastIndex = index;
});

// 检查样式文件
console.log('\n4. 检查样式文件:');
const hasStyles = htmlContent.includes('href="./styles.css"');
console.log(`  ${hasStyles ? '✅' : '❌'} styles.css 已引入`);

// 总结
console.log('\n=== 验证结果 ===');
if (allElementsFound && orderCorrect && hasStyles) {
  console.log('✅ HTML结构验证通过！');
  console.log('\n下一步：在浏览器中打开 operation.html 进行功能测试。');
  console.log('测试要点：');
  console.log('  1. 页面是否能正常加载');
  console.log('  2. 交易面板是否显示正常');
  console.log('  3. 股票搜索功能是否工作');
  console.log('  4. 买入/卖出切换是否正常');
  console.log('  5. 价格和数量输入是否验证');
} else {
  console.log('❌ HTML结构存在问题，需要修复：');
  if (!allElementsFound) console.log('  - 缺少必要的HTML元素');
  if (!orderCorrect) console.log('  - 脚本引入顺序不正确');
  if (!hasStyles) console.log('  - 样式文件未引入');
}

// 额外检查：trade-optimizer.js是否在app.js之前
const tradeOptimizerIndex = htmlContent.indexOf('trade-optimizer.js');
const appJsIndex = htmlContent.indexOf('app.js');
if (tradeOptimizerIndex > appJsIndex && tradeOptimizerIndex !== -1 && appJsIndex !== -1) {
  console.log('\n⚠️  警告：trade-optimizer.js 应该在 app.js 之前引入！');
}