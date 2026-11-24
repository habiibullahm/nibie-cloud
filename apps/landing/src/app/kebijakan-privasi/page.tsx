import type { Metadata } from "next"
import { PageShell, Prose } from "@/components/site/page-shell"
import { pageMetadata } from "@/lib/metadata"
import { SITE, contactEmail } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Kebijakan Privasi",
  description: "Data pribadi apa yang dikumpulkan Nibie Cloud, untuk apa, dan bagaimana kami menjaganya.",
  path: "/kebijakan-privasi",
})

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
              <strong>Akun:</strong> alamat email, nama yang kamu isi, dan kata sandi (disimpan sebagai hash oleh penyedia
              autentikasi kami). Bila kamu masuk dengan Google, kami menerima email, nama, dan foto profil dari akun
              Google-mu, bukan kata sandinya.
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
              <strong>Pembayaran:</strong> referensi dan status transaksi, invoice, serta saldo dan riwayat mutasi
              saldo. Nomor kartu, rekening, atau dompet digitalmu diproses penyedia pembayaran dan tidak kami simpan.
            </li>
            <li>
              <strong>Bantuan:</strong> isi tiket bantuan dan balasan kami.
            </li>
            <li>
              <strong>Teknis:</strong> data akses dasar seperti alamat IP dan jenis peramban, termasuk pemeriksaan
              captcha saat mendaftar atau masuk, untuk keamanan dan pemecahan masalah.
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
            <li>Supabase untuk autentikasi dan basis data (data akun, instance, dan pembayaran), di region Singapura.</li>
            <li>
              Tencent Cloud untuk server tempat instance berjalan: paket berbayar di Jakarta, Indonesia; instance beta
              gratis bisa berjalan di Jakarta atau Singapura.
            </li>
            <li>SumoPod untuk pemrosesan pembayaran (QRIS) dan pengiriman email tagihan dan layanan.</li>
            <li>Penyedia email untuk email konfirmasi akun dan kode masuk yang dikirim lewat Supabase.</li>
            <li>
              Cloudflare untuk menyajikan situs dan dashboard, pemeriksaan captcha (Turnstile), dan penyimpanan cadangan
              terenkripsi (R2).
            </li>
            <li>Google, hanya bila kamu memilih masuk dengan Google.</li>
            <li>
              NibieRouter dan provider model AI di belakangnya, atau provider AI yang kamu pilih sendiri. Isi permintaan
              AI yang dijalankan agent-mu dikirim ke mereka untuk diproses. Untuk setiap akun kami membuat satu pengguna
              NibieRouter dengan alamat email teknis (bukan emailmu) dan satu API key per instance.
            </li>
            <li>WhatsApp, hanya bila kamu menghubungi bantuan lewat WhatsApp.</li>
          </ul>
          <p>
            Karena basis data kami berada di Singapura, data akun dan pembayaranmu disimpan di luar Indonesia. Data
            yang kamu simpan di instance tetap berada di server Jakarta untuk paket berbayar, dan di Jakarta atau
            Singapura untuk instance beta gratis.
          </p>
        </section>
        <section>
          <h2>5. Penyimpanan dan penghapusan</h2>
          <ul>
            <li>
              Saat instance dihapus, container, volume data, dan rahasianya langsung dihapus. Cadangan volume ikut
              terhapus paling lama 7 hari kemudian.
            </li>
            <li>
              Bila langganan tidak diperpanjang, instance dihentikan setelah masa tenggang dan dihapus 30 hari
              kemudian.
            </li>
            <li>Cadangan basis data disimpan paling lama sekitar 8 minggu, lalu terhapus otomatis.</li>
            <li>Data pembayaran dan invoice kami simpan selama 10 tahun untuk kewajiban perpajakan.</li>
            <li>Data akun lainnya kami simpan selama akunmu ada. Akun dapat dihapus atas permintaanmu.</li>
          </ul>
        </section>
        <section>
          <h2>6. Hakmu</h2>
          <p>
            Sesuai Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi, kamu dapat meminta akses,
            koreksi, atau penghapusan data pribadimu, menarik persetujuan yang pernah kamu berikan, dan menolak
            pemrosesan tertentu. Kirim permintaan lewat{" "}
            {email ? <a href={`mailto:${email}`}>{email}</a> : <a href="/kontak">halaman Kontak</a>}. Kami menjawab secepatnya.
          </p>
        </section>
        <section>
          <h2>7. Keamanan</h2>
          <p>
            Setiap pelanggan mendapat container dan volume terpisah. Rahasia dienkripsi, dan akses ke sistem produksi
            dibatasi. Tidak ada sistem yang sepenuhnya bebas risiko. Bila terjadi kebocoran yang berdampak pada data
            pribadimu, kami memberi tahu kamu secara tertulis paling lambat 3 x 24 jam sejak kebocoran diketahui.
          </p>
        </section>
        <section>
          <h2>8. Penyimpanan di peramban</h2>
          <p>
            Dashboard menyimpan sesi masuk dan pilihan tampilan (bahasa dan tema) di penyimpanan peramban. Kami tidak
            memakai cookie iklan atau pelacak analitik.
          </p>
        </section>
        <section>
          <h2>9. Perubahan</h2>
          <p>Kami dapat memperbarui kebijakan ini. Tanggal berlaku terbaru selalu tercantum di bagian atas halaman.</p>
        </section>
      </Prose>
    </PageShell>
  )
}
