// 提携店への納品書・請求書PDFを生成するモジュール。
// 旧K-Report出力(サンプルPDF)のレイアウトにできるだけ近づけている(二重罫線の見出し、
// 店舗名/発注年月日の枠、金額ボックス、請求書は振込先ボックスを右側に並べる、明朝体)。
// pdfmake(軽量な純JSライブラリ)で組んでおり、ヘッドレスブラウザ等の重い依存は使わない。

const path = require("path");
const pdfmake = require("pdfmake");

const FONT_PATH = path.join(__dirname, "fonts", "NotoSerifJP.ttf");
pdfmake.addFonts({
  NotoSerifJP: { normal: FONT_PATH, bold: FONT_PATH, italics: FONT_PATH, bolditalics: FONT_PATH },
});

const TAX_RATE = 0.1;
const PAGE_WIDTH = 515; // A4(pageMargins 40,40)の本文幅にほぼ合わせた基準値

// 請求書に載せる自社情報。サンプルPDF(旧K-Report出力)の内容をそのまま固定値として使う。
const COMPANY_NAME = "スーツケースの救急車／合同会社Facilitate";
const COMPANY_REGISTRATION_NUMBER = "T6180003016648";
const BANK_LINE = "入金先：愛知銀行　八事支店　普通　2057354";
const BANK_HOLDER = "　　　　　ド）ファシリテート";
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

function rule(width) {
  return { canvas: [{ type: "line", x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 1.2, lineColor: "#000000" }] };
}

function boxLayout() {
  return {
    hLineWidth: () => 1,
    vLineWidth: () => 1,
    hLineColor: () => "#000000",
    vLineColor: () => "#000000",
  };
}

function tableLayout() {
  return {
    hLineWidth: () => 0.75,
    vLineWidth: () => 0.75,
    hLineColor: () => "#000000",
    vLineColor: () => "#000000",
    paddingLeft: () => 4,
    paddingRight: () => 4,
    paddingTop: () => 3,
    paddingBottom: () => 3,
  };
}

// showCode(ミニット向け請求書)のときは、自社のパーツ番号/パーツ名ではなく、ミニット商品コード・
// ミニット向け名称(パーツ名_ミニット名称)を「パーツ番号/名称」欄に表示する。ミニット向け名称には
// 自社パーツ番号が既にカッコ書きで含まれている(例:「アウトスペーサー（D-201）」)ため、
// 修理王向け(showCode=false)と同じ2セル1見出しのレイアウトにそのまま流用できる。
function buildMainTable(items, { showCode }) {
  const headerRow = [
    { text: "NO.", alignment: "center" },
    { text: "パーツ番号/名称", colSpan: 2, alignment: "center" },
    {},
    { text: "単価", alignment: "center" },
    { text: "購入数", alignment: "center" },
    { text: "合計", alignment: "center" },
  ];
  const widths = [24, 55, "*", 50, 40, 60];
  const body = [headerRow];
  items.forEach((item, i) => {
    const lineTotal = (Number(item.price) || 0) * (Number(item.qty) || 0);
    const code = showCode ? item.minuteCode || "" : item.partNo || "";
    const name = showCode ? item.minuteName || item.partName || "" : item.partName || "";
    body.push([
      { text: String(i + 1), alignment: "center" },
      code,
      name,
      { text: yen(item.price), alignment: "right" },
      { text: String(item.qty), alignment: "right" },
      { text: yen(lineTotal), alignment: "right" },
    ]);
  });
  return { table: { headerRows: 1, widths, body }, layout: tableLayout(), margin: [0, 0, 0, 10] };
}

function buildOtherTable(otherItems, startNo) {
  const body = [[{ text: "NO.", alignment: "center" }, { text: "パーツ名(特注品)", alignment: "center" }, { text: "単価", alignment: "center" }, { text: "購入数", alignment: "center" }, { text: "合計", alignment: "center" }]];
  otherItems.forEach((item, i) => {
    const lineTotal = (Number(item.price) || 0) * (Number(item.qty) || 0);
    body.push([
      { text: String(startNo + i), alignment: "center" },
      `${item.partName || ""}${item.color ? `(${item.color})` : ""}`,
      { text: yen(item.price), alignment: "right" },
      { text: String(item.qty), alignment: "right" },
      { text: yen(lineTotal), alignment: "right" },
    ]);
  });
  return {
    stack: [
      { text: "型番なし部材", margin: [0, 10, 0, 4] },
      { table: { headerRows: 1, widths: [24, "*", 50, 40, 60], body }, layout: tableLayout() },
    ],
  };
}

function amountBox(total, subtotal) {
  return {
    table: {
      widths: [70, 150],
      body: [[
        { text: "金額", bold: true, alignment: "center", margin: [0, 6, 0, 6] },
        { text: `${yen(total)}(税別：${subtotal.toLocaleString("ja-JP")})`, alignment: "center", margin: [0, 6, 0, 6] },
      ]],
    },
    layout: boxLayout(),
  };
}

function paymentInfoBox() {
  return {
    table: {
      widths: ["*"],
      body: [[
        {
          stack: [
            { text: PAYMENT_TERMS, fontSize: 9 },
            { text: BANK_LINE, fontSize: 9, margin: [0, 4, 0, 0] },
            { text: BANK_HOLDER, fontSize: 9 },
            { text: COMPANY_NAME, fontSize: 9, margin: [0, 6, 0, 0] },
            { text: `登録番号：${COMPANY_REGISTRATION_NUMBER}`, fontSize: 9 },
          ],
          margin: [6, 6, 6, 6],
        },
      ]],
    },
    layout: boxLayout(),
  };
}

function buildDocument({ title, addressLabel, addressValue, date, items, otherItems, showCode, withPaymentBox, taxLine }) {
  const { subtotal, tax, total } = calcTotals(items, otherItems);

  const dateBox = {
    width: 160,
    table: {
      widths: ["*"],
      body: [
        [{ text: "発注年月日", alignment: "center", fontSize: 9, margin: [0, 3, 0, 2] }],
        [{ text: date || "", alignment: "center", fontSize: 13, margin: [0, 2, 0, 4] }],
      ],
    },
    layout: boxLayout(),
  };

  // ラベルがある場合(修理王の「店舗名」)は、記入欄を模した固定長の下線をラベルの下に引く
  // (店舗名の文字数に関わらず同じ見た目にするため)。ラベルが無い場合(ミニット向けの宛名)は
  // 固定長の線だと文字幅とずれるため、テキスト自体に下線装飾を付けて文字幅ぴったりに揃える。
  const addressBlock = {
    width: "*",
    stack: addressLabel
      ? [
          { text: addressLabel, fontSize: 9, margin: [0, 0, 0, 3] },
          rule(220),
          { text: addressValue, fontSize: 15, margin: [0, 4, 0, 0] },
        ]
      : [{ text: addressValue, fontSize: 15, decoration: "underline", margin: [0, 0, 0, 4] }],
  };

  const amountRow = withPaymentBox
    ? {
        columns: [
          { width: 230, stack: [amountBox(total, subtotal), { text: `(税：${tax.toLocaleString("ja-JP")})`, fontSize: 9, margin: [0, 4, 0, 0] }] },
          { width: "*", ...paymentInfoBox() },
        ],
        columnGap: 12,
        margin: [0, 0, 0, 16],
      }
    : { columns: [amountBox(total, subtotal)], margin: [0, 0, 0, 16] };

  const content = [
    rule(PAGE_WIDTH),
    { text: title, fontSize: 26, alignment: "center", margin: [0, 10, 0, 10] },
    rule(PAGE_WIDTH),
    { columns: [addressBlock, dateBox], columnGap: 10, margin: [0, 16, 0, 14] },
    { text: "以下の通り、納品いたします。", margin: [0, 0, 0, 12] },
    amountRow,
  ];
  if (items.length > 0) content.push(buildMainTable(items, { showCode }));
  if (otherItems.length > 0) content.push(buildOtherTable(otherItems, items.length + 1));

  const docDefinition = {
    defaultStyle: { font: "NotoSerifJP", fontSize: 10 },
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

// 納品書は修理王・ミニット共通で使う。パーツ番号/名称欄に何を出すか、宛先に何を出すかは
// どちらも書類種別ではなく依頼元で決まる(showCodeは実質「ミニット向けかどうか」を表す)。
// ミニットの納品書はミニット宛にしか作らない(依頼データの「店舗名」は社内でどの店舗向けに
// 準備するかの参考情報でしかなく、納品書の宛先ではない)ため、showCode時は請求書と同じ
// 固定の取引先名を宛先にする。
async function buildDeliveryNotePdf({ storeName, date, items, otherItems, showCode }) {
  return buildDocument({
    title: "納品書",
    addressLabel: showCode ? "" : "店舗名",
    addressValue: showCode ? MINUTE_CUSTOMER_NAME : storeName || "",
    date,
    items,
    otherItems,
    showCode: !!showCode,
    withPaymentBox: false,
    taxLine: false,
  });
}

// ミニット向け。宛先は固定の取引先名。振込先等の請求情報を右側に併記する。
async function buildInvoicePdf({ date, items, otherItems }) {
  return buildDocument({
    title: "請求書",
    addressLabel: "",
    addressValue: MINUTE_CUSTOMER_NAME,
    date,
    items,
    otherItems,
    showCode: true,
    withPaymentBox: true,
    taxLine: true,
  });
}

module.exports = { buildDeliveryNotePdf, buildInvoicePdf };
