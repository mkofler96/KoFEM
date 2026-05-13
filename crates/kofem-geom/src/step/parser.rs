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
    Ok(file)
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
