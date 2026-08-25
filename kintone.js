// kintoneとの通信をまとめたモジュール。
// PowerShellプロトタイプ(_Common.ps1 / Server.ps1)の在庫計算ロジックをそのまま踏襲している。

const APP_KEYS = ["ZAIKO", "SHUKKO", "NYUKO", "PARTS", "STORE"];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません`);
  return v;
}

const KINTONE_BASE_URL = requireEnv("KINTONE_BASE_URL").replace(/\/+$/, "");
const APP_ID = {};
const APP_TOKEN = {};
for (const key of APP_KEYS) {
  APP_ID[key] = requireEnv(`KINTONE_${key}_APP_ID`);
  APP_TOKEN[key] = requireEnv(`KINTONE_${key}_API_TOKEN`);
}

// 対象の2店舗(在庫を分けて表示する単位)。店舗マスタが増えたら合わせて増やす想定。
const STORES = ["スーツケース救急車", "豊田倉庫"];

// 店舗ごとにアラート閾値(適正在庫数)を別フィールドで持つ。豊田倉庫は未入力なら
// 常にアラート対象外(店舗側のような共通閾値へのフォールバックはしない)。
const THRESHOLD_FIELD_BY_STORE = {
  "スーツケース救急車": "適正在庫数",
  "豊田倉庫": "適正在庫数_豊田用",
};

// パーツ番号のプレフィックス(ハイフンより前)からカテゴリ名を判定する。
const CATEGORY_MAP = {
  A: "A-キャスター",
  B: "B-軸",
  C: "C-ブラインドリベット",
  D: "D-ベアリング/ワッシャー/ナット/ネジ",
  E: "E-樹脂ハンドル",
  F: "F-ハードハンドル/布ハンドル",
  G: "G-ロック",
  H: "H-伸縮ハンドル",
  J: "J-フットパーツ",
  K: "K-ハウジング/足パーツ",
  L: "L-スライダー",
  M: "M-TUMI",
  N: "N-RIMOWA",
  O: "O-サムソナイト",
  P: "P-その他/内装",
  W: "W-工具類",
};

function getCategoryFromPartNo(partNo) {
  if (!partNo) return "その他";
  const prefix = partNo.split("-")[0];
  if (CATEGORY_MAP[prefix]) return CATEGORY_MAP[prefix];
  return `その他(${prefix})`;
}

function authHeaders(appKey) {
  return { "X-Cybozu-API-Token": APP_TOKEN[appKey] };
}

// ルックアップフィールドを含むレコード追加/更新には、操作対象アプリのトークンだけでなく
// ルックアップ参照先アプリのトークンもカンマ区切りで一緒に渡す必要がある(kintoneの仕様)。
function combinedAuthHeaders(appKeys) {
  return { "X-Cybozu-API-Token": appKeys.map((k) => APP_TOKEN[k]).join(",") };
}

// kintoneは1回のGETで最大500件までしか返らないため、offsetを進めながら全件取得する。
async function getAllRecords(appKey, query = "") {
  const limit = 500;
  let offset = 0;
  const all = [];
  while (true) {
    const q = `${query} limit ${limit} offset ${offset}`.trim();
    const url = `${KINTONE_BASE_URL}/k/v1/records.json?app=${APP_ID[appKey]}&query=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: authHeaders(appKey) });
    if (!res.ok) {
      throw new Error(`kintone取得エラー(${appKey}): ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    all.push(...json.records);
    if (json.records.length < limit) break;
    offset += limit;
  }
  return all;
}

// 店舗ごとの実在庫を算出する。
// 実在庫(店舗別) = (その店舗への入庫「袋数」合計 - その店舗からの出庫「出庫数」合計) + その店舗の棚卸差異
async function getInventoryList() {
  const [partsRecords, zaikoRecords, shukkoRecords, nyukoRecords] = await Promise.all([
    getAllRecords("PARTS"),
    getAllRecords("ZAIKO"),
    getAllRecords("SHUKKO"),
    getAllRecords("NYUKO"),
  ]);

  const partNoByBarcode = {};
  const partNameByBarcode = {};
  const unitByBarcode = {};
  const thresholdByBarcode = {};
  const imageFileKeyByBarcode = {};

  for (const r of partsRecords) {
    const masterBc = r["バーコード番号"]?.value;
    if (!masterBc) continue;
    partNoByBarcode[masterBc] = r["パーツ番号"]?.value;
    partNameByBarcode[masterBc] = r["パーツ名"]?.value;
    unitByBarcode[masterBc] = r["単位・袋分け用"]?.value;
    const images = r["パーツ画像"]?.value;
    if (images && images.length > 0) imageFileKeyByBarcode[masterBc] = images[0].fileKey;
    // 店舗ごとのアラート閾値(未設定のパーツもある)。0は「アラート対象外」の意味。
    const thresholds = {};
    for (const store of STORES) {
      const thresholdVal = r[THRESHOLD_FIELD_BY_STORE[store]]?.value;
      thresholds[store] = thresholdVal !== null && thresholdVal !== undefined && thresholdVal !== "" ? Number(thresholdVal) : null;
    }
    thresholdByBarcode[masterBc] = thresholds;
  }

  // キー: "店舗名|バーコード番号"
  const nyukoTotal = {};
  for (const r of nyukoRecords) {
    const store = r["入庫先"]?.value;
    for (const row of r["テーブル"]?.value || []) {
      const bc = row.value["バーコード番号_1"]?.value;
      if (!bc) continue;
      const qty = Number(row.value["袋数"]?.value || 0);
      const key = `${store}|${bc}`;
      nyukoTotal[key] = (nyukoTotal[key] || 0) + qty;
    }
  }

  const shukkoTotal = {};
  for (const r of shukkoRecords) {
    const store = r["出庫元"]?.value;
    for (const row of r["テーブル"]?.value || []) {
      const bc = row.value["バーコード番号"]?.value;
      if (!bc) continue;
      const qty = Number(row.value["出庫数"]?.value || 0);
      const key = `${store}|${bc}`;
      shukkoTotal[key] = (shukkoTotal[key] || 0) + qty;
    }
  }

  const diffByKey = {};
  const latestDateByKey = {};
  for (const r of zaikoRecords) {
    const bc = r["バーコード番号"]?.value;
    const store = r["倉庫名"]?.value;
    if (!bc) continue;
    const date = r["棚卸日"]?.value;
    const qty = Number(r["在庫数"]?.value || 0);
    const key = `${store}|${bc}`;
    if (!(key in latestDateByKey) || date > latestDateByKey[key]) {
      latestDateByKey[key] = date;
      diffByKey[key] = qty;
    }
  }

  const allBarcodes = Object.keys(partNoByBarcode).sort();
  return allBarcodes.map((bc) => {
    const partNo = partNoByBarcode[bc];
    const stocks = {};
    for (const store of STORES) {
      const key = `${store}|${bc}`;
      const theoretical = (nyukoTotal[key] || 0) - (shukkoTotal[key] || 0);
      stocks[store] = theoretical + (diffByKey[key] || 0);
    }
    return {
      partNo,
      partName: partNameByBarcode[bc],
      barcode: bc,
      unit: unitByBarcode[bc] ?? null,
      category: getCategoryFromPartNo(partNo),
      threshold: thresholdByBarcode[bc] ?? Object.fromEntries(STORES.map((s) => [s, null])),
      imageFileKey: imageFileKeyByBarcode[bc] ?? null,
      stocks,
    };
  });
}

// パーツ番号・パーツ名・バーコード番号のいずれかに部分一致するパーツを検索する。
async function findPartsByKeyword(keyword) {
  const escaped = (keyword || "").replace(/"/g, '\\"');
  const q = `(パーツ番号 like "${escaped}" or パーツ名 like "${escaped}" or バーコード番号 like "${escaped}")`;
  const records = (await getAllRecords("PARTS", q)).slice(0, 20);
  return records.map((r) => {
    const images = r["パーツ画像"]?.value;
    return {
      partNo: r["パーツ番号"]?.value,
      partName: r["パーツ名"]?.value,
      unit: r["単位・袋分け用"]?.value,
      barcode: r["バーコード番号"]?.value,
      imageFileKey: images && images.length > 0 ? images[0].fileKey : null,
    };
  });
}

// 指定バーコード・店舗の理論在庫だけをピンポイントで計算する(棚卸修正の差異算出用)。
async function getTheoreticalStock(barcode, store) {
  const escBc = barcode.replace(/"/g, '\\"');
  const escStore = store.replace(/"/g, '\\"');

  const nyukoRecords = await getAllRecords("NYUKO", `バーコード番号_1 like "${escBc}" and 入庫先 = "${escStore}"`);
  let inTotal = 0;
  for (const r of nyukoRecords) {
    for (const row of r["テーブル"]?.value || []) {
      if (row.value["バーコード番号_1"]?.value === barcode) {
        inTotal += Number(row.value["袋数"]?.value || 0);
      }
    }
  }

  const shukkoRecords = await getAllRecords("SHUKKO", `バーコード番号 like "${escBc}" and 出庫元 = "${escStore}"`);
  let outTotal = 0;
  for (const r of shukkoRecords) {
    for (const row of r["テーブル"]?.value || []) {
      if (row.value["バーコード番号"]?.value === barcode) {
        outTotal += Number(row.value["出庫数"]?.value || 0);
      }
    }
  }

  return inTotal - outTotal;
}

// 棚卸で数えた「実数」を受け取り、理論在庫との差異を自動計算して在庫管理アプリに1件登録する。
async function addZaikoAdjustment(data) {
  const theoretical = await getTheoreticalStock(data.barcode, data.store);
  const diff = Number(data.actualCount) - theoretical;

  const headers = { ...combinedAuthHeaders(["ZAIKO", "PARTS", "STORE"]), "Content-Type": "application/json; charset=utf-8" };
  const body = {
    app: Number(APP_ID.ZAIKO),
    record: {
      棚卸日: { value: data.date },
      倉庫名: { value: data.store },
      バーコード番号: { value: data.barcode },
      パーツ番号: { value: data.partNo },
      パーツ名: { value: data.partName },
      在庫数: { value: diff },
    },
  };
  const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`kintone登録エラー: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { id: json.id, theoretical, diff, actual: data.actualCount };
}

// 対象アプリで「日付フィールド=当日」「店舗フィールド=選択店舗」のレコードが既にあれば
// そのテーブルに複数行をまとめて追記(PUT更新)、無ければ新規作成(POST)する。
async function addOrAppendRecord({ appKey, dateField, storeField, dateValue, storeValue, newRows, headerFields }) {
  const headers = { ...combinedAuthHeaders([appKey, "PARTS", "STORE"]), "Content-Type": "application/json; charset=utf-8" };
  const appId = APP_ID[appKey];

  const escStore = storeValue.replace(/"/g, '\\"');
  const q = `${dateField} = "${dateValue}" and ${storeField} = "${escStore}" limit 1`;
  const searchUrl = `${KINTONE_BASE_URL}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(q)}`;
  const searchRes = await fetch(searchUrl, { headers: authHeaders(appKey) });
  if (!searchRes.ok) throw new Error(`kintone検索エラー: ${searchRes.status} ${await searchRes.text()}`);
  const searchJson = await searchRes.json();

  const newRowValues = newRows.map((row) => {
    const rowValue = {};
    for (const k of Object.keys(row)) rowValue[k] = { value: row[k] };
    return { value: rowValue };
  });

  if (searchJson.records.length > 0) {
    const existing = searchJson.records[0];
    const updatedRows = existing["テーブル"].value.concat(newRowValues);
    const updateBody = {
      app: Number(appId),
      id: Number(existing["レコード番号"].value),
      record: { テーブル: { value: updatedRows } },
    };
    const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json`, {
      method: "PUT",
      headers,
      body: JSON.stringify(updateBody),
    });
    if (!res.ok) throw new Error(`kintone更新エラー: ${res.status} ${await res.text()}`);
    return { id: existing["レコード番号"].value, appended: true, rowCount: newRowValues.length };
  }

  const record = {};
  for (const k of Object.keys(headerFields)) record[k] = { value: headerFields[k] };
  record["テーブル"] = { value: newRowValues };
  const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ app: Number(appId), record }),
  });
  if (!res.ok) throw new Error(`kintone登録エラー: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { id: json.id, appended: false, rowCount: newRowValues.length };
}

async function addShukkoFromWeb(data) {
  const rows = data.items.map((item) => ({
    バーコード番号: item.barcode,
    パーツ番号: item.partNo,
    パーツ名: item.partName,
    "単位・袋分け用": item.unit,
    出庫数: item.qty,
  }));
  return addOrAppendRecord({
    appKey: "SHUKKO",
    dateField: "出庫日",
    storeField: "出庫元",
    dateValue: data.date,
    storeValue: data.from,
    newRows: rows,
    headerFields: { 出庫日: data.date, 出庫元: data.from },
  });
}

async function addNyukoFromWeb(data) {
  const rows = data.items.map((item) => ({
    バーコード番号_1: item.barcode,
    パーツ番号: item.partNo,
    パーツ名: item.partName,
    袋数: item.qty,
    "単位・袋分け用": item.unit,
  }));
  return addOrAppendRecord({
    appKey: "NYUKO",
    dateField: "入荷日",
    storeField: "入庫先",
    dateValue: data.date,
    storeValue: data.to,
    newRows: rows,
    headerFields: { 入荷日: data.date, 入庫先: data.to, "担当者・指示書作成者": data.tantosha },
  });
}

async function fetchPartsImage(fileKey) {
  const url = `${KINTONE_BASE_URL}/k/v1/file.json?fileKey=${fileKey}`;
  const res = await fetch(url, { headers: authHeaders("PARTS") });
  if (!res.ok) throw new Error(`kintone画像取得エラー: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { buffer, contentType };
}

module.exports = {
  STORES,
  CATEGORY_MAP,
  getInventoryList,
  findPartsByKeyword,
  addZaikoAdjustment,
  addShukkoFromWeb,
  addNyukoFromWeb,
  fetchPartsImage,
};
