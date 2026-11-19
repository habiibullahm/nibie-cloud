import type { NoticeKind } from './lifecycle.js';

export type EmailKind = NoticeKind | 'payment_received' | 'topup_received';

export interface EmailContext {
  instanceName: string;
  /** End of the paid period (for `payment_received`, the new end). */
  periodEnd: Date | null;
  graceEndsAt?: Date | null;
  retentionEndsAt?: Date | null;
  amountIdr?: number;
  /** Wallet balance after a top-up (`topup_received`). */
  balanceIdr?: number;
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
        subject: 'Pembayaran diterima - Nibie Cloud', heading: 'Pembayaran diterima', tag: 'TAGIHAN',
        paragraphs: [
          `Terima kasih. Pembayaran${c.amountIdr ? ` sebesar ${fmtIdr(c.amountIdr)}` : ''} untuk instance "${name}" sudah kami terima.`,
          `Instance Anda aktif sampai ${end}.`,
        ],
        button: 'Buka dashboard',
      };
    case 'topup_received':
      return {
        subject: 'Top-up saldo diterima - Nibie Cloud', heading: 'Top-up saldo diterima', tag: 'TAGIHAN',
        paragraphs: [
          `Terima kasih. Top-up saldo${c.amountIdr ? ` sebesar ${fmtIdr(c.amountIdr)}` : ''} sudah kami terima.`,
          ...(c.balanceIdr !== undefined ? [`Saldo Nibie Cloud Anda sekarang ${fmtIdr(c.balanceIdr)}.`] : []),
          'Saldo bukan uang tunai dan tidak dapat dikembalikan atau ditarik.',
        ],
        button: 'Lihat saldo',
      };
    case 'renewal_7d':
    case 'renewal_3d':
    case 'renewal_1d': {
      const days = kind === 'renewal_7d' ? 7 : kind === 'renewal_3d' ? 3 : 1;
      return {
        subject: `Langganan berakhir ${days} hari lagi - Nibie Cloud`, heading: `Langganan berakhir ${days} hari lagi`, tag: 'TAGIHAN',
        paragraphs: [
          `Langganan instance "${name}" berakhir pada ${end}.`,
          'Perpanjang sebelum tanggal itu supaya instance Anda tidak terganggu.',
        ],
        button: 'Perpanjang di dashboard',
      };
    }
    case 'grace_started':
      return {
        subject: 'Masa tenggang dimulai - Nibie Cloud', heading: 'Masa tenggang dimulai', tag: 'TAGIHAN',
        paragraphs: [
          `Langganan instance "${name}" sudah berakhir. Instance tetap berjalan selama masa tenggang 3 hari, sampai ${fmtDate(c.graceEndsAt)}.`,
          'Setelah itu instance dihentikan. Perpanjang sekarang untuk menghindarinya.',
        ],
        button: 'Perpanjang di dashboard',
      };
    case 'suspension_warning':
      return {
        subject: 'Instance akan dihentikan besok - Nibie Cloud', heading: 'Instance akan dihentikan besok', tag: 'TAGIHAN',
        paragraphs: [
          `Masa tenggang instance "${name}" berakhir pada ${fmtDate(c.graceEndsAt)}. Setelah itu instance dihentikan.`,
          'Data Anda tetap disimpan 30 hari setelah penghentian.',
        ],
        button: 'Perpanjang di dashboard',
      };
    case 'suspended':
      return {
        subject: 'Instance dihentikan - Nibie Cloud', heading: 'Instance dihentikan', tag: 'TAGIHAN',
        paragraphs: [
          `Instance "${name}" dihentikan karena langganan belum diperpanjang. Data Anda tetap disimpan sampai ${fmtDate(c.retentionEndsAt)}.`,
          'Perpanjang sebelum tanggal itu untuk menjalankan instance kembali. Setelahnya instance dan datanya dihapus permanen.',
        ],
        button: 'Perpanjang di dashboard',
      };
    case 'deletion_warning':
      return {
        subject: 'Data akan dihapus permanen - Nibie Cloud', heading: 'Data akan dihapus permanen', tag: 'TAGIHAN',
        paragraphs: [
          `Instance "${name}" dan seluruh datanya akan dihapus permanen pada ${fmtDate(c.retentionEndsAt)}.`,
          'Perpanjang sebelum tanggal itu jika Anda ingin menyimpannya.',
        ],
        button: 'Perpanjang di dashboard',
      };
    case 'deleted':
      return {
        subject: 'Instance dihapus - Nibie Cloud', heading: 'Instance dihapus', tag: 'TAGIHAN',
        paragraphs: [`Masa penyimpanan data berakhir, sehingga instance "${name}" dan datanya sudah dihapus permanen.`],
        button: null,
      };
  }
}

/** Indonesian transactional email, same look as the Nibie Cloud auth emails. Every dynamic value is escaped. */
export function renderEmail(kind: EmailKind, ctx: EmailContext): RenderedEmail {
  return layout(copyFor(kind, ctx), ctx.dashboardUrl);
}

export interface WaitlistInviteContext {
  /** What the person typed on the waiting-list form; shown escaped in the greeting only. */
  name: string;
  /** End of the claim window. */
  claimUntil: Date;
  /** Where to register, e.g. `https://cloud.nibie.app/dashboard/register`. */
  registerUrl: string;
}

export interface WaitlistConfirmContext {
  /** The confirmation page with the token in the fragment, e.g. `https://cloud.nibie.app/daftar-tunggu/konfirmasi#t=...`. */
  confirmUrl: string;
  /** End of the link's validity. */
  validUntil: Date;
}

/**
 * The double opt-in email: the entry joins the queue only after the person opens this link and confirms. It carries no text
 * from the form: the address is not proven yet, so whatever was typed must not reach that inbox under our name.
 */
export function renderWaitlistConfirm(ctx: WaitlistConfirmContext): RenderedEmail {
  return layout({
    subject: 'Konfirmasi email daftar tunggu - Nibie Cloud', heading: 'Konfirmasi email Anda', tag: 'BETA',
    paragraphs: [
      'Halo,',
      'Seseorang (semoga Anda) memasukkan alamat email ini ke daftar tunggu beta gratis Nibie Cloud.',
      `Buka tautan di bawah dan tekan "Konfirmasi" sebelum ${fmtDate(ctx.validUntil)}. Tanpa konfirmasi, alamat ini tidak masuk antrean dan datanya kami hapus.`,
      'Kalau Anda tidak merasa mendaftar, abaikan email ini.',
    ],
    button: 'Buka halaman konfirmasi',
  }, ctx.confirmUrl);
}

/** The invitation sent when a free beta slot is reserved for a waiting-list entry. */
export function renderWaitlistInvite(ctx: WaitlistInviteContext): RenderedEmail {
  return layout({
    subject: 'Slot beta gratis Anda sudah siap - Nibie Cloud', heading: 'Slot beta gratis Anda sudah siap', tag: 'BETA',
    paragraphs: [
      `Halo ${ctx.name},`,
      'Satu slot beta gratis Nibie Cloud sekarang kosong dan kami simpan untuk Anda.',
      `Daftar dengan alamat email ini sebelum ${fmtDate(ctx.claimUntil)}. Setelah itu slot diberikan ke orang berikutnya di daftar tunggu.`,
      'Setelah masuk, buat instance Hermes Anda dengan paket Beta Preview (gratis).',
    ],
    button: 'Daftar sekarang',
  }, ctx.registerUrl);
}

export interface BetaInviteContext {
  /** The invited address, already validated by the route; named in the subject so the mail reads as written to one person. */
  email: string;
  /** Where to register, e.g. `https://cloud.nibie.app/dashboard/register`. */
  registerUrl: string;
  /** True when the mail carries a monitored Reply-To, so the copy may ask for a reply. */
  canReply: boolean;
}

/**
 * Sent when an admin adds an address to the beta invite list. It carries no admin-typed text (note, reason). Plain text with
 * no HTML layout (owner decision 2026-11-19): the branded "you are invited" mail landed in Gmail spam on a first contact, so
 * this one reads like a person's note. It names the address and says why it came.
 */
export function renderBetaInvite(ctx: BetaInviteContext): { subject: string; text: string } {
  const text = [
    'Halo,',
    '',
    `Tim Nibie Cloud sudah membuka akses beta untuk ${ctx.email}. Biasanya karena Anda atau rekan Anda meminta akses ke kami.`,
    '',
    'Nibie Cloud adalah layanan hosting agen Hermes AI. Daftar atau masuk dengan alamat email ini, lalu buat instance Hermes Anda dari dashboard:',
    ctx.registerUrl,
    '',
    ctx.canReply
      ? 'Ada pertanyaan? Balas email ini, tim kami yang menjawab. Kalau Anda tidak meminta akses ini, abaikan saja email ini.'
      : 'Kalau Anda tidak meminta akses ini, abaikan saja email ini.',
    '',
    'Salam,',
    'Tim Nibie Cloud',
  ].join('\n');
  return { subject: `Akses beta Nibie Cloud untuk ${ctx.email}`, text };
}

/** Long messages are cut in emails; the full text is in the dashboard. */
const excerpt = (s: string) => (s.length > 1000 ? `${s.slice(0, 1000)}…` : s);

export interface TicketToTeamContext {
  kind: 'new' | 'reply';
  subject: string;
  category: string;
  customerEmail: string;
  message: string;
  /** Admin panel page of the ticket. */
  url: string;
}

/** To the support inbox: a new ticket, or a customer's reply on one. Customer text is escaped by `layout`. */
export function renderTicketToTeam(ctx: TicketToTeamContext): RenderedEmail {
  const what = ctx.kind === 'new' ? 'Tiket baru' : 'Balasan pelanggan';
  return layout({
    subject: `${what}: ${ctx.subject}`, heading: `${what}: ${ctx.subject}`, tag: 'TIKET',
    paragraphs: [`Dari ${ctx.customerEmail} · ${ctx.category}`, excerpt(ctx.message)],
    button: 'Buka di panel admin',
  }, ctx.url);
}

export interface TicketReplyContext {
  subject: string;
  message: string;
  /** Dashboard page of the ticket. */
  url: string;
}

/** To the customer when the team replies. */
export function renderTicketReply(ctx: TicketReplyContext): RenderedEmail {
  return layout({
    subject: `Balasan untuk tiket: ${ctx.subject}`, heading: `Balasan untuk tiket: ${ctx.subject}`, tag: 'TIKET',
    paragraphs: ['Tim Nibie Cloud membalas tiketmu:', excerpt(ctx.message), 'Balas lewat dashboard supaya percakapannya tetap di satu tempat.'],
    button: 'Buka tiket',
  }, ctx.url);
}

function layout(c: Copy, buttonUrl: string): RenderedEmail {
  const font = "font-family:'Segoe UI',Arial,Helvetica,sans-serif;";
  const paras = c.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4b5563;${font}">${escapeHtml(p)}</p>`)
    .join('\n');
  const button = c.button
    ? `<p style="margin:8px 0 24px;"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 22px;border-radius:10px;${font}">${escapeHtml(c.button)}</a></p>`
    : '';
  const html = `<div style="margin:0;padding:24px 12px;background:#f3f4f6;${font}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;border-collapse:collapse;">
<tr><td style="background:#0d0e12;border-radius:16px 16px 0 0;padding:20px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="46" style="vertical-align:middle;"><img src="https://nibie.app/brand/nibie-mark.png" width="36" height="24" alt="" style="display:block;border:0;"></td><td style="vertical-align:middle;${font}color:#ffffff;font-size:16px;font-weight:700;">Nibie Cloud</td>
<td align="right" style="${font}color:#9ca3af;font-size:11px;font-weight:700;letter-spacing:1px;">${escapeHtml(c.tag)}</td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:28px 24px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;${font}">${escapeHtml(c.heading)}</h1>
${paras}
${button}<p style="margin:0;font-size:12px;color:#6b7280;${font}">Nibie Cloud &middot; https://cloud.nibie.app</p>
</td></tr></table></div>`;
  const text = [c.heading, '', ...c.paragraphs, ...(c.button ? ['', `${c.button}: ${buttonUrl}`] : []), '', 'Nibie Cloud - https://cloud.nibie.app'].join('\n');
  return { subject: c.subject, text, html };
}
