const STORES = ["スーツケース救急車", "豊田倉庫"];

// ===== 在庫一覧 =====
let inventoryCache = [];

async function loadInventory() {
  const status = document.getElementById("list-status");
  status.textContent = "読み込み中...";
  try {
    const res = await fetch("/api/inventory");
    inventoryCache = await res.json();
    applyInventoryFilter();
    status.textContent = `${inventoryCache.length}件`;
  } catch (e) {
    status.textContent = "読み込みに失敗しました: " + e.message;
  }
}

async function loadCategories() {
  try {
    const res = await fetch("/api/categories");
    const categories = await res.json();
    const sel = document.getElementById("category-select");
    for (const c of categories) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error("カテゴリ一覧の取得に失敗しました", e);
  }
}

// アイテムの実効閾値(個別の「適正在庫数」があればそれを優先、無ければ画面上部の共通閾値)。
// 適正在庫数が0のパーツは「在庫0のままでよい」という意味として扱い、常にアラート対象外にする。
function getEffectiveThreshold(item, commonThreshold) {
  return (item.threshold ?? null) !== null ? item.threshold : commonThreshold;
}

function isItemLow(item, commonThreshold) {
  const threshold = getEffectiveThreshold(item, commonThreshold);
  return STORES.some(store => (item.stocks?.[store] ?? 0) < threshold);
}

// 「どれだけ適正在庫を下回っているか」が大きい(マイナスが大きい)ものほど先頭に来るようにする。
function lowestMargin(item, commonThreshold) {
  const threshold = getEffectiveThreshold(item, commonThreshold);
  return Math.min(...STORES.map(store => (item.stocks?.[store] ?? 0) - threshold));
}

function applyInventoryFilter() {
  const category = document.getElementById("category-select").value;
  const keyword = document.getElementById("search-box").value.trim();
  const stockFilter = document.getElementById("stock-filter-select").value;
  const commonThreshold = Number(document.getElementById("threshold-input").value) || 0;
  let list = inventoryCache;
  if (category) list = list.filter(item => item.category === category);
  if (keyword) {
    list = list.filter(item =>
      (item.partNo ?? "").includes(keyword) ||
      (item.partName ?? "").includes(keyword) ||
      (item.barcode ?? "").includes(keyword)
    );
  }
  if (stockFilter === "low") {
    list = list.filter(item => isItemLow(item, commonThreshold));
    list = [...list].sort((a, b) => lowestMargin(a, commonThreshold) - lowestMargin(b, commonThreshold));
  }
  renderInventory(list);
}

function renderInventory(list) {
  const commonThreshold = Number(document.getElementById("threshold-input").value) || 0;
  const container = document.getElementById("inventory-list");
  container.innerHTML = "";

  for (const item of list) {
    const threshold = getEffectiveThreshold(item, commonThreshold);
    const imgSrc = item.imageFileKey ? `/api/image?fileKey=${encodeURIComponent(item.imageFileKey)}` : "";

    const card = document.createElement("div");
    card.className = "inv-card";

    let thresholdTag = "";
    if (item.threshold !== null && item.threshold !== undefined) {
      thresholdTag = item.threshold === 0
        ? `<span class="tag tag-noalert">アラート対象外</span>`
        : `<span class="tag tag-threshold">適正在庫 ${item.threshold}</span>`;
    }

    const total = STORES.reduce((sum, store) => sum + (item.stocks?.[store] ?? 0), 0);

    const storeRows = STORES.map(store => {
      const qty = item.stocks?.[store] ?? 0;
      const isLow = qty < threshold;
      return `<div class="store-stock-row ${isLow ? 'is-low' : ''}" data-barcode="${item.barcode}" data-store="${store}" data-partno="${item.partNo ?? ''}" data-partname="${item.partName ?? ''}">
        <span class="store-name">${store}</span>
        <span class="store-qty-wrap">
          <span class="store-qty">${qty}${isLow ? ' ⚠' : ''}</span>
          <button type="button" class="edit-stock-btn" title="実数を入力して修正">✏️</button>
        </span>
      </div>`;
    }).join("");

    card.innerHTML = `
      ${imgSrc ? `<img src="${imgSrc}" class="inv-thumb" loading="lazy" title="クリックで拡大">` : `<div class="inv-thumb placeholder"></div>`}
      <div class="inv-body">
        <div class="inv-title-row">
          <span class="tag tag-category">${item.category ?? ""}</span>
          ${thresholdTag}
          <span class="inv-total">合計在庫<strong>${total}</strong></span>
        </div>
        <div class="inv-name">${item.partName ?? ""}</div>
        <div class="inv-sub">${item.partNo ?? ""} ・ バーコード:${item.barcode ?? ""}</div>
        <div class="store-stock-list">${storeRows}</div>
        <button type="button" class="add-to-cart-btn">＋ 出庫/入庫の明細に追加</button>
      </div>
    `;

    if (imgSrc) {
      card.querySelector(".inv-thumb").addEventListener("click", () => openImageModal(imgSrc));
    }
    card.querySelector(".add-to-cart-btn").addEventListener("click", () => addItemToCart(item));
    container.appendChild(card);
  }

  container.querySelectorAll(".edit-stock-btn").forEach(btn => {
    btn.addEventListener("click", () => startStockEdit(btn.closest(".store-stock-row")));
  });
}

function startStockEdit(row) {
  const barcode = row.dataset.barcode;
  const store = row.dataset.store;
  const partNo = row.dataset.partno;
  const partName = row.dataset.partname;

  row.querySelector(".store-qty-wrap").innerHTML = `
    <div class="stock-edit-box">
      <input type="number" class="stock-edit-input" placeholder="実数">
      <button type="button" class="stock-save-btn">保存</button>
      <button type="button" class="stock-cancel-btn">取消</button>
    </div>
  `;
  const input = row.querySelector(".stock-edit-input");
  input.focus();

  row.querySelector(".stock-cancel-btn").addEventListener("click", () => loadInventory());

  row.querySelector(".stock-save-btn").addEventListener("click", async () => {
    const actualCount = Number(input.value);
    if (input.value === "" || Number.isNaN(actualCount)) { alert("実数を入力してください"); return; }
    const today = new Date().toISOString().slice(0, 10);
    try {
      const res = await fetch("/api/zaiko-adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode, store, partNo, partName, actualCount, date: today })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "修正に失敗しました");
      alert(`${store}の実数を${json.actual}に修正しました(理論在庫${json.theoretical} → 差異${json.diff}を登録)`);
      loadInventory();
    } catch (e) {
      alert("エラー: " + e.message);
      loadInventory();
    }
  });
}

// カテゴリ・在庫状況のドロップダウンを切り替えたときは、手入力していた検索キーワードが
// 残ったままだと絞り込みがわかりにくくなるため、自動でクリアしてから絞り込み直す。
function clearSearchBoxAndApplyFilter() {
  document.getElementById("search-box").value = "";
  applyInventoryFilter();
}

document.getElementById("reload-btn").addEventListener("click", loadInventory);
document.getElementById("category-select").addEventListener("change", clearSearchBoxAndApplyFilter);
document.getElementById("search-box").addEventListener("input", applyInventoryFilter);
document.getElementById("stock-filter-select").addEventListener("change", clearSearchBoxAndApplyFilter);
document.getElementById("threshold-input").addEventListener("input", applyInventoryFilter);

// ===== スマホ用: 出庫・入庫フォームをボトムシート化(通販アプリのカートのような見た目) =====
// PC幅ではform-colは通常のサイドバー表示のため、これらのクラス切り替えはCSS側で
// 「max-width:960px」のときだけ効くようにしてあり、PC表示には影響しない。
function openFormDrawer() {
  document.getElementById("form-col").classList.add("is-open");
  document.getElementById("form-backdrop").classList.add("is-open");
}
function closeFormDrawer() {
  document.getElementById("form-col").classList.remove("is-open");
  document.getElementById("form-backdrop").classList.remove("is-open");
}
document.getElementById("mobile-cart-open-btn").addEventListener("click", openFormDrawer);
document.getElementById("form-drawer-close-btn").addEventListener("click", closeFormDrawer);
document.getElementById("form-backdrop").addEventListener("click", closeFormDrawer);

// ===== パーツ画像の拡大表示 =====
function openImageModal(src) {
  const modal = document.getElementById("image-modal");
  document.getElementById("image-modal-img").src = src;
  modal.style.display = "flex";
}
function closeImageModal() {
  document.getElementById("image-modal").style.display = "none";
}
document.getElementById("image-modal").addEventListener("click", closeImageModal);

// ===== バーコードスキャナー(カメラ読み取り) =====
// iPhoneのSafariはブラウザ内蔵のBarcodeDetector APIに未対応のため、Android/iPhone両方で動くように
// ZXing(純JSのバーコード解析ライブラリ、/vendor/zxing.min.jsにローカル同梱)でカメラ映像を解析する。
// なお getUserMedia(カメラ)自体はHTTPS(または localhost)接続でないとブラウザ側で許可されない点に注意。
let zxingReader = null;

function getZxingReader() {
  if (!zxingReader) {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.UPC_A,
      ZXing.BarcodeFormat.UPC_E,
      ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.ITF,
      ZXing.BarcodeFormat.CODABAR
    ]);
    zxingReader = new ZXing.BrowserMultiFormatReader(hints);
  }
  return zxingReader;
}

async function openScanner() {
  if (typeof ZXing === "undefined") {
    alert("バーコード読み取りライブラリの読み込みに失敗しました。ページを再読み込みしてください。");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("このページはカメラを使用できません(HTTPS接続が必要です)。");
    return;
  }
  const modal = document.getElementById("scanner-modal");
  const hint = document.getElementById("scanner-hint");
  hint.textContent = "カメラをバーコードにかざしてください";
  modal.style.display = "flex";

  try {
    const reader = getZxingReader();
    await reader.decodeFromConstraints(
      { video: { facingMode: "environment" } },
      "scanner-video",
      (result, err) => {
        if (result) {
          document.getElementById("search-box").value = result.getText();
          applyInventoryFilter();
          closeScanner();
        }
        // NotFoundExceptionは「このフレームには写っていなかった」なだけなので無視して継続する
      }
    );
  } catch (e) {
    alert("カメラを起動できませんでした: " + e.message);
    closeScanner();
  }
}

function closeScanner() {
  document.getElementById("scanner-modal").style.display = "none";
  if (zxingReader) {
    zxingReader.reset();
  }
}

document.getElementById("barcode-scan-btn").addEventListener("click", openScanner);
document.getElementById("scanner-close-btn").addEventListener("click", closeScanner);

// ===== 店舗ドロップダウン(出庫元・入庫先) =====
async function loadStores() {
  try {
    const res = await fetch("/api/stores");
    const stores = await res.json();
    for (const sel of document.querySelectorAll(".store-select")) {
      for (const store of stores) {
        const opt = document.createElement("option");
        opt.value = store;
        opt.textContent = store;
        sel.appendChild(opt);
      }
    }
  } catch (e) {
    console.error("店舗一覧の取得に失敗しました", e);
  }
}

const cart = { reg: [] };

// ===== 明細(カート) =====
function renderCart(target) {
  const tbody = document.getElementById(`${target}-cart-body`);
  tbody.innerHTML = "";
  cart[target].forEach((row, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.partNo}</td>
      <td>${row.partName}</td>
      <td><input type="number" class="cart-qty-input" min="1" value="${row.qty}" data-idx="${idx}"></td>
      <td><button type="button" class="remove-btn" data-idx="${idx}">削除</button></td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById(`${target}-cart-count`).textContent = cart[target].length;
  if (target === "reg") {
    document.getElementById("mobile-cart-text").textContent = `明細 ${cart.reg.length}件`;
  }
  tbody.querySelectorAll(".remove-btn").forEach(b => {
    b.addEventListener("click", () => {
      cart[target].splice(Number(b.dataset.idx), 1);
      renderCart(target);
    });
  });
  tbody.querySelectorAll(".cart-qty-input").forEach(input => {
    input.addEventListener("change", () => {
      const idx = Number(input.dataset.idx);
      const qty = Number(input.value);
      cart[target][idx].qty = (qty > 0) ? qty : 1;
      input.value = cart[target][idx].qty;
    });
  });
}

// 在庫一覧の各カードの「＋ 出庫/入庫の明細に追加」ボタンから、検索し直すことなく直接カートに入れる。
// 数量はひとまず1件で追加し、カート側の数量欄で必要に応じて変更する。
function addItemToCart(item) {
  cart.reg.push({
    barcode: item.barcode,
    partNo: item.partNo,
    partName: item.partName,
    unit: item.unit,
    qty: 1
  });
  renderCart("reg");

  const status = document.getElementById("list-status");
  const prevText = status.textContent;
  status.textContent = `「${item.partName ?? item.partNo}」を明細に追加しました`;
  setTimeout(() => {
    if (status.textContent.startsWith(`「${item.partName ?? item.partNo}」`)) {
      status.textContent = prevText;
    }
  }, 1500);
}

// ===== まとめて登録 =====
function readRegForm() {
  return {
    date: document.getElementById("reg-date").value,
    store: document.getElementById("reg-store").value,
    tantosha: document.getElementById("reg-tantosha").value
  };
}

document.getElementById("reg-shukko-submit-btn").addEventListener("click", async () => {
  const { date, store } = readRegForm();
  const resultEl = document.getElementById("reg-result");
  if (!date || !store) { alert("日付と店舗を入力してください"); return; }
  if (cart.reg.length === 0) { alert("明細を1件以上追加してください"); return; }

  resultEl.textContent = "登録中...";
  resultEl.className = "result";
  try {
    const res = await fetch("/api/shukko", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, from: store, items: cart.reg })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "登録に失敗しました");
    const msg = json.appended
      ? `既存の出庫レコード(番号:${json.id})に${json.rowCount}件まとめて追記しました`
      : `新しい出庫レコード(番号:${json.id})に${json.rowCount}件登録しました`;
    resultEl.textContent = msg;
    resultEl.className = "result ok";
    cart.reg = [];
    renderCart("reg");
    loadInventory();
  } catch (err) {
    resultEl.textContent = "エラー: " + err.message;
    resultEl.className = "result error";
  }
});

document.getElementById("reg-nyuko-submit-btn").addEventListener("click", async () => {
  const { date, store, tantosha } = readRegForm();
  const resultEl = document.getElementById("reg-result");
  if (!date || !store) { alert("日付と店舗を入力してください"); return; }
  if (cart.reg.length === 0) { alert("明細を1件以上追加してください"); return; }

  resultEl.textContent = "登録中...";
  resultEl.className = "result";
  try {
    const res = await fetch("/api/nyuko", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, to: store, tantosha, items: cart.reg })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "登録に失敗しました");
    const msg = json.appended
      ? `既存の入庫レコード(番号:${json.id})に${json.rowCount}件まとめて追記しました`
      : `新しい入庫レコード(番号:${json.id})に${json.rowCount}件登録しました`;
    resultEl.textContent = msg;
    resultEl.className = "result ok";
    cart.reg = [];
    renderCart("reg");
    loadInventory();
  } catch (err) {
    resultEl.textContent = "エラー: " + err.message;
    resultEl.className = "result error";
  }
});

loadInventory();
loadCategories();
loadStores();
