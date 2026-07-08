fn greeting() -> String {
    format!("Hello from {}", env!("CARGO_PKG_NAME"))
}

fn main() -> anyhow::Result<()> {
    use std::io::Write;

    writeln!(std::io::stdout().lock(), "{}", greeting())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn greeting_names_package() {
        assert_eq!(
            super::greeting(),
            format!("Hello from {}", env!("CARGO_PKG_NAME"))
        );
    }
}
