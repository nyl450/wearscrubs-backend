# Tarif Ongkir Wearscrubs (per kg)

> **Terakhir update:** 9 Juni 2026
> **Sumber:** `cities.js` (CITY_RATES + ZONE_RATES). Edit di sini sebagai draft, lalu apply ke `cities.js` + `public/checkout.html` + `public/checkout-en.html` (3 file wajib sinkron).
> **Berat:** dihitung `Math.ceil(qty / 3)` kg (1-3 baju = 1 kg, 4-6 baju = 2 kg, dst).
> **Catatan:** `>10 kg` di luar Zona 1 = "ongkir dikonfirmasi admin" (Lion Cargo).

---

## Format & Cara Revisi

Untuk revisi tarif, edit nilai `[Rp X.XXX]` di samping kota. Kalau mau bulk per provinsi, ganti rate di heading provinsi-nya.

Setelah revisi:
1. Edit `cities.js` → update `CITY_RATES` (untuk override per-kota) atau `ZONE_RATES` (untuk zona)
2. Edit `public/checkout.html` + `public/checkout-en.html` → mirror perubahan
3. Commit + push → Railway auto-deploy

---

## 🌴 JAWA

### DKI Jakarta — Rp 10.000/kg *(Zona 1)*
- Jakarta Pusat — `Rp 10.000`
- Jakarta Utara — `Rp 10.000`
- Jakarta Barat — `Rp 10.000`
- Jakarta Selatan — `Rp 10.000`
- Jakarta Timur — `Rp 10.000`
- Kepulauan Seribu — `Rp 10.000`

### Banten — Mixed (Jabodetabek 10rb · sisanya 12rb)
**Jabodetabek (Zona 1):**
- Tangerang — `Rp 10.000`
- Tangerang Selatan — `Rp 10.000`
- Kabupaten Tangerang — `Rp 10.000`

**Banten lain (Zona 2):**
- Serang — `Rp 12.000`
- Kabupaten Serang — `Rp 12.000`
- Cilegon — `Rp 12.000`
- Lebak — `Rp 12.000`
- Pandeglang — `Rp 12.000`

### Jawa Barat — Mixed (Jabodetabek 10rb · sisanya 12rb)
**Jabodetabek (Zona 1):**
- Bekasi — `Rp 10.000`
- Kabupaten Bekasi — `Rp 10.000`
- Depok — `Rp 10.000`
- Bogor — `Rp 10.000`
- Kabupaten Bogor — `Rp 10.000`

**Jawa Barat lain (Zona 2):**
- Bandung — `Rp 12.000`
- Kabupaten Bandung — `Rp 12.000`
- Bandung Barat — `Rp 12.000`
- Cimahi — `Rp 12.000`
- Cirebon — `Rp 12.000`
- Kabupaten Cirebon — `Rp 12.000`
- Karawang — `Rp 12.000`
- Subang — `Rp 12.000`
- Purwakarta — `Rp 12.000`
- Sukabumi — `Rp 12.000`
- Kabupaten Sukabumi — `Rp 12.000`
- Cianjur — `Rp 12.000`
- Garut — `Rp 12.000`
- Tasikmalaya — `Rp 12.000`
- Kabupaten Tasikmalaya — `Rp 12.000`
- Ciamis — `Rp 12.000`
- Kuningan — `Rp 12.000`
- Majalengka — `Rp 12.000`
- Sumedang — `Rp 12.000`
- Indramayu — `Rp 12.000`
- Pangandaran — `Rp 12.000`
- Banjar — `Rp 12.000`

### Jawa Tengah — Rp 20.000/kg *(Zona 3)*
- Semarang — `Rp 20.000`
- Kabupaten Semarang — `Rp 20.000`
- Solo (Surakarta) — `Rp 20.000`
- Magelang — `Rp 20.000`
- Kabupaten Magelang — `Rp 20.000`
- Purwokerto (Banyumas) — `Rp 20.000`
- Cilacap — `Rp 20.000`
- Kebumen — `Rp 20.000`
- Purworejo — `Rp 20.000`
- Klaten — `Rp 20.000`
- Boyolali — `Rp 20.000`
- Sukoharjo — `Rp 20.000`
- Wonogiri — `Rp 20.000`
- Karanganyar — `Rp 20.000`
- Sragen — `Rp 20.000`
- Grobogan — `Rp 20.000`
- Blora — `Rp 20.000`
- Rembang — `Rp 20.000`
- Pati — `Rp 20.000`
- Kudus — `Rp 20.000`
- Jepara — `Rp 20.000`
- Demak — `Rp 20.000`
- Kendal — `Rp 20.000`
- Batang — `Rp 20.000`
- Pekalongan — `Rp 20.000`
- Kabupaten Pekalongan — `Rp 20.000`
- Pemalang — `Rp 20.000`
- Tegal — `Rp 20.000`
- Kabupaten Tegal — `Rp 20.000`
- Brebes — `Rp 20.000`
- Wonosobo — `Rp 20.000`
- Temanggung — `Rp 20.000`
- Salatiga — `Rp 20.000`

### DI Yogyakarta — Rp 20.000/kg *(Zona 3)*
- Yogyakarta — `Rp 20.000`
- Sleman — `Rp 20.000`
- Bantul — `Rp 20.000`
- Gunung Kidul — `Rp 20.000`
- Kulon Progo — `Rp 20.000`

### Jawa Timur — Rp 20.000/kg *(Zona 3)*
- Surabaya — `Rp 20.000`
- Malang — `Rp 20.000`
- Kabupaten Malang — `Rp 20.000`
- Batu — `Rp 20.000`
- Sidoarjo — `Rp 20.000`
- Gresik — `Rp 20.000`
- Mojokerto — `Rp 20.000`
- Kabupaten Mojokerto — `Rp 20.000`
- Jombang — `Rp 20.000`
- Kediri — `Rp 20.000`
- Kabupaten Kediri — `Rp 20.000`
- Blitar — `Rp 20.000`
- Kabupaten Blitar — `Rp 20.000`
- Tulungagung — `Rp 20.000`
- Trenggalek — `Rp 20.000`
- Nganjuk — `Rp 20.000`
- Madiun — `Rp 20.000`
- Kabupaten Madiun — `Rp 20.000`
- Magetan — `Rp 20.000`
- Ngawi — `Rp 20.000`
- Bojonegoro — `Rp 20.000`
- Tuban — `Rp 20.000`
- Lamongan — `Rp 20.000`
- Bangkalan — `Rp 20.000`
- Sampang — `Rp 20.000`
- Pamekasan — `Rp 20.000`
- Sumenep — `Rp 20.000`
- Pasuruan — `Rp 20.000`
- Kabupaten Pasuruan — `Rp 20.000`
- Probolinggo — `Rp 20.000`
- Kabupaten Probolinggo — `Rp 20.000`
- Lumajang — `Rp 20.000`
- Jember — `Rp 20.000`
- Bondowoso — `Rp 20.000`
- Situbondo — `Rp 20.000`
- Banyuwangi — `Rp 20.000`
- Ponorogo — `Rp 20.000`
- Pacitan — `Rp 20.000`

---

## 🏝️ BALI

### Bali — Rp 20.000/kg *(Zona 3)*
- Denpasar — `Rp 20.000`
- Badung — `Rp 20.000`
- Gianyar — `Rp 20.000`
- Tabanan — `Rp 20.000`
- Bangli — `Rp 20.000`
- Klungkung — `Rp 20.000`
- Karangasem — `Rp 20.000`
- Buleleng — `Rp 20.000`
- Jembrana — `Rp 20.000`

---

## 🏔️ SUMATRA

### 🆕 Aceh — Rp 40.000/kg *(OVERRIDE — naik dari 28rb)*
- Banda Aceh — `Rp 40.000`
- Sabang — `Rp 40.000`
- Langsa — `Rp 40.000`
- Lhokseumawe — `Rp 40.000`
- Subulussalam — `Rp 40.000`
- Aceh Besar — `Rp 40.000`
- Aceh Barat — `Rp 40.000`
- Aceh Selatan — `Rp 40.000`
- Aceh Timur — `Rp 40.000`
- Aceh Tengah — `Rp 40.000`
- Aceh Utara — `Rp 40.000`
- Pidie — `Rp 40.000`
- Bireuen — `Rp 40.000`
- Simeulue — `Rp 40.000`
- Gayo Lues — `Rp 40.000`
- Nagan Raya — `Rp 40.000`

### Sumatra Utara — Rp 28.000/kg *(Zona 4)*
- Medan — `Rp 28.000`
- Binjai — `Rp 28.000`
- Pematangsiantar — `Rp 28.000`
- Tebing Tinggi — `Rp 28.000`
- Tanjungbalai — `Rp 28.000`
- Sibolga — `Rp 28.000`
- Padangsidimpuan — `Rp 28.000`
- Gunungsitoli — `Rp 28.000`
- Deli Serdang — `Rp 28.000`
- Langkat — `Rp 28.000`
- Karo — `Rp 28.000`
- Simalungun — `Rp 28.000`
- Asahan — `Rp 28.000`
- Labuhanbatu — `Rp 28.000`
- Tapanuli Utara — `Rp 28.000`
- Tapanuli Tengah — `Rp 28.000`
- Tapanuli Selatan — `Rp 28.000`
- Nias — `Rp 28.000`

### Sumatra Barat — Rp 28.000/kg *(Zona 4)*
- Padang — `Rp 28.000`
- Bukittinggi — `Rp 28.000`
- Payakumbuh — `Rp 28.000`
- Pariaman — `Rp 28.000`
- Solok — `Rp 28.000`
- Sawahlunto — `Rp 28.000`
- Padang Panjang — `Rp 28.000`
- Agam — `Rp 28.000`
- Pesisir Selatan — `Rp 28.000`
- Tanah Datar — `Rp 28.000`
- Mentawai — `Rp 28.000`

### Riau — Rp 28.000/kg *(Zona 4)*
- Pekanbaru — `Rp 28.000`
- Dumai — `Rp 28.000`
- Kampar — `Rp 28.000`
- Bengkalis — `Rp 28.000`
- Siak — `Rp 28.000`
- Rokan Hulu — `Rp 28.000`
- Rokan Hilir — `Rp 28.000`
- Indragiri Hulu — `Rp 28.000`
- Indragiri Hilir — `Rp 28.000`
- Kepulauan Meranti — `Rp 28.000`
- Pelalawan — `Rp 28.000`
- Kuantan Singingi — `Rp 28.000`

### Kepulauan Riau — Rp 28.000/kg *(Zona 4)*
- Batam — `Rp 28.000`
- Tanjungpinang — `Rp 28.000`
- Bintan — `Rp 28.000`
- Karimun — `Rp 28.000`
- Natuna — `Rp 28.000`
- Lingga — `Rp 28.000`
- Kepulauan Anambas — `Rp 28.000`

### Jambi — Rp 28.000/kg *(Zona 4)*
- Jambi — `Rp 28.000`
- Sungai Penuh — `Rp 28.000`
- Batanghari — `Rp 28.000`
- Bungo — `Rp 28.000`
- Kerinci — `Rp 28.000`
- Merangin — `Rp 28.000`
- Muaro Jambi — `Rp 28.000`
- Sarolangun — `Rp 28.000`
- Tanjung Jabung Barat — `Rp 28.000`
- Tanjung Jabung Timur — `Rp 28.000`
- Tebo — `Rp 28.000`

### Sumatra Selatan — Rp 28.000/kg *(Zona 4)*
- Palembang — `Rp 28.000`
- Prabumulih — `Rp 28.000`
- Pagar Alam — `Rp 28.000`
- Lubuklinggau — `Rp 28.000`
- Banyuasin — `Rp 28.000`
- Lahat — `Rp 28.000`
- Muara Enim — `Rp 28.000`
- Musi Banyuasin — `Rp 28.000`
- Musi Rawas — `Rp 28.000`
- Ogan Komering Ilir — `Rp 28.000`
- Ogan Komering Ulu — `Rp 28.000`
- Empat Lawang — `Rp 28.000`

### Bangka Belitung — Rp 28.000/kg *(Zona 4)*
- Pangkalpinang — `Rp 28.000`
- Bangka — `Rp 28.000`
- Belitung — `Rp 28.000`
- Bangka Barat — `Rp 28.000`
- Bangka Tengah — `Rp 28.000`
- Bangka Selatan — `Rp 28.000`
- Belitung Timur — `Rp 28.000`

### Bengkulu — Rp 28.000/kg *(Zona 4)*
- Bengkulu — `Rp 28.000`
- Rejang Lebong — `Rp 28.000`
- Bengkulu Selatan — `Rp 28.000`
- Bengkulu Utara — `Rp 28.000`
- Kepahiang — `Rp 28.000`
- Lebong — `Rp 28.000`
- Mukomuko — `Rp 28.000`
- Seluma — `Rp 28.000`
- Kaur — `Rp 28.000`

### 🆕 Lampung — Rp 15.000/kg *(OVERRIDE — TURUN dari 28rb)*
- Bandar Lampung — `Rp 15.000`
- Metro — `Rp 15.000`
- Lampung Barat — `Rp 15.000`
- Lampung Selatan — `Rp 15.000`
- Lampung Tengah — `Rp 15.000`
- Lampung Timur — `Rp 15.000`
- Lampung Utara — `Rp 15.000`
- Mesuji — `Rp 15.000`
- Pesawaran — `Rp 15.000`
- Pesisir Barat — `Rp 15.000`
- Pringsewu — `Rp 15.000`
- Tanggamus — `Rp 15.000`
- Tulang Bawang — `Rp 15.000`
- Way Kanan — `Rp 15.000`

---

## 🌳 KALIMANTAN

### Kalimantan Barat — Rp 28.000/kg *(Zona 4)*
- Pontianak — `Rp 28.000`
- Kabupaten Pontianak — `Rp 28.000`
- Singkawang — `Rp 28.000`
- Sambas — `Rp 28.000`
- Sanggau — `Rp 28.000`
- Sintang — `Rp 28.000`
- Ketapang — `Rp 28.000`
- Mempawah — `Rp 28.000`

### Kalimantan Tengah — Rp 28.000/kg *(Zona 4)*
- Palangkaraya — `Rp 28.000`
- Kotawaringin Barat — `Rp 28.000`
- Kotawaringin Timur — `Rp 28.000`
- Kapuas — `Rp 28.000`
- Barito Selatan — `Rp 28.000`
- Barito Utara — `Rp 28.000`

### Kalimantan Selatan — Rp 28.000/kg *(Zona 4)*
- Banjarmasin — `Rp 28.000`
- Banjarbaru — `Rp 28.000`
- Kabupaten Banjar — `Rp 28.000`
- Barito Kuala — `Rp 28.000`
- Hulu Sungai Selatan — `Rp 28.000`
- Hulu Sungai Tengah — `Rp 28.000`
- Hulu Sungai Utara — `Rp 28.000`
- Tabalong — `Rp 28.000`
- Tapin — `Rp 28.000`

### Kalimantan Timur — Rp 28.000/kg *(Zona 4)*
- Samarinda — `Rp 28.000`
- Balikpapan — `Rp 28.000`
- Bontang — `Rp 28.000`
- Kutai Kartanegara — `Rp 28.000`
- Kutai Barat — `Rp 28.000`
- Kutai Timur — `Rp 28.000`
- Berau — `Rp 28.000`
- Penajam Paser Utara — `Rp 28.000`
- Paser — `Rp 28.000`
- Mahakam Ulu — `Rp 28.000`

### Kalimantan Utara — Rp 28.000/kg *(Zona 4)*
- Tarakan — `Rp 28.000`
- Nunukan — `Rp 28.000`
- Bulungan — `Rp 28.000`
- Malinau — `Rp 28.000`
- Tana Tidung — `Rp 28.000`

---

## 🌋 SULAWESI

### Sulawesi Selatan — Rp 31.000/kg *(Zona 5)*
- Makassar — `Rp 31.000`
- Parepare — `Rp 31.000`
- Palopo — `Rp 31.000`
- Gowa — `Rp 31.000`
- Maros — `Rp 31.000`
- Pangkajene — `Rp 31.000`
- Barru — `Rp 31.000`
- Bone — `Rp 31.000`
- Soppeng — `Rp 31.000`
- Wajo — `Rp 31.000`
- Sidrap — `Rp 31.000`
- Pinrang — `Rp 31.000`
- Enrekang — `Rp 31.000`
- Luwu — `Rp 31.000`
- Luwu Utara — `Rp 31.000`
- Luwu Timur — `Rp 31.000`
- Bantaeng — `Rp 31.000`
- Jeneponto — `Rp 31.000`
- Takalar — `Rp 31.000`
- Selayar — `Rp 31.000`
- Bulukumba — `Rp 31.000`
- Sinjai — `Rp 31.000`

### Sulawesi Tengah — Rp 31.000/kg *(Zona 5)*
- Palu — `Rp 31.000`
- Donggala — `Rp 31.000`
- Parigi Moutong — `Rp 31.000`
- Poso — `Rp 31.000`
- Morowali — `Rp 31.000`
- Tojo Una-Una — `Rp 31.000`
- Banggai — `Rp 31.000`
- Sigi — `Rp 31.000`

### Sulawesi Tenggara — Rp 31.000/kg *(Zona 5)*
- Kendari — `Rp 31.000`
- Bau-Bau — `Rp 31.000`
- Kolaka — `Rp 31.000`
- Konawe — `Rp 31.000`
- Muna — `Rp 31.000`
- Buton — `Rp 31.000`
- Wakatobi — `Rp 31.000`

### Sulawesi Utara — Rp 31.000/kg *(Zona 5)*
- Manado — `Rp 31.000`
- Bitung — `Rp 31.000`
- Tomohon — `Rp 31.000`
- Kotamobagu — `Rp 31.000`
- Minahasa — `Rp 31.000`
- Minahasa Utara — `Rp 31.000`
- Minahasa Selatan — `Rp 31.000`
- Bolaang Mongondow — `Rp 31.000`
- Kepulauan Sangihe — `Rp 31.000`
- Kepulauan Talaud — `Rp 31.000`

### 🆕 Gorontalo — Rp 50.000/kg *(OVERRIDE — naik dari 31rb)*
- Gorontalo — `Rp 50.000`
- Kabupaten Gorontalo — `Rp 50.000`
- Pohuwato — `Rp 50.000`
- Bone Bolango — `Rp 50.000`

### Sulawesi Barat — Rp 31.000/kg *(Zona 5)*
- Mamuju — `Rp 31.000`
- Mamasa — `Rp 31.000`
- Polewali Mandar — `Rp 31.000`
- Pasangkayu — `Rp 31.000`

---

## 🏝️ NUSA TENGGARA

### Nusa Tenggara Barat — Rp 28.000/kg *(Zona 4)*
- Mataram — `Rp 28.000`
- Lombok Barat — `Rp 28.000`
- Lombok Tengah — `Rp 28.000`
- Lombok Timur — `Rp 28.000`
- Lombok Utara — `Rp 28.000`
- Sumbawa — `Rp 28.000`
- Sumbawa Barat — `Rp 28.000`
- Dompu — `Rp 28.000`
- Bima — `Rp 28.000`
- Kabupaten Bima — `Rp 28.000`

### Nusa Tenggara Timur — Rp 28.000/kg *(Zona 4)*
- Kupang — `Rp 28.000`
- Kabupaten Kupang — `Rp 28.000`
- Ende — `Rp 28.000`
- Flores Timur — `Rp 28.000`
- Manggarai — `Rp 28.000`
- Manggarai Barat — `Rp 28.000`
- Sikka — `Rp 28.000`
- Sumba Barat — `Rp 28.000`
- Sumba Timur — `Rp 28.000`
- Timor Tengah Selatan — `Rp 28.000`
- Timor Tengah Utara — `Rp 28.000`

---

## 🌊 MALUKU

### Maluku — Rp 31.000/kg *(Zona 5)*
- Ambon — `Rp 31.000`
- Tual — `Rp 31.000`
- Maluku Tengah — `Rp 31.000`
- Maluku Tenggara — `Rp 31.000`
- Buru — `Rp 31.000`
- Seram Bagian Barat — `Rp 31.000`
- Seram Bagian Timur — `Rp 31.000`
- Kepulauan Aru — `Rp 31.000`
- Maluku Barat Daya — `Rp 31.000`
- Kepulauan Tanimbar — `Rp 31.000`

### Maluku Utara — Rp 31.000/kg *(Zona 5)*
- Ternate — `Rp 31.000`
- Tidore Kepulauan — `Rp 31.000`
- Halmahera Barat — `Rp 31.000`
- Halmahera Tengah — `Rp 31.000`
- Halmahera Timur — `Rp 31.000`
- Halmahera Selatan — `Rp 31.000`
- Halmahera Utara — `Rp 31.000`
- Kepulauan Sula — `Rp 31.000`
- Pulau Taliabu — `Rp 31.000`

---

## 🦜 PAPUA

### Papua — Rp 31.000/kg *(Zona 5)*
- Jayapura — `Rp 31.000`
- Merauke — `Rp 31.000`
- Nabire — `Rp 31.000`
- Sorong — `Rp 31.000`
- Manokwari — `Rp 31.000`
- Biak Numfor — `Rp 31.000`
- Fakfak — `Rp 31.000`
- Timika (Mimika) — `Rp 31.000`
- Wamena (Jayawijaya) — `Rp 31.000`
- Sarmi — `Rp 31.000`
- Raja Ampat — `Rp 31.000`
- Teluk Bintuni — `Rp 31.000`
- Teluk Wondama — `Rp 31.000`
- Kaimana — `Rp 31.000`
- Maybrat — `Rp 31.000`
- Tambrauw — `Rp 31.000`
- Pegunungan Bintang — `Rp 31.000`
- Yahukimo — `Rp 31.000`
- Puncak Jaya — `Rp 31.000`
- Yalimo — `Rp 31.000`
- Lanny Jaya — `Rp 31.000`
- Mappi — `Rp 31.000`
- Asmat — `Rp 31.000`
- Boven Digoel — `Rp 31.000`

---

## 📊 Ringkasan Statistik

| Pulau | Provinsi | Total Kota | Rate |
|---|---|---|---|
| Jawa | DKI + Banten + Jabar + Jateng + DIY + Jatim | 102 | 10rb–20rb |
| Bali | Bali | 9 | 20rb |
| Sumatra | Aceh | 16 | **40rb** ⚡ |
| Sumatra | Sumut/Sumbar/Riau/Kepri/Jambi/Sumsel/Babel/Bengkulu | 81 | 28rb |
| Sumatra | Lampung | 14 | **15rb** ⚡ |
| Kalimantan | Barat/Tengah/Selatan/Timur/Utara | 38 | 28rb |
| Sulawesi | Selsel/Sulteng/Sultra/Sulut/Sulbar | 51 | 31rb |
| Sulawesi | Gorontalo | 4 | **50rb** ⚡ |
| Nusa Tenggara | NTB + NTT | 21 | 28rb |
| Maluku | Maluku + Maluku Utara | 19 | 31rb |
| Papua | Papua + Papua Barat | 24 | 31rb |
| **TOTAL** | — | **~379** | — |

> ⚡ = ada CITY_RATES override aktif.

---

## Catatan Implementasi

- **Kalau mau ganti rate per provinsi:** edit di `cities.js` `CITY_RATES` map.
- **Kalau mau ganti rate per zona (bulk):** edit `cities.js` `ZONE_RATES` (akan affect semua kota di zona itu yang tidak punya override).
- **Mirror wajib:** apapun yang diubah di `cities.js`, harus mirror ke `public/checkout.html` + `public/checkout-en.html` (search `CITY_RATES = {` di kedua file).
- **Tidak perlu** regenerate `public/cities.json` karena struktur city object (name, zone, is_dki) tidak berubah — yang berubah hanya logic resolusi tarif.
- **>10 kg di luar Jabodetabek:** otomatis "Lion Cargo (ongkir dikonfirmasi admin)" — bypass tarif normal.

---

*File ini dibuat 9 Juni 2026. Update tanggal di header tiap kali revisi.*
