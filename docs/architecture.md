# 餐廳推薦靜態網站架構

## 目標

打造一個可部署於 GitHub Pages，並可掛載為 LINE LIFF Endpoint URL 的餐廳推薦網站，讓使用者可以：

- 貼上 Google Maps URL 推薦餐廳。
- 補充推薦理由與人工線索。
- 瀏覽已審核餐廳。
- 以地區為主要入口，搭配多標籤篩選。
- 使用 Google 地圖快速查看餐廳位置。

第一版的核心原則是「不依賴 Google Places API」。Google Places API 只保留為未來可選補強，不作為 MVP 必要條件。

## 系統邊界

```text
GitHub Pages static site / LIFF endpoint
  - browse restaurants
  - submit Google Maps URL
  - filter by district and tags
  - render map iframe
  - optionally initialize LIFF SDK

Google Apps Script Web App
  - receive submissions
  - optionally expand short URLs
  - call Gemini API with structured output
  - write rows to Google Sheets

Google Sheets
  - source of truth for submissions
  - manual review workflow
  - approved records can be exported or published as JSON
```

## 非目標

- 第一版不建立會員系統。
- 第一版不直接公開未審核投稿。
- 第一版不把 Gemini API key 或任何後端密鑰放在前端。
- 第一版不要求 Google Places API 或 Maps billing。
- 第一版不即時同步 Google Sheet 到前端，先以靜態 JSON 或 Apps Script JSON endpoint 為資料來源。

## 資料流程

### 投稿流程

```text
User
  -> open GitHub Pages or LIFF
  -> paste Google Maps URL
  -> add recommendation note and optional manual fields
  -> static site POST / Apps Script Web App
  -> Apps Script validates input
  -> Apps Script expands maps.app.goo.gl if allowed
  -> Apps Script asks Gemini for structured restaurant profile
  -> Apps Script writes pending row to Google Sheets
  -> editor reviews row
  -> approved records are published to data/restaurants.json or JSON endpoint
```

### 瀏覽流程

```text
Static site
  -> load data/restaurants.json by default
  -> optionally load published Apps Script JSON endpoint
  -> build district filters
  -> build tag filters
  -> render cards
  -> render selected restaurant map iframe
```

## LIFF 與 RWD

同一份前端必須同時支援一般瀏覽器與 LINE LIFF。

### LIFF 掛載方式

- GitHub Pages 網址可直接設定為 LINE Developers 的 LIFF Endpoint URL。
- `config.js` 提供 `liffId`，有值時才初始化 LIFF SDK。
- `requireLiffLogin=false` 時不強制登入，適合低摩擦投稿。
- `requireLiffLogin=true` 時可取得 LINE profile，並帶入投稿 payload。
- 投稿 payload 會包含 `clientContext.channel`、`inLineClient`、`lineUserId`、`lineDisplayName`。

### RWD 原則

- 桌面版使用篩選、清單、地圖三欄。
- 平板版地圖移到下方。
- 手機版順序為篩選、地圖、清單。
- 控制項最小高度 44px，方便 LINE 內建瀏覽器觸控。
- 使用 `env(safe-area-inset-*)` 避免被手機瀏海與系統列遮擋。
- 不依賴 hover 操作。
- 投稿 dialog 寬度限制在 viewport 內。

## Google Maps URL 靜態分析策略

### 支援來源

- 完整 Google Maps URL，例如 `https://www.google.com/maps/place/...`
- 搜尋 URL，例如 `https://www.google.com/maps/search/...`
- 短網址，例如 `https://maps.app.goo.gl/...`

### 靜態可萃取資訊

完整 URL 可能包含：

- 店名 path segment。
- 座標片段，例如 `@25.033,121.565,17z`。
- query 參數。
- place 或 search path。

短網址通常無法只靠字串知道店名與座標。Apps Script 可用 `UrlFetchApp` follow redirect 取得展開後 URL；這不是 Places API，不需要 Maps billing，但仍是一次網路請求。

若短網址成功展開，後端會重新對展開後 URL 執行靜態解析，並優先使用展開後取得的店名候選與座標候選。

### 風險

- Google Maps URL 格式可能改變。
- 短網址展開可能被限制或失敗。
- URL 本身不一定含評論、評分、價格、停車資訊。
- 因此 Gemini 結果必須包含 confidence 與 `needs_review`。

## Gemini 結構化任務

Gemini 不負責憑空查資料。它只根據以下輸入推論：

- 原始 Google Maps URL。
- 展開後 URL，如有。
- 使用者推薦理由。
- 使用者選填店名、地區、價格或情境。
- URL 靜態解析出的店名候選、座標候選、地址候選。

模型輸出應符合 JSON Schema，包含：

- 基本資訊：店名、地區、地址、座標。
- 飲食資訊：料理類型、風格、口味。
- 使用情境：約會、家庭、商務、朋友聚餐、單人、宵夜等。
- 營運與便利：停車、價格、排隊、訂位線索。
- 特色：招牌、環境、服務、氣氛。
- 風險：低評分要素、可能踩雷點。
- 信心分數：名稱、地點、標籤、價格。
- 審核建議：`needs_review` 與原因。

價格欄位 `price_level` 在 Gemini schema 中使用 `unknown`、`$`、`$$`、`$$$`、`$$$$`。寫入 Google Sheet 時，後端會把 `unknown` 正規化為空白，方便人工審核。

後端寫入 Sheet 前會再清理模型輸出：

- 文字欄位中的 `unknown`、`未知`、`不確定` 會轉成空白。
- 陣列欄位中的 `unknown` 會被濾掉。
- `latitude=0` 或 `longitude=0` 不會被視為有效座標。
- 使用者手填欄位與 URL 靜態解析候選會作為 fallback。

## Google Sheet 欄位

| 欄位 | 用途 |
| --- | --- |
| id | 穩定 ID |
| created_at | 投稿時間 |
| review_status | pending / approved / rejected |
| source_mode | static_url / resolved_url / manual / places_api |
| original_url | 使用者貼上的 URL |
| resolved_url | 展開後 URL |
| submitter_name | 投稿者暱稱 |
| user_note | 推薦理由 |
| client_context | LIFF 或 Web 來源資訊 |
| name | 餐廳名稱 |
| district | 主要地區 |
| address | 地址 |
| latitude | 緯度 |
| longitude | 經度 |
| rating | 評分，可空 |
| price_level | 價格帶 |
| cuisine_tags | 料理標籤 |
| taste_tags | 口味標籤 |
| vibe_tags | 風格標籤 |
| occasion_tags | 聚會類型 |
| parking | 停車資訊 |
| features | 特色 |
| negative_signals | 低評分要素 |
| confidence_name | 店名信心 |
| confidence_location | 地點信心 |
| confidence_tags | 標籤信心 |
| needs_review | 是否需人工審核 |
| review_notes | 審核原因 |
| ai_raw_json | Gemini 原始 JSON |

## 前端資訊架構

第一屏直接是產品主功能：

- 頁首：產品名稱、投稿按鈕、資料狀態、LIFF 狀態。
- 篩選列：地區主篩選、搜尋、價格、停車、多標籤。
- 主視圖：餐廳清單與地圖。
- 詳細資訊：選中餐廳後顯示特色、風險、推薦理由、地圖連結。
- 投稿面板：Google Maps URL、推薦理由、選填店名/地區/價格/情境。

## 部署策略

### GitHub Pages

- 使用無 build step 的 `index.html`、`styles.css`、`app.js`。
- 靜態資料放在 `data/restaurants.json`。
- 設定檔放在 `config.example.js`，使用者複製為 `config.js`。
- 若作為 LIFF endpoint，GitHub Pages URL 必須使用 HTTPS。

### Apps Script

- `backend/apps-script/Code.gs` 提供 Web App 程式。
- API key 存在 Script Properties，不寫入 Git。
- Web App 部署為 Anyone 可存取時，必須加上 honeypot、簡單限流與欄位驗證。

## 開發順序

1. 建立架構文件與資料欄位契約。
2. 建立靜態前端瀏覽與投稿 UI。
3. 加入 LIFF 初始化與 RWD 安全區域。
4. 建立範例資料與本機 fallback。
5. 建立 Apps Script 後端範本。
6. 補 README 部署步驟。
7. 本機以靜態伺服器驗證。
