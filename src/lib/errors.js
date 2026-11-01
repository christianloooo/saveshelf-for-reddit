/** Error with a stable machine-readable `code` so the UI can branch without string matching. */
export class LibraryError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'LibraryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
