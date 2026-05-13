pub mod parser;
pub mod topology;
pub use parser::{parse, Arg, StepEntity, StepError, StepFile};
pub use topology::{BRep, TopoEdge, TopoFace, TopologyError};
