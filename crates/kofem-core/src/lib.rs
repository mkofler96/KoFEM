#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod boundary;
pub mod elements;
pub mod material;
pub mod mesh;
pub mod property;
pub mod solver;

pub use mesh::Mesh;
pub use solver::LinearStaticSolver;
