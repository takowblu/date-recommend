# 餐廳推薦地圖

可部署到 GitHub Pages，也可掛載為 LINE LIFF Endpoint URL 的靜態餐廳推薦網站。使用者可以貼上 Google Maps URL 投稿，後端範本使用 Google Apps Script 呼叫 Gemini 2.5 Flash-Lite 產生結構化資料，再寫入 Google Sheet 進行審核管理。

## 架構

完整設計請看 [docs/architecture.md](docs/architecture.md)。

核心路線：

```text
GitHub Pages static site / LIFF endpoint
  -> Apps Script Web App
  -> Gemini structured output
  -> Google Sheets pending rows
  -> approved data published as JSON
```

第一版預設不使用 Google Places API。Google Maps URL 會先做靜態解析；短網址展開可在 Apps Script 用 `ENABLE_URL_RESOLVE=true` 開啟。

## 專案結構

```text
.
├── index.html
├── styles.css
├── app.js
├── config.example.js
├── data/
│   └── restaurants.json
├── backend/
│   └── apps-script/
│       └── Code.gs
└── docs/
    └── architecture.md
```

## 本機預覽

在專案根目錄執行：

```powershell
python -m http.server 4173
```

然後打開：

```text
http://localhost:4173/
```

如果只要看畫面，也可以直接開 `index.html`，但用本機伺服器比較接近 GitHub Pages。

## 前端設定

複製設定檔：

```powershell
Copy-Item config.example.js config.js
```

修改 `config.js`：

```js
window.RESTAURANT_RECS_CONFIG = {
  dataUrl: "data/restaurants.json",
  submitEndpoint: "YOUR_APPS_SCRIPT_WEB_APP_URL",
  mapsEmbedApiKey: "",
  liffId: "",
  requireLiffLogin: false,
  enableDemoSubmit: false
};
```

`mapsEmbedApiKey` 可留空。留空時前端使用 `maps.google.com?q=...&output=embed` 的基本 iframe。

## LIFF 掛載

1. 先完成 GitHub Pages 部署，取得 HTTPS 網址。
2. 到 LINE Developers 建立 LIFF app。
3. Endpoint URL 填入 GitHub Pages 網址，例如：

```text
https://你的帳號.github.io/你的repo/
```

4. 將 LIFF ID 填入 `config.js`：

```js
window.RESTAURANT_RECS_CONFIG = {
  dataUrl: "data/restaurants.json",
  submitEndpoint: "YOUR_APPS_SCRIPT_WEB_APP_URL",
  mapsEmbedApiKey: "",
  liffId: "YOUR_LIFF_ID",
  requireLiffLogin: false,
  enableDemoSubmit: false
};
```

`requireLiffLogin=false` 時，使用者不必登入也能投稿。若改成 `true`，前端會要求 LIFF login，投稿 payload 會帶 `lineUserId` 與 `lineDisplayName`。

## Apps Script 部署

1. 建立 Google Sheet。
2. 到 [script.google.com](https://script.google.com/) 建立 Apps Script。
3. 貼上 `backend/apps-script/Code.gs`。
4. 在 Apps Script 的 Script Properties 設定：

```text
GEMINI_API_KEY=你的 Gemini API key
SPREADSHEET_ID=Google Sheet ID
ENABLE_URL_RESOLVE=false
```

若要允許展開 `maps.app.goo.gl` 短網址：

```text
ENABLE_URL_RESOLVE=true
```

5. 部署為 Web App。
6. 將 Web App URL 填入 `config.js` 的 `submitEndpoint`。

## Google Sheet 審核

Apps Script 會寫入 `submissions` 工作表，預設 `review_status=pending`。

建議流程：

1. 人工檢查 `needs_review` 與 `review_notes`。
2. 修正店名、地區、地址、標籤。
3. 將可公開資料改成 `approved`。
4. 匯出或同步到 `data/restaurants.json`。

## GitHub Pages

把這個資料夾推到 GitHub repo 後：

1. Repository Settings。
2. Pages。
3. Source 選 `Deploy from a branch`。
4. Branch 選 `main` 與 root。
5. 等 GitHub Pages 完成部署。

## 安全注意

- 不要把 Gemini API key 放在 `config.js` 或任何前端檔案。
- Apps Script Web App 若公開給任何人呼叫，請保留 honeypot 欄位並考慮加上更嚴格限流。
- 未審核投稿不要直接公開到前端。
- Gemini 輸出是輔助整理，不應視為已驗證事實。

