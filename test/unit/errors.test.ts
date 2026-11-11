import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, RuntimeUnavailableError, ValidationError } from '../../src/shared/errors.js';

describe('AppError hierarchy', () => {
  it('maps to HTTP statuses', () => {
    expect(new NotFoundError('x').status).toBe(404);
    expect(new ConflictError('x').status).toBe(409);
    expect(new ValidationError('x').status).toBe(400);
    expect(new RuntimeUnavailableError('x').status).toBe(503);
  });
});
