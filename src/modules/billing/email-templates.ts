import type { NoticeKind } from './lifecycle.js';

export type EmailKind = NoticeKind | 'payment_received';

export interface EmailContext {
  instanceName: string;
  /** End of the paid period (for `payment_received`, the new end). */
  periodEnd: Date | null;
  graceEndsAt?: Date | null;
  retentionEndsAt?: Date | null;
  amountIdr?: number;
  /** Where the customer manages the instance, e.g. `https://cloud.nibie.app/dashboard/instances`. */
  dashboardUrl: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const dateFmt = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long', timeStyle: 'short' });
const fmtDate = (d: Date | null | undefined): string => (d ? `${dateFmt.format(d)} WIB` : '-');
const fmtIdr = (n: number): string => `Rp ${new Intl.NumberFormat('id-ID').format(n)}`;

interface Copy { subject: string; heading: string; tag: string; paragraphs: string[]; button: string | null }

function copyFor(kind: EmailKind, c: EmailContext): Copy {
  const name = c.instanceName;
  const end = fmtDate(c.periodEnd);
  switch (kind) {
    case 'payment_received':
      return {
        subject: 'Pembayaran diterima - NibieCloud', heading: 'Pembayaran diterima', tag: 'TAGIHAN',
        paragraphs: [
          `Terima kasih. Pembayaran${c.amountIdr ? ` sebesar ${fmtIdr(c.amountIdr)}` : ''} untuk instance "${name}" sudah kami terima.`,
          `Instance Anda aktif sampai ${end}.`,
        ],
        button: 'Buka dashboard',
      };
    case 'renewal_7d':
    case 'renewal_3d':
    case 'renewal_1d': {
      const days = kind === 'renewal_7d' ? 7 : kind === 'renewal_3d' ? 3 : 1;
      return {
        subject: `Langganan berakhir ${days} hari lagi - NibieCloud`, heading: `Langganan berakhir ${days} hari lagi`, tag: 'TAGIHAN',
        paragraphs: [
          `Langganan instance "${name}" berakhir pada ${end}.`,
          'Perpanjang sebelum tanggal itu supaya instance Anda tidak terganggu.',
        ],
        button: 'Perpanjang di dashboard',
      };
    }
    case 'grace_started':
      return {
        subject: 'Masa tenggang dimulai - NibieCloud', heading: 'Masa tenggang dimulai', tag: 'TAGIHAN',
        paragraphs: [
          `Langganan instance "${name}" sudah berakhir. Instance tetap berjalan selama masa tenggang 3 hari, sampai ${fmtDate(c.graceEndsAt)}.`,
          'Setelah itu instance dihentikan. Perpanjang sekarang untuk menghindarinya.',
        ],
        button: 'Perpanjang di dashboard',
      };
    case 'suspension_warning':
      return {
        subject: 'Instance akan dihentikan besok - NibieCloud', heading: 'Instance akan dihentikan besok', tag: 'TAGIHAN',
        paragraphs: [
          `Masa tenggang instance "${name}" berakhir pada ${fmtDate(c.graceEndsAt)}. Setelah itu instance dihentikan.`,
          'Data Anda tetap disimpan 30 hari setelah penghentian.',
        ],
        button: 'Perpanjang di dashboard',
      };
    case 'suspended':
      return {
        subject: 'Instance dihentikan - NibieCloud', heading: 'Instance dihentikan', tag: 'TAGIHAN',
        paragraphs: [
          `Instance "${name}" dihentikan karena langganan belum diperpanjang. Data Anda tetap disimpan sampai ${fmtDate(c.retentionEndsAt)}.`,
          'Perpanjang sebelum tanggal itu untuk menjalankan instance kembali. Setelahnya instance dan datanya dihapus permanen.',
        ],
        button: 'Perpanjang di dashboard',
      };
    case 'deletion_warning':
      return {
        subject: 'Data akan dihapus permanen - NibieCloud', heading: 'Data akan dihapus permanen', tag: 'TAGIHAN',
        paragraphs: [
          `Instance "${name}" dan seluruh datanya akan dihapus permanen pada ${fmtDate(c.retentionEndsAt)}.`,
          'Perpanjang sebelum tanggal itu jika Anda ingin menyimpannya.',
        ],
        button: 'Perpanjang di dashboard',
      };
    case 'deleted':
      return {
        subject: 'Instance dihapus - NibieCloud', heading: 'Instance dihapus', tag: 'TAGIHAN',
        paragraphs: [`Masa penyimpanan data berakhir, sehingga instance "${name}" dan datanya sudah dihapus permanen.`],
        button: null,
      };
  }
}

/** Indonesian transactional email, same look as the NibieCloud auth emails. Every dynamic value is escaped. */
export function renderEmail(kind: EmailKind, ctx: EmailContext): RenderedEmail {
  const c = copyFor(kind, ctx);
  const font = "font-family:'Segoe UI',Arial,Helvetica,sans-serif;";
  const paras = c.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4b5563;${font}">${escapeHtml(p)}</p>`)
    .join('\n');
  const button = c.button
    ? `<p style="margin:8px 0 24px;"><a href="${escapeHtml(ctx.dashboardUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 22px;border-radius:10px;${font}">${escapeHtml(c.button)}</a></p>`
    : '';
  const html = `<div style="margin:0;padding:24px 12px;background:#f3f4f6;${font}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;border-collapse:collapse;">
<tr><td style="background:#0d0e12;border-radius:16px 16px 0 0;padding:20px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="46" style="vertical-align:middle;"><img src="https://nibie.app/brand/nibie-mark.png" width="36" height="24" alt="" style="display:block;border:0;"></td><td style="vertical-align:middle;${font}color:#ffffff;font-size:16px;font-weight:700;">NibieCloud</td>
<td align="right" style="${font}color:#9ca3af;font-size:11px;font-weight:700;letter-spacing:1px;">${escapeHtml(c.tag)}</td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:28px 24px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;${font}">${escapeHtml(c.heading)}</h1>
${paras}
${button}<p style="margin:0;font-size:12px;color:#6b7280;${font}">NibieCloud &middot; https://cloud.nibie.app</p>
</td></tr></table></div>`;
  const text = [c.heading, '', ...c.paragraphs, ...(c.button ? ['', `${c.button}: ${ctx.dashboardUrl}`] : []), '', 'NibieCloud - https://cloud.nibie.app'].join('\n');
  return { subject: c.subject, text, html };
}
