const SHEET_NAME = "submissions";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

function doPost(e) {
  try {
    const payload = parseRequest_(e);
    validateSubmission_(payload);

    if (payload.website) {
      return json_({ ok: true, ignored: true });
    }

    const originalUrlFacts = analyzeMapsUrl_(payload.mapsUrl);
    const resolvedUrl = maybeResolveUrl_(payload.mapsUrl);
    const urlFacts = resolvedUrl
      ? mergeUrlFacts_(originalUrlFacts, analyzeMapsUrl_(resolvedUrl))
      : originalUrlFacts;
    const profile = extractRestaurantProfile_(payload, urlFacts, resolvedUrl);
    const row = buildSheetRow_(payload, urlFacts, resolvedUrl, profile);

    appendRow_(row);
    return json_({ ok: true, id: row.id, reviewStatus: row.review_status, needsReview: row.needs_review });
  } catch (error) {
    return json_({ ok: false, error: error.message }, 400);
  }
}

function doGet() {
  return json_({
    ok: true,
    service: "restaurant-recommendation-submissions",
    mode: "static-url-first"
  });
}

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("Missing request body.");
  }
  return JSON.parse(e.postData.contents);
}

function validateSubmission_(payload) {
  if (!payload.mapsUrl || !/^https?:\/\/[^ ]+/i.test(payload.mapsUrl)) {
    throw new Error("Google Maps URL is required.");
  }
  if (!/google\.com|goo\.gl/i.test(payload.mapsUrl)) {
    throw new Error("Only Google Maps URLs are accepted.");
  }
  if (!payload.note || String(payload.note).trim().length < 6) {
    throw new Error("Recommendation note is too short.");
  }
}

function analyzeMapsUrl_(rawUrl) {
  const facts = {
    source_mode: "static_url",
    original_url: rawUrl,
    name_candidate: "",
    coordinate_candidate: null,
    path: "",
    query: ""
  };

  try {
    const decoded = decodeURIComponent(rawUrl);
    const match = decoded.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (match) {
      facts.coordinate_candidate = {
        latitude: Number(match[1]),
        longitude: Number(match[2])
      };
    }

    const url = new URL(rawUrl);
    facts.path = decodeURIComponent(url.pathname);
    facts.query = decodeURIComponent(url.search || "");

    const placeMatch = facts.path.match(/\/place\/([^/]+)/);
    if (placeMatch) {
      facts.name_candidate = placeMatch[1].replace(/\+/g, " ").trim();
    }

    const searchMatch = facts.path.match(/\/search\/([^/]+)/);
    if (!facts.name_candidate && searchMatch) {
      facts.name_candidate = searchMatch[1].replace(/\+/g, " ").trim();
    }
  } catch (error) {
    facts.parse_error = error.message;
  }

  return facts;
}

function maybeResolveUrl_(rawUrl) {
  const props = PropertiesService.getScriptProperties();
  const enabled = props.getProperty("ENABLE_URL_RESOLVE") === "true";
  if (!enabled || rawUrl.indexOf("maps.app.goo.gl") === -1) return "";

  try {
    const response = UrlFetchApp.fetch(rawUrl, {
      followRedirects: false,
      muteHttpExceptions: true
    });
    const headers = response.getAllHeaders();
    return headers.Location || headers.location || "";
  } catch (error) {
    return "";
  }
}

function mergeUrlFacts_(originalFacts, resolvedFacts) {
  return {
    source_mode: "resolved_url",
    original_url: originalFacts.original_url,
    name_candidate: cleanText_(resolvedFacts.name_candidate) || cleanText_(originalFacts.name_candidate) || "",
    coordinate_candidate: resolvedFacts.coordinate_candidate || originalFacts.coordinate_candidate || null,
    path: resolvedFacts.path || originalFacts.path || "",
    query: resolvedFacts.query || originalFacts.query || "",
    parse_error: resolvedFacts.parse_error || originalFacts.parse_error || ""
  };
}

function extractRestaurantProfile_(payload, urlFacts, resolvedUrl) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in Script Properties.");

  const prompt = [
    "你是餐廳推薦資料整理助手。只能根據輸入資料推論，不要假裝查到不存在的評論或即時資訊。",
    "如果資訊不足，文字欄位請用空字串，陣列欄位請用空陣列，不要輸出 unknown、未知、不確定。",
    "latitude、longitude、rating 只有在輸入明確提供時才輸出；不要用 0 代表未知。",
    "請用繁體中文輸出。價格用 unknown, $, $$, $$$, $$$$。價格資訊不足時必須用 unknown。",
    "若使用者手填店名、地區、價格，或 URL 靜態解析提供 name_candidate、coordinate_candidate，請優先保留這些線索。",
    "請根據 URL、店名候選與使用者筆記判斷是否為餐廳、咖啡廳、酒吧、甜點店、小吃攤、夜市攤位或其他餐飲地點。除非明顯不是餐飲地點，is_food_place 預設為 true。",
    "店名、地區、地址、料理標籤、口味標籤、風格標籤、聚會類型標籤應以你的修正後結構化結果輸出；不要只複製使用者原文。",
    "",
    "使用者投稿：",
    JSON.stringify(payload, null, 2),
    "",
    "URL 靜態解析：",
    JSON.stringify(urlFacts, null, 2),
    "",
    "展開後 URL：",
    resolvedUrl || "(none)"
  ].join("\n");

  const schema = restaurantSchema_();
  const response = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + encodeURIComponent(apiKey), {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: schema
      }
    })
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error("Gemini request failed: " + status + " " + body);
  }

  const parsed = JSON.parse(body);
  const text = parsed.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

function restaurantSchema_() {
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      district: { type: "string" },
      address: { type: "string" },
      latitude: { type: "number" },
      longitude: { type: "number" },
      rating: { type: "number" },
      price_level: { type: "string", enum: ["unknown", "$", "$$", "$$$", "$$$$"] },
      cuisine_tags: { type: "array", items: { type: "string" } },
      taste_tags: { type: "array", items: { type: "string" } },
      vibe_tags: { type: "array", items: { type: "string" } },
      occasion_tags: { type: "array", items: { type: "string" } },
      parking: { type: "string" },
      features: { type: "array", items: { type: "string" } },
      negative_signals: { type: "array", items: { type: "string" } },
      confidence_name: { type: "number" },
      confidence_location: { type: "number" },
      confidence_tags: { type: "number" },
      is_food_place: { type: "boolean" },
      place_type: { type: "string" },
      needs_review: { type: "boolean" },
      review_notes: { type: "string" }
    },
    required: [
      "name",
      "district",
      "address",
      "price_level",
      "cuisine_tags",
      "taste_tags",
      "vibe_tags",
      "occasion_tags",
      "parking",
      "features",
      "negative_signals",
      "confidence_name",
      "confidence_location",
      "confidence_tags",
      "is_food_place",
      "place_type",
      "needs_review",
      "review_notes"
    ]
  };
}

function buildSheetRow_(payload, urlFacts, resolvedUrl, profile) {
  const coordinates = urlFacts.coordinate_candidate || {};
  const id = Utilities.getUuid();
  const latitude = normalizeCoordinate_(profile.latitude) || normalizeCoordinate_(coordinates.latitude);
  const longitude = normalizeCoordinate_(profile.longitude) || normalizeCoordinate_(coordinates.longitude);
  const isFoodPlace = profile.is_food_place !== false;
  return {
    id: id,
    created_at: new Date().toISOString(),
    review_status: isFoodPlace ? "approved" : "rejected",
    source_mode: resolvedUrl ? "resolved_url" : urlFacts.source_mode,
    original_url: payload.mapsUrl,
    resolved_url: resolvedUrl,
    submitter_name: payload.submitterName || "",
    user_note: payload.note || "",
    client_context: JSON.stringify(payload.clientContext || {}),
    name: cleanText_(profile.name) || cleanText_(payload.manualName) || cleanText_(urlFacts.name_candidate) || "",
    district: cleanText_(profile.district) || cleanText_(payload.manualDistrict) || "",
    address: cleanText_(profile.address) || "",
    latitude: latitude || "",
    longitude: longitude || "",
    rating: normalizeRating_(profile.rating) || "",
    price_level: normalizePriceLevel_(profile.price_level) || payload.manualPrice || "",
    cuisine_tags: join_(cleanArray_(profile.cuisine_tags)),
    taste_tags: join_(cleanArray_(profile.taste_tags)),
    vibe_tags: join_(cleanArray_(profile.vibe_tags)),
    occasion_tags: join_(cleanArray_(profile.occasion_tags)),
    parking: cleanText_(profile.parking) || "",
    features: join_(cleanArray_(profile.features)),
    negative_signals: join_(cleanArray_(profile.negative_signals)),
    confidence_name: normalizeConfidence_(profile.confidence_name),
    confidence_location: normalizeConfidence_(profile.confidence_location),
    confidence_tags: normalizeConfidence_(profile.confidence_tags),
    is_food_place: isFoodPlace,
    place_type: cleanText_(profile.place_type) || "",
    needs_review: profile.needs_review === true,
    review_notes: buildReviewNotes_(profile, isFoodPlace),
    ai_raw_json: JSON.stringify(profile)
  };
}

function appendRow_(row) {
  const sheet = getSheet_();
  const headers = ensureHeaders_(sheet);
  sheet.appendRow(headers.map((header) => row[header] === undefined ? "" : row[header]));
}

function ensureHeaders_(sheet) {
  const expectedHeaders = getHeaders_();
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(expectedHeaders);
    return expectedHeaders;
  }

  const lastColumn = Math.max(sheet.getLastColumn(), expectedHeaders.length);
  const currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map((value) => String(value || "").trim());
  const activeHeaders = currentHeaders.filter((header) => header);
  const missingHeaders = expectedHeaders.filter((header) => activeHeaders.indexOf(header) === -1);

  if (missingHeaders.length > 0) {
    sheet.getRange(1, activeHeaders.length + 1, 1, missingHeaders.length).setValues([missingHeaders]);
  }

  return activeHeaders.concat(missingHeaders);
}

function getSheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) throw new Error("Missing SPREADSHEET_ID in Script Properties.");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  return spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
}

function getHeaders_() {
  return [
    "id",
    "created_at",
    "review_status",
    "source_mode",
    "original_url",
    "resolved_url",
    "submitter_name",
    "user_note",
    "client_context",
    "name",
    "district",
    "address",
    "latitude",
    "longitude",
    "rating",
    "price_level",
    "cuisine_tags",
    "taste_tags",
    "vibe_tags",
    "occasion_tags",
    "parking",
    "features",
    "negative_signals",
    "confidence_name",
    "confidence_location",
    "confidence_tags",
    "is_food_place",
    "place_type",
    "needs_review",
    "review_notes",
    "ai_raw_json"
  ];
}

function join_(values) {
  return Array.isArray(values) ? values.join(", ") : "";
}

function cleanText_(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lowered = text.toLowerCase();
  if (["unknown", "n/a", "na", "null", "undefined", "未知", "不明", "不確定"].indexOf(lowered) !== -1) return "";
  return text;
}

function cleanArray_(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => cleanText_(value))
    .filter((value, index, array) => value && array.indexOf(value) === index);
}

function normalizeCoordinate_(value) {
  const number = Number(value);
  if (!isFinite(number) || number === 0) return "";
  return number;
}

function normalizeRating_(value) {
  const number = Number(value);
  if (!isFinite(number) || number <= 0) return "";
  return number;
}

function normalizeConfidence_(value) {
  const number = Number(value);
  if (!isFinite(number)) return "";
  return Math.max(0, Math.min(1, number));
}

function buildReviewNotes_(profile, isFoodPlace) {
  const notes = [];
  const placeType = cleanText_(profile.place_type);
  const reviewNotes = cleanText_(profile.review_notes);
  if (placeType) notes.push("place_type=" + placeType);
  if (!isFoodPlace) notes.push("Gemini 判斷此地點不是餐飲地點，已自動拒絕。");
  if (reviewNotes) notes.push(reviewNotes);
  return notes.join(" ");
}

function normalizePriceLevel_(value) {
  if (!value || value === "unknown") return "";
  return value;
}

function json_(data, statusCode) {
  const output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}
