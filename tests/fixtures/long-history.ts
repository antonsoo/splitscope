/** Controlled valid history, small enough for the actual 25 MiB browser input limit. */
export function longHistory(count = 140_000, records = false): string {
  const duration = (id: number): string => {
    const centiseconds = records ? count - id + 100 : 1000 + (id % 10) * 100;
    const whole = Math.floor(centiseconds / 100);
    return `${String(Math.floor(whole / 3600)).padStart(2, "0")}:${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
  };
  const parts = [
    '<Run version="1.8.1"><GameName>Long history control</GameName>',
    "<CategoryName>Synthetic boundary case</CategoryName><Offset>00:00:00</Offset>",
    `<AttemptCount>${count}</AttemptCount><AttemptHistory>`,
  ];
  for (let id = 1; id <= count; id++)
    parts.push(`<Attempt id="${id}"><RealTime>${duration(id)}</RealTime></Attempt>`);
  parts.push(
    "</AttemptHistory><Segments><Segment><Name>Finish</Name>",
    '<SplitTimes><SplitTime name="Personal Best"><RealTime>00:00:01</RealTime></SplitTime></SplitTimes>',
    "<BestSegmentTime><RealTime>00:00:01</RealTime></BestSegmentTime><SegmentHistory>",
  );
  for (let id = 1; id <= count; id++)
    parts.push(`<Time id="${id}"><RealTime>${duration(id)}</RealTime></Time>`);
  parts.push("</SegmentHistory></Segment></Segments></Run>");
  return parts.join("");
}
