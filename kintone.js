// kintoneとの通信をまとめたモジュール。
// PowerShellプロトタイプ(_Common.ps1 / Server.ps1)の在庫計算ロジックをそのまま踏襲している。

const { buildDeliveryNotePdf, buildInvoicePdf } = require("./pdf");

const APP_KEYS = ["ZAIKO", "SHUKKO", "NYUKO", "PARTS", "STORE", "IRAI", "IRAI_MINUTE"];

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

// 提携店からのパーツ購入依頼を管理しているkintoneアプリ(依頼元ごとに別アプリ)。
// 「発注表」テーブルはパーツマスタ登録済みのパーツ、「その他」テーブルはパーツマスタに無い特注品(バーコード無し)。
// 「発送準備」に相当するフィールドのコードが依頼元アプリによって異なる(依頼表=発送準備_0、ミニット用=発送準備)ので個別に持つ。
// shortageTable: 依頼数より少なく出庫した際の不足分を書き込む専用テーブル(ルックアップ無し、直接入力のみ)。
// 「発注表」はパーツマスタへのルックアップを含み、パーツ名の重複によりAPI経由では自動入力できないため新設した。
// アプリごとにテーブル名・フィールドコードの命名(自動採番の"_0"サフィックス)が異なる点に注意。
// docTypes: 出庫登録時に自動生成するPDFの種類と、その添付先フィールド(両アプリにもとから
// 存在する添付ファイル欄)。修理王は納品書欄しか無いため納品書のみ、ミニットは納品書・請求書の
// 両方の欄があるため両方を生成する(現物に添付する納品書と、請求処理用の請求書は用途が別のため)。
const REQUEST_SOURCES = [
  {
    key: "IRAI",
    label: "スーツケース修理王",
    shippingPrepField: "発送準備_0",
    shortageTable: "不足分明細",
    docTypes: [{ type: "delivery", field: "納品書", label: "納品書" }],
  },
  {
    key: "IRAI_MINUTE",
    label: "ミニット",
    shippingPrepField: "発送準備",
    shortageTable: "不足分_分納分明細",
    docTypes: [
      { type: "delivery", field: "納品書", label: "納品書" },
      { type: "invoice", field: "請求書", label: "請求書" },
    ],
    // 分納まとめ機能用: 出庫登録のたびに「実際に出庫した明細」をJSON文字列で保存しておくフィールド
    // (システム内部用。画面には出さない)。これが無い古い依頼(この機能を追加する前の分)はまとめられない。
    actualItemsField: "出庫実績JSON",
  },
];

// 不足分明細テーブル内のフィールドコードは、両アプリともテーブルコピーで自動生成されたもので共通("_0"サフィックス)。
const SHORTAGE_TABLE_FIELDS = {
  partNo: "パーツ番号_0",
  partName: "パーツ名_0",
  barcode: "バーコード番号_0",
  unit: "単位_0",
  qty: "購入数_0",
  price: "卸値_0",
};

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

// 依頼表アプリの「レコードのアクセス権限」は特定ユーザー/グループにしか編集を許可しておらず、
// APIトークン経由の書き込み(Everyone扱い)は権限が無いため反映されない。そのため依頼表への
// 書き込みだけは、権限を持つ実在のkintoneユーザー(サービスアカウント)としてパスワード認証を併用する。
const SERVICE_LOGIN_ID = process.env.KINTONE_SERVICE_LOGIN_ID;
const SERVICE_PASSWORD = process.env.KINTONE_SERVICE_PASSWORD;

function requestAuthHeaders(appKey) {
  const headers = authHeaders(appKey);
  if (SERVICE_LOGIN_ID && SERVICE_PASSWORD) {
    headers["X-Cybozu-Authorization"] = Buffer.from(`${SERVICE_LOGIN_ID}:${SERVICE_PASSWORD}`).toString("base64");
  }
  return headers;
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

// 出庫表・入庫表は「その日・その店舗」でまとめて1レコードにテーブル(明細行)を持つ構造が共通なので、
// 誤登録の見直し・削除機能もこの2アプリで共通の設定として扱う。
const HISTORY_CONFIG = {
  SHUKKO: {
    label: "出庫表",
    dateField: "出庫日",
    storeField: "出庫元",
    rowFields: { barcode: "バーコード番号", partNo: "パーツ番号", partName: "パーツ名", unit: "単位・袋分け用", qty: "出庫数" },
  },
  NYUKO: {
    label: "入庫表",
    dateField: "入荷日",
    storeField: "入庫先",
    rowFields: { barcode: "バーコード番号_1", partNo: "パーツ番号", partName: "パーツ名", unit: "単位・袋分け用", qty: "袋数" },
  },
};

// 直近days日分の出庫/入庫登録を、明細行(削除対象を指すrowIndex付き)ごと新しい順で返す。
async function getRegistrationHistory(appKey, days = 30) {
  const cfg = HISTORY_CONFIG[appKey];
  if (!cfg) throw new Error(`不正なアプリです: ${appKey}`);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const records = await getAllRecords(appKey, `${cfg.dateField} >= "${sinceStr}"`);
  const results = records.map((r) => ({
    appKey,
    recordId: r["レコード番号"]?.value,
    date: r[cfg.dateField]?.value || "",
    store: r[cfg.storeField]?.value || "",
    rows: (r["テーブル"]?.value || []).map((row, rowIndex) => ({
      rowIndex,
      barcode: row.value[cfg.rowFields.barcode]?.value || "",
      partNo: row.value[cfg.rowFields.partNo]?.value || "",
      partName: row.value[cfg.rowFields.partName]?.value || "",
      unit: row.value[cfg.rowFields.unit]?.value || "",
      qty: row.value[cfg.rowFields.qty]?.value || "",
    })),
  }));
  results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return results;
}

// その日・その店舗の登録をまとめて1件削除する。
// SHUKKO/NYUKOのAPIトークンには削除権限を付与していないため、依頼表と同様にサービスアカウントの
// パスワード認証を併用する(requestAuthHeadersは名前の通り依頼表用に作った関数だが、中身は
// 「APIトークン+サービスアカウント」の組み合わせを返すだけの汎用処理なのでそのまま使う)。
async function deleteRegistrationRecord(appKey, recordId) {
  if (!HISTORY_CONFIG[appKey]) throw new Error(`不正なアプリです: ${appKey}`);
  const res = await fetch(`${KINTONE_BASE_URL}/k/v1/records.json?app=${APP_ID[appKey]}&ids%5B%5D=${recordId}`, {
    method: "DELETE",
    headers: requestAuthHeaders(appKey),
  });
  if (!res.ok) throw new Error(`削除エラー: ${res.status} ${await res.text()}`);
  return { deleted: "record" };
}

// 登録済み明細を1行だけ削除する。削除した結果テーブルが空になる場合はレコードごと削除する。
// テーブルのバーコード番号はPARTSアプリへのルックアップのため、書き戻し(PUT)にはSHUKKO/NYUKO単体の
// トークンだけでなくPARTS・STOREのトークンも組み合わせて渡す必要がある(addOrAppendRecordと同じ理由)。
async function deleteRegistrationRow(appKey, recordId, rowIndex) {
  if (!HISTORY_CONFIG[appKey]) throw new Error(`不正なアプリです: ${appKey}`);
  const appId = APP_ID[appKey];
  const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json?app=${appId}&id=${recordId}`, { headers: authHeaders(appKey) });
  if (!res.ok) throw new Error(`レコード取得エラー: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const rows = json.record["テーブル"].value;
  if (rowIndex < 0 || rowIndex >= rows.length) throw new Error("指定された明細が見つかりません(画面を再読み込みしてください)");
  const updatedRows = rows.filter((_, i) => i !== rowIndex);
  if (updatedRows.length === 0) return deleteRegistrationRecord(appKey, recordId);

  const headers = { ...combinedAuthHeaders([appKey, "PARTS", "STORE"]), "Content-Type": "application/json; charset=utf-8" };
  const updateRes = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ app: Number(appId), id: Number(recordId), record: { テーブル: { value: updatedRows } } }),
  });
  if (!updateRes.ok) throw new Error(`明細の削除エラー: ${updateRes.status} ${await updateRes.text()}`);
  return { deleted: "row" };
}

// 提携店からのパーツ購入依頼を、依頼元アプリ横断で一覧取得する。
// status="pending"(既定): まだ在庫アプリから出庫登録していない依頼(「出庫登録日」が空、かつ発送準備が準備中)。
// status="completed": この機能で出庫登録済みの依頼(「出庫登録日」が入っている)。間違いが無かったか
// 見直せるよう、新しい順で返す。この機能を作る前にK-Reportで手動処理した過去分は「出庫登録日」が
// 無いため、どちらにも出てこない(該当データが無いだけで正常な挙動)。
async function getRequests(status = "pending") {
  // 依頼表側の「バーコード番号」欄は未入力のことが多いため、パーツ番号からPARTSマスタを逆引きして補完する。
  const partsRecords = await getAllRecords("PARTS");
  const barcodeByPartNo = {};
  const unitByPartNo = {};
  const priceByPartNo = {};
  const minuteCodeByPartNo = {};
  for (const r of partsRecords) {
    const partNo = r["パーツ番号"]?.value;
    if (!partNo) continue;
    barcodeByPartNo[partNo] = r["バーコード番号"]?.value || "";
    unitByPartNo[partNo] = r["単位・袋分け用"]?.value || "";
    priceByPartNo[partNo] = Number(r["卸値"]?.value || 0);
    minuteCodeByPartNo[partNo] = r["ミニット商品コード"]?.value || "";
  }

  const results = [];
  for (const { key, label, shippingPrepField, shortageTable, docTypes } of REQUEST_SOURCES) {
    // 日付フィールドの空/非空チェックは is empty / is not empty ではなく = "" / != "" を使う(kintoneの仕様)。
    const query =
      status === "completed" ? `出庫登録日 != ""` : `出庫登録日 = "" and ${shippingPrepField} in ("準備中")`;
    const records = await getAllRecords(key, query);
    for (const r of records) {
      const fromOrderTable = (r["発注表"]?.value || [])
        .map((row, tableRowIndex) => {
          const partNo = row.value["パーツ番号"]?.value || "";
          return {
            partNo,
            partName: row.value["パーツ名"]?.value || "",
            barcode: row.value["バーコード番号"]?.value || barcodeByPartNo[partNo] || "",
            unit: row.value["単位"]?.value || unitByPartNo[partNo] || "",
            qty: Number(row.value["購入数"]?.value || 0),
            price: Number(row.value["卸値"]?.value || 0) || priceByPartNo[partNo] || 0,
            minuteCode: row.value["ミニット商品コード"]?.value || minuteCodeByPartNo[partNo] || "",
            // パーツ名_ミニット名称はIRAI_MINUTEの発注表にしか無いフィールドだが、無いアプリでは
            // row.value["..."]がundefinedになるだけで安全(?.valueでエラーにならない)。
            // ミニット向け請求書のパーツ番号/名称欄には、自社名称ではなくこちらを表示する。
            minuteName: row.value["パーツ名_ミニット名称"]?.value || "",
          };
        })
        .filter((item) => item.qty > 0);
      // 以前この機能で「今回は不足」として作成された分(ルックアップ無しの専用テーブル)。
      // フィールド構成は発注表と同じ意味を持つが、フィールドコードはアプリ側の自動採番("_0")になっている。
      // 単価・ミニット商品コードはこのテーブルには持たせていない(無いレコードもある)ため、
      // 常にパーツマスタ側の値をフォールバックとして使う。
      const fromShortageTable = (r[shortageTable]?.value || [])
        .map((row) => {
          const partNo = row.value[SHORTAGE_TABLE_FIELDS.partNo]?.value || "";
          return {
            partNo,
            partName: row.value[SHORTAGE_TABLE_FIELDS.partName]?.value || "",
            barcode: row.value[SHORTAGE_TABLE_FIELDS.barcode]?.value || barcodeByPartNo[partNo] || "",
            unit: row.value[SHORTAGE_TABLE_FIELDS.unit]?.value || unitByPartNo[partNo] || "",
            qty: Number(row.value[SHORTAGE_TABLE_FIELDS.qty]?.value || 0),
            price: Number(row.value[SHORTAGE_TABLE_FIELDS.price]?.value || 0) || priceByPartNo[partNo] || 0,
            minuteCode: minuteCodeByPartNo[partNo] || "",
            minuteName: row.value["パーツ名_ミニット名称_0"]?.value || "",
          };
        })
        .filter((item) => item.qty > 0);
      const items = [...fromOrderTable, ...fromShortageTable];
      // 「その他」テーブルはパーツマスタに無い特注品でバーコードが無いため、在庫アプリからの自動突合はできない。
      // 出庫登録自体は担当者が内容を見て手入力する前提の参考情報として返す。
      const otherItems = (r["その他"]?.value || [])
        .map((row) => ({
          partName: row.value["パーツ名_その他"]?.value || "",
          color: row.value["色_その他"]?.value || "",
          qty: Number(row.value["購入数_その他"]?.value || 0),
          price: Number(row.value["卸値_その他"]?.value || 0),
        }))
        .filter((item) => item.qty > 0);
      if (items.length === 0 && otherItems.length === 0) continue;
      results.push({
        source: key,
        sourceLabel: label,
        recordId: r["$id"]?.value,
        date: r["日付"]?.value || "",
        storeName: r["店舗名"]?.value || "",
        items,
        otherItems,
        shukkoDate: r["出庫登録日"]?.value || "",
        // 発送済み表示で、実際に添付された納品書/請求書PDFをその場で見返せるようにする。
        documents: (docTypes || []).map(({ field, label: docLabel }) => ({
          label: docLabel,
          files: (r[field]?.value || []).map((f) => ({ name: f.name, fileKey: f.fileKey })),
        })),
      });
    }
  }
  results.sort((a, b) => {
    const key1 = status === "completed" ? a.shukkoDate : a.date;
    const key2 = status === "completed" ? b.shukkoDate : b.date;
    return (key2 || "").localeCompare(key1 || "");
  });
  return results;
}

// 依頼表アプリの添付ファイル(納品書/請求書)を、fileKey指定でダウンロードする。
async function fetchRequestDocument(source, fileKey) {
  if (!REQUEST_SOURCES.some((s) => s.key === source)) throw new Error(`不正な依頼元です: ${source}`);
  const url = `${KINTONE_BASE_URL}/k/v1/file.json?fileKey=${fileKey}`;
  const res = await fetch(url, { headers: authHeaders(source) });
  if (!res.ok) throw new Error(`kintoneファイル取得エラー: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/pdf";
  return { buffer, contentType };
}

// パーツ番号の配列から、パーツマスタのバーコード・パーツ名・単位・卸値・ミニット商品コードを
// まとめて逆引きする。新規依頼作成でパーツ番号だけ分かっている場合(手入力・ミニットのExcel
// 貼り付けとも共通)に使う。
async function lookupPartsByPartNos(partNos) {
  const uniq = [...new Set((partNos || []).filter(Boolean))];
  if (uniq.length === 0) return {};
  const q = `パーツ番号 in (${uniq.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(",")})`;
  const records = await getAllRecords("PARTS", q);
  const map = {};
  for (const r of records) {
    const partNo = r["パーツ番号"]?.value;
    if (!partNo) continue;
    map[partNo] = {
      partName: r["パーツ名"]?.value || "",
      barcode: r["バーコード番号"]?.value || "",
      unit: r["単位・袋分け用"]?.value || "",
      price: Number(r["卸値"]?.value || 0),
      minuteCode: r["ミニット商品コード"]?.value || "",
    };
  }
  return map;
}

// 依頼表アプリの「店舗名」も実は隠れたルックアップキー(店舗名_検索)を持っており、実在しない
// 文字列を入れるとレコード作成自体がGAIA_LO04エラーになる。自由入力を許すと表記ゆれで
// 高確率で失敗するため、新規依頼作成画面では過去の依頼で実際に使われた店舗名を候補として
// 出せるように、既存レコードから一覧をユニークに集めて返す。
async function getRequestStoreNames(source) {
  if (!REQUEST_SOURCES.some((s) => s.key === source)) throw new Error(`不正な依頼元です: ${source}`);
  const records = await getAllRecords(source);
  const names = new Set();
  for (const r of records) {
    const name = r["店舗名"]?.value;
    if (name) names.add(name);
  }
  return [...names].sort();
}

// 提携店からの新規依頼を、この在庫アプリから直接作成する。修理王は担当者がパーツを検索して
// 手入力、ミニットはExcelの発注データをそのまま貼り付けて作る想定(app.js側で列を解析)。
// 発注表テーブルは見た目上「パーツ番号・パーツ名・バーコード番号・単位・卸値」等がどれも
// 普通のテキスト/数値フィールドに見える(fields.jsonのtypeもSINGLE_LINE_TEXT/NUMBERで、
// lookupプロパティもnull)が、実機検証の結果、実際には裏で「隠れたルックアップキー」に
// よって他の項目がまとめてクリアされる挙動があることが判明した。具体的には:
//  - 修理王(IRAI): パーツ_検索フィールドがキー(値は常にパーツ名と同じ)。これが空だと、
//    パーツ番号・パーツ名・バーコード番号・単位・卸値まで含めて全部空で保存される。
//  - ミニット(IRAI_MINUTE): ミニット商品コードフィールドがキー。不正な値を入れるとGAIA_LO04
//    エラーになり、逆に空のまま送るとパーツ番号まで含めて全部空で保存される。
// そのため、キー相当の項目には必ずパーツマスタ側の実在する値(パーツ名・ミニット商品コード)を
// 補って送る。パーツマスタに無い新パーツ(キーが用意できない)は、この発注表テーブルには
// 書き込まず、ルックアップを持たない「不足分」用テーブルに書き込むことで安全に登録する
// (不足分の自動作成:createShortageRequestと同じ考え方)。
// レコード直下の「店舗名」も同様に隠れたキー(店舗名_検索)を持ち、実在しない文字列を
// 入れるとレコード作成自体がGAIA_LO04で失敗するため、店舗名はgetRequestStoreNamesの
// 候補一覧から選んだ値を渡す前提で、店舗名_検索フィールドに書き込む。
// 卸値はitem側の値(ミニットのExcelにある「単価」など、その依頼時点の金額)を優先し、
// 未指定であればパーツマスタの現在の卸値を使う。
async function createRequest({ source, date, storeName, items }) {
  const sourceConfig = REQUEST_SOURCES.find((s) => s.key === source);
  if (!sourceConfig) throw new Error(`不正な依頼元です: ${source}`);
  const validItems = (items || []).filter((item) => item.partNo && Number(item.qty) > 0);
  if (validItems.length === 0) throw new Error("明細が1件もありません");

  const partsMap = await lookupPartsByPartNos(validItems.map((item) => item.partNo));

  // 隠れたルックアップキーとして使える値がパーツマスタ側に存在するかどうかで、書き込み先
  // テーブルを振り分ける。修理王(IRAI)はパーツ_検索(値はパーツ名)がキーだが、実機検証の結果、
  // 参照先(パーツマスタのパーツ名フィールド)に重複禁止設定が掛かっていないため、そもそも
  // ルックアップとして機能せず必ずGAIA_LO03エラーになることが判明した。そのためIRAIは常に
  // 不足分明細テーブル側に書き込む(ミニットはミニット商品コードのルックアップが正常に機能する)。
  const hasUsableKey = (master) => {
    if (source !== "IRAI_MINUTE") return false;
    return !!master?.minuteCode;
  };
  const matchedItems = validItems.filter((item) => hasUsableKey(partsMap[item.partNo]));
  const unmatchedItems = validItems.filter((item) => !hasUsableKey(partsMap[item.partNo]));

  const rows = matchedItems.map((item) => {
    const master = partsMap[item.partNo];
    const rowValue = {
      パーツ番号: { value: item.partNo },
      パーツ名: { value: master.partName || "" },
      バーコード番号: { value: master.barcode || "" },
      単位: { value: master.unit || "" },
      卸値: {
        value: item.price !== undefined && item.price !== null && item.price !== "" ? Number(item.price) : master.price || 0,
      },
      購入数: { value: Number(item.qty) },
    };
    // source === "IRAI_MINUTE" のときしかここに来ない(修理王は常にunmatchedItems側で処理する)。
    rowValue["ミニット商品コード"] = { value: master.minuteCode };
    rowValue["パーツ名_ミニット名称"] = { value: item.minuteName || "" };
    return { value: rowValue };
  });

  const record = {
    日付: { value: date },
  };
  // 店舗名_検索が未登録の値だとレコード作成自体が失敗するため、空欄のときだけは書き込まない
  // (店舗名未入力のまま作成できるようにする)。
  if (storeName) record["店舗名_検索"] = { value: storeName };
  if (rows.length > 0) record["発注表"] = { value: rows };
  // パーツマスタに無い(隠れたキーが用意できない)分は、ルックアップを一切持たない
  // 「不足分」テーブルに書き込む。createShortageRequestと同じ、実機検証済みの安全な書き込み先。
  if (unmatchedItems.length > 0) {
    record[sourceConfig.shortageTable] = {
      value: unmatchedItems.map((item) => {
        // unmatched=隠れたキーが使えない、であってパーツマスタに無いとは限らない
        // (ミニットはパーツ自体はマスタにあってもミニット商品コード未設定なら unmatched になる)ため、
        // マスタ情報があれば優先的に使う。
        const master = partsMap[item.partNo] || {};
        const rowValue = {
          [SHORTAGE_TABLE_FIELDS.partNo]: { value: item.partNo },
          [SHORTAGE_TABLE_FIELDS.partName]: { value: master.partName || item.partName || item.minuteName || "" },
          [SHORTAGE_TABLE_FIELDS.barcode]: { value: master.barcode || item.barcode || "" },
          [SHORTAGE_TABLE_FIELDS.unit]: { value: master.unit || item.unit || "" },
          [SHORTAGE_TABLE_FIELDS.qty]: { value: Number(item.qty) },
          [SHORTAGE_TABLE_FIELDS.price]: {
            value: item.price !== undefined && item.price !== null && item.price !== "" ? Number(item.price) : master.price || 0,
          },
        };
        if (source === "IRAI_MINUTE" && item.minuteName) {
          rowValue["パーツ名_ミニット名称_0"] = { value: item.minuteName };
        }
        return { value: rowValue };
      }),
    };
  }
  // 発送準備は必須の選択項目で、「準備中」でないとこの機能の依頼一覧(getRequests)に出てこない。
  if (source === "IRAI") {
    record["発送準備_0"] = { value: "準備中" };
    // IRAI側だけ存在する必須のチェックボックス。この画面からの新規作成では判断材料が無いため、
    // 安全側(共有しない)を既定値にしておく。
    record["スーツケースの救急車へ共有"] = { value: ["共有しない"] };
  } else {
    record["発送準備"] = { value: "準備中" };
  }

  const headers = { ...requestAuthHeaders(source), "Content-Type": "application/json; charset=utf-8" };
  const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ app: Number(APP_ID[source]), record }),
  });
  if (!res.ok) throw new Error(`依頼の作成エラー: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { id: json.id, rowCount: rows.length, unmatchedPartNos: unmatchedItems.map((item) => item.partNo) };
}

// 新規レコード作成時にそのままコピーしてよいフィールド型(逆に、レコード番号や集計項目・添付ファイルなど
// システム側で自動設定される/コピーすべきでない型は除外する)。
const COPYABLE_FIELD_TYPES = new Set([
  "SINGLE_LINE_TEXT", "MULTI_LINE_TEXT", "NUMBER", "RADIO_BUTTON",
  "CHECK_BOX", "DROP_DOWN", "MULTI_SELECT", "USER_SELECT", "LINK",
]);

async function getFieldTypeMap(appKey) {
  const url = `${KINTONE_BASE_URL}/k/v1/app/form/fields.json?app=${APP_ID[appKey]}`;
  const res = await fetch(url, { headers: authHeaders(appKey) });
  if (!res.ok) throw new Error(`kintoneフィールド取得エラー: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const map = {};
  for (const [name, f] of Object.entries(json.properties)) map[name] = f.type;
  return map;
}

// 依頼のうち今回出庫しきれなかった分を、元の依頼レコードの内容(店舗名・共有設定など)を引き継いだ
// 新しい依頼レコードとして作成する。日付は「出庫登録した日」を入れ、出庫登録日は空のままにすることで、
// 次にこの機能を開いたときに改めて「未処理の依頼」として一覧に出てくるようにする。
// 明細は「発注表」テーブル(パーツマスタへのルックアップ)ではなく、ルックアップ無しの専用テーブル
// (shortageTable)に書き込む。パーツ名の重複により、ルックアップはAPI経由では一意に解決できないため。
async function createShortageRequest(source, date, shortageInfo) {
  const sourceConfig = REQUEST_SOURCES.find((s) => s.key === source);
  const [original, typeMap] = await Promise.all([
    (async () => {
      const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json?app=${APP_ID[source]}&id=${shortageInfo.recordId}`, {
        headers: authHeaders(source),
      });
      if (!res.ok) throw new Error(`依頼レコード取得エラー: ${res.status} ${await res.text()}`);
      const json = await res.json();
      return json.record;
    })(),
    getFieldTypeMap(source),
  ]);
  if (!original) throw new Error(`元の依頼レコード(${shortageInfo.recordId})が見つかりません`);

  const newRecord = {};
  for (const [name, field] of Object.entries(original)) {
    if (!COPYABLE_FIELD_TYPES.has(typeMap[name])) continue;
    newRecord[name] = { value: field.value };
  }

  newRecord[sourceConfig.shortageTable] = {
    value: shortageInfo.items.map((item) => ({
      value: {
        [SHORTAGE_TABLE_FIELDS.partNo]: { value: item.partNo || "" },
        [SHORTAGE_TABLE_FIELDS.partName]: { value: item.partName || "" },
        [SHORTAGE_TABLE_FIELDS.barcode]: { value: item.barcode || "" },
        [SHORTAGE_TABLE_FIELDS.unit]: { value: item.unit || "" },
        [SHORTAGE_TABLE_FIELDS.qty]: { value: Number(item.qty) },
        [SHORTAGE_TABLE_FIELDS.price]: { value: Number(item.price) || 0 },
      },
    })),
  };
  newRecord["日付"] = { value: date };

  const headers = { ...requestAuthHeaders(source), "Content-Type": "application/json; charset=utf-8" };
  const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ app: Number(APP_ID[source]), record: newRecord }),
  });
  if (!res.ok) throw new Error(`不足分依頼の作成エラー: ${res.status} ${await res.text()}`);
  return await res.json();
}

// PDFファイルをkintoneにアップロードし、後で record.json のFILEフィールド値として使えるfileKeyを得る。
async function uploadFileToKintone(appKey, buffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/pdf" }), filename);
  const res = await fetch(`${KINTONE_BASE_URL}/k/v1/file.json`, {
    method: "POST",
    headers: requestAuthHeaders(appKey),
    body: form,
  });
  if (!res.ok) throw new Error(`kintoneファイルアップロードエラー: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.fileKey;
}

// 依頼の明細を、指定された出庫元(店舗名)ごとに振り分けてSHUKKOへ出庫登録し、
// 完了したら依頼表側のレコードに「出庫登録日」をセットして二重登録を防ぐ。
// 依頼数より少なく出庫した分(shortageItems)があれば、その差分を新しい依頼レコードとして作り直す。
// documentItems/documentOtherItemsは「実際に出庫した分」で、この内容から納品書/請求書PDFを生成し、
// 依頼表アプリにもとから存在する添付ファイル欄(納品書 or 請求書)へ自動アップロードする。
async function fulfillRequest({ source, recordId, date, shipments, shortageItems, documentItems, documentOtherItems, requestStoreName }) {
  const sourceConfig = REQUEST_SOURCES.find((s) => s.key === source);
  if (!sourceConfig) throw new Error(`不正な依頼元です: ${source}`);

  const shukkoResults = [];
  for (const shipment of shipments || []) {
    const items = (shipment.items || []).filter((item) => Number(item.qty) > 0);
    if (items.length === 0) continue;
    const rows = items.map((item) => ({
      バーコード番号: item.barcode || "",
      パーツ番号: item.partNo || "",
      パーツ名: item.partName || "",
      "単位・袋分け用": item.unit || "",
      出庫数: Number(item.qty),
    }));
    const result = await addOrAppendRecord({
      appKey: "SHUKKO",
      dateField: "出庫日",
      storeField: "出庫元",
      dateValue: date,
      storeValue: shipment.store,
      newRows: rows,
      headerFields: { 出庫日: date, 出庫元: shipment.store },
    });
    shukkoResults.push({ store: shipment.store, ...result });
  }

  let shortageResult = null;
  const validShortageItems = (shortageItems || []).filter((item) => Number(item.qty) > 0);
  if (validShortageItems.length > 0) {
    shortageResult = await createShortageRequest(source, date, { recordId, items: validShortageItems });
  }

  const docItems = (documentItems || []).filter((item) => Number(item.qty) > 0);
  const docOtherItems = (documentOtherItems || []).filter((item) => Number(item.qty) > 0);
  const documents = [];
  const record = { 出庫登録日: { value: date } };
  if (docItems.length > 0 || docOtherItems.length > 0) {
    for (const { type, field, label } of sourceConfig.docTypes) {
      // ミニット向け(納品書・請求書とも)は自社名称ではなくミニット商品コード・名称を見せる。
      const buffer =
        type === "invoice"
          ? await buildInvoicePdf({ date, items: docItems, otherItems: docOtherItems })
          : await buildDeliveryNotePdf({
              storeName: requestStoreName,
              date,
              items: docItems,
              otherItems: docOtherItems,
              showCode: source === "IRAI_MINUTE",
            });
      const timestamp = new Date().toISOString().replace("T", "_").replace(/:/g, "-").slice(0, 19);
      const filename = `report_${timestamp}.pdf`;
      const fileKey = await uploadFileToKintone(source, buffer, filename);
      record[field] = { value: [{ fileKey }] };
      documents.push({ label, filename, base64: buffer.toString("base64") });
    }
    // 分納まとめ機能用に、今回実際に出庫した明細をそのまま保存しておく
    if (sourceConfig.actualItemsField) {
      record[sourceConfig.actualItemsField] = { value: JSON.stringify({ items: docItems, otherItems: docOtherItems }) };
    }
  }

  const headers = { ...requestAuthHeaders(source), "Content-Type": "application/json; charset=utf-8" };
  const updateRes = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ app: Number(APP_ID[source]), id: Number(recordId), record }),
  });
  if (!updateRes.ok) throw new Error(`依頼表の更新エラー: ${updateRes.status} ${await updateRes.text()}`);

  return { shukkoResults, shortageResult, documents };
}

// 分納で複数回に分かれたミニット向け依頼(出庫登録済み・recordIds)の実出庫明細をまとめて
// 1枚の請求書PDFを作り、選択の中で最も新しい出庫登録日のレコードの「請求書」欄に上書き添付する。
// 各レコードに既にある個別の請求書PDF(納品書も)はそのまま残す。
async function mergeInvoices(recordIds) {
  const sourceConfig = REQUEST_SOURCES.find((s) => s.key === "IRAI_MINUTE");
  const ids = [...new Set((recordIds || []).map(Number))].filter(Boolean);
  if (ids.length < 2) throw new Error("まとめる依頼を2件以上選択してください");

  const records = [];
  for (const id of ids) {
    const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json?app=${APP_ID.IRAI_MINUTE}&id=${id}`, {
      headers: authHeaders("IRAI_MINUTE"),
    });
    if (!res.ok) throw new Error(`依頼レコード取得エラー(ID:${id}): ${res.status} ${await res.text()}`);
    const json = await res.json();
    records.push({ id, record: json.record });
  }

  const missing = records.filter((r) => !r.record[sourceConfig.actualItemsField]?.value);
  if (missing.length > 0) {
    throw new Error(
      `以下の依頼には出庫実績の記録が無いため、まとめられません(この機能を追加する前に出庫登録されたものです): ID ${missing
        .map((r) => r.id)
        .join(", ")}`
    );
  }

  const allItems = [];
  const allOtherItems = [];
  for (const { record } of records) {
    const parsed = JSON.parse(record[sourceConfig.actualItemsField].value);
    allItems.push(...(parsed.items || []));
    allOtherItems.push(...(parsed.otherItems || []));
  }
  if (allItems.length === 0 && allOtherItems.length === 0) throw new Error("まとめる明細がありません");

  // 出庫登録日が最も新しいレコードを代表(添付先)にする
  records.sort((a, b) => (b.record["出庫登録日"]?.value || "").localeCompare(a.record["出庫登録日"]?.value || ""));
  const target = records[0];

  const date = new Date().toISOString().slice(0, 10);
  const buffer = await buildInvoicePdf({ date, items: allItems, otherItems: allOtherItems });
  const timestamp = new Date().toISOString().replace("T", "_").replace(/:/g, "-").slice(0, 19);
  const filename = `report_merged_${timestamp}.pdf`;
  const fileKey = await uploadFileToKintone("IRAI_MINUTE", buffer, filename);

  const headers = { ...requestAuthHeaders("IRAI_MINUTE"), "Content-Type": "application/json; charset=utf-8" };
  const updateRes = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      app: Number(APP_ID.IRAI_MINUTE),
      id: Number(target.id),
      record: { 請求書: { value: [{ fileKey }] } },
    }),
  });
  if (!updateRes.ok) throw new Error(`まとめ請求書の添付エラー: ${updateRes.status} ${await updateRes.text()}`);

  return {
    targetRecordId: target.id,
    itemCount: allItems.length + allOtherItems.length,
    filename,
    base64: buffer.toString("base64"),
  };
}

// 入力ミスの依頼を削除する。出庫表・PDFと連動してしまうと整合性が崩れるため、
// まだ出庫登録していない(準備中の)依頼のみを対象とする。
async function deleteRequest(source, recordId) {
  const sourceConfig = REQUEST_SOURCES.find((s) => s.key === source);
  if (!sourceConfig) throw new Error(`不正な依頼元です: ${source}`);
  const res = await fetch(`${KINTONE_BASE_URL}/k/v1/record.json?app=${APP_ID[source]}&id=${recordId}`, {
    headers: authHeaders(source),
  });
  if (!res.ok) throw new Error(`依頼レコード取得エラー: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.record["出庫登録日"]?.value) {
    throw new Error("この依頼はすでに出庫登録済みのため、この画面からは削除できません");
  }
  const delRes = await fetch(`${KINTONE_BASE_URL}/k/v1/records.json?app=${APP_ID[source]}&ids%5B%5D=${recordId}`, {
    method: "DELETE",
    headers: requestAuthHeaders(source),
  });
  if (!delRes.ok) throw new Error(`依頼の削除エラー: ${delRes.status} ${await delRes.text()}`);
  return { deleted: true };
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
  REQUEST_SOURCES,
  CATEGORY_MAP,
  getInventoryList,
  findPartsByKeyword,
  addZaikoAdjustment,
  addShukkoFromWeb,
  addNyukoFromWeb,
  fetchPartsImage,
  getRequests,
  fetchRequestDocument,
  fulfillRequest,
  mergeInvoices,
  deleteRequest,
  lookupPartsByPartNos,
  getRequestStoreNames,
  createRequest,
  getRegistrationHistory,
  deleteRegistrationRecord,
  deleteRegistrationRow,
};
