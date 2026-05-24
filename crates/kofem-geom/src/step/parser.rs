use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct StepEntity {
    pub id: u64,
    pub type_name: String,
    pub args: Vec<Arg>,
}

#[derive(Debug, Clone)]
pub enum Arg {
    String(String),
    Real(f64),
    Integer(i64),
    Ref(u64),
    List(Vec<Arg>),
    Enum(String),
    Omitted,                                     // $
    Derived,                                     // *
    TypedValue { name: String, args: Vec<Arg> }, // TYPE_NAME(...)
}

pub type StepFile = HashMap<u64, StepEntity>;

#[derive(Debug, thiserror::Error)]
pub enum StepError {
    #[error("missing DATA section")]
    MissingDataSection,
    #[error("parse error: {0}")]
    ParseError(String),
}

pub fn parse(text: &str) -> Result<StepFile, StepError> {
    let data_pos = text.find("DATA;").ok_or(StepError::MissingDataSection)?;
    let rest = &text[data_pos + 5..];
    let endsec_pos = rest.find("ENDSEC;").ok_or(StepError::MissingDataSection)?;
    let data_text = &rest[..endsec_pos];

    let mut file = HashMap::new();
    for stmt in split_statements(data_text) {
        let stmt = stmt.trim();
        if stmt.is_empty() || !stmt.starts_with('#') {
            continue;
        }
        let entity = parse_entity(stmt)?;
        file.insert(entity.id, entity);
    }

    // Normalise all geometry coordinates to millimetres.  AP242 STEP files may
    // store geometry in any unit system (mm, inch, …).  We detect the unit by
    // locating the GLOBAL_UNIT_ASSIGNED_CONTEXT of the geometric representation
    // and checking whether its length-unit entity is a CONVERSION_BASED_UNIT
    // named "INCH"/"inch".  If so, every length-valued entity argument is
    // multiplied by 25.4 so the rest of the pipeline always works in mm.
    let scale = detect_length_scale_mm(&file);
    if (scale - 1.0).abs() > 1e-10 {
        apply_length_scale(&mut file, scale);
    }

    // Normalise all plane-angle values to radians.  AP242 STEP files may store
    // angles in degrees (CONVERSION_BASED_UNIT 'DEGREE') or in radians
    // (SI_UNIT .RADIAN.).  We normalise everything to radians here so that
    // downstream code can use angle values directly without calling to_radians().
    let angle_scale = detect_angle_scale_rad(&file);
    if (angle_scale - 1.0).abs() > 1e-10 {
        apply_angle_scale(&mut file, angle_scale);
    }

    Ok(file)
}

const INCH_TO_MM: f64 = 25.4;

/// Return the mm-per-unit scale factor encoded in the file's geometry context.
/// Returns 1.0 for millimetre files, 25.4 for inch files.
fn detect_length_scale_mm(file: &StepFile) -> f64 {
    for entity in file.values() {
        // We are looking for any entity that has a GLOBAL_UNIT_ASSIGNED_CONTEXT
        // TypedValue component (occurs in the GEOMETRIC_REPRESENTATION_CONTEXT
        // complex entity).
        let unit_ids: Vec<u64> = entity
            .args
            .iter()
            .find_map(|a| {
                if let Arg::TypedValue {
                    name,
                    args: tv_args,
                } = a
                {
                    if name == "GLOBAL_UNIT_ASSIGNED_CONTEXT" {
                        if let Some(Arg::List(ids)) = tv_args.first() {
                            return Some(
                                ids.iter()
                                    .filter_map(|a| {
                                        if let Arg::Ref(id) = a {
                                            Some(*id)
                                        } else {
                                            None
                                        }
                                    })
                                    .collect(),
                            );
                        }
                    }
                }
                None
            })
            .unwrap_or_default();

        if unit_ids.is_empty() {
            continue;
        }

        for uid in &unit_ids {
            if let Some(unit) = file.get(uid) {
                if is_inch_length_unit(unit) {
                    return INCH_TO_MM;
                }
            }
        }
    }
    1.0
}

/// Return true if `entity` is simultaneously a LENGTH_UNIT and a
/// CONVERSION_BASED_UNIT whose name is "INCH" (case-insensitive).
fn is_inch_length_unit(entity: &StepEntity) -> bool {
    let has_length_unit = entity
        .args
        .iter()
        .any(|a| matches!(a, Arg::TypedValue { name, .. } if name == "LENGTH_UNIT"));
    if !has_length_unit {
        return false;
    }
    entity.args.iter().any(|a| {
        if let Arg::TypedValue {
            name,
            args: tv_args,
        } = a
        {
            if name == "CONVERSION_BASED_UNIT" {
                if let Some(Arg::String(s)) = tv_args.first() {
                    return s.eq_ignore_ascii_case("INCH");
                }
            }
        }
        false
    })
}

/// Return the radians-per-unit scale factor for plane angles in this file.
/// Returns 1.0 for radian files, π/180 for degree files.
///
/// AP242 files that use SI_UNIT(.RADIAN.) store angles as-is (1.0 scale).
/// Files that declare CONVERSION_BASED_UNIT('DEGREE') need π/180 applied so
/// that the rest of the pipeline always works in radians.
fn detect_angle_scale_rad(file: &StepFile) -> f64 {
    for entity in file.values() {
        let unit_ids: Vec<u64> = entity
            .args
            .iter()
            .find_map(|a| {
                if let Arg::TypedValue {
                    name,
                    args: tv_args,
                } = a
                {
                    if name == "GLOBAL_UNIT_ASSIGNED_CONTEXT" {
                        if let Some(Arg::List(ids)) = tv_args.first() {
                            return Some(
                                ids.iter()
                                    .filter_map(|a| {
                                        if let Arg::Ref(id) = a {
                                            Some(*id)
                                        } else {
                                            None
                                        }
                                    })
                                    .collect(),
                            );
                        }
                    }
                }
                None
            })
            .unwrap_or_default();

        if unit_ids.is_empty() {
            continue;
        }

        for uid in &unit_ids {
            if let Some(unit) = file.get(uid) {
                if is_degree_plane_angle_unit(unit) {
                    return std::f64::consts::PI / 180.0;
                }
            }
        }
    }
    1.0
}

/// Return true if `entity` is simultaneously a PLANE_ANGLE_UNIT and a
/// CONVERSION_BASED_UNIT whose name is "DEGREE" (case-insensitive).
fn is_degree_plane_angle_unit(entity: &StepEntity) -> bool {
    let has_plane_angle = entity
        .args
        .iter()
        .any(|a| matches!(a, Arg::TypedValue { name, .. } if name == "PLANE_ANGLE_UNIT"));
    if !has_plane_angle {
        return false;
    }
    entity.args.iter().any(|a| {
        if let Arg::TypedValue {
            name,
            args: tv_args,
        } = a
        {
            if name == "CONVERSION_BASED_UNIT" {
                if let Some(Arg::String(s)) = tv_args.first() {
                    return s.eq_ignore_ascii_case("DEGREE");
                }
            }
        }
        false
    })
}

/// Scale every plane-angle-valued entity argument by `scale` (π/180 for degree→radian).
/// Entities affected:
/// * `CONICAL_SURFACE` — semi_angle at arg[3]
fn apply_angle_scale(file: &mut StepFile, scale: f64) {
    for entity in file.values_mut() {
        if entity.type_name == "CONICAL_SURFACE" {
            if let Some(arg) = entity.args.get_mut(3) {
                scale_real_arg(arg, scale);
            }
        }
    }
}

/// Scale every length-valued entity argument by `scale` (25.4 for inch→mm).
/// Entities affected:
/// * `CARTESIAN_POINT`  — coordinate list
/// * `CIRCLE` / `CYLINDRICAL_SURFACE` / `SPHERICAL_SURFACE` / `CONICAL_SURFACE`
///   — radius at arg[2]
/// * `TOROIDAL_SURFACE` — major_radius at arg[2], minor_radius at arg[3]
/// * `ELLIPSE`          — semi_axis_1 at arg[2], semi_axis_2 at arg[3]
///
/// Knot vectors (B-spline parametric domain) are intentionally left untouched;
/// control-point positions are covered via CARTESIAN_POINT above.
fn apply_length_scale(file: &mut StepFile, scale: f64) {
    for entity in file.values_mut() {
        match entity.type_name.as_str() {
            "CARTESIAN_POINT" => {
                if let Some(Arg::List(coords)) = entity.args.get_mut(1) {
                    for c in coords.iter_mut() {
                        scale_real_arg(c, scale);
                    }
                }
            }
            "CIRCLE" | "CYLINDRICAL_SURFACE" | "SPHERICAL_SURFACE" | "CONICAL_SURFACE" => {
                if let Some(arg) = entity.args.get_mut(2) {
                    scale_real_arg(arg, scale);
                }
            }
            "TOROIDAL_SURFACE" | "ELLIPSE" => {
                for i in [2usize, 3usize] {
                    if let Some(arg) = entity.args.get_mut(i) {
                        scale_real_arg(arg, scale);
                    }
                }
            }
            _ => {}
        }
    }
}

fn scale_real_arg(arg: &mut Arg, scale: f64) {
    match arg {
        Arg::Real(v) => *v *= scale,
        Arg::Integer(v) => *arg = Arg::Real(*v as f64 * scale),
        _ => {}
    }
}

/// Split the DATA section into individual statements on `;`, respecting string literals.
fn split_statements(text: &str) -> Vec<String> {
    let mut stmts = Vec::new();
    let mut buf = String::new();
    let mut in_str = false;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if in_str {
            if c == '\'' {
                if i + 1 < chars.len() && chars[i + 1] == '\'' {
                    // Escaped apostrophe ''
                    buf.push_str("''");
                    i += 2;
                    continue;
                }
                in_str = false;
                buf.push('\'');
            } else {
                buf.push(c);
            }
        } else if c == '\'' {
            in_str = true;
            buf.push('\'');
        } else if c == '\n' || c == '\r' {
            buf.push(' ');
        } else if c == ';' {
            let s = buf.trim().to_string();
            if !s.is_empty() {
                stmts.push(s);
            }
            buf.clear();
        } else {
            buf.push(c);
        }
        i += 1;
    }
    stmts
}

fn parse_entity(stmt: &str) -> Result<StepEntity, StepError> {
    let err = || StepError::ParseError(stmt[..stmt.len().min(100)].to_string());

    let eq = stmt.find('=').ok_or_else(err)?;
    let id: u64 = stmt[1..eq].trim().parse().map_err(|_| err())?;

    let rest = stmt[eq + 1..].trim();
    let paren = rest.find('(').ok_or_else(err)?;
    let type_name = rest[..paren].trim().to_string();

    let args_outer = rest[paren..].trim();
    if !args_outer.ends_with(')') {
        return Err(err());
    }
    let inner = &args_outer[1..args_outer.len() - 1];

    // Complex entity instance: #id=(TYPE1(args1)TYPE2(args2)...)
    // Detected when type_name is empty and inner starts with an uppercase letter.
    if type_name.is_empty() {
        let trimmed = inner.trim_start();
        if trimmed.starts_with(|c: char| c.is_ascii_uppercase()) {
            let args = parse_complex_components(trimmed).map_err(|_| err())?;
            return Ok(StepEntity {
                id,
                type_name: String::new(),
                args,
            });
        }
    }

    let args = parse_arg_list(inner).map_err(|_| err())?;
    Ok(StepEntity {
        id,
        type_name,
        args,
    })
}

/// Parse a complex entity body: `TYPE1(args1)TYPE2(args2)...` into a Vec of TypedValue args.
fn parse_complex_components(s: &str) -> Result<Vec<Arg>, StepError> {
    let mut result = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        // Read identifier
        let name_start = i;
        while i < chars.len()
            && (chars[i].is_ascii_uppercase() || chars[i].is_ascii_digit() || chars[i] == '_')
        {
            i += 1;
        }
        let name: String = chars[name_start..i].iter().collect();
        if name.is_empty() {
            return Err(StepError::ParseError(format!(
                "expected type name in complex entity near '{}'",
                chars[i..].iter().take(20).collect::<String>()
            )));
        }
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() || chars[i] != '(' {
            return Err(StepError::ParseError(format!(
                "expected '(' after '{name}'"
            )));
        }
        // Find matching ')'
        let arg_start = i;
        let mut depth = 0i32;
        let mut in_str = false;
        while i < chars.len() {
            let c = chars[i];
            if in_str {
                if c == '\'' {
                    if i + 1 < chars.len() && chars[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    in_str = false;
                }
            } else if c == '\'' {
                in_str = true;
            } else if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth -= 1;
                if depth == 0 {
                    i += 1;
                    break;
                }
            }
            i += 1;
        }
        let arg_str: String = chars[arg_start..i].iter().collect();
        let inner = &arg_str[1..arg_str.len() - 1];
        let sub_args = parse_arg_list(inner)?;
        result.push(Arg::TypedValue {
            name,
            args: sub_args,
        });
    }

    Ok(result)
}

fn parse_arg_list(s: &str) -> Result<Vec<Arg>, StepError> {
    let mut args = Vec::new();
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut start = 0;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;

    while i <= chars.len() {
        let split = if i == chars.len() {
            true
        } else {
            let c = chars[i];
            if in_str {
                if c == '\'' {
                    if i + 1 < chars.len() && chars[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    in_str = false;
                }
                false
            } else {
                match c {
                    '\'' => {
                        in_str = true;
                        false
                    }
                    '(' => {
                        depth += 1;
                        false
                    }
                    ')' => {
                        depth -= 1;
                        false
                    }
                    ',' if depth == 0 => true,
                    _ => false,
                }
            }
        };

        if split {
            let arg_str: String = chars[start..i].iter().collect();
            args.push(parse_arg(arg_str.trim())?);
            start = i + 1;
        }
        i += 1;
    }

    Ok(args)
}

fn parse_arg(s: &str) -> Result<Arg, StepError> {
    let err = || StepError::ParseError(format!("cannot parse arg: '{s}'"));

    match s {
        "" | "$" => return Ok(Arg::Omitted),
        "*" => return Ok(Arg::Derived),
        _ => {}
    }

    if let Some(stripped) = s.strip_prefix('#') {
        let id: u64 = stripped.parse().map_err(|_| err())?;
        return Ok(Arg::Ref(id));
    }

    if s.starts_with('\'') && s.ends_with('\'') {
        let inner = &s[1..s.len() - 1];
        return Ok(Arg::String(inner.replace("''", "'")));
    }

    if s.starts_with('.') && s.ends_with('.') {
        return Ok(Arg::Enum(s[1..s.len() - 1].to_string()));
    }

    if s.starts_with('(') && s.ends_with(')') {
        let inner = &s[1..s.len() - 1];
        return Ok(Arg::List(parse_arg_list(inner)?));
    }

    // Typed parameter value: TYPE_NAME(...)
    if let Some(paren_pos) = s.find('(') {
        let name_candidate = &s[..paren_pos];
        if !name_candidate.is_empty()
            && s.ends_with(')')
            && name_candidate
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            && name_candidate.starts_with(|c: char| c.is_ascii_uppercase())
        {
            let inner = &s[paren_pos + 1..s.len() - 1];
            return Ok(Arg::TypedValue {
                name: name_candidate.to_string(),
                args: parse_arg_list(inner)?,
            });
        }
    }

    // Try integer first (no dot or E), then float
    if !s.contains('.') && !s.to_ascii_uppercase().contains('E') {
        if let Ok(v) = s.parse::<i64>() {
            return Ok(Arg::Integer(v));
        }
    }
    if let Ok(v) = s.parse::<f64>() {
        return Ok(Arg::Real(v));
    }

    Err(err())
}
