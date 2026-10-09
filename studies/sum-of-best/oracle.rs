// Run as an example in the pinned livesplit-core checkout. No copied algorithm.
use livesplit_core::{TimingMethod, analysis::sum_of_segments, run::parser::livesplit};
use serde_json::{Value, json};
use std::io::{self, BufRead};

fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = &input["id"];
        match livesplit::parse(input["xml"].as_str().unwrap()) {
            Err(error) => println!("{}", json!({"id": id, "error": error.to_string()})),
            Ok(run) => {
                let mut results = Vec::new();
                for method in [TimingMethod::RealTime, TimingMethod::GameTime] {
                    let mut predictions = vec![None; run.len() + 1];
                    let total = sum_of_segments::best::calculate(
                        run.segments(), &mut predictions, false, false, method,
                    );
                    let boundaries: Vec<_> = predictions.iter().map(|prediction| {
                        prediction.map(|p| json!({"seconds": p.time.total_seconds(),
                                                 "predecessor": p.predecessor}))
                    }).collect();
                    results.push(json!({"method": format!("{method:?}"),
                        "total": total.map(|t| t.total_seconds()), "boundaries": boundaries}));
                }
                println!("{}", json!({"id": id, "results": results}));
            }
        }
    }
}
