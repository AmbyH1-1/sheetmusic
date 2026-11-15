const enabled = new URLSearchParams(location.search).get("perf") === "1";
const startedAt = performance.now();
const output = [];
const sampleSets = new Map();
let panel = null;

if (enabled) {
  panel = document.createElement("pre");
  panel.id = "performanceReadout";
  panel.setAttribute("aria-live", "polite");
  panel.style.cssText = [
    "position:fixed",
    "z-index:10000",
    "right:6px",
    "bottom:6px",
    "width:min(360px,calc(100vw - 12px))",
    "max-height:38vh",
    "overflow:auto",
    "margin:0",
    "padding:8px",
    "border:1px solid #8794a8",
    "border-radius:8px",
    "background:rgba(17,19,24,.94)",
    "color:#e8edf5",
    "font:10px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace",
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
    "pointer-events:none"
  ].join(";");
  document.body.append(panel);
  globalThis.__sheetmusicPerformance = {
    records: output,
    summaries: sampleSets
  };
}

function render() {
  if (!panel) return;
  panel.textContent = ["Performance (?perf=1)", ...output.slice(-22)].join("\n");
}

function record(label, value, unit = "ms", details = "") {
  if (!enabled) return;
  const suffix = details ? ` | ${details}` : "";
  const line = `${label}: ${typeof value === "number" ? value.toFixed(2) : value} ${unit}${suffix}`;
  output.push(line);
  console.info(`[perf] ${line}`);
  render();
}

export const perf = {
  enabled,
  startedAt,
  begin() {
    return enabled ? performance.now() : 0;
  },
  time(label, start, details = "") {
    if (!enabled) return 0;
    const elapsed = performance.now() - start;
    record(label, elapsed, "ms", details);
    return elapsed;
  },
  record,
  sample(label, value, unit = "ms") {
    if (!enabled || !Number.isFinite(value)) return;
    let samples = sampleSets.get(label);
    if (!samples) {
      samples = { count: 0, total: 0, min: Infinity, max: -Infinity, unit };
      sampleSets.set(label, samples);
    }
    samples.count += 1;
    samples.total += value;
    samples.min = Math.min(samples.min, value);
    samples.max = Math.max(samples.max, value);
  },
  summarize(label) {
    if (!enabled) return;
    const samples = sampleSets.get(label);
    if (!samples || !samples.count) return;
    record(
      `${label} avg / min / max (n=${samples.count})`,
      `${(samples.total / samples.count).toFixed(2)} / ${samples.min.toFixed(2)} / ${samples.max.toFixed(2)}`,
      samples.unit
    );
    sampleSets.delete(label);
  },
  memory(details) {
    if (!enabled) return;
    const heap = performance.memory && Number.isFinite(performance.memory.usedJSHeapSize)
      ? `, JS heap ${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB`
      : ", JS heap unavailable";
    record("Memory", JSON.stringify(details) + heap, "");
  }
};
