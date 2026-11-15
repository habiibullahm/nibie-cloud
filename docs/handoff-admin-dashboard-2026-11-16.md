# Handoff: admin dashboard Nibie Cloud, Fase A selesai — 2026-11-16

Repo: https://github.com/habiibullahm/nibie-cloud. Branch kerja: `claude/project-thread-tirdms`
(**belum di-push**). Plan lengkap tidak ada di disk; kerja mengikuti `docs/handoff-admin-dashboard-2026-11-15.md`
(ringkasan di lampiran sesi) dan keputusan Nash 2026-11-15.

## Keputusan Nash yang dipakai

1. Panel di **`/dashboard/admin`** (di `apps/web`, bukan paket `apps/admin` terpisah).
2. **MFA TOTP wajib** untuk aksi yang mengubah data.
3. UI admin **Bahasa Indonesia** (dashboard pelanggan tetap Inggris).
4. Mulai **Fase A** sekarang, paralel dengan autopilot.

## Status: Fase A selesai dan terverifikasi. Fase B/C belum.

Fase A = panel baca-saja. Semua endpoint GET, tidak ada aksi yang mengubah data.

### A0–A3 — Backend (selesai)

- `src/config/env.ts`: `ADMIN_EMAILS` (lowercase, trim; **kosong = tidak ada admin**, fail closed).
- `src/modules/auth/token-verifier.ts`: `AuthClaims` dapat `aal` (hanya `aal2` diakui; selain itu `aal1`).
  Perilaku route pelanggan tidak berubah.
- `src/http/admin-routes.ts`: plugin ketiga, prefix `/api/v1/admin`. Hook: token valid → email di
  `ADMIN_EMAILS`. Semua rute `cache-control: no-store`, kena rate limit. Setiap request dicatat ke
  `AuditLog`. Rute baca jalan di `aal1`; rute ubah (Fase B) akan butuh `aal2` + alasan.
- `src/modules/admin/audit-service.ts` + migrasi aditif `20261115174608_add_audit_log` (tabel baru
  `AuditLog`; kolom `detail` JSONB; indeks `createdAt`, `actorEmail+createdAt`, `targetId+createdAt`).
- `src/http/server.ts` + `src/main.ts`: plugin admin didaftarkan hanya bila `SUPABASE_URL` diset.
- Endpoint baca: `me`, `overview`, `customers?q=`, `customers/:tenantId`, `instances?status=`,
  `instances/:id` (+`events`), `subscriptions`, `payments`, `plans`, `nodes`, `jobs/failed`
  (503 `queue_unavailable` tanpa Redis), `audit`, `system`. Cursor pagination.
- **Tanpa secret di UI**: modul admin tidak boleh impor `secrets/secret-store`, dan rute admin tidak
  boleh memilih kolom `ciphertext`/`wrappedKey` (dijaga `test/unit/secrets-boundary.test.ts`).

### A4–A5 — UI + verifikasi (selesai)

- `apps/web/src/app/(app)/admin/*`: Ringkasan, Pelanggan (+detail), Instance (+detail),
  Langganan & pembayaran, Plan, Node, Job gagal, Audit. Bahasa Indonesia.
- `AdminGate` memanggil `/admin/me`; non-admin melihat "Tidak berwenang" tanpa petunjuk siapa admin.
  Link "Admin" di sidebar muncul hanya setelah `/admin/me` menjawab.
- **Panel tidak punya data mock**: di mode `mock`/`live` setiap halaman menampilkan "Panel admin butuh
  backend" (keputusan murni di `apps/web/src/lib/admin-gate-rules.ts`, teruji).
- Dokumentasi diperbarui: `AGENTS.md` ("Three API surfaces" + bagian Admin API + Admin panel),
  `docs/CURRENT_STATE.md` (entri admin Fase A).

### Bukti tes (2026-11-16, sandbox)

- Backend: **58 tes admin lulus** — 26 integrasi (`admin-auth`, `admin-api`, `audit-service`, Postgres
  nyata di 5433 + Redis 6380) + 32 unit (`admin-auth-rules`, `token-verifier`, `secrets-boundary`).
- `apps/web`: `pnpm typecheck` bersih, `pnpm lint` bersih, **97 tes lulus**, `pnpm build` hijau dengan
  8 rute `/admin/*`.
- E2E T0 Playwright: **53 lulus / 1 skipped**, termasuk 10 spec admin baru (setiap rute admin menolak
  menggambar data contoh, link admin tersembunyi untuk non-admin, tidak ada pelanggaran a11y serius).

### Catatan penting soal working tree bersama

Tree ini dipakai bersama thread SumoPod. Saat Fase A selesai, `src/modules/billing/*`, `duitku-client.ts`
dan `src/config/env.ts` (bagian `BILLING_GATEWAY`/`SUMOPOD_*`) **sedang diubah thread lain dan belum
commit**. Akibatnya `pnpm build` (root) dan `pnpm test` masih gagal di berkas billing/duitku dan 33 tes
`config.test.ts` (pesan `Invalid configuration: BILLING_GATEWAY`) — **bukan dari kerja admin**. Kerja admin
terbukti bersih lewat tes admin di atas. Rebase/merge setelah thread SumoPod commit.

### Menjalankan suite penuh di sandbox ini

`pnpm test` apa adanya melaporkan ~41 gagal yang **semuanya lingkungan**, bukan kode. Wajib:

```bash
# 1) Redis: tes job butuh REDIS_URL, tanpa itu gagal keras ("REDIS_URL must be set")
export REDIS_URL='redis://:hermes_dev_only@127.0.0.1:6380'

# 2) Docker: socket hanya bisa diakses root/grup docker, jadi tes runtime harus lewat sudo -E
sudo -E env PATH="$PATH" REDIS_URL="$REDIS_URL" pnpm test
```

Tanpa keduanya: `connect EACCES /var/run/docker.sock` (tes runtime), `spawn redis-server ENOENT`
(`job-shutdown` menyalakan Redis sendiri di port 6391–6393), dan `REDIS_URL must be set` (tes job).
Tes yang tidak butuh Docker/Redis (unit + integrasi admin) jalan normal tanpa keduanya.


## Yang menunggu Nash (tidak dikerjakan tanpa izin)

- **A6** [H] Caddy allowlist `/api/v1/admin/*`, `ADMIN_EMAILS` di `/etc/hermes-cloud/backend.env`,
  jalankan migrasi `20261115174608_add_audit_log`, deploy backend, rilis dashboard. Konfirmasi diketik di
  thread VPS.
- **A7** [N] Aktifkan MFA TOTP di Supabase (Authentication > Multi-Factor) dan daftarkan autentikator di
  akun admin Nash. Wajib sebelum Fase B (aksi ubah butuh `aal2`).
- **Fase B** (aksi aman: restart/stop/start, retry job, edit harga & plan, saklar signup/penjualan/
  maintenance) dan **Fase C** (aksi uang, menunggu keputusan gateway Duitku vs SumoPod) belum dikerjakan.

## Belum diverifikasi

- Terhadap Supabase nyata / JWKS-nya; `ADMIN_EMAILS` nyata di VPS; Caddy `/api/v1/admin/*`; alur MFA TOTP
  (Fase B); deployment apa pun.
