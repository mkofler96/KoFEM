// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Every catalog's it text, one chunk fetched by ../loadLocale.ts.
import.meta.glob("../messages/*.ts", { query: "?locale=it", eager: true });
