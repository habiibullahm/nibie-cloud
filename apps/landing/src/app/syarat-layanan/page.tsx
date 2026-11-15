import type { Metadata } from "next"
import { PageShell, Prose } from "@/components/site/page-shell"
import { BETA_USERS } from "@/lib/plans"
import { SITE, contactEmail } from "@/lib/site"

export const metadata: Metadata = {
  title: "Syarat Layanan",
  description: "Syarat dan ketentuan penggunaan layanan hosting agent AI Nibie Cloud.",
  alternates: { canonical: "/syarat-layanan" },
}

export default function SyaratLayananPage() {
  const email = contactEmail()
  return (
    <PageShell
      title="Syarat Layanan"
      intro={`Berlaku sejak ${SITE.legalUpdated}. Dengan membuat akun atau membayar, kamu menyetujui syarat berikut.`}
    >
      <Prose>
        <section>
          <h2>1. Penyelenggara dan layanan</h2>
          <p>
            {SITE.name} dioperasikan oleh {SITE.operator} (&ldquo;kami&rdquo;). Kami menyediakan hosting terkelola untuk
            agent AI Hermes: satu container terisolasi dan satu volume penyimpanan untuk setiap pelanggan, beserta
            dashboard untuk mengelolanya. Layanan ini berada dalam tahap <strong>beta undangan</strong>.
          </p>
        </section>
        <section>
          <h2>2. Akun</h2>
          <ul>
            <li>Kamu wajib memberikan email yang aktif dan menjaga kerahasiaan akunmu.</li>
            <li>Kamu bertanggung jawab atas semua aktivitas yang terjadi lewat akunmu dan instance miliknya.</li>
            <li>Akses beta dapat diberikan, ditolak, atau dicabut oleh kami.</li>
          </ul>
        </section>
        <section>
          <h2>3. Paket, harga, dan pembayaran</h2>
          <ul>
            <li>
              Langganan bersifat bulanan dan ditagih dalam Rupiah (IDR). Harga, spesifikasi, dan isi paket ada di
              halaman <a href="/harga">Harga</a>.
            </li>
            <li>
              Harga beta berlaku hanya untuk pengguna beta ({BETA_USERS} pengguna pertama). Setelah beta, harga normal berlaku.
            </li>
            <li>
              Pembayaran diproses lewat payment gateway pihak ketiga. Instance diaktifkan setelah server kami
              memverifikasi pembayaran, bukan hanya karena kamu kembali dari halaman pembayaran.
            </li>
            <li>Paket Hosting + Kredit AI memberi kredit NibieRouter sebesar $2 satu kali di awal, bukan setiap bulan.</li>
            <li>
              Pemakaian AI di luar kredit tersebut ditagih terpisah oleh NibieRouter atau provider yang kamu pilih.
              Kami tidak menjanjikan pemakaian AI tanpa batas.
            </li>
          </ul>
        </section>
        <section>
          <h2>4. Refund</h2>
          <p>
            Refund diatur dalam <a href="/kebijakan-refund">Kebijakan Refund</a>, yang menjadi bagian dari syarat ini.
          </p>
        </section>
        <section>
          <h2>5. Penggunaan yang diizinkan</h2>
          <p>Kamu tidak boleh memakai layanan untuk:</p>
          <ul>
            <li>melanggar hukum yang berlaku di Indonesia atau hak pihak lain;</li>
            <li>mengirim spam, phishing, malware, atau konten yang menipu;</li>
            <li>menyerang, memindai, atau mengganggu sistem milik kami, pelanggan lain, atau pihak ketiga;</li>
            <li>menambang mata uang kripto atau beban kerja lain yang tidak sesuai tujuan layanan;</li>
            <li>mencoba keluar dari container, mengakses server host, atau mengakses data pelanggan lain.</li>
          </ul>
          <p>
            Pelanggaran dapat membuat instance dihentikan atau akun ditutup tanpa pengembalian dana, dan dapat kami
            laporkan kepada pihak berwenang bila diperlukan.
          </p>
        </section>
        <section>
          <h2>6. Data dan backup</h2>
          <ul>
            <li>Kamu tetap memiliki data dan konten yang kamu simpan di instance-mu.</li>
            <li>
              Kamu bertanggung jawab atas isi, konfigurasi, dan skill yang kamu jalankan, termasuk API key dan token
              bot yang kamu masukkan.
            </li>
            <li>
              Fitur backup masih dalam pengembangan. Selama beta, jangan menyimpan satu-satunya salinan data penting di
              instance.
            </li>
          </ul>
        </section>
        <section>
          <h2>7. Ketersediaan</h2>
          <p>
            Layanan beta diberikan sebagaimana adanya, tanpa jaminan ketersediaan tertentu. Kami dapat melakukan
            pemeliharaan, dan dapat menyampaikan pemberitahuan lewat dashboard atau email.
          </p>
        </section>
        <section>
          <h2>8. Penangguhan dan penghentian</h2>
          <ul>
            <li>
              Bila langganan tidak diperpanjang, instance dapat disuspend setelah masa tenggang. Data kemudian dihapus
              setelah masa penyimpanan yang diumumkan di dashboard.
            </li>
            <li>Kamu dapat berhenti berlangganan kapan saja. Pembayaran yang sudah berjalan mengikuti Kebijakan Refund.</li>
            <li>Kami dapat menangguhkan atau menutup akun yang melanggar syarat ini.</li>
          </ul>
        </section>
        <section>
          <h2>9. Batas tanggung jawab</h2>
          <p>
            Sejauh diizinkan hukum, tanggung jawab kami atas kerugian yang timbul dari penggunaan layanan dibatasi
            sebesar jumlah yang kamu bayarkan untuk layanan dalam satu bulan terakhir. Kami tidak bertanggung jawab atas
            keluaran atau tindakan agent AI yang kamu jalankan, maupun biaya pemakaian AI di provider pihak ketiga.
          </p>
        </section>
        <section>
          <h2>10. Perubahan syarat</h2>
          <p>
            Kami dapat memperbarui syarat ini. Tanggal berlaku terbaru selalu tercantum di bagian atas halaman, dan
            perubahan penting kami sampaikan lewat dashboard atau email.
          </p>
        </section>
        <section>
          <h2>11. Hukum yang berlaku dan kontak</h2>
          <p>
            Syarat ini tunduk pada hukum Republik Indonesia. Pertanyaan dapat dikirim lewat{" "}
            {email ? (
              <>
                email ke <a href={`mailto:${email}`}>{email}</a> atau{" "}
              </>
            ) : null}
            <a href={SITE.telegramUrl}>Telegram {SITE.telegramHandle}</a>, atau lewat halaman <a href="/kontak">Kontak</a>.
          </p>
        </section>
      </Prose>
    </PageShell>
  )
}
