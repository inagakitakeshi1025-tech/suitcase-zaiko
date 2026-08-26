require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const kintone = require("./kintone");

const PORT = process.env.PORT || 8080;
const wwwRoot = path.join(__dirname, "www");
const imageCacheDir = path.join(__dirname, "image-cache");
if (!fs.existsSync(imageCacheDir)) fs.mkdirSync(imageCacheDir, { recursive: true });

const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD;
if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) {
  throw new Error("環境変数 BASIC_AUTH_USER / BASIC_AUTH_PASSWORD が設定されていません。");
}

// ブラウザ標準のBasic認証ダイアログはiPhone(Safari)やLINEなどアプリ内ブラウザで
// 正しく動かないことがあるため、通常のログインフォーム+Cookieセッションに置き換えている。
// 署名鍵は専用のSESSION_SECRETを推奨するが、未設定でも動くようパスワードから導出する。
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update(BASIC_AUTH_PASSWORD).digest("hex");
const SESSION_COOKIE = "zaiko_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30日間はログインし直さなくていいようにする

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signSession(expiresAt) {
  const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${hmac}`;
}

function isValidSessionToken(token) {
  if (!token) return false;
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return false;
  const expiresAtStr = token.slice(0, dotIdx);
  const hmac = token.slice(dotIdx + 1);
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(expiresAtStr).digest("hex");
  return hmac.length === expected.length && timingSafeStringEqual(hmac, expected);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return cookies;
}

function isRequestSecure(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

const app = express();
app.disable("x-powered-by");

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/login", (req, res) => {
  const cookies = parseCookies(req);
  if (isValidSessionToken(cookies[SESSION_COOKIE])) return res.redirect("/");
  res.sendFile(path.join(wwwRoot, "login.html"));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (
    typeof username === "string" &&
    typeof password === "string" &&
    timingSafeStringEqual(username, BASIC_AUTH_USER) &&
    timingSafeStringEqual(password, BASIC_AUTH_PASSWORD)
  ) {
    const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
    const secure = isRequestSecure(req);
    res.cookie(SESSION_COOKIE, signSession(expiresAt), {
      httpOnly: true,
      secure,
      // LINE返信アシスタントの受信一覧からiframeで埋め込んで開くと、ブラウザから見て
      // このアプリは常に第三者コンテキストになる。SameSite=Laxのままだとログイン後の
      // Cookieが保存/送信されず、ログイン画面に戻り続けるループになるためNoneにする
      // (Noneはブラウザ仕様上Secure必須なので、https以外ではLaxにフォールバックする)。
      sameSite: secure ? "none" : "lax",
      maxAge: SESSION_MAX_AGE_MS,
      path: "/",
    });
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});

app.get("/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.redirect("/login");
});

// アプリ全体にかかる簡易パスワード認証(社外にURLを公開する際の最低限のアクセス制限)。
app.use((req, res, next) => {
  const cookies = parseCookies(req);
  if (isValidSessionToken(cookies[SESSION_COOKIE])) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "ログインが必要です" });
  }
  res.redirect("/login");
});

app.get("/api/inventory", async (req, res) => {
  try {
    res.json(await kintone.getInventoryList());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/categories", (req, res) => {
  res.json(Object.values(kintone.CATEGORY_MAP));
});

app.get("/api/search", async (req, res) => {
  try {
    res.json(await kintone.findPartsByKeyword(req.query.keyword || ""));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/stores", (req, res) => {
  res.json(kintone.STORES);
});

app.get("/api/requests", async (req, res) => {
  try {
    res.json(await kintone.getPendingRequests());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/requests/fulfill", async (req, res) => {
  try {
    const result = await kintone.fulfillRequest(req.body);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// パーツ画像はkintoneから毎回取得すると遅いため、初回取得後はディスクにキャッシュして使い回す。
app.get("/api/image", async (req, res) => {
  try {
    const fileKey = req.query.fileKey;
    if (!fileKey) return res.status(400).json({ error: "fileKey is required" });

    const safeKey = String(fileKey).replace(/[^a-zA-Z0-9_-]/g, "_");
    const cachePath = path.join(imageCacheDir, `${safeKey}.bin`);
    const metaPath = path.join(imageCacheDir, `${safeKey}.meta`);

    let buffer, contentType;
    if (fs.existsSync(cachePath)) {
      buffer = fs.readFileSync(cachePath);
      contentType = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, "utf8").trim() : "application/octet-stream";
    } else {
      ({ buffer, contentType } = await kintone.fetchPartsImage(fileKey));
      try {
        fs.writeFileSync(cachePath, buffer);
        fs.writeFileSync(metaPath, contentType);
      } catch {}
    }

    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(404).end();
  }
});

app.post("/api/shukko", async (req, res) => {
  try {
    const result = await kintone.addShukkoFromWeb(req.body);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/nyuko", async (req, res) => {
  try {
    const result = await kintone.addNyukoFromWeb(req.body);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/zaiko-adjust", async (req, res) => {
  try {
    const result = await kintone.addZaikoAdjustment(req.body);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// キャッシュ由来で古いJS/CSSが表示され続けないよう、毎回サーバーに最新かどうか確認させる
// (更新が無ければ304で高速に返る。完全に無効化するわけではないので表示速度への影響は小さい)。
app.use(express.static(wwwRoot, { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
app.get("*", (req, res) => {
  res.sendFile(path.join(wwwRoot, "index.html"));
});

app.listen(PORT, () => {
  console.log(`起動しました: port ${PORT}`);
});
