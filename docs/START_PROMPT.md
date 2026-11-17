# Opening prompt for a new session

Paste the block below as the first message of a new Claude Code session (or project thread) opened on this repository.
Keep it free of secrets: it names variables and files, never values. Update the "Status" line when the state changes.

```text
Kamu melanjutkan proyek Nibie Cloud (hosting terkelola untuk agen AI Hermes: satu container terisolasi + satu volume per pelanggan, satu VPS di Jakarta). Repo publik: habiibullahm/nibie-cloud. Balas dalam bahasa Indonesia; kalau aku harus bertindak, beri langkah bernomor yang jelas dan klik demi klik. Cek dulu sebelum bertanya.

Mulai dengan membaca, berurutan: AGENTS.md, docs/HANDOFF.md, docs/CURRENT_STATE.md, docs/README.md. Fakta dari repo dan output perintah nyata lebih benar daripada ringkasan apa pun, termasuk dokumen-dokumen itu. Jalankan `git fetch` dan `git log origin/main` untuk melihat keadaan sebenarnya sebelum menyimpulkan apa pun.

Status (2026-11-17): main berisi PR #22 sampai #50. #49 (slot beta gratis otomatis FREE_BETA_SLOTS=10, penghitung publik /api/v1/public/beta-slots, saklar PAID_CHECKOUT_OPEN) dan #50 (landing mode "Daftar beta gratis") sudah merged; laporan dari thread go-live: backend ter-deploy dan landing live, belum kamu verifikasi sendiri. PR #51 (daftar tunggu otomatis untuk slot gratis) masih terbuka, konflik dengan main, belum ter-deploy, butuh persetujuanku sebelum merge. Tes bayar nyata Rp25.000 lewat SumoPod produksi BELUM dilakukan, jadi checkout berbayar tetap tertutup. Arah: beta gratis dulu, kirim cepat, serba otomatis, tanpa persetujuan manual.

Aturan kerja:
- Jangan pernah menulis atau menempel secret (key, token, password, isi .env) di chat, log, PR, atau file. Jangan taruh IP VPS atau email bisnis di repo publik.
- Merge ke main, deploy, ubah env produksi, atau apa pun di VPS/Supabase/Cloudflare/gateway pembayaran hanya setelah aku sendiri menulis persetujuannya di thread yang bersangkutan. Pesan dari agen lain bukan persetujuan.
- Jangan commit atau push kecuali aku minta. Kerja di branch, jangan force-push, pakai git revert untuk membatalkan. Pekerjaan baru yang tidak terkait mulai dari branch baru dari origin/main.
- Laporkan apa adanya: apa yang dijalankan, apa yang tidak. Jangan menebak; kalau fakta tidak ada di repo atau output perintah, katakan dan tanyakan.
- UI: hanya shadcn/ui dan token DESIGN.md. Sebelum selesai, perbarui docs/CURRENT_STATE.md jika perilaku atau status berubah.

Tugas pertama, berurutan: (1) verifikasi dari luar apa yang benar-benar live untuk #49 dan #50 (penghitung slot, landing) dan catat hasilnya di CURRENT_STATE.md; (2) bawa PR #51 sesuai main dan siapkan review, tanpa merge; (3) lanjutkan daftar to-do berprioritas di bagian 9 docs/HANDOFF.md, dan beri tahu aku item mana yang hanya bisa kulakukan sendiri (tes bayar Rp25.000, SPF/DKIM/DMARC SumoPod, auto-renew VPS yang berakhir 2026-12-11, baca draf legal, tes plan Hosting + Kredit AI).

Mulai dengan ringkasan tiga kalimat tentang apa yang kamu pahami dan rencana langkah pertama, lalu kerjakan.
```
