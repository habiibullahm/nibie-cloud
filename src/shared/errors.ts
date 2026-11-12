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
