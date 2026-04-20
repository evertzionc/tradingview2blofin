/**
 * TradingView → BloFin Webhook Middleware
 * Deploy on Render.com (free tier works)
 *
 * Verified against: https://docs.blofin.com
 * Flow: TradingView Alert → POST /webhook → This server → BloFin API
 */

const express = require("express");
const crypto = require("crypto");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());
app.use(express.text());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
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

// ─── SIGNATURE ───────────────────────────────────────────────────────────────
// Verified format from docs.blofin.com:
// prehash = path + METHOD + timestamp + nonce + body
// IMPORTANT: hexdigest → string → bytes → base64  (NOT hex2bytes)
function sign(path, method, timestamp, nonce, body = "") {
  const prehash = path + method.toUpperCase() + timestamp + nonce + body;
  const hexdigest = crypto
    .createHmac("sha256", CONFIG.BLOFIN_API_SECRET)
    .update(prehash)
    .digest("hex");
  return Buffer.from(hexdigest).toString("base64");
}

// ─── BLOFIN API REQUEST ───────────────────────────────────────────────────────
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

  const res = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });
  
  // DEBUG START
  const rawText = await res.text();
  console.log("[BLOFIN RAW RESPONSE]", {
    url,
    status: res.status,
    body: rawText,
  });
  // DEBUG END
  
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    console.error("[BLOFIN PARSE ERROR]", e.message);
    return { error: "Invalid JSON from BloFin", raw: rawText };
  }
  
  return parsed;
  }

// ─── GET FUTURES BALANCE ──────────────────────────────────────────────────────
async function getUSDTBalance() {
  const data = await blofinRequest("GET", "/api/v1/asset/balances", {
    accountType: "futures",
  });
  const usdt = data?.data?.find((b) => b.currency === "USDT");
  return parseFloat(usdt?.available || 0);
}

// ─── GET MARK PRICE ───────────────────────────────────────────────────────────
async function getMarkPrice(instId) {
  const data = await blofinRequest("GET", "/api/v1/market/mark-price", { instId });
  return parseFloat(data?.data?.[0]?.markPx || 0);
}

// ─── GET CONTRACT SIZE ────────────────────────────────────────────────────────
async function getContractSize(instId) {
  const data = await blofinRequest("GET", "/api/v1/market/instruments", { instId });
  return parseFloat(data?.data?.[0]?.ctVal || 1);
}

// ─── SET LEVERAGE ─────────────────────────────────────────────────────────────
async function setLeverage(instId, leverage, marginMode = "cross") {
  return blofinRequest("POST", "/api/v1/trade/set-leverage", null, {
    instId,
    leverage: leverage.toString(),
    marginMode,
  });
}

// ─── CLOSE POSITION ───────────────────────────────────────────────────────────
async function closePosition(instId, marginMode = "cross") {
  const posData = await blofinRequest("GET", "/api/v1/trade/positions", { instId });
  const pos = posData?.data?.[0];
  if (!pos || parseFloat(pos.pos) === 0) {
    console.log("[CLOSE] No open position to close");
    return null;
  }
  console.log(`[CLOSE] Closing existing position on ${instId}`);
  return blofinRequest("POST", "/api/v1/trade/close-position", null, {
    instId,
    marginMode,
  });
}

// ─── PLACE ORDER ─────────────────────────────────────────────────────────────
async function placeOrder(instId, side, leverage = CONFIG.LEVERAGE) {
  console.log("DEBUG START ----------------");
  const [balance, markPrice, ctVal] = await Promise.all([
    getUSDTBalance(),
    getMarkPrice(instId),
    getContractSize(instId),
  ]);
  console.log("BALANCE:", balance);
  console.log("MARK PRICE:", markPrice);
  console.log("CTVAL:", ctVal);

  console.log("DEBUG END ----------------");

  if (!balance || !markPrice || !ctVal) {
    throw new Error("Failed to fetch market data from BloFin");
  }

  const notional = balance * CONFIG.TRADE_PCT * leverage;
  const contracts = Math.floor(notional / (markPrice * ctVal));

  if (contracts < 1) {
    throw new Error(
      `Contracts = 0. Need at least ${((markPrice * ctVal) / leverage).toFixed(2)} USDT available`
    );
  }

  await setLeverage(instId, leverage, "cross");

  const order = {
    instId,
    marginMode: "cross",
    posSide: "net",
    side,
    orderType: "market",
    size: contracts.toString(),
  };

  console.log(
    `[ORDER] ${side.toUpperCase()} ${contracts} contracts | ${instId} | ~${markPrice} | ${leverage}x | notional ~${notional.toFixed(2)} USDT`
  );

  return blofinRequest("POST", "/api/v1/trade/order", null, order);
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    let body = req.body;

    // Handle TradingView sending text instead of JSON
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        console.error("Invalid JSON from webhook");
        return res.status(400).send("Bad request");
      }
    }

    const { secret, action, symbol, leverage } = body;

    if (secret !== CONFIG.WEBHOOK_SECRET) {
      console.warn("[WARN] Invalid webhook secret");
      return res.status(401).json({ error: "Unauthorized" });
    }

 // const instId = symbol || CONFIG.SYMBOL;
    const rawSymbol = symbol || CONFIG.SYMBOL;

// Convert TradingView format (BTC-USDT) → BloFin format (BTCUSDT)
    const instId = rawSymbol.replace("-", "");
    const side = action?.toLowerCase();
    const lev = parseInt(leverage) || CONFIG.LEVERAGE;

    if (!["buy", "sell"].includes(side)) {
      return res.status(400).json({ error: `Invalid action: ${action}` });
    }

    console.log(`\n[WEBHOOK] ${side.toUpperCase()} ${instId} @ ${lev}x`);

    await closePosition(instId, "cross");
    const result = await placeOrder(instId, side, lev);

    if (result?.code !== "0") {
      throw new Error(`BloFin error: ${result?.msg || JSON.stringify(result)}`);
    }

    console.log(`[SUCCESS] ${JSON.stringify(result.data)}`);
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "running",
    symbol: CONFIG.SYMBOL,
    defaultLeverage: CONFIG.LEVERAGE,
    tradePct: `${CONFIG.TRADE_PCT * 100}%`,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BloFin Webhook Server on port ${PORT}`);
});
