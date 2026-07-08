const config = window.RESTAURANT_RECS_CONFIG;

const state = {
  restaurants: [],
  filtered: [],
  selectedId: null,
  district: "全部",
  tags: new Set(),
  search: "",
  price: "",
  parkingOnly: false,
  liff: {
    ready: false,
    inClient: false,
    userId: "",
    displayName: ""
  }
};

const els = {
  dataStatus: document.querySelector("#dataStatus"),
  liffStatus: document.querySelector("#liffStatus"),
  districtFilters: document.querySelector("#districtFilters"),
  tagFilters: document.querySelector("#tagFilters"),
  searchInput: document.querySelector("#searchInput"),
  priceSelect: document.querySelector("#priceSelect"),
  parkingToggle: document.querySelector("#parkingToggle"),
  clearFilters: document.querySelector("#clearFilters"),
  restaurantList: document.querySelector("#restaurantList"),
  resultCount: document.querySelector("#resultCount"),
  activeTitle: document.querySelector("#activeTitle"),
  selectedName: document.querySelector("#selectedName"),
  openInMaps: document.querySelector("#openInMaps"),
  mapFrame: document.querySelector("#mapFrame"),
  mapFallback: document.querySelector("#mapFallback"),
  detailPanel: document.querySelector("#detailPanel"),
  submitDialog: document.querySelector("#submitDialog"),
  openSubmit: document.querySelector("#openSubmit"),
  closeSubmit: document.querySelector("#closeSubmit"),
  cancelSubmit: document.querySelector("#cancelSubmit"),
  submitForm: document.querySelector("#submitForm"),
  submitMessage: document.querySelector("#submitMessage")
};

init();

async function init() {
  await initLiff();
  bindEvents();
  await loadRestaurants();
  renderFilters();
  applyFilters();
}

async function initLiff() {
  if (!config.liffId || !window.liff) {
    els.liffStatus.textContent = "Web 模式";
    return;
  }

  try {
    await window.liff.init({ liffId: config.liffId });
    state.liff.ready = true;
    state.liff.inClient = window.liff.isInClient();
    els.liffStatus.textContent = state.liff.inClient ? "LIFF 模式" : "瀏覽器模式";

    if (config.requireLiffLogin && !window.liff.isLoggedIn()) {
      window.liff.login();
      return;
    }

    if (window.liff.isLoggedIn()) {
      const profile = await window.liff.getProfile();
      state.liff.userId = profile.userId || "";
      state.liff.displayName = profile.displayName || "";
      const submitter = document.querySelector("#submitterName");
      if (submitter && !submitter.value) submitter.value = state.liff.displayName;
    }
  } catch (error) {
    els.liffStatus.textContent = "LIFF 未啟用";
  }
}

function bindEvents() {
  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    applyFilters();
  });

  els.priceSelect.addEventListener("change", (event) => {
    state.price = event.target.value;
    applyFilters();
  });

  els.parkingToggle.addEventListener("change", (event) => {
    state.parkingOnly = event.target.checked;
    applyFilters();
  });

  els.clearFilters.addEventListener("click", () => {
    state.district = "全部";
    state.tags.clear();
    state.search = "";
    state.price = "";
    state.parkingOnly = false;
    els.searchInput.value = "";
    els.priceSelect.value = "";
    els.parkingToggle.checked = false;
    renderFilters();
    applyFilters();
  });

  els.openSubmit.addEventListener("click", () => {
    els.submitMessage.textContent = "";
    els.submitDialog.showModal();
  });

  els.closeSubmit.addEventListener("click", closeSubmitDialog);
  els.cancelSubmit.addEventListener("click", closeSubmitDialog);
  els.submitForm.addEventListener("submit", handleSubmit);
}

async function loadRestaurants() {
  try {
    const response = await fetch(config.dataUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const records = await response.json();
    state.restaurants = records.filter((item) => item.reviewStatus === "approved");
    els.dataStatus.textContent = `${state.restaurants.length} 筆已審核`;
  } catch (error) {
    els.dataStatus.textContent = "資料載入失敗";
    els.restaurantList.innerHTML = `<div class="empty-state">無法載入餐廳資料：${escapeHtml(error.message)}</div>`;
  }
}

function renderFilters() {
  const districts = ["全部", ...unique(state.restaurants.map((item) => item.district).filter(Boolean))];
  els.districtFilters.innerHTML = districts.map((district) => {
    const active = district === state.district ? " active" : "";
    return `<button class="segment-button${active}" type="button" data-district="${escapeHtml(district)}">${escapeHtml(district)}</button>`;
  }).join("");

  els.districtFilters.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.district = button.dataset.district;
      renderFilters();
      applyFilters();
    });
  });

  const tags = unique(state.restaurants.flatMap((item) => collectTags(item))).slice(0, 28);
  els.tagFilters.innerHTML = tags.map((tag) => {
    const active = state.tags.has(tag) ? " active" : "";
    return `<button class="tag-filter${active}" type="button" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
  }).join("");

  els.tagFilters.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const tag = button.dataset.tag;
      if (state.tags.has(tag)) state.tags.delete(tag);
      else state.tags.add(tag);
      renderFilters();
      applyFilters();
    });
  });
}

function applyFilters() {
  state.filtered = state.restaurants.filter((item) => {
    if (state.district !== "全部" && item.district !== state.district) return false;
    if (state.price && item.priceLevel !== state.price) return false;
    if (state.parkingOnly && !hasParkingSignal(item.parking)) return false;
    if (state.tags.size > 0) {
      const tags = new Set(collectTags(item));
      for (const tag of state.tags) {
        if (!tags.has(tag)) return false;
      }
    }
    if (state.search) {
      const haystack = [
        item.name,
        item.address,
        item.district,
        item.recommendationNote,
        item.parking,
        ...collectTags(item),
        ...(item.features || []),
        ...(item.negativeSignals || [])
      ].join(" ").toLowerCase();
      if (!haystack.includes(state.search)) return false;
    }
    return true;
  });

  if (!state.filtered.some((item) => item.id === state.selectedId)) {
    state.selectedId = state.filtered[0]?.id || null;
  }

  renderResults();
  renderSelected();
}

function renderResults() {
  els.resultCount.textContent = `${state.filtered.length} 間餐廳`;
  els.activeTitle.textContent = state.district === "全部" ? "全部推薦" : `${state.district}推薦`;

  if (state.filtered.length === 0) {
    els.restaurantList.innerHTML = `<div class="empty-state">沒有符合條件的餐廳。</div>`;
    return;
  }

  els.restaurantList.innerHTML = state.filtered.map((item) => {
    const active = item.id === state.selectedId ? " active" : "";
    const tags = collectTags(item).slice(0, 6).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    return `
      <button class="restaurant-card${active}" type="button" data-id="${escapeHtml(item.id)}">
        <h3>${escapeHtml(item.name)}</h3>
        <div class="meta-row">
          <span class="meta-pill">${escapeHtml(item.district || "未分區")}</span>
          <span class="meta-pill">${escapeHtml(item.priceLevel || "價格未定")}</span>
          <span class="meta-pill">${formatRating(item.rating)}</span>
        </div>
        <p class="card-note">${escapeHtml(item.recommendationNote || "")}</p>
        <div class="tag-row">${tags}</div>
      </button>
    `;
  }).join("");

  els.restaurantList.querySelectorAll(".restaurant-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedId = card.dataset.id;
      renderResults();
      renderSelected();
    });
  });
}

function renderSelected() {
  const item = state.restaurants.find((record) => record.id === state.selectedId);
  if (!item) {
    els.selectedName.textContent = "選擇餐廳";
    els.openInMaps.href = "#";
    els.mapFrame.removeAttribute("src");
    els.mapFallback.classList.remove("hidden");
    els.detailPanel.innerHTML = "";
    return;
  }

  els.selectedName.textContent = item.name;
  els.openInMaps.href = item.mapUrl || buildMapsSearchUrl(item);
  const embedUrl = buildEmbedUrl(item);
  if (embedUrl) {
    els.mapFrame.src = embedUrl;
    els.mapFallback.classList.add("hidden");
  } else {
    els.mapFrame.removeAttribute("src");
    els.mapFallback.classList.remove("hidden");
  }

  els.detailPanel.innerHTML = `
    <p>${escapeHtml(item.recommendationNote || "")}</p>
    ${renderDetailSection("特色", item.features)}
    ${renderDetailSection("可能踩雷", item.negativeSignals)}
    ${renderDetailSection("適合", item.occasionTags)}
    <div class="detail-section">
      <h3>停車</h3>
      <p>${escapeHtml(item.parking || "尚無停車資訊")}</p>
    </div>
    <div class="detail-section">
      <h3>地址</h3>
      <p>${escapeHtml(item.address || "尚無地址")}</p>
    </div>
  `;
}

async function handleSubmit(event) {
  event.preventDefault();
  const formData = new FormData(els.submitForm);
  const payload = Object.fromEntries(formData.entries());
  payload.clientCreatedAt = new Date().toISOString();
  payload.clientContext = {
    channel: state.liff.ready ? "liff" : "web",
    inLineClient: state.liff.inClient,
    lineUserId: state.liff.userId,
    lineDisplayName: state.liff.displayName
  };

  if (payload.website) {
    els.submitMessage.textContent = "投稿已收到。";
    return;
  }

  if (!isGoogleMapsUrl(payload.mapsUrl)) {
    els.submitMessage.textContent = "請貼上 Google Maps URL。";
    return;
  }

  if (!config.submitEndpoint) {
    if (config.enableDemoSubmit) {
      els.submitMessage.textContent = "Demo 模式：表單格式正確。設定 submitEndpoint 後會送到 Apps Script。";
      return;
    }
    els.submitMessage.textContent = "尚未設定投稿端點。";
    return;
  }

  els.submitMessage.textContent = "送出中...";
  try {
    const response = await fetch(config.submitEndpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    els.submitMessage.textContent = result.reviewStatus === "rejected"
      ? "已收到，但系統判斷這可能不是餐飲地點。"
      : "已送出，並通過餐飲地點初步檢查。";
    els.submitForm.reset();
  } catch (error) {
    els.submitMessage.textContent = `送出失敗：${error.message}`;
  }
}

function closeSubmitDialog() {
  els.submitDialog.close();
}

function collectTags(item) {
  return [
    ...(item.cuisineTags || []),
    ...(item.tasteTags || []),
    ...(item.vibeTags || []),
    ...(item.occasionTags || [])
  ];
}

function unique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

function hasParkingSignal(value) {
  if (!value) return false;
  return !["無", "未知", "不確定", "尚無停車資訊"].some((word) => value.includes(word));
}

function formatRating(rating) {
  return rating ? `${Number(rating).toFixed(1)} 星` : "未評分";
}

function buildMapsSearchUrl(item) {
  if (item.latitude && item.longitude) {
    return `https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([item.name, item.address].filter(Boolean).join(" "))}`;
}

function buildEmbedUrl(item) {
  if (config.mapsEmbedApiKey) {
    const query = item.latitude && item.longitude
      ? `${item.latitude},${item.longitude}`
      : [item.name, item.address].filter(Boolean).join(" ");
    return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(config.mapsEmbedApiKey)}&q=${encodeURIComponent(query)}`;
  }
  const query = item.latitude && item.longitude
    ? `${item.latitude},${item.longitude}`
    : [item.name, item.address].filter(Boolean).join(" ");
  return `https://maps.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
}

function renderDetailSection(title, values) {
  if (!values || values.length === 0) return "";
  const tags = values.map((value) => `<span class="tag">${escapeHtml(value)}</span>`).join("");
  return `
    <div class="detail-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="tag-row">${tags}</div>
    </div>
  `;
}

function isGoogleMapsUrl(value) {
  try {
    const url = new URL(value);
    return ["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl", "goo.gl"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
