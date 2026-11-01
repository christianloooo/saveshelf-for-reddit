// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
/** Error with a stable machine-readable `code` so the UI can branch without string matching. */
export class LibraryError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'LibraryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
