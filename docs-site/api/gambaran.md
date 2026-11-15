# Rancangan API

> **Belum final.** API pelanggan masih berupa kerangka kontrak di PRD v1.0. Skema, autentikasi, katalog
> error, dan spesifikasi OpenAPI belum dibuat. Jangan membangun integrasi dari halaman ini.
>
> Yang sudah ada saat ini hanya API operator internal (satu bearer token admin, hanya bisa diakses
> dari host lokal, tanpa autentikasi pelanggan). API itu tidak tersedia untuk umum.

Base path yang direncanakan: `/api/v1`

## Kelompok endpoint yang direncanakan

| Kelompok | Contoh |
| --- | --- |
| Akun | `POST /auth/register`, `POST /auth/login`, `GET /me` |
| Plan dan langganan | `GET /plans`, `POST /subscriptions/checkout`, `POST /subscriptions/renew` |
| Instance | `POST /instances`, `GET /instances/:id`, `POST /instances/:id/restart` |
| Penyedia AI | `GET/PUT /instances/:id/providers`, `POST /instances/:id/providers/test` |
| Telegram | `GET/PUT /instances/:id/telegram`, `POST /instances/:id/telegram/verify` |
| File dan console | `GET/POST /instances/:id/files`, `POST /instances/:id/console/sessions` |
| Backup dan audit | `GET/POST /instances/:id/backups`, `GET /audit-logs` |

## Perilaku yang direncanakan

- Operasi panjang (provisioning, restart, restore) mengembalikan `202 Accepted` dan ID job.
- Setiap akses sumber daya dicek per tenant.
- Tindakan sensitif pembayaran dan provisioning memakai idempotency key.
- Error disanitasi: tidak pernah memuat rahasia atau kredensial infrastruktur.
- Autentikasi, console, file, dan provisioning dibatasi lajunya.

## Penyedia AI (ini sudah nyata)

Untuk memakai model AI langsung, lihat [Penyedia AI](../dasar/provider-ai.md). API NibieRouter
(`https://router.nibie.app/v1`) terpisah dari API Nibie Cloud.
