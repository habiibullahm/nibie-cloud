import { describe, expect, it } from 'vitest';
import { assertAdminAllowed, mutating } from '../../src/http/admin-routes.js';
import { ForbiddenError } from '../../src/shared/errors.js';

const allowed = new Set(['boss@nibie.app']);
const claims = (email: string, aal: 'aal1' | 'aal2') => ({ userId: 'u', email, aal });

describe('admin authorization rules', () => {
  it('treats every method that can change data as mutating', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) expect(mutating(m), m).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(mutating(m), m).toBe(false);
  });

  it('lets an allowlisted admin read at aal1', () => {
    expect(() => assertAdminAllowed(claims('boss@nibie.app', 'aal1'), 'GET', allowed)).not.toThrow();
  });

  it('refuses an email that is not on the allowlist, for reads and writes alike', () => {
    for (const m of ['GET', 'POST']) {
      expect(() => assertAdminAllowed(claims('stranger@example.test', 'aal2'), m, allowed)).toThrow(ForbiddenError);
    }
  });

  it('matches the allowlist case-insensitively', () => {
    expect(() => assertAdminAllowed(claims('BOSS@Nibie.App', 'aal1'), 'GET', allowed)).not.toThrow();
  });

  it('refuses a write at aal1 with mfa_required, and allows it at aal2', () => {
    const err = (() => { try { assertAdminAllowed(claims('boss@nibie.app', 'aal1'), 'POST', allowed); } catch (e) { return e as ForbiddenError; } return null; })();
    expect(err?.code).toBe('mfa_required');
    expect(err?.status).toBe(403);
    expect(() => assertAdminAllowed(claims('boss@nibie.app', 'aal2'), 'POST', allowed)).not.toThrow();
  });

  it('checks the allowlist before the second factor, so a stranger never learns about MFA', () => {
    const err = (() => { try { assertAdminAllowed(claims('stranger@example.test', 'aal1'), 'POST', allowed); } catch (e) { return e as ForbiddenError; } return null; })();
    expect(err?.code).toBe('forbidden');
  });

  it('refuses everybody when the allowlist is empty', () => {
    expect(() => assertAdminAllowed(claims('boss@nibie.app', 'aal2'), 'GET', new Set())).toThrow(ForbiddenError);
  });
});
