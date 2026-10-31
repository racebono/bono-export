use rusqlite::{Connection, params};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(std::env::args().nth(1).expect("output directory"));
    std::fs::create_dir_all(&dir)?;
    for (name, count) in [("small", 80), ("dictionary", 24000)] {
        let source = dir.join(format!("{name}-source.db"));
        if source.exists() { std::fs::remove_file(&source)?; }
        let mut db = Connection::open(&source)?;
        db.execute_batch("CREATE TABLE telemetry(id INTEGER PRIMARY KEY, x REAL, label TEXT, payload BLOB); PRAGMA user_version=17;")?;
        let tx = db.transaction()?;
        let mut state: u64 = 123456789;
        {
            let mut insert = tx.prepare("INSERT INTO telemetry VALUES(?1, ?2, ?3, ?4)")?;
            for i in 1..=count {
                let bytes: Vec<u8> = (0..96).map(|_| {
                    state ^= state << 13; state ^= state >> 7; state ^= state << 17;
                    state as u8
                }).collect();
                insert.execute(params![i, i as f64 / 8.0, format!("car {}", i % 40), bytes])?;
            }
        }
        tx.commit()?;
        drop(db);
        bono_export::export(&source, &dir.join(format!("{name}.db")), "CREATE INDEX telemetry_label ON telemetry(label);")?;
        std::fs::remove_file(source)?;
        println!("generated {name}.db ({count} rows)");
    }
    Ok(())
}
