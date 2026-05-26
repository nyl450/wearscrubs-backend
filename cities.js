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

function rateForZone(zone) {
  return ZONE_RATES[zone] || ZONE_RATES[3];
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

module.exports = { CITIES, ZONE_RATES, rateForZone };
