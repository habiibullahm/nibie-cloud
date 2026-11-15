# Siklus instance

Setiap instance punya status yang terlihat di dashboard.

| Status | Arti |
| --- | --- |
| `Pending` | Menunggu pembayaran atau antrean provisioning. |
| `Provisioning` | Runtime dan volume sedang dibuat. |
| `Starting` | Hermes sedang menyala dan menjalani pemeriksaan kesehatan. |
| `Active` | Berjalan normal. |
| `Degraded` | Berjalan tetapi bermasalah. Pemulihan otomatis berjalan. Dashboard menampilkan alasan singkat dan langkah berikutnya. |
| `Suspended` | Dihentikan, misalnya karena langganan lewat masa tenggang. Data tetap disimpan selama masa retensi. |
| `Failed` | Provisioning atau pemulihan gagal. |
| `Deleting` / `Deleted` | Instance dan datanya sedang atau sudah dihapus. |

## Pemulihan otomatis

Jika instance `Active` atau `Degraded` berhenti merespons, sistem mencoba memulihkannya otomatis
(maksimal 3 percobaan dengan jeda yang bertambah). Instance yang Anda hentikan sendiri (`stop`) tidak
dinyalakan ulang otomatis.

## Masalah dari penyedia AI bukan masalah runtime

Jika penyedia model AI sedang gangguan, runtime Hermes yang sehat tidak akan di-restart. Dashboard
membedakan error penyedia dari error runtime.

## Aksi yang tersedia

- **Restart**
- **Stop / Start** (sesuai status langganan)
- **Web Console**: shell di dalam container Anda sendiri, dengan batas sesi dan waktu diam.

Dashboard tidak pernah menampilkan jalur file server induk, akses Docker, atau kredensial infrastruktur.
