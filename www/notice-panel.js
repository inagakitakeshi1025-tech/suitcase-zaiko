/* お知らせ(更新点)パネル。#noticePanel があるページで動く。
 * 内容は /api/notices (knowledge/お知らせ.md 由来)。既読は localStorage に持つ。
 * 未読があれば開いた状態、すべて確認済みなら細いバーに畳む。 */
(function () {
  var mount = document.getElementById('noticePanel');
  if (!mount) return;

  var SEEN_KEY = 'zaiko_notice_seen';
  function getSeen() {
    try { return localStorage.getItem(SEEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setSeen(v) {
    try { localStorage.setItem(SEEN_KEY, v); } catch (e) { /* プライベートモード等 */ }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 本文: 「- 」始まりの行は箇条書き、それ以外の非空行は段落にする。
  function bodyHtml(body) {
    var lines = String(body || '').split('\n');
    var out = [];
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (/^[-・]\s*/.test(ln)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + esc(ln.replace(/^[-・]\s*/, '')) + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        if (ln) out.push('<p>' + esc(ln) + '</p>');
      }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  // 色はこのアプリの配色(style.cssの:rootで定義されたCSS変数)に合わせている。
  // 変数が読めない場合のフォールバック値も併記してある。
  var STYLE = [
    '#noticePanel{font-family:"Segoe UI","Hiragino Kaku Gothic ProN",Meiryo,sans-serif;margin:0;}',
    '#noticePanel .np-box{border:1px solid var(--border,#ece4d2);background:var(--tag-bg,#f1ece0);border-radius:8px;overflow:hidden;}',
    '#noticePanel .np-box.np-unread{border-color:var(--accent,#159089);box-shadow:0 1px 4px rgba(21,144,137,.15);}',
    '#noticePanel .np-head{display:flex;align-items:center;gap:8px;width:100%;text-align:left;',
    'background:none;border:0;cursor:pointer;padding:9px 12px;font-size:13px;color:var(--accent-dark,#0d6b65);font-weight:bold;}',
    '#noticePanel .np-head .np-caret{margin-left:auto;transition:transform .15s;font-size:11px;}',
    '#noticePanel .np-box.np-open .np-head .np-caret{transform:rotate(90deg);}',
    '#noticePanel .np-badge{background:var(--accent-dark,#0d6b65);color:#fff;border-radius:10px;font-size:11px;padding:1px 7px;font-weight:bold;}',
    '#noticePanel .np-body{display:none;padding:2px 12px 12px;}',
    '#noticePanel .np-box.np-open .np-body{display:block;}',
    '#noticePanel .np-item{border-top:1px solid var(--border,#ece4d2);padding:9px 0;}',
    '#noticePanel .np-item:first-child{border-top:0;}',
    '#noticePanel .np-date{font-size:11px;color:var(--muted,#8b8477);}',
    '#noticePanel .np-title{font-size:13px;font-weight:bold;color:var(--text,#2d2a24);margin:1px 0 3px;}',
    '#noticePanel .np-item p{margin:3px 0;font-size:12.5px;color:var(--text,#2d2a24);line-height:1.6;}',
    '#noticePanel .np-item ul{margin:3px 0;padding-left:1.2em;}',
    '#noticePanel .np-item li{font-size:12.5px;color:var(--text,#2d2a24);line-height:1.6;}',
    '#noticePanel .np-dismiss{margin-top:8px;border:1px solid var(--border,#ece4d2);background:#fff;color:var(--muted,#8b8477);',
    'border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;}',
  ].join('');

  function render(notices) {
    if (!notices.length) { mount.innerHTML = ''; return; }
    var latestId = notices[0].id;
    var unread = getSeen() !== latestId;

    var items = notices.map(function (n) {
      return '<div class="np-item">' +
        (n.date ? '<div class="np-date">' + esc(n.date) + '</div>' : '') +
        '<div class="np-title">' + esc(n.title) + '</div>' +
        bodyHtml(n.body) +
        '</div>';
    }).join('');

    mount.innerHTML =
      '<style>' + STYLE + '</style>' +
      '<div class="np-box' + (unread ? ' np-unread np-open' : '') + '" id="npBox">' +
        '<button type="button" class="np-head" id="npHead">' +
          '<span>📣 お知らせ</span>' +
          (unread ? '<span class="np-badge">新着</span>' : '<span class="np-badge" style="background:var(--muted,#8b8477)">' + notices.length + '</span>') +
          '<span class="np-caret">▶</span>' +
        '</button>' +
        '<div class="np-body">' + items +
          '<button type="button" class="np-dismiss" id="npDismiss">確認した（閉じる）</button>' +
        '</div>' +
      '</div>';

    var box = document.getElementById('npBox');
    document.getElementById('npHead').addEventListener('click', function () {
      box.classList.toggle('np-open');
    });
    document.getElementById('npDismiss').addEventListener('click', function () {
      setSeen(latestId);
      box.classList.remove('np-open', 'np-unread');
      box.querySelector('.np-badge').style.background = 'var(--muted,#8b8477)';
      box.querySelector('.np-badge').textContent = String(notices.length);
    });
  }

  fetch('/api/notices')
    .then(function (r) { return r.json(); })
    .then(function (d) { render((d && d.notices) || []); })
    .catch(function () { mount.innerHTML = ''; });
})();
