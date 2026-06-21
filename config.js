// ═══════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════

export const CONFIG = {
  // Server
  PORT: parseInt(process.env.PORT) || 8899,

  // Trading Parameters
  SCAN_INTERVAL: 30,          // seconds between each scan cycle
  BUY_AMOUNT: 5,              // USDT per trade (margin)
  LEVERAGE: 5,                // leverage multiplier
  MAX_POSITIONS: 5,           // max concurrent positions
  MAX_DAILY_TRADES: 20,       // daily trade limit

  // Risk Management
  TAKE_PROFIT: 1.10,          // +10% take profit
  STOP_LOSS: 0.92,            // -8% stop loss
  TRAILING_STOP: 0.08,        // 8% drawdown from peak triggers sell

  // Token Filters
  MIN_LIQUIDITY: 5000,        // min 24h quote volume (USDT)
  MAX_TAX: 10,                // max buy/sell tax %
  MIN_CHANGE: 3,              // min 24h price change %
  MAX_CHANGE: 50,             // max 24h price change %
  KLINE_MIN: 30,              // min kline data points required

  // Account
  INITIAL_USDT: 100,          // starting balance

  // API Endpoints
  BINANCE_API: 'https://api.binance.com',
  BINANCE_API1: 'https://api1.binance.com',
  BINANCE_TICKER: 'https://api.binance.com/api/v3/ticker/24hr',
  BINANCE_KLINE: 'https://api1.binance.com/api/v3/klines',
};
