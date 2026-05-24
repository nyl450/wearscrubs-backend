# 📘 Panduan Admin Wearscrubs

Panduan langkah-demi-langkah memakai dashboard Wearscrubs untuk mengelola pesanan.
Tidak perlu paham teknologi — ikuti saja urutannya. Kalau bingung, hubungi James.

> **Alamat dashboard:** buka `wearscrubs.id` (atau alamat yang diberikan) lalu masuk ke halaman **Login**.

---

## 1. Masuk (Login)
1. Buka halaman dashboard.
2. Masukkan **username** dan **password** Anda.
3. Klik **Masuk**.

> Lupa password? Hubungi James — jangan coba-coba berkali-kali (akun bisa terkunci sementara demi keamanan).

---

## 2. Mengenal Menu (sebelah kiri)
- **Overview** — ringkasan: jumlah pesanan baru, penjualan.
- **Produk** — daftar baju.
- **Inventori** — stok per ukuran/warna + **Terima Stok**.
- **Popular** — atur produk "Terlaris" di website.
- **Pesanan** — semua order + proses dari bayar sampai kirim.
- **Input Order WA** — catat pesanan yang masuk lewat WhatsApp.
- **Pre-Order** — antrian pesanan yang menunggu stok / sedang dijahit.
- **Refund** — pengembalian uang (khusus bordir yang ditolak).
- **Tukar Size** — penukaran ukuran.

---

## 3. Gambaran Besar Alur Pesanan
Setiap pesanan jalan urut seperti ini:

```
Order masuk  →  Konfirmasi Bayar  →  (Bordir, jika ada)  →  Kemas  →  Kirim (+resi)  →  Selesai
```

Stok **otomatis berkurang** saat Anda konfirmasi pembayaran. Anda tinggal mengikuti tombol yang muncul di tiap tahap.

---

## 4. Mencatat Order dari WhatsApp (Input Order WA)
Saat dokter pesan via WA, catat di sini.

1. Klik menu **Input Order WA**.
2. **Data Pelanggan** — isi:
   - Nama Dokter/Pelanggan, Nomor WhatsApp, Kota Pengiriman, Alamat Lengkap.
   - Berat Paket (kg), Ekspedisi, Ongkos Kirim, Metode Pembayaran. (Catatan opsional.)
   - 💡 Pilih ekspedisi **"Free Ongkir"** atau **"Kirim sendiri"** → ongkir otomatis jadi 0.
3. **Produk Dipesan** → Item #1:
   - Pilih **Produk → Warna → Variant → Ukuran → Jumlah**.
   - Setelah pilih ukuran, muncul info **stok tersedia** (hijau = aman, kuning = menipis, merah = habis).
4. **Bordir** (hanya untuk produk **Atasan**):
   - Klik kotak **Nama** dan/atau **Logo** → isi detail (nama yang dibordir / posisi / warna benang).
   - Untuk Celana/Cap/Gown, bordir otomatis tidak aktif (memang tidak melayani bordir).
5. **Tambah produk lain** → klik **Tambah Produk**.
6. **Diskon** (opsional) — pilih 5% atau Consignment 30%.
7. Klik **Simpan & Generate Invoice WA**.
   - Tombol berubah jadi **abu-abu "Tersimpan"** = order sudah tercatat.
8. Klik **Kirim ke WA Customer** → WhatsApp otomatis terbuka berisi pesan konfirmasi + instruksi pembayaran. Tinggal **kirim**.
9. Untuk order berikutnya, klik **Order Baru** (form jadi bersih lagi).

### 4a. Ukuran Custom (mis. 4XL — di luar daftar)
- Di pilihan **Ukuran**, pilih **"✏️ Custom Size…"**.
- Isi **Label Ukuran** (mis. `4XL`) dan **Harga Satuan** (harga khusus ukuran itu).
- Barang custom **dijahit dulu** — lihat bagian **7** soal menandai siap.

### 4b. Jumlah Melebihi Stok (Pre-Order)
- Kalau jumlah yang dipesan **lebih banyak dari stok**, muncul peringatan + tombol **Jadikan Pre-Order**.
- Klik kalau pelanggan tetap mau pesan (barang menyusul). Lihat bagian **7**.

### 4c. Bonus (Gratis)
- Centang **🎁 Jadikan Bonus** kalau item itu hadiah/gratis (tidak ditagih).

---

## 5. Konfirmasi Pembayaran
Setelah pelanggan transfer & kirim bukti:
1. Buka menu **Pesanan** → klik pesanan yang dimaksud.
2. Klik **Konfirmasi Pembayaran**.
3. **Upload foto bukti transfer** → simpan.
4. Stok otomatis berkurang. Pesanan lanjut ke tahap berikutnya (Bordir atau Kemas).

> ⏰ Pelanggan wajib bayar maksimal **2×24 jam**. Lewat itu, sebaiknya pesanan dibatalkan.

---

## 6. Bordir (jika pesanan ada bordir)
- Setelah dibayar, pesanan ber-bordir masuk status **"Bordir"**.
- Setelah baju selesai dibordir, buka pesanan → klik **Bordir Selesai** → **centang konfirmasi** → pesanan jadi **siap dikemas**. (Foto opsional.)

---

## 7. Pre-Order & Custom (barang belum ada / dijahit dulu)
Pesanan dengan **Custom Size** atau **Pre-Order** **tidak bisa dikemas** sampai barangnya siap.

- **Custom (dijahit):** buka pesanan → setelah baju jadi, klik **Tandai Siap (custom selesai dijahit)**.
- **Pre-Order katalog (menunggu stok):** **otomatis siap** begitu Anda **Terima Stok** untuk ukuran itu (lihat bagian 12). Tidak perlu klik apa-apa.
- Selama belum siap, di detail pesanan ada label **"menunggu stok"** / **"menunggu dijahit"**.

> Lihat semua antrian Pre-Order di menu **Pre-Order** (ada umur hari-nya: makin lama makin perlu diprioritaskan).

---

## 8. Mengemas (Kemas)
1. Pesanan berstatus **siap kemas** → buka pesanan.
2. Klik **Kemas** → **centang konfirmasi** (sudah dikemas rapi + isi sesuai pesanan) → **Konfirmasi Dikemas**.
3. Foto **opsional** (boleh dilampirkan kalau perlu, tidak wajib).

---

## 9. Mengirim (Kirim + Resi)
1. Pesanan sudah dikemas → buka pesanan.
2. Klik **Kirim** → isi **Nomor Resi** (dan kurir bila perlu).
   - Kalau antar sendiri, pilih kurir **"Kirim sendiri"** (resi boleh kosong).
3. Klik **Kirim Resi ke Customer** → WhatsApp terbuka berisi nomor resi untuk pelanggan. Kirim.

---

## 10. Menyelesaikan Pesanan
Setelah barang sampai ke pelanggan, ubah status pesanan menjadi **Selesai**.

---

## 11. Membatalkan Pesanan
- Pesanan bisa dibatalkan **sebelum dikirim**.
- Buka pesanan → **Batalkan** → isi alasan.
- Kalau sudah dibayar, stok **otomatis dikembalikan**, dan dibuat catatan refund (untuk ditindaklanjuti manual).

> ⚠️ Pesanan yang **sudah dikirim tidak bisa dibatalkan**.

---

## 12. Menerima Stok dari Penjahit
Saat barang baru datang:
1. Menu **Inventori** → cari produk + ukuran/warnanya.
2. Klik tombol **➕ (Terima Stok)** pada baris itu.
3. Isi **jumlah** yang masuk → simpan.
4. Kalau ada **Pre-Order** yang menunggu ukuran itu, sistem **otomatis memenuhinya** (muncul pesan "Pre-Order terpenuhi") dan pesanan itu jadi siap dikemas.

> Varian yang ada antrian Pre-Order diberi tanda **oranye "N PO"** di Inventori.

---

## 13. Menu Pre-Order (antrian)
- Berisi semua pesanan yang **menunggu stok** (PO katalog) atau **menunggu dijahit** (custom).
- Tiap baris menampilkan: produk, pelanggan, jumlah, status bayar, dan **umur (berapa hari menunggu)**.
- Untuk item custom ada tombol **Tandai Siap** langsung di sini.

---

## 14. Tukar Size
- Pelanggan boleh tukar ukuran dalam **3 hari** setelah pesanan **Selesai**.
- Buka menu **Tukar Size** (atau dari detail pesanan) → pilih item → ukuran baru.
- Stok otomatis disesuaikan: ukuran lama kembali ke stok, ukuran baru dikeluarkan.

> 💡 **Tukar size BUKAN refund uang** — hanya ganti ukuran.

---

## 15. Refund (khusus bordir yang ditolak)
- **Produk TIDAK PERNAH dikembalikan uangnya** — hanya bisa tukar ukuran.
- **Refund uang HANYA** untuk **bordir yang ditolak** (misal hasil bordir salah).
- Buka menu **Refund** → proses sesuai data → upload bukti transfer pengembalian.

---

## 16. Cek Stok & Penjualan
- **Overview** — lihat jumlah pesanan baru & ringkasan penjualan.
- **Inventori** — lihat stok tiap ukuran (merah = habis, kuning = menipis).
- **Popular** — pilih produk yang tampil sebagai "Terlaris" di website.

---

## ⭐ Aturan Penting (hafalkan ini)
1. **Produk tidak pernah refund uang** — hanya **tukar size**.
2. **Refund uang hanya untuk bordir yang ditolak.**
3. **Bordir hanya untuk Atasan** (bukan celana/cap/gown).
4. Pelanggan wajib bayar maksimal **2×24 jam**.
5. **Custom & Pre-Order** harus **siap dulu** sebelum bisa dikemas.
6. Selalu **kirim pesan WA konfirmasi** ke pelanggan setelah mencatat order, dan **kirim resi** setelah dikirim.

## 📞 Rekening & Kontak
- **BCA** `8780269791` a/n **Priscilla Lavine**
- **Mandiri** `1220010735721` a/n **Priscilla Lavine**
- WhatsApp toko: `+62 878-8717-2220`
- Ada masalah teknis / error → **hubungi James**.

---
*Panduan ini juga bisa dibuka langsung di dashboard lewat menu **Panduan**.*
