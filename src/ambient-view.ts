const pageNames = ['いまの空気', '時計', '7日間の推移'];
function navigation(active: number) {
  return `<nav class="ambient-nav" aria-label="表示画面">${pageNames.map((name, page) => `<button data-page="${page}" aria-label="${name}" aria-current="${active === page ? 'page' : 'false'}"><span></span></button>`).join('')}<button class="manage-button" data-manage-screen aria-label="照明・設定を開く">照明・設定</button></nav>`;
}

export const ambientView = `
<main class="ambient" aria-label="おうちの空気">
  <div class="ambient-track">
    <section class="ambient-page current-page" aria-label="いまの空気">
      <header class="ambient-heading"><div><p class="eyebrow">HOME / ENVIRONMENT</p><h1>いまの空気</h1></div><div class="ambient-small-clock"><time data-clock>--:--</time><span data-date></span></div></header>
      <div id="sensors" class="ambient-sensors"><div class="ambient-empty">センサーに接続しています…</div></div>
      <div class="ambient-bottom"><p id="summary">センサーを確認しています</p>${navigation(0)}</div>
      <p class="ambient-notice" data-notice role="status"></p>
    </section>
    <section class="ambient-page clock-page" aria-label="時計" inert>
      <div class="clock-face"><p data-date></p><time data-clock>--:--</time><p class="clock-caption">おうちの空気</p></div>
      <div class="ambient-bottom">${navigation(1)}<div class="compact-readings" data-compact></div></div>
      <p class="ambient-notice" data-notice role="status"></p>
    </section>
    <section class="ambient-page trends-page" aria-label="7日間の推移" inert>
      <header class="ambient-heading"><div><p class="eyebrow">A WEEK AT HOME</p><h1>空気のうつろい</h1></div><span class="trend-period">直近7日間</span></header>
      <div id="ambient-trends" class="ambient-trends"><div class="ambient-empty">記録を集めています…</div></div>
      <div class="ambient-bottom"><div class="compact-readings" data-compact></div>${navigation(2)}</div>
      <p class="ambient-notice" data-notice role="status"></p>
    </section>
  </div>
</main>
<dialog id="management" aria-labelledby="management-title">
  <div class="detail-head"><div><p class="eyebrow">HOME / CONTROLS</p><h2 id="management-title">照明・設定</h2></div><button data-close-management aria-label="閉じる">✕</button></div>
  <section class="management-sensors"><h3>センサー</h3><div id="sensor-health"></div><div id="battery-alerts"></div><div id="registration-actions"></div></section>
  <section><h3>推移画面のグラフ</h3><div class="graph-options" role="group" aria-label="表示するグラフ"><label><input type="checkbox" data-show="temperature" checked>温度</label><label><input type="checkbox" data-show="humidity" checked>湿度</label><label><input type="checkbox" data-show="co2" checked>CO₂</label></div></section>
  <div id="hue-controls"></div>
  <footer><div id="connection">接続を確認しています</div><div class="footer-actions"><span id="refresh"></span><button id="fullscreen" aria-label="全画面表示">⛶ 全画面</button></div></footer>
  <p class="management-note">現在値30分 → 時計20秒 → 推移20秒。0:00〜7:00は暗い配色になります（日本時間）。環境光に応じた輝度調整はiPadの「明るさの自動調節」を有効にしてください。</p>
</dialog>
<dialog id="detail" aria-labelledby="detail-name">
  <div class="detail-head"><div><p class="eyebrow">HISTORY / 記録</p><h2 id="detail-name"></h2></div><button id="close" aria-label="閉じる">✕</button></div>
  <div class="detail-controls"><div id="periods" class="segmented"><button data-days="1" class="active">24時間</button><button data-days="7">7日</button><button data-days="30">30日</button><button data-days="365">1年</button></div><div id="metrics" class="graph-options detail-options" role="group" aria-label="履歴に表示するグラフ"><label><input type="checkbox" data-detail-metric="temperature">温度</label><label><input type="checkbox" data-detail-metric="humidity">湿度</label><label><input type="checkbox" data-detail-metric="co2">CO₂</label></div></div>
  <div id="plot"></div><p id="history-message"></p>
</dialog>`;
