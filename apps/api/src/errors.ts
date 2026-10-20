/** Something that isn't the signed-in person's, or doesn't exist. Answered with 403. */
export class NotFound extends Error {}
/** The request clashes with the current state. Answered with 409 and the message. */
export class Conflict extends Error {}
/** The request itself is wrong (a missing field). Answered with 400 and the message. */
export class BadRequest extends Error {
  readonly statusCode = 400;
}
