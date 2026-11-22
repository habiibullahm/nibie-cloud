import type { Metadata } from "next"
import { PageShell, Prose } from "@/components/site/page-shell"
import { pageMetadata } from "@/lib/metadata"
import { SITE, contactEmail } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Kebijakan Refund",
  description: "Syarat pengembalian dana untuk langganan Nibie Cloud.",
  path: "/kebijakan-refund",
})

export default function KebijakanRefundPage() {
  const email = contactEmail()
  return (
    <PageShell
      title="Kebijakan Refund"
      intro={`Berlaku sejak ${SITE.legalUpdated}. Refund berarti pengembalian uang untuk pembayaran yang sudah kamu lakukan.`}
    >
      <Prose>
        <section>
          <h2>Refund penuh dalam 7 hari</h2>
          <p>
            Kamu berhak atas refund penuh bila permintaan diajukan dalam <strong>7 hari</strong> setelah pembayaran
            pertamamu dan instance <strong>belum dipakai</strong>.
          </p>
        </section>
        <section>
          <h2>Yang tidak dikembalikan</h2>
          <ul>
            <li>Pembayaran langganan yang sudah berjalan, di luar ketentuan 7 hari di atas.</li>
            <li>Perpanjangan langganan bulanan.</li>
            <li>Pemakaian AI lewat NibieRouter, termasuk kredit paket ($2 atau $3) yang sudah terpakai.</li>
            <li>Akun yang ditutup karena melanggar Syarat Layanan.</li>
          </ul>
        </section>
        <section>
          <h2>Pembayaran ganda atau kesalahan kami</h2>
          <p>
            Bila kamu tertagih dua kali untuk pembayaran yang sama, atau pembayaran berhasil tetapi instance tidak
            pernah aktif karena kesalahan di sisi kami, kelebihan atau seluruh pembayaran tersebut dikembalikan.
          </p>
        </section>
        <section>
          <h2>Cara mengajukan</h2>
          <ol>
            <li>
              Hubungi kami lewat{" "}
              {email ? (
                <>
                  email <a href={`mailto:${email}`}>{email}</a>
                </>
              ) : (
                <a href="/kontak">halaman Kontak</a>
              )}
              .
            </li>
            <li>Sertakan email akunmu serta tanggal, jumlah, dan metode pembayaran.</li>
            <li>Kami memeriksa permintaanmu dan menjawab dengan keputusan beserta alasannya.</li>
          </ol>
        </section>
        <section>
          <h2>Waktu dan metode pengembalian</h2>
          <p>
            Refund yang disetujui diproses dalam waktu paling lama 14 hari kerja. Dana dikembalikan lewat metode yang
            kami sepakati denganmu, memakai metode pembayaran asal bila memungkinkan. Biaya yang dikenakan pihak
            ketiga (misalnya penyedia pembayaran) mengikuti ketentuan mereka.
          </p>
        </section>
      </Prose>
    </PageShell>
  )
}
