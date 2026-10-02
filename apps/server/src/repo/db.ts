import type { Db } from '../db/client';

/** A transaction handle from `db.transaction()`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Repository functions accept either, so routes can compose them in one transaction. */
export type DbOrTx = Db | Tx;

/** A request that conflicts with the current state (e.g. approving an open chore). */
export class ConflictError extends Error {
  override name = 'ConflictError';
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** A request the rules refuse (the route answers 400 with the message). */
export class ValidationError extends Error {
  override name = 'ValidationError';
  constructor(readonly issues: unknown) {
    super('Invalid request');
  }
}
