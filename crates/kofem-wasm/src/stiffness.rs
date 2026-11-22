// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! A model's assembled stiffness matrix, lent to the solve that runs on it
//! (KOF-457). An uncoupled solve eliminates its supports in the matrix itself
//! rather than in a copy, so the module never holds two; when the run finishes
//! or is freed, the matrix goes back to the model exactly as assembled, for
//! support reactions and the next load case.

use std::cell::RefCell;
use std::rc::Rc;

use kofem_fem::{CsrMatrix, PreparedStatic};
use wasm_bindgen::JsError;

enum Held {
    NotAssembled,
    Assembled(CsrMatrix),
    /// Lent to a run, which gives it back when it finishes or is freed.
    InSolve,
}

/// Where a model keeps its assembled matrix.
pub(crate) struct Stiffness(Rc<RefCell<Held>>);

impl Stiffness {
    pub(crate) fn new() -> Self {
        Self(Rc::new(RefCell::new(Held::NotAssembled)))
    }

    pub(crate) fn set(&self, matrix: CsrMatrix) {
        *self.0.borrow_mut() = Held::Assembled(matrix);
    }

    fn missing(held: &Held, caller: &str) -> JsError {
        match held {
            Held::InSolve => JsError::new(&format!(
                "a solve is running on this model's stiffness matrix; finish or free it before \
                 {caller}()"
            )),
            Held::NotAssembled | Held::Assembled(_) => {
                JsError::new(&format!("assemble() must be called before {caller}()"))
            }
        }
    }

    /// `work` on the assembled matrix, for `caller` (named in the error).
    ///
    /// # Errors
    /// No matrix assembled, or one lent to a running solve; else `work`'s.
    pub(crate) fn with<T>(
        &self,
        caller: &str,
        work: impl FnOnce(&CsrMatrix) -> Result<T, JsError>,
    ) -> Result<T, JsError> {
        match &*self.0.borrow() {
            Held::Assembled(matrix) => work(matrix),
            held => Err(Self::missing(held, caller)),
        }
    }

    /// The matrix, lent to a solve for `caller`; give it back through a
    /// [`Loan`], or with [`Stiffness::set`] if the solve could not be set up.
    ///
    /// # Errors
    /// No matrix assembled, or one lent to a running solve already.
    pub(crate) fn lend(&self, caller: &str) -> Result<CsrMatrix, JsError> {
        let mut held = self.0.borrow_mut();
        match std::mem::replace(&mut *held, Held::InSolve) {
            Held::Assembled(matrix) => Ok(matrix),
            other => {
                let error = Self::missing(&other, caller);
                *held = other;
                Err(error)
            }
        }
    }

    /// A loan of the matrix inside `prepared` (from [`Stiffness::lend`]).
    pub(crate) fn loan(&self, prepared: PreparedStatic) -> Loan {
        Loan {
            prepared: Some(prepared),
            home: Some(Rc::clone(&self.0)),
        }
    }
}

/// A run's prepared system. When it holds a model's matrix on loan, dropping
/// it gives the matrix back.
pub(crate) struct Loan {
    prepared: Option<PreparedStatic>,
    home: Option<Rc<RefCell<Held>>>,
}

impl Loan {
    /// A system of the run's own (a coupled, tied or mixed reduction).
    pub(crate) fn owned(prepared: PreparedStatic) -> Self {
        Self {
            prepared: Some(prepared),
            home: None,
        }
    }

    fn gone() -> JsError {
        JsError::new("the solve has finished; its system is gone")
    }

    pub(crate) fn get(&self) -> Result<&PreparedStatic, JsError> {
        self.prepared.as_ref().ok_or_else(Self::gone)
    }

    pub(crate) fn get_mut(&mut self) -> Result<&mut PreparedStatic, JsError> {
        self.prepared.as_mut().ok_or_else(Self::gone)
    }
}

impl Drop for Loan {
    fn drop(&mut self) {
        if let (Some(prepared), Some(home)) = (self.prepared.take(), self.home.take()) {
            // A loan is made only of an uncoupled system, whose matrix comes
            // back; nothing to give back otherwise, and the model then says
            // it needs assembling again.
            *home.borrow_mut() = match prepared.into_stiffness() {
                Ok(matrix) => Held::Assembled(matrix),
                Err(_) => Held::NotAssembled,
            };
        }
    }
}
