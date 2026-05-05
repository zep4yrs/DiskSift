use pinkbin_scaffold::Scaffold;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: pinkbin-scaffold-lint <file.toml> [...]");
        std::process::exit(2);
    }

    let mut errors = 0usize;
    for path in args {
        let text = std::fs::read_to_string(&path)?;
        match toml::from_str::<Scaffold>(&text) {
            Ok(s) => {
                if s.scopes.is_empty() {
                    eprintln!("WARN: {} has no scopes", path);
                }
                println!("ok: {} ({})", path, s.id);
            }
            Err(e) => {
                eprintln!("FAIL: {}: {}", path, e);
                errors += 1;
            }
        }
    }
    if errors > 0 {
        std::process::exit(1);
    }
    Ok(())
}
