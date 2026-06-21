// ═══════════════════════════════════════════
//  Technical Analysis Engine
// ═══════════════════════════════════════════

import { CONFIG } from './config.js';

// --- RSI ---
export function calcRSI(closes, period = 14) {
  const rsi = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) { rsi.push(50); continue; }
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    rsi.push(100 - (100 / (1 + rs)));
  }
  return rsi;
}

// --- EMA ---
export function calcEMA(data, period) {
  const ema = [data[0]];
  const k = 2 / (period + 1);
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// --- MACD ---
export function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  const i = closes.length - 1;
  let cross = 'none';
  if (i > 0) {
    if (histogram[i] > 0 && histogram[i - 1] <= 0) cross = 'golden';
    else if (histogram[i] < 0 && histogram[i - 1] >= 0) cross = 'dead';
  }
  let signal = 'neutral';
  if (cross === 'golden') signal = 'buy';
  else if (cross === 'dead') signal = 'sell';
  else if (histogram[i] > 0 && histogram[i] > histogram[i - 1]) signal = 'weak_buy';
  else if (histogram[i] < 0 && histogram[i] < histogram[i - 1]) signal = 'weak_sell';
  return { histogram: histogram[i], cross, signal };
}

// --- Bollinger Bands ---
export function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { position: 0.5, signal: 'neutral' };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const price = closes[closes.length - 1];
  const pos = upper !== lower ? (price - lower) / (upper - lower) : 0.5;
  let signal = 'neutral';
  if (pos < 0.05) signal = 'strong_buy';
  else if (pos < 0.15) signal = 'buy';
  else if (pos > 0.95) signal = 'strong_sell';
  else if (pos > 0.85) signal = 'sell';
  return { position: pos, signal };
}

// --- Volume Analysis ---
export function calcVolume(volumes) {
  if (volumes.length < 21) return { ratio: 1, signal: 'neutral' };
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b) / 20;
  const ratio = avg > 0 ? volumes[volumes.length - 1] / avg : 1;
  let signal = 'neutral';
  if (ratio > 3) signal = 'extreme_volume';
  else if (ratio > 2) signal = 'high_volume';
  else if (ratio > 1.5) signal = 'above_avg';
  else if (ratio < 0.3) signal = 'low_volume';
  return { ratio, signal };
}

// --- Moving Averages ---
export function calcMA(closes) {
  const ma = (arr, p) => arr.length >= p ? arr.slice(-p).reduce((a, b) => a + b) / p : arr[arr.length - 1];
  const m7 = ma(closes, 7), m25 = ma(closes, 25), m50 = ma(closes, 50);
  const price = closes[closes.length - 1];
  let trend = 'neutral';
  if (price > m7 && m7 > m25 && m25 > m50) trend = 'strong_uptrend';
  else if (price > m25 && m25 > m50) trend = 'uptrend';
  else if (price < m7 && m7 < m25 && m25 < m50) trend = 'strong_downtrend';
  else if (price < m25 && m25 < m50) trend = 'downtrend';
  let cross = 'none';
  if (closes.length > 25) {
    const prev = closes.slice(-26, -1);
    const pm7 = prev.slice(-7).reduce((a, b) => a + b) / 7;
    const pm25 = prev.slice(-25).reduce((a, b) => a + b) / 25;
    if (m7 > m25 && pm7 <= pm25) cross = 'golden';
    else if (m7 < m25 && pm7 >= pm25) cross = 'dead';
  }
  return { trend, cross };
}

// --- Candlestick Pattern Detection ---
export function detectPatterns(klines) {
  const p = [];
  if (klines.length < 3) return p;
  const k = klines[klines.length - 1];
  const body = Math.abs(k.close - k.open);
  const range = k.high - k.low;
  if (range === 0) return p;
  const uWick = k.high - Math.max(k.close, k.open);
  const lWick = Math.min(k.close, k.open) - k.low;
  if (lWick > body * 2 && uWick < body * 0.5) p.push('hammer');
  if (uWick > body * 2 && lWick < body * 0.5) p.push('inverted_hammer');
  const pk = klines[klines.length - 2];
  const pBody = Math.abs(pk.close - pk.open);
  if (pk.close < pk.open && k.close > k.open && k.open <= pk.close && k.close >= pk.open && body > pBody) p.push('bullish_engulfing');
  if (pk.close > pk.open && k.close < k.open && k.open >= pk.close && k.close <= pk.open && body > pBody) p.push('bearish_engulfing');
  if (body < range * 0.1) p.push('doji');
  const k1 = klines[klines.length - 3], k2 = klines[klines.length - 2];
  if (k1.close > k1.open && k2.close > k2.open && k.close > k.open) p.push('three_white_soldiers');
  if (k1.close < k1.open && k2.close < k2.open && k.close < k.open) p.push('three_black_crows');
  return p;
}

// ═══════════════════════════════════════════
//  Main Analysis (weighted scoring)
// ═══════════════════════════════════════════
export function analyze(data) {
  const { closes, highs, lows, volumes, klines } = data;
  if (closes.length < CONFIG.KLINE_MIN) {
    return { action: 'hold', confidence: 0, score: 0, reasons: ['数据不足'], indicators: {} };
  }
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bollinger = calcBollinger(closes);
  const volume = calcVolume(volumes);
  const ma = calcMA(closes);
  const patterns = detectPatterns(klines);

  const scoreMap = {
    strong_buy: 1.0, buy: 0.7, weak_buy: 0.4,
    neutral: 0,
    weak_sell: -0.4, sell: -0.7, strong_sell: -1.0,
    extreme_volume: 0.5, high_volume: 0.3, above_avg: 0.1, low_volume: -0.1,
    strong_uptrend: 0.8, uptrend: 0.4, strong_downtrend: -0.8, downtrend: -0.4,
    golden: 0.7, dead: -0.7, golden_ma7_25: 0.6, dead_ma7_25: -0.6,
  };

  const w = { rsi: 20, macd: 20, bollinger: 15, volume: 15, ma: 15, pattern: 15 };
  let totalScore = 0, totalWeight = 0;
  const indicators = {};

  // RSI
  const rsiVal = rsi[rsi.length - 1];
  let rsiSignal = 'neutral';
  if (rsiVal < 30) rsiSignal = 'strong_buy';
  else if (rsiVal < 40) rsiSignal = 'buy';
  else if (rsiVal > 70) rsiSignal = 'strong_sell';
  else if (rsiVal > 60) rsiSignal = 'sell';
  indicators.rsi = { value: rsiVal, signal: rsiSignal };
  totalScore += (scoreMap[rsiSignal] || 0) * w.rsi;
  totalWeight += w.rsi;

  // MACD
  indicators.macd = macd;
  totalScore += (scoreMap[macd.signal] || 0) * w.macd;
  totalWeight += w.macd;

  // Bollinger
  indicators.bollinger = bollinger;
  totalScore += (scoreMap[bollinger.signal] || 0) * w.bollinger;
  totalWeight += w.bollinger;

  // Volume
  indicators.volume = volume;
  totalScore += (scoreMap[volume.signal] || 0) * w.volume;
  totalWeight += w.volume;

  // MA
  indicators.ma = ma;
  let maScore = scoreMap[ma.trend] || 0;
  if (ma.cross === 'golden') maScore += 0.3;
  else if (ma.cross === 'dead') maScore -= 0.3;
  totalScore += Math.max(-1, Math.min(1, maScore)) * w.ma;
  totalWeight += w.ma;

  // Patterns
  indicators.patterns = patterns;
  if (patterns.length > 0) {
    const patMap = { hammer: 0.7, inverted_hammer: -0.7, bullish_engulfing: 0.8, bearish_engulfing: -0.8, doji: 0, three_white_soldiers: 0.75, three_black_crows: -0.75 };
    const patScore = patterns.reduce((s, p) => s + (patMap[p] || 0), 0) / patterns.length;
    totalScore += Math.max(-1, Math.min(1, patScore)) * w.pattern;
    totalWeight += w.pattern;
  }

  const norm = totalWeight > 0 ? totalScore / totalWeight : 0;
  let action = 'hold';
  if (norm > 0.25) action = 'strong_buy';
  else if (norm > 0.1) action = 'buy';
  else if (norm < -0.25) action = 'strong_sell';
  else if (norm < -0.1) action = 'sell';

  const reasons = [];
  if (rsiVal < 35) reasons.push(`RSI超卖(${rsiVal.toFixed(1)})`);
  else if (rsiVal > 65) reasons.push(`RSI偏高(${rsiVal.toFixed(1)})`);
  if (macd.cross === 'golden') reasons.push('MACD金叉');
  else if (macd.cross === 'dead') reasons.push('MACD死叉');
  if (patterns.length) reasons.push(`形态:${patterns.join(',')}`);
  if (ma.trend.includes('uptrend')) reasons.push(`趋势:${ma.trend}`);

  return { action, confidence: Math.abs(norm), score: norm, reasons, indicators };
}

// ═══════════════════════════════════════════
//  Buy / Sell Decision
// ═══════════════════════════════════════════
export function shouldBuy(analysis, token) {
  const ok = analysis.action === 'buy' || analysis.action === 'strong_buy';
  if (!ok) return { buy: false };
  if (analysis.confidence < 0.1) return { buy: false };
  return { buy: true, reason: analysis.reasons.join(';') || 'AI买入' };
}

export function shouldSell(pos, price, analysis) {
  if (price <= 0) return { sell: false };
  const pnl = price / pos.buyPrice;
  if (pnl >= CONFIG.TAKE_PROFIT) return { sell: true, reason: `止盈+${((pnl - 1) * 100).toFixed(1)}%` };
  if (pnl <= CONFIG.STOP_LOSS) return { sell: true, reason: `止损-${((1 - pnl) * 100).toFixed(1)}%` };
  if (pos.highPrice && pos.highPrice > pos.buyPrice) {
    const drop = (pos.highPrice - price) / pos.highPrice;
    if (drop >= CONFIG.TRAILING_STOP && pnl > 1) return { sell: true, reason: `移动止损高点回撤${(drop * 100).toFixed(1)}%` };
  }
  if (analysis && (analysis.action === 'sell' || analysis.action === 'strong_sell') && analysis.confidence > 0.25) {
    return { sell: true, reason: `AI信号: ${(analysis.reasons || []).join(';')}` };
  }
  return { sell: false };
}
