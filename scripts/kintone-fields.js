#!/usr/bin/env node
// kintoneアプリのフィールド構成(フィールドコード・型・ラベル)を、kintone本体に直接問い合わせて
// 確認するツール。キントーンの専門知識が無くても、フィールド名の綴りや型を人に聞かずに確認できる。
//
// 使い方:
//   node scripts/kintone-fields.js            → .envにある対象アプリを全て一覧表示
//   node scripts/kintone-fields.js ZAIKO      → 指定したアプリ(ZAIKO/SHUKKO/NYUKO/PARTS/STORE/IRAI/IRAI_MINUTE)のみ表示
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const APP_KEYS = ["ZAIKO", "SHUKKO", "NYUKO", "PARTS", "STORE", "IRAI", "IRAI_MINUTE"];
const BASE_URL = (process.env.KINTONE_BASE_URL || "").replace(/\/+$/, "");

const TYPE_LABEL = {
  SINGLE_LINE_TEXT: "文字列(1行)",
  MULTI_LINE_TEXT: "文字列(複数行)",
  NUMBER: "数値",
  DROP_DOWN: "ドロップダウン",
  RADIO_BUTTON: "ラジオボタン",
  CHECK_BOX: "チェックボックス",
  MULTI_SELECT: "複数選択",
  DATE: "日付",
  TIME: "時刻",
  DATETIME: "日時",
  LINK: "リンク",
  FILE: "添付ファイル",
  SUBTABLE: "テーブル(サブテーブル)",
  RECORD_NUMBER: "レコード番号",
  CREATOR: "作成者",
  MODIFIER: "更新者",
  CREATED_TIME: "作成日時",
  UPDATED_TIME: "更新日時",
  STATUS: "ステータス",
  STATUS_ASSIGNEE: "作業者",
  CATEGORY: "カテゴリー",
  LOOKUP: "ルックアップ",
  USER_SELECT: "ユーザー選択",
  GROUP_SELECT: "グループ選択",
  ORGANIZATION_SELECT: "組織選択",
  GROUP: "グループフィールド(見た目の区切り)",
  REFERENCE_TABLE: "関連レコード一覧",
  CALC: "計算",
};

function typeLabel(t) {
  return TYPE_LABEL[t] || t;
}

async function fetchFields(appId, token) {
  const res = await fetch(`${BASE_URL}/k/v1/app/form/fields.json?app=${appId}`, {
    headers: { "X-Cybozu-API-Token": token },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { properties } = await res.json();
  return properties;
}

function printFields(properties, indent = "  ") {
  for (const [code, def] of Object.entries(properties)) {
    if (def.type === "SUBTABLE") {
      console.log(`${indent}${code} [テーブル]`);
      printFields(def.fields, indent + "  ");
    } else if (!["RECORD_NUMBER", "CREATOR", "MODIFIER", "CREATED_TIME", "UPDATED_TIME"].includes(def.type)) {
      console.log(`${indent}${code}\t${typeLabel(def.type)}\t${def.label || ""}`);
    }
  }
}

(async () => {
  if (!BASE_URL) {
    console.log("KINTONE_BASE_URLが未設定です(.envを確認してください)");
    process.exit(1);
  }
  const target = process.argv[2] ? [process.argv[2].toUpperCase()] : APP_KEYS;
  for (const key of target) {
    const appId = process.env[`KINTONE_${key}_APP_ID`];
    const token = process.env[`KINTONE_${key}_API_TOKEN`];
    if (!appId || !token) {
      console.log(`\n=== ${key}: 環境変数(KINTONE_${key}_APP_ID / _API_TOKEN)が未設定のためスキップ ===`);
      continue;
    }
    console.log(`\n=== ${key}(アプリID: ${appId}) ===`);
    try {
      const properties = await fetchFields(appId, token);
      printFields(properties);
    } catch (e) {
      console.log(`取得エラー: ${e.message}`);
    }
  }
})();
