// Compiled inside pinned upstream livesplit-core. No Splitscope code is used.
use livesplit_core::{
    AtomicDateTime, Run, Segment, Time, TimeSpan,
    run::{parser::livesplit, saver},
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};
use time::OffsetDateTime;

fn stamp(second: i64, synced: bool) -> Option<AtomicDateTime> {
    Some(AtomicDateTime::new(
        OffsetDateTime::from_unix_timestamp(1_767_225_600 + second).unwrap(),
        synced,
    ))
}

fn produce(directory: &Path) {
    let mut run = Run::new();
    run.set_game_name("Authored clock controls");
    run.set_category_name("Native writer, not recorded gameplay");
    run.set_offset(TimeSpan::from_seconds(-5.0));
    run.push_segment(Segment::new("First"));
    run.push_segment(Segment::new("Finish"));
    let rt = |s| Time::new().with_real_time(Some(TimeSpan::from_seconds(s)));
    run.add_attempt_with_index(
        rt(84.25),
        1,
        stamp(0, true),
        stamp(120, true),
        Some(TimeSpan::from_seconds(30.75)),
    );
    run.add_attempt_with_index(Time::new(), 2, stamp(300, true), stamp(390, true), None);
    run.segments_mut()[0]
        .segment_history_mut()
        .insert(2, rt(30.5));
    run.add_attempt_with_index(
        Time::new().with_game_time(Some(TimeSpan::from_seconds(32.0))),
        3,
        stamp(500, false),
        stamp(545, false),
        Some(TimeSpan::zero()),
    );
    run.add_attempt_with_index(Time::new(), 4, stamp(600, true), stamp(600, true), None);
    run.add_attempt_with_index(Time::new(), 5, stamp(700, true), stamp(1000, true), None);
    run.segments_mut()[1]
        .segment_history_mut()
        .insert(5, rt(200.0));
    run.add_attempt_with_index(rt(50.0), 6, stamp(1100, true), None, None);
    run.add_attempt_with_index(Time::new(), 7, stamp(1300, true), stamp(1290, true), None);
    // The eighth interval overlaps #5, outside the recent group in a 3-attempt comparison.
    run.add_attempt_with_index(Time::new(), 8, stamp(800, true), stamp(850, true), None);
    let mut xml = String::new();
    saver::livesplit::save_run(&run, &mut xml).unwrap();
    std::fs::create_dir_all(directory).unwrap();
    std::fs::write(directory.join("native-clocks.lss"), xml).unwrap();
}

fn main() {
    if let Some(directory) = std::env::args().nth(1) {
        produce(Path::new(&directory));
        return;
    }
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        match livesplit::parse(input["xml"].as_str().unwrap()) {
            Err(error) => println!("{}", json!({"id": input["id"], "error": error.to_string()})),
            Ok(run) => {
                let attempts: Vec<_> = run
                    .attempt_history()
                    .iter()
                    .map(|a| {
                        json!({
                            "id": a.index(),
                            "startUnix": a.started().map(|t| t.time.unix_timestamp()),
                            "endUnix": a.ended().map(|t| t.time.unix_timestamp()),
                            "synchronized": a.started().is_some_and(|t| t.synced_with_atomic_clock)
                                && a.ended().is_some_and(|t| t.synced_with_atomic_clock),
                            "durationSeconds": a.duration().map(|t| t.total_seconds()),
                            "pauseSeconds": a.pause_time().map(|t| t.total_seconds()),
                        })
                    })
                    .collect();
                println!("{}", json!({"id": input["id"], "attempts": attempts}));
            }
        }
    }
}
