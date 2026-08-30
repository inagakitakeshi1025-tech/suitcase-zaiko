#!/usr/bin/env node
// kintoneアプリのレコードを検索して中身を確認するツール(閲覧のみ。書き込みは行わない)。
// フィールドの実際の値・件数などを、人に聞かずに自分で確認できるようにするためのもの。
//
// 使い方:
//   node scripts/kintone-search.js STORE
//   node scripts/kintone-search.js ZAIKO '部品番号 like "P-101"'
//
// クエリ構文はkintoneのAPIのquery引数と同じ(フィールドコードはkintone-fields.jsで確認)。
// 結果は最大10件まで表示する。
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const BASE_URL = (process.env.KINTONE_BASE_URL || "").replace(/\/+$/, "");
const APP_KEYS = ["ZAIKO", "SHUKKO", "NYUKO", "PARTS", "STORE", "IRAI", "IRAI_MINUTE"];

(async () => {
  const key = (process.argv[2] || "").toUpperCase();
  const condition = process.argv[3] || "";
  if (!key || !APP_KEYS.includes(key)) {
    console.log("使い方: node scripts/kintone-search.js <APP_KEY> \"<検索条件(任意)>\"");
    console.log(`APP_KEY: ${APP_KEYS.join(" / ")}`);
    process.exit(1);
  }
  const appId = process.env[`KINTONE_${key}_APP_ID`];
  const token = process.env[`KINTONE_${key}_API_TOKEN`];
  if (!appId || !token) {
    console.log(`環境変数 KINTONE_${key}_APP_ID / _API_TOKEN が未設定です`);
    process.exit(1);
  }
  const query = `${condition ? condition + " " : ""}limit 10`;
  const url = `${BASE_URL}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "X-Cybozu-API-Token": token } });
  if (!res.ok) {
    console.log(`取得エラー: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { records } = await res.json();
  console.log(`${records.length}件取得(最大10件表示、クエリ: ${query})`);
  for (const rec of records) {
    const flat = {};
    for (const [code, f] of Object.entries(rec)) {
      if (["CREATOR", "MODIFIER", "CREATED_TIME", "UPDATED_TIME"].includes(f.type)) continue;
      flat[code] = f.type === "SUBTABLE" ? f.value.map((row) => {
        const r = {};
        for (const [c, v] of Object.entries(row.value)) r[c] = v.value;
        return r;
      }) : f.value;
    }
    console.log(JSON.stringify(flat, null, 2));
  }
})();
