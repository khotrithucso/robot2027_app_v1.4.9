/* ==========================================================================
   ROBOT 2027 - V1.4 PRO (UPDATE 12)
   - Hands-Free & Button-Triggered English Pronunciation Grading + Auto-Advance
   - 100% In-App Wi-Fi Suggestion Connect + Real Local IP Verification
   - Dual-Mode Bluetooth Scanner & Connector (BLE + Classic: ESP32, Speakers, Phones)
   - Full Server Sync for All Topics & Lessons (api.php + Native HTTP fallback)
   - Configurable Pronunciation Pass Threshold (50% - 100%)
   - Instant Voice Command Execution via speechPartial + Safe WebRTC P2P Camera
   - Single Official Developer Password: 202799
   ========================================================================== */
(function () {
  "use strict";

  const DEFAULT_SERVER_BASE = "https://khotrithucso.io.vn/robot2027_2_4/test1";
  const DEV_MASTER_PIN = "202799";

  const ESP_SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
  const ESP_CHAR_TX_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
  const ESP_CHAR_RX_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a9";

  const getRobotNative = () => window.Capacitor?.Plugins?.RobotNative || null;
  const getBleClient = () => window.Capacitor?.Plugins?.BluetoothLe || null;

  const state = {
    activeTab: "robot",
    settingsUnlocked: false,
    karaokeOpen: false,
    roleName: "🎓 Cô giáo tiếng Anh",
    mood: "happy",
    headLightOn: false,
    armLightOn: false,
    bleConnected: false,
    bleDeviceId: "",
    bleDeviceName: "",
    btDiscoveredMap: {},
    selectedBtAddress: "",
    wifiScannedList: [],
    selectedWifiSsid: "",
    isConfiguringWifi: false,
    isSpeaking: false,
    isListening: false,
    isRecordingLesson: false,
    recordStartedAt: 0,
    listenSessionId: 0,
    idleSeconds: 0,
    sleepStage: "awake",
    members: [],
    activeMemberId: "m_default",
    deviceUid: "",
    topics: [],
    currentTopicSlug: "daily",
    currentTopicTitle: "Giao tiếp hằng ngày",
    sentences: [
      {
        id: 0,
        en: "Hello! How are you today?",
        vi: "Xin chào! Hôm nay bạn khỏe không?",
        audio_url: "",
        spelling: [
          { word: "Hello", spell: "H-E-L-L-O" },
          { word: "How", spell: "H-O-W" },
          { word: "are", spell: "A-R-E" },
          { word: "you", spell: "Y-O-U" },
          { word: "today", spell: "T-O-D-A-Y" }
        ]
      }
    ],
    sentenceIndex: 0,
    config: {
      serverUrl: DEFAULT_SERVER_BASE,
      parentPin: "1234",
      studyOnly: false,
      bedtime: "21:30",
      brightness: 75,
      volume: 80,
      speechRate: 0.95,
      passThreshold: 70,
      bleAutoReconnect: true,
      savedBleAddress: "",
      savedBleName: "",
      savedBlePin: ""
    },
    pointPollTimer: null,
    audioPlayer: new Audio(),
    camPreviewStream: null
  };

  // ==================== HELPERS & URL NORMALIZATION ====================
  function generateUid(prefix = "RB_", len = 20) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = prefix;
    while (out.length < len) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out.slice(0, len);
  }

  function getServerBase() {
    let raw = (state.config.serverUrl || DEFAULT_SERVER_BASE).trim().replace(/\/+$/, "");
    raw = raw.replace(/\/(api|api_user|api_point|camera_live|youtube|games)\.php$/i, "");
    if (!raw || raw === "https://khotrithucso.io.vn/robot2027_2_4") {
      raw = DEFAULT_SERVER_BASE;
    }
    return raw;
  }

  function buildApiUrl(scriptName, params = {}) {
    const base = getServerBase();
    const url = new URL(`${base}/${scriptName}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    });
    return url.toString();
  }

  async function fetchServerJson(scriptName, params = {}) {
    const url = buildApiUrl(scriptName, params);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        return JSON.parse(text);
      }
    } catch (_) {}

    const native = getRobotNative();
    if (native && typeof native.httpGet === "function") {
      const nativeRes = await native.httpGet({ url });
      if (nativeRes && nativeRes.body) {
        return JSON.parse(nativeRes.body);
      }
    }
    throw new Error("Không thể kết nối máy chủ");
  }

  function normalizeVietnamese(str) {
    return (str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .trim();
  }

  function normalizeEnglishWords(str) {
    let s = (str || "").toLowerCase();
    const contractions = {
      "i'm": "i am",
      "you're": "you are",
      "he's": "he is",
      "she's": "she is",
      "it's": "it is",
      "we're": "we are",
      "they're": "they are",
      "what's": "what is",
      "where's": "where is",
      "who's": "who is",
      "how's": "how is",
      "that's": "that is",
      "there's": "there is",
      "don't": "do not",
      "doesn't": "does not",
      "didn't": "did not",
      "can't": "cannot",
      "won't": "will not",
      "isn't": "is not",
      "aren't": "are not",
      "let's": "let us"
    };
    Object.entries(contractions).forEach(([k, v]) => {
      s = s.replace(new RegExp(`\\b${k}\\b`, "g"), v);
    });
    return s.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  }

  function buildLocalSpelling(sentence) {
    return (sentence || "")
      .replace(/[^a-zA-Z0-9'\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(w => ({
        word: w,
        spell: w.toUpperCase().split("").join("-")
      }));
  }

  // ==================== LOCAL STATE STORAGE ====================
  function loadLocalState() {
    try {
      const savedCfg = JSON.parse(localStorage.getItem("rb_v14_config") || "null");
      if (savedCfg && typeof savedCfg === "object") {
        Object.assign(state.config, savedCfg);
      }
      state.config.serverUrl = getServerBase();
      state.config.passThreshold = Number(state.config.passThreshold) || 70;

      let devUid = localStorage.getItem("rb_v14_device_uid");
      if (!devUid) {
        devUid = generateUid("RB_CAM_", 20);
        localStorage.setItem("rb_v14_device_uid", devUid);
      }
      state.deviceUid = devUid;

      const savedMembers = JSON.parse(localStorage.getItem("rb_v14_members") || "null");
      if (Array.isArray(savedMembers) && savedMembers.length > 0) {
        state.members = savedMembers;
      } else {
        state.members = [
          { id: "m_default", uid: generateUid("", 20), name: "Bé Yêu", age: 7, avatar: "🧒", stars: 5 }
        ];
      }

      const activeId = localStorage.getItem("rb_v14_active_member");
      if (activeId && state.members.some(m => m.id === activeId)) {
        state.activeMemberId = activeId;
      } else {
        state.activeMemberId = state.members[0].id;
      }

      const cachedTopics = JSON.parse(localStorage.getItem("rb_v14_topics_cache") || "null");
      if (Array.isArray(cachedTopics) && cachedTopics.length > 0) {
        state.topics = cachedTopics;
      }
    } catch (_) {}
  }

  function saveLocalState() {
    try {
      state.config.serverUrl = getServerBase();
      localStorage.setItem("rb_v14_config", JSON.stringify(state.config));
      localStorage.setItem("rb_v14_members", JSON.stringify(state.members));
      localStorage.setItem("rb_v14_active_member", state.activeMemberId);
    } catch (_) {}
  }

  function safeSetTopicCache(topicSlug, hash, items) {
    const dataKey = `rb_topic_data_${topicSlug}`;
    const hashKey = `rb_topic_hash_${topicSlug}`;
    const payload = JSON.stringify(items);
    try {
      localStorage.setItem(dataKey, payload);
      localStorage.setItem(hashKey, hash || "");
    } catch (_) {
      try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("rb_topic_data_") && k !== dataKey) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.slice(0, 5).forEach(k => localStorage.removeItem(k));
        localStorage.setItem(dataKey, payload);
        localStorage.setItem(hashKey, hash || "");
      } catch (__) {}
    }
  }

  // ==================== FAMILY MEMBERS & STARS ====================
  function getActiveMember() {
    return state.members.find(m => m.id === state.activeMemberId) || state.members[0];
  }

  function updateHeaderMemberUI() {
    const m = getActiveMember();
    if (!m) return;
    document.getElementById("hdr-member-avatar").textContent = m.avatar || "🧒";
    document.getElementById("hdr-member-name").textContent = m.name;
    document.getElementById("hdr-stars").textContent = String(m.stars || 0);
    const hardName = document.getElementById("hard-member-name");
    if (hardName) hardName.textContent = m.name;
  }

  function addStarsToActiveMember(delta, reason = "") {
    const m = getActiveMember();
    if (!m) return;
    m.stars = Math.max(0, (m.stars || 0) + delta);
    saveLocalState();
    updateHeaderMemberUI();
    renderMembersSettingsList();

    fetchServerJson("api_user.php", {
      action: "sync_profile",
      bot_id: m.uid,
      name: m.name,
      stars: m.stars,
      reason
    }).catch(() => {});
  }

  function startPointPolling() {
    stopPointPolling();
    state.pointPollTimer = setInterval(async () => {
      if (state.activeTab !== "youtube" && state.activeTab !== "game") return;
      const m = getActiveMember();
      if (!m) return;
      try {
        const data = await fetchServerJson("api_point.php", { uid: m.uid, _t: Date.now() });
        if (data && data.status === "ok" && typeof data.stars === "number") {
          if (data.stars !== m.stars) {
            m.stars = data.stars;
            saveLocalState();
            updateHeaderMemberUI();
          }
        }
      } catch (_) {}
    }, 2000);
  }

  function stopPointPolling() {
    if (state.pointPollTimer) {
      clearInterval(state.pointPollTimer);
      state.pointPollTimer = null;
    }
  }

  // ==================== NAVIGATION & TABS ====================
  function switchTab(tabName) {
    if ((tabName === "youtube" || tabName === "game") && state.config.studyOnly) {
      speakFeedback("Chế độ Chỉ Học Tập đang bật. Phụ huynh có thể mở khóa trong Cài đặt nhé!", "vi-VN");
      return;
    }

    if (tabName === "settings" && !state.settingsUnlocked) {
      openPinModal();
      return;
    }

    if (state.activeTab === "youtube" && tabName !== "youtube") {
      document.getElementById("frame-youtube").src = "about:blank";
      stopPointPolling();
    }
    if (state.activeTab === "game" && tabName !== "game") {
      document.getElementById("frame-game").src = "about:blank";
      stopPointPolling();
    }

    state.activeTab = tabName;
    document.querySelectorAll(".tab-view").forEach(sec => sec.classList.remove("active"));
    document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    const target = document.getElementById(`tab-${tabName}`);
    if (target) target.classList.add("active");

    const refreshBtn = document.getElementById("btn-refresh-frame");
    if (tabName === "youtube" || tabName === "game") {
      refreshBtn.classList.remove("hidden");
      const m = getActiveMember();
      const script = tabName === "youtube" ? "youtube.php" : "games.php";
      const frame = document.getElementById(tabName === "youtube" ? "frame-youtube" : "frame-game");
      frame.src = buildApiUrl(script, { uid: m.uid, stars: m.stars, init: 1, r: Date.now() });
      startPointPolling();
    } else {
      refreshBtn.classList.add("hidden");
    }

    if (tabName === "topics") {
      renderTopicsGrid();
      loadTopicsList(true);
    }
    if (tabName === "settings") {
      syncSettingsUI();
      renderCameraQrCode();
      refreshDeviceTelemetry();
    }

    resetIdleTimer();
  }

  // ==================== ROBOT FACE, SLEEP CYCLE & TTS ====================
  function setRobotMood(mood) {
    state.mood = mood;
    const head = document.getElementById("robot-head");
    if (head) head.className = `robot-head mood-${mood}`;
    const zzz = document.getElementById("sleep-zzz");
    if (zzz) zzz.classList.toggle("hidden", mood !== "sleeping");
  }

  function setRobotBubble(text) {
    const el = document.getElementById("robot-bubble");
    if (el) el.textContent = text;
  }

  function startNaturalBlinkLoop() {
    setInterval(() => {
      if (state.mood === "sleeping") return;
      document.querySelectorAll(".eye").forEach(e => e.classList.add("blinking"));
      setTimeout(() => {
        document.querySelectorAll(".eye").forEach(e => e.classList.remove("blinking"));
      }, 150);
    }, 3800);
  }

  function resetIdleTimer() {
    state.idleSeconds = 0;
    if (state.sleepStage === "sleeping") {
      wakeRobot(false);
    } else if (state.sleepStage === "prompting") {
      state.sleepStage = "awake";
    }
    updateSleepBadge();
  }

  function updateSleepBadge() {
    const badge = document.getElementById("sleep-countdown-badge");
    if (!badge) return;
    if (state.activeTab !== "robot" || state.karaokeOpen) {
      badge.textContent = "Đang hoạt động";
      return;
    }
    if (state.sleepStage === "awake") {
      badge.textContent = `Gợi ý sau: ${Math.max(0, 10 - state.idleSeconds)}s`;
    } else if (state.sleepStage === "prompting") {
      badge.textContent = `Ngủ sau: ${Math.max(0, 20 - state.idleSeconds)}s`;
    } else {
      badge.textContent = "💤 Đang ngủ";
    }
  }

  function startIdleMonitor() {
    setInterval(() => {
      if (state.activeTab !== "robot" || state.isSpeaking || state.isRecordingLesson || state.karaokeOpen || state.isConfiguringWifi) {
        state.idleSeconds = 0;
        updateSleepBadge();
        return;
      }
      state.idleSeconds += 1;
      if (state.idleSeconds === 10 && state.sleepStage === "awake") {
        state.sleepStage = "prompting";
        const m = getActiveMember();
        speakFeedback(`${m.name} ơi, bạn có muốn học tiếng Anh, đổi chủ đề, bật đèn hay chơi game không?`, "vi-VN");
      } else if (state.idleSeconds >= 20 && state.sleepStage !== "sleeping") {
        state.sleepStage = "sleeping";
        setRobotMood("sleeping");
        sendBleCommand("M:SLEEP");
        const native = getRobotNative();
        if (native) native.setBrightness({ level: 5 }).catch(() => {});
      }
      updateSleepBadge();
    }, 1000);
  }

  function wakeRobot(greet = true) {
    state.idleSeconds = 0;
    state.sleepStage = "awake";
    setRobotMood("happy");
    sendBleCommand("M:WAKE");
    const native = getRobotNative();
    if (native) native.setBrightness({ level: state.config.brightness }).catch(() => {});
    if (greet) {
      const m = getActiveMember();
      const h = new Date().getHours();
      const part = h < 12 ? "Chào buổi sáng" : h < 18 ? "Chào buổi chiều" : "Chào buổi tối";
      speakFeedback(`${part} ${m.name}! Lucky đã thức dậy rồi đây!`, "vi-VN");
    }
    updateSleepBadge();
  }

  function stopAllSpeechAndMic() {
    state.isSpeaking = false;
    state.isListening = false;
    state.isRecordingLesson = false;
    try { state.audioPlayer.pause(); } catch (_) {}
    const native = getRobotNative();
    if (native) {
      native.stopSpeak().catch(() => {});
      native.stopListening().catch(() => {});
    }
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
  }

  function onSamplePlaybackFinished() {
    state.isSpeaking = false;
    setRobotMood("happy");
    if (state.karaokeOpen) {
      const scoreEl = document.getElementById("k-score-label");
      if (scoreEl) scoreEl.textContent = "🎙️ Tới lượt bạn đọc câu tiếng Anh...";
    }
    ensureAlwaysListening();
  }

  function speakFeedback(text, lang = "vi-VN", isSampleSentence = false) {
    setRobotBubble(text);
    state.isSpeaking = true;
    state.isListening = false;
    setRobotMood("speaking");

    const native = getRobotNative();
    if (native) {
      native.stopListening().catch(() => {});
      native.speak({
        text,
        lang,
        rate: lang.startsWith("en") ? state.config.speechRate : 1.0,
        pitch: 1.08
      }).catch(() => {});
      setTimeout(() => {
        if (state.isSpeaking) {
          onSamplePlaybackFinished();
        }
      }, Math.min(9000, Math.max(1800, text.length * 75)));
      return;
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = lang.startsWith("en") ? state.config.speechRate : 1.0;
      u.onend = () => onSamplePlaybackFinished();
      u.onerror = () => onSamplePlaybackFinished();
      window.speechSynthesis.speak(u);
    } else {
      onSamplePlaybackFinished();
    }
  }

  // ==================== TOPICS & LESSONS SYNC (SERVER API.PHP) ====================
  function renderTopicsGrid() {
    const grid = document.getElementById("topics-grid");
    const summary = document.getElementById("topics-summary-text");
    if (!grid) return;

    const query = normalizeVietnamese(document.getElementById("topic-search-input")?.value || "");
    const filtered = state.topics.filter(t => {
      if (!query) return true;
      const hay = normalizeVietnamese(`${t.index || ""} ${t.topic || ""} ${t.title || ""}`);
      return hay.includes(query);
    });

    if (state.topics.length === 0) {
      summary.textContent = "Đang tải danh sách chủ đề từ máy chủ...";
      grid.innerHTML = `<div class="sub-text">Đang kết nối tới máy chủ học liệu...</div>`;
      return;
    }

    const totalSentences = state.topics.reduce((acc, t) => acc + (Number(t.count) || 0), 0);
    summary.textContent = `Đã đồng bộ ${state.topics.length} chủ đề (${totalSentences.toLocaleString()} câu tiếng Anh) từ máy chủ.`;

    grid.innerHTML = "";
    filtered.forEach(t => {
      const slug = t.topic;
      const title = t.title || slug;
      const count = Number(t.count) || 0;
      const viCount = Number(t.vi_count) || 0;
      const audioCount = Number(t.audio_count) || 0;
      const isCached = !!localStorage.getItem(`rb_topic_data_${slug}`);

      const card = document.createElement("div");
      card.className = "topic-card";
      card.innerHTML = `
        <div>
          <h4>${t.index ? `#${t.index} • ` : ""}${title}</h4>
          <p class="topic-meta">📚 ${count.toLocaleString()} câu • 🇻🇳 ${viCount} dịch • 🔊 ${audioCount} audio ${isCached ? "• ✅ Offline" : ""}</p>
        </div>
        <div class="topic-actions">
          <button type="button" class="action-btn primary" data-act="seq" style="flex:1;">▶️ Học thứ tự</button>
          <button type="button" class="action-btn" data-act="rnd">🎲 Ngẫu nhiên</button>
        </div>
      `;
      card.querySelector('[data-act="seq"]').addEventListener("click", () => loadTopicLessons(slug, "sequential"));
      card.querySelector('[data-act="rnd"]').addEventListener("click", () => loadTopicLessons(slug, "random"));
      grid.appendChild(card);
    });
  }

  async function loadTopicsList(forceRefresh = false) {
    const summary = document.getElementById("topics-summary-text");
    if (forceRefresh && summary) {
      summary.textContent = "🔄 Đang đồng bộ danh sách chủ đề từ máy chủ...";
    }

    try {
      const data = await fetchServerJson("api.php", { action: "topics", _t: Date.now() });
      if (data && data.status === "ok" && Array.isArray(data.topics) && data.topics.length > 0) {
        state.topics = data.topics.map((item, idx) => ({
          index: item.index || idx + 1,
          topic: item.topic,
          title: item.title || item.topic,
          count: Number(item.count) || 0,
          vi_count: Number(item.vi_count) || 0,
          audio_count: Number(item.audio_count) || 0,
          version_hash: item.version_hash || ""
        }));
        try {
          localStorage.setItem("rb_v14_topics_cache", JSON.stringify(state.topics));
        } catch (_) {}
        renderTopicsGrid();
        return;
      }
    } catch (_) {}

    if (state.topics.length > 0) {
      renderTopicsGrid();
    } else if (summary) {
      summary.textContent = "⚠️ Chưa đồng bộ được chủ đề từ máy chủ. Kiểm tra Wi-Fi rồi bấm Đồng bộ lại.";
    }
  }

  async function loadTopicLessons(topicSlug, orderMode = null) {
    const mode = orderMode || document.getElementById("lesson-order-mode")?.value || "sequential";
    const meta = state.topics.find(t => t.topic === topicSlug);
    const topicTitle = meta?.title || topicSlug;
    const expectedHash = meta?.version_hash || "";

    const cacheKey = `rb_topic_data_${topicSlug}`;
    const hashKey = `rb_topic_hash_${topicSlug}`;

    let loadedItems = null;
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      const cachedHash = localStorage.getItem(hashKey) || "";
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw);
        if (Array.isArray(parsed) && parsed.length > 1 && (!expectedHash || cachedHash === expectedHash)) {
          loadedItems = parsed;
        }
      }
    } catch (_) {}

    if (!loadedItems) {
      const summary = document.getElementById("topics-summary-text");
      if (summary) summary.textContent = `📥 Đang tải bài học chủ đề "${topicTitle}" từ máy chủ...`;

      try {
        let allItems = [];
        let offset = 0;
        const pageSize = 500;
        let serverHash = expectedHash;

        while (true) {
          const data = await fetchServerJson("api.php", {
            action: "download",
            topic: topicSlug,
            offset,
            limit: pageSize
          });

          if (!data || data.status !== "ok" || !Array.isArray(data.items)) {
            break;
          }
          if (data.version_hash) serverHash = data.version_hash;

          const mapped = data.items.map((it, idx) => {
            const enText = (it.en || it.in || "").trim();
            return {
              id: it.id !== undefined ? it.id : offset + idx,
              en: enText,
              vi: (it.vi || "").trim(),
              audio_url: (it.audio_url || "").trim(),
              spelling: Array.isArray(it.spelling) && it.spelling.length > 0
                ? it.spelling
                : buildLocalSpelling(enText),
              anim: it.anim || "HAPPY_IDLE"
            };
          }).filter(it => it.en.length > 0);

          allItems = allItems.concat(mapped);
          const total = Number(data.total) || allItems.length;
          if (allItems.length >= total || mapped.length === 0 || allItems.length >= 2500) {
            break;
          }
          offset += pageSize;
        }

        if (allItems.length > 0) {
          loadedItems = allItems;
          safeSetTopicCache(topicSlug, serverHash, allItems);
        }
      } catch (err) {
        speakFeedback(`Không tải được chủ đề ${topicTitle} từ máy chủ. Bạn kiểm tra Wi-Fi nhé!`, "vi-VN");
        renderTopicsGrid();
        return;
      }
    }

    if (!loadedItems || loadedItems.length === 0) {
      speakFeedback(`Chủ đề ${topicTitle} hiện chưa có câu nào trên máy chủ.`, "vi-VN");
      renderTopicsGrid();
      return;
    }

    let finalItems = loadedItems.slice();
    if (mode === "random") {
      for (let i = finalItems.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [finalItems[i], finalItems[j]] = [finalItems[j], finalItems[i]];
      }
    }

    state.currentTopicSlug = topicSlug;
    state.currentTopicTitle = topicTitle;
    state.sentences = finalItems;
    state.sentenceIndex = 0;

    renderTopicsGrid();
    switchTab("robot");
    toggleKaraokePanel(true);
    renderCurrentSentence();
    playCurrentSample();
  }

  // ==================== KARAOKE & PRONUNCIATION ====================
  function toggleKaraokePanel(open) {
    state.karaokeOpen = open;
    state.isRecordingLesson = false;
    const stage = document.getElementById("robot-stage");
    const panel = document.getElementById("karaoke-panel");
    stage.classList.toggle("split-mode", open);
    stage.classList.toggle("full-face", !open);
    panel.classList.toggle("hidden", !open);
    if (open) {
      renderCurrentSentence();
    }
    updateSleepBadge();
  }

  function renderCurrentSentence() {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    document.getElementById("k-topic-title").textContent = `Chủ đề: ${state.currentTopicTitle}`;
    document.getElementById("k-progress-text").textContent = `Câu ${state.sentenceIndex + 1} / ${state.sentences.length}`;

    const enBox = document.getElementById("k-sentence-en");
    const words = item.en.split(/\s+/);
    enBox.innerHTML = words.map((w, idx) => `<span class="k-word" data-widx="${idx}">${w}</span>`).join(" ");

    const spellBox = document.getElementById("k-spelling-box");
    const spList = Array.isArray(item.spelling) && item.spelling.length > 0
      ? item.spelling
      : buildLocalSpelling(item.en);
    spellBox.innerHTML = "";
    spList.forEach(sp => {
      const chip = document.createElement("span");
      chip.className = "spell-chip";
      chip.textContent = `${sp.word}: ${sp.spell}`;
      chip.addEventListener("click", () => {
        speakFeedback(`${sp.word}: ${sp.spell}`, "en-US");
      });
      spellBox.appendChild(chip);
    });

    document.getElementById("k-sentence-vi").textContent = item.vi || "Bấm Dịch câu để xem nghĩa tiếng Việt";
    document.getElementById("k-score-label").textContent = `Điểm phát âm: Sẵn sàng (Đạt ≥ ${state.config.passThreshold || 70}%)`;
    document.getElementById("k-heard-words").textContent = "";
  }

  function playCurrentSample() {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    wordEls.forEach((el, idx) => {
      setTimeout(() => {
        wordEls.forEach(w => w.classList.remove("active"));
        el.classList.add("active");
      }, idx * 300);
    });
    setTimeout(() => wordEls.forEach(w => w.classList.remove("active")), wordEls.length * 300 + 300);

    if (item.audio_url) {
      try {
        const native = getRobotNative();
        if (native) native.stopListening().catch(() => {});
        state.isSpeaking = true;
        state.isListening = false;
        setRobotMood("speaking");

        state.audioPlayer.pause();
        state.audioPlayer.src = item.audio_url;
        state.audioPlayer.playbackRate = state.config.speechRate;
        state.audioPlayer.onended = () => onSamplePlaybackFinished();
        state.audioPlayer.onerror = () => speakFeedback(item.en, "en-US", true);
        state.audioPlayer.play().catch(() => speakFeedback(item.en, "en-US", true));
        return;
      } catch (_) {}
    }
    speakFeedback(item.en, "en-US", true);
  }

  function startLessonPronunciationCheck() {
    state.isRecordingLesson = true;
    state.recordStartedAt = Date.now();
    state.isListening = true;
    state.listenSessionId += 1;
    setRobotMood("listening");
    document.getElementById("k-score-label").textContent = "🎙️ Đang nghe bé đọc tiếng Anh...";
    const native = getRobotNative();
    if (native) {
      native.startListening({ lang: "en-US" }).catch(() => {
        state.isRecordingLesson = false;
        state.isListening = false;
      });
    }
  }

  function evaluateEnglishPronunciation(spokenText) {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    const cleanTarget = normalizeEnglishWords(item.en);
    const cleanSpoken = normalizeEnglishWords(spokenText);

    // Tô màu từng từ hiển thị trên màn hình
    const rawTargetWords = item.en.split(/\s+/).filter(Boolean);
    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    rawTargetWords.forEach((rawW, idx) => {
      const normParts = normalizeEnglishWords(rawW);
      const ok = normParts.length > 0 && normParts.every(p => cleanSpoken.includes(p));
      if (wordEls[idx]) {
        wordEls[idx].classList.remove("ok", "miss");
        wordEls[idx].classList.add(ok ? "ok" : "miss");
      }
    });

    let matched = 0;
    cleanTarget.forEach(tw => {
      if (cleanSpoken.includes(tw)) matched++;
    });

    const score = cleanTarget.length > 0 ? Math.round((matched / cleanTarget.length) * 100) : 0;
    const passThreshold = Number(state.config.passThreshold) || 70;
    const isPassed = score >= passThreshold;

    document.getElementById("k-score-label").textContent = `Điểm: ${score}% / Mức đạt ${passThreshold}% (${matched}/${cleanTarget.length} từ)`;
    document.getElementById("k-heard-words").textContent = `Nghe được: "${spokenText}"`;

    if (isPassed) {
      addStarsToActiveMember(1, `Đọc chuẩn: ${item.en}`);
      sendBleCommand("M:HAPPY");
      speakFeedback(`Tuyệt vời! Bạn đạt ${score} điểm và nhận thêm 1 ngôi sao!`, "vi-VN");
      setTimeout(() => {
        if (!state.karaokeOpen) return;
        if (state.sentenceIndex < state.sentences.length - 1) {
          state.sentenceIndex += 1;
          renderCurrentSentence();
          playCurrentSample();
        } else {
          speakFeedback(`Chúc mừng bạn đã hoàn thành toàn bộ chủ đề ${state.currentTopicTitle}!`, "vi-VN");
        }
      }, 2800);
    } else {
      speakFeedback(`Bạn đạt ${score} điểm (cần ${passThreshold} điểm). Hãy đọc lại câu này nhé!`, "vi-VN");
    }
  }

  // ==================== VOICE COMMAND ROUTER (INSTANT PARTIAL + AUTO LESSON GRADING) ====================
  let lastInstantCmdNorm = "";
  let lastInstantCmdTime = 0;

  function ensureAlwaysListening() {
    if (state.isSpeaking || state.isConfiguringWifi || robotPc || isAnsweringCam) return;
    const native = getRobotNative();
    if (native && !state.isListening) {
      state.isListening = true;
      native.startListening({ lang: state.karaokeOpen ? "en-US" : "vi-VN" }).catch(() => {
        state.isListening = false;
      });
    }
  }

  function isKaraokeControlCommand(norm) {
    if (!norm) return false;
    return (
      norm.includes("nghe mau") ||
      norm.includes("doc mau") ||
      norm.includes("nghe lai") ||
      norm.includes("cau tiep") ||
      norm.includes("cau sau") ||
      norm.includes("tiep theo") ||
      norm.includes("cau truoc") ||
      norm.includes("quay lai") ||
      norm.includes("dich cau") ||
      norm.includes("nghia la gi") ||
      norm.includes("dung hoc") ||
      norm.includes("dong bang hoc") ||
      norm.includes("mo youtube") ||
      norm.includes("choi game") ||
      norm.includes("ve robot") ||
      norm.includes("so hoc tap") ||
      norm.includes("mo den") ||
      norm.includes("bat den") ||
      norm.includes("tat den") ||
      norm.includes("xoay dau") ||
      norm.includes("gat dau") ||
      norm.includes("lac dau") ||
      norm.includes("tang sang") ||
      norm.includes("giam sang")
    );
  }

  function canTriggerInstantVoiceCommand(norm) {
    if (!norm || state.isRecordingLesson || state.isSpeaking) return false;
    // Khi đang mở bảng học tiếng Anh, không cắt ngang khi bé đang đọc câu tiếng Anh
    if (state.karaokeOpen && !isKaraokeControlCommand(norm)) {
      return false;
    }
    return (
      norm === "hello" ||
      norm === "lucky" ||
      norm.includes("hello lucky") ||
      norm.includes("mo youtube") ||
      norm.includes("xem youtube") ||
      norm.includes("choi game") ||
      norm.includes("mo game") ||
      norm.includes("tro choi") ||
      norm.includes("huong dan") ||
      norm.includes("so hoc tap") ||
      norm.includes("ve robot") ||
      norm.includes("on tu kho") ||
      norm.includes("hoc ngau nhien") ||
      norm.includes("mo den dau") ||
      norm.includes("bat den dau") ||
      norm.includes("tat den dau") ||
      norm.includes("mo den tay") ||
      norm.includes("bat den tay") ||
      norm.includes("tat den tay") ||
      norm.includes("xoay dau") ||
      norm.includes("gat dau") ||
      norm.includes("lac dau") ||
      norm.includes("tang sang") ||
      norm.includes("giam sang") ||
      norm.includes("dich cau") ||
      norm.includes("nghia la gi") ||
      norm.includes("nghe mau") ||
      norm.includes("doc mau") ||
      norm.includes("cau tiep") ||
      norm.includes("cau truoc") ||
      norm.includes("dung hoc")
    );
  }

  function handleVoiceTranscript(rawText) {
    const text = (rawText || "").trim();
    if (!text) return;
    document.getElementById("user-heard-line").textContent = `🗣️ Bạn nói: "${text}"`;

    const norm = normalizeVietnamese(text);
    resetIdleTimer();

    // 1. Khi đang mở bài học tiếng Anh: tự động chấm điểm bất kỳ câu đọc nào không phải lệnh điều khiển
    if (state.karaokeOpen && (state.isRecordingLesson || !isKaraokeControlCommand(norm))) {
      state.isRecordingLesson = false;
      evaluateEnglishPronunciation(text);
      return;
    }
    state.isRecordingLesson = false;

    // 2. Xử lý các lệnh điều khiển bằng giọng nói
    if (norm === "hello" || norm === "lucky" || norm === "hello lucky") {
      wakeRobot(true);
      return;
    }

    if (norm.includes("youtube")) {
      switchTab("youtube");
      return;
    }
    if (norm.includes("choi game") || norm.includes("tro choi") || norm.includes("mo game")) {
      switchTab("game");
      return;
    }
    if (norm.includes("huong dan")) {
      switchTab("guide");
      return;
    }
    if (norm.includes("ve robot") || norm.includes("man hinh chinh")) {
      switchTab("robot");
      return;
    }
    if (norm.includes("so hoc tap") || norm.includes("on tu kho")) {
      switchTab("topics");
      return;
    }
    if (norm.includes("hoc ngau nhien")) {
      if (state.topics.length > 0) {
        const rnd = state.topics[Math.floor(Math.random() * state.topics.length)];
        loadTopicLessons(rnd.topic, "random");
      }
      return;
    }
    if (norm.includes("hoc chu de") || norm.includes("muon hoc")) {
      const numMatch = norm.match(/\d+/);
      if (numMatch && state.topics.length > 0) {
        const idx = parseInt(numMatch[0], 10) - 1;
        if (state.topics[idx]) {
          loadTopicLessons(state.topics[idx].topic, "sequential");
          return;
        }
      }
      const matchedTopic = state.topics.find(t =>
        norm.includes(normalizeVietnamese(t.title)) || norm.includes(normalizeVietnamese(t.topic))
      );
      if (matchedTopic) {
        loadTopicLessons(matchedTopic.topic, "sequential");
      } else {
        switchTab("topics");
        speakFeedback("Mình đã mở Sổ học chủ đề rồi, bạn chọn chủ đề muốn học nhé!", "vi-VN");
      }
      return;
    }
    if (norm.includes("nghe mau") || norm.includes("doc mau") || norm.includes("nghe lai")) {
      if (state.karaokeOpen) playCurrentSample();
      return;
    }
    if (norm.includes("cau tiep") || norm.includes("cau sau") || norm.includes("tiep theo")) {
      if (state.karaokeOpen && state.sentenceIndex < state.sentences.length - 1) {
        state.sentenceIndex += 1;
        renderCurrentSentence();
        playCurrentSample();
      }
      return;
    }
    if (norm.includes("cau truoc") || norm.includes("quay lai")) {
      if (state.karaokeOpen && state.sentenceIndex > 0) {
        state.sentenceIndex -= 1;
        renderCurrentSentence();
        playCurrentSample();
      }
      return;
    }
    if (norm.includes("dung hoc") || norm.includes("dong bang hoc")) {
      toggleKaraokePanel(false);
      return;
    }
    if (norm.includes("dich cau") || norm.includes("nghia la gi")) {
      const cur = state.sentences[state.sentenceIndex];
      if (cur) speakFeedback(`Câu này có nghĩa là: ${cur.vi || "Chưa có bản dịch"}`, "vi-VN");
      return;
    }
    if (norm.includes("mo den dau") || norm.includes("bat den dau")) {
      setHeadLight(true);
      speakFeedback("Đã bật đèn đầu rồi nhé!", "vi-VN");
      return;
    }
    if (norm.includes("tat den dau")) {
      setHeadLight(false);
      speakFeedback("Đã tắt đèn đầu!", "vi-VN");
      return;
    }
    if (norm.includes("mo den tay") || norm.includes("bat den tay")) {
      setArmLight(true);
      speakFeedback("Đã bật đèn tay rồi nhé!", "vi-VN");
      return;
    }
    if (norm.includes("tat den tay")) {
      setArmLight(false);
      speakFeedback("Đã tắt đèn tay!", "vi-VN");
      return;
    }
    if (norm.includes("xoay dau") || norm.includes("gat dau") || norm.includes("lac dau")) {
      sendBleCommand("M:HEAD_SWEEP:2");
      speakFeedback("Mình xoay đầu ngay đây!", "vi-VN");
      return;
    }
    if (norm.includes("tang sang")) {
      state.config.brightness = Math.min(100, state.config.brightness + 20);
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
      speakFeedback(`Đã tăng độ sáng lên ${state.config.brightness} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("giam sang")) {
      state.config.brightness = Math.max(15, state.config.brightness - 20);
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
      speakFeedback(`Đã giảm độ sáng xuống ${state.config.brightness} phần trăm!`, "vi-VN");
      return;
    }
  }

  // ==================== 1. WI-FI SCANNER & 100% IN-APP VERIFIED CONNECT ====================
  let wifiVerifyTimer = null;

  function isLocalWifiIp(ip) {
    if (!ip || ip === "0.0.0.0") return false;
    return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  }

  function cleanSsidName(raw) {
    return (raw || "").replace(/^"+|"+$/g, "").trim();
  }

  function stopWifiVerifyPolling() {
    if (wifiVerifyTimer) {
      clearInterval(wifiVerifyTimer);
      wifiVerifyTimer = null;
    }
  }

  function renderWifiList() {
    const box = document.getElementById("wifi-scan-list");
    if (!box) return;

    if (!state.wifiScannedList || state.wifiScannedList.length === 0) {
      box.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">Không tìm thấy mạng Wi-Fi nào. Hãy bật Wi-Fi trên máy và bấm "Quét Wi-Fi".</div>`;
      return;
    }

    box.innerHTML = "";
    state.wifiScannedList.forEach(net => {
      const row = document.createElement("div");
      const isSelected = net.ssid === state.selectedWifiSsid;
      row.className = `scan-item ${isSelected ? "selected" : ""}`;
      row.innerHTML = `
        <div class="scan-item-main">
          <div class="scan-item-title">${net.secured ? "🔒" : "🔓"} ${net.ssid}</div>
          <div class="scan-item-sub">Sóng: ${net.signalPct || 80}% (${net.level || -55} dBm) • Băng tần ${net.band || "2.4GHz"}</div>
        </div>
        <span class="scan-badge ${net.connected ? "connected" : ""}">${net.connected ? "✓ Đang dùng" : (net.secured ? "WPA2" : "Mở")}</span>
      `;
      row.addEventListener("click", () => {
        state.selectedWifiSsid = net.ssid;
        document.getElementById("wifi-ssid-input").value = net.ssid;
        document.getElementById("wifi-pass-input").value = "";
        renderWifiList();

        if (net.secured) {
          openVirtualKeyboard("wifi-pass-input", "qwerty", `Mật khẩu Wi-Fi: ${net.ssid}`, () => {
            connectSelectedWifi();
          });
        } else {
          connectSelectedWifi();
        }
      });
      box.appendChild(row);
    });
  }

  async function scanWifiList() {
    const box = document.getElementById("wifi-scan-list");
    if (box && (!state.wifiScannedList || state.wifiScannedList.length === 0)) {
      box.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">🔄 Đang quét các mạng Wi-Fi xung quanh...</div>`;
    }

    const native = getRobotNative();
    if (!native || typeof native.scanWifiNetworks !== "function") {
      if (box) {
        box.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">Chức năng quét Wi-Fi hoạt động trên ứng dụng Android APK.</div>`;
      }
      return;
    }

    try {
      const res = await native.scanWifiNetworks();
      state.wifiScannedList = Array.isArray(res?.networks) ? res.networks : [];
      const curSsid = cleanSsidName(res?.currentSsid);
      if (curSsid && !curSsid.toLowerCase().includes("unknown")) {
        document.getElementById("wifi-modal-current").textContent = `Mạng hiện tại: ${curSsid}`;
      }
      renderWifiList();
    } catch (err) {
      if (box) {
        box.innerHTML = `<div class="error-text" style="padding:12px;">Lỗi quét Wi-Fi: ${err?.message || "Hãy bật Vị trí (GPS) & Wi-Fi rồi bấm Cấp quyền"}</div>`;
      }
    }
  }

    async function verifyWifiConnectionOnce(targetSsid) {
    const native = getRobotNative();
    const fb = document.getElementById("wifi-connect-feedback");
    if (!native || typeof native.getDeviceStatus !== "function") return false;

    try {
      const st = await native.getDeviceStatus();
      const curSsid = cleanSsidName(st?.wifiSsid);
      const localIp = (st?.localIp || "").trim();

      const isMaskedConnected = curSsid === "Đã kết nối Wi-Fi";
      const ssidMatched = isMaskedConnected
        ? true
        : (targetSsid
            ? curSsid.toLowerCase() === targetSsid.toLowerCase()
            : (curSsid && !curSsid.toLowerCase().includes("unknown") && !curSsid.toLowerCase().includes("chưa")));

      if (ssidMatched && isLocalWifiIp(localIp)) {
        stopWifiVerifyPolling();
        state.isConfiguringWifi = false;
        const displaySsid = isMaskedConnected && targetSsid ? targetSsid : curSsid;
        if (fb) {
          fb.textContent = `✅ Đã kết nối thành công Wi-Fi "${displaySsid}" (IP: ${localIp})`;
          fb.className = "sub-text";
          fb.style.color = "#4ade80";
          fb.classList.remove("hidden");
        }
        refreshDeviceTelemetry();
        scanWifiList();
        return true;
      }
    } catch (_) {}
    return false;
  }


  async function connectSelectedWifi() {
    const ssid = (document.getElementById("wifi-ssid-input")?.value || "").trim();
    const password = document.getElementById("wifi-pass-input")?.value || "";
    const fb = document.getElementById("wifi-connect-feedback");

    if (!ssid) {
      if (fb) {
        fb.textContent = "⚠️ Vui lòng chọn một mạng Wi-Fi từ danh sách bên trên.";
        fb.className = "error-text";
        fb.classList.remove("hidden");
      }
      return;
    }

    stopWifiVerifyPolling();
    state.isConfiguringWifi = true;

    if (fb) {
      fb.textContent = `⏳ Đang kết nối tự động tới "${ssid}" trong app... (Nếu có thông báo trên thanh trạng thái, hãy bấm Cho phép)`;
      fb.className = "sub-text";
      fb.style.color = "#fbbf24";
      fb.classList.remove("hidden");
    }

    const native = getRobotNative();
    if (!native || typeof native.connectWifi !== "function") {
      state.isConfiguringWifi = false;
      return;
    }

    try {
      const res = await native.connectWifi({ ssid, password });
      if (res && res.connected && isLocalWifiIp(res.ip)) {
        state.isConfiguringWifi = false;
        if (fb) {
          fb.textContent = `✅ Đã kết nối thành công Wi-Fi "${ssid}" (IP: ${res.ip})`;
          fb.style.color = "#4ade80";
        }
        refreshDeviceTelemetry();
        scanWifiList();
        return;
      }

      // Kiểm tra liên tục mỗi 1.2 giây cho tới khi Android hoàn tất kết nối ngầm
      let checks = 0;
      wifiVerifyTimer = setInterval(async () => {
        checks += 1;
        const ok = await verifyWifiConnectionOnce(ssid);
        if (ok || checks >= 12) {
          stopWifiVerifyPolling();
          state.isConfiguringWifi = false;
          if (!ok && fb) {
            fb.textContent = `⚠️ Android đang chờ xác nhận hoặc sai mật khẩu. Hãy kiểm tra thông báo trên cùng hoặc bấm "Bảng Wi-Fi Android" (mật khẩu đã chép sẵn).`;
            fb.className = "error-text";
            fb.style.color = "";
          }
        }
      }, 1200);
    } catch (err) {
      state.isConfiguringWifi = false;
      if (fb) {
        fb.textContent = `❌ ${err?.message || "Kết nối Wi-Fi thất bại."}`;
        fb.className = "error-text";
        fb.style.color = "";
      }
    }
  }

  function openWifiModal() {
    const fb = document.getElementById("wifi-connect-feedback");
    if (fb) fb.classList.add("hidden");
    document.getElementById("wifi-modal").classList.remove("hidden");
    refreshDeviceTelemetry();
    scanWifiList();
  }

  // ==================== 2. DUAL-MODE BLUETOOTH SCANNER & CONNECTOR ====================
  function updateBleHeaderAndModalUI() {
    const pill = document.getElementById("hdr-ble-pill");
    const hdrTxt = document.getElementById("hdr-ble-text");
    const detail = document.getElementById("ble-status-detail");
    const modalSt = document.getElementById("ble-modal-status");

    if (state.bleConnected) {
      if (pill) {
        pill.classList.remove("offline");
        pill.classList.add("online");
      }
      if (hdrTxt) hdrTxt.textContent = `BT: ${state.bleDeviceName || "Đã kết nối"}`;
      if (detail) detail.textContent = `Trạng thái: Đã kết nối (${state.bleDeviceName})`;
      if (modalSt) modalSt.textContent = `✅ Đã kết nối: ${state.bleDeviceName} (${state.bleDeviceId})`;
    } else {
      if (pill) {
        pill.classList.remove("online");
        pill.classList.add("offline");
      }
      if (hdrTxt) hdrTxt.textContent = "BT: Chờ";
      if (detail) detail.textContent = "Trạng thái: Chưa kết nối thiết bị Bluetooth";
      if (modalSt) modalSt.textContent = "Trạng thái: Chưa kết nối";
    }
  }

  function renderBluetoothDeviceList() {
    const listEl = document.getElementById("ble-device-list");
    if (!listEl) return;

    const devices = Object.values(state.btDiscoveredMap);
    if (devices.length === 0) {
      listEl.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">Không tìm thấy thiết bị nào. Hãy bật Bluetooth trên thiết bị kia rồi bấm "Quét thiết bị".</div>`;
      return;
    }

    devices.sort((a, b) => {
      const aEsp = /esp32|robot|lucky/i.test(a.name) ? 1 : 0;
      const bEsp = /esp32|robot|lucky/i.test(b.name) ? 1 : 0;
      if (aEsp !== bEsp) return bEsp - aEsp;
      if ((a.paired ? 1 : 0) !== (b.paired ? 1 : 0)) return (b.paired ? 1 : 0) - (a.paired ? 1 : 0);
      return (b.rssi || -80) - (a.rssi || -80);
    });

    listEl.innerHTML = "";
    devices.forEach(dev => {
      const addr = dev.address || dev.deviceId;
      const isSelected = addr === state.selectedBtAddress;
      const isConn = state.bleConnected && addr === state.bleDeviceId;
      const isEsp = /esp32|robot|lucky/i.test(dev.name);
      const isAudio = /speaker|audio|k12|jbl|sony|michio|headset|buds|airpods/i.test(dev.name);
      const icon = isEsp ? "🤖" : isAudio ? "🔊" : "📱";

      const row = document.createElement("div");
      row.className = `scan-item ${isSelected ? "selected" : ""}`;
      row.innerHTML = `
        <div class="scan-item-main">
          <div class="scan-item-title">${icon} ${dev.name}</div>
          <div class="scan-item-sub">MAC: ${addr} • Sóng: ${dev.rssi || -65} dBm ${dev.paired ? "• Đã ghép đôi" : ""}</div>
        </div>
        <span class="scan-badge ${isConn ? "connected" : ""}">${isConn ? "✓ Đã kết nối" : (dev.type || "BT")}</span>
      `;
      row.addEventListener("click", () => {
        state.selectedBtAddress = addr;
        renderBluetoothDeviceList();
      });
      listEl.appendChild(row);
    });
  }

  async function startBluetoothScan() {
    const listEl = document.getElementById("ble-device-list");
    const modalSt = document.getElementById("ble-modal-status");
    if (modalSt) modalSt.textContent = "🔄 Đang quét tất cả thiết bị Bluetooth (BLE & Classic)...";
    if (listEl && Object.keys(state.btDiscoveredMap).length === 0) {
      listEl.innerHTML = `<div class="sub-text" style="padding:14px; text-align:center;">🔄 Đang tìm điện thoại, loa Bluetooth và ESP32 gần đây...</div>`;
    }

    const native = getRobotNative();
    if (native && typeof native.scanBluetoothDevices === "function") {
      try {
        const res = await native.scanBluetoothDevices();
        if (res && Array.isArray(res.devices)) {
          res.devices.forEach(d => {
            if (d.address) state.btDiscoveredMap[d.address] = d;
          });
          if (res.devices.length > 0) {
            renderBluetoothDeviceList();
          }
        }
        return;
      } catch (err) {
        if (modalSt) modalSt.textContent = `⚠️ ${err?.message || "Lỗi quét Bluetooth"}`;
      }
    }

    const ble = getBleClient();
    if (ble) {
      try {
        await ble.initialize();
        await ble.requestLEScan({ allowDuplicates: false }, result => {
          const id = result.device?.deviceId;
          if (!id) return;
          state.btDiscoveredMap[id] = {
            address: id,
            deviceId: id,
            name: result.device?.name || result.localName || `Thiết bị BLE (${id})`,
            rssi: result.rssi || -65,
            type: "BLE",
            paired: false
          };
          renderBluetoothDeviceList();
        });
        setTimeout(() => {
          ble.stopLEScan().catch(() => {});
          if (modalSt) modalSt.textContent = `Tìm thấy ${Object.keys(state.btDiscoveredMap).length} thiết bị Bluetooth.`;
          renderBluetoothDeviceList();
        }, 8000);
      } catch (err) {
        if (modalSt) modalSt.textContent = `Lỗi BLE: ${err?.message || "Chưa bật Bluetooth"}`;
      }
    }
  }

  async function connectSelectedBluetoothDevice() {
    const addr = state.selectedBtAddress || Object.keys(state.btDiscoveredMap)[0];
    if (!addr) {
      document.getElementById("ble-modal-status").textContent = "⚠️ Hãy bấm Quét thiết bị và chọn 1 thiết bị trong danh sách.";
      return;
    }

    const dev = state.btDiscoveredMap[addr] || { address: addr, name: addr };
    const pin = document.getElementById("ble-pin-input")?.value || "";
    const autoRec = !!document.getElementById("ble-auto-reconnect")?.checked;
    document.getElementById("ble-modal-status").textContent = `⏳ Đang kết nối tới ${dev.name}...`;

    const native = getRobotNative();
    if (native && typeof native.connectBluetoothDevice === "function") {
      try {
        const res = await native.connectBluetoothDevice({
          address: addr,
          name: dev.name,
          pin
        });
        if (res && res.connected) {
          state.bleConnected = true;
          state.bleDeviceId = addr;
          state.bleDeviceName = dev.name;
          state.config.bleAutoReconnect = autoRec;
          state.config.savedBleAddress = addr;
          state.config.savedBleName = dev.name;
          state.config.savedBlePin = pin;
          saveLocalState();
          updateBleHeaderAndModalUI();
          renderBluetoothDeviceList();
          return;
        }
      } catch (err) {
        document.getElementById("ble-modal-status").textContent = `❌ ${err?.message || "Kết nối thất bại"}`;
        return;
      }
    }

    const ble = getBleClient();
    if (ble) {
      try {
        await ble.connect(addr, () => {
          state.bleConnected = false;
          updateBleHeaderAndModalUI();
        });
        state.bleConnected = true;
        state.bleDeviceId = addr;
        state.bleDeviceName = dev.name;
        saveLocalState();
        updateBleHeaderAndModalUI();
        renderBluetoothDeviceList();
      } catch (err) {
        document.getElementById("ble-modal-status").textContent = `❌ Lỗi BLE: ${err?.message || "Đã hủy"}`;
      }
    }
  }

  async function disconnectAndForgetBluetooth() {
    const native = getRobotNative();
    if (native && typeof native.disconnectBluetoothDevice === "function") {
      await native.disconnectBluetoothDevice().catch(() => {});
    }
    const ble = getBleClient();
    if (ble && state.bleDeviceId) {
      await ble.disconnect(state.bleDeviceId).catch(() => {});
    }
    state.bleConnected = false;
    state.bleDeviceId = "";
    state.bleDeviceName = "";
    state.config.savedBleAddress = "";
    state.config.savedBleName = "";
    saveLocalState();
    updateBleHeaderAndModalUI();
    renderBluetoothDeviceList();
  }

  async function sendBleCommand(cmd) {
    if (!state.bleConnected) return;
    const native = getRobotNative();
    if (native && typeof native.sendBluetoothData === "function") {
      await native.sendBluetoothData({ cmd }).catch(() => {});
    }
    const ble = getBleClient();
    if (ble && state.bleDeviceId) {
      try {
        const encoder = new TextEncoder();
        const dataView = new DataView(encoder.encode(cmd + "\n").buffer);
        await ble.write(state.bleDeviceId, ESP_SERVICE_UUID, ESP_CHAR_TX_UUID, dataView);
      } catch (_) {}
    }
  }

  function handleEspHardwareEvent(msg) {
    const clean = (msg || "").trim().toUpperCase();
    if (!clean) return;
    if (clean.includes("TOUCH_HEAD") || clean.includes("PIR_WAKE")) {
      wakeRobot(true);
    } else if (clean.includes("BTN_1")) {
      playCurrentSample();
    } else if (clean.includes("BTN_2")) {
      startLessonPronunciationCheck();
    } else if (clean.includes("BTN_3")) {
      if (state.sentenceIndex < state.sentences.length - 1) {
        state.sentenceIndex += 1;
        renderCurrentSentence();
      }
    } else if (clean.includes("BTN_4")) {
      const cur = state.sentences[state.sentenceIndex];
      if (cur && cur.vi) speakFeedback(cur.vi, "vi-VN");
    }
  }

  function setHeadLight(on) {
    state.headLightOn = on;
    const el = document.getElementById("head-led-indicator");
    if (el) {
      el.textContent = `💡 Đèn đầu: ${on ? "Bật" : "Tắt"}`;
      el.classList.toggle("on", on);
    }
    sendBleCommand(on ? "L:HEAD_ON" : "L:HEAD_OFF");
  }

  function setArmLight(on) {
    state.armLightOn = on;
    const el = document.getElementById("arm-led-indicator");
    if (el) {
      el.textContent = `🦾 Đèn tay: ${on ? "Bật" : "Tắt"}`;
      el.classList.toggle("on", on);
    }
    sendBleCommand(on ? "L:ARM_ON" : "L:ARM_OFF");
  }

  // ==================== 3. SHARED VIRTUAL KEYBOARD (NUMPAD & QWERTY) ====================
  const vkbState = {
    targetInputId: "",
    layout: "qwerty",
    shift: false,
    masked: true,
    onConfirm: null
  };

  function renderVirtualKeyboardKeys() {
    const container = document.getElementById("vkb-keys-container");
    const preview = document.getElementById("vkb-preview-input");
    if (!container || !preview) return;

    const targetEl = document.getElementById(vkbState.targetInputId);
    preview.value = targetEl ? targetEl.value : "";
    preview.type = vkbState.masked ? "password" : "text";

    container.innerHTML = "";
    const rows = vkbState.layout === "numpad"
      ? [
          ["1", "2", "3"],
          ["4", "5", "6"],
          ["7", "8", "9"],
          ["CLR", "0", "DEL", "OK"]
        ]
      : [
          ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
          ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
          ["a", "s", "d", "f", "g", "h", "j", "k", "l", "@"],
          ["SHIFT", "z", "x", "c", "v", "b", "n", "m", "_", "-"],
          ["CLR", "SPACE", ".", "DEL", "OK"]
        ];

    rows.forEach(rowKeys => {
      const rowDiv = document.createElement("div");
      rowDiv.className = "vkb-row";
      rowKeys.forEach(k => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vkb-key";

        let label = k;
        if (k === "SHIFT") {
          label = vkbState.shift ? "⬆ HOA" : "⬆ thường";
          btn.classList.add("wide");
        } else if (k === "SPACE") {
          label = "Dấu cách";
          btn.classList.add("space");
        } else if (k === "DEL") {
          label = "⌫";
          btn.classList.add("wide");
        } else if (k === "CLR") {
          label = "Xóa";
          btn.classList.add("wide");
        } else if (k === "OK") {
          label = "✓ Xác nhận";
          btn.classList.add("confirm");
        } else if (/^[a-z]$/.test(k)) {
          label = vkbState.shift ? k.toUpperCase() : k;
        }

        btn.textContent = label;
        btn.addEventListener("click", () => {
          const inp = document.getElementById(vkbState.targetInputId);
          if (!inp) return;

          if (k === "SHIFT") {
            vkbState.shift = !vkbState.shift;
            renderVirtualKeyboardKeys();
            return;
          }
          if (k === "CLR") {
            inp.value = "";
          } else if (k === "DEL") {
            inp.value = inp.value.slice(0, -1);
          } else if (k === "SPACE") {
            inp.value += " ";
          } else if (k === "OK") {
            closeVirtualKeyboard();
            if (typeof vkbState.onConfirm === "function") {
              vkbState.onConfirm(inp.value);
            }
            return;
          } else {
            const ch = /^[a-z]$/.test(k) && vkbState.shift ? k.toUpperCase() : k;
            inp.value += ch;
          }
          preview.value = inp.value;
        });
        rowDiv.appendChild(btn);
      });
      container.appendChild(rowDiv);
    });
  }

  function openVirtualKeyboard(targetInputId, layout = "qwerty", title = "⌨️ Bàn phím ảo", onConfirm = null) {
    vkbState.targetInputId = targetInputId;
    vkbState.layout = layout;
    vkbState.shift = false;
    vkbState.masked = true;
    vkbState.onConfirm = onConfirm;
    document.getElementById("vkb-title").textContent = title;
    renderVirtualKeyboardKeys();
    document.getElementById("virtual-kb-modal").classList.remove("hidden");
  }

  function closeVirtualKeyboard() {
    document.getElementById("virtual-kb-modal").classList.add("hidden");
  }

  // ==================== 4. QR CODE & WEBRTC P2P REMOTE CAMERA ====================
  function renderCameraQrCode() {
    const camUrl = buildApiUrl("camera_live.php", { uid: state.deviceUid });
    const urlInp = document.getElementById("camera-live-url-input");
    if (urlInp) urlInp.value = camUrl;

    const qrSlot = document.getElementById("camera-qr-code");
    if (qrSlot && window.RobotQR) {
      window.RobotQR.render(qrSlot, camUrl, 126);
    }
  }

  let robotPc = null;
  let robotCamStream = null;
  let isAnsweringCam = false;
  let appliedViewerIceCount = 0;

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  async function camApiPost(action, payload = {}) {
    const url = buildApiUrl("camera_live.php", { api: 1, uid: state.deviceUid, action });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: state.deviceUid, role: "robot", action, ...payload })
    });
    return res.json();
  }

  function stopRobotP2PCamera() {
    if (robotPc) {
      try { robotPc.close(); } catch (_) {}
      robotPc = null;
    }
    if (robotCamStream) {
      try { robotCamStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      robotCamStream = null;
    }
    isAnsweringCam = false;
    appliedViewerIceCount = 0;

    const statusEl = document.getElementById("cam-signaling-status");
    if (statusEl) statusEl.textContent = "🟢 Sẵn sàng kết nối từ xa (24/7)";

    setTimeout(() => {
      if (!state.isSpeaking && !state.isRecordingLesson) {
        ensureAlwaysListening();
      }
    }, 450);
  }

  async function handleIncomingViewerCall(offerSdp) {
    if (isAnsweringCam || robotPc) return;
    isAnsweringCam = true;
    appliedViewerIceCount = 0;

    try {
      stopAllSpeechAndMic();
      if (state.camPreviewStream) {
        try { state.camPreviewStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        state.camPreviewStream = null;
        const previewEl = document.getElementById("cam-preview-video");
        if (previewEl) previewEl.classList.add("hidden");
      }

      await new Promise(resolve => setTimeout(resolve, 350));

      try {
        robotCamStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: true
        });
      } catch (mediaErr) {
        robotCamStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false
        });
      }

      robotPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      robotCamStream.getTracks().forEach(t => robotPc.addTrack(t, robotCamStream));

      robotPc.onicecandidate = ev => {
        if (ev.candidate) {
          camApiPost("ice", { candidate: ev.candidate.toJSON() }).catch(() => {});
        }
      };
      robotPc.onconnectionstatechange = () => {
        if (robotPc && ["disconnected", "failed", "closed"].includes(robotPc.connectionState)) {
          stopRobotP2PCamera();
        }
      };

      await robotPc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      const answer = await robotPc.createAnswer();
      await robotPc.setLocalDescription(answer);
      await camApiPost("robot_answer", { sdp: { type: answer.type, sdp: answer.sdp } });

      const statusEl = document.getElementById("cam-signaling-status");
      if (statusEl) statusEl.textContent = "🔴 Đang truyền hình trực tiếp tới người thân...";
    } catch (_) {
      stopRobotP2PCamera();
    } finally {
      isAnsweringCam = false;
    }
  }

  function startGlobalCameraSignalingPoller() {
    setInterval(async () => {
      if (!state.deviceUid) return;
      try {
        const data = await fetchServerJson("camera_live.php", {
          api: 1,
          uid: state.deviceUid,
          action: "poll",
          role: "robot",
          t: Date.now()
        });
        if (!data || data.status !== "ok" || !data.session) return;
        const sess = data.session;

        if (sess.state === "ringing" && sess.offer && !robotPc && !isAnsweringCam) {
          await handleIncomingViewerCall(sess.offer);
        }
        if (robotPc && Array.isArray(sess.viewer_ice) && sess.viewer_ice.length > appliedViewerIceCount) {
          for (let i = appliedViewerIceCount; i < sess.viewer_ice.length; i++) {
            try {
              await robotPc.addIceCandidate(new RTCIceCandidate(sess.viewer_ice[i]));
            } catch (_) {}
          }
          appliedViewerIceCount = sess.viewer_ice.length;
        }
        if (robotPc && (sess.state === "cooldown" || sess.state === "idle")) {
          stopRobotP2PCamera();
        }
      } catch (_) {}
    }, 3000);
  }

  // ==================== SETTINGS UI, KIOSK & TELEMETRY ====================
  function syncSettingsUI() {
    document.getElementById("set-study-only").checked = !!state.config.studyOnly;
    const passSelect = document.getElementById("set-pass-threshold");
    if (passSelect) {
      passSelect.value = String(state.config.passThreshold || 70);
    }
    document.getElementById("set-bedtime").value = state.config.bedtime || "21:30";
    document.getElementById("set-brightness").value = state.config.brightness;
    document.getElementById("val-brightness").textContent = `${state.config.brightness}%`;
    document.getElementById("set-volume").value = state.config.volume;
    document.getElementById("val-volume").textContent = `${state.config.volume}%`;
    document.getElementById("set-rate").value = state.config.speechRate;
    document.getElementById("val-rate").textContent = `${state.config.speechRate}x`;
    document.getElementById("set-base-url").value = getServerBase();
    renderMembersSettingsList();
    updateBleHeaderAndModalUI();
  }

  function renderMembersSettingsList() {
    const list = document.getElementById("members-list");
    if (!list) return;
    list.innerHTML = "";
    state.members.forEach(m => {
      const row = document.createElement("div");
      row.className = "member-item";
      row.innerHTML = `
        <span><strong>${m.avatar || "🧒"} ${m.name}</strong> (${m.age} tuổi) • ★ ${m.stars || 0}</span>
        <button type="button" class="action-btn ${m.id === state.activeMemberId ? "primary" : ""}">${m.id === state.activeMemberId ? "Đang chọn" : "Chọn"}</button>
      `;
      row.querySelector("button").addEventListener("click", () => {
        state.activeMemberId = m.id;
        saveLocalState();
        updateHeaderMemberUI();
        renderMembersSettingsList();
      });
      list.appendChild(row);
    });
  }

  function openPinModal() {
    document.getElementById("pin-modal-input").value = "";
    document.getElementById("pin-modal-error").classList.add("hidden");
    document.getElementById("pin-modal").classList.remove("hidden");
  }

  async function refreshDeviceTelemetry() {
    const native = getRobotNative();
    if (native && typeof native.getDeviceStatus === "function") {
      try {
        const st = await native.getDeviceStatus();
        const icon = st.isCharging ? "⚡" : "🔋";
        document.getElementById("hdr-battery").textContent = `${icon} ${st.battery}%`;
        document.getElementById("hdr-temp").textContent = `${Number(st.temperature).toFixed(1)}°C`;

        const curSsid = cleanSsidName(st.wifiSsid);
        const ipStr = (st.localIp || "").trim();
        const wifiText = isLocalWifiIp(ipStr) && curSsid && !curSsid.toLowerCase().includes("unknown")
          ? `${curSsid} (${ipStr})`
          : (curSsid && !curSsid.toLowerCase().includes("unknown") ? curSsid : "Chưa kết nối Wi-Fi");

        const wifiInfo = document.getElementById("set-wifi-info");
        if (wifiInfo) wifiInfo.textContent = wifiText;
        const modalCur = document.getElementById("wifi-modal-current");
        if (modalCur) modalCur.textContent = `Mạng hiện tại: ${wifiText}`;

        const lockSt = document.getElementById("dev-lock-state");
        if (lockSt) {
          lockSt.innerHTML = st.kioskLocked
            ? `Trạng thái Kiosk: <strong style="color:#f59e0b;">ĐANG GHIM MÀN HÌNH</strong>`
            : `Trạng thái Kiosk: <strong style="color:#22c55e;">ĐANG MỞ (KHÔNG GHIM)</strong>`;
        }
        return;
      } catch (_) {}
    }

    if (navigator.getBattery) {
      try {
        const bat = await navigator.getBattery();
        document.getElementById("hdr-battery").textContent = `${bat.charging ? "⚡" : "🔋"} ${Math.round(bat.level * 100)}%`;
      } catch (_) {}
    }
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
    document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document.getElementById("btn-refresh-frame").addEventListener("click", () => {
      const m = getActiveMember();
      if (state.activeTab === "youtube") {
        document.getElementById("frame-youtube").src = buildApiUrl("youtube.php", { uid: m.uid, stars: m.stars, r: Date.now() });
      } else if (state.activeTab === "game") {
        document.getElementById("frame-game").src = buildApiUrl("games.php", { uid: m.uid, stars: m.stars, r: Date.now() });
      }
    });

    document.getElementById("hdr-ble-pill").addEventListener("click", () => {
      document.getElementById("ble-modal").classList.remove("hidden");
      startBluetoothScan();
    });

    document.getElementById("member-badge").addEventListener("click", () => {
      const grid = document.getElementById("quick-member-grid");
      grid.innerHTML = "";
      state.members.forEach(m => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `action-btn ${m.id === state.activeMemberId ? "primary" : ""}`;
        btn.textContent = `${m.avatar || "🧒"} ${m.name} (★ ${m.stars || 0})`;
        btn.addEventListener("click", () => {
          state.activeMemberId = m.id;
          saveLocalState();
          updateHeaderMemberUI();
          document.getElementById("member-modal").classList.add("hidden");
        });
        grid.appendChild(btn);
      });
      document.getElementById("member-modal").classList.remove("hidden");
    });
    document.getElementById("btn-member-close").addEventListener("click", () => {
      document.getElementById("member-modal").classList.add("hidden");
    });

    document.getElementById("robot-head").addEventListener("click", () => wakeRobot(true));
    document.getElementById("btn-toggle-karaoke").addEventListener("click", () => toggleKaraokePanel(!state.karaokeOpen));
    document.getElementById("btn-close-karaoke").addEventListener("click", () => toggleKaraokePanel(false));
    document.getElementById("btn-quick-talk").addEventListener("click", () => {
      wakeRobot(false);
      speakFeedback("Mình đang nghe đây! Bạn muốn học chủ đề nào?", "vi-VN");
    });

    document.getElementById("btn-k-prev").addEventListener("click", () => {
      if (state.sentenceIndex > 0) {
        state.sentenceIndex -= 1;
        renderCurrentSentence();
      }
    });
    document.getElementById("btn-k-next").addEventListener("click", () => {
      if (state.sentenceIndex < state.sentences.length - 1) {
        state.sentenceIndex += 1;
        renderCurrentSentence();
      }
    });
    document.getElementById("btn-k-listen").addEventListener("click", playCurrentSample);
    document.getElementById("btn-k-replay").addEventListener("click", playCurrentSample);
    document.getElementById("btn-k-record").addEventListener("click", startLessonPronunciationCheck);

    document.getElementById("btn-sync-topics").addEventListener("click", () => loadTopicsList(true));
    document.getElementById("topic-search-input").addEventListener("input", renderTopicsGrid);
    document.getElementById("btn-review-hard-words").addEventListener("click", () => {
      if (state.topics.length > 0) {
        loadTopicLessons(state.topics[0].topic, "random");
      }
    });

    document.getElementById("btn-pin-cancel").addEventListener("click", () => {
      document.getElementById("pin-modal").classList.add("hidden");
    });
    document.getElementById("btn-pin-toggle-eye").addEventListener("click", () => {
      const inp = document.getElementById("pin-modal-input");
      inp.type = inp.type === "password" ? "text" : "password";
    });
    document.querySelectorAll("#pin-numpad .numpad-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const inp = document.getElementById("pin-modal-input");
        const k = btn.dataset.key;
        if (k === "CLR") inp.value = "";
        else if (k === "DEL") inp.value = inp.value.slice(0, -1);
        else inp.value += k;
      });
    });
    document.getElementById("btn-pin-confirm").addEventListener("click", () => {
      const val = document.getElementById("pin-modal-input").value.trim();
      if (val === state.config.parentPin || val === DEV_MASTER_PIN || val === "robotrobot") {
        state.settingsUnlocked = true;
        document.getElementById("pin-modal").classList.add("hidden");
        switchTab("settings");
      } else {
        document.getElementById("pin-modal-error").classList.remove("hidden");
      }
    });

    document.getElementById("btn-lock-settings").addEventListener("click", () => {
      state.settingsUnlocked = false;
      switchTab("robot");
    });

    document.getElementById("btn-add-member").addEventListener("click", () => {
      const name = document.getElementById("new-member-name").value.trim();
      if (!name) return;
      const age = parseInt(document.getElementById("new-member-age").value, 10) || 7;
      const avatar = document.getElementById("new-member-avatar").value || "🧒";
      const newMember = { id: `m_${Date.now()}`, uid: generateUid("", 20), name, age, avatar, stars: 0 };
      state.members.push(newMember);
      state.activeMemberId = newMember.id;
      document.getElementById("new-member-name").value = "";
      saveLocalState();
      updateHeaderMemberUI();
      renderMembersSettingsList();
    });

    document.getElementById("set-study-only").addEventListener("change", e => {
      state.config.studyOnly = e.target.checked;
      saveLocalState();
    });
    const passSelect = document.getElementById("set-pass-threshold");
    if (passSelect) {
      passSelect.addEventListener("change", e => {
        state.config.passThreshold = parseInt(e.target.value, 10) || 70;
        saveLocalState();
      });
    }
    document.getElementById("set-bedtime").addEventListener("change", e => {
      state.config.bedtime = e.target.value;
      saveLocalState();
    });

    document.getElementById("set-new-parent-pin").addEventListener("click", () => {
      openVirtualKeyboard("set-new-parent-pin", "numpad", "Nhập mã PIN Phụ huynh mới");
    });
    document.getElementById("btn-save-parent-pin").addEventListener("click", () => {
      const newPin = document.getElementById("set-new-parent-pin").value.trim();
      if (newPin.length >= 4) {
        state.config.parentPin = newPin;
        saveLocalState();
        document.getElementById("set-new-parent-pin").value = "";
        speakFeedback("Đã đổi mã PIN Phụ huynh thành công!", "vi-VN");
      }
    });

    document.getElementById("set-brightness").addEventListener("input", e => {
      state.config.brightness = parseInt(e.target.value, 10);
      document.getElementById("val-brightness").textContent = `${state.config.brightness}%`;
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
    });
    document.getElementById("set-volume").addEventListener("input", e => {
      state.config.volume = parseInt(e.target.value, 10);
      document.getElementById("val-volume").textContent = `${state.config.volume}%`;
      saveLocalState();
      if (getRobotNative()) getRobotNative().setVolume({ level: state.config.volume }).catch(() => {});
    });
    document.getElementById("set-rate").addEventListener("input", e => {
      state.config.speechRate = parseFloat(e.target.value);
      document.getElementById("val-rate").textContent = `${state.config.speechRate}x`;
      saveLocalState();
    });

    document.getElementById("btn-req-perms").addEventListener("click", () => {
      if (getRobotNative()) getRobotNative().requestAllPermissions().catch(() => {});
    });

    // Wi-Fi Modal events
    document.getElementById("btn-open-wifi").addEventListener("click", openWifiModal);
    document.getElementById("btn-wifi-close").addEventListener("click", () => {
      stopWifiVerifyPolling();
      state.isConfiguringWifi = false;
      document.getElementById("wifi-modal").classList.add("hidden");
    });
    document.getElementById("btn-wifi-rescan").addEventListener("click", scanWifiList);
    document.getElementById("wifi-pass-input").addEventListener("click", () => {
      const ssid = document.getElementById("wifi-ssid-input").value || "Wi-Fi";
      openVirtualKeyboard("wifi-pass-input", "qwerty", `Mật khẩu Wi-Fi: ${ssid}`, () => {
        connectSelectedWifi();
      });
    });
    document.getElementById("btn-wifi-toggle-eye").addEventListener("click", () => {
      const inp = document.getElementById("wifi-pass-input");
      inp.type = inp.type === "password" ? "text" : "password";
    });
    document.getElementById("btn-wifi-connect").addEventListener("click", connectSelectedWifi);
    document.getElementById("btn-wifi-android-panel").addEventListener("click", () => {
      state.isConfiguringWifi = true;
      if (getRobotNative()) getRobotNative().openWifiSettings().catch(() => {});
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.isConfiguringWifi) {
        const target = (document.getElementById("wifi-ssid-input")?.value || "").trim();
        verifyWifiConnectionOnce(target);
      }
    });

    // Bluetooth Modal events
    document.getElementById("btn-ble-scan").addEventListener("click", () => {
      document.getElementById("ble-modal").classList.remove("hidden");
      startBluetoothScan();
    });
    document.getElementById("btn-ble-close").addEventListener("click", () => {
      if (getRobotNative()) getRobotNative().stopBluetoothScan().catch(() => {});
      document.getElementById("ble-modal").classList.add("hidden");
    });
    document.getElementById("btn-ble-modal-scan").addEventListener("click", startBluetoothScan);
    document.getElementById("ble-pin-input").addEventListener("click", () => {
      openVirtualKeyboard("ble-pin-input", "numpad", "Nhập mã PIN / Mật khẩu Bluetooth");
    });
    document.getElementById("btn-ble-connect-selected").addEventListener("click", connectSelectedBluetoothDevice);
    document.getElementById("btn-ble-forget").addEventListener("click", disconnectAndForgetBluetooth);

    document.getElementById("btn-test-head-light").addEventListener("click", () => setHeadLight(!state.headLightOn));
    document.getElementById("btn-test-arm-light").addEventListener("click", () => setArmLight(!state.armLightOn));
    document.getElementById("btn-test-head-turn").addEventListener("click", () => sendBleCommand("M:HEAD_SWEEP:2"));

    document.getElementById("btn-copy-cam-url").addEventListener("click", async () => {
      const val = document.getElementById("camera-live-url-input").value;
      try {
        await navigator.clipboard.writeText(val);
        document.getElementById("cam-signaling-status").textContent = "✅ Đã sao chép link Camera!";
      } catch (_) {}
    });

    document.getElementById("btn-toggle-cam-preview").addEventListener("click", async () => {
      const videoEl = document.getElementById("cam-preview-video");
      if (state.camPreviewStream) {
        state.camPreviewStream.getTracks().forEach(t => t.stop());
        state.camPreviewStream = null;
        videoEl.classList.add("hidden");
        return;
      }
      try {
        state.camPreviewStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        videoEl.srcObject = state.camPreviewStream;
        videoEl.classList.remove("hidden");
      } catch (_) {}
    });

    document.getElementById("dev-exit-code-input").addEventListener("click", () => {
      openVirtualKeyboard("dev-exit-code-input", "numpad", "Nhập mã nhà phát triển");
    });

    document.getElementById("btn-dev-lock").addEventListener("click", async () => {
      const native = getRobotNative();
      if (native) {
        await native.setKioskMode({ enabled: true }).catch(() => {});
        refreshDeviceTelemetry();
      }
    });

    document.getElementById("btn-check-pin-status").addEventListener("click", refreshDeviceTelemetry);

    document.getElementById("btn-dev-unlock").addEventListener("click", async () => {
      const code = (document.getElementById("dev-exit-code-input").value || "").trim();
      if (code === DEV_MASTER_PIN) {
        document.getElementById("dev-exit-code-input").value = "";
        const native = getRobotNative();
        if (native) {
          await native.setKioskMode({ enabled: false }).catch(() => {});
          refreshDeviceTelemetry();
        }
        speakFeedback("Đã xác nhận mã nhà phát triển và gỡ ghim ứng dụng!", "vi-VN");
      } else {
        speakFeedback("Mã nhà phát triển không đúng!", "vi-VN");
      }
    });

    document.getElementById("vkb-close").addEventListener("click", closeVirtualKeyboard);
    document.getElementById("vkb-switch-layout").addEventListener("click", () => {
      vkbState.layout = vkbState.layout === "numpad" ? "qwerty" : "numpad";
      renderVirtualKeyboardKeys();
    });
    document.getElementById("vkb-toggle-eye").addEventListener("click", () => {
      vkbState.masked = !vkbState.masked;
      renderVirtualKeyboardKeys();
    });

    // Native Plugin Event Listeners
    const native = getRobotNative();
    if (native && typeof native.addListener === "function") {
      native.addListener("speechPartial", data => {
        const partial = (data?.text || "").trim();
        if (!partial) return;
        const heardEl = document.getElementById("user-heard-line");
        if (heardEl) heardEl.textContent = `👂 Đang nghe: "${partial}"...`;

        const norm = normalizeVietnamese(partial);
        const now = Date.now();
        if (canTriggerInstantVoiceCommand(norm)) {
          if (norm === lastInstantCmdNorm && now - lastInstantCmdTime < 2200) return;
          lastInstantCmdNorm = norm;
          lastInstantCmdTime = now;
          handleVoiceTranscript(partial);
        }
      });
      native.addListener("speechResult", data => {
        state.isListening = false;
        const finalText = (data?.text || "").trim();
        const norm = normalizeVietnamese(finalText);
        const now = Date.now();

        if (norm && norm === lastInstantCmdNorm && now - lastInstantCmdTime < 2500) {
          setTimeout(ensureAlwaysListening, 350);
          return;
        }

        if (finalText) {
          handleVoiceTranscript(finalText);
        }
        setTimeout(ensureAlwaysListening, 400);
      });
      native.addListener("speechError", () => {
        state.isListening = false;
        // Không hủy trạng thái chấm điểm nếu lỗi phát sinh ngay lúc vừa bấm nút ghi âm
        if (state.isRecordingLesson && Date.now() - state.recordStartedAt > 1200) {
          state.isRecordingLesson = false;
          setRobotMood("happy");
        }
        setTimeout(ensureAlwaysListening, 700);
      });
      native.addListener("ttsEnd", () => {
        onSamplePlaybackFinished();
      });
      native.addListener("btDeviceFound", dev => {
        const addr = dev?.address || dev?.deviceId;
        if (addr) {
          state.btDiscoveredMap[addr] = dev;
          renderBluetoothDeviceList();
        }
      });
      native.addListener("btScanFinished", data => {
        const count = Array.isArray(data?.devices) ? data.devices.length : Object.keys(state.btDiscoveredMap).length;
        const st = document.getElementById("ble-modal-status");
        if (st && !state.bleConnected) {
          st.textContent = `Đã quét xong: tìm thấy ${count} thiết bị Bluetooth.`;
        }
        renderBluetoothDeviceList();
      });
      native.addListener("btConnectionChanged", st => {
        state.bleConnected = !!st?.connected;
        if (!state.bleConnected) {
          state.bleDeviceId = "";
          state.bleDeviceName = "";
        }
        updateBleHeaderAndModalUI();
        renderBluetoothDeviceList();
      });
      native.addListener("bleHardwareData", ev => {
        handleEspHardwareEvent(ev?.data || "");
      });
    }
  }

  // ==================== BOOTSTRAP ====================
  async function initApp() {
    if (window.__robot2027Initialized) return;
    window.__robot2027Initialized = true;

    loadLocalState();
    updateHeaderMemberUI();
    bindEvents();
    startNaturalBlinkLoop();
    startIdleMonitor();
    renderCameraQrCode();

    refreshDeviceTelemetry();
    setInterval(refreshDeviceTelemetry, 10000);

    const native = getRobotNative();
    if (native) {
      await native.requestAllPermissions().catch(() => {});
      await native.setBrightness({ level: state.config.brightness }).catch(() => {});
      await native.setVolume({ level: state.config.volume }).catch(() => {});
    }

    if (state.config.bleAutoReconnect && state.config.savedBleAddress && native?.connectBluetoothDevice) {
      native.connectBluetoothDevice({
        address: state.config.savedBleAddress,
        name: state.config.savedBleName || state.config.savedBleAddress,
        pin: state.config.savedBlePin || ""
      }).then(res => {
        if (res && res.connected) {
          state.bleConnected = true;
          state.bleDeviceId = state.config.savedBleAddress;
          state.bleDeviceName = state.config.savedBleName || state.config.savedBleAddress;
          updateBleHeaderAndModalUI();
        }
      }).catch(() => {});
    }

    loadTopicsList(true);
    startGlobalCameraSignalingPoller();
    ensureAlwaysListening();
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();