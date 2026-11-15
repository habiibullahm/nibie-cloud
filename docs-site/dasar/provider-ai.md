# Penyedia AI

Hermes membutuhkan penyedia model AI. Anda punya dua pilihan. Biaya AI selalu ditagih terpisah dari biaya hosting.

## NibieRouter (default)

NibieRouter adalah gateway AI dengan satu API key untuk banyak model. Format API-nya kompatibel dengan OpenAI.

- Base URL: `https://router.nibie.app/v1`
- Daftar model dan harga per token: `GET https://router.nibie.app/v1/models` (terbuka tanpa key).
  Daftar ini berubah, jadi jangan menyalin angkanya ke tempat lain.
- Pemakaian AI ditagih oleh NibieRouter, bukan oleh Nibie Cloud.
- Cara mendapat key dan mengisi saldo: `[BELUM DITENTUKAN]`.

Pemakaian AI di dashboard hanya ditampilkan jika data dari NibieRouter tersedia dan sahih.

## Kunci sendiri (BYOK)

Pakai akun penyedia Anda sendiri.

1. Buka **Configuration > Provider**.
2. Masukkan kredensial penyedia dan, jika perlu, base URL kustom.
3. Pilih **Test connection**. Kunci tidak pernah ditampilkan ulang.
4. Simpan.

Yang perlu diketahui:

- Kredensial disimpan terenkripsi.
- Anda bisa mengganti atau menghapus kunci kapan saja.
- Base URL kustom divalidasi dan dibatasi untuk mencegah akses ke jaringan internal (perlindungan SSRF).
- Biaya pemakaian ditagih oleh penyedia Anda, bukan oleh Nibie Cloud.

## Jika koneksi penyedia gagal

Dashboard menampilkan status koneksi dan pesan error yang sudah disanitasi. Periksa saldo atau kunci di sisi
penyedia sebelum menghubungi dukungan.
