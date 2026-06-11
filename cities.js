// cities.js — daftar kota/kabupaten Indonesia + ZONA ONGKIR
// ─────────────────────────────────────────────────────────────────────────────
// Tarif ongkir INTERIM (sebelum integrasi KiriminAja). Asal kirim: Pagedangan,
// Kab. Tangerang. Tarif flat per kg per zona (acuan data REG ekspedisi dari Tangerang):
//   Zona 1 — Jabodetabek                          : Rp10.000/kg
//   Zona 2 — Banten (lain) + Jawa Barat           : Rp12.000/kg
//   Zona 3 — Jateng + DIY + Jatim + Bali          : Rp20.000/kg
//   Zona 4 — Sumatra + Kalimantan + NTB + NTT     : Rp28.000/kg
//   Zona 5 — Sulawesi + Maluku + Papua + Gorontalo: Rp31.000/kg
// Catatan: zona = perkiraan; zona jauh (Papua/NTT) bisa lebih mahal dari floor ini.
// Order berat (>10kg) di luar Zona 1 tetap "dikonfirmasi admin" (lihat server.js).
const ZONE_RATES = { 1: 10000, 2: 12000, 3: 20000, 4: 28000, 5: 31000 };

// City-level overrides (Juni 2026 — keputusan owner setelah baseline J&T per-kota).
// Dipakai DULU sebelum fallback ZONE_RATES — overlay tanpa harus tambah zona baru.
// Pattern: kota yg tidak ada di sini → pakai zona-nya.
const CITY_RATES = {
  // Aceh (16 kota) — REVISI batch-3 (10 Jun) per-kota 60rb-95rb (sebelumnya flat 40rb)
  "Banda Aceh": 60000, "Sabang": 75000, "Langsa": 70000, "Lhokseumawe": 70000,
  "Subulussalam": 75000, "Aceh Besar": 85000, "Aceh Barat": 88000, "Aceh Selatan": 85000,
  "Aceh Timur": 85000, "Aceh Tengah": 85000, "Aceh Utara": 85000, "Pidie": 85000,
  "Bireuen": 85000, "Simeulue": 95000, "Gayo Lues": 85000, "Nagan Raya": 85000,

  // Lampung (14 kota) — REVISI batch-3 (10 Jun) per-kota
  // Lampung Tengah BELUM user revisi → tetap 15rb dari batch awal
  "Bandar Lampung": 15000, "Metro": 38000, "Lampung Barat": 35000, "Lampung Selatan": 35000,
  "Lampung Tengah": 35000, "Lampung Timur": 35000, "Lampung Utara": 35000, "Mesuji": 35000,
  "Pesawaran": 25000, "Pesisir Barat": 35000, "Pringsewu": 35000, "Tanggamus": 35000,
  "Tulang Bawang": 35000, "Way Kanan": 35000,

  // Gorontalo (4 kota) — naik dari zona 5 (31rb) jadi 50rb/kg
  "Gorontalo": 50000, "Kabupaten Gorontalo": 50000, "Pohuwato": 50000, "Bone Bolango": 50000,

  // ── BATCH-1 OWNER REVISI (9 Jun 2026) ────────────────────────────────────
  // Jawa Barat (8 kota) — sebelumnya zona 2 (12rb)
  "Ciamis": 16500, "Tasikmalaya": 14000, "Kabupaten Tasikmalaya": 14000,
  "Kuningan": 16500, "Majalengka": 16500,
  "Sumedang": 15500, "Indramayu": 15000, "Pangandaran": 17500, "Banjar": 16500,

  // Jawa Tengah (29 kota) — sebelumnya zona 3 (20rb)
  "Semarang": 17500, "Kabupaten Semarang": 17500,
  "Solo (Surakarta)": 17500, "Magelang": 18500, "Kabupaten Magelang": 18500,
  "Purwokerto (Banyumas)": 19500, "Cilacap": 16500, "Kebumen": 20500,
  "Purworejo": 20500, "Klaten": 20500, "Boyolali": 20500, "Sukoharjo": 16500,
  "Wonogiri": 20500, "Karanganyar": 23500, "Sragen": 20500, "Grobogan": 22500,
  "Blora": 23500, "Rembang": 23500, "Pati": 22500, "Kudus": 22500,
  "Jepara": 22500, "Demak": 22500, "Kendal": 22500, "Batang": 23500,
  "Pekalongan": 21500, "Kabupaten Pekalongan": 21500,
  "Pemalang": 21500, "Tegal": 20000, "Kabupaten Tegal": 20000,
  "Brebes": 22000, "Wonosobo": 22000, "Temanggung": 25000, "Salatiga": 22000,

  // DI Yogyakarta (5 kota) — sebelumnya zona 3 (20rb)
  "Yogyakarta": 18000, "Sleman": 18000, "Bantul": 18000,
  "Gunung Kidul": 25000, "Kulon Progo": 25000,

  // ── BATCH-2 JAWA TIMUR (10 Jun 2026) — sebelumnya zona 3 (20rb) ──────────
  "Surabaya": 20000, "Malang": 30000, "Kabupaten Malang": 30000, "Batu": 30000,
  "Sidoarjo": 20000, "Gresik": 25000,
  "Mojokerto": 28000, "Kabupaten Mojokerto": 28000, "Jombang": 28000,
  "Kediri": 25000, "Kabupaten Kediri": 25000,
  "Blitar": 25000, "Kabupaten Blitar": 25000,
  "Tulungagung": 25000, "Trenggalek": 25000, "Nganjuk": 25000,
  "Madiun": 22000, "Kabupaten Madiun": 22000,
  "Magetan": 25000, "Ngawi": 25000, "Bojonegoro": 25000, "Tuban": 25000,
  "Lamongan": 25000, "Bangkalan": 25000, "Sampang": 25000, "Pamekasan": 25000,
  "Sumenep": 30000,
  "Pasuruan": 25000, "Kabupaten Pasuruan": 25000,
  "Probolinggo": 25000, "Kabupaten Probolinggo": 25000,
  "Lumajang": 25000, "Jember": 28000, "Bondowoso": 28000, "Situbondo": 28000,
  "Banyuwangi": 28000, "Ponorogo": 25000, "Pacitan": 30000,

  // ── BATCH-3 (10 Jun 2026) — Bali + Sumatra Utara ─────────────────────────
  // Bali (9 kota) — sebelumnya zona 3 (20rb)
  "Denpasar": 30000, "Badung": 30000, "Gianyar": 38000, "Tabanan": 38000,
  "Bangli": 38000, "Klungkung": 40000, "Karangasem": 40000, "Buleleng": 38000,
  "Jembrana": 38000,

  // Sumatra Utara (18 kota) — sebelumnya zona 4 (28rb)
  "Medan": 30000, "Binjai": 55000, "Pematangsiantar": 55000, "Tebing Tinggi": 58000,
  "Tanjungbalai": 62000, "Sibolga": 60000, "Padangsidimpuan": 60000, "Gunungsitoli": 60000,
  "Deli Serdang": 60000, "Langkat": 62000, "Karo": 60000, "Simalungun": 65000,
  "Asahan": 65000, "Labuhanbatu": 65000, "Tapanuli Utara": 65000, "Tapanuli Tengah": 70000,
  "Tapanuli Selatan": 65000, "Nias": 72000,

  // ── BATCH-3 lanjutan (10 Jun) — Sumatra lainnya ──────────────────────────
  // Jambi (11 kota) — sebelumnya zona 4 (28rb)
  "Jambi": 30000, "Sungai Penuh": 40000, "Batanghari": 40000, "Bungo": 40000,
  "Kerinci": 40000, "Merangin": 40000, "Muaro Jambi": 40000, "Sarolangun": 40000,
  "Tanjung Jabung Barat": 40000, "Tanjung Jabung Timur": 40000, "Tebo": 40000,

  // Kepulauan Riau (7 kota) — sebelumnya zona 4 (28rb)
  "Batam": 30000, "Tanjungpinang": 45000, "Bintan": 70000, "Karimun": 60000,
  "Natuna": 60000, "Lingga": 60000, "Kepulauan Anambas": 65000,

  // Riau (12 kota) — sebelumnya zona 4 (28rb)
  "Pekanbaru": 30000, "Dumai": 35000, "Kampar": 40000, "Bengkalis": 40000,
  "Siak": 40000, "Rokan Hulu": 40000, "Rokan Hilir": 40000, "Indragiri Hulu": 40000,
  "Indragiri Hilir": 40000, "Kepulauan Meranti": 40000, "Pelalawan": 40000, "Kuantan Singingi": 40000,

  // Sumatra Barat (11 kota) — sebelumnya zona 4 (28rb)
  "Padang": 35000, "Bukittinggi": 45000, "Payakumbuh": 50000, "Pariaman": 45000,
  "Solok": 45000, "Sawahlunto": 50000, "Padang Panjang": 50000, "Agam": 50000,
  "Pesisir Selatan": 50000, "Tanah Datar": 50000, "Mentawai": 55000,

  // Bengkulu (9 kota) — sebelumnya zona 4 (28rb)
  "Bengkulu": 35000, "Rejang Lebong": 45000, "Bengkulu Selatan": 45000, "Bengkulu Utara": 45000,
  "Kepahiang": 40000, "Lebong": 42000, "Mukomuko": 42000, "Seluma": 42000, "Kaur": 40000,

  // Bangka Belitung (7 kota)
  "Pangkalpinang": 25000, "Bangka": 45000, "Belitung": 42000, "Bangka Barat": 42000,
  "Bangka Tengah": 42000, "Bangka Selatan": 50000, "Belitung Timur": 40000,

  // Sumatra Selatan (12 kota) — sebelumnya zona 4 (28rb)
  "Palembang": 15000, "Prabumulih": 25000, "Pagar Alam": 25000, "Lubuklinggau": 30000,
  "Banyuasin": 45000, "Lahat": 30000, "Muara Enim": 25000, "Musi Banyuasin": 30000,
  "Musi Rawas": 35000, "Ogan Komering Ilir": 30000, "Ogan Komering Ulu": 28000, "Empat Lawang": 30000,
};

function rateForZone(zone) {
  return ZONE_RATES[zone] || ZONE_RATES[3];
}

// Resolusi tarif per kota. Cek CITY_RATES dulu (override), fallback ke zone rate.
function rateForCity(cityName, zone) {
  if (cityName && Object.prototype.hasOwnProperty.call(CITY_RATES, cityName))
    return CITY_RATES[cityName];
  return rateForZone(zone);
}

// Kota dikelompokkan per zona (per provinsi). Jabodetabek (Bogor/Depok/Bekasi/
// Tangerang) masuk Zona 1 meski provinsinya Jawa Barat/Banten.
const ZONE_CITIES = {
  1: [
    // DKI Jakarta
    "Jakarta Pusat", "Jakarta Utara", "Jakarta Barat", "Jakarta Selatan", "Jakarta Timur", "Kepulauan Seribu",
    // Jabodetabek — Banten
    "Tangerang", "Tangerang Selatan", "Kabupaten Tangerang",
    // Jabodetabek — Jawa Barat
    "Bekasi", "Kabupaten Bekasi", "Depok", "Bogor", "Kabupaten Bogor",
  ],
  2: [
    // Banten (selain Jabodetabek)
    "Serang", "Kabupaten Serang", "Cilegon", "Lebak", "Pandeglang",
    // Jawa Barat (selain Jabodetabek)
    "Bandung", "Kabupaten Bandung", "Bandung Barat", "Cimahi", "Cirebon", "Kabupaten Cirebon",
    "Karawang", "Subang", "Purwakarta", "Sukabumi", "Kabupaten Sukabumi", "Cianjur", "Garut",
    "Tasikmalaya", "Kabupaten Tasikmalaya", "Ciamis", "Kuningan", "Majalengka", "Sumedang",
    "Indramayu", "Pangandaran", "Banjar",
  ],
  3: [
    // Jawa Tengah
    "Semarang", "Kabupaten Semarang", "Solo (Surakarta)", "Yogyakarta", "Magelang", "Kabupaten Magelang",
    "Purwokerto (Banyumas)", "Cilacap", "Kebumen", "Purworejo", "Klaten", "Boyolali", "Sukoharjo",
    "Wonogiri", "Karanganyar", "Sragen", "Grobogan", "Blora", "Rembang", "Pati", "Kudus", "Jepara",
    "Demak", "Kendal", "Batang", "Pekalongan", "Kabupaten Pekalongan", "Pemalang", "Tegal",
    "Kabupaten Tegal", "Brebes", "Wonosobo", "Temanggung", "Salatiga",
    // DI Yogyakarta
    "Sleman", "Bantul", "Gunung Kidul", "Kulon Progo",
    // Jawa Timur
    "Surabaya", "Malang", "Kabupaten Malang", "Batu", "Sidoarjo", "Gresik", "Mojokerto",
    "Kabupaten Mojokerto", "Jombang", "Kediri", "Kabupaten Kediri", "Blitar", "Kabupaten Blitar",
    "Tulungagung", "Trenggalek", "Nganjuk", "Madiun", "Kabupaten Madiun", "Magetan", "Ngawi",
    "Bojonegoro", "Tuban", "Lamongan", "Bangkalan", "Sampang", "Pamekasan", "Sumenep", "Pasuruan",
    "Kabupaten Pasuruan", "Probolinggo", "Kabupaten Probolinggo", "Lumajang", "Jember", "Bondowoso",
    "Situbondo", "Banyuwangi", "Ponorogo", "Pacitan",
    // Bali
    "Denpasar", "Badung", "Gianyar", "Tabanan", "Bangli", "Klungkung", "Karangasem", "Buleleng", "Jembrana",
  ],
  4: [
    // Nusa Tenggara Barat
    "Mataram", "Lombok Barat", "Lombok Tengah", "Lombok Timur", "Lombok Utara", "Sumbawa",
    "Sumbawa Barat", "Dompu", "Bima", "Kabupaten Bima",
    // Nusa Tenggara Timur
    "Kupang", "Kabupaten Kupang", "Ende", "Flores Timur", "Manggarai", "Manggarai Barat", "Sikka",
    "Sumba Barat", "Sumba Timur", "Timor Tengah Selatan", "Timor Tengah Utara",
    // Kalimantan Barat
    "Pontianak", "Kabupaten Pontianak", "Singkawang", "Sambas", "Sanggau", "Sintang", "Ketapang", "Mempawah",
    // Kalimantan Tengah
    "Palangkaraya", "Kotawaringin Barat", "Kotawaringin Timur", "Kapuas", "Barito Selatan", "Barito Utara",
    // Kalimantan Selatan
    "Banjarmasin", "Banjarbaru", "Kabupaten Banjar", "Barito Kuala", "Hulu Sungai Selatan",
    "Hulu Sungai Tengah", "Hulu Sungai Utara", "Tabalong", "Tapin",
    // Kalimantan Timur
    "Samarinda", "Balikpapan", "Bontang", "Kutai Kartanegara", "Kutai Barat", "Kutai Timur", "Berau",
    "Penajam Paser Utara", "Paser", "Mahakam Ulu",
    // Kalimantan Utara
    "Tarakan", "Nunukan", "Bulungan", "Malinau", "Tana Tidung",
    // Sumatera Utara
    "Medan", "Binjai", "Pematangsiantar", "Tebing Tinggi", "Tanjungbalai", "Sibolga", "Padangsidimpuan",
    "Gunungsitoli", "Deli Serdang", "Langkat", "Karo", "Simalungun", "Asahan", "Labuhanbatu",
    "Tapanuli Utara", "Tapanuli Tengah", "Tapanuli Selatan", "Nias",
    // Sumatera Barat
    "Padang", "Bukittinggi", "Payakumbuh", "Pariaman", "Solok", "Sawahlunto", "Padang Panjang", "Agam",
    "Pesisir Selatan", "Tanah Datar", "Mentawai",
    // Riau
    "Pekanbaru", "Dumai", "Kampar", "Bengkalis", "Siak", "Rokan Hulu", "Rokan Hilir", "Indragiri Hulu",
    "Indragiri Hilir", "Kepulauan Meranti", "Pelalawan", "Kuantan Singingi",
    // Kepulauan Riau
    "Batam", "Tanjungpinang", "Bintan", "Karimun", "Natuna", "Lingga", "Kepulauan Anambas",
    // Jambi
    "Jambi", "Sungai Penuh", "Batanghari", "Bungo", "Kerinci", "Merangin", "Muaro Jambi", "Sarolangun",
    "Tanjung Jabung Barat", "Tanjung Jabung Timur", "Tebo",
    // Sumatera Selatan
    "Palembang", "Prabumulih", "Pagar Alam", "Lubuklinggau", "Banyuasin", "Lahat", "Muara Enim",
    "Musi Banyuasin", "Musi Rawas", "Ogan Komering Ilir", "Ogan Komering Ulu", "Empat Lawang",
    // Bangka Belitung
    "Pangkalpinang", "Bangka", "Belitung", "Bangka Barat", "Bangka Tengah", "Bangka Selatan", "Belitung Timur",
    // Bengkulu
    "Bengkulu", "Rejang Lebong", "Bengkulu Selatan", "Bengkulu Utara", "Kepahiang", "Lebong", "Mukomuko",
    "Seluma", "Kaur",
    // Lampung
    "Bandar Lampung", "Metro", "Lampung Barat", "Lampung Selatan", "Lampung Tengah", "Lampung Timur",
    "Lampung Utara", "Mesuji", "Pesawaran", "Pesisir Barat", "Pringsewu", "Tanggamus", "Tulang Bawang",
    "Way Kanan",
    // Aceh
    "Banda Aceh", "Sabang", "Langsa", "Lhokseumawe", "Subulussalam", "Aceh Besar", "Aceh Barat",
    "Aceh Selatan", "Aceh Timur", "Aceh Tengah", "Aceh Utara", "Pidie", "Bireuen", "Simeulue",
    "Gayo Lues", "Nagan Raya",
  ],
  5: [
    // Sulawesi Selatan
    "Makassar", "Parepare", "Palopo", "Gowa", "Maros", "Pangkajene", "Barru", "Bone", "Soppeng", "Wajo",
    "Sidrap", "Pinrang", "Enrekang", "Luwu", "Luwu Utara", "Luwu Timur", "Bantaeng", "Jeneponto",
    "Takalar", "Selayar", "Bulukumba", "Sinjai",
    // Sulawesi Tengah
    "Palu", "Donggala", "Parigi Moutong", "Poso", "Morowali", "Tojo Una-Una", "Banggai", "Sigi",
    // Sulawesi Tenggara
    "Kendari", "Bau-Bau", "Kolaka", "Konawe", "Muna", "Buton", "Wakatobi",
    // Sulawesi Utara
    "Manado", "Bitung", "Tomohon", "Kotamobagu", "Minahasa", "Minahasa Utara", "Minahasa Selatan",
    "Bolaang Mongondow", "Kepulauan Sangihe", "Kepulauan Talaud",
    // Gorontalo
    "Gorontalo", "Kabupaten Gorontalo", "Pohuwato", "Bone Bolango",
    // Sulawesi Barat
    "Mamuju", "Mamasa", "Polewali Mandar", "Pasangkayu",
    // Maluku
    "Ambon", "Tual", "Maluku Tengah", "Maluku Tenggara", "Buru", "Seram Bagian Barat",
    "Seram Bagian Timur", "Kepulauan Aru", "Maluku Barat Daya", "Kepulauan Tanimbar",
    // Maluku Utara
    "Ternate", "Tidore Kepulauan", "Halmahera Barat", "Halmahera Tengah", "Halmahera Timur",
    "Halmahera Selatan", "Halmahera Utara", "Kepulauan Sula", "Pulau Taliabu",
    // Papua
    "Jayapura", "Merauke", "Nabire", "Sorong", "Manokwari", "Biak Numfor", "Fakfak", "Timika (Mimika)",
    "Wamena (Jayawijaya)", "Sarmi", "Raja Ampat", "Teluk Bintuni", "Teluk Wondama", "Kaimana", "Maybrat",
    "Tambrauw", "Pegunungan Bintang", "Yahukimo", "Puncak Jaya", "Yalimo", "Lanny Jaya", "Mappi",
    "Asmat", "Boven Digoel",
  ],
};

const DKI_NAMES = new Set([
  "Jakarta Pusat", "Jakarta Utara", "Jakarta Barat", "Jakarta Selatan", "Jakarta Timur", "Kepulauan Seribu",
]);

const CITIES = [];
for (const [zone, names] of Object.entries(ZONE_CITIES)) {
  const z = Number(zone);
  for (const name of names) {
    CITIES.push({ name, zone: z, is_dki: DKI_NAMES.has(name) });
  }
}

// Sorting: DKI dulu, lalu alfabetis
CITIES.sort((a, b) => {
  if (a.is_dki !== b.is_dki) return b.is_dki - a.is_dki;
  return a.name.localeCompare(b.name, 'id');
});

module.exports = { CITIES, ZONE_RATES, CITY_RATES, rateForZone, rateForCity };
