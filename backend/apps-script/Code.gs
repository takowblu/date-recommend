const SHEET_NAME = "submissions";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

function doPost(e) {
  try {
    const payload = parseRequest_(e);
    validateSubmission_(payload);

    if (payload.website) {
      return json_({ ok: true, ignored: true });
    }

    const urlFacts = analyzeMapsUrl_(payload.mapsUrl);
    const resolvedUrl = maybeResolveUrl_(payload.mapsUrl);
    const profile = extractRestaurantProfile_(payload, urlFacts, resolvedUrl);
    const row = buildSheetRow_(payload, urlFacts, resolvedUrl, profile);

    appendRow_(row);
    return json_({ ok: true, id: row.id, needsReview: profile.needs_review });
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

function extractRestaurantProfile_(payload, urlFacts, resolvedUrl) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in Script Properties.");

  const prompt = [
    "你是餐廳推薦資料整理助手。只能根據輸入資料推論，不要假裝查到不存在的評論或即時資訊。",
    "如果資訊不足，欄位可留空，並提高 needs_review。",
    "請用繁體中文輸出。價格用 $, $$, $$$, $$$$。",
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
      price_level: { type: "string", enum: ["", "$", "$$", "$$$", "$$$$"] },
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
      "needs_review",
      "review_notes"
    ]
  };
}

function buildSheetRow_(payload, urlFacts, resolvedUrl, profile) {
  const coordinates = urlFacts.coordinate_candidate || {};
  const id = Utilities.getUuid();
  return {
    id: id,
    created_at: new Date().toISOString(),
    review_status: "pending",
    source_mode: resolvedUrl ? "resolved_url" : urlFacts.source_mode,
    original_url: payload.mapsUrl,
    resolved_url: resolvedUrl,
    submitter_name: payload.submitterName || "",
    user_note: payload.note || "",
    client_context: JSON.stringify(payload.clientContext || {}),
    name: profile.name || payload.manualName || urlFacts.name_candidate || "",
    district: profile.district || payload.manualDistrict || "",
    address: profile.address || "",
    latitude: profile.latitude || coordinates.latitude || "",
    longitude: profile.longitude || coordinates.longitude || "",
    rating: profile.rating || "",
    price_level: profile.price_level || payload.manualPrice || "",
    cuisine_tags: join_(profile.cuisine_tags),
    taste_tags: join_(profile.taste_tags),
    vibe_tags: join_(profile.vibe_tags),
    occasion_tags: join_(profile.occasion_tags),
    parking: profile.parking || "",
    features: join_(profile.features),
    negative_signals: join_(profile.negative_signals),
    confidence_name: profile.confidence_name,
    confidence_location: profile.confidence_location,
    confidence_tags: profile.confidence_tags,
    needs_review: profile.needs_review,
    review_notes: profile.review_notes || "",
    ai_raw_json: JSON.stringify(profile)
  };
}

function appendRow_(row) {
  const sheet = getSheet_();
  const headers = getHeaders_();
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  sheet.appendRow(headers.map((header) => row[header] === undefined ? "" : row[header]));
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
    "needs_review",
    "review_notes",
    "ai_raw_json"
  ];
}

function join_(values) {
  return Array.isArray(values) ? values.join(", ") : "";
}

function json_(data, statusCode) {
  const output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}
