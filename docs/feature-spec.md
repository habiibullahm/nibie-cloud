# Feature Spec — Nibie Cloud (berdasarkan handoff task list)

**Bersumber dari:** `docs/prd.md` (PRD v1.0) + `docs/handoff-2026-11-15.md` + `docs/CURRENT_STATE.md`  
**Update terakhir:** 2026-11-16 — Duitku sandbox berhasil, pindah ke SumoPod KYC.  
**Legenda:** ✅ selesai / 🟡 sebagian / ❌ belum / 🔄 berubah sejak handoff

---

## A. Landing, Docs & Self-Service Signup

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 1 | Landing page live (cloud.nibie.app) | §4 | ✅ | Semua CTA → `/dashboard/register` |
| 2 | Docs site live (cloud.nibie.app/docs) | - | ✅ | Dokumentasi customer Bahasa Indonesia |
| 3 | Kill switch signup (`NEXT_PUBLIC_SIGNUP_OPEN`) | §4 | ✅ | `false` = landing balik ke invite-only |
| 4 | Self-service register & login | §4, 15.1 | 🟡 | Registrasi + auth Supabase OK, **tapi buntu di checkout** |

**Gap:** Pendaftar baru bisa daftar, login, lihat dashboard — tapi gak bisa bayar.

---

## B. Billing & Payment Gateway

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 5 | Backend billing Milestone D (Duitku POP) | §5.4-10, §10, §15.2 | ✅ | Kode checkout, callback, lifecycle, tick, email — semua di `main` |
| 6 | Duitku sandbox test | §5.4 | ~~🟡~~ **🔄** | **Berhasil 16 Nov.** Testing sandbox sukses. Lanjut SumoPod. |
| 7 | Duitku production KYC | §5.4 | ~~🟡~~ **🔄** | **Batal.** Pindah ke SumoPod Managed Payment (KYC lebih cepat). |
| 8 | Billing NYALA di VPS | §5, §10 | ❌ | `billing:false`, Caddy rute billing 404, `Plan.monthlyPriceIdr` masih `null` |
| 9 | Plan pricing sesuai landing | §5.2-3 | ❌ | DB: Rp 10.000 (beta-starter). Landing: Rp 25rb / Rp 50rb beta. |
| 10 | SumoPod SMTP (email billing) | §5.4 | 🟡 | SMTP dan template email siap di kode. Setting env + verify SPF/DKIM/DMARC masih perlu. |
| 11 | Invoice/receipt, refund, plan upgrade | §5.5 | ❌ | Belum. Catatan gap di architecture.md 9a. |

**🔄 Keputusan baru:** Duitku sandbox berhasil → **pindah ke SumoPod Managed Payment sebagai gateway utama (QRIS, KYC lebih cepat).** Gateway ganda `BILLING_GATEWAY=duitku|sumopod` masih rencana, butuh implementasi SumoPod di kode backend.

---

## C. Subscription & Instance Lifecycle

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 12 | Subscription lifecycle (grace 3d, retention 30d, suspend, delete) | §10 | ✅ | Kode di `src/modules/billing/lifecycle.ts`. Jalan kalau billing ON. |
| 13 | Billing tick (reminder, grace, suspend, retention) | §10.3, 11.3 | ✅ | Jalan periodik kalau billing ON. |
| 14 | Cancel at period end | §10.4 | ✅ | Kode di billing routes + service. |
| 15 | Restart suspended instance setelah renewal | §10.3 | ✅ | Kode `restartPending` flag. |

**Gap:** Semua ini mentok di billing OFF + plan prices null.

---

## D. Runtime & Container

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 16 | Backend Milestone A-D merged | §6, 14, 15 | ✅ | Semua milestone backend di `main`. |
| 17 | Hardening baseline (non-root, read-only, cap drop) | §7.1 | ✅ | Terverifikasi di VPS dengan official image. |
| 18 | gVisor (runsc) DNS fix dan verifikasi | §7.2 | ✅ | Berfungsi penuh. VPS pakai `HERMES_RUNTIME=runsc`. |
| 19 | Egress controls (tenant isolation, SSRF, canary) | §7.3 | 🟡 | Branch `feat/egress-controls`, **belum merge ke `main`**. |
| 20 | Disk quota (XFS, project quota) | §7.1 | ✅ | Terverifikasi di VPS. |
| 21 | Scheduler multi-node / capacity reservation | §6.4 | ❌ | Single node. Belum ada scheduler. |
| 22 | Job queue Redis + BullMQ | §11 | 🟡 | Kode ada, `REDIS_URL` belum dipasang di VPS prod. |

**Gap:** Egress branch blocking merge. Scheduler dan job queue belum live.

---

## E. NibieRouter (Milestone E)

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 23 | Create NibieRouter user per tenant | §8.1 | ✅ | Admin calls terverifikasi ke router live. |
| 24 | Create API key per instance | §8.1 | ✅ | Kode + verifikasi real router. |
| 25 | One-time credit grant (`Plan.includedCreditNano`) | §8.1 | 🟡 | Kode siap, **belum pernah kepakai** karena billing OFF. |
| 26 | Router provisioning retry + guard | §8.1 | 🟡 | 24 attempts, perlu operator kalau habis. |

---

## F. Provider & Integrations (Telegram)

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 27 | Envelope-encrypted secrets (KEK, AES-256-GCM) | §7.4 | ✅ | Milestone C, deployed di VPS. |
| 28 | Provider config (BYOK + NibieRouter) | §8.2, 15.4 | ✅ | CRUD + test + delete. |
| 29 | Telegram bot connection | §9.3, 15.5 | ✅ | CRUD + verify + delete. |
| 30 | Log redaction | §7.4 | ✅ | Redact secret, API key, token dari logs. |
| 31 | Platform lain (Discord, WhatsApp, dll) | §9.2 | ❌ | Hanya Telegram. PRD §9.2 jelas: "Telegram now, other platforms later." |

---

## G. Customer Dashboard

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 32 | Dashboard (apps/web) — preview | §4.3, 15 | ✅ | Sudah live di Cloudflare Worker. |
| 33 | Dashboard — customer API mode | §15.3 | 🟡 | Mode `customer` siap, **belum diaktifkan di Worker** karena backend belum siap. |
| 34 | Billing screens (checkout, subscriptions, payment) | §15.2 | 🟡 | UI + mock beres. Real payment buntu. |
| 35 | Provider config screen | §15.4 | 🟡 | UI preview. Backend siap. |
| 36 | Telegram config screen | §15.5 | 🟡 | UI preview. Backend siap. |
| 37 | File manager / Web console | §15.6 | ❌ | PRD §7.5. Belum dibangun. |
| 38 | Backups UI | §15.7 | ❌ | Belum. |
| 39 | Admin/operator console | §16 | ❌ | Belum sama sekali. |

---

## H. Monitoring & Autopilot

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 40 | Health checks / /healthz | §13.1 | ✅ | Live di VPS. |
| 41 | Reconciler (auto-recovery instance crash) | §13.2 | ✅ | Bounded backoff, stability window, $\\le$ 3 attempts. |
| 42 | Autopilot Fase 1 (alert Telegram, /readyz, heartbeat, watchdog host) | §13.3 | 🟡 | **Kode selesai di branch, BELUM commit/push.** |
| 43 | Autopilot Fase 2-7 (sisanya) | §13.3 | ❌ | Rencana disetujui, belum dikerjakan. |
| 44 | Backup tenant volume (DB-only sekarang) | §12 | ❌ | Hanya DB. Volume tenant dan R2 belum. |

---

## I. Testing & CI

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 45 | Unit & integration tests (backend 462+) | - | ✅ | Berjalan. |
| 46 | E2E T0 (landing + dashboard mock) | - | ✅ | Hijau. |
| 47 | E2E T1 (customer mode + real backend) | - | ❌ | Butuh secrets `E2E_*`, Supabase test project, Docker daemon. |
| 48 | E2E T2 (production smoke) | - | ❌ | Butuh T1 dulu. |
| 49 | CI workflow (typecheck, lint, unit test) | - | ✅ | `.github/workflows/ci.yml` — jalan. |
| 50 | E2E CI workflow | - | 🟡 | `.github/workflows/e2e.yml` — T0 jalan, T1/T2 skip. |

---

## J. Legal & Admin

| # | Task | PRD § | Status | Catatan |
|---|------|-------|--------|---------|
| 51 | Syarat Layanan, Kebijakan Privasi, Kebijakan Refund | §2 | 🟡 | Draft live di landing. **Nash harus baca dan setuju.** |
| 52 | SPF/DKIM/DMARC SumoPod | - | ❌ | Perlu cek + set DNS. Menunggu SumoPod aktif. |
| 53 | VPS auto-renew (habis 2026-12-11) | - | ❌ | Nash harus aktifkan. |
| 54 | Bot Telegram untuk alert operasional | - | ❌ | Nash harus buat bot, token ke Bitwarden. |

---

## Ringkasan Prioritas (setelah update 16 Nov)

**Lakukan sekarang (kode dan infra):**
1. Implementasi gateway SumoPod Managed Payment di backend (bayar = QRIS, callback SumoPod)
2. Set `BILLING_GATEWAY=sumopod` dan env SumoPod di VPS
3. Set dua plan via SQL: Rp 25.000 (beta-starter) dan Rp 50.000 (beta-pro)
4. Nyalakan billing: `hc up -d --force-recreate backend` → verifikasi `billing:true` di log
5. Set Caddy routes billing + callback biar gak 404
6. Uji bayar end-to-end

**Menunggu Nash:**
- ✅ ~~Setuju SumoPod~~ (implisit dari "pindah ke sumopod KYC")
- ✅ ~~Duitku sandbox test~~ (berhasil)
- Buat bot Telegram → token ke Bitwarden → izin pasang autopilot Fase 1
- Aktifkan auto-renew VPS Tencent
- Baca + setuju 3 halaman legal draft
- Cek SPF/DKIM/DMARC SumoPod
- Merge PR 28 & 29 (setelah akun tes + secrets E2E siap)