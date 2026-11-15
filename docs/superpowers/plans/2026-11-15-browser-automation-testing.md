# Rencana: Automation Browser Testing (Playwright) untuk Nibie Cloud

> Status: **disetujui Nash 2026-11-15 (semua rekomendasi ★)**, T0, perancah T1/T2 dan workflow sudah dibangun di `e2e/` dan
> `.github/workflows/`. Lihat "Status implementasi" di bagian akhir untuk apa yang sudah terbukti dan apa yang belum.
> Dibuat 2026-11-15 dari pembacaan repo `habiibullahm/nibie-cloud` (main di `656a6c9`): `AGENTS.md`, `docs/CURRENT_STATE.md`,
> `apps/web`, `apps/landing`, `src/`, `test/`. Setiap fakta di bagian "Kondisi nyata" diambil dari kode, bukan dari ingatan.

## 1. Tujuan

Punya tes otomatis yang membuka browser sungguhan dan memastikan jalur yang dipakai pelanggan beta tidak rusak diam-diam:
halaman publik terbuka, login berfungsi, instance bisa di-deploy dan dikelola (Stop / Start / Restart / Delete), alur bayar
(Duitku) berjalan sampai instance muncul. Tes harus bisa dijalankan (a) di laptop Nash dengan satu perintah, (b) otomatis di
GitHub Actions pada setiap PR, dan (c) sebagai smoke test aman terhadap produksi.

Bukan tujuan: menguji keamanan runtime Hermes (sudah ada di `test/integration`), menguji isi jawaban agent, uji beban,
mengotomasi halaman pembayaran Duitku itu sendiri (UI pihak ketiga, rapuh).

## 2. Kondisi nyata (hasil membaca repo)

1. **Belum ada CI sama sekali.** Tidak ada `.github/`. 676 tes backend dan 83 tes dashboard hanya jalan manual. Belum ada
   Playwright atau tes browser di repo; tes dashboard = Vitest (logika, fake `fetch`), tidak merender halaman.
2. **Dashboard punya tiga mode data** (`apps/web/src/lib/api/index.ts`):
   - `mock` (default): semua data di memori browser, tanpa backend. Jika variabel Supabase kosong, `AuthGate` mati dan form
     login hanya "shell" (submit langsung ke `/instances`). **Tidak butuh secret apa pun.**
   - `customer`: browser memanggil API backend dengan token Supabase. Butuh `NEXT_PUBLIC_SUPABASE_URL`,
     `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_HERMES_API_URL`, semuanya dibaca **saat build**.
   - `live`: jembatan dev (operator token), hanya untuk pengembangan; tidak dipakai tes.
3. **Dashboard di `basePath` `/dashboard`** (lokal `http://localhost:3100/dashboard`). Landing statis di `apps/landing`
   (lokal port 3300; rute `/`, `/harga`, `/kontak`, `/syarat-layanan`, `/kebijakan-refund`, `/kebijakan-privasi`, 404).
4. **Backend memverifikasi token Supabase lewat JWKS proyek** dan `SUPABASE_URL` wajib **https** (`src/config/env.ts`).
   Artinya login sungguhan di tes full-stack butuh proyek Supabase sungguhan (atau stub https, terlalu berat).
5. **Pembuatan instance lewat `POST /instances` dibatasi `BETA_ALLOWED_EMAILS`** (daftar email persis, tanpa wildcard; kosong =
   tidak ada yang boleh, error `403 provisioning_not_enabled`) dan rate limit 5 per 10 menit; `MAX_INSTANCES_PER_TENANT=1`.
   Checkout Duitku (`POST /subscriptions/checkout`) rate limit 10 per 10 menit.
6. **Duitku:** host dikunci `api-sandbox.duitku.com` / `api-prod.duitku.com` (tidak bisa diarahkan ke fake tanpa mengubah
   kode), dan `returnUrl` wajib `https` (`validate()` di `duitku-client.ts`), padahal `returnUrl` dibentuk dari
   `DASHBOARD_ORIGIN`. Akibatnya **checkout asli tidak bisa jalan dengan dashboard `http://localhost`**. Callback pembayaran
   (`POST /api/v1/billing/duitku/callback`, form-urlencoded) hanya diautentikasi tanda tangan
   `HMAC-SHA256(merchantCode + amount + merchantOrderId, apiKey)`, jadi **mudah disimulasikan** oleh tes yang memegang key sandbox.
   Setelah bayar, Duitku mengarahkan ke `/dashboard/instances?payment=<orderId>`.
7. **Elemen UI sudah mudah dicari lewat role/label** (`aria-label="Delete <nama>"`, `Label htmlFor="instance-name"`, dialog Radix
   untuk Stop/Restart, dialog Delete yang meminta mengetik nama instance). Tidak ada `data-testid`; rencana ini **tidak menambahnya**.
8. Backend lokal sudah punya semua bahan: `compose.yaml` (Postgres 5433, Redis 6380), image stub `hermes-stub`
   (`test/helpers/stub-image.ts`), `scripts/demo.ts` yang menanam plan `demo-small` dan node `local`,
   `HERMES_DISK_QUOTA=off` dan `HERMES_EGRESS_POLICY=off` untuk dev. Docker tersedia di runner `ubuntu-latest`.
9. `.gitignore` sudah mengabaikan `.env` dan `.env.*` (kecuali `.env.example`). Repo GitHub **publik**, jadi artefak CI
   (trace, video) bisa dilihat orang lain.

## 3. Arsitektur tes: tiga tingkat

| Tingkat | Apa yang jalan | Secret | Kapan | Perkiraan waktu jalan |
| --- | --- | --- | --- | --- |
| **T0 Mock** | Landing (hasil export statis) + dashboard mode `mock`. Tanpa backend, tanpa Supabase. | Tidak ada | Setiap PR yang menyentuh `apps/web` / `apps/landing`; laptop | 2 sampai 4 menit |
| **T1 Full-stack lokal** | Dashboard mode `customer` + backend + Postgres + Redis + container stub sungguhan + proyek Supabase khusus tes. Duitku disimulasikan lewat callback bertanda tangan. | Ya (GitHub Secrets / `.env.e2e`) | Push ke `main`, nightly, manual; laptop | 8 sampai 12 menit |
| **T2 Smoke produksi** | `cloud.nibie.app` dan `api.cloud.nibie.app`, hanya baca, satu akun tes khusus. | Ya (satu akun) | Nightly + manual setelah deploy | 1 sampai 2 menit |

Struktur kode (paket mandiri baru, mengikuti pola repo "tiap paket punya `package.json` dan lockfile sendiri"):

```
e2e/
  package.json, pnpm-lock.yaml, tsconfig.json, playwright.config.ts, README.md
  .env.e2e.example            (nama variabel saja, tanpa nilai)
  support/
    env.ts                    baca dan validasi variabel, gagal dengan pesan jelas
    supabase-admin.ts         buat/hapus user tes lewat Admin API (hanya Node, tidak pernah di browser)
    backend.ts                bantu: operator API (hapus instance sisa), seed plan/node, kirim callback Duitku bertanda tangan
    stack.ts                  global setup T1: migrate, seed, tunggu backend siap
  tests/
    landing/*.spec.ts         T0
    dashboard-mock/*.spec.ts  T0
    dashboard-customer/*.spec.ts  T1
    prod-smoke/*.spec.ts      T2
```

Proyek Playwright (`playwright.config.ts`): `landing`, `dashboard-mock`, `setup-customer` (login sekali, simpan `storageState`),
`dashboard-customer` (bergantung pada setup), `prod-smoke`. Chromium saja untuk awal; satu proyek tambahan viewport
mobile 390 px untuk landing dan daftar instance (DESIGN.md mewajibkan mobile bekerja). `workers: 1` di T1 (satu Docker
daemon, satu database, rate limit). `retries: 1` di CI saja; tes yang butuh retry untuk lulus dicatat sebagai flaky, bukan disembunyikan.

Prinsip pemilihan elemen: `getByRole` / `getByLabel`, tidak ada selector CSS, tidak ada `waitForTimeout`; semua tunggu lewat
auto-wait / `expect(...).toBeVisible()` / `expect.poll`. Transisi status di mock memakai timer asli; di T0 dipercepat dengan
`page.clock` (Playwright) agar tidak menunggu detik-detik nyata.

## 4. Skenario prioritas

**P0 (wajib ada di rilis pertama)**

| # | Tingkat | Skenario | Yang dipastikan |
| --- | --- | --- | --- |
| 1 | T0 | Landing: tiap rute 200, judul benar, 404 untuk path asing, tidak ada error console, tidak ada scroll horizontal di 390 px | halaman publik (dibutuhkan KYC Duitku) tidak rusak |
| 2 | T0 | Landing: harga di `/harga` tampil (Rp 25.000 / Rp 50.000 beta, coret Rp 50.000 / 75.000), tautan legal ada | salah ketik harga langsung ketahuan |
| 3 | T0 | Dashboard mock: daftar instance menampilkan 3 seed; `?empty` menampilkan empty state; `?fail` menampilkan error state berlabel | state UI utama |
| 4 | T0 | Dashboard mock: deploy (isi nama, pilih plan, kirim) sampai progress selesai dan instance `Running` | alur inti |
| 5 | T0 | Dashboard mock: Stop lalu Start, Restart (dialog konfirmasi), Delete (harus ketik nama persis; tombol salah nama tidak aktif) | aksi siklus hidup + guard |
| 6 | T1 | Login email+password asli; tanpa sesi `/dashboard/instances` melempar ke `/sign-in`; Sign out kembali ke sign-in | AuthGate + Supabase |
| 7 | T1 | User di `BETA_ALLOWED_EMAILS`: deploy sungguhan, instance `ACTIVE` dan token/URL akses tampil; container `hermes-<id>` benar-benar ada | create end-to-end ke Docker |
| 8 | T1 | Siklus hidup nyata: Stop (status `STOPPED`, container berhenti), Start, Restart, Delete (container dan volume hilang) | job queue + runtime |
| 9 | T1 | User di luar daftar beta: deploy ditolak dengan pesan yang ramah (`provisioning_not_enabled`), tidak ada container | gerbang beta |
| 10 | T2 | Landing 200; `/dashboard/sign-in` 200; `GET api.cloud.nibie.app/healthz` menjawab `{status:ok}`; login akun tes produksi; daftar instance terbuka tanpa error | produksi hidup |

**P1 (setelah P0 stabil)**

11. T1 Pembayaran: `POST /subscriptions/checkout` dengan instance tertunda → tes menanam `Payment` PENDING, mengirim callback
    Duitku **bertanda tangan** (key sandbox), lalu membuka `/dashboard/instances?payment=<orderId>` dan memastikan banner
    "Waiting for your payment" berubah menjadi instance aktif; callback kedua dengan data sama tidak menggandakan (idempoten);
    callback dengan tanda tangan salah → 400 dan tidak ada efek.
12. T1 Langganan: banner masa tenggang / suspended (instance dihentikan, tombol Start disembunyikan) lewat tick billing atau baris database yang ditanam.
13. T1 Konfigurasi: pasang provider (kunci palsu ke endpoint yang ditolak dengan wajar) dan Telegram (token palsu) menampilkan pesan error yang benar, secret tidak pernah tampil ulang.
14. T0 Aksesibilitas dasar: `@axe-core/playwright` pada landing, sign-in, daftar instance, deploy (gagal bila ada pelanggaran serius). DESIGN.md mewajibkan WCAG AA dan fokus terlihat.
15. T0 Keyboard: Tab melewati dialog Stop/Delete, Escape menutup, fokus kembali ke pemicu.

**P2 (nanti)**

16. T2 Satu kali alur beli dengan **Duitku sandbox sungguhan** (butuh `DUITKU_ENV=sandbox` di backend yang dites dan dashboard di https): sampai redirect ke domain `duitku.com` saja; pembayaran dilanjutkan dengan callback bertanda tangan atau tombol simulator manual.
17. Docs `cloud.nibie.app/docs` (setelah Worker-nya ada): halaman terbuka, pencarian jalan.
18. Regresi visual (screenshot) landing dan komponen; tunda sampai desain stabil.

## 5. Data dan akun uji; menyimpan kredensial dengan aman

**Prinsip:** tidak ada secret di repo (repo publik), tidak di chat, tidak di log CI, tidak di trace yang diunggah.

- **Proyek Supabase khusus tes** (`nibie-cloud-e2e`), terpisah dari `nibie-cloud-sgp` yang dipakai pelanggan. Alasan: tes membuat
  dan menghapus user, mengubah `BETA_ALLOWED_EMAILS`, dan tidak boleh mengotori user nyata. User tes dibuat lewat Admin API
  dengan `email_confirm: true` (tidak perlu kirim email, tidak menyentuh SumoPod).
- **Kumpulan user tes tetap**, mis. `e2e-1` sampai `e2e-3` pada domain yang valid dan tidak mengirim email, semuanya ditulis di
  `BETA_ALLOWED_EMAILS` backend tes (daftar persis, tanpa wildcard). Satu user per berkas spek karena `MAX_INSTANCES_PER_TENANT=1`;
  tiap spek membersihkan instance sisa lewat operator API di `afterAll`. Password acak dibuat per run, tidak disimpan.
- **Penyimpanan:**
  - Laptop: `e2e/.env.e2e` (sudah ter-ignore oleh `.env.*`), nilai asli juga di Bitwarden.
  - GitHub Actions: Secrets repo. Dibaca hanya oleh job T1/T2; **tidak tersedia untuk PR dari fork** (perilaku bawaan GitHub), jadi PR luar hanya menjalankan T0.
  - Kunci yang butuh: `E2E_SUPABASE_URL`, `E2E_SUPABASE_PUBLISHABLE_KEY` (publik, ikut build dashboard), `E2E_SUPABASE_SECRET_KEY`
    (service role, **hanya di Node**, tidak pernah masuk build dashboard), `E2E_DUITKU_MERCHANT_CODE`, `E2E_DUITKU_API_KEY` (sandbox),
    `E2E_ADMIN_TOKEN` dan `E2E_MASTER_KEY` (dibuat acak di CI per run, tidak perlu secret), untuk T2: `PROD_SMOKE_EMAIL`, `PROD_SMOKE_PASSWORD`.
- **Login sekali:** proyek `setup-customer` memasukkan password hanya di sini lalu menyimpan `storageState` (berkas ter-ignore, tidak
  diunggah). Proyek ini memakai `trace: 'off'`, `video: 'off'`, `screenshot: 'off'`.
- **Artefak CI:** T0 mengunggah trace/video hanya saat gagal (tidak ada secret di T0). T1/T2 **tidak** mengunggah trace/video/storageState;
  hanya laporan teks yang sudah disaring (nama tes, pesan gagal). Alasan: repo publik, artefak bisa diunduh pengguna GitHub lain.
- **Masking:** `env.ts` mendaftarkan semua nilai secret ke `::add-mask::` di CI; tidak ada `console.log` objek env.
- **Akun produksi (T2):** satu akun khusus (`smoke@...`), tanpa instance, tanpa data pelanggan; password panjang acak dari Bitwarden.
  T2 tidak membuat atau menghapus apa pun (hanya baca).

## 6. Seed lokal (backend)

Skrip `e2e/support/stack.ts` (global setup T1) meniru `scripts/demo.ts`, tidak memakai kode produksi baru:

1. `docker compose up -d postgres redis` (sudah ada di `compose.yaml`), tunggu sehat.
2. Buat database `hermes_e2e` (terpisah dari `hermes` dan `hermes_test`), `pnpm db:migrate` ke sana.
3. Seed: plan `demo-small` (cpu 500, memori 256 MB, storage 1024 MB, `monthlyPriceIdr` kecil di atas minimum Duitku untuk jalur bayar),
   plan kedua dengan `includedCreditNano` hanya bila tes kredit ditambahkan; node `local` (`name:'local', region:'local'`).
4. Bangun image `hermes-stub:0.2.0` (`ensureStubImage`), jalankan backend dengan env: `NODE_ENV=development`, `HERMES_IMAGE=hermes-stub:0.2.0`,
   `HERMES_DISK_QUOTA=off`, `HERMES_EGRESS_POLICY=off`, `REDIS_URL`, `SUPABASE_URL` (proyek tes), `DASHBOARD_ORIGIN=http://localhost:3100`,
   `BETA_ALLOWED_EMAILS=<user tes>`, `SECRETS_KEK` acak, `ADMIN_TOKEN`/`HERMES_MASTER_KEY` acak.
   Billing (`DUITKU_*`) hidup hanya untuk spek pembayaran. NibieRouter **mati** (belum terverifikasi dengan router asli).
5. Build dashboard: `NEXT_PUBLIC_HERMES_API_MODE=customer NEXT_PUBLIC_HERMES_API_URL=http://127.0.0.1:3000 NEXT_PUBLIC_SUPABASE_*=...` lalu `next start --port 3100`.
6. Teardown: hapus container `hermes-*`, volume `hermes-data-*`, network `hn*` sisa; matikan proses.

## 7. Menangani Duitku sandbox dan callback

- Karena host Duitku dikunci dan `returnUrl` harus https, T1 **tidak** memanggil `createInvoice` sungguhan. Alur yang diuji:
  data langganan/pembayaran ditanam lewat SQL pada database tes → tes mengirim callback bertanda tangan ke backend lokal →
  UI diperiksa. Fungsi tanda tangan dibuat ulang di tes (3 baris HMAC), **bukan** mengimpor key dari kode produksi.
- Jalur `createInvoice` sungguhan hanya diuji di P2 #16 terhadap sandbox nyata, dengan dashboard https (staging) atau lewat
  skrip yang sudah ada `test/validation/duitku-sandbox-live.ts`. Halaman bayar Duitku **tidak** diotomasi.
- Opsi yang butuh persetujuan (lihat keputusan 3): satu seam tes kecil di backend, mis. `DUITKU_API_BASE_URL` yang hanya
  berlaku bila `NODE_ENV!=production`, sehingga fake Duitku lokal bisa menjawab `createInvoice` dan T1 mencakup checkout penuh.
  Tanpa seam ini T1 tetap bernilai; dengan seam, skenario #11 jadi lebih nyata.

## 8. CI di GitHub Actions

Berkas baru `.github/workflows/e2e.yml` (belum dibuat). Tiga job:

1. `e2e-t0` pada `pull_request` (path filter `apps/web/**`, `apps/landing/**`, `e2e/**`): setup Node 22 + pnpm 10.28.0 (cache), instal
   Chromium (`playwright install --with-deps chromium`), build landing (export) + dashboard mock, jalankan proyek `landing` dan `dashboard-mock`.
   Unggah `playwright-report` dan trace saat gagal. Tidak memakai secret, aman untuk PR fork.
2. `e2e-t1` pada `push` ke `main`, `schedule` (nightly 18:00 UTC = 01:00 WIB), dan `workflow_dispatch`: service `postgres:16.6` dan `redis:7.4`
   (kredensial dev seperti di `compose.yaml`, hanya di runner), Docker bawaan runner, build image stub, jalankan backend dan dashboard,
   jalankan proyek `setup-customer` + `dashboard-customer`. Timeout job 20 menit, `concurrency` agar run lama dibatalkan.
3. `e2e-t2` pada `schedule` dan `workflow_dispatch` saja: proyek `prod-smoke`. Gagal mengirim notifikasi lewat email GitHub bawaan (tanpa integrasi pihak ketiga).

Usul terpisah (bukan bagian tes browser, lihat keputusan 5): job CI dasar untuk `tsc`, lint, dan tes unit backend/dashboard/landing,
karena saat ini nol pemeriksaan otomatis di PR.

## 9. Tugas implementasi (urutan, tiap tugas berdiri sendiri)

| Tugas | Isi | Selesai bila | Perkiraan |
| --- | --- | --- | --- |
| 0 | Persetujuan Nash atas keputusan di bagian 11; Nash menyiapkan proyek Supabase tes (langkah di bagian 10) | keputusan tercatat, secret ada di Bitwarden | menunggu Nash |
| 1 | Verifikasi asumsi yang belum pasti dengan menjalankan: `/healthz` lewat proxy publik, perilaku checkout vs gerbang beta, domain email yang diterima Supabase | catatan hasil di README e2e | 1 sampai 2 jam |
| 2 | Perancah `e2e/` (paket, config, env.ts), tes landing P0 #1 #2 (T0) | `pnpm test:landing` hijau lokal, tanpa warning | 3 sampai 4 jam |
| 3 | Tes dashboard mock P0 #3 sampai #5 | hijau, dengan `page.clock`, tidak ada `waitForTimeout` | 4 sampai 6 jam |
| 4 | Workflow `e2e-t0` + badge/README | PR percobaan: job hijau, laporan terunggah saat sengaja digagalkan | 2 sampai 3 jam |
| 5 | `stack.ts`, `supabase-admin.ts`, `setup-customer` | login sekali jalan lokal, `storageState` tersimpan, teardown bersih | 6 sampai 8 jam |
| 6 | Spek T1 P0 #6 sampai #9 | hijau lokal 3x berturut-turut; tidak ada container sisa | 6 sampai 8 jam |
| 7 | Workflow `e2e-t1` dan `e2e-t2`, spek T2 #10 | satu run nightly hijau di GitHub | 4 sampai 5 jam |
| 8 | P1 #11 sampai #15 | hijau, dokumentasi `docs/CURRENT_STATE.md` diperbarui | 8 sampai 12 jam |

Total kasar: **P0 lengkap ± 3 sampai 4 hari kerja**; P1 tambah ± 1 sampai 1,5 hari. Angka ini perkiraan, dua risiko terbesar
(lihat bagian 12) bisa menambah 1 hari. Tiap tugas diakhiri dengan `pnpm typecheck && pnpm lint` di paket `e2e` dan pembaruan
`docs/CURRENT_STATE.md` sesuai aturan AGENTS.md. Tidak ada commit sebelum Nash bilang "commit".

## 10. Yang perlu Nash lakukan (hanya setelah rencana disetujui)

**A. Buat proyek Supabase khusus tes**
1. Buka https://supabase.com/dashboard dan login.
2. Klik **New project**, pilih organisasi yang sama dengan proyek utama.
3. Isi **Name** `nibie-cloud-e2e`, **Region** `Southeast Asia (Singapore)`, klik **Generate a password** lalu simpan password-nya di Bitwarden.
4. Klik **Create new project**, tunggu sampai status hijau.
5. Buka **Project Settings** (ikon roda gigi) → **API Keys**. Catat tiga nilai: **Project URL**, **Publishable key**, dan **Secret key**
   (di UI lama bernama `service_role`, ada di tab *Legacy API Keys*). Simpan ketiganya di Bitwarden. **Jangan tempel ke chat.**
6. Beri tahu saya "proyek e2e siap" (tanpa nilainya). Saya akan menulis `.env.e2e.example` dan memintamu mengisi `.env.e2e` lokal.

Catatan: proyek gratis Supabase otomatis di-pause setelah sekitar 7 hari tanpa aktivitas; job nightly T1 menjaganya tetap aktif.
Bila organisasimu sudah mencapai batas proyek gratis, kabari saya; ada opsi lain di keputusan 2.

**B. Daftarkan secret ke GitHub (setelah workflow dibuat, bukan sekarang)**
1. Buka https://github.com/habiibullahm/nibie-cloud/settings/secrets/actions.
2. Klik **New repository secret**.
3. Isi **Name** (mis. `E2E_SUPABASE_URL`) dan tempel **Secret** dari Bitwarden, klik **Add secret**. Ulangi untuk tiap nama yang saya daftarkan nanti.

**C. Akun smoke produksi (untuk T2, opsional)**
1. Buka dashboard Supabase proyek utama `nibie-cloud-sgp` → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Isi email khusus smoke dan password acak panjang dari Bitwarden, centang **Auto Confirm User**, klik **Create user**.
3. Simpan email dan password di Bitwarden. (Akun ini tidak ditambahkan ke `BETA_ALLOWED_EMAILS`, jadi tidak bisa membuat instance.)

## 11. Keputusan terbuka (rekomendasi saya ditandai ★)

1. **Lokasi tes.** ★ Paket mandiri `e2e/` di akar repo (menjangkau landing + dashboard + backend). Alternatif: `apps/web/e2e` (hanya dashboard).
2. **Login T1.** ★ Proyek Supabase khusus tes (bagian 10A). Alternatif: pakai `nibie-cloud-sgp` dengan user `e2e-*` (lebih cepat, tapi mencampur data tes ke produksi dan butuh `BETA_ALLOWED_EMAILS` produksi diubah). Tidak disarankan.
3. **Seam tes Duitku (`DUITKU_API_BASE_URL`, non-produksi).** ★ Tunda; mulai tanpa seam, tambahkan jika checkout lokal terasa perlu. Perubahan ini menyentuh kode backend dan butuh persetujuan sendiri.
4. **Smoke produksi.** ★ Hanya baca dengan satu akun khusus, tidak membuat instance (setiap instance memakan RAM VPS yang terbatas). Alternatif: sekali seminggu buat dan hapus satu instance stub.
5. **CI dasar** (tsc, lint, unit) ikut dikerjakan? ★ Ya, tapi sebagai PR terpisah dan kecil, lebih dulu dari e2e, karena tidak ada jaring pengaman sama sekali sekarang.
6. **Menambah `data-testid`.** ★ Tidak; role/label cukup. Bila ada elemen yang tak terjangkau, minta persetujuan per kasus.
7. **Kapan T1 jalan di CI.** ★ Push ke `main` + nightly + manual (bukan setiap PR) agar cepat dan hemat menit Actions. Alternatif: setiap PR yang menyentuh `src/**` atau `apps/web/**` (lebih aman, ± 10 menit tambahan per PR).
8. **Laptop Nash.** T1 lokal butuh Docker Desktop sehat dan disk bebas (dari catatan e2e lokal 2026-11-15). Tes T0 tidak butuh Docker. ★ Cukup T0 di laptop, T1 terutama di CI.

## 12. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Artefak CI di repo publik membocorkan token/password | Tinggi | Trace/video T1 dan T2 dimatikan; storageState tidak diunggah; secret tidak tersedia untuk PR fork; mask di log |
| Proyek Supabase gratis di-pause atau terkena batas | Sedang | Nightly menjaga aktif; bila batas proyek gratis tercapai, pakai opsi lain (keputusan 2) |
| Rate limit (5 create / 10 menit, 10 checkout / 10 menit) membuat tes acak gagal | Sedang | `workers: 1`, satu create per spek, user berbeda per berkas, jeda dengan menunggu kondisi, bukan waktu |
| Tes siklus hidup T1 tidak stabil (container lambat di runner) | Sedang | Tunggu status lewat `expect.poll` dengan batas wajar (60 s), log container disimpan sebagai teks yang sudah disaring, `retries: 1` hanya di CI |
| Kontainer/volume sisa menumpuk di runner atau laptop | Rendah-Sedang | Teardown global + `afterAll` per spek yang menghapus lewat operator API; label nama `hermes-*` diperiksa di akhir run |
| `returnUrl` https membuat checkout lokal mustahil tanpa seam | Sedang | Jalur callback bertanda tangan (bagian 7); seam sebagai keputusan 3 |
| UI berubah (DESIGN/penggantian teks) mematahkan tes | Rendah | Locator berbasis role/label; satu berkas page-object kecil per halaman |
| Duitku/NibieRouter belum terbukti dengan layanan asli | Sedang | Tes T1 memakai fake/callback; P2 #16 menutup celah sandbox; kredit NibieRouter tidak dites sampai harness live lulus |
| Nash menghabiskan waktu menyiapkan akun padahal rencana berubah | Rendah | Bagian 10 hanya dikerjakan setelah persetujuan |

## 13. Batas rencana ini

- Belum dijalankan apa pun: tidak ada instalasi Playwright, tidak ada perubahan file di repo, tidak ada commit.
- Beberapa asumsi sengaja ditandai untuk diverifikasi di Tugas 1: apakah `/healthz` terjangkau lewat proxy publik, apakah checkout sama-sama
  dibatasi gerbang beta (kode yang dibaca menggerbang `POST /instances`; jalur checkout belum ditelusuri sampai tuntas), dan domain
  email yang diterima Supabase untuk user tes.
- Perkiraan waktu adalah estimasi kasar, bukan hasil ukur.

## 14. Status implementasi (2026-11-15)

Terbukti dengan menjalankannya (Chromium di sandbox cloud, tanpa Docker daemon):
- **T0 landing + dashboard mock:** semua tes hijau (landing desktop dan ponsel, dashboard desktop dan ponsel, deploy/Stop/Start/Restart/Delete mock,
  a11y axe, keyboard). `pnpm typecheck` di `e2e/` bersih.
- `support/stack-prep.mjs` langkah database (buat `hermes_e2e`, `prisma migrate deploy`, seed plan `demo-small` dan node `local`) dijalankan
  terhadap Postgres 16 lokal dan berhasil.

**Belum terbukti** (butuh proyek Supabase tes dan Docker daemon): seluruh T1 (login asli, beta gate, siklus hidup dengan container stub),
T2 (butuh akun smoke dan jaringan ke produksi), dan job `t1`/`t2` di GitHub Actions. Job `t1` melewati diri sendiri dengan notice
bila secret `E2E_SUPABASE_*` belum ada, jadi push ke `main` tidak merah sebelum Nash menyiapkannya.

Penyimpangan dari rencana di atas:
- Transisi status mock diuji dengan timer asli (sekitar 6 detik per langkah), bukan `page.clock`; lebih sederhana dan stabil.
- P1 #11 (callback Duitku) dan #12 (masa tenggang/suspended) **belum dibuat**; P1 #13 (konfigurasi provider/Telegram) juga belum.
  P1 #14 (a11y) dan #15 (keyboard) sudah ada di T0.
- `ci.yml` (tsc, lint, tes unit untuk empat paket) ikut di PR yang sama sebagai commit terpisah, karena hanya satu cabang yang boleh dipakai.
- Rencana asli menyebut `pnpm test:landing` dan seterusnya; skrip yang ada: `test:t0`, `test:landing`, `test:t1`, `test:t2`, `stack:prep`, `build:t0`.

Temuan dari tes (produk, belum diperbaiki, tercatat sebagai `known-a11y-issue` / `test.fixme`):
1. Landing `/`: `<dl>` hero berisi anak `role="img"` (aksesibilitas `definition-list`, serius).
2. Dashboard `/sign-in`: tautan "Create an account" hanya dibedakan dari teks oleh warna (kontras 2,31:1, perlu 3:1) atau garis bawah (`link-in-text-block`, serius).
3. Dashboard: setelah dialog Stop/Restart ditutup dengan Escape, fokus tidak kembali ke tombol pemicu.

### Perubahan keputusan 2 (2026-11-15, Nash: "run on current projects, limit supabase")

Login T1 memakai proyek Supabase yang sudah ada (`nibie-cloud-sgp`), bukan proyek baru. Supaya jejaknya kecil: tiga akun yang dibuat
Nash dengan tangan (Auto Confirm), **tanpa** kunci service-role di GitHub maupun di tes (`E2E_SUPABASE_SECRET_KEY` menjadi opsional),
satu password dari secret `E2E_USER_PASSWORD`, alamat dari pola `E2E_EMAIL_TEMPLATE` (alamat asli tetap di secret, bukan di repo).
Backend yang dites jalan di runner dengan database sementara sendiri dan hanya membaca kunci publik proyek untuk memverifikasi token;
ketiga akun tidak ada di `BETA_ALLOWED_EMAILS` produksi. Langkah klik ada di `e2e/README.md`, bagian T1.
