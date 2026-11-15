# Pengenalan

> **Status:** private beta. Dashboard masih dalam pratinjau dan sebagian fitur belum aktif.

Nibie Cloud adalah layanan hosting terkelola untuk agen AI Hermes. Anda mendapat satu runtime
Hermes khusus milik Anda dengan penyimpanan permanen, tanpa mengurus VPS, Docker, deployment, atau
perawatan server.

Slogan produk: *jalankan agen AI pribadi Anda 24/7, tanpa VPS, tanpa setup, tanpa perawatan infrastruktur.*

## Yang Anda dapat

- Satu container terisolasi dan satu volume penyimpanan per pelanggan.
- Dashboard untuk mengelola instance: akses, status, monitor, log, file manager, dan konfigurasi.
- Shell penuh di dalam container Anda sendiri. Tidak ada akses SSH atau Docker ke server induk.
- Skill bawaan Hermes dan skill kustom buatan Anda.
- Pemulihan otomatis jika runtime bermasalah.

## Yang tidak termasuk

- Token AI. Biaya hosting dan biaya pemakaian AI dipisah, dan tidak ada paket token tak terbatas.
- Akses ke server induk, VPS umum, atau platform multi-agen.

## Biaya

| Komponen | Ditagih oleh |
| --- | --- |
| Hosting instance (langganan bulanan) | Nibie Cloud. Harga: `[BELUM DITENTUKAN]` |
| Pemakaian AI lewat NibieRouter | NibieRouter |
| Pemakaian AI dengan kunci sendiri (BYOK) | Penyedia pilihan Anda |

## Mulai dari mana?

| Anda ingin... | Baca |
| --- | --- |
| Menjalankan Hermes pertama kali | [Quickstart](quickstart.md) |
| Memahami status instance | [Siklus instance](dasar/siklus-instance.md) |
| Memilih penyedia AI | [Penyedia AI](dasar/provider-ai.md) |
| Menghubungkan Telegram | [Telegram](dasar/telegram.md) |
| Memahami tagihan dan masa tenggang | [Langganan](dasar/langganan.md) |
| Mengintegrasikan lewat API | [Rancangan API](api/gambaran.md) |

Dukungan awal tersedia lewat Telegram: `[BELUM DITENTUKAN: tautan]`.
