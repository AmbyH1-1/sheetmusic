import { getSetting, setSetting } from "./db.js";

const MAX_RECORDING_MS = 5 * 60 * 1000;
const MIN_RECORDING_SECONDS = 0.5;

export function createRecorder({ metronome }) {
  const panel = document.querySelector("#recorderPanel");
  const recordButton = document.querySelector("#recordButton");
  const stopButton = document.querySelector("#recordStopButton");
  const recordTimer = document.querySelector("#recordTimer");
  const playbackButton = document.querySelector("#recordPlaybackButton");
  const seekBar = document.querySelector("#recordSeekBar");
  const playbackTime = document.querySelector("#recordPlaybackTime");
  const rerecordButton = document.querySelector("#rerecordButton");
  const discardButton = document.querySelector("#discardRecordingButton");
  const duringRecordingCheckbox = document.querySelector("#metronomeDuringRecording");
  const status = document.querySelector("#recorderStatus");
  const compactStatus = document.querySelector("#recorderCompactStatus");
  const audio = document.querySelector("#recordedAudio");

  let state = "idle";
  let recorderSupported = false;
  let preferredMimeType = "";
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let recordingBlob = null;
  let objectUrl = null;
  let recordingStartedAt = 0;
  let recordedDuration = 0;
  let timerId = null;
  let limitId = null;
  let requestPending = false;
  let requestId = 0;
  let finalizing = false;
  let finishMessage = "";
  let recorderError = "";
  let pausedForRecording = false;
  let pausedForPlayback = false;
  let recorderSettingTouched = false;
  let disposed = false;

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  }

  function formatTime(seconds) {
    const wholeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const minutes = Math.floor(wholeSeconds / 60);
    const remainingSeconds = String(wholeSeconds % 60).padStart(2, "0");
    return `${minutes}:${remainingSeconds}`;
  }

  function getPlaybackDuration() {
    return Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : recordedDuration;
  }

  function updatePlaybackProgress() {
    const total = getPlaybackDuration();
    const elapsed = Math.min(total, Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    seekBar.max = String(Math.max(total, 0.01));
    seekBar.value = String(elapsed);
    playbackTime.textContent = `${formatTime(elapsed)} / ${formatTime(total)}`;
    playbackButton.textContent = audio.paused ? "Play" : "Pause";
  }

  function render() {
    const isRecording = state === "recording";
    const isReady = state === "ready";
    recordButton.hidden = isRecording || isReady;
    recordButton.disabled = !recorderSupported || requestPending;
    stopButton.hidden = !isRecording;
    stopButton.disabled = finalizing;
    recordTimer.hidden = !isRecording;
    playbackButton.hidden = !isReady;
    seekBar.hidden = !isReady;
    playbackTime.hidden = !isReady;
    rerecordButton.hidden = !isReady;
    discardButton.hidden = !isReady;
    rerecordButton.disabled = !recorderSupported;
    panel.classList.toggle("is-recording", isRecording);
    compactStatus.textContent = isRecording
      ? recordTimer.textContent
      : isReady ? "Ready" : recorderSupported ? "Record" : "Unavailable";
    compactStatus.classList.toggle("is-recording", isRecording);
    if (isReady) updatePlaybackProgress();
  }

  function stopTracks(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }

  function releaseMicrophone() {
    stopTracks(mediaStream);
    mediaStream = null;
  }

  function clearRecording() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    recordingBlob = null;
    recordedDuration = 0;
    chunks = [];
  }

  function stopPlaybackForRecording() {
    const shouldResumeDuringRecording = pausedForPlayback && duringRecordingCheckbox.checked;
    const shouldResumeAfterRecording = pausedForPlayback && !duringRecordingCheckbox.checked;
    pausedForPlayback = false;
    audio.pause();
    if (shouldResumeDuringRecording) void metronome.resume();
    if (shouldResumeAfterRecording) pausedForRecording = true;
  }

  function microphoneErrorMessage(error) {
    if (error && ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error.name)) {
      return "Microphone access was denied. Enable it in Settings > Safari > Microphone, or in the Home Screen app's settings.";
    }
    if (error && ["NotFoundError", "DevicesNotFoundError"].includes(error.name)) {
      return "No microphone was found. Connect or enable a microphone, then try again.";
    }
    if (error && ["NotReadableError", "TrackStartError"].includes(error.name)) {
      return "The microphone is unavailable or in use by another app. Close the other app and try again.";
    }
    if (error && error.name === "AbortError") {
      return "Microphone access was interrupted. Try recording again.";
    }
    return `Could not start recording: ${error && error.message ? error.message : "unknown microphone error"}`;
  }

  async function restoreMetronomeAfterRecording({ refreshAudio = true, resume = true } = {}) {
    metronome.setRecordingActive(false);
    if (refreshAudio) {
      try {
        await metronome.restoreAfterRecording();
      } catch (error) {
        setStatus(`Metronome audio could not be restored after recording: ${error.message}`, true);
      }
    }
    if (pausedForRecording) {
      pausedForRecording = false;
      if (resume) {
        const resumed = await metronome.resume();
        if (!resumed) {
          setStatus("Recording ended. Tap Start in the metronome panel to resume it.", true);
        }
      }
    }
  }

  function stopRecording(message, { refreshAudio = true, resumeMetronome = true } = {}) {
    if (state !== "recording" || finalizing) return;
    finalizing = true;
    finishMessage = message;
    recordedDuration = Math.max(0, (performance.now() - recordingStartedAt) / 1000);
    window.clearInterval(timerId);
    window.clearTimeout(limitId);
    timerId = null;
    limitId = null;
    setStatus("Finishing recording…");
    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch (error) {
      if (mediaRecorder) mediaRecorder.removeEventListener("stop", onRecorderStopped);
      mediaRecorder = null;
      releaseMicrophone();
      chunks = [];
      state = "idle";
      finalizing = false;
      setStatus(`Could not stop recording: ${error.message}`, true);
      render();
      void restoreMetronomeAfterRecording({
        refreshAudio,
        resume: resumeMetronome
      });
      return;
    }
    releaseMicrophone();
    render();
    void restoreMetronomeAfterRecording({
      refreshAudio,
      resume: resumeMetronome
    });
  }

  function onRecorderStopped() {
    window.clearInterval(timerId);
    window.clearTimeout(limitId);
    timerId = null;
    limitId = null;
    releaseMicrophone();

    const recorder = mediaRecorder;
    mediaRecorder = null;
    finalizing = false;
    state = "idle";

    if (recordedDuration < MIN_RECORDING_SECONDS || chunks.length === 0) {
      chunks = [];
      if (recorderError) {
        setStatus(recorderError, true);
      } else {
        setStatus("Recording was under 0.5 seconds and was discarded.");
      }
      render();
      return;
    }

    const mimeType = recorder?.mimeType || preferredMimeType || chunks[0].type || "audio/mp4";
    try {
      recordingBlob = new Blob(chunks, { type: mimeType });
      objectUrl = URL.createObjectURL(recordingBlob);
      audio.src = objectUrl;
      state = "ready";
      setStatus(recorderError || finishMessage || "Recording ready.");
    } catch (error) {
      recordingBlob = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      state = "idle";
      setStatus(`Could not prepare the recording for playback: ${error.message}`, true);
    }
    chunks = [];
    render();
  }

  function beginRecording() {
    if (!recorderSupported || requestPending || state === "recording" || disposed) return;
    stopPlaybackForRecording();
    clearRecording();
    state = "idle";
    requestPending = true;
    recorderError = "";
    finishMessage = "";
    finalizing = false;
    setStatus("Requesting microphone access…");
    render();

    const currentRequestId = ++requestId;
    metronome.setRecordingActive(true, duringRecordingCheckbox.checked);
    if (!duringRecordingCheckbox.checked && metronome.isRunning()) {
      metronome.pause();
      pausedForRecording = true;
    }

    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    }).then((stream) => {
      if (disposed || currentRequestId !== requestId) {
        stopTracks(stream);
        return;
      }

      mediaStream = stream;
      chunks = [];
      const options = preferredMimeType ? { mimeType: preferredMimeType } : undefined;
      mediaRecorder = new window.MediaRecorder(stream, options);
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      });
      mediaRecorder.addEventListener("error", (event) => {
        recorderError = event.error && event.error.message
          ? `Recording failed: ${event.error.message}`
          : "Recording failed. Check microphone access and try again.";
        if (state === "recording" && !finalizing) {
          stopRecording(recorderError);
        } else {
          setStatus(recorderError, true);
        }
      });
      mediaRecorder.addEventListener("stop", onRecorderStopped, { once: true });

      recordingStartedAt = performance.now();
      recordedDuration = 0;
      state = "recording";
      requestPending = false;
      mediaRecorder.start(250);
      recordTimer.textContent = "0:00";
      timerId = window.setInterval(() => {
        const elapsed = Math.min(MAX_RECORDING_MS, performance.now() - recordingStartedAt);
        recordTimer.textContent = formatTime(elapsed / 1000);
        compactStatus.textContent = recordTimer.textContent;
      }, 100);
      limitId = window.setTimeout(() => {
        stopRecording("The 5-minute recording limit was reached.");
      }, MAX_RECORDING_MS);
      setStatus("Recording. Tap Stop when you are finished.");
      render();
      if (duringRecordingCheckbox.checked && metronome.isRunning()) {
        void metronome.resumeForRecording().catch((error) => {
          setStatus(`Recording is active, but metronome audio could not resume: ${error.message}`, true);
        });
      }
    }).catch(async (error) => {
      if (currentRequestId !== requestId) return;
      if (mediaRecorder) {
        mediaRecorder.removeEventListener("stop", onRecorderStopped);
        if (mediaRecorder.state !== "inactive") {
          try {
            mediaRecorder.stop();
          } catch (stopError) {
            console.warn("Could not stop a failed recording session:", stopError);
          }
        }
        mediaRecorder = null;
      }
      const microphoneWasAcquired = Boolean(mediaStream);
      releaseMicrophone();
      requestPending = false;
      state = "idle";
      metronome.setRecordingActive(false);
      chunks = [];
      let errorMessage = microphoneErrorMessage(error);
      if (microphoneWasAcquired) {
        try {
          await metronome.restoreAfterRecording();
        } catch (restoreError) {
          errorMessage += ` Metronome audio could not be restored: ${restoreError.message}`;
        }
      }
      if (pausedForRecording) {
        pausedForRecording = false;
        const resumed = await metronome.resume();
        if (!resumed) {
          setStatus(`${errorMessage} Metronome is paused; tap Start to resume it.`, true);
          render();
          return;
        }
      }
      setStatus(errorMessage, true);
      render();
    });
  }

  async function resumeMetronomeAfterPlayback() {
    if (!pausedForPlayback) return;
    pausedForPlayback = false;
    const resumed = await metronome.resume();
    setStatus(
      resumed
        ? "Playback stopped. Metronome resumed."
        : "Playback stopped. Tap Start in the metronome panel to resume it.",
      !resumed
    );
  }

  recordButton.addEventListener("click", beginRecording);
  rerecordButton.addEventListener("click", beginRecording);
  stopButton.addEventListener("click", () => stopRecording("Recording ready."));
  discardButton.addEventListener("click", () => {
    clearRecording();
    state = "idle";
    setStatus("Recording discarded.");
    render();
    void resumeMetronomeAfterPlayback();
  });

  playbackButton.addEventListener("click", async () => {
    if (!recordingBlob) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (metronome.isRunning()) {
      metronome.pause();
      pausedForPlayback = true;
      setStatus("Metronome paused for playback.");
    }
    try {
      await audio.play();
    } catch (error) {
      setStatus(`Could not play recording: ${error.message}`, true);
      await resumeMetronomeAfterPlayback();
    }
  });

  seekBar.addEventListener("input", () => {
    const duration = getPlaybackDuration();
    if (duration > 0) audio.currentTime = Math.min(duration, Number(seekBar.value));
    updatePlaybackProgress();
  });

  audio.addEventListener("timeupdate", updatePlaybackProgress);
  audio.addEventListener("durationchange", updatePlaybackProgress);
  audio.addEventListener("loadedmetadata", updatePlaybackProgress);
  audio.addEventListener("ended", () => {
    audio.currentTime = 0;
    updatePlaybackProgress();
    void resumeMetronomeAfterPlayback();
  });
  audio.addEventListener("pause", () => {
    updatePlaybackProgress();
    void resumeMetronomeAfterPlayback();
  });
  audio.addEventListener("play", updatePlaybackProgress);
  audio.addEventListener("error", () => {
    setStatus("Could not play the recording. Try recording it again.", true);
  });

  duringRecordingCheckbox.addEventListener("change", () => {
    recorderSettingTouched = true;
    setSetting("metronomeDuringRecording", duringRecordingCheckbox.checked).catch((error) => {
      setStatus(`Could not save recorder setting: ${error.message}`, true);
    });
    if (state !== "recording" && !requestPending) return;
    metronome.setRecordingActive(true, duringRecordingCheckbox.checked);
    if (duringRecordingCheckbox.checked && pausedForRecording) {
      pausedForRecording = false;
      void metronome.resume().then((resumed) => {
        if (!resumed) setStatus("The metronome is paused; tap Start to resume it.", true);
      });
    } else if (!duringRecordingCheckbox.checked && metronome.isRunning()) {
      metronome.pause();
      pausedForRecording = true;
    }
  });

  getSetting("metronomeDuringRecording", true).then((saved) => {
    if (!recorderSettingTouched) duringRecordingCheckbox.checked = saved !== false;
  }).catch((error) => {
    setStatus(`Could not load recorder setting: ${error.message}`, true);
  });

  function chooseMimeType() {
    const MediaRecorderConstructor = window.MediaRecorder;
    if (typeof MediaRecorderConstructor !== "function") return "";
    if (typeof MediaRecorderConstructor.isTypeSupported !== "function") return "";
    for (const type of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]) {
      try {
        if (MediaRecorderConstructor.isTypeSupported(type)) return type;
      } catch (error) {
        console.warn(`Could not check recording type ${type}:`, error);
      }
    }
    return "";
  }

  if (typeof window.MediaRecorder !== "function") {
    setStatus("Audio recording is not supported by this browser.", true);
  } else if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    setStatus("Microphone access is not available in this browser or connection.", true);
  } else {
    preferredMimeType = chooseMimeType();
    recorderSupported = true;
    setStatus("Ready to record.");
  }

  function stopForNavigation() {
    if (requestPending) {
      requestId += 1;
      requestPending = false;
      pausedForRecording = false;
      metronome.setRecordingActive(false);
    }
    if (state === "recording") {
      pausedForRecording = false;
      stopRecording("Recording saved before returning to the Library.", {
        refreshAudio: false,
        resumeMetronome: false
      });
    }
    pausedForPlayback = false;
    audio.pause();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    requestId += 1;
    window.clearInterval(timerId);
    window.clearTimeout(limitId);
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.removeEventListener("stop", onRecorderStopped);
      try {
        mediaRecorder.stop();
      } catch (error) {
        console.warn("Could not stop the recorder during page cleanup:", error);
      }
    }
    releaseMicrophone();
    metronome.setRecordingActive(false);
    chunks = [];
    pausedForPlayback = false;
    audio.pause();
    audio.removeAttribute("src");
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    recordingBlob = null;
    mediaRecorder = null;
  }

  window.addEventListener("pagehide", dispose);
  window.addEventListener("beforeunload", dispose);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (requestPending) {
        requestId += 1;
        requestPending = false;
        pausedForRecording = false;
        metronome.setRecordingActive(false);
        setStatus("Recording request cancelled because the app went to the background.");
        render();
      }
      if (state === "recording") {
        stopRecording("Recording saved when the app went to the background.", {
          refreshAudio: false,
          resumeMetronome: false
        });
      }
      pausedForPlayback = false;
      audio.pause();
    }
  });

  render();
  return { stopForNavigation };
}
