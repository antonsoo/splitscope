// Compile as an example in the pinned livesplit-core checkout. No copied parser.
use livesplit_core::{Time, TimingMethod, analysis::sum_of_segments, run::parser::livesplit};
use serde_json::{Value, json};
use std::io::{self, BufRead};

fn dual(time: Time) -> Value {
    json!({"realTime": time.real_time.map(|t| t.total_seconds()),
           "gameTime": time.game_time.map(|t| t.total_seconds())})
}

fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = &input["id"];
        match livesplit::parse(input["xml"].as_str().unwrap()) {
            Err(error) => println!("{}", json!({"id": id, "error": error.to_string()})),
            Ok(run) => {
                let attempts: Vec<_> = run.attempt_history().iter().map(|a| json!({
                    "id": a.index(), "time": dual(a.time()),
                    "pauseTime": a.pause_time().map(|t| t.total_seconds()),
                })).collect();
                let segments: Vec<_> = run.segments().iter().map(|s| {
                    let history: Vec<_> = s.segment_history().iter().map(|(id, time)|
                        json!({"attemptId": id, "time": dual(*time)})).collect();
                    json!({"name": s.name(), "personalBest": dual(s.comparison("Personal Best")),
                           "bestSegmentTime": dual(s.best_segment_time()), "history": history})
                }).collect();
                let totals: Vec<_> = [TimingMethod::RealTime, TimingMethod::GameTime].iter().map(|m| {
                    let mut predictions = vec![None; run.len() + 1];
                    sum_of_segments::best::calculate(run.segments(), &mut predictions, false, false, *m)
                        .map(|t| t.total_seconds())
                }).collect();
                println!("{}", json!({"id": id, "run": {
                    "gameName": run.game_name(), "categoryName": run.category_name(),
                    "offset": run.offset().total_seconds(), "attemptCount": run.attempt_count(),
                    "attempts": attempts, "segments": segments,
                }, "totals": totals}));
            }
        }
    }
}
