# Quickstart

Deploy instance Hermes pertama Anda dalam sekitar sepuluh langkah. Semuanya dilakukan sendiri lewat dashboard.

> **Status:** alur di bawah adalah alur yang direncanakan (PRD v1.0). Layar pendaftaran dan pembayaran
> masih berupa kerangka UI di pratinjau.

## 1. Daftar dan verifikasi akun

Buat akun lalu verifikasi. Private beta hanya untuk pengguna yang diundang.

## 2. Pilih plan dan region

Pilih plan dan region. Hanya plan dan region yang masih punya kapasitas yang ditampilkan.
Batas CPU, RAM, penyimpanan, dan jaringan ditampilkan jelas sebelum Anda membayar.

## 3. Beri nama instance

Masukkan nama instance. Nama hanya label untuk Anda. Nama container di server dibuat dari ID internal.

## 4. Tinjau ringkasan

Periksa spesifikasi, siklus tagihan bulanan, dan harga. Harga plan: `[BELUM DITENTUKAN]`.

## 5. Bayar

Bayar lewat metode yang tersedia (QRIS atau gateway pembayaran). Pembayaran diverifikasi di sisi server
sebelum instance dibuat.

## 6. Tunggu provisioning

Dashboard menampilkan progres. Status berjalan dari `Pending`, `Provisioning`, `Starting`, lalu `Active`.
Lihat [Siklus instance](dasar/siklus-instance.md).

## 7. Pilih penyedia AI

Pilih NibieRouter (default) atau kunci Anda sendiri (BYOK). Lihat [Penyedia AI](dasar/provider-ai.md).

## 8. Hubungkan Telegram

Buat bot lewat BotFather, lalu tempelkan token bot Anda. Lihat [Telegram](dasar/telegram.md).

## 9. Kirim pesan uji

Kirim pesan ke bot Anda. Jika agen membalas, instance siap dipakai.

## 10. Kelola dari dashboard

Menu instance: Access, Hermes, Monitor, Logs, Upgrade & Renew, Custom Domain, File Manager,
Configuration. Aksi: restart, stop atau start (sesuai status langganan), dan buka Web Console.

> **Keamanan:** skill kustom yang Anda pasang dapat menjalankan kode dan memengaruhi instance Anda sendiri.
> Pasang hanya skill yang Anda percaya.
