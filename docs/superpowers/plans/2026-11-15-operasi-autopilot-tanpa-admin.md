# Nibie Cloud: operasi autopilot tanpa admin hands-on — audit dan rencana

Tanggal: 2026-11-15 (malam). Status: **Disetujui Nash 2026-11-15 ("setuju semua rekomendasi"). Fase 1: alert di dalam backend (1.1, 1.2) ada di PR dari branch `claude/project-thread-uym76i`; `/readyz` dan watchdog host (1.3, 1.4) sudah ditulis ulang lebih kecil oleh thread go-live (PR #33). Belum ada yang dipasang oleh PR ini di VPS.**
Dasar: audit baca-saja atas repo (`main` d44586f), `docs/prd.md` (bagian 10, 11, 12, 13, 17, 19), `docs/CURRENT_STATE.md`, `docs/architecture.md` ("Known gaps"), `deploy/`, `ops/egress/`, dan handoff 2026-11-15.
Aturan baca: yang saya tulis "terverifikasi" artinya terlihat di kode atau di catatan hasil uji repo. Yang tidak ada di repo saya tandai **belum diketahui** dan harus dicek di VPS oleh Nash atau thread VPS.

Penanda pemilik tugas:

- **[T]** dikerjakan thread ini lewat kode di repo (branch, tes, PR). Tidak jalan di produksi sampai Nash bilang "push" dan men-deploy.
- **[H]** perubahan di host VPS. Thread menyiapkan skrip + langkah klik-per-klik; dijalankan di thread VPS atau oleh Nash, dengan konfirmasi Nash diketik langsung di thread VPS.
- **[N]** hanya Nash: membuat akun, memutuskan, membayar, memegang kredensial.

---

## 1. Ringkasan untuk Nash

Perjalanan pelanggan (daftar, bayar, instance jadi, pengingat, grace, suspend, hapus) **sudah otomatis di kode**, tetapi belum terbukti dengan pembayaran nyata. Yang paling kurang bukan fitur pelanggan, melainkan **mata dan telinga operator**: sekarang tidak ada satu pun alert ke Nash. Kalau reconciler menyerah, VPS mati, disk penuh, atau pembayaran masuk tapi instance gagal dibuat, tidak ada yang memberi tahu. "Tanpa admin" hanya aman kalau sistem **berteriak sendiri** saat butuh manusia dan **diam-diam sembuh** untuk sisanya.

Tiga kenyataan yang perlu Nash tahu sejak awal:

1. **Tagihan berulang tidak bisa benar-benar otomatis** dengan VA dan QRIS lewat Duitku POP: tiap periode adalah invoice baru yang harus dibayar pelanggan sendiri (`docs/architecture.md` gap 9a). Yang bisa diotomatiskan: pengingat, invoice, suspend, hapus. Auto-debit kartu atau e-wallet **belum diketahui** apakah Duitku mengizinkan untuk merchant Nash; itu pertanyaan ke Duitku, bukan kode.
2. **Satu VPS = satu titik gagal.** Autopilot bisa menyembuhkan proses dan container, tidak bisa menyembuhkan VPS yang mati atau kedaluwarsa (paket VPS habis **2026-12-11**). Itu harus ditutup dengan backup di luar VPS, runbook pemulihan, dan perpanjangan otomatis.
3. **Ada hal yang tetap butuh manusia**: dukungan pelanggan, penyalahgunaan (abuse), sengketa pembayaran, dan KYC. Rencana ini membuatnya masuk antrean pengecualian yang sampai ke Telegram Nash dengan konteks, dan menurunkan frekuensinya, bukan menghilangkannya.

---

## 2. Audit: apa yang sudah otomatis

| Area | Yang berjalan sendiri (terlihat di kode) | Bukti | Catatan belum terbukti |
| --- | --- | --- | --- |
| Pemulihan instance | Reconciler tiap 15 detik: container mati atau gateway tak sehat dipulihkan, maksimal 3 percobaan dengan backoff + jitter, jendela stabilitas mengembalikan jatah percobaan; instance `STOPPED` tidak pernah dihidupkan ulang | `reconciler.ts` | Setelah 3 kali gagal instance jadi `DEGRADED` (`recovery_exhausted`) dan **berhenti, tidak ada yang diberi tahu** |
| Antrean kerja | Aksi lifecycle lewat BullMQ, retry 4x, reaper lease basi, sweeper untuk `PENDING` yatim, reconciler jalan di bawah kunci Redis | `src/modules/jobs/*` | Job yang habis retry hanya terlihat di `GET /jobs/failed` (butuh `ADMIN_TOKEN` dari SSH) |
| Pembayaran | Callback Duitku diverifikasi HMAC sebelum akses DB, idempoten lewat `PaymentEvent`; instance dibuat setelah pembayaran terverifikasi; ada perbaikan jika crash di tengah (`ensureInstance`, `restartIfPending`) | `duitku-callback.ts`, `billing-tick.ts` | Lolos sandbox lokal dengan callback bertanda tangan; **belum** ada pembayaran Duitku nyata, billing di VPS masih mati |
| Siklus langganan | Tick billing: pengingat 7/3/1 hari, grace 3 hari, suspend (instance di-stop, volume disimpan), retensi 30 hari, hapus + bersihkan secret, tutup invoice kedaluwarsa, tutup pembelian terbengkalai 7 hari | `lifecycle.ts`, `billing-tick.ts` | Email lewat SumoPod belum terbukti sampai ke inbox; email invite Supabase masuk Spam, SPF/DKIM/DMARC belum dicek |
| Kunci router + kredit | `RouterProvisioner` membuat user, key, kredit sekali (`CreditGrant`), dicoba ulang tiap tick | `router-provisioner.ts` | Berhenti setelah 24 percobaan lalu butuh operator; alur penuh setelah bayar nyata belum terbukti |
| Disk tenant | `DiskMonitor` mencatat `disk.warning`/`disk.full`/`disk.ok` | `disk-monitor.ts` | Hanya catatan di DB (informasi), tidak ada notifikasi ke siapa pun |
| Host | Reboot: XFS, egress, Docker, semua container kembali sendiri; `restart: unless-stopped` untuk Redis, backend, Caddy; log Docker dirotasi (10 MB x 3-5) | `deploy/README.md`, `compose.prod.yaml` | Tenant memakai `RestartPolicy: no`, jadi **pemulihan tenant sepenuhnya bergantung pada backend hidup** |
| TLS | Caddy memperbarui sertifikat Let's Encrypt sendiri (volume `caddy_data` persisten); landing, dashboard, docs berjalan di Cloudflare Workers dengan sertifikat terkelola | `Caddyfile`, `compose.prod.yaml` | Tidak ada pemeriksaan atau alert bila perpanjangan gagal; syarat: port 80/443 terbuka, DNS tetap awan abu-abu |
| Backup database | `hermes-db-backup` tiap hari 19:00 UTC via systemd timer, simpan 14 | `CURRENT_STATE.md` | Hanya di VPS (tanpa salinan R2), restore **belum pernah dilatih**, tidak ada alert jika timer gagal |
| CI | `ci.yml` (typecheck, lint, tes 4 paket), `e2e.yml` (T0 per PR, T1 harian, T2 smoke produksi harian) | `.github/workflows` | T1 menunggu secret `E2E_*` dari Nash; hasil merah hanya terlihat di GitHub |

## 3. Audit: celah yang masih manual atau buta

Urutan dari yang paling berbahaya bagi bisnis tanpa admin.

| # | Celah | Dampak jika dibiarkan | Dasar |
| --- | --- | --- | --- |
| G1 | **Tidak ada alert operator sama sekali.** Pencarian di `src/` tidak menemukan kode alert, webhook, atau notifikasi operator | Pemulihan habis, pembayaran macet, disk penuh, Redis mati: Nash tahu dari keluhan pelanggan | PRD 13.2 "Alert operators when automated recovery is exhausted" belum dibangun |
| G2 | **Tidak ada pemeriksaan dari luar dan tidak ada "dead-man's switch".** `/healthz` hanya mengatakan proses hidup, bukan DB/Redis/Docker/reconciler | VPS mati atau reconciler macet diam-diam; pelanggan bayar tapi tidak dilayani | `server.ts:77`; deploy README |
| G3 | **Backend `unhealthy` tidak di-restart otomatis** (Docker tidak melakukan itu tanpa autoheal) | Backend hang = semua pemulihan tenant berhenti | `compose.prod.yaml` hanya `restart: unless-stopped` |
| G4 | **Pembayaran masuk tapi callback tidak datang** tidak ada pemeriksaan status ke Duitku | Uang diterima, pelanggan tidak punya instance, tidak ada yang tahu | Gap 9a: "no status-check call for an invoice whose callback never arrives" |
| G5 | **Pembayaran sukses tapi instance `FAILED` saat provisioning** tidak ada jalur otomatis atau notifikasi | Pelanggan membayar, tidak dapat layanan | `state-machine.ts` (`FAILED` hanya ke `PROVISIONING`/`DELETING`); perbaikan hanya untuk `instanceId` kosong |
| G6 | **Pengingat tidak membawa pelanggan ke pembayaran**: email menaut ke daftar instance; invoice Duitku hanya berlaku 60 menit | Churn tak sengaja, suspend yang sebenarnya bisa dicegah | `INVOICE_EXPIRY_MINUTES = 60`, `email-templates.ts` |
| G7 | **Tidak ada backup volume tenant sama sekali**, dan tidak ada salinan DB di luar VPS | Disk/VPS rusak = data semua pelanggan hilang; PRD release gate #4 "Backup restoration has been demonstrated" belum terpenuhi | `CURRENT_STATE.md` "tenant volumes are still not backed up" |
| G8 | **Tidak ada batas kapasitas.** Hanya `MAX_INSTANCES_PER_TENANT`; tidak ada batas global atau pemeriksaan RAM node | Penjualan melebihi RAM (perkiraan nyata 15-30 user) = OOM berantai di semua pelanggan | `architecture.md` gap 7; handoff butir 14 |
| G9 | **Higiene host manual** (catatan 2026-11-15 dari memori proyek: image lama sudah dipangkas sekali secara manual jadi 2 terbaru, `ufw` aktif hanya port 22 dan Caddy membuka 80/443; keduanya belum terjadwal/terverifikasi ulang): image backend lama menumpuk, project id XFS yatim bertambah tiap hapus, tidak ada pembersihan terjadwal, **belum diketahui** apakah `unattended-upgrades`, rotasi journald, NTP, fail2ban/ufw aktif | Disk penuh, patch keamanan tertinggal | `CURRENT_STATE.md`, handoff butir 13 |
| G10 | **Paket VPS kedaluwarsa 2026-12-11** dan perpanjangan bergantung pada ingatan manusia | Seluruh layanan mati | Memori proyek |
| G11 | **Pengiriman email belum terbukti** (Spam, SPF/DKIM/DMARC) | Pengingat dan peringatan hapus tidak sampai; data pelanggan dihapus tanpa dia tahu | Handoff butir 5 |
| G12 | **Satu titik gagal**: satu VPS, Redis di VPS (AOF belum diuji crash), `SECRETS_KEK` hanya di env VPS + Bitwarden | Tidak ada jalur pemulihan bencana yang tertulis dan pernah dicoba | `architecture.md` gap 6, 8 |
| G13 | **Deploy backend manual** (SSH, `hc`, migrasi tangan), tanpa rollback terskrip | Deploy salah = downtime panjang; wajar sengaja manual, tetapi harus aman dan terskrip | `deploy/README.md` |
| G14 | **Pelanggan tidak diberi tahu saat agennya `DEGRADED`/mati** | Keluhan masuk lewat jalur tak terstruktur | tidak ada kode email untuk itu |
| G15 | **Dukungan, abuse, refund** belum punya kebijakan operasional | Satu laporan abuse atau sengketa menghabiskan hari Nash | PRD butir 21 no. 11 (abuse) belum diputuskan; Duitku tanpa refund |
| G16 | Secret/kredensial kedaluwarsa: kunci admin NibieRouter tanpa batasan IP, kunci SumoPod, kunci Duitku, password DB | Kegagalan senyap saat kredensial berputar | `architecture.md` 9b |

---

## 4. Rancangan (ringkas)

Tiga lapis, dari dalam ke luar, supaya kegagalan satu lapis tertangkap lapis berikutnya:

1. **Dalam aplikasi (backend):** modul `ops` baru — `Alerter` (Telegram ke Nash, dengan dedupe + cooldown + pemulihan "sudah beres"), tabel `OperatorAlert`, emisi dari titik yang sudah ada (reconciler `recovery.exhausted`, `provisioning.stalled`, job gagal habis, tick billing gagal, router habis percobaan, pembayaran PAID tanpa instance, disk penuh), `/readyz` internal, denyut jantung (heartbeat) tiap tick yang berhasil, ringkasan harian "semua baik".
2. **Di host (independen dari backend):** `hermes-watchdog` (systemd timer 1 menit): Docker, kesehatan container backend dan restart bila `unhealthy` 3x berturut-turut, disk `/` dan XFS, RAM tersedia, umur sertifikat, rantai iptables egress, mount XFS, NTP. Mengirim alert sendiri lewat curl, jadi tetap bersuara walau backend mati.
3. **Di luar VPS:** monitor uptime eksternal gratis memantau `https://api.cloud.nibie.app/readyz`, landing, dan dashboard, ditambah **monitor heartbeat** yang menandai masalah bila tick backend berhenti datang. Inilah yang menangkap kasus "VPS mati total" dan "alert sendiri ikut mati".

Prinsip yang saya pegang (selaras PRD 13.3): satu alert = satu tindakan yang jelas, tidak ada alert informatif tanpa tindakan, setiap alert membawa tenant/instance/penyebab/langkah aman berikutnya, alert yang sama tidak diulang lebih dari sekali per jam dan ada pesan penutup saat pulih, secret tidak pernah masuk pesan, kegagalan mengirim alert tidak boleh memengaruhi layanan pelanggan.

Saluran alert yang direkomendasikan: **bot Telegram pribadi** (gratis, instan; Nash sudah memakai Telegram) dengan email bisnis sebagai cadangan lewat monitor eksternal.

---

## 5. Rencana kerja (gaya Superpowers: tugas kecil, tes dulu, bukti sebelum klaim)

Urutan fase = urutan prioritas. Fase 0 dan 1 adalah syarat sebelum menerima pelanggan berbayar tanpa pengawasan.

### Fase 0 — Keputusan dan akun (menunggu Nash, tidak butuh kode)

| Tugas | Pemilik | Ukuran |
| --- | --- | --- |
| 0.1 Setujui rencana ini dan jawab 6 pertanyaan di bagian 7 (atau "setuju semua rekomendasi") | [N] | S |
| 0.2 Buat bot Telegram untuk alert operator (langkah klik di Lampiran A) | [N] | S |
| 0.3 Buat akun monitor uptime + heartbeat gratis (Lampiran B) | [N] | S |
| 0.4 Aktifkan perpanjangan otomatis paket VPS Tencent dan pasang pengingat kalender 2026-12-01 (Lampiran C) | [N] | S |
| 0.5 Perbaiki SPF/DKIM/DMARC SumoPod untuk domain pengirim; uji kirim ke Gmail dan cek folder Spam | [N] | M |
| 0.6 Tanyakan ke Duitku: apakah ada API cek status transaksi untuk POP dan auto-debit (kartu/e-wallet) untuk merchant ini | [N] | S |

### Fase 1 — Mata dan telinga: alert, health check, watchdog (celah G1, G2, G3, G14 sebagian)

Tujuan: setiap keadaan yang butuh manusia sampai ke Telegram Nash dalam 5 menit; setiap keadaan yang bisa sembuh sendiri sembuh sendiri; keheningan itu sendiri terdeteksi.

- [x] **1.1 [T] Modul `Alerter`.** Berkas: `src/modules/ops/alerter.ts`, `telegram-alerter.ts`, migrasi `OperatorAlert` (kunci unik `dedupeKey`, `firstSeenAt`, `lastSentAt`, `resolvedAt`, `severity`). Env baru (hanya nama): `OPS_TELEGRAM_BOT_TOKEN`, `OPS_TELEGRAM_CHAT_ID`. Lewat `safeFetch`. Tes dulu: dedupe + cooldown 1 jam, pesan penutup saat pulih, redaksi secret, gagal kirim tidak melempar ke pemanggil, Telegram mati tidak memblokir tick.
- [x] **1.2 [T] Pasang titik emisi.** Dari data yang sudah ada: `recovery.exhausted`, `provisioning.stalled`, instance `FAILED`, job gagal habis retry, tick billing gagal berturut-turut (≥3), `RouterProvisioning` mencapai 5 dan 24 percobaan, lonjakan callback dengan tanda tangan salah, kegagalan kirim email berturut-turut, `disk.full`, Redis terputus >2 menit, Docker tak terjangkau, canary egress gagal saat start. Satu tes per titik dengan fake.
- [ ] **1.3 [T] `/readyz` internal + heartbeat + ringkasan harian.** `/readyz` memeriksa DB, Redis, Docker, dan umur tick reconciler terakhir (tidak membocorkan detail ke publik, hanya `ok`/`fail`). `OPS_HEARTBEAT_URL` dipanggil tiap tick maintenance yang sukses (opsional, dilewati bila kosong). Pesan harian 09:00 WIB: instance aktif, pembayaran 24 jam, alert terbuka, backup terakhir. **Tidak adanya** pesan harian juga sinyal. Rute `/readyz` perlu ditambahkan ke allowlist Caddyfile.
- [ ] **1.4 [T] Skrip host `ops/host/hermes-watchdog.sh` + unit systemd.** Pemeriksaan di bagian 4 lapis 2; restart backend hanya bila `unhealthy` 3 pemeriksaan berturut-turut dan maksimal 3 kali per jam (setelah itu alert, bukan loop); tidak pernah menyentuh container tenant; env di `/etc/hermes-cloud/ops.env` mode 600. Tes: `shellcheck` dan harness dengan perintah palsu.
- [ ] **1.5 [H] Pasang di VPS** (setelah PR dimerge dan Nash menyetujui di thread VPS): salin skrip, isi env, aktifkan timer, picu alert uji, matikan backend dengan sengaja di jam sepi dan buktikan: alert datang, backend pulih sendiri.
- [ ] **1.6 [N] Pasang monitor eksternal** (Lampiran B) setelah 1.3 live; uji dengan menghentikan backend 6 menit.
- [ ] **1.7 [T] Email "agen Anda bermasalah / sudah pulih" ke pelanggan** (G14): dipicu `recovery.exhausted` dan `instance.active` setelah `DEGRADED`, bahasa Indonesia, sekali per kejadian, melalui `BillingNotice`-style klaim unik.

Bukti selesai Fase 1: tangkapan alert Telegram untuk (a) recovery habis, (b) backend dimatikan dan dipulihkan watchdog, (c) heartbeat berhenti lalu monitor eksternal mengirim peringatan, (d) pesan harian tiba.

### Fase 2 — Penagihan yang menutup uang (G4, G5, G6, G11, G16)

- [ ] **2.1 [T] Rekonsiliasi pembayaran.** Job di tick billing: payment `PENDING` yang sudah >10 menit atau `PAID` tanpa instance >15 menit. Bila Duitku menyediakan cek status (tugas 0.6, **harus diverifikasi di sandbox dulu**), panggil dan proses lewat jalur idempoten yang sama dengan callback; bila tidak ada, minimal alert "invoice menggantung" dengan order id. Alert terpisah untuk "uang masuk, instance tidak ada".
- [ ] **2.2 [T] Jalur gagal-provisioning setelah bayar (G5).** Aturan: instance `FAILED` pada langganan yang sudah dibayar → otomatis dicoba ulang 2 kali dengan jeda, lalu alert kritis ke Nash dengan opsi aman (coba lagi / tandai refund manual). Tes dengan runtime palsu yang gagal.
- [ ] **2.3 [T] Pengingat yang bisa ditindaklanjuti (G6).** Tautan dalam di email: `…/dashboard/instances/<id>/billing?renew=1` yang membuka halaman tagihan dan menyiapkan invoice baru setelah login (invoice Duitku hanya 60 menit, jadi tautan bayar langsung di email tidak bisa dipakai). Tambahkan pengingat hari H dan H+1 selama grace; salinan teks ke Telegram pelanggan jika sudah tersambung (opsional, ditunda bila memperumit).
- [ ] **2.4 [T] Tes ujung ke ujung siklus** dengan jam palsu: bayar → aktif → T-7/T-3/T-1 → grace → suspend → bayar saat suspend (instance hidup lagi) → retensi → hapus; sudah ada sebagian di tes billing, lengkapi celahnya, jangan menggandakan.
- [ ] **2.5 [T] Alert untuk kredensial yang berputar:** pemeriksaan harian ringan ke NibieRouter (admin key valid), SMTP (koneksi), Duitku (tanda tangan uji bila ada endpoint aman). Gagal = alert. Tidak ada secret di pesan.
- [ ] **2.6 [N] Uji bayar nyata** Rp 25.000 setelah KYC (langkah panduan produksi yang sudah ada), dan uji penerimaan email di Gmail/Outlook.
- [ ] **2.7 [N] Keputusan auto-debit** (bergantung jawaban Duitku 0.6): jika tersedia, rencana terpisah; jika tidak, kebijakan "bayar manual tiap bulan" ditulis jelas di landing/docs.

### Fase 3 — Higiene host terjadwal (G9, G10 sebagian)

Semua [H] dengan skrip yang disiapkan thread, dan idempoten.

- [ ] **3.1 Pembersihan terjadwal** mingguan: `docker image prune` untuk image backend lama, simpan 2 terbaru + image yang sedang dipakai + canary + Hermes terpasang; jangan pernah `docker system prune` / prune volume. Dry-run dulu, hasil dikirim sebagai ringkasan.
- [ ] **3.2 Project id XFS yatim:** skrip yang mendaftar project id tanpa volume, melaporkan jumlah; menghapus hanya setelah verifikasi volume benar-benar tidak ada, dan membatasi kecepatan. Pertama hanya lapor.
- [ ] **3.3 Pemeriksaan dan penyetelan OS (baca-saja dulu):** `unattended-upgrades` aktif untuk keamanan, kebijakan reboot kernel (jendela jam sepi, hanya bila reboot diperlukan, setelah itu cek bahwa semua layanan kembali), batas ukuran journald, NTP sinkron, ufw hanya 22/80/443, fail2ban atau setara. Hasil cek dilaporkan dulu, lalu perubahan satu-satu dengan persetujuan Nash.
- [ ] **3.4 Umur sertifikat:** watchdog mengirim alert bila `api.cloud.nibie.app` < 14 hari.
- [ ] **3.5 Alert paket VPS:** pengingat kalender + (jika Tencent menyediakan) notifikasi tagihan ke email Nash; lihat Lampiran C.

### Fase 4 — Backup dan pemulihan yang terbukti (G7, G12)

- [ ] **4.1 [H] Salin backup DB ke Cloudflare R2** (terenkripsi, bucket privat, token hanya-tulis untuk VPS), retensi 14 harian + 8 mingguan, alert bila dump terakhir >26 jam atau salinan R2 gagal.
- [ ] **4.2 [T] Backup volume tenant:** arsip per instance (`ACTIVE`/`STOPPED`) harian, pada jam sepi, satu per satu (batas I/O), terenkripsi di sisi VPS sebelum keluar, checksum + catatan di tabel `Backup` (PRD bagian 14), retensi 7 hari, tidak mencadangkan instance yang sudah `DELETED`; menghormati kebijakan penghapusan (backup ikut kedaluwarsa setelah penghapusan, tulis di kebijakan privasi).
- [ ] **4.3 [T+H] Latihan restore otomatis mingguan:** pulihkan satu backup acak ke volume sementara + container uji, cek integritas (checksum + gateway menjawab), hapus; hasil ke Telegram. Gagal = alert (PRD "Failed backup restoration" adalah pengecualian manusia).
- [ ] **4.4 [N] Simpan salinan `SECRETS_KEK`, `HERMES_MASTER_KEY` dan kunci enkripsi backup** di Bitwarden dan satu lokasi terpisah; tanpa itu backup tak bisa dibuka. Konfirmasi tertulis ke saya "sudah", tanpa menempel nilainya.
- [ ] **4.5 [T] Dokumen pemulihan bencana** (VPS baru dari nol → layanan hidup lagi), dilatih sekali pada VPS cadangan kecil sebelum rilis; catat waktu sebenarnya (RTO) dan titik data (RPO).

### Fase 5 — Kapasitas dan pengaman penjualan (G8)

- [ ] **5.1 [T] Reservasi kapasitas node:** hitung memori + CPU yang dijanjikan ke instance aktif terhadap batas aman node (`RuntimeNode`, kolom kapasitas bila perlu); `POST /subscriptions/checkout` menolak dengan pesan ramah "penuh, daftar tunggu" saat reservasi >80%, dan paket otomatis dianggap tidak dijual di `GET /plans` (pelanggan tidak membayar untuk sesuatu yang tidak bisa dibuat). Pembukaan kembali manual atau otomatis di bawah 70%.
- [ ] **5.2 [T] Alert kapasitas** pada 70% dan 85% (reservasi dan RAM nyata), plus disk node.
- [ ] **5.3 [H] Ukur RAM/disk nyata** satu instance Hermes di bawah `runsc` pada plan 1 CPU/1 GB/1 GB (sampai sekarang belum terukur) dan pakai angka itu untuk batas 5.1.
- [ ] **5.4 [N] Rencana node kedua:** keputusan pemicu (mis. 70% terpakai selama seminggu) dan anggaran; implementasi multi-node adalah milestone sendiri, bukan bagian rencana ini.

### Fase 6 — Runbook insiden dan antrean pengecualian (G13, G15)

- [ ] **6.1 [T] `docs/runbook-operasi.md`** (Indonesia): tiap alert dari Fase 1-5 punya satu entri: arti, dampak ke pelanggan, tindakan klik-per-klik, kapan aman menunggu. Format satu halaman per alert.
- [ ] **6.2 [T] Skrip deploy dan rollback** `ops/host/deploy.sh` (build, migrasi dengan dump DB dulu, recreate, cek `/readyz`, rollback otomatis ke tag sebelumnya bila gagal). Tetap dipicu manusia; deploy otomatis ke produksi sengaja tidak diusulkan sebelum ada staging.
- [ ] **6.3 [T] Alat operator aman:** perintah `hc ops` untuk daftar alert terbuka, instance bermasalah, job gagal, status backup, tanpa mengetik token admin tiap kali.
- [ ] **6.4 [N] Putuskan kebijakan dukungan dan abuse:** jam balas, kanal tunggal (email atau Telegram), balasan otomatis, FAQ di docs; kebijakan penghentian paksa akun yang melanggar (PRD butir 21 no. 11). Thread menulis drafnya, Nash memutuskan.
- [ ] **6.5 [T] Uji "game day"** sebelum rilis: matikan backend, Redis, dan simulasi disk penuh satu per satu di jam sepi; catat apakah alert datang dan sistem pulih, perbaiki celah yang ketemu.

### Fase 7 — Nanti (setelah pelanggan berbayar nyata)

Redis terkelola (Tencent Jakarta), node kedua, staging, deploy otomatis, rotasi `HERMES_MASTER_KEY`/KEK terjadwal, IP allowlist untuk kunci admin NibieRouter setelah `X-Real-IP` benar, audit log operator, dasbor metrik.

---

## 6. Apa yang tetap butuh manusia setelah rencana ini

Dengan semua fase selesai, Nash hanya dipanggil untuk: node/VPS mati total atau kedaluwarsa; kegagalan restore backup; instance pelanggan yang sudah bayar gagal dibuat setelah 2 percobaan; kapasitas penuh atau jaringan egress diblokir; laporan abuse; sengketa pembayaran dan refund manual (Duitku tidak punya refund); pertanyaan pelanggan yang tidak terjawab FAQ; rotasi kredensial. Perkiraan, bukan janji: pada beta kecil biasanya beberapa kali sebulan, bukan harian. Angka sebenarnya harus diukur selama beta.

## 7. Pertanyaan untuk Nash (jawab "setuju semua rekomendasi" bila setuju)

1. **Saluran alert:** Telegram pribadi (rekomendasi) + email cadangan dari monitor eksternal. Alternatif: email saja.
2. **Tagihan berulang:** mulai dengan pengingat + tautan masuk ke halaman bayar (rekomendasi); tanyakan auto-debit ke Duitku untuk tahap berikutnya.
3. **Batas kapasitas:** tutup penjualan otomatis di 80% reservasi, buka kembali manual (rekomendasi: buka manual agar tidak berayun).
4. **Backup volume tenant:** harian, retensi 7 hari, ke R2, terenkripsi (rekomendasi). Biaya R2 kecil untuk volume 1 GB x puluhan pelanggan; saya hitung angka pastinya sebelum Fase 4.
5. **Pembersihan host:** image lama dihapus otomatis tiap minggu, project id XFS hanya dilaporkan sampai Nash setuju penghapusan otomatis (rekomendasi).
6. **Dukungan:** satu kanal (email bisnis atau Telegram), tanpa janji SLA waktu balas selama beta (rekomendasi), FAQ di docs.

## 8. Urutan eksekusi yang saya usulkan

Fase 0 paralel dengan 1.1-1.3 (kode, belum menyentuh produksi) → 1.4 → 1.5-1.7 → Fase 2 → Fase 4 (backup lebih penting dari kapasitas saat pelanggan pertama masuk) → Fase 5 → Fase 3 → Fase 6 → game day. Tiap fase satu PR kecil dengan tes dan bukti; tidak ada yang di-push sebelum Nash bilang "push", tidak ada yang menyentuh VPS tanpa konfirmasi Nash diketik di thread VPS.

Hal yang **tidak** saya lakukan di rencana ini: mengubah VPS produksi, menyentuh data pelanggan, menempel secret, menyalakan billing. Semua itu menunggu persetujuan.

---

## Lampiran A — Membuat bot Telegram untuk alert (Nash, ±5 menit)

1. Buka Telegram, cari `@BotFather` (centang biru), tekan **Start**.
2. Kirim `/newbot`.
3. Isi nama tampilan, misalnya `Nibie Ops`.
4. Isi username yang berakhiran `bot`, misalnya `nibie_ops_alert_bot` (cari yang belum dipakai).
5. BotFather membalas dengan **token**. Jangan tempel ke chat mana pun, termasuk thread ini. Simpan langsung di Bitwarden dengan nama `OPS_TELEGRAM_BOT_TOKEN`.
6. Buka bot Anda lewat tautan `t.me/<username bot>` dan tekan **Start**, kirim satu pesan apa saja.
7. Untuk mengetahui `chat id` Anda: cari `@userinfobot`, tekan Start; angka di baris `Id` adalah chat id Anda. Simpan di Bitwarden dengan nama `OPS_TELEGRAM_CHAT_ID` (angka ini bukan rahasia berat, tetapi tetap tidak ditempel di repo).
8. Selanjutnya nilai-nilai ini hanya dimasukkan ke `/etc/hermes-cloud/ops.env` di VPS pada tugas 1.5 dengan langkah yang saya siapkan; jangan ke repo.

## Lampiran B — Monitor eksternal (Nash, ±10 menit, tersedia setelah tugas 1.3)

Rekomendasi: satu layanan gratis untuk dua kebutuhan (uptime HTTP dan heartbeat). Contoh yang umum dipakai: Better Stack atau UptimeRobot (uptime) dan Healthchecks.io (heartbeat). Saya belum memverifikasi batas paket gratis saat ini; cek halaman harga masing-masing sebelum memilih.

1. Buka situs layanan yang dipilih dan daftar dengan email bisnis.
2. Buat monitor HTTP baru ke `https://api.cloud.nibie.app/readyz` dengan interval 5 menit (atau terkecil yang gratis), peringatan ke email dan Telegram (integrasi bawaan; pilih bot atau kanal yang sama jika ditawarkan).
3. Buat monitor HTTP kedua untuk `https://cloud.nibie.app/` dan ketiga untuk `https://cloud.nibie.app/dashboard/sign-in`.
4. Buat satu **heartbeat/cron monitor** dengan periode 5 menit dan toleransi 10 menit. Salin URL ping-nya (ini rahasia ringan: jangan ke repo atau chat), simpan di Bitwarden sebagai `OPS_HEARTBEAT_URL`.
5. Beri tahu saya "monitor siap" (tanpa URL); thread VPS yang memasukkan nilainya ke env.

## Lampiran C — Perpanjangan VPS (Nash, ±5 menit, lakukan minggu ini)

1. Buka konsol Tencent Cloud dan masuk.
2. Buka **Billing Center** lalu **Renewal Management** (nama menu dapat berbeda; cari "Renewal").
3. Temukan instance VPS Jakarta, pilih **Set auto-renewal** dan pilih periode terpendek yang sesuai anggaran.
4. Pastikan metode pembayaran/saldo cukup sebelum 2026-12-11. Jika tidak ada fitur auto-renew untuk paket ini, perpanjang manual sekarang.
5. Buat pengingat kalender 2026-12-01 "Cek VPS Nibie Cloud sudah diperpanjang".
6. Beri tahu saya "VPS sudah dijamin perpanjangannya" dan tanggal kedaluwarsa barunya dari konsol.
