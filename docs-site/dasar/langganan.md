# Langganan, masa tenggang, dan retensi

## Kebijakan yang disetujui

| Hal | Aturan |
| --- | --- |
| Penagihan | Langganan hosting berulang. Token AI ditagih terpisah. |
| Berhenti berlangganan | Instance tetap aktif sampai akhir periode yang sudah dibayar. |
| Masa tenggang | 3 hari setelah langganan jatuh tempo atau kedaluwarsa (tunduk pada kebijakan penagihan). |
| Penangguhan | Setelah masa tenggang, runtime dihentikan. Akses normal ditutup. |
| Retensi data | 30 hari setelah penangguhan. Volume dan metadata pemulihan disimpan. |
| Setelah retensi | Instance dan datanya dihapus permanen. |

## Alur ringkas

```
Active -> Grace period -> Suspended -> Deleting -> Deleted
              |               |
              +-- bayar ----> Active   (perpanjangan sah dalam masa retensi, jika kapasitas ada)
```

Anda diberi pemberitahuan sebelum penangguhan dan sebelum penghapusan permanen.

## Perpanjangan

Jika Anda memperpanjang dalam masa retensi, sistem memeriksa kapasitas lalu memulihkan instance.
Titik awal masa tenggang ditampilkan jelas di dashboard: `[BELUM DITENTUKAN: detail kebijakan penagihan]`.

## Harga

Harga plan belum final dan akan diumumkan setelah pengukuran sumber daya selesai.
