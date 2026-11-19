import type { Metadata } from "next"
import { PageShell, Prose } from "@/components/site/page-shell"
import { SITE, contactEmail } from "@/lib/site"

export const metadata: Metadata = {
  title: "Kebijakan Privasi",
  description: "Data pribadi apa yang dikumpulkan Nibie Cloud, untuk apa, dan bagaimana kami menjaganya.",
  alternates: { canonical: "/kebijakan-privasi" },
}

export default function KebijakanPrivasiPage() {
  const email = contactEmail()
  return (
    <PageShell
      title="Kebijakan Privasi"
      intro={`Berlaku sejak ${SITE.legalUpdated}. Halaman ini menjelaskan data pribadi yang kami kumpulkan dan cara kami memakainya.`}
    >
      <Prose>
        <section>
          <h2>1. Siapa kami</h2>
          <p>
            {SITE.name} dioperasikan oleh {SITE.operator}. Pertanyaan soal data pribadi dapat dikirim lewat halaman{" "}
            <a href="/kontak">Kontak</a>.
          </p>
        </section>
        <section>
          <h2>2. Data yang kami kumpulkan</h2>
          <ul>
            <li>
              <strong>Akun:</strong> alamat email dan kata sandi (disimpan sebagai hash oleh penyedia autentikasi kami).
            </li>
            <li>
              <strong>Instance:</strong> nama instance, paket, status, log operasional, serta konfigurasi dan data yang
              kamu simpan di instance.
            </li>
            <li>
              <strong>Rahasia yang kamu masukkan:</strong> API key provider AI dan token bot Telegram. Semuanya
              disimpan terenkripsi, dan tidak pernah ditampilkan ulang atau ditulis ke log.
            </li>
            <li>
              <strong>Pembayaran:</strong> referensi dan status transaksi. Nomor kartu, rekening, atau dompet digitalmu
              diproses penyedia pembayaran dan tidak kami simpan.
            </li>
            <li>
              <strong>Teknis:</strong> data akses dasar seperti alamat IP dan jenis peramban, untuk keamanan dan
              pemecahan masalah.
            </li>
          </ul>
        </section>
        <section>
          <h2>3. Untuk apa kami memakainya</h2>
          <ul>
            <li>Menjalankan, mengamankan, dan menagih layanan.</li>
            <li>Mengirim email transaksional seperti konfirmasi akun, tagihan, dan pengingat perpanjangan.</li>
            <li>Mencegah penyalahgunaan dan menanggapi permintaan bantuan.</li>
          </ul>
          <p>Kami tidak menjual data pribadimu dan tidak memakainya untuk iklan.</p>
        </section>
        <section>
          <h2>4. Pihak yang memproses data</h2>
          <p>Kami memakai penyedia berikut untuk menjalankan layanan:</p>
          <ul>
            <li>Supabase untuk autentikasi dan basis data.</li>
            <li>SumoPod untuk pemrosesan pembayaran (QRIS).</li>
            <li>Cloudflare untuk menyajikan situs dan dashboard.</li>
            <li>Penyedia layanan email untuk mengirim email transaksional.</li>
            <li>
              NibieRouter atau provider AI yang kamu pilih, untuk permintaan AI yang dijalankan agent-mu. Untuk setiap akun kami
              membuat satu pengguna NibieRouter dengan alamat email teknis (bukan emailmu) dan satu API key per instance.
            </li>
          </ul>
          <p>Server tempat instance berjalan berada di Jakarta, Indonesia.</p>
        </section>
        <section>
          <h2>5. Penyimpanan dan penghapusan</h2>
          <p>
            Kami menyimpan data selama akunmu aktif dan selama diperlukan untuk kewajiban pembayaran dan keamanan.
            Saat instance dihapus, datanya dihapus mengikuti masa penyimpanan yang diumumkan di dashboard.
          </p>
        </section>
        <section>
          <h2>6. Hakmu</h2>
          <p>
            Kamu dapat meminta akses, koreksi, atau penghapusan data pribadimu, dan menarik persetujuan yang pernah
            kamu berikan. Kirim permintaan lewat{" "}
            {email ? <a href={`mailto:${email}`}>{email}</a> : <a href="/kontak">halaman Kontak</a>}. Kami menjawab secepatnya.
          </p>
        </section>
        <section>
          <h2>7. Keamanan</h2>
          <p>
            Setiap pelanggan mendapat container dan volume terpisah. Rahasia dienkripsi, dan akses ke sistem produksi
            dibatasi. Tidak ada sistem yang sepenuhnya bebas risiko, dan kami akan memberi tahu bila terjadi insiden
            yang berdampak pada datamu.
          </p>
        </section>
        <section>
          <h2>8. Perubahan</h2>
          <p>Kami dapat memperbarui kebijakan ini. Tanggal berlaku terbaru selalu tercantum di bagian atas halaman.</p>
        </section>
      </Prose>
    </PageShell>
  )
}
