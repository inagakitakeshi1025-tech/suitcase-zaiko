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

// アイテムの店舗別・実効閾値。
// ・スーツケース救急車: 個別の「適正在庫数」があればそれを優先、無ければ画面上部の共通閾値。
// ・豊田倉庫: 個別の「適正在庫数_豊田用」があればそれを使い、未設定なら常にアラート対象外(共通閾値は使わない)。
// どちらも閾値が0のパーツは「在庫0のままでよい」という意味として扱い、常にアラート対象外にする。
function getEffectiveThreshold(item, store, commonThreshold) {
  const t = item.threshold?.[store] ?? null;
  if (t !== null) return t;
  return store === "豊田倉庫" ? null : commonThreshold;
}

// 閾値がnull(アラート対象外)の店舗は常にfalse。
function isStoreLow(item, store, commonThreshold) {
  const threshold = getEffectiveThreshold(item, store, commonThreshold);
  if (threshold === null) return false;
  return (item.stocks?.[store] ?? 0) < threshold;
}

function isItemLow(item, commonThreshold) {
  return STORES.some(store => isStoreLow(item, store, commonThreshold));
}

// 指定した店舗「だけ」が閾値割れで、他の店舗はすべて正常なアイテムかどうか。
function isOnlyStoreLow(item, targetStore, commonThreshold) {
  return STORES.every(store =>
    store === targetStore ? isStoreLow(item, store, commonThreshold) : !isStoreLow(item, store, commonThreshold)
  );
}

// 在庫数-閾値。閾値がnull(アラート対象外)の店舗はソート順の末尾に回るようInfinityを返す。
function storeMargin(item, store, commonThreshold) {
  const threshold = getEffectiveThreshold(item, store, commonThreshold);
  if (threshold === null) return Infinity;
  return (item.stocks?.[store] ?? 0) - threshold;
}

// 「どれだけ適正在庫を下回っているか」が大きい(マイナスが大きい)ものほど先頭に来るようにする。
function lowestMargin(item, commonThreshold) {
  return Math.min(...STORES.map(store => storeMargin(item, store, commonThreshold)));
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
  } else if (stockFilter === "low-store") {
    list = list.filter(item => isOnlyStoreLow(item, "スーツケース救急車", commonThreshold));
    list = [...list].sort((a, b) => storeMargin(a, "スーツケース救急車", commonThreshold) - storeMargin(b, "スーツケース救急車", commonThreshold));
  } else if (stockFilter === "low-toyota") {
    list = list.filter(item => isOnlyStoreLow(item, "豊田倉庫", commonThreshold));
    list = [...list].sort((a, b) => storeMargin(a, "豊田倉庫", commonThreshold) - storeMargin(b, "豊田倉庫", commonThreshold));
  }
  renderInventory(list);
}

function renderInventory(list) {
  const commonThreshold = Number(document.getElementById("threshold-input").value) || 0;
  const container = document.getElementById("inventory-list");
  container.innerHTML = "";

  for (const item of list) {
    const imgSrc = item.imageFileKey ? `/api/image?fileKey=${encodeURIComponent(item.imageFileKey)}` : "";

    const card = document.createElement("div");
    card.className = "inv-card";

    const total = STORES.reduce((sum, store) => sum + (item.stocks?.[store] ?? 0), 0);

    const storeRows = STORES.map(store => {
      const threshold = getEffectiveThreshold(item, store, commonThreshold);
      const qty = item.stocks?.[store] ?? 0;
      const isLow = threshold !== null && qty < threshold;
      const thresholdText = threshold !== null ? `適正在庫 ${threshold}` : "アラート対象外";
      return `<div class="store-stock-row ${isLow ? 'is-low' : ''}" data-barcode="${item.barcode}" data-store="${store}" data-partno="${item.partNo ?? ''}" data-partname="${item.partName ?? ''}">
        <span class="store-name">${store}<span class="store-threshold">${thresholdText}</span></span>
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
          <span class="inv-total">合計在庫<strong>${total}</strong></span>
        </div>
        <div class="inv-name">${item.partName ?? ""}</div>
        <div class="inv-sub">${item.partNo ?? ""} ・ バーコード:${item.barcode ?? ""}${item.unit ? ` ・ 単位:${item.unit}` : ""}</div>
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
      <td>${row.unit ?? ""}</td>
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

// ===== 提携店からの依頼(パーツ購入依頼)処理 =====
let requestsCache = [];
let requestsLoaded = false;

function switchTab(tab) {
  const isRequests = tab === "requests";
  document.getElementById("list-col").style.display = isRequests ? "none" : "";
  document.getElementById("requests-col").style.display = isRequests ? "" : "none";
  document.getElementById("tab-inventory-btn").classList.toggle("is-active", !isRequests);
  document.getElementById("tab-requests-btn").classList.toggle("is-active", isRequests);
  if (isRequests && !requestsLoaded) loadRequests();
}
document.getElementById("tab-inventory-btn").addEventListener("click", () => switchTab("inventory"));
document.getElementById("tab-requests-btn").addEventListener("click", () => switchTab("requests"));

async function loadRequests() {
  const status = document.getElementById("requests-status");
  status.textContent = "読み込み中...";
  try {
    const res = await fetch("/api/requests");
    if (!res.ok) throw new Error((await res.json()).error || "取得に失敗しました");
    requestsCache = await res.json();
    requestsLoaded = true;
    renderRequests();
    status.textContent = `${requestsCache.length}件`;
    const badge = document.getElementById("requests-badge");
    if (requestsCache.length > 0) {
      badge.textContent = requestsCache.length;
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  } catch (e) {
    status.textContent = "読み込みに失敗しました: " + e.message;
  }
}
document.getElementById("requests-reload-btn").addEventListener("click", loadRequests);

// バーコードから在庫アプリ側の在庫数(店舗別)を引く。見つからなければ0扱い。
function lookupStock(barcode, store) {
  if (!barcode) return null;
  const item = inventoryCache.find((i) => i.barcode === barcode);
  if (!item) return null;
  return item.stocks?.[store] ?? 0;
}

// 依頼明細1行ぶんの出庫元・出庫数の初期値を決める。店舗に在庫があれば店舗優先、無ければ豊田倉庫、
// どちらにも在庫が無ければ店舗を仮選択して出庫数0にする(担当者が手動で判断できるよう画面には警告を出す)。
// 依頼数より在庫が少ない場合は、ある分だけ出庫し、残りは「不足分」として自動計算される。
function suggestShipment(barcode, qty) {
  const storeStock = lookupStock(barcode, STORES[0]);
  if (storeStock !== null && storeStock > 0) return { store: STORES[0], qty: Math.min(storeStock, qty) };
  const toyotaStock = lookupStock(barcode, STORES[1]);
  if (toyotaStock !== null && toyotaStock > 0) return { store: STORES[1], qty: Math.min(toyotaStock, qty) };
  return { store: STORES[0], qty: 0 };
}

function renderRequests() {
  const container = document.getElementById("requests-list");
  container.innerHTML = "";

  if (requestsCache.length === 0) {
    container.innerHTML = `<p class="hint">現在、対応待ちの依頼はありません。</p>`;
    return;
  }

  requestsCache.forEach((request, reqIdx) => {
    const card = document.createElement("div");
    card.className = "request-card";
    const totalCount = request.items.length + request.otherItems.length;
    card.innerHTML = `
      <div class="request-card-header">
        <span class="tag tag-category">${request.sourceLabel}</span>
        <span class="request-date">${request.date}</span>
        <span class="request-store-name">${request.storeName ?? ""}</span>
        <span class="request-count">明細${totalCount}件</span>
        <button type="button" class="request-toggle-btn">詳細を開く</button>
      </div>
      <div class="request-detail" style="display:none;"></div>
    `;
    const toggleBtn = card.querySelector(".request-toggle-btn");
    const detailEl = card.querySelector(".request-detail");
    toggleBtn.addEventListener("click", () => {
      const opening = detailEl.style.display === "none";
      detailEl.style.display = opening ? "" : "none";
      toggleBtn.textContent = opening ? "詳細を閉じる" : "詳細を開く";
      if (opening && detailEl.innerHTML === "") renderRequestDetail(request, reqIdx, detailEl);
    });
    container.appendChild(card);
  });
}

function renderRequestDetail(request, reqIdx, detailEl) {
  const itemRows = request.items.map((item, itemIdx) => {
    const storeStock = lookupStock(item.barcode, STORES[0]);
    const toyotaStock = lookupStock(item.barcode, STORES[1]);
    const suggested = suggestShipment(item.barcode, item.qty);
    const shortage = (storeStock !== null ? storeStock : 0) < item.qty && (toyotaStock !== null ? toyotaStock : 0) < item.qty;
    return `
      <tr class="${shortage ? 'is-shortage' : ''}" data-kind="item" data-req="${reqIdx}" data-idx="${itemIdx}">
        <td>${item.partNo}</td>
        <td>${item.partName}</td>
        <td>${item.qty}</td>
        <td>${item.unit ?? ""}</td>
        <td>${item.barcode ? (storeStock ?? '?') : '突合不可'}</td>
        <td>${item.barcode ? (toyotaStock ?? '?') : '突合不可'}</td>
        <td>
          <select class="ship-store-select">
            <option value="">出庫しない</option>
            <option value="${STORES[0]}" ${suggested.store === STORES[0] ? 'selected' : ''}>${STORES[0]}</option>
            <option value="${STORES[1]}" ${suggested.store === STORES[1] ? 'selected' : ''}>${STORES[1]}</option>
          </select>
        </td>
        <td>
          <input type="number" class="ship-qty-input" value="${suggested.qty}" min="0" max="${item.qty}">
          <span class="ship-qty-of">/ ${item.qty}</span>
          ${shortage ? '<div class="shortage-warn">⚠ 両店とも不足</div>' : ''}
        </td>
      </tr>`;
  }).join("");

  const otherRows = request.otherItems.map((item, itemIdx) => `
    <tr data-kind="other" data-req="${reqIdx}" data-idx="${itemIdx}">
      <td><input type="text" class="manual-partno-input" placeholder="(任意)パーツ番号"></td>
      <td>${item.partName}${item.color ? `(${item.color})` : ''}</td>
      <td>${item.qty}</td>
      <td>-</td>
      <td>手入力</td>
      <td>手入力</td>
      <td>
        <select class="ship-store-select">
          <option value="">出庫しない</option>
          <option value="${STORES[0]}">${STORES[0]}</option>
          <option value="${STORES[1]}">${STORES[1]}</option>
        </select>
      </td>
      <td>${item.qty}(全量固定)</td>
    </tr>`).join("");

  detailEl.innerHTML = `
    <div class="request-table-wrap">
      <table class="request-table">
        <thead><tr><th>パーツ番号</th><th>パーツ名</th><th>依頼数</th><th>単位</th><th>${STORES[0]}在庫</th><th>${STORES[1]}在庫</th><th>出庫元</th><th>今回の出庫数</th></tr></thead>
        <tbody>${itemRows}${otherRows}</tbody>
      </table>
    </div>
    <p class="hint">今回の出庫数を依頼数より少なくすると、差分は「不足分」として新しい依頼レコードを自動作成します(発送日はこの登録日、店舗名などは元の依頼を引き継ぎます)。${request.otherItems.length > 0 ? '「その他」の明細はパーツマスタに無い特注品のため、パーツ番号は分かる範囲で手入力してください(空欄でも登録できます。不足分の自動作成はされないため、全量出庫できない場合は別途手動で対応してください)。' : ''}</p>
    <button type="button" class="submit-btn request-fulfill-btn">この内容で出庫登録する</button>
    <p class="result request-fulfill-result"></p>
  `;

  detailEl.querySelector(".request-fulfill-btn").addEventListener("click", () => fulfillRequest(request, detailEl));
}

async function fulfillRequest(request, detailEl) {
  const resultEl = detailEl.querySelector(".request-fulfill-result");
  const shipmentsByStore = {};
  const shortages = [];
  // 出庫元(店舗/豊田倉庫)には関係なく、「今回実際に出庫する分」をまとめて納品書/請求書PDFの明細にする。
  const documentItems = [];
  const documentOtherItems = [];

  detailEl.querySelectorAll("tr[data-kind]").forEach((row) => {
    const store = row.querySelector(".ship-store-select").value;
    const kind = row.dataset.kind;
    const idx = Number(row.dataset.idx);

    if (kind === "item") {
      const src = request.items[idx];
      const qtyInput = row.querySelector(".ship-qty-input");
      const actualQty = store ? Math.min(Math.max(Number(qtyInput.value) || 0, 0), src.qty) : 0;
      if (actualQty > 0) {
        if (!shipmentsByStore[store]) shipmentsByStore[store] = [];
        shipmentsByStore[store].push({ barcode: src.barcode, partNo: src.partNo, partName: src.partName, unit: src.unit, qty: actualQty });
        documentItems.push({ partNo: src.partNo, partName: src.partName, price: src.price, minuteCode: src.minuteCode, qty: actualQty });
      }
      const shortageQty = src.qty - actualQty;
      if (shortageQty > 0) shortages.push({ barcode: src.barcode, partNo: src.partNo, partName: src.partName, unit: src.unit, qty: shortageQty, price: src.price });
    } else {
      if (!store) return;
      const src = request.otherItems[idx];
      const manualPartNo = row.querySelector(".manual-partno-input").value.trim();
      if (!shipmentsByStore[store]) shipmentsByStore[store] = [];
      shipmentsByStore[store].push({ barcode: "", partNo: manualPartNo, partName: src.partName + (src.color ? `(${src.color})` : ""), unit: "", qty: src.qty });
      documentOtherItems.push({ partName: src.partName, color: src.color, price: src.price, qty: src.qty });
    }
  });

  const shipments = Object.keys(shipmentsByStore).map((store) => ({ store, items: shipmentsByStore[store] }));
  if (shipments.length === 0) {
    alert("出庫元が選択された明細がありません");
    return;
  }

  resultEl.textContent = "登録中...";
  resultEl.className = "result";
  try {
    const res = await fetch("/api/requests/fulfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: request.source,
        recordId: request.recordId,
        date: new Date().toISOString().slice(0, 10),
        shipments,
        shortageItems: shortages,
        documentItems,
        documentOtherItems,
        requestStoreName: request.storeName,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "登録に失敗しました");
    const docLabel = request.source === "IRAI_MINUTE" ? "請求書" : "納品書";
    resultEl.textContent = shortages.length > 0
      ? "出庫登録が完了しました(不足分は新しい依頼として作成しました)"
      : "出庫登録が完了しました";
    resultEl.className = "result ok";
    if (json.pdfBase64) {
      const byteChars = atob(json.pdfBase64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);
      const actions = document.createElement("div");
      actions.className = "pdf-actions";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = `${docLabel}を開く(印刷・保存)`;
      openBtn.addEventListener("click", () => window.open(blobUrl, "_blank"));
      const downloadLink = document.createElement("a");
      downloadLink.href = blobUrl;
      downloadLink.download = json.pdfFilename || `${docLabel}.pdf`;
      downloadLink.textContent = `${docLabel}をPCにダウンロード`;
      downloadLink.className = "pdf-download-link";
      actions.appendChild(openBtn);
      actions.appendChild(downloadLink);
      resultEl.after(actions);
    }
    loadInventory();
    setTimeout(loadRequests, 1000);
  } catch (e) {
    resultEl.textContent = "エラー: " + e.message;
    resultEl.className = "result error";
  }
}

loadInventory();
loadCategories();
loadStores();
