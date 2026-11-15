# Draf docs Nibie Cloud

Konten Markdown untuk situs docs terpisah. Belum ada alat situs (generator) yang dipilih, jadi folder ini
hanya berisi konten. Belum di-commit.

Sumber fakta: `docs/prd.md` v1.0, `AGENTS.md`, dan `GET https://router.nibie.app/v1/models`.
Struktur mengikuti pola docs.sumorouter.com (Pengenalan, Quickstart, Dasar, Integrasi).

## Struktur situs

```
Panduan
  index.md              Pengenalan
  quickstart.md         Deploy instance pertama
  dasar/
    siklus-instance.md  Status dan siklus hidup
    provider-ai.md      NibieRouter dan BYOK
    telegram.md         Hubungkan bot Telegram
    langganan.md        Langganan, masa tenggang, retensi
  api/
    gambaran.md         Rancangan API (belum final)
```

## Aturan penulisan draf

- Fakta hanya dari repo atau dari sumber di atas. Yang belum diputuskan ditulis `[BELUM DITENTUKAN]`.
- Tidak ada harga plan, kredensial, token, atau IP server.
- Dashboard saat ini masih pratinjau (data mock), jadi halaman diberi catatan status.

## Pertanyaan terbuka untuk pemilik

1. Bahasa docs: Indonesia (draf ini) atau Inggris?
2. Audiens: pelanggan (draf ini) atau tim internal?
3. Alat situs docs (Zudoku, Docusaurus, Mintlify, atau lainnya) dan domain (misalnya `docs.cloud.nibie.app`).
4. Lokasi draf ini di repo: folder baru `docs-site/` atau repo terpisah.
5. Plan dan harga, alur setup Telegram yang final, cara pelanggan mendapat key NibieRouter.
