// JavaScript文件验证脚本
const fs = require('fs');
const path = require('path');

console.log('=== JavaScript文件验证 ===\n');

// 检查文件是否存在
const files = [
  'storage.js',
  'ledger-core.js',
  'trade-optimizer.js',
  'app.js'
];

console.log('1. 文件存在性检查:');
files.forEach(file => {
  const filePath = path.join(__dirname, file);
  const exists = fs.existsSync(filePath);
  console.log(`  ${exists ? '✅' : '❌'} ${file}`);
});

// 检查语法
console.log('\n2. 语法检查:');
files.forEach(file => {
  const filePath = path.join(__dirname, file);
  try {
    // 简单读取检查
    const content = fs.readFileSync(filePath, 'utf8');
    // 检查是否有明显的语法错误模式
    const hasUnclosedBrace = (content.match(/{/g) || []).length !== (content.match(/}/g) || []).length;
    const hasUnclosedParen = (content.match(/\(/g) || []).length !== (content.match(/\)/g) || []).length;
    const hasUnclosedBracket = (content.match(/\[/g) || []).length !== (content.match(/\]/g) || []).length;
    
    if (!hasUnclosedBrace && !hasUnclosedParen && !hasUnclosedBracket) {
      console.log(`  ✅ ${file} 基本语法检查通过`);
    } else {
      console.log(`  ⚠️  ${file} 可能有未闭合的符号`);
    }
  } catch (error) {
    console.log(`  ❌ ${file} 读取失败: ${error.message}`);
  }
});

// 检查trade-optimizer.js的导出
console.log('\n3. trade-optimizer.js 导出检查:');
const optimizerPath = path.join(__dirname, 'trade-optimizer.js');
const optimizerContent = fs.readFileSync(optimizerPath, 'utf8');

const exportsToCheck = [
  'init',
  'updateState',
  'getTradeData',
  'validateTradeData',
  'clearForm'
];

exportsToCheck.forEach(exportName => {
  let found = false;
  if (exportName === 'clearForm') {
    // clearForm 导出的是 clearTradeForm 函数
    const regex = new RegExp(`clearForm:\\s*clearTradeForm`);
    found = regex.test(optimizerContent);
  } else {
    const regex = new RegExp(`${exportName}:\\s*${exportName}`);
    found = regex.test(optimizerContent);
  }
  console.log(`  ${found ? '✅' : '❌'} 导出 ${exportName}`);
});

// 检查app.js中的集成
console.log('\n4. app.js 集成检查:');
const appPath = path.join(__dirname, 'app.js');
const appContent = fs.readFileSync(appPath, 'utf8');

const integrationChecks = [
  { pattern: 'window\\.TradeOptimizer', desc: '引用TradeOptimizer' },
  { pattern: 'TradeOptimizer\\.init', desc: '调用init方法' },
  { pattern: 'TradeOptimizer\\.updateState', desc: '调用updateState方法' },
  { pattern: 'TradeOptimizer\\.getTradeData', desc: '调用getTradeData方法' },
  { pattern: 'TradeOptimizer\\.validateTradeData', desc: '调用validateTradeData方法' },
  { pattern: 'TradeOptimizer\\.clearForm', desc: '调用clearForm方法' }
];

integrationChecks.forEach(({ pattern, desc }) => {
  const regex = new RegExp(pattern);
  const found = regex.test(appContent);
  console.log(`  ${found ? '✅' : '❌'} ${desc}`);
});

// 检查全局变量定义
console.log('\n5. 全局变量定义检查:');
const globalVars = [
  'LedgerStorage',
  'LedgerCore',
  'TradeOptimizer'
];

// 检查storage.js
const storageContent = fs.readFileSync(path.join(__dirname, 'storage.js'), 'utf8');
const definesLedgerStorage = /global\\.LedgerStorage\s*=/.test(storageContent);
console.log(`  ${definesLedgerStorage ? '✅' : '❌'} storage.js 定义 LedgerStorage`);

// 检查ledger-core.js
const coreContent = fs.readFileSync(path.join(__dirname, 'ledger-core.js'), 'utf8');
const definesLedgerCore = /global\\.LedgerCore\s*=/.test(coreContent);
console.log(`  ${definesLedgerCore ? '✅' : '❌'} ledger-core.js 定义 LedgerCore`);

// 检查trade-optimizer.js
const definesTradeOptimizer = /global\\.TradeOptimizer\s*=/.test(optimizerContent);
console.log(`  ${definesTradeOptimizer ? '✅' : '❌'} trade-optimizer.js 定义 TradeOptimizer`);

console.log('\n=== 验证完成 ===');
console.log('\n建议：在浏览器中打开页面，按F12查看控制台是否有错误。');
console.log('如果没有红色错误信息，通常表示JavaScript运行正常。');