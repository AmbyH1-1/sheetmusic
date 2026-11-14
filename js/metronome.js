import { getSetting, setSetting } from "./db.js";

const MIN_BPM = 30;
const MAX_BPM = 300;
const LOOKAHEAD_MS = 100;
const SCHEDULER_INTERVAL_MS = 25;

export function createMetronome() {
  const bpmSlider = document.querySelector("#bpmSlider");
  const bpmValue = document.querySelector("#bpmValue");
  const bpmDown = document.querySelector("#bpmDown");
  const bpmUp = document.querySelector("#bpmUp");
  const toggleButton = document.querySelector("#metronomeToggle");
  const tapButton = document.querySelector("#tapTempo");
  const timeSignature = document.querySelector("#timeSignature");
  const customBeatsField = document.querySelector("#customBeatsField");
  const customBeatsInput = document.querySelector("#customBeats");
  const volumeSlider = document.querySelector("#metronomeVolume");
  const volumeValue = document.querySelector("#volumeValue");
  const status = document.querySelector("#metronomeStatus");
  const message = document.querySelector("#metronomeMessage");
  const beatIndicator = document.querySelector("#beatIndicator");

  let bpm = 96;
  let signature = "4/4";
  let customBeats = 4;
  let volume = 0.7;
  let audioContext = null;
  let schedulerId = null;
  let saveTimer = null;
  let indicatorTimer = null;
  let nextBeatTime = 0;
  let beatIndex = 0;
  let running = false;
  let startPending = false;
  let startAttempt = 0;
  let runId = 0;
  let taps = [];
  const activeClicks = new Map();

  function setMessage(text) {
    message.textContent = text;
  }

  function updateControls() {
    bpmSlider.value = String(bpm);
    bpmValue.value = `${bpm} BPM`;
    bpmValue.textContent = `${bpm} BPM`;
    timeSignature.value = signature;
    customBeatsInput.value = String(customBeats);
    customBeatsField.hidden = signature !== "custom";
    volumeSlider.value = String(volume);
    volumeValue.value = `${Math.round(volume * 100)}%`;
    volumeValue.textContent = `${Math.round(volume * 100)}%`;
  }

  function beatCount() {
    if (signature === "custom") return customBeats;
    return Number(signature.split("/")[0]);
  }

  function saveSettingsSoon() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      setSetting("metronome", { bpm, signature, customBeats, volume }).catch((error) => {
        setMessage(`Could not save metronome settings: ${error.message}`);
      });
    }, 180);
  }

  function setBpm(value, shouldSave = true) {
    bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(value)));
    updateControls();
    if (shouldSave) saveSettingsSoon();
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function pulseIndicator(accent, activeRun) {
    if (!running || activeRun !== runId) return;
    beatIndicator.dataset.accent = String(accent);
    beatIndicator.classList.add("is-active");
    window.clearTimeout(indicatorTimer);
    indicatorTimer = window.setTimeout(() => {
      beatIndicator.classList.remove("is-active");
    }, 90);
  }

  function scheduleClick(time, accent, activeRun) {
    if (!audioContext) return;
    const visualDelay = Math.max(0, (time - audioContext.currentTime) * 1000);
    // This timer only flashes the UI; the sound is scheduled on the audio clock below.
    window.setTimeout(() => pulseIndicator(accent, activeRun), visualDelay);
    if (volume <= 0) return;

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const peak = volume * (accent ? 0.8 : 0.55);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(accent ? 1760 : 1175, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    activeClicks.set(oscillator, gain);
    oscillator.onended = () => {
      activeClicks.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(time);
    oscillator.stop(time + 0.05);
  }

  function scheduleBeats() {
    if (!running || !audioContext || audioContext.state !== "running") return;
    const scheduleThrough = audioContext.currentTime + LOOKAHEAD_MS / 1000;
    const secondsPerBeat = 60 / bpm;
    const beatsPerBar = beatCount();

    while (nextBeatTime < scheduleThrough) {
      const accent = beatIndex === 0;
      scheduleClick(nextBeatTime, accent, runId);
      beatIndex = (beatIndex + 1) % beatsPerBar;
      nextBeatTime += secondsPerBeat;
    }
  }

  function getAudioContext() {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("Web Audio is not available in this browser.");
    }
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextConstructor();
      audioContext.addEventListener("statechange", handleAudioStateChange);
    }
    return audioContext;
  }

  function startScheduler() {
    running = true;
    runId += 1;
    beatIndex = 0;
    nextBeatTime = audioContext.currentTime + 0.05;
    setStatus("Playing");
    toggleButton.textContent = "Stop";
    setMessage("");
    scheduleBeats();
    schedulerId = window.setInterval(scheduleBeats, SCHEDULER_INTERVAL_MS);
  }

  async function start() {
    if (running || startPending) return;
    startPending = true;
    toggleButton.disabled = true;
    const attempt = ++startAttempt;
    try {
      const context = getAudioContext();
      await context.resume();
      if (attempt !== startAttempt) return;
      if (context.state !== "running") {
        throw new Error("Audio could not start. Tap Start again to retry.");
      }
      if (!running) startScheduler();
    } catch (error) {
      if (attempt === startAttempt) {
        setMessage(`Could not start metronome: ${error.message}`);
      }
    } finally {
      if (attempt === startAttempt) {
        startPending = false;
        toggleButton.disabled = false;
      }
    }
  }

  function stop({ paused = false } = {}) {
    if (startPending) {
      startAttempt += 1;
      startPending = false;
      toggleButton.disabled = false;
    }
    if (schedulerId !== null) {
      window.clearInterval(schedulerId);
      schedulerId = null;
    }
    if (running) {
      running = false;
      runId += 1;
      if (audioContext) {
        const now = audioContext.currentTime;
        for (const [oscillator, gain] of activeClicks) {
          gain.gain.cancelScheduledValues(now);
          gain.gain.setTargetAtTime(0, now, 0.005);
          oscillator.stop(now + 0.03);
        }
      }
    }
    window.clearTimeout(indicatorTimer);
    beatIndicator.classList.remove("is-active");
    toggleButton.textContent = "Start";
    setStatus(paused ? "Paused" : "Stopped");
  }

  function handleAudioStateChange() {
    if (running && audioContext.state !== "running") {
      stop({ paused: true });
      setMessage("Audio paused by the browser. Tap Start to resume.");
    }
  }

  async function loadSettings() {
    try {
      const saved = await getSetting("metronome", null);
      if (saved && typeof saved === "object") {
        if (Number.isFinite(saved.bpm)) bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(saved.bpm)));
        if (["2/4", "3/4", "4/4", "5/4", "6/8", "custom"].includes(saved.signature)) {
          signature = saved.signature;
        }
        if (Number.isFinite(saved.customBeats)) {
          customBeats = Math.min(16, Math.max(1, Math.round(saved.customBeats)));
        }
        if (Number.isFinite(saved.volume)) volume = Math.min(1, Math.max(0, saved.volume));
      }
      updateControls();
    } catch (error) {
      setMessage(`Could not load metronome settings: ${error.message}`);
    }
  }

  function recordTap() {
    const now = performance.now();
    if (taps.length) {
      const interval = now - taps[taps.length - 1];
      if (interval < 200 || interval > 2000) {
        taps = [];
      } else {
        taps.push(now);
        if (taps.length > 6) taps.shift();
        const intervals = taps.slice(1).map((tap, index) => tap - taps[index]);
        const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
        setBpm(60000 / average);
        setMessage("");
        return;
      }
    }
    taps.push(now);
    setMessage("Tap a steady pulse a few times to set tempo.");
  }

  bpmDown.addEventListener("click", () => setBpm(bpm - 1));
  bpmUp.addEventListener("click", () => setBpm(bpm + 1));
  bpmSlider.addEventListener("input", () => setBpm(Number(bpmSlider.value), false));
  bpmSlider.addEventListener("change", saveSettingsSoon);
  tapButton.addEventListener("click", recordTap);
  toggleButton.addEventListener("click", () => {
    if (running) stop();
    else start();
  });

  timeSignature.addEventListener("change", () => {
    signature = timeSignature.value;
    if (beatIndex >= beatCount()) beatIndex = 0;
    updateControls();
    saveSettingsSoon();
  });
  customBeatsInput.addEventListener("input", () => {
    const value = Number(customBeatsInput.value);
    if (!Number.isFinite(value)) return;
    customBeats = Math.min(16, Math.max(1, Math.round(value)));
    customBeatsInput.value = String(customBeats);
    saveSettingsSoon();
  });
  volumeSlider.addEventListener("input", () => {
    volume = Math.min(1, Math.max(0, Number(volumeSlider.value)));
    updateControls();
  });
  volumeSlider.addEventListener("change", saveSettingsSoon);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && running) {
      stop({ paused: true });
      setMessage("Paused while the app was hidden. Tap Start to resume.");
      if (audioContext && audioContext.state === "running") {
        audioContext.suspend().catch((error) => {
          setMessage(`Could not pause audio: ${error.message}`);
        });
      }
    }
  });

  updateControls();
  loadSettings();

  return {
    stop
  };
}
