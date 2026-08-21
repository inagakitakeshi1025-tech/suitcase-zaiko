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

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const app = express();
app.disable("x-powered-by");

// アプリ全体にかかる簡易パスワード認証(社外にURLを公開する際の最低限のアクセス制限)。
app.use((req, res, next) => {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx >= 0) {
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (timingSafeStringEqual(user, BASIC_AUTH_USER) && timingSafeStringEqual(pass, BASIC_AUTH_PASSWORD)) {
        return next();
      }
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Zaiko"');
  res.status(401).send("Authentication required");
});

app.use(express.json());

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

app.use(express.static(wwwRoot));
app.get("*", (req, res) => {
  res.sendFile(path.join(wwwRoot, "index.html"));
});

app.listen(PORT, () => {
  console.log(`起動しました: port ${PORT}`);
});
