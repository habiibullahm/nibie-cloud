# Handoff: end-to-end test admin panel (Fase A) — lokal

Repo: https://github.com/habiibullahm/nibie-cloud
Branch: `claude/project-thread-tirdms` (HEAD `7b7e6a5`)
PR: [#31](https://github.com/habiibullahm/nibie-cloud/pull/31) — MERGEABLE, CI hijau
(backend, docs, landing, t0, web; t1/t2 skip).

Tujuan: verifikasi end-to-end admin panel `/dashboard/admin` terhadap Supabase nyata + backend nyata.
Nomor di bawah = urutan. Jangan lompat.

---

## 0. Yang sudah terverifikasi (jangan ulangi)

| Cakupan | Hasil |
| --- | --- |
| `pnpm build` (tsc --noEmit) | bersih |
| `pnpm test:unit` | 476 lulus, 31 file |
| Admin backend (integrasi + unit) | 58 lulus (Postgres 5433 + Redis 6380) |
| `apps/web` typecheck + lint + test | bersih, 97 lulus |
| `apps/web` `next build` | hijau, 8 rute `/admin/*` |
| Playwright T0 `pnpm test:t0` | 53 lulus / 1 skip, termasuk 10 spec admin (mock mode) |

**Belum terverifikasi sama sekali — itulah tugas handoff ini:**

- `/api/v1/admin/*` terhadap Supabase nyata + JWKS-nya (hanya pernah dengan token palsu).
- `ADMIN_EMAILS` nyata di jalur config → hook.
- Panel `/dashboard/admin` dengan backend nyata, bukan mock.
- Bahwa non-admin benar-benar tidak bisa menarik data (403) dari browser.
- Setiap request admin tertulis ke tabel `AuditLog`.

---

## 1. Prasyarat

```bash
cd /home/ubuntu/nibie-cloud
git fetch origin claude/project-thread-tirdms && git checkout claude/project-thread-tirdms && git pull
pnpm install                     # juga menjalankan prisma generate
docker compose up -d postgres redis
pnpm db:migrate                  # WAJIB: migrasi 20261115174608_add_audit_log
```

Cek migrasi masuk:

```bash
psql "postgresql://hermes:***@127.0.0.1:5433/hermes" -c '\d "AuditLog"'
```

Tanpa tabel itu setiap request admin gagal 500 di penulisan audit.

---

## 2. Supabase: tiga akun

Panel butuh dua jenis akun di project Supabase yang sama dengan dashboard pelanggan.

| Akun | Peran | Syarat |
| --- | --- | --- |
| `admin@…` | admin | emailnya ada di `ADMIN_EMAILS` |
| `customer@…` | pelanggan | emailnya ada di `BETA_ALLOWED_EMAILS`, boleh membuat instance |
| `outsider@…` | bukan admin | TIDAK ada di `ADMIN_EMAILS` — dipakai membuktikan 403 |

Ketiganya **Auto Confirm User** saat dibuat. Untuk T1 yang sudah ada, pakai `e2e-lifecycle` sebagai
customer dan `e2e-outsider` sebagai outsider; buat satu akun admin baru.

---

## 3. Backend: variabel yang wajib

`ADMIN_EMAILS` sekarang ada di `.env.example` (commit berikutnya). Isi `.env`:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
DASHBOARD_ORIGIN=http://localhost:3100
BETA_ALLOWED_EMAILS=<customer-email>
ADMIN_EMAILS=<admin-email>
MAX_INSTANCES_PER_TENANT=1
REDIS_URL=redis://:***@127.0.0.1:6380
ADMIN_TOKEN=<>=24 chars>
HERMES_MASTER_KEY=<>=32 chars>
SECRETS_KEK=<32 byte base64>
HERMES_IMAGE=hermes-stub:0.2.0
HERMES_DISK_QUOTA=off            # hanya boleh di luar production
HERMES_EGRESS_POLICY=off         # hanya boleh di luar production
```

Lalu:

```bash
pnpm dev
curl -s localhost:3000/healthz
```

Admin plugin hanya terdaftar bila `SUPABASE_URL` diset. Tanpa itu `/api/v1/admin/*` = 404, bukan 403 —
kalau dapat 404, `SUPABASE_URL` belum terbaca.

---

## 4. Dashboard: mode `customer`

`NEXT_PUBLIC_*` terkunci saat build, jadi harus rebuild:

```bash
cd apps/web
cat > .env.local <<'EOF'
NEXT_PUBLIC_HERMES_API_MODE=customer
NEXT_PUBLIC_HERMES_API_URL=http://127.0.0.1:3000
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
EOF
pnpm build && pnpm start          # http://localhost:3100/dashboard
```

Di mode `mock`/`live` setiap halaman admin menampilkan "Panel admin butuh backend" — itu perilaku
benar, bukan bug. Kalau melihatnya di mode `customer`, berarti build-nya masih build mock.

---

## 5. API: cek satu per satu (`curl` dulu, UI belakangan)

Ambil token admin (lewat login dashboard atau `support/supabase-admin.ts`), lalu:

```bash
TOKEN=<access_token_admin>
B=http://127.0.0.1:3000/api/v1/admin

curl -s -H "authorization: Bearer $TOKEN" $B/me
curl -s -H "authorization: Bearer $TOKEN" $B/system
curl -s -H "authorization: Bearer $TOKEN" $B/overview
curl -s -H "authorization: Bearer $TOKEN" "$B/customers?q=&limit=5"
curl -s -H "authorization: Bearer $TOKEN" "$B/instances?status="
curl -s -H "authorization: Bearer $TOKEN" $B/plans
curl -s -H "authorization: Bearer $TOKEN" $B/nodes
curl -s -H "authorization: Bearer $TOKEN" $B/subscriptions
curl -s -H "authorization: Bearer $TOKEN" $B/payments
curl -s -H "authorization: Bearer $TOKEN" $B/audit
curl -s -H "authorization: Bearer $TOKEN" $B/jobs/failed
```

Yang harus benar, per item:

1. `/me` mengembalikan `{ id, email, aal }`. `aal` = `aal1` tanpa MFA, `aal2` dengan MFA.
2. `/system` melaporkan `customerApi: true` dan `adminEmails` = jumlah email yang kamu isi (bukan 0).
3. Setiap respons punya header `cache-control: no-store` — cek dengan `curl -D-`.
4. Tanpa header `authorization` → **401**.
5. Dengan token `outsider` → **403** `Forbidden` (pesan tidak boleh membocorkan siapa admin).
6. Dengan token `customer` → **403**.
7. `jobs/failed` → **503** `queue_unavailable` bila `REDIS_URL` kosong; **200** bila diset.
8. Rate limit 120/menit per `userId`: lewati dengan loop cepat, harus mulai 429.

---

## 6. Audit trail

Setelah tes API di atas, setiap request harus punya baris:

```bash
psql "postgresql://hermes:***@127.0.0.1:5433/hermes" \
  -c 'SELECT "actorEmail", action, "createdAt" FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT 10;'
```

Yang harus benar: jumlah baris ≥ jumlah request yang kamu tembak, `actorEmail` = email admin, dan
tidak ada baris untuk request yang ditolak 401/403 (hook menolak sebelum route jalan — kalau ada
baris di sini, itu bug).

---

## 7. UI: klik satu per satu

Login sebagai admin → sidebar "Admin" harus muncul → buka tiap halaman:

| Rute | Cek |
| --- | --- |
| `/dashboard/admin` | angka overview cocok dengan `curl /overview` |
| `/dashboard/admin/pelanggan` | daftar tenant, pencarian `q` jalan, buka satu detail |
| `/dashboard/admin/instance` | filter status jalan, buka detail + event |
| `/dashboard/admin/langganan` | langganan & pembayaran tampil |
| `/dashboard/admin/plan` | daftar plan, `monthlyPriceIdr` null terlihat "tidak dijual" |
| `/dashboard/admin/node` | daftar node |
| `/dashboard/admin/job` | dengan Redis: daftar job gagal; tanpa Redis: pesan 503, bukan crash |
| `/dashboard/admin/audit` | halaman audit memuat baris dari langkah 6 |

Lalu login sebagai `outsider`:

- Link "Admin" **tidak** muncul di sidebar.
- Buka `/dashboard/admin` langsung via URL → "Tidak berwenang", tanpa nama admin mana pun.

Terakhir: keyboard-only tab melalui satu tabel admin, dan cek tidak ada overflow horizontal di lebar
375px.

---

## 8. Kalau mau otomatis (opsional, tapi ini yang paling bernilai)

T1 saat ini tidak punya spec admin. Tambahkan — ini yang akan menangkap regresi ke depan:

1. `e2e/support/env.ts` — tambah `ADMIN_USER` dan `emailOf('admin')`, jadikan `BETA_USERS = ['lifecycle']`
   seperti sekarang.
2. `e2e/playwright.config.ts` → `backendEnv()` — tambah
   `ADMIN_EMAILS: emailOf('admin')`.
3. `e2e/support/stack-prep.mjs` — tidak perlu diubah (Supabase URL sama).
4. `e2e/tests/dashboard-customer/auth.setup.ts` — tambah `"admin"` ke `USERS`.
5. File baru `e2e/tests/dashboard-customer/admin.spec.ts`:
   - admin melihat `/admin`, non-admin melihat "Tidak berwenang" di URL yang sama;
   - 8 rute admin merender tanpa error konsol;
   - link "Admin" tidak ada di sidebar `outsider`.

Jangan taruh email asli di repo — pakai `E2E_EMAIL_TEMPLATE`.

---

## 9. Lapor balik

Untuk setiap item di §5, §6, §7: **lulus/gagal + bukti** (baris output, bukan ringkasan). Kalau gagal,
sertakan request, respons, dan log backend. Jangan perbaiki kode dulu — laporkan dulu.

## 10. Di luar cakupan (jangan dikerjakan)

- MFA TOTP (A7) dan semua aksi ubah data (Fase B) — belum ada rute POST/PUT/PATCH/DELETE.
- Caddy allowlist `/api/v1/admin/*` dan deploy VPS (A6) — kerja operator, bukan lokal.
- Fase C (aksi uang, gateway Duitku vs SumoPod) — belum diputuskan.