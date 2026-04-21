const express = require("express");
const crypto = require("crypto");
const { randomUUID } = require("crypto");

const app = express();

// ✅ Handle BOTH JSON + text (TradingView sends text/plain sometimes)
app.use(express.json());
app.use(express.text());

// ─── CONFIG ─────────────────────────────────────────────────────
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

// ─── SYMBOL HELPERS ─────────────────────────────────────────────
// TradingView: BTC-USDT
// BloFin trade: BTCUSDT
// BloFin market: BTC-USDT
function formatSymbol(raw) {
  return {
    trade: raw.replace("-", ""), // MERLUSDT
    market: raw.includes("-") ? raw : raw.replace(/(USDT|USD)$/, "-$1"),
  };
}

// ─── SIGNATURE ─────────────────────────────────────────────────
function sign(path, method, timestamp, nonce, body = "") {
  const prehash = path + method.toUpperCase() + timestamp + nonce + body;
  const hexdigest = crypto
    .createHmac("sha256", CONFIG.BLOFIN_API_SECRET)
    .update(prehash)
    .digest("hex");

  return Buffer.from(hexdigest).toString("base64");
}

// ─── BLOFIN REQUEST ─────────────────────────────────────────────
async function blofinRequest(method, path, queryParams = null, body = null) {
  const timestamp = Date.now().toString();
  const nonce = randomUUID();

  const fullPath = queryParams
    ? `${path}?${new URLSearchParams(queryParams).toString()}`
    : path;

  const bodyStr = body ? JSON.stringify(body) : "";
  const signature = sign(fullPath, method, timestamp, nonce, bodyStr);

  const headers = {
    "Content-Type": "application/json",
    "ACCESS-KEY": CONFIG.BLOFIN_API_KEY,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-NONCE": nonce,
    "ACCESS-PASSPHRASE": CONFIG.BLOFIN_PASSPHRASE,
  };

  const url = `${CONFIG.BASE_URL}${fullPath}`;

  const res = await fetch(url, { method, headers, body: bodyStr || undefined });
  const data = await res.json();

  // 🔥 ALWAYS LOG RESPONSE
  console.log("[BLOFIN RAW RESPONSE]", {
    url,
    status: res.status,
    body: JSON.stringify(data),
  });

  // ❌ FAIL FAST ON API ERROR
  if (data.code !== "0") {
    throw new Error(`BloFin API Error: ${data.msg}`);
  }

  return data;
}

// ─── MARKET DATA ────────────────────────────────────────────────
async function getUSDTBalance() {
  const data = await blofinRequest("GET", "/api/v1/asset/balances", {
    accountType: "futures",
  });

  const usdt = data?.data?.find((b) => b.currency === "USDT");
  return parseFloat(usdt?.available || 0);
}

async function getMarkPrice(instIdMarket) {
  const data = await blofinRequest(
    "GET",
    "/api/v1/market/mark-price",
    { instId: instIdMarket }
  );

  return parseFloat(data?.data?.[0]?.markPx || 0);
}

async function getContractSize(instIdMarket) {
  const data = await blofinRequest(
    "GET",
    "/api/v1/market/instruments",
    { instId: instIdMarket }
  );

  return parseFloat(data?.data?.[0]?.ctVal || 1);
}

// ─── TRADING ───────────────────────────────────────────────────
async function setLeverage(instIdTrade, leverage) {
  return blofinRequest("POST", "/api/v1/trade/set-leverage", null, {
    instId: instIdTrade,
    leverage: leverage.toString(),
    marginMode: "cross",
  });
}

async function closePosition(instIdTrade) {
  try {
    const posData = await blofinRequest(
      "GET",
      "/api/v1/trade/positions",
      { instId: instIdTrade }
    );

    const pos = posData?.data?.[0];
    if (!pos || parseFloat(pos.pos) === 0) {
      console.log("[CLOSE] No open position");
      return;
    }

    console.log(`[CLOSE] Closing position ${instIdTrade}`);

    return blofinRequest("POST", "/api/v1/trade/close-position", null, {
      instId: instIdTrade,
      marginMode: "cross",
    });
  } catch (err) {
    console.warn("[CLOSE ERROR]", err.message);
  }
}

async function placeOrder(symbolRaw, side, leverage) {
  const { trade, market } = formatSymbol(symbolRaw);

  console.log("DEBUG SYMBOL:", { raw: symbolRaw, trade, market });

  const [balance, markPrice, ctVal] = await Promise.all([
    getUSDTBalance(),
    getMarkPrice(market),
    getContractSize(market),
  ]);

  console.log("DEBUG VALUES:", { balance, markPrice, ctVal });

  if (!balance || !markPrice || !ctVal) {
    throw new Error(
      `Market data failed | balance=${balance} price=${markPrice} ctVal=${ctVal}`
    );
  }

  const notional = balance * CONFIG.TRADE_PCT * leverage;
  const contracts = Math.floor(notional / (markPrice * ctVal));

  if (contracts < 1) {
    throw new Error("Not enough balance to open position");
  }

  await setLeverage(trade, leverage);

  console.log(`[ORDER] ${side.toUpperCase()} ${contracts} ${trade}`);

  return blofinRequest("POST", "/api/v1/trade/order", null, {
    instId: trade,
    marginMode: "cross",
    posSide: "net",
    side,
    orderType: "market",
    size: contracts.toString(),
  });
}

// ─── WEBHOOK ───────────────────────────────────────────────────
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

    await closePosition(formatSymbol(sym).trade);
    const result = await placeOrder(sym, side, lev);

    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("[ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
