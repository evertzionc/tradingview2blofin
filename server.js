const express = require("express");
const crypto = require("crypto");
const { randomUUID } = require("crypto");

const app = express();

// Handle TradingView payloads
app.use(express.json());
app.use(express.text());

// ─── CONFIG ─────────────────────────────────────
const CONFIG = {
  BLOFIN_API_KEY: process.env.BLOFIN_API_KEY,
  BLOFIN_API_SECRET: process.env.BLOFIN_API_SECRET,
  BLOFIN_PASSPHRASE: process.env.BLOFIN_PASSPHRASE,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  SYMBOL: process.env.SYMBOL || "BTC-USDT",
  LEVERAGE: parseInt(process.env.LEVERAGE) || 10,
  TRADE_PCT: parseFloat(process.env.TRADE_PCT) || 0.05,
  BASE_URL: "https://openapi.blofin.com",
};

// ─── SYMBOL FORMAT ──────────────────────────────
function formatSymbol(raw) {
  return {
    trade: raw.replace("-", ""),        // BTCUSDT
    market: raw.includes("-")
      ? raw
      : raw.replace(/(USDT|USD)$/, "-$1"),
  };
}

// ─── SIGNATURE ──────────────────────────────────
function sign(path, method, timestamp, nonce, body = "") {
  const prehash = path + method.toUpperCase() + timestamp + nonce + body;

  const hex = crypto
    .createHmac("sha256", CONFIG.BLOFIN_API_SECRET)
    .update(prehash)
    .digest("hex");

  return Buffer.from(hex).toString("base64");
}

// ─── REQUEST ────────────────────────────────────
async function blofinRequest(method, path, queryParams = null, body = null) {
  const timestamp = Date.now().toString();
  const nonce = randomUUID();

  const fullPath = queryParams
    ? `${path}?${new URLSearchParams(queryParams)}`
    : path;

  const bodyStr = body ? JSON.stringify(body) : "";

  const headers = {
    "Content-Type": "application/json",
    "ACCESS-KEY": CONFIG.BLOFIN_API_KEY,
    "ACCESS-SIGN": sign(fullPath, method, timestamp, nonce, bodyStr),
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-NONCE": nonce,
    "ACCESS-PASSPHRASE": CONFIG.BLOFIN_PASSPHRASE,
  };

  const url = `${CONFIG.BASE_URL}${fullPath}`;

  const res = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  const data = await res.json();

  console.log("[BLOFIN]", url, JSON.stringify(data));

  if (data.code !== "0") {
    throw new Error(data.msg);
  }

  return data;
}

// ─── MARKET DATA ────────────────────────────────
async function getUSDTBalance() {
  const data = await blofinRequest("GET", "/api/v1/asset/balances", {
    accountType: "futures",
  });

  const usdt = data.data.find((b) => b.currency === "USDT");
  return parseFloat(usdt?.available || 0);
}

async function getMarkPrice(instId) {
  const data = await blofinRequest(
    "GET",
    "/api/v1/market/mark-price",
    { instId }
  );

  return parseFloat(data.data[0].markPrice);
}

async function getContractSize(instId) {
  const data = await blofinRequest(
    "GET",
    "/api/v1/market/instruments",
    { instId }
  );

  return parseFloat(data.data[0].contractValue);
}

// ─── ORDER ─────────────────────────────────────
async function placeOrder(symbolRaw, side, leverage) {
  const { trade, market } = formatSymbol(symbolRaw);

  console.log("SYMBOL:", { trade, market });

  const [balance, price, contractValue] = await Promise.all([
    getUSDTBalance(),
    getMarkPrice(market),
    getContractSize(market),
  ]);

  console.log("VALUES:", { balance, price, contractValue });

  if (!balance || !price || !contractValue) {
    throw new Error("Invalid market data");
  }

  const notional = balance * CONFIG.TRADE_PCT * leverage;
  const contracts = Math.floor(notional / (price * contractValue));

  if (contracts < 1) {
    throw new Error("Not enough balance");
  }

  console.log(`[ORDER] ${side.toUpperCase()} ${contracts} ${trade}`);

  return blofinRequest("POST", "/api/v1/trade/order", null, {
    instId: trade,
    marginMode: "cross",
    posSide: "net",
    side,
    orderType: "market",
    size: contracts.toString(),
    brokerId: ""
  });
}

// ─── WEBHOOK ───────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    let body = req.body;

    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const { secret, action, symbol, leverage } = body;

    if (secret !== CONFIG.WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const side = action?.toLowerCase();

    if (!["buy", "sell"].includes(side)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const sym = symbol || CONFIG.SYMBOL;
    const lev = parseInt(leverage) || CONFIG.LEVERAGE;

    console.log(`[WEBHOOK] ${side.toUpperCase()} ${sym} @ ${lev}x`);

    const result = await placeOrder(sym, side, lev);

    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("[ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH ────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
