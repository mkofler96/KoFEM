// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registry of topology-optimization benchmark cases (KOF-234). Each
// default-exports a descriptor:
//   { name, description, run(optimize) }
// where run() returns { metrics:[{label,value}], checks:[{label,pass}], layout? }.

import mbbBeam from "./mbb-beam.mjs";
import cantilever3d from "./cantilever-3d.mjs";
import cantileverMeshIndependence from "./cantilever-mesh-independence.mjs";

export default [mbbBeam, cantilever3d, cantileverMeshIndependence];
