// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Every catalog's es text, one chunk fetched by ../loadLocale.ts.
import.meta.glob("../messages/*.ts", { query: "?locale=es", eager: true });
