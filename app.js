// Konfigurasi sumber data:
// - "firebase": live realtime dari Firebase Realtime Database (cocok untuk GitHub Pages/HTTPS)
// - "http": polling JSON dari endpoint lokal ESP32 (mis. http://192.168.x.x/data) — cocok saat dibuka via localhost di WiFi yang sama
const DATA_MODE = "firebase";

// HTTP (mode "http")
const DATA_ENDPOINT = "http://192.168.1.34/data"; // contoh: "http://192.168.1.50/data"
const POLL_INTERVAL_MS = 10000;

// Firebase Realtime Database (mode "firebase")
const firebaseConfig = {
  apiKey: "AIzaSyCwVGsogTitoABuuPRxVaj7EXX7MwUbZwI",
  authDomain: "monitoring-kualitas-udar-cffd5.firebaseapp.com",
  databaseURL: "https://monitoring-kualitas-udar-cffd5-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "monitoring-kualitas-udar-cffd5",
  storageBucket: "monitoring-kualitas-udar-cffd5.firebasestorage.app",
  messagingSenderId: "248996760386",
  appId: "1:248996760386:web:9c14dd5733ec11598396db"
};

const RTDB_PATH = "latest"; // path data yang dikirim ESP32 (PUT ke /latest.json)

const station = {
  location: "Lab Workshop, Resiskom, Universitas Tanjungpura",
  area: "Pontianak, Kalimantan Barat",
  address: "W8VW+43W, Jl. Jenderal Ahmad Yani, Bansir Laut, Kec. Pontianak Tenggara, Kota Pontianak, Kalimantan Barat 78115",
  coordinates: { lat: -0.05706330465544652, lng: 109.34515151019522 },
};

// Data contoh sesuai output serial ESP32
const sampleData = {
  pms5003: { pm25: 33.0, pm10: 41.0 },
  mq7: { adcRaw: 471, adcFiltered: 471.0, voltageMv: 838.0, coPpm: 0.14 },
  dht22: { temperature: 31.7, humidity: 76.3 },
  ispu: { pm25: 71.93, pm10: 41.0, tertinggi: 71.93, kategori: "SEDANG" },
  updatedAt: null,
};

const CATEGORY_MAP = {
  BAIK: { key: "baik", label: "Baik", desc: "Kualitas udara baik." },
  SEDANG: { key: "sedang", label: "Sedang", desc: "Kualitas udara dapat diterima; kelompok sensitif perlu waspada." },
  "TIDAK SEHAT": { key: "tidak-sehat", label: "Tidak Sehat", desc: "Kelompok sensitif dapat terganggu; kurangi aktivitas luar ruang." },
  "SANGAT TIDAK SEHAT": { key: "sangat-tidak-sehat", label: "Sangat Tidak Sehat", desc: "Berisiko bagi kesehatan; hindari aktivitas luar ruang." },
  BERBAHAYA: { key: "berbahaya", label: "Berbahaya", desc: "Darurat kesehatan; hindari paparan luar ruang." },
};

function normalizeCategory(kategori, ispuValue) {
  if (kategori) {
    const k = String(kategori).trim().toUpperCase();
    if (CATEGORY_MAP[k]) return CATEGORY_MAP[k];
  }
  const v = Number(ispuValue);
  if (!Number.isFinite(v)) return { key: "sedang", label: "Menunggu data", desc: "Menunggu data ISPU dari perangkat." };
  if (v <= 50) return CATEGORY_MAP.BAIK;
  if (v <= 100) return CATEGORY_MAP.SEDANG;
  if (v <= 200) return CATEGORY_MAP["TIDAK SEHAT"];
  if (v <= 300) return CATEGORY_MAP["SANGAT TIDAK SEHAT"];
  return CATEGORY_MAP.BERBAHAYA;
}

// Ikon wajah (gaya sederhana menyerupai indikator wajah IQAir) menyesuaikan kategori
function faceSvg(key) {
  const common = (mouth) => `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img">
      <circle cx="32" cy="32" r="28" fill="rgba(255,255,255,0.95)"/>
      <circle cx="22" cy="26" r="4" fill="#2b3a42"/>
      <circle cx="42" cy="26" r="4" fill="#2b3a42"/>
      ${mouth}
    </svg>`;
  switch (key) {
    case "baik":
      return common('<path d="M20 38c3 6 21 6 24 0" stroke="#2e7d32" stroke-width="4" fill="none" stroke-linecap="round"/>');
    case "sedang":
      return common('<line x1="22" y1="40" x2="42" y2="40" stroke="#1565c0" stroke-width="4" stroke-linecap="round"/>');
    case "tidak-sehat":
      return common('<path d="M22 42c4-4 16-4 20 0" stroke="#8d6e00" stroke-width="4" fill="none" stroke-linecap="round"/>');
    case "sangat-tidak-sehat":
      return common('<path d="M22 44c4-6 16-6 20 0" stroke="#b71c1c" stroke-width="4" fill="none" stroke-linecap="round"/>');
    case "berbahaya":
      return common('<path d="M22 44c4-6 16-6 20 0" stroke="#212121" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M18 20l6 4M46 20l-6 4" stroke="#212121" stroke-width="3" stroke-linecap="round"/>');
    default:
      return common('<line x1="22" y1="40" x2="42" y2="40" stroke="#607d8b" stroke-width="4" stroke-linecap="round"/>');
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setDataSourceStatus(state, text) {
  const chip = document.getElementById("dataSourceChip");
  const label = document.getElementById("dataSourceText");
  if (label) label.textContent = text;
  else if (chip) chip.textContent = text;
  if (!chip) return;
  chip.classList.remove("status-connected", "status-disconnected", "status-sample");
  if (state === "connected") chip.classList.add("status-connected");
  else if (state === "sample") chip.classList.add("status-sample");
  else chip.classList.add("status-disconnected");
}
function fmt(v, digits = 2) {
  if (v == null || v === "" || Number.isNaN(Number(v))) return "--";
  const n = Number(v);
  return n.toFixed(digits).replace(/\.00$/, ".00").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, digits === 0 ? "" : ".00");
}
function fmtFixed(v, digits = 2) {
  if (v == null || v === "" || Number.isNaN(Number(v))) return "--";
  return Number(v).toFixed(digits);
}
function fmtTime(value) {
  let d = null;
  if (value != null && value !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      // Angka kecil = detik sejak boot ESP32, bukan waktu nyata
      if (n > 1e11) d = new Date(n); // ms epoch
      else if (n > 1e9) d = new Date(n * 1000); // s epoch
    } else {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) d = parsed;
    }
  }
  if (!d || Number.isNaN(d.getTime())) d = new Date();
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Pontianak" }).format(d) + " WIB";
}
function merge(base, incoming) {
  if (!incoming || typeof incoming !== "object") return base;
  return {
    ...base, ...incoming,
    pms5003: { ...base.pms5003, ...(incoming.pms5003 || {}) },
    mq7: { ...base.mq7, ...(incoming.mq7 || {}) },
    dht22: { ...base.dht22, ...(incoming.dht22 || {}) },
    ispu: { ...base.ispu, ...(incoming.ispu || {}) },
  };
}

function getMainPollutant(ispu) {
  const candidates = [
    { name: "PM2.5", value: Number(ispu.pm25) },
    { name: "PM10", value: Number(ispu.pm10) },
  ].filter((c) => Number.isFinite(c.value));
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.value > a.value ? b : a));
}

function setBar(id, value, max) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = Number(value);
  const pct = Number.isFinite(v) && max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
  requestAnimationFrame(() => { el.style.width = pct + "%"; });
}

function revealOnLoad() {
  const els = document.querySelectorAll(".reveal");
  els.forEach((el, i) => setTimeout(() => el.classList.add("visible"), 80 + i * 90));
}

function render(data) {
  const ispu = data.ispu || {};
  const pms = data.pms5003 || {};
  const mq7 = data.mq7 || {};
  const dht = data.dht22 || {};

  const tertinggi = ispu.tertinggi ?? ispu.ispuTertinggi ?? Math.max(Number(ispu.pm25) || 0, Number(ispu.pm10) || 0);
  const category = normalizeCategory(ispu.kategori || ispu.kategoriUdara, tertinggi);
  const main = getMainPollutant(ispu);

  setText("locationName", station.location);
  setText("locationArea", station.area);
  setText("updatedAt", fmtTime(data.updatedAt));

  setText("ispuTertinggi", Number.isFinite(Number(tertinggi)) ? fmtFixed(tertinggi, 2) : "--");
  setText("hasilIspuTertinggi", Number.isFinite(Number(tertinggi)) ? fmtFixed(tertinggi, 2) : "--");
  setText("kategoriUdara", category.label.toUpperCase());
  setText("hasilKategori", (ispu.kategori || category.label).toString().toUpperCase());
  setText("hasilIspuPm25", Number.isFinite(Number(ispu.pm25)) ? fmtFixed(ispu.pm25, 2) : "--");
  setText("hasilIspuPm10", Number.isFinite(Number(ispu.pm10)) ? fmtFixed(ispu.pm10, 2) : "--");

  // Breakdown card: CO, Suhu, Kelembapan (sesuai permintaan)
  setText("breakdownCo", Number.isFinite(Number(mq7.coPpm)) ? fmtFixed(mq7.coPpm, 2) : "--");
  setText("breakdownSuhu", Number.isFinite(Number(dht.temperature)) ? fmtFixed(dht.temperature, 2) : "--");
  setText("breakdownKelembapan", Number.isFinite(Number(dht.humidity)) ? fmtFixed(dht.humidity, 2) : "--");

  setText("mainPollutant", main ? main.name : "--");
  if (main) {
    const conc = main.name === "PM2.5" ? pms.pm25 : pms.pm10;
    setText("mainPollutantValue", Number.isFinite(Number(conc)) ? `${fmtFixed(conc, 2)} µg/m³` : "-- µg/m³");
  } else {
    setText("mainPollutantValue", "--");
  }

  const card = document.getElementById("ispuCard");
  card.className = "card ispu-card reveal visible " + category.key;
  setHtml("faceIcon", faceSvg(category.key));

  setText("pm25", Number.isFinite(Number(pms.pm25)) ? fmtFixed(pms.pm25, 2) : "--");
  setText("pm10", Number.isFinite(Number(pms.pm10)) ? fmtFixed(pms.pm10, 2) : "--");

  setText("adcRaw", mq7.adcRaw ?? "--");
  setText("adcFiltered", Number.isFinite(Number(mq7.adcFiltered)) ? fmtFixed(mq7.adcFiltered, 2) : (mq7.adcFiltered ?? "--"));
  setText("teganganAo", Number.isFinite(Number(mq7.voltageMv)) ? fmtFixed(mq7.voltageMv, 2) : "--");
  setText("coPpm", Number.isFinite(Number(mq7.coPpm)) ? fmtFixed(mq7.coPpm, 2) : "--");

  setText("suhu", Number.isFinite(Number(dht.temperature)) ? fmtFixed(dht.temperature, 2) : "--");
  setText("kelembapan", Number.isFinite(Number(dht.humidity)) ? fmtFixed(dht.humidity, 2) : "--");

  // Animasi bar visual (skala referensi tampilan)
  setBar("barPm25", pms.pm25, 150);
  setBar("barPm10", pms.pm10, 200);
  setBar("barCo", mq7.coPpm, 10);
  setBar("barSuhu", dht.temperature, 50);
  setBar("barKelembapan", dht.humidity, 100);
}

let map, marker;
function initMap() {
  const { lat, lng } = station.coordinates;
  map = L.map("map", { scrollWheelZoom: false }).setView([lat, lng], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const popupText = `<strong>${station.location}</strong><br>${station.address || station.area}`;
  marker = L.marker([lat, lng]).addTo(map).bindPopup(popupText);
  document.getElementById("mapLink").href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

async function loadData() {
  let current = merge(structuredClone(sampleData), {});
  if (DATA_ENDPOINT) {
    try {
      const res = await fetch(DATA_ENDPOINT, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      current = merge(current, json);
      setDataSourceStatus("connected", "ESP32 (terhubung)");
    } catch (err) {
      setDataSourceStatus("disconnected", "ESP32 (terputus)");
      console.warn("Gagal memuat data ESP32:", err);
    }
  } else {
    setDataSourceStatus("sample", "Data contoh (ESP32)");
  }
  render(current);
}

const ESP32_OFFLINE_TIMEOUT_MS = 20000;

function startFirebase() {
  if (typeof firebase === "undefined") {
    setDataSourceStatus("disconnected", "ESP32 (terputus)");
    render(merge(structuredClone(sampleData), {}));
    return;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    const db = firebase.database();
    const ref = db.ref(RTDB_PATH);

    let serverTimeOffset = 0;
    let offlineTimer = null;
    let latestVal = null;
    let hasReceivedInitialSnapshot = false;
    let sawLiveUpdate = false;

    const clearOfflineTimer = () => {
      if (offlineTimer) {
        clearTimeout(offlineTimer);
        offlineTimer = null;
      }
    };

    const scheduleOfflineCheck = (delayMs) => {
      clearOfflineTimer();
      offlineTimer = setTimeout(() => {
        setDataSourceStatus("disconnected", "ESP32 (terputus)");
      }, Math.max(1000, delayMs));
    };

    const updateConnectionState = () => {
      if (!latestVal || typeof latestVal !== "object") {
        clearOfflineTimer();
        setDataSourceStatus("disconnected", "ESP32 (terputus)");
        return;
      }

      const rawUpdatedAt = Number(latestVal.updatedAt);
      const updatedAtMs = Number.isFinite(rawUpdatedAt)
        ? (rawUpdatedAt > 1e11 ? rawUpdatedAt : (rawUpdatedAt > 1e9 ? rawUpdatedAt * 1000 : null))
        : null;

      if (updatedAtMs !== null) {
        const ageMs = (Date.now() + serverTimeOffset) - updatedAtMs;
        if (ageMs <= ESP32_OFFLINE_TIMEOUT_MS) {
          setDataSourceStatus("connected", "ESP32 (terhubung)");
          scheduleOfflineCheck(ESP32_OFFLINE_TIMEOUT_MS - Math.max(0, ageMs) + 500);
        } else {
          clearOfflineTimer();
          setDataSourceStatus("disconnected", "ESP32 (terputus)");
        }
        return;
      }

      if (sawLiveUpdate) {
        setDataSourceStatus("connected", "ESP32 (terhubung)");
        scheduleOfflineCheck(ESP32_OFFLINE_TIMEOUT_MS);
      } else {
        clearOfflineTimer();
        setDataSourceStatus("disconnected", "ESP32 (terputus)");
      }
    };

    setDataSourceStatus("disconnected", "ESP32 (terputus)");
    render(merge(structuredClone(sampleData), {}));

    db.ref(".info/serverTimeOffset").on("value", (offsetSnap) => {
      const offset = offsetSnap.val();
      if (typeof offset === "number" && Number.isFinite(offset)) {
        serverTimeOffset = offset;
        if (latestVal) updateConnectionState();
      }
    });

    ref.on(
      "value",
      (snapshot) => {
        const val = snapshot.val();
        if (val && typeof val === "object") {
          if (hasReceivedInitialSnapshot) sawLiveUpdate = true;
          hasReceivedInitialSnapshot = true;
          latestVal = val;
          const current = merge(structuredClone(sampleData), val);
          render(current);
          updateConnectionState();
        } else {
          latestVal = null;
          clearOfflineTimer();
          setDataSourceStatus("disconnected", "ESP32 (terputus)");
          render(merge(structuredClone(sampleData), {}));
        }
      },
      (err) => {
        console.warn("Firebase read error:", err);
        latestVal = null;
        clearOfflineTimer();
        setDataSourceStatus("disconnected", "ESP32 (terputus)");
        render(merge(structuredClone(sampleData), {}));
      }
    );
  } catch (e) {
    console.warn("Firebase init error:", e);
    setDataSourceStatus("disconnected", "ESP32 (terputus)");
    render(merge(structuredClone(sampleData), {}));
  }
}

(async function main() {
  initMap();
  revealOnLoad();
  if (DATA_MODE === "firebase") {
    startFirebase();
  } else {
    await loadData();
    if (DATA_ENDPOINT) setInterval(loadData, POLL_INTERVAL_MS);
  }
})();
