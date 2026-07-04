fn greeting() -> String {
    format!("Hello from {}", env!("CARGO_PKG_NAME"))
}

fn main() {
    println!("{}", greeting());
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
