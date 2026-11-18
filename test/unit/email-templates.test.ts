import { describe, expect, it } from 'vitest';
import { escapeHtml, renderEmail, renderWaitlistConfirm, type EmailKind } from '../../src/modules/billing/email-templates.js';

const ctx = {
  instanceName: 'Bot <script>alert(1)</script> "x"',
  periodEnd: new Date('2026-12-31T05:00:00.000Z'),
  graceEndsAt: new Date('2027-01-03T05:00:00.000Z'),
  retentionEndsAt: new Date('2027-02-02T05:00:00.000Z'),
  amountIdr: 50_000,
  dashboardUrl: 'https://cloud.example.test/dashboard/instances',
};

const KINDS: EmailKind[] = ['payment_received', 'renewal_7d', 'renewal_3d', 'renewal_1d', 'grace_started', 'suspension_warning', 'suspended', 'deletion_warning', 'deleted'];

describe('renderEmail', () => {
  it.each(KINDS)('%s: Indonesian, escaped, no raw HTML from the instance name', (kind) => {
    const m = renderEmail(kind, ctx);
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.subject).not.toContain('Bot');
    expect(m.subject).toMatch(/Nibie Cloud$/);
    expect(m.text.length).toBeGreaterThan(20);
    expect(m.html).toContain('Nibie Cloud');
  });

  it('formats dates in Jakarta time', () => {
    const m = renderEmail('renewal_7d', ctx);
    expect(m.text).toContain('WIB');
    expect(m.text).toMatch(/31 Desember 2026/);
    expect(m.text).toContain('12.00'); // 05:00 UTC is 12:00 WIB
  });

  it('payment_received shows the amount in rupiah', () => {
    expect(renderEmail('payment_received', ctx).text).toContain('Rp 50.000');
  });

  it('links to the dashboard only where an action is expected', () => {
    expect(renderEmail('renewal_1d', ctx).html).toContain('href="https://cloud.example.test/dashboard/instances"');
    expect(renderEmail('deleted', ctx).html).not.toContain('href=');
  });

  it('escapes the dashboard URL attribute', () => {
    expect(renderEmail('renewal_1d', { ...ctx, dashboardUrl: 'https://x.test/"onmouseover="a' }).html).not.toContain('"onmouseover');
  });

  it('never contains payment internals', () => {
    for (const k of KINDS) expect(JSON.stringify(renderEmail(k, ctx))).not.toMatch(/reference|merchant|signature|apiKey/i);
  });
});

describe('renderWaitlistConfirm', () => {
  it('links to the confirmation page and carries no text typed on the form', () => {
    const m = renderWaitlistConfirm({ confirmUrl: 'https://cloud.example.test/daftar-tunggu/konfirmasi#t=abc', validUntil: ctx.periodEnd });
    expect(m.html).toContain('href="https://cloud.example.test/daftar-tunggu/konfirmasi#t=abc"');
    expect(m.text).toMatch(/^Konfirmasi email Anda\n\nHalo,\n/);
    expect(m.text).toContain('WIB');
  });
});

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
