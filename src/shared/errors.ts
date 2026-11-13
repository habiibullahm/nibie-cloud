export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'validation_error');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'not_found');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'conflict');
  }
}

export class RuntimeUnavailableError extends AppError {
  constructor(message = 'Runtime is temporarily unavailable') {
    super(message, 503, 'runtime_unavailable');
  }
}

/** An existing tenant volume has no disk quota while quotas are enforced; it must never run unbounded. */
export class VolumeQuotaMissingError extends AppError {
  constructor(message = 'Tenant volume has no disk quota') {
    super(message, 409, 'volume_quota_missing');
  }
}

/**
 * The tenant network does not carry the bridge name the host egress ruleset matches (an old network, or
 * a name collision), so enforcing the policy is impossible. Docker cannot rename a bridge in place:
 * delete and reprovision.
 */
export class NetworkPolicyMissingError extends AppError {
  constructor(message = 'Tenant network does not match the egress policy') {
    super(message, 409, 'network_policy_missing');
  }
}

/** One opaque error for every authentication failure: no detail from the token or the library. */
export class UnauthorizedError extends AppError {
  constructor() {
    super('Unauthorized', 401, 'unauthorized');
  }
}

/** The identity provider's key set could not be fetched: our side or theirs, not the caller's token. */
export class AuthUnavailableError extends AppError {
  constructor() {
    super('Authentication is temporarily unavailable', 503, 'auth_unavailable');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, code = 'forbidden') {
    super(message, 403, code);
  }
}

export class InstanceLimitError extends AppError {
  constructor() {
    super('Instance limit reached for this account', 409, 'instance_limit_reached');
  }
}

/** Redis cannot be reached, so the operation was not accepted and nothing changed. */
export class QueueUnavailableError extends AppError {
  constructor() {
    super('Job queue is temporarily unavailable', 503, 'queue_unavailable');
  }
}
