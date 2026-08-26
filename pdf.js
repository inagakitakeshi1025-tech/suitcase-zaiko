// 提携店への納品書・請求書PDFを生成するモジュール。
// 見た目は旧K-Reportの様式(サンプルPDF)に準拠しつつ、pdfmake(軽量な純JSライブラリ)で組み直している。
// ヘッドレスブラウザ等の重い依存を使わないため、Renderの無料枠でも動作コストが増えない。

const path = require("path");
const pdfmake = require("pdfmake");

const FONT_PATH = path.join(__dirname, "fonts", "NotoSansJP.ttf");
pdfmake.addFonts({
  NotoSansJP: { normal: FONT_PATH, bold: FONT_PATH, italics: FONT_PATH, bolditalics: FONT_PATH },
});

const TAX_RATE = 0.1;

// 請求書に載せる自社情報。サンプルPDF(旧K-Report出力)の内容をそのまま固定値として使う。
const COMPANY_NAME = "スーツケースの救急車／合同会社Facilitate";
const COMPANY_REGISTRATION_NUMBER = "T6180003016648";
const COMPANY_BANK_INFO = "愛知銀行　八事支店　普通　2057354　（ド）ファシリテート";
const PAYMENT_TERMS = "月末締め、翌月末日までのお振込みをお願い致します。";
const MINUTE_CUSTOMER_NAME = "ミニット　アジア　パシフィック（株）　様";

function yen(n) {
  return "¥" + Math.round(n || 0).toLocaleString("ja-JP");
}

function calcTotals(items, otherItems) {
  const subtotal = [...items, ...otherItems].reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 0), 0);
  const tax = Math.floor(subtotal * TAX_RATE);
  return { subtotal, tax, total: subtotal + tax };
}

function buildMainTable(items, { showCode }) {
  const headerRow = showCode
    ? ["NO.", "商品コード", "パーツ名(パーツ番号)", "単価", "購入数", "合計"]
    : ["NO.", "パーツ番号", "パーツ名", "単価", "購入数", "合計"];
  const widths = showCode ? ["auto", "auto", "*", "auto", "auto", "auto"] : ["auto", "auto", "*", "auto", "auto", "auto"];
  const body = [headerRow];
  items.forEach((item, i) => {
    const lineTotal = (Number(item.price) || 0) * (Number(item.qty) || 0);
    if (showCode) {
      body.push([
        String(i + 1),
        item.minuteCode || "",
        `${item.partName || ""}${item.partNo ? `(${item.partNo})` : ""}`,
        yen(item.price),
        String(item.qty),
        yen(lineTotal),
      ]);
    } else {
      body.push([String(i + 1), item.partNo || "", item.partName || "", yen(item.price), String(item.qty), yen(lineTotal)]);
    }
  });
  return { table: { headerRows: 1, widths, body }, layout: tableLayout(), margin: [0, 0, 0, 10] };
}

function buildOtherTable(otherItems, startNo) {
  const body = [["NO.", "パーツ名(特注品)", "単価", "購入数", "合計"]];
  otherItems.forEach((item, i) => {
    const lineTotal = (Number(item.price) || 0) * (Number(item.qty) || 0);
    body.push([
      String(startNo + i),
      `${item.partName || ""}${item.color ? `(${item.color})` : ""}`,
      yen(item.price),
      String(item.qty),
      yen(lineTotal),
    ]);
  });
  return {
    stack: [
      { text: "型番なし部材", margin: [0, 10, 0, 4] },
      { table: { headerRows: 1, widths: ["auto", "*", "auto", "auto", "auto"], body }, layout: tableLayout() },
    ],
  };
}

function tableLayout() {
  return {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5,
    hLineColor: () => "#999999",
    vLineColor: () => "#999999",
    fillColor: (rowIndex) => (rowIndex === 0 ? "#eeeeee" : null),
    paddingLeft: () => 4,
    paddingRight: () => 4,
    paddingTop: () => 3,
    paddingBottom: () => 3,
  };
}

function buildDocument({ title, addressLines, date, items, otherItems, showCode, footerBox, taxLine }) {
  const { subtotal, tax, total } = calcTotals(items, otherItems);
  const content = [
    { text: title, fontSize: 22, alignment: "center", margin: [0, 0, 0, 20] },
    {
      columns: [
        { width: "*", text: addressLines, fontSize: 11 },
        { width: "auto", text: [{ text: "発注年月日\n", fontSize: 9, color: "#666666" }, { text: date || "", fontSize: 12 }], alignment: "right" },
      ],
      margin: [0, 0, 0, 12],
    },
    { text: "以下の通り、納品いたします。", margin: [0, 0, 0, 10] },
    {
      table: { widths: ["auto"], body: [[{ text: `金額　${yen(total)}(税別：${subtotal.toLocaleString("ja-JP")})`, bold: false, margin: [4, 4, 4, 4] }]] },
      layout: tableLayout(),
      margin: [0, 0, 0, taxLine ? 4 : 14],
    },
  ];
  if (taxLine) content.push({ text: `(税：${tax.toLocaleString("ja-JP")})`, fontSize: 9, margin: [0, 0, 0, 14] });
  if (items.length > 0) content.push(buildMainTable(items, { showCode }));
  if (otherItems.length > 0) content.push(buildOtherTable(otherItems, items.length + 1));
  if (footerBox) {
    content.push({
      margin: [0, 20, 0, 0],
      stack: [
        { text: PAYMENT_TERMS, fontSize: 9 },
        { text: `入金先：${COMPANY_BANK_INFO}`, fontSize: 9, margin: [0, 4, 0, 0] },
        { text: COMPANY_NAME, fontSize: 9, margin: [0, 8, 0, 0] },
        { text: `登録番号：${COMPANY_REGISTRATION_NUMBER}`, fontSize: 9 },
      ],
    });
  }

  const docDefinition = {
    defaultStyle: { font: "NotoSansJP", fontSize: 10 },
    pageMargins: [40, 40, 40, 40],
    content,
    footer: (currentPage, pageCount) => ({
      text: `${currentPage}/${pageCount}`,
      alignment: "center",
      fontSize: 8,
      margin: [0, 10, 0, 0],
    }),
  };
  const pdf = pdfmake.createPdf(docDefinition);
  return pdf.getBuffer();
}

// 修理王向け。宛先はその依頼の店舗名(フランチャイズ加盟店名)。請求は別管理のため税抜金額のみ表示。
async function buildDeliveryNotePdf({ storeName, date, items, otherItems }) {
  return buildDocument({
    title: "納品書",
    addressLines: [{ text: "店舗名\n", fontSize: 9, color: "#666666" }, { text: storeName || "", fontSize: 13 }],
    date,
    items,
    otherItems,
    showCode: false,
    footerBox: false,
    taxLine: false,
  });
}

// ミニット向け。宛先は固定の取引先名。振込先等の請求情報を併記する。
async function buildInvoicePdf({ date, items, otherItems }) {
  return buildDocument({
    title: "請求書",
    addressLines: [{ text: MINUTE_CUSTOMER_NAME, fontSize: 13 }],
    date,
    items,
    otherItems,
    showCode: true,
    footerBox: true,
    taxLine: true,
  });
}

module.exports = { buildDeliveryNotePdf, buildInvoicePdf };
