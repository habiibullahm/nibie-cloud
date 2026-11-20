# Proyek Multi-Node: 3 VPS untuk 100 pengguna

Dicatat 2026-11-20 atas permintaan owner. Status: **rencana, belum dimulai.** Belum ada keputusan arsitektur yang disetujui;
dokumen ini mencatat tujuan, keadaan sekarang, dan pekerjaan yang dibutuhkan supaya tidak lupa.

## Tujuan

- Tiga VPS yang sama (owner sudah punya) siap dipakai bersama untuk instance pelanggan.
- Target: **100 pengguna**, satu instance per pengguna (sesuai `BETA_USERS = 100` di `apps/landing/src/lib/plans.ts`).
- Satu VPS mati tidak mematikan instance di VPS lain.

## Keadaan sekarang (2026-11-20)

- Satu node saja (ADR 0001, `docs/adr/0001-docker-direct-no-orchestrator.md`): backend hanya memakai Docker di VPS tempat ia
  berjalan. "A second node needs a remote-capable" runtime manager.
- Tabel `RuntimeNode` sudah ada, isinya satu baris `local`. `nodeId` hanya dipakai di `instance-service.ts` dan
  `admin-routes.ts`. Tidak ada penjadwal (`docs/feature-spec.md`, #21 "Scheduler multi-node / capacity reservation": belum).
- Rencana operasi (`2026-11-15-operasi-autopilot-tanpa-admin.md`, item 5.1 sampai 5.4) sudah memuat reservasi kapasitas,
  alert kapasitas, pengukuran RAM nyata, dan "multi-node adalah milestone sendiri". Proyek ini adalah milestone itu.
- VPS produksi: RAM 15 GB, terpakai sekitar 2,2 GB. Satu instance tenant memakai sekitar 240 sampai 320 MB nyata
  (diukur 2026-11-20, beberapa instance), batas 1 GB per instance.
- SSH masuk ke VPS dibatasi provider sejak 2026-11-20; deploy memakai pull deploy di host. Tailscale direncanakan.

## Hitungan kapasitas (perkiraan, harus diukur ulang)

| Sumber | Per instance | 100 instance | 3 VPS |
| --- | --- | --- | --- |
| RAM nyata | sekitar 300 MB | sekitar 30 GB | 45 GB (3 x 15 GB) |
| RAM batas plan | 1 GB | 100 GB | 45 GB |
| Disk plan | 5 GB (Hosting) atau 10 GB (Kredit AI) | 500 GB sampai 1 TB | **belum diketahui** |
| CPU plan | 1 CPU | 100 CPU | **belum diketahui** |

Kesimpulan sementara:

- RAM: 100 instance muat di 3 VPS hanya dengan **overcommit** (batas 1 GB, pemakaian nyata sekitar 300 MB). Di satu VPS
  saja tidak muat (30 GB nyata lebih besar dari 15 GB).
- Disk kemungkinan besar batas pertama. Kuota XFS adalah batas atas, file sparse, jadi disk juga bisa overcommit, tapi perlu
  alert. Ukuran disk tiap VPS harus dicek dulu.

## Pekerjaan

### Fase 0: ukur dan putuskan

- [ ] Ukur RAM, CPU, disk nyata per instance di bawah `runsc` selama seminggu (item 5.3 rencana operasi).
- [ ] Catat spesifikasi tiap VPS: RAM, vCPU, disk, region. Tanpa alamat IP di repo.
- [ ] Owner memutuskan rasio overcommit RAM dan disk, dan apakah VPS 1 (control plane) juga menampung instance.

### Fase 1: jaringan antar node

- [ ] Tailscale (atau WireGuard) di ketiga VPS. Lalu lintas kontrol antar node hanya lewat jaringan privat ini, tidak lewat
  internet publik. Ini juga menghidupkan lagi deploy dari GitHub.

### Fase 2: runtime agent di setiap node

- [ ] Layanan kecil di setiap node yang menjalankan antarmuka `RuntimeManager` (`src/modules/runtime/types.ts`) di atas Docker
  lokal. Hanya agent ini yang menyentuh socket Docker di node itu.
- [ ] Backend memilih implementasi per `RuntimeNode`: `local` seperti sekarang, atau klien remote ke agent node lain.
- [ ] Autentikasi agent: token per node atau mTLS, hanya terbuka di jaringan privat.
- [ ] Nama Docker tetap dari UUID instance, jadi panggilan tetap idempoten.

### Fase 3: penjadwal

- [ ] `RuntimeNode` mendapat kolom kapasitas (RAM, disk, CPU yang boleh dijanjikan) dan status (`active`, `draining`).
- [ ] Saat instance dibuat, pilih node dengan sisa reservasi terbesar, simpan `Instance.nodeId`. Instance tidak pindah node.
- [ ] Checkout ditolak dengan "penuh" saat semua node di atas batas (item 5.1).

### Fase 4: operasi per node

- [ ] Setup host yang sama di VPS 2 dan 3: Docker, XFS project quota, `ops/egress`, `runsc`, image Hermes ter-pin, canary.
  Satu skrip atau runbook dari `deploy/README.md`.
- [ ] Timer kuota volume (`hermes-volume-quota`) dan pull deploy agent di setiap node.
- [ ] Reconciler dan alert per node: node tidak menjawab, RAM atau disk di atas 70% dan 85% (item 5.2).
- [ ] Backup volume tenant per node (sekarang belum ada backup volume sama sekali).

### Fase 5: panel admin

- [ ] Halaman Node menampilkan kapasitas dan pemakaian tiap node, dan tombol drain (tidak menerima instance baru).

## Selesai bila

- 100 instance uji tersebar di 3 node, dibuat dan dihapus lewat dashboard seperti biasa.
- Mematikan satu node: instance di dua node lain tetap jalan, alert muncul, instance di node yang mati pulih setelah node
  hidup lagi.
- Alert kapasitas berbunyi di 70%.

## Risiko dan pertanyaan terbuka

- Control plane (backend, Redis, Caddy) tetap di satu VPS. Kalau VPS itu mati, instance di node lain tetap jalan, tapi
  dashboard, pembayaran dan pemulihan berhenti sampai VPS itu kembali.
- Akses pelanggan ke agent: `accessUrl` masih alamat loopback. Perlu dicek apakah ada fitur yang butuh lalu lintas masuk
  ke instance di node lain (Telegram memakai koneksi keluar).
- Ukuran disk dan vCPU VPS belum diketahui.
