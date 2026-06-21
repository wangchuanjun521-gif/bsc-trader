#!/usr/bin/env node

// ═══════════════════════════════════════════
//  AI Trading Bot — Server Edition
//  Clean version for VPS / desktop deployment
// ═══════════════════════════════════════════

import http from 'http';
import https from 'https';
import { CONFIG } from './config.js';
import { analyze, shouldBuy, shouldSell } from './analyzer.js';

// ═══════════════════════════════════════════
//  Utility
// ═══════════════════════════════════════════
function log(msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${t}] ${msg}`;
  state.logs.push(line);
  if (state.logs.length > 500) state.logs = state.logs.slice(-300);
  console.log(line);
}

function fmt(n, d = 2) { return n.toFixed(d); }

// ═══════════════════════════════════════════
//  HTTPS Fetcher (native, no curl/proxy)
// ═══════════════════════════════════════════
function httpsGet(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (!data || data.trim() === '') {
          reject(new Error('empty response'));
        } else {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 200))); }
        }
      });
    });
    req.on('error', e => reject(new Error('https error: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
  });
}

// ═══════════════════════════════════════════
//  Token Filter
// ═══════════════════════════════════════════
function parseGainers(raw) {
  const arr = Array.isArray(raw) ? raw : (raw?.data || []);
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.filter(d => {
    if (!d.symbol || !d.symbol.endsWith('USDT')) return false;
    if (['UP', 'DOWN', 'BEAR', 'BULL', 'BULLA', 'BEARA'].some(k => d.symbol.includes(k))) return false;
    const chg = parseFloat(d.priceChangePercent || 0);
    return chg >= CONFIG.MIN_CHANGE && chg <= CONFIG.MAX_CHANGE && parseFloat(d.quoteVolume || 0) >= CONFIG.MIN_LIQUIDITY;
  }).map(d => ({
    symbol: d.symbol,
    price: parseFloat(d.lastPrice),
    changePercent: parseFloat(d.priceChangePercent),
    volume: parseFloat(d.quoteVolume || 0),
    high24h: parseFloat(d.highPrice || 0),
    low24h: parseFloat(d.lowPrice || 0),
    timestamp: Date.now(),
  })).sort((a, b) => b.changePercent - a.changePercent).slice(0, 30);
}

// ═══════════════════════════════════════════
//  Data Fetching
// ═══════════════════════════════════════════
async function fetchTopGainers() {
  // Primary: Binance public API
  try {
    const raw = await httpsGet(CONFIG.BINANCE_TICKER);
    const gainers = parseGainers(raw);
    if (gainers.length > 0) {
      state.gainers = gainers;
      state.lastGainersUpdate = Date.now();
      log(`✅ 涨幅榜更新: ${gainers.length} 个代币 (共${Array.isArray(raw) ? raw.length : '?'}条)`);
      return;
    }
    log(`⚠️ 接口1返回 ${Array.isArray(raw) ? raw.length : '?'} 条, 过滤后0条`);
  } catch (e) { log(`❌ 接口1失败: ${e.message?.slice(0, 100)}`); }

  // Fallback: Binance internal API (may be deprecated)
  try {
    const raw = await httpsGet('https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-market-change?limit=500&rankBy=asc&quoteAsset=USDT');
    const gainers = parseGainers(raw);
    if (gainers.length > 0) {
      state.gainers = gainers;
      state.lastGainersUpdate = Date.now();
      log(`✅ 涨幅榜更新(备用): ${gainers.length} 个代币`);
    } else {
      log(`⚠️ 备用接口过滤后0条`);
    }
  } catch (e) { log(`❌ 备用接口失败: ${e.message?.slice(0, 100)}`); }
}

async function fetchKline(symbol) {
  try {
    const data = await httpsGet(`${CONFIG.BINANCE_KLINE}?symbol=${symbol}&interval=5m&limit=100`);
    if (!Array.isArray(data)) return null;
    return data.map(k => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
  } catch (e) { return null; }
}

async function fetchAllKlines() {
  const syms = [
    ...new Set([
      ...state.gainers.slice(0, 15).map(g => g.symbol),
      ...Object.keys(state.positions),
    ]),
  ];
  if (syms.length === 0) return;
  let ok = 0, fail = 0;
  for (const sym of syms) {
    const k = await fetchKline(sym);
    if (k && k.length >= CONFIG.KLINE_MIN) { state.klineCache[sym] = k; ok++; }
    else fail++;
    await new Promise(r => setTimeout(r, 100)); // rate limit
  }
  state.lastKlineUpdate = Date.now();
  log(`📊 K线更新: 成功${ok} 失败${fail} 共${syms.length}个`);
}

// ═══════════════════════════════════════════
//  State
// ═══════════════════════════════════════════
const state = {
  gainers: [],
  klineCache: {},
  positions: {},
  tradeHistory: [],
  balance: CONFIG.INITIAL_USDT,
  stats: { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, running: true },
  dailyTradeCount: 0,
  startTime: Date.now(),
  logs: [],
  lastGainersUpdate: 0,
  lastKlineUpdate: 0,
};

// ═══════════════════════════════════════════
//  Trading Engine
// ═══════════════════════════════════════════
function doBuy(sym, price, reason) {
  if (state.balance < CONFIG.BUY_AMOUNT) return;
  const tradeAmount = CONFIG.BUY_AMOUNT * CONFIG.LEVERAGE;
  const qty = tradeAmount / price;
  state.positions[sym] = {
    symbol: sym, buyPrice: price, quantity: qty,
    cost: CONFIG.BUY_AMOUNT, buyTime: Date.now(),
    highPrice: price, currentPrice: price,
  };
  state.balance -= CONFIG.BUY_AMOUNT;
  state.dailyTradeCount++;
  state.stats.totalTrades++;
  state.tradeHistory.push({
    type: 'BUY', symbol: sym, price, quantity: qty,
    amount: tradeAmount, reason, time: Date.now(),
  });
  log(`🟢 买入 ${sym} @${price.toFixed(6)} ×${qty.toFixed(2)} | $${tradeAmount}(本金$${CONFIG.BUY_AMOUNT}×${CONFIG.LEVERAGE}倍) | ${reason}`);
}

function doSell(sym, reason) {
  const pos = state.positions[sym];
  if (!pos) return;
  const price = pos.currentPrice;
  const revenue = pos.quantity * price;
  const pnl = revenue - pos.cost;
  state.balance += revenue;
  state.tradeHistory.push({
    type: 'SELL', symbol: sym, price, quantity: pos.quantity,
    amount: revenue, pnl, reason, time: Date.now(),
  });
  state.dailyTradeCount++;
  if (pnl > 0) state.stats.wins++; else state.stats.losses++;
  state.stats.totalPnl += pnl;
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  log(`🔴 卖出 ${sym} @${price.toFixed(6)} | ${pnlStr} | ${reason}`);
  delete state.positions[sym];
}

function autoSell() {
  const posCount = Object.keys(state.positions).length;
  if (posCount === 0) return;
  for (const [sym, pos] of Object.entries(state.positions)) {
    const cached = state.klineCache[sym];
    if (cached?.length) {
      pos.currentPrice = cached[cached.length - 1].close;
      if (pos.currentPrice > (pos.highPrice || 0)) pos.highPrice = pos.currentPrice;
    }
    const gainer = state.gainers.find(g => g.symbol === sym);
    if (gainer) {
      pos.currentPrice = gainer.price;
      if (gainer.price > (pos.highPrice || 0)) pos.highPrice = gainer.price;
    }
    let aiAnalysis = null;
    if (cached?.length >= CONFIG.KLINE_MIN) {
      aiAnalysis = analyze({
        closes: cached.map(k => k.close), highs: cached.map(k => k.high),
        lows: cached.map(k => k.low), volumes: cached.map(k => k.volume), klines: cached,
      });
    }
    const pnl = pos.currentPrice / pos.buyPrice;
    const result = shouldSell(pos, pos.currentPrice, aiAnalysis);
    log(`  📦 ${sym} | 成本${pos.buyPrice.toFixed(6)} 现价${pos.currentPrice.toFixed(6)} PnL:${((pnl - 1) * 100).toFixed(1)}% | AI:${aiAnalysis?.action || '无数据'} | ${result.sell ? '🔴卖出:' + result.reason : '✅持有'}`);
    if (result.sell) doSell(sym, result.reason);
  }
}

function autoBuy() {
  if (Object.keys(state.positions).length >= CONFIG.MAX_POSITIONS) return;
  if (state.dailyTradeCount >= CONFIG.MAX_DAILY_TRADES) return;

  const candidates = state.gainers.slice(0, 15);
  let analyzed = 0, skipped = 0;
  for (const token of candidates) {
    if (state.positions[token.symbol]) continue;
    if (Object.keys(state.positions).length >= CONFIG.MAX_POSITIONS) break;

    const klineData = state.klineCache[token.symbol];
    if (!klineData || klineData.length < CONFIG.KLINE_MIN) { skipped++; continue; }

    const closes = klineData.map(k => k.close);
    const highs = klineData.map(k => k.high);
    const lows = klineData.map(k => k.low);
    const volumes = klineData.map(k => k.volume);

    const aiAnalysis = analyze({ closes, highs, lows, volumes, klines: klineData });
    analyzed++;
    const decision = shouldBuy(aiAnalysis, token);
    log(`  🧠 ${token.symbol} | +${token.changePercent.toFixed(1)}% | 信号:${aiAnalysis.action} 置信:${(aiAnalysis.confidence * 100).toFixed(0)}% 得分:${aiAnalysis.score.toFixed(3)} | ${aiAnalysis.reasons.join(';') || '-'}`);
    if (decision.buy) {
      doBuy(token.symbol, token.price, decision.reason);
    }
  }
  if (analyzed > 0) log(`  📊 分析${analyzed}个 跳过${skipped}个 (数据不足)`);
}

function resetDaily() {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() < 2) {
    log(`📊 日终统计: 交易${state.stats.totalTrades}笔 胜率${state.stats.totalTrades > 0 ? ((state.stats.wins / state.stats.totalTrades) * 100).toFixed(1) : 0}% PnL:${state.stats.totalPnl >= 0 ? '+' : ''}$${state.stats.totalPnl.toFixed(2)}`);
    state.dailyTradeCount = 0;
    state.tradeHistory = [];
    state.stats = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, running: true };
  }
}

// ═══════════════════════════════════════════
//  Main Loop
// ═══════════════════════════════════════════
async function tick() {
  if (!state.stats.running) return;
  try {
    const posCount = Object.keys(state.positions).length;
    log(`━━━ 周期开始 | 持仓:${posCount}/${CONFIG.MAX_POSITIONS} 余额:$${fmt(state.balance)} ━━━`);
    await fetchTopGainers();
    await fetchAllKlines();
    autoSell();
    autoBuy();
    log(`━━━ 周期结束 ━━━`);
  } catch (e) { log(`❌ tick error: ${e.message}`); }
}

// ═══════════════════════════════════════════
//  HTTP Server
// ═══════════════════════════════════════════
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // State cache (500ms)
  let cachedStateJSON = '';
  let cachedStateTime = 0;
  function buildStateJSON() {
    if (Date.now() - cachedStateTime < 500) return cachedStateJSON;
    cachedStateJSON = JSON.stringify({
      positions: state.positions, gainers: state.gainers.slice(0, 20),
      balance: state.balance, stats: state.stats,
      dailyTradeCount: state.dailyTradeCount,
      uptime: Date.now() - state.startTime,
      lastGainersUpdate: state.lastGainersUpdate,
      lastKlineUpdate: state.lastKlineUpdate,
      klineCount: Object.keys(state.klineCache).length,
      positionCount: Object.keys(state.positions).length,
    });
    cachedStateTime = Date.now();
    return cachedStateJSON;
  }

  const sendJSON = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };

  // --- API Routes ---
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(buildStateJSON());
  } else if (url.pathname === '/api/trades') {
    sendJSON({ trades: state.tradeHistory.slice(-100).reverse() });
  } else if (url.pathname === '/api/positions') {
    const positions = {};
    for (const [sym, pos] of Object.entries(state.positions)) {
      const k = state.klineCache[sym];
      let aiAnalysis = null;
      if (k?.length >= CONFIG.KLINE_MIN) {
        aiAnalysis = analyze({
          closes: k.map(c => c.close), highs: k.map(c => c.high),
          lows: k.map(c => c.low), volumes: k.map(c => c.volume), klines: k,
        });
      }
      positions[sym] = { ...pos, aiAnalysis };
    }
    sendJSON({ positions });
  } else if (url.pathname === '/api/analysis') {
    const sym = url.searchParams.get('symbol');
    const k = state.klineCache[sym];
    if (!k || k.length < CONFIG.KLINE_MIN) { sendJSON({ error: '数据不足', dataPoints: k?.length || 0 }); return; }
    const analysis = analyze({
      closes: k.map(c => c.close), highs: k.map(c => c.high),
      lows: k.map(c => c.low), volumes: k.map(c => c.volume), klines: k,
    });
    sendJSON({ symbol: sym, dataPoints: k.length, analysis });
  } else if (url.pathname === '/api/gainers') {
    sendJSON({ gainers: state.gainers });
  } else if (url.pathname === '/api/klines') {
    sendJSON({ klines: state.klineCache });
  } else if (url.pathname === '/api/logs') {
    sendJSON({ logs: state.logs.slice(-80).reverse() });
  } else if (url.pathname === '/api/toggle' && req.method === 'POST') {
    state.stats.running = !state.stats.running;
    log(state.stats.running ? '▶️ 机器人已启动' : '⏸️ 机器人已暂停');
    sendJSON({ running: state.stats.running });
  } else if (url.pathname === '/api/reset' && req.method === 'POST') {
    state.balance = CONFIG.INITIAL_USDT;
    state.positions = {};
    state.tradeHistory = [];
    state.stats = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, running: true };
    state.dailyTradeCount = 0;
    log('🔄 模拟账户已重置');
    sendJSON({ ok: true });
  } else if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
  } else {
    res.writeHead(404); res.end('Not Found');
  }
});

// ═══════════════════════════════════════════
//  Startup
// ═══════════════════════════════════════════
server.listen(CONFIG.PORT, () => {
  log(`🚀 AI 交易系统 v2.0 启动 端口:${CONFIG.PORT}`);
  log(`📡 模式: 服务端自动拉取 Binance 数据`);
  log(`🌐 面板: http://localhost:${CONFIG.PORT}`);
  log(`💰 初始资金: ${CONFIG.INITIAL_USDT} USDT`);

  // Network connectivity test
  log('🔍 测试 Binance API 连通性...');
  httpsGet('https://api.binance.com/api/v3/ping')
    .then(() => log('✅ Binance API 连通!'))
    .catch(e => log(`❌ Binance API 不通: ${e.message}`));

  // Start trading loop
  tick();
  setInterval(tick, CONFIG.SCAN_INTERVAL * 1000);
  setInterval(resetDaily, 60000);
});

// ═══════════════════════════════════════════
//  Dashboard HTML (inline)
// ═══════════════════════════════════════════
const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 交易系统 v2.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#e0e6ed;font:13px/1.5 system-ui,-apple-system,sans-serif}
.header{background:linear-gradient(135deg,#0d1421 0%,#131b2e 100%);padding:16px 20px;border-bottom:1px solid #1a2332;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.header h1{font-size:18px;color:#00d4aa;font-weight:700}
.header h1 span{color:#666;font-size:12px;font-weight:400;margin-left:8px}
.status{display:flex;gap:8px;flex-wrap:wrap}
.badge{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600}
.badge.run{background:#00d4aa22;color:#00d4aa;border:1px solid #00d4aa44}
.badge.off{background:#ff475722;color:#ff4757;border:1px solid #ff475744}
.badge.info{background:#1e90ff22;color:#1e90ff;border:1px solid #1e90ff44}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;padding:14px 20px}
.stat{background:#111927;border:1px solid #1a2332;border-radius:10px;padding:12px}
.stat .label{color:#5a6a80;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.stat .value{font-size:20px;font-weight:700;color:#fff;margin-top:4px}
.stat .value.green{color:#00d4aa}
.stat .value.red{color:#ff4757}
.stat .value.blue{color:#1e90ff}
.section{padding:10px 20px}
.section h2{font-size:14px;color:#5a6a80;margin-bottom:8px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#111927;color:#5a6a80;padding:8px;text-align:left;font-weight:600;position:sticky;top:0}
td{padding:7px 8px;border-bottom:1px solid #1a2332}
tr.positive td{background:#00d4aa08}
.pnl-pos{color:#00d4aa;font-weight:600}
.pnl-neg{color:#ff4757;font-weight:600}
.buy{color:#00d4aa;font-weight:600}
.sell{color:#ff4757;font-weight:600}
.tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600}
.tag.strong_buy{background:#00d4aa33;color:#00d4aa}
.tag.buy{background:#00d4aa22;color:#00d4aa}
.tag.sell{background:#ff475722;color:#ff4757}
.tag.strong_sell{background:#ff475733;color:#ff4757}
.tag.hold{background:#66666622;color:#888}
.token-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
.token{background:#111927;border:1px solid #1a2332;border-radius:8px;padding:10px;cursor:pointer;transition:.2s}
.token:hover{border-color:#00d4aa}
.token .sym{font-weight:700;color:#fff;font-size:13px}
.token .chg{color:#00d4aa;font-weight:600;font-size:15px;margin-top:3px}
.token .vol{color:#5a6a80;font-size:11px}
.empty{color:#5a6a80;text-align:center;padding:30px;font-size:14px}
.controls{padding:10px 20px;display:flex;gap:8px;flex-wrap:wrap}
button{background:#111927;color:#e0e6ed;border:1px solid #2a3a4e;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:.2s}
button:hover{border-color:#00d4aa;color:#00d4aa}
button.danger:hover{border-color:#ff4757;color:#ff4757}
a{color:#1e90ff;text-decoration:none}
a:hover{text-decoration:underline}
</style></head><body>
<div class="header">
  <h1>🤖 AI 交易系统 v2.0 <span>Server Edition</span></h1>
  <div class="status">
    <span class="badge run" id="statusBadge">● 运行中</span>
    <span class="badge info" id="uptimeBadge">⏱ 00:00:00</span>
    <span class="badge info" id="dataBadge">📊 数据: 0</span>
  </div>
</div>
<div class="stats">
  <div class="stat"><div class="label">余额</div><div class="value" id="balance">$100.00</div></div>
  <div class="stat"><div class="label">总资产</div><div class="value blue" id="equity">$100.00</div></div>
  <div class="stat"><div class="label">总盈亏</div><div class="value green" id="totalPnl">+$0.00</div></div>
  <div class="stat"><div class="label">持仓</div><div class="value" id="posCount">0/5</div></div>
  <div class="stat"><div class="label">胜率</div><div class="value blue" id="winRate">0%</div></div>
  <div class="stat"><div class="label">今日交易</div><div class="value" id="dailyTrades">0</div></div>
</div>
<div class="controls">
  <button onclick="toggleBot()" id="toggleBtn">⏸ 暂停</button>
  <button onclick="resetBot()" class="danger">🔄 重置</button>
  <span style="flex:1"></span>
  <span style="color:#5a6a80;font-size:11px" id="updateTime">上次更新: --</span>
</div>
<div class="section"><h2>📦 持仓</h2><table>
  <thead><tr><th>币种</th><th>买入价</th><th>现价</th><th>持仓量</th><th>成本</th><th>市值</th><th>盈亏</th><th>AI</th></tr></thead>
  <tbody id="posTable"></tbody>
</table><div class="empty" id="posEmpty" style="display:none">暂无持仓，等待 AI 发现买入信号...</div></div>
<div class="section"><h2>📜 交易记录</h2><table>
  <thead><tr><th>时间</th><th>操作</th><th>币种</th><th>价格</th><th>数量</th><th>金额</th><th>盈亏</th><th>原因</th></tr></thead>
  <tbody id="tradeTable"></tbody>
</table><div class="empty" id="tradeEmpty" style="display:none">暂无交易记录</div></div>
<div class="section"><h2>🔥 涨幅榜 (服务器自动拉取)</h2>
  <div class="token-grid" id="gainersGrid"></div>
  <div class="empty" id="gainersEmpty" style="display:none">正在拉取数据...</div>
</div>
<script>
let isRunning=true;
function fmt(n,d=2){return n.toFixed(d)}
function pnlClass(v){return v>=0?'pnl-pos':'pnl-neg'}
function pnlStr(v){return v>=0?'+$'+fmt(v):'-$'+fmt(Math.abs(v))}
function tsStr(t){if(!t)return'--';const d=new Date(t);return d.toLocaleTimeString('zh-CN',{hour12:false})}
function render(){
  fetch('/api/state').then(r=>r.json()).then(s=>{
    document.getElementById('balance').textContent='$'+fmt(s.balance);
    let posVal=0;for(const p of Object.values(s.positions))posVal+=p.currentPrice*p.quantity;
    const eq=s.balance+posVal;
    document.getElementById('equity').textContent='$'+fmt(eq);
    const tp=s.stats.totalPnl;
    const tpe=document.getElementById('totalPnl');
    tpe.textContent=(tp>=0?'+':'')+pnlStr(tp);
    tpe.className='value '+(tp>=0?'green':'red');
    document.getElementById('posCount').textContent=s.positionCount+'/'+5;
    const wr=s.stats.totalTrades>0?((s.stats.wins/s.stats.totalTrades)*100).toFixed(0):'0';
    document.getElementById('winRate').textContent=wr+'%';
    document.getElementById('dailyTrades').textContent=s.dailyTradeCount;
    isRunning=s.stats.running;
    document.getElementById('statusBadge').className='badge '+(s.stats.running?'run':'off');
    document.getElementById('statusBadge').textContent=s.stats.running?'● 运行中':'● 已暂停';
    document.getElementById('toggleBtn').textContent=s.stats.running?'⏸ 暂停':'▶️ 启动';
    const ut=Math.floor(s.uptime/1000);
    const h=Math.floor(ut/3600),m=Math.floor((ut%3600)/60),sec=ut%60;
    document.getElementById('uptimeBadge').textContent='⏱ '+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
    document.getElementById('dataBadge').textContent='📊 数据: '+s.klineCount;
    document.getElementById('updateTime').textContent='上次更新: '+new Date().toLocaleTimeString('zh-CN',{hour12:false});
    // Positions
    const posT=document.getElementById('posTable');
    const posE=document.getElementById('posEmpty');
    const pos=Object.values(s.positions);
    if(pos.length===0){posT.innerHTML='';posE.style.display='';}
    else{posE.style.display='none';posT.innerHTML=pos.map(p=>{
      const pnl=p.currentPrice/p.buyPrice-1;
      const mkt=p.currentPrice*p.quantity;
      const aiTag=p.aiAnalysis?'<span class="tag '+p.aiAnalysis.action+'">'+p.aiAnalysis.action+'</span>':'<span class="tag hold">无数据</span>';
      return '<tr class="'+(pnl>=0?'positive':'')+'"><td><b>'+p.symbol.replace('USDT','')+'</b></td><td>'+p.buyPrice.toFixed(6)+'</td><td>'+p.currentPrice.toFixed(6)+'</td><td>'+p.quantity.toFixed(2)+'</td><td>$'+fmt(p.cost)+'</td><td>$'+fmt(mkt)+'</td><td class="'+pnlClass(pnl)+'">'+(pnl>=0?'+':'')+pnl.toFixed(2)+'%</td><td>'+aiTag+'</td></tr>';
    }).join('');}
    // Trades
    const trT=document.getElementById('tradeTable');
    const trE=document.getElementById('tradeEmpty');
    if(s.trades&&s.trades.length>0){trE.style.display='none';trT.innerHTML=s.trades.map(t=>{
      const cls=t.type==='BUY'?'buy':'sell';
      return '<tr><td>'+tsStr(t.time)+'</td><td class="'+cls+'">'+t.type+'</td><td><b>'+t.symbol.replace('USDT','')+'</b></td><td>'+t.price.toFixed(6)+'</td><td>'+t.quantity.toFixed(2)+'</td><td>$'+fmt(t.amount)+'</td><td class="'+(t.pnl>=0?'pnl-pos':'pnl-neg')+'">'+(t.pnl!=null?(t.pnl>=0?'+':'')+pnlStr(t.pnl):'--')+'</td><td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+t.reason+'</td></tr>';
    }).join('');}else{trT.innerHTML='';trE.style.display='';}
    // Gainers
    const gG=document.getElementById('gainersGrid');
    const gE=document.getElementById('gainersEmpty');
    if(s.gainers&&s.gainers.length>0){gE.style.display='none';gG.innerHTML=s.gainers.map(g=>'<div class="token"><div class="sym">'+g.symbol.replace('USDT','')+'</div><div class="chg">+'+g.changePercent.toFixed(1)+'%</div><div class="vol">$'+(g.volume/1000).toFixed(0)+'K</div></div>').join('');}else{gG.innerHTML='';gE.style.display='';}
  }).catch(e=>console.error('render error:',e));
}
function toggleBot(){
  fetch('/api/toggle',{method:'POST'}).then(r=>r.json()).then(s=>{
    isRunning=s.running;
    render();
  });
}
function resetBot(){
  if(!confirm('确定要重置模拟账户？所有持仓和交易记录将清空。'))return;
  fetch('/api/reset',{method:'POST'}).then(()=>render());
}
render();
setInterval(render,3000);
</script></body></html>`;
