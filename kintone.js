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
      const buildPdf = type === "invoice" ? buildInvoicePdf : buildDeliveryNotePdf;
      const buffer = await buildPdf({ storeName: requestStoreName, date, items: docItems, otherItems: docOtherItems });
      const timestamp = new Date().toISOString().replace("T", "_").replace(/:/g, "-").slice(0, 19);
      const filename = `report_${timestamp}.pdf`;
      const fileKey = await uploadFileToKintone(source, buffer, filename);
      record[field] = { value: [{ fileKey }] };
      documents.push({ label, filename, base64: buffer.toString("base64") });
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
};
