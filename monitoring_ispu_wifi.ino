#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DHT.h>
#include <PMS.h>
#include <math.h>

// =====================================================
// KONFIGURASI WIFI (ubah sesuai jaringan Anda)
// =====================================================
const char* WIFI_SSID = "NAMA_WIFI";
const char* WIFI_PASS = "PASSWORD_WIFI";

WebServer server(80);

// =====================================================
// 1. DEFINISI PIN ESP32-S3 & KONSTANTA
// =====================================================
#define DHTPIN 4
#define DHTTYPE DHT22

#define MQ7_PIN 1

#define PMS_RX 18
#define PMS_TX 17

#define WINDOW_SIZE 5

// Faktor Pembagi Resistor pada GPIO 1 (Misal: 10k & 10k = 2.0). 
// Jika tanpa resistor pembagi tegangan eksternal, gunakan 1.0
const float FAKTOR_PEMBAGI = 2.0;

// Parameter Kalibrasi MQ-7
const float R0 = 0.66;  // Nilai R0 hasil kalkulasi di udara bersih (kOhm)
const float RL = 10.0;  // Resistor beban pada modul MQ-7 (10 kOhm)

// Interval pembacaan/output (ms)
const unsigned long SAMPLE_INTERVAL_MS = 2000;

// =====================================================
// 2. INISIALISASI SENSOR
// =====================================================
DHT dht(DHTPIN, DHTTYPE);

PMS pms(Serial2);
PMS::DATA data;

// =====================================================
// 3. STRUKTUR MEDIAN FILTER
// =====================================================
struct MedianFilter {
  float samples[WINDOW_SIZE];
  int index = 0;
  int count = 0;
};

// Variabel filter setiap sensor
MedianFilter filterPM25;
MedianFilter filterPM10;
MedianFilter filterMQ7;
MedianFilter filterSuhu;
MedianFilter filterKelembaban;

// =====================================================
// 4. DATA TERAKHIR (untuk endpoint /data)
// =====================================================
struct LatestData {
  float pm25 = NAN;
  float pm10 = NAN;
  int adcRaw = 0;
  float adcFiltered = NAN;
  float voltageMv = NAN;
  float coPpm = NAN;
  float suhu = NAN;
  float kelembapan = NAN;
  float ispuPm25 = NAN;
  float ispuPm10 = NAN;
  float ispuTertinggi = NAN;
  String kategori = "BELUM TERSEDIA";
  bool hasPms = false;
  bool hasDht = false;
};

LatestData latest;
unsigned long lastSampleMs = 0;

// =====================================================
// FUNGSI UTIL JSON
// =====================================================
String jsonNumberOrNull(float v, int digits = 2) {
  if (isnan(v) || isinf(v)) return "null";
  return String(v, (unsigned int)digits);
}

void addCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Cache-Control", "no-store");
}

String buildJsonPayload() {
  String json = "{";
  json += "\"pms5003\":{";
  json += "\"pm25\":" + jsonNumberOrNull(latest.pm25, 2) + ",";
  json += "\"pm10\":" + jsonNumberOrNull(latest.pm10, 2);
  json += "},";
  json += "\"mq7\":{";
  json += "\"adcRaw\":" + String(latest.adcRaw) + ",";
  json += "\"adcFiltered\":" + jsonNumberOrNull(latest.adcFiltered, 2) + ",";
  json += "\"voltageMv\":" + jsonNumberOrNull(latest.voltageMv, 2) + ",";
  json += "\"coPpm\":" + jsonNumberOrNull(latest.coPpm, 2);
  json += "},";
  json += "\"dht22\":{";
  json += "\"temperature\":" + jsonNumberOrNull(latest.suhu, 2) + ",";
  json += "\"humidity\":" + jsonNumberOrNull(latest.kelembapan, 2);
  json += "},";
  json += "\"ispu\":{";
  json += "\"pm25\":" + jsonNumberOrNull(latest.ispuPm25, 2) + ",";
  json += "\"pm10\":" + jsonNumberOrNull(latest.ispuPm10, 2) + ",";
  json += "\"tertinggi\":" + jsonNumberOrNull(latest.ispuTertinggi, 2) + ",";
  json += "\"kategori\":\"" + latest.kategori + "\"";
  json += "}";
  json += "}";
  return json;
}

void handleData() {
  addCorsHeaders();
  server.send(200, "application/json", buildJsonPayload());
}

void handleOptions() {
  addCorsHeaders();
  server.send(204);
}

void handleRoot() {
  addCorsHeaders();
  server.send(200, "text/plain", "ESP32-S3 Monitoring ISPU aktif. Gunakan endpoint /data untuk JSON.");
}

// =====================================================
// 5. FUNGSI MENAMBAHKAN DATA KE WINDOW
// =====================================================
void tambahSampel(MedianFilter &filter, float nilai) {
  if (isnan(nilai) || isinf(nilai)) {
    return;
  }

  filter.samples[filter.index] = nilai;
  filter.index++;

  if (filter.index >= WINDOW_SIZE) {
    filter.index = 0;
  }

  if (filter.count < WINDOW_SIZE) {
    filter.count++;
  }
}

// =====================================================
// 6. FUNGSI MEDIAN FILTER
// =====================================================
float medianFilter(MedianFilter &filter) {
  if (filter.count == 0) {
    return NAN;
  }

  float temp[WINDOW_SIZE];

  // Menyalin data sampel
  for (int i = 0; i < filter.count; i++) {
    temp[i] = filter.samples[i];
  }

  // Mengurutkan data dari kecil ke besar (Bubble Sort)
  for (int i = 0; i < filter.count - 1; i++) {
    for (int j = 0; j < filter.count - i - 1; j++) {
      if (temp[j] > temp[j + 1]) {
        float swap = temp[j];
        temp[j] = temp[j + 1];
        temp[j + 1] = swap;
      }
    }
  }

  // Mengambil nilai tengah
  if (filter.count % 2 == 1) {
    return temp[filter.count / 2];
  } else {
    int tengah = filter.count / 2;
    return (temp[tengah - 1] + temp[tengah]) / 2.0;
  }
}

// =====================================================
// 7. FUNGSI KALIBRASI MATEMATIKA MQ-7 (PERHITUNGAN PPM)
// =====================================================
float hitungPPM_MQ7(float teganganAO_mV) {
  float V_AO = teganganAO_mV / 1000.0; // Konversi mV ke Volt
  
  if (V_AO <= 0 || V_AO >= 5.0) return 0.0; // Proteksi pembagian nol/overflow

  // 1. Hitung Resistansi Sensor (Rs) saat ini
  float Rs = ((5.0 - V_AO) / V_AO) * RL;

  // 2. Hitung Rasio Rs/R0
  float rasio = Rs / R0;

  // 3. Persamaan Logaritmik Kurva MQ-7 (ppm CO)
  float ppm = 99.041 * pow(rasio, -1.518);
  
  return ppm;
}

// =====================================================
// 8. FUNGSI PERHITUNGAN ISPU
// Berdasarkan Permen LHK No. 14 Tahun 2020
// =====================================================
float hitungISPU(float konsentrasi, bool parameterPM25) {
  if (isnan(konsentrasi) || konsentrasi < 0) {
    return NAN;
  }

  // Batas konsentrasi ambien
  const float batasPM25[] = {0, 15.5, 55.4, 150.4, 250.4, 500};
  const float batasPM10[] = {0, 50, 150, 350, 420, 500};

  // Batas nilai ISPU
  const float batasISPU[] = {0, 50, 100, 200, 300, 500};

  const float *batasKonsentrasi;

  if (parameterPM25) {
    batasKonsentrasi = batasPM25;
  } else {
    batasKonsentrasi = batasPM10;
  }

  // Membatasi nilai maksimum tabel
  if (konsentrasi >= batasKonsentrasi[5]) {
    return 500;
  }

  // Interpolasi linear
  for (int i = 0; i < 5; i++) {
    if (konsentrasi <= batasKonsentrasi[i + 1]) {
      float Xa = batasKonsentrasi[i + 1];
      float Xb = batasKonsentrasi[i];

      float Ia = batasISPU[i + 1];
      float Ib = batasISPU[i];

      float ISPU = ((Ia - Ib) / (Xa - Xb)) * (konsentrasi - Xb) + Ib;
      return ISPU;
    }
  }

  return NAN;
}

// =====================================================
// 9. FUNGSI MENENTUKAN KATEGORI ISPU
// =====================================================
String dapatkanKategoriISPU(float nilai) {
  if (isnan(nilai)) {
    return "BELUM TERSEDIA";
  }

  if (nilai <= 50) {
    return "BAIK";
  } else if (nilai <= 100) {
    return "SEDANG";
  } else if (nilai <= 200) {
    return "TIDAK SEHAT";
  } else if (nilai <= 300) {
    return "SANGAT TIDAK SEHAT";
  } else {
    return "BERBAHAYA";
  }
}

void printWiFiInfo() {
  Serial.print("WiFi terhubung. IP ESP32: ");
  Serial.println(WiFi.localIP());
  Serial.println("Endpoint data: http://" + WiFi.localIP().toString() + "/data");
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.println("Menghubungkan ke WiFi (SSID: " + String(WIFI_SSID) + ")");
  Serial.print("Status");

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    server.handleClient(); // tetap responsif jika ada request lokal/jaringan
    if (millis() - start > 20000) {
      Serial.println("\nGagal terhubung WiFi (timeout). Akan mencoba ulang otomatis di background.");
      Serial.println("Pastikan: SSID/password benar, WiFi 2.4GHz, dan sinyal stabil.");
      return;
    }
  }
  Serial.println();
  printWiFiInfo();
}

// =====================================================
// 10. SETUP
// =====================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("======================================");
  Serial.println(" SISTEM MONITORING KUALITAS UDARA");
  Serial.println(" ESP32-S3 + MEDIAN FILTER + MQ7 PPM");
  Serial.println(" + WiFi WebServer /data (JSON)");
  Serial.println("======================================");

  // Inisialisasi DHT22
  dht.begin();

  // Inisialisasi PMS5003 (Hardware Serial2)
  Serial2.begin(9600, SERIAL_8N1, PMS_RX, PMS_TX);

  // Inisialisasi MQ-7
  pinMode(MQ7_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(MQ7_PIN, ADC_11db);

  Serial.println("Inisialisasi sensor selesai.");

  server.on("/", HTTP_GET, handleRoot);
  server.on("/data", HTTP_GET, handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.begin();
  Serial.println("WebServer aktif (akan melayani /data saat WiFi terhubung).");

  connectWiFi();
}

// =====================================================
// 11. BACA SENSOR & UPDATE DATA
// =====================================================
void sampleSensors() {
  // ---------------------------------------------------
  // A. PEMBACAAN SENSOR DHT22
  // ---------------------------------------------------
  float suhuRaw = dht.readTemperature();
  float kelembabanRaw = dht.readHumidity();

  if (!isnan(suhuRaw) && !isnan(kelembabanRaw)) {
    tambahSampel(filterSuhu, suhuRaw);
    tambahSampel(filterKelembaban, kelembabanRaw);
    latest.hasDht = true;
  }

  // ---------------------------------------------------
  // B. PEMBACAAN SENSOR MQ-7 & PERHITUNGAN PPM
  // ---------------------------------------------------
  int mq7Raw = analogRead(MQ7_PIN);
  float teganganPin_mV = analogReadMilliVolts(MQ7_PIN);
  float teganganAO_mV = teganganPin_mV * FAKTOR_PEMBAGI;

  tambahSampel(filterMQ7, (float)mq7Raw);
  float mq7Filtered = medianFilter(filterMQ7);

  // Perhitungan PPM CO
  float coPPM = hitungPPM_MQ7(teganganAO_mV);

  // ---------------------------------------------------
  // C. PEMBACAAN SENSOR PMS5003
  // ---------------------------------------------------
  bool pmsReady = pms.readUntil(data, 2000);

  if (pmsReady) {
    tambahSampel(filterPM25, data.PM_AE_UG_2_5);
    tambahSampel(filterPM10, data.PM_AE_UG_10_0);
    latest.hasPms = true;
  }

  // ---------------------------------------------------
  // D. HASIL MEDIAN FILTER
  // ---------------------------------------------------
  float pm25Filtered = medianFilter(filterPM25);
  float pm10Filtered = medianFilter(filterPM10);
  float suhuFiltered = medianFilter(filterSuhu);
  float kelembabanFiltered = medianFilter(filterKelembaban);

  // ---------------------------------------------------
  // E. PERHITUNGAN NILAI ISPU
  // ---------------------------------------------------
  float ispuPM25 = hitungISPU(pm25Filtered, true);
  float ispuPM10 = hitungISPU(pm10Filtered, false);

  // Nilai ISPU tertinggi
  float ispuTertinggi = NAN;

  if (!isnan(ispuPM25)) {
    ispuTertinggi = ispuPM25;
  }

  if (!isnan(ispuPM10)) {
    if (isnan(ispuTertinggi) || ispuPM10 > ispuTertinggi) {
      ispuTertinggi = ispuPM10;
    }
  }

  String kategoriUdara = dapatkanKategoriISPU(ispuTertinggi);

  // Simpan ke struct untuk /data
  latest.pm25 = pm25Filtered;
  latest.pm10 = pm10Filtered;
  latest.adcRaw = mq7Raw;
  latest.adcFiltered = mq7Filtered;
  latest.voltageMv = teganganAO_mV;
  latest.coPpm = coPPM;
  latest.suhu = suhuFiltered;
  latest.kelembapan = kelembabanFiltered;
  latest.ispuPm25 = ispuPM25;
  latest.ispuPm10 = ispuPM10;
  latest.ispuTertinggi = ispuTertinggi;
  latest.kategori = kategoriUdara;

  // ---------------------------------------------------
  // F. OUTPUT SERIAL MONITOR (format lama)
  // ---------------------------------------------------
  Serial.println("\n========== MONITORING KUALITAS UDARA ==========");

  // Output PMS5003
  Serial.println("[DATA PMS5003]");
  if (!isnan(pm25Filtered)) {
    Serial.printf("PM2.5              : %.2f ug/m3\n", pm25Filtered);
  } else {
    Serial.println("PM2.5              : Data belum tersedia.");
  }

  if (!isnan(pm10Filtered)) {
    Serial.printf("PM10               : %.2f ug/m3\n", pm10Filtered);
  } else {
    Serial.println("PM10               : Data belum tersedia.");
  }

  // Output MQ-7
  Serial.println("\n[DATA MQ-7]");
  Serial.printf("ADC Raw            : %d\n", mq7Raw);
  Serial.printf("ADC Filtered       : %.2f\n", mq7Filtered);
  Serial.printf("Tegangan AO        : %.2f mV\n", teganganAO_mV);
  Serial.printf("Konsentrasi CO     : %.2f ppm\n", coPPM);

  // Output DHT22
  Serial.println("\n[DATA DHT22]");
  if (!isnan(suhuFiltered)) {
    Serial.printf("Suhu               : %.2f °C\n", suhuFiltered);
    Serial.printf("Kelembapan         : %.2f %%\n", kelembabanFiltered);
  } else {
    Serial.println("Data belum tersedia.");
  }

  // Output ISPU
  Serial.println("\n[HASIL ISPU]");
  if (!isnan(ispuPM25)) {
    Serial.printf("ISPU PM2.5         : %.2f\n", ispuPM25);
  }
  if (!isnan(ispuPM10)) {
    Serial.printf("ISPU PM10          : %.2f\n", ispuPM10);
  }
  if (!isnan(ispuTertinggi)) {
    Serial.printf("ISPU Tertinggi     : %.2f\n", ispuTertinggi);
    Serial.printf("Kategori Udara     : %s\n", kategoriUdara.c_str());
  } else {
    Serial.println("ISPU belum dapat dihitung.");
  }

  Serial.println("===============================================");

  // Output JSON satu baris (opsional, berguna untuk jembatan serial/USB)
  Serial.print("JSON:");
  Serial.println(buildJsonPayload());
}

// =====================================================
// 12. LOOP UTAMA
// =====================================================
void loop() {
  server.handleClient();

  // Coba reconnect WiFi berkala jika terputus/gagal awal
  static unsigned long lastWifiRetry = 0;
  static bool wasConnected = false;
  bool connected = (WiFi.status() == WL_CONNECTED);
  if (connected && !wasConnected) {
    printWiFiInfo();
  }
  if (!connected && millis() - lastWifiRetry > 10000) {
    lastWifiRetry = millis();
    Serial.println("WiFi belum terhubung, mencoba reconnect...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  wasConnected = connected;

  unsigned long now = millis();
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    sampleSensors();
  }
}
