import { Prisma } from '@prisma/client';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { failure } from './api-response';
import { DomainError } from './errors';
import { logger } from './logger';
import { ValidationError } from './validation';

const log = logger('http');

// Postgres unique / foreign-key / check violations.
const INTEGRITY_SQLSTATES = new Set(['23505', '23503', '23514']);
const INTEGRITY_PRISMA_CODES = new Set(['P2002', 'P2003', 'P2004']);

/** True for a DB constraint violation, from a Prisma query or a raw one. */
export function isIntegrityViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (INTEGRITY_PRISMA_CODES.has(err.code)) return true;
    const sqlState = (err.meta as { code?: string } | undefined)?.code;
    return err.code === 'P2010' && !!sqlState && INTEGRITY_SQLSTATES.has(sqlState);
  }
  return false;
}

/**
 * Renders every error as an ApiResponse. Mirrors the Java GlobalExceptionHandler:
 * domain errors carry their status; constraint violations are 409 without
 * echoing DB details; anything unexpected is logged and a generic 500.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof ValidationError) {
    res.status(400).json(failure(err.message, err.fieldErrors));
    return;
  }
  if (err instanceof DomainError) {
    res.status(err.status).json(failure(err.message));
    return;
  }
  if (isIntegrityViolation(err)) {
    res.status(409).json(failure('The request conflicts with existing data'));
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json(failure('The uploaded file is too large'));
    } else {
      res.status(400).json(failure("Send the file as multipart/form-data in a part named 'file'"));
    }
    return;
  }
  // body-parser: malformed JSON, or a body over the limit.
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json(failure('Malformed JSON request body'));
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json(failure('The request body is too large'));
    return;
  }

  log.error(`Unhandled error while processing ${req.method} ${req.originalUrl}`, err);
  res.status(500).json(failure('An unexpected error occurred'));
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(failure(`No endpoint ${req.method} ${req.path}`));
};
