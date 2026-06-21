# 🤖 AI Trading Bot — BSC/USDT Server Edition

基于技术分析的加密货币自动交易机器人，内置 Web 仪表盘。

## 功能

- **AI 技术分析引擎**：RSI、MACD、布林带、均线系统、K线形态识别，加权评分决策
- **自动交易**：扫描涨幅榜 → AI 分析 → 自动买入/卖出
- **风控系统**：止盈、止损、移动止损、AI 信号卖出
- **Web 仪表盘**：实时监控持仓、交易记录、涨幅榜、系统日志
- **模拟交易**：默认使用模拟资金，安全测试策略

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/wangchuanjun521-gif/bsc-trader.git
cd bsc-trader

# 安装依赖
npm install

# 启动
npm start
```

打开浏览器访问 `http://localhost:8899`

## 配置

编辑 `config.js` 调整参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8899 | Web 面板端口 |
| `SCAN_INTERVAL` | 30 | 扫描周期（秒） |
| `BUY_AMOUNT` | 5 | 每笔交易保证金（USDT） |
| `LEVERAGE` | 5 | 杠杆倍数 |
| `MAX_POSITIONS` | 5 | 最大持仓数 |
| `TAKE_PROFIT` | 1.10 | 止盈线 (+10%) |
| `STOP_LOSS` | 0.92 | 止损线 (-8%) |
| `TRAILING_STOP` | 0.08 | 移动止损回撤幅度 |
| `INITIAL_USDT` | 100 | 初始模拟资金 |

## API

| 端点 | 说明 |
|------|------|
| `GET /api/state` | 完整状态（余额、持仓、统计） |
| `GET /api/positions` | 持仓详情（含 AI 分析） |
| `GET /api/trades` | 最近 100 条交易记录 |
| `GET /api/analysis?symbol=XXXUSDT` | 单币种 AI 分析 |
| `GET /api/gainers` | 涨幅榜 |
| `GET /api/logs` | 系统日志 |
| `POST /api/toggle` | 启动/暂停 |
| `POST /api/reset` | 重置账户 |

## 技术栈

- Node.js 18+（纯原生，无框架依赖）
- Binance Public API（无需 API Key）
- 内嵌 HTML/CSS/JS 仪表盘

## ⚠️ 免责声明

本项目仅供学习和研究用途。加密货币交易存在高风险，请自行评估。模拟交易结果不代表实际收益。

## License

MIT
