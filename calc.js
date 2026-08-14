// ========================================
// v2.1 卷数计算器 — 丛书卷数加减计算
// V3.1: 改为居中弹窗 (modal overlay) + 计算过程预览
// ========================================
let calcLocked = false;
let calcHoverTimer = null;

// 计算器状态: 显示值, 当前累计值, 待执行运算符 (null|+|−)
let calcDisplayVal = '0';
let calcAccum = 0;
let calcPendingOp = null;
let calcJustEvaluated = false;
let calcStartNewNumber = false;
let calcExpr = '';          // 计算过程表达式 (如 "12 + 5 − 3 = 14")
let calcLastOp = null;      // 最近一次运算符 (用于过程预览)
let calcStepText = '';      // 过程预览文字

const OP_SYM = { '+': '＋', '-': '－' };

function calcUpdateDisplay() {
  const el = document.getElementById('calcDisplay');
  if (el) el.textContent = calcDisplayVal;
}
function calcUpdateSteps() {
  const el = document.getElementById('calcSteps');
  if (el) el.textContent = calcStepText;
}

// 输入数字
function calcInputDigit(d) {
  if (calcJustEvaluated || calcStartNewNumber) {
    calcDisplayVal = '0'; calcJustEvaluated = false; calcStartNewNumber = false;
  }
  if (calcDisplayVal === '0') calcDisplayVal = d;
  else if (calcDisplayVal.length < 12) calcDisplayVal += d;
  calcUpdateDisplay();
  // 过程预览: 输入数字时更新最后操作数
  if (calcPendingOp) {
    calcStepText = calcAccum + ' ' + (OP_SYM[calcPendingOp] || calcPendingOp) + ' ' + calcDisplayVal;
  } else {
    calcStepText = calcDisplayVal;
  }
  calcUpdateSteps();
}

// 输入运算符 (先求值再记录新运算符)
function calcInputOp(op) {
  if (calcPendingOp) {
    calcApply();
  } else {
    calcAccum = parseInt(calcDisplayVal, 10) || 0;
  }
  calcPendingOp = op;
  calcLastOp = op;
  calcJustEvaluated = false;
  calcStartNewNumber = true;
  calcStepText = calcAccum + ' ' + (OP_SYM[op] || op);
  calcUpdateSteps();
}

// 执行当前待运算
function calcApply() {
  const cur = parseInt(calcDisplayVal, 10) || 0;
  const prev = calcAccum;
  if (calcPendingOp === '+') calcAccum += cur;
  else if (calcPendingOp === '-') calcAccum -= cur;
  else calcAccum = cur;
  calcPendingOp = null;
  calcDisplayVal = String(calcAccum);
  calcUpdateDisplay();
  // 过程预览: 记录完整算式
  calcStepText = prev + ' ' + (OP_SYM[calcLastOp] || calcLastOp || '') + ' ' + cur + ' = ' + calcAccum;
  calcUpdateSteps();
}

function calcEval() {
  if (calcPendingOp) {
    const cur = parseInt(calcDisplayVal, 10) || 0;
    const prev = calcAccum;
    if (calcPendingOp === '+') calcAccum += cur;
    else if (calcPendingOp === '-') calcAccum -= cur;
    calcPendingOp = null;
    calcDisplayVal = String(calcAccum);
    calcUpdateDisplay();
    calcStepText = prev + ' ' + (OP_SYM[calcLastOp] || calcLastOp || '') + ' ' + cur + ' = ' + calcAccum;
    calcUpdateSteps();
  } else {
    calcStepText = calcDisplayVal + ' = ' + calcDisplayVal;
    calcUpdateSteps();
  }
  calcJustEvaluated = true;
}

function calcBackspace() {
  if (calcJustEvaluated || calcStartNewNumber) { calcClear(); return; }
  calcDisplayVal = calcDisplayVal.length > 1 ? calcDisplayVal.slice(0, -1) : '0';
  calcUpdateDisplay();
  if (calcPendingOp) {
    calcStepText = calcAccum + ' ' + (OP_SYM[calcPendingOp] || calcPendingOp) + ' ' + calcDisplayVal;
  } else {
    calcStepText = calcDisplayVal;
  }
  calcUpdateSteps();
}

function calcClear() {
  calcDisplayVal = '0';
  calcAccum = 0;
  calcPendingOp = null;
  calcJustEvaluated = false;
  calcStartNewNumber = false;
  calcLastOp = null;
  calcStepText = '';
  calcUpdateDisplay();
  calcUpdateSteps();
}

function calcHandleKey(key) {
  if (/^\d$/.test(key)) calcInputDigit(key);
  else if (key === '+') calcInputOp('+');
  else if (key === '-') calcInputOp('-');
  else if (key === '=') calcEval();
  else if (key === '←') calcBackspace();
  else if (key === 'C') calcClear();
}

function initCalcPanel() {
  const btn = document.createElement('button');
  btn.id = 'calcBtn';
  btn.className = 'knowledge-btn calc-btn';
  btn.innerHTML = '<span class="kb-icon">卷</span><span class="kb-text">卷數計算</span>';
  btn.setAttribute('aria-label', '打开卷数计算器');
  document.body.appendChild(btn);

  const overlay = document.getElementById('calcOverlay');
  const panel = document.getElementById('calcPanel') || overlay.querySelector('.calc-panel');
  const closeBtn = document.getElementById('calcClose');

  function showPanel() { overlay.classList.add('show'); btn.classList.add('locked'); }
  function hidePanel() { if (calcLocked) return; overlay.classList.remove('show'); btn.classList.remove('locked'); }

  btn.addEventListener('mouseenter', () => { clearTimeout(calcHoverTimer); });
  btn.addEventListener('mouseleave', () => { calcHoverTimer = setTimeout(() => {}, 0); });
  // V3.1: 弹窗模式 — 点击按钮打开弹窗
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    calcLocked = true;
    showPanel();
  });

  // 关闭按钮
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    calcLocked = false;
    hidePanel();
  });
  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      calcLocked = false;
      hidePanel();
    }
  });
  // 键盘按键
  panel.querySelectorAll('.calc-grid button[data-key]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      calcHandleKey(b.dataset.key);
    });
  });
  // 键盘支持: 面板显示时数字与运算符可直接键盘输入
  document.addEventListener('keydown', (e) => {
    if (!overlay.classList.contains('show')) return;
    if (/^\d$/.test(e.key) || e.key === '+' || e.key === '-' || e.key === '=' ||
        e.key === 'Enter' || e.key === 'Backspace' || e.key === 'c' || e.key === 'C' || e.key === 'Escape') {
      if (e.key === 'Escape') { calcLocked = false; hidePanel(); return; }
      e.preventDefault();
      if (e.key === 'Enter') calcHandleKey('=');
      else if (e.key === 'Backspace') calcHandleKey('←');
      else if (e.key === 'c' || e.key === 'C') calcHandleKey('C');
      else calcHandleKey(e.key);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCalcPanel);
} else {
  initCalcPanel();
}
