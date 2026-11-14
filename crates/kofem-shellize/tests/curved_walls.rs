// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Curved thin walls (KOF-312): the planar wall pass pairs only opposite flat
//! faces, so a tube or a sheet-metal bend has no wall there. The curved pass
//! measures them by casting rays through the material.

#![allow(
    clippy::expect_used,
    clippy::cast_precision_loss,
    reason = "test fixtures: a fixture that fails to build should abort the test, and grid \
              indices are small"
)]

mod support;

use kofem_shellize::geometry::tet_mesh_boundary;
use kofem_shellize::{detect_curved_walls, ShellizeMesh};
use support::{boxes, BoxSpec};

/// Face ids of [`tube`].
const OUTER: i32 = 1;
const INNER: i32 = 2;

/// Six tets per grid cell (Kuhn), corners numbered radial + 2·around + 4·along.
const KUHN: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

/// Grid of a tube or rod: `segments` around, `layers` through the wall,
/// `rings` along z. A rod (`r_inner == 0`) has one axis node per ring.
struct Grid {
    r_inner: f64,
    r_outer: f64,
    length: f64,
    segments: usize,
    layers: usize,
    rings: usize,
}

impl Grid {
    fn solid(&self) -> bool {
        self.r_inner == 0.0
    }

    fn ring_nodes(&self) -> usize {
        if self.solid() {
            1 + self.layers * self.segments
        } else {
            (self.layers + 1) * self.segments
        }
    }

    fn node(&self, ring: usize, layer: usize, segment: usize) -> usize {
        let segment = segment % self.segments;
        let first = ring * self.ring_nodes();
        match (self.solid(), layer) {
            (true, 0) => first,
            (true, _) => first + 1 + (layer - 1) * self.segments + segment,
            (false, _) => first + layer * self.segments + segment,
        }
    }

    fn vertices(&self) -> Vec<f64> {
        let mut vertices = Vec::new();
        for ring in 0..=self.rings {
            let height = self.length * ring as f64 / self.rings as f64;
            if self.solid() {
                vertices.extend([0.0, 0.0, height]);
            }
            for layer in usize::from(self.solid())..=self.layers {
                let radius = self.r_inner
                    + (self.r_outer - self.r_inner) * layer as f64 / self.layers as f64;
                for segment in 0..self.segments {
                    let angle = std::f64::consts::TAU * segment as f64 / self.segments as f64;
                    vertices.extend([radius * angle.cos(), radius * angle.sin(), height]);
                }
            }
        }
        vertices
    }

    fn tets(&self) -> Vec<[usize; 4]> {
        let mut tets = Vec::new();
        for ring in 0..self.rings {
            for layer in 0..self.layers {
                for segment in 0..self.segments {
                    let corner = |index: usize| {
                        self.node(
                            ring + index / 4,
                            layer + index % 2,
                            segment + (index / 2) % 2,
                        )
                    };
                    if self.solid() && layer == 0 {
                        // A wedge from the axis: corners 0, 2, 4, 6 are the axis node.
                        let [axis, first, second] = [0, 1, 3].map(corner);
                        let [top_axis, top_first, top_second] = [4, 5, 7].map(corner);
                        tets.extend([
                            [axis, first, second, top_second],
                            [axis, first, top_second, top_first],
                            [axis, top_first, top_second, top_axis],
                        ]);
                    } else {
                        tets.extend(KUHN.map(|tet| tet.map(corner)));
                    }
                }
            }
        }
        tets
    }

    /// Face id of a boundary triangle (see [`tube`]).
    fn face(&self, corners: [[f64; 3]; 3]) -> i32 {
        if corners.iter().all(|corner| corner[2].abs() < 1e-9) {
            3
        } else if corners
            .iter()
            .all(|corner| (corner[2] - self.length).abs() < 1e-9)
        {
            4
        } else if corners
            .iter()
            .all(|corner| (corner[0].hypot(corner[1]) - self.r_outer).abs() < 1e-9)
        {
            OUTER
        } else {
            INNER
        }
    }
}

fn indices(groups: &[impl AsRef<[usize]>]) -> Vec<u32> {
    groups
        .iter()
        .flat_map(|group| group.as_ref().iter().copied())
        .map(|vertex| u32::try_from(vertex).expect("small mesh"))
        .collect()
}

/// A tube (or, with `r_inner == 0`, a solid rod) along z as a structured tet
/// mesh, body 1. Faces: 1 outer cylinder, 2 bore, 3 end z = 0, 4 end z = length.
fn tube(grid: &Grid) -> ShellizeMesh {
    let vertices = grid.vertices();
    let tets = grid.tets();
    let surface = tet_mesh_boundary(&tets);
    let point = |vertex: usize| -> [f64; 3] {
        [
            vertices[3 * vertex],
            vertices[3 * vertex + 1],
            vertices[3 * vertex + 2],
        ]
    };
    let faces: Vec<i32> = surface
        .iter()
        .map(|tri| grid.face(tri.map(point)))
        .collect();
    ShellizeMesh::new(
        &vertices,
        &indices(&tets),
        &vec![1; tets.len()],
        &indices(&surface),
        &faces,
    )
    .expect("tube mesh")
}

fn grid(r_inner: f64, r_outer: f64, segments: usize, layers: usize) -> Grid {
    Grid {
        r_inner,
        r_outer,
        length: 60.0,
        segments,
        layers,
        rings: 12,
    }
}

/// A 2 mm tube wall is found, about 2 mm thick, on body 1.
#[test]
fn thin_tube_is_a_curved_wall() {
    let mesh = tube(&grid(20.0, 22.0, 64, 1));
    let walls = detect_curved_walls(&mesh, 15.0);
    assert!(!walls.is_empty(), "no curved wall found");
    for wall in &walls {
        assert_eq!(wall.body, 1);
        assert!([OUTER, INNER].contains(&wall.face), "{wall:?}");
        assert!((wall.thickness - 2.0).abs() < 0.05, "{wall:?}");
    }
}

/// Inner and outer cylinder are one wall: reported once.
#[test]
fn tube_wall_is_reported_once() {
    let mesh = tube(&grid(20.0, 22.0, 64, 1));
    assert_eq!(detect_curved_walls(&mesh, 15.0).len(), 1);
}

/// A 20 mm wall is thicker than the 15 mm limit: no wall.
#[test]
fn thick_tube_is_no_wall() {
    let mesh = tube(&grid(5.0, 25.0, 48, 4));
    assert_eq!(detect_curved_walls(&mesh, 15.0), Vec::new());
}

/// A solid rod has one curved face and nothing opposite it: no wall.
#[test]
fn solid_rod_is_no_wall() {
    let mesh = tube(&grid(0.0, 4.0, 32, 2));
    assert_eq!(detect_curved_walls(&mesh, 15.0), Vec::new());
}

/// A flat plate is the planar pass's wall, not a curved one.
#[test]
fn flat_plate_is_no_curved_wall() {
    let mesh = boxes(&[BoxSpec {
        min: [0.0; 3],
        max: [40.0, 20.0, 2.0],
        cells: [8, 4, 2],
        body: 1,
        face_base: 0,
    }]);
    assert_eq!(detect_curved_walls(&mesh, 15.0), Vec::new());
}
