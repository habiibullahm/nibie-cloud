# Hubungkan Telegram

Telegram adalah kanal pertama yang didukung. Setiap instance memakai bot Telegram milik Anda sendiri.

## Langkah

1. Di Telegram, buka **@BotFather** dan buat bot baru. Simpan token bot yang diberikan.
2. Di dashboard, buka **Configuration > Telegram** lalu tempelkan token.
3. Sistem memeriksa token ke Telegram. Jika sah, token disimpan terenkripsi.
4. Kirim pesan uji ke bot Anda. Jika agen membalas, koneksi berhasil.

## Keamanan

- Jangan membagikan token bot. Satu token tidak boleh dipakai bersama oleh beberapa instance.
- Token tidak pernah muncul di log atau layar dashboard.
- Aktifkan pairing atau allowlist Hermes supaya hanya Anda yang bisa berbicara dengan agen.
  Panduan konfigurasi yang direkomendasikan: `[BELUM DITENTUKAN]`.

## Ganti atau cabut token

Anda bisa mengganti token atau menghapus koneksi kapan saja dari halaman yang sama. Jika token bocor,
cabut lewat BotFather lalu ganti di dashboard.

> Mode polling atau webhook ditentukan oleh perilaku gateway Hermes dan arsitektur deployment:
> `[BELUM DITENTUKAN]`.
