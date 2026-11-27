export class OlatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OlatError';
  }
}

/** Thrown when the user's credentials are rejected by OpenOLAT. */
export class OlatAuthError extends OlatError {
  constructor(message = 'OpenOLAT hat die Anmeldedaten abgelehnt.') {
    super(message, 401);
    this.name = 'OlatAuthError';
  }
}

/** Thrown when an action would change data on OpenOLAT. The client is read-only by design. */
export class ReadOnlyViolation extends OlatError {
  constructor(what: string) {
    super(`Blockiert (read-only): ${what}`, 403);
    this.name = 'ReadOnlyViolation';
  }
}

export class NotFoundError extends OlatError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}
