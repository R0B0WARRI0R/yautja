import { ulid } from 'ulid';

export function generateTraceId(): string {
  return `tr_${ulid()}`;
}

export function generateOperationId(): string {
  return `op_${ulid()}`;
}

export function generateIdempotencyKey(): string {
  return `ik_${ulid()}`;
}