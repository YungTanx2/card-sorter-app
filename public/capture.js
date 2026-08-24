/**
 * Shared camera stack for every capture-driven mode in this app.
 *
 * Extracted verbatim from index.html (the price-sorter page) when Set Builder mode was added.
 * The reason it's shared rather than copied: this is the least-settled code in the project —
 * the crop geometry, the frame-diff trigger and the adaptive-quality JPEG step were all derived
 * from real calibration runs and are still being tuned against a rig whose orientation behavior
 * isn't fully diagnosed. Two copies would silently diverge exactly when that tuning happens.
 *
 * The ONLY mode-specific part of a capture is what happens to the resulting blob, which is why
 * CaptureRig takes an onCapture(blob) callback and knows nothing about sessions, goals,
 * decisions, or any API route.
 *
 * Plain script (not an ESM module) exposing one global, so the consuming pages can keep their
 * existing IIFE structure unchanged.
 */
window.CardSorterCapture = (function () {
  'use strict';

  // ═══════════════════════ API HELPER ═══════════════════════════

  async function api(path, opts) {
    const res = await fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || (res.status + ' ' + res.statusText));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // ═══════════════════════ CROP GEOMETRY ═══════════════════════════════

  // Base crop, as fractions of the frame — the exact box validated in the 2026-08-04
  // calibration run (scripts/calibrate.ts): full frame scored 0/3 correct against real
  // TCGTracking /scan calls, this crop scored 2/3 with a clean score/gap separation from wrong
  // matches. captureCropZoomPct=100 reproduces it exactly; sliders scale/reposition from here.
  const BASE_CROP_W = 0.58;
  const BASE_CROP_H = 0.47;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /** Maps the two persisted slider values to an absolute crop rectangle. Box is always
   *  horizontally centered (matches every sample photo — the rig points straight down at a
   *  centered card holder); only size (zoom) and vertical position are adjustable. */
  function getCrop(settings) {
    const scale = settings.captureCropZoomPct / 100;
    const width = clamp(BASE_CROP_W * scale, 0.15, 0.95);
    const height = clamp(BASE_CROP_H * scale, 0.15, 0.95);
    const top = (settings.captureCropVPosPct / 100) * (1 - height);
    const left = (1 - width) / 2;
    return { left, top, width, height };
  }

  /**
   * What CLIP's preprocessor consumes. From the model's own preprocessor_config.json:
   * `size: {shortest_edge: 224}` then `do_center_crop: true, crop_size: 224x224` — so the image's
   * SHORTEST edge sets the detail, and everything outside the resulting centre square is thrown
   * away before the model sees anything. Both facts drive the numbers in describeFraming().
   */
  const CLIP_INPUT_PX = 224;

  /**
   * Camera constraints, shared by every stream this app opens.
   *
   * Resolution is requested rather than left to the browser. Unconstrained getUserMedia on mobile
   * frequently hands back 640x480, which after cropping leaves roughly 226px against CLIP's 224 —
   * a ~1.01x sampling ratio, meaning sensor noise and demosaic artifacts pass into the model with
   * no averaging to smooth them. At 1080p the same crop carries about 508px, so the 640px upload
   * is downsampled FROM real pixels instead of being near-native marginal ones.
   *
   * `ideal` and not `exact`: a device that can't do 1080p should degrade, never fail to open.
   * Nothing downstream changes — _triggerCapture still caps output at 640 — so upload size is
   * unaffected. This buys sampling quality, not bytes.
   */
  const VIDEO_CONSTRAINTS = {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  };

  /**
   * The numbers that decide whether recognition is being starved, for a stream of a given size.
   *
   * `ratio` is the headline: the crop's shortest edge divided by CLIP's 224. Below ~1.5 the model
   * is being fed marginally-sampled pixels no threshold tuning can recover. Reported rather than
   * assumed because it depends entirely on what the device actually granted.
   */
  function describeFraming(videoWidth, videoHeight, settings) {
    if (!videoWidth || !videoHeight) return null;
    const crop = getCrop(settings);
    const { sw, sh } = cropRectPx(videoWidth, videoHeight, crop);
    const shortest = Math.min(sw, sh);
    return {
      stream: videoWidth + 'x' + videoHeight,
      streamAspect: Math.round((videoWidth / videoHeight) * 100) / 100,
      cropPx: sw + 'x' + sh,
      // >1 is landscape in PIXELS. Worth watching: the crop fractions are fixed, so a portrait
      // video stream flips this, which changes which edge CLIP's centre crop cuts into.
      cropAspect: Math.round((sw / sh) * 100) / 100,
      shortestEdge: shortest,
      clipInput: CLIP_INPUT_PX,
      ratio: Math.round((shortest / CLIP_INPUT_PX) * 100) / 100,
      starved: shortest / CLIP_INPUT_PX < 1.5,
    };
  }

  function renderCropGuide(el, crop) {
    el.style.left = (crop.left * 100) + '%';
    el.style.top = (crop.top * 100) + '%';
    el.style.width = (crop.width * 100) + '%';
    el.style.height = (crop.height * 100) + '%';
  }

  /** Converts a fractional crop into the video element's native pixel coordinates — needed
   *  because getUserMedia's actual resolution isn't known until the stream is playing, so the
   *  crop can't be baked in as pixels ahead of time. */
  function cropRectPx(videoWidth, videoHeight, crop) {
    return {
      sx: Math.round(crop.left * videoWidth),
      sy: Math.round(crop.top * videoHeight),
      sw: Math.round(crop.width * videoWidth),
      sh: Math.round(crop.height * videoHeight),
    };
  }

  // ═══════════════════════ CAPTURE ENCODING ═══════════════════════════

  const MAX_UPLOAD_BYTES = 100 * 1024;
  // Sample frames are stored, not recognised, so they are budgeted against volume space rather
  // than upload latency. 50 cards at this cap is roughly 20MB.
  const SAMPLE_MAX_BYTES = 400 * 1024;
  const SAMPLE_MAX_WIDTH = 1280;

  /** Steps JPEG quality down until the blob fits the cap, or gives up at the floor quality.
   *  Needed specifically BECAUSE we now crop before upload: calibration testing found a tight
   *  crop of just the card is LARGER at a fixed quality than the full frame (114KB vs 69KB) —
   *  removing the plain bin background removes the low-entropy content JPEG compresses best,
   *  leaving dense card art+text. A fixed q0.8 that was safe for full frames isn't safe here.
   *
   *  Note: the 100KB default originated as TCGTracking's decoded-image cap. Recognition is now
   *  local (CLIP, which downsamples to 224x224 anyway), so this is no longer a hard external
   *  constraint — it's kept because it's the size every validation run to date was measured at.
   *  Configurable per rig rather than hardcoded, so raising it is a one-line experiment. */
  function canvasToBlobUnderCap(canvas, maxBytes) {
    const qualities = [0.8, 0.7, 0.6, 0.5, 0.4];
    return new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        canvas.toBlob((blob) => {
          if (!blob || blob.size <= maxBytes || i === qualities.length - 1) { resolve(blob); return; }
          i++;
          tryNext();
        }, 'image/jpeg', qualities[i]);
      };
      tryNext();
    });
  }

  // ═══════════════════════ THUMBNAIL PREVIEW ═══════════════════════════

  /** Renders the exact bytes POSTed for recognition — deliberately NOT a re-draw from the video
   *  element, which could look fine on screen while the raw captured buffer is rotated or
   *  mis-cropped (a known getUserMedia + canvas.drawImage orientation gotcha on some mobile
   *  browsers). Revokes the previous object URL so a long run doesn't leak memory. */
  class ThumbPreview {
    constructor({ container, img, downloadLink }) {
      this.container = container;
      this.img = img;
      this.downloadLink = downloadLink;
      this.lastUrl = null;
    }

    show(blob) {
      if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
      this.lastUrl = URL.createObjectURL(blob);
      if (this.container) this.container.hidden = false;
      if (this.img) this.img.src = this.lastUrl;
      if (this.downloadLink) {
        this.downloadLink.href = this.lastUrl;
        this.downloadLink.download = 'capture-' + Date.now() + '.jpg'; // unique per save, not per card
      }
    }
  }

  // ═══════════════════════ CAPTURE RIG ═══════════════════════════

  // Client-side capture state machine — see plan "Client state machine":
  // IDLE -> ARMED -> CHANGING -> STABLE -> SCANNING -> DECIDED -> WAIT_CLEAR -> ARMED, + STALLED.
  // ARMED/WAIT_CLEAR both watch for frame-diff; the difference is only which transition a
  // detected change leads to (a new card arriving vs. the just-decided card being routed away).
  const S = {
    IDLE: 'idle', ARMED: 'armed', CHANGING: 'changing', SCANNING: 'scanning',
    WAIT_CLEAR: 'wait_clear', STALLED: 'stalled', DONE: 'done',
  };

  class CaptureRig {
    /**
     * @param {object} opts
     * @param {HTMLVideoElement} opts.video       live camera element
     * @param {HTMLElement}     [opts.cropGuide]  overlay box redrawn whenever settings change
     * @param {object}           opts.settings    AppSettings (crop + timing knobs)
     * @param {function}         opts.onCapture   (blob, meta) => void — called the instant a
     *                                            capture is encoded, BEFORE any upload. Do the
     *                                            upload here. meta = { drift, spanMs } (the
     *                                            evidence the card was at rest, see _tick) plus
     *                                            { fullFrame, framing } when collecting samples.
     * @param {function}        [opts.onHopperEmpty] () => void — no activity for hopperEmptyTimeoutMs
     * @param {function}        [opts.onStall]    (reason) => void — 'scan-failed' | 'unsettled'
     * @param {function}        [opts.onNoCard]   (presenceDiff) => void — settled on bare platform;
     *                                            no capture, no tone, no card consumed
     * @param {boolean}         [opts.collectSamples] also encode the full uncropped frame, for
     *                                            offline crop-geometry A/B. Dry runs only.
     * @param {function}        [opts.onStateChange] (state) => void
     * @param {number}          [opts.maxUploadBytes]
     */
    constructor(opts) {
      this.video = opts.video;
      this.cropGuide = opts.cropGuide || null;
      this.onCapture = opts.onCapture;
      this.onHopperEmpty = opts.onHopperEmpty || (() => {});
      this.onStall = opts.onStall || (() => {});
      this.onNoCard = opts.onNoCard || (() => {});
      this.onStateChange = opts.onStateChange || (() => {});
      this.maxUploadBytes = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;

      this.state = S.IDLE;
      this.stream = null;
      this.loopTimer = null;
      this.prevGray = null;    // Uint8ClampedArray from the last diff-canvas sample
      this.stableCount = 0;
      this.lastActivityAt = 0; // resets the hopper-empty timer whenever something is happening
      this.lastBlob = null;
      this.stallReason = null; // 'scan-failed' | 'unsettled' — decides how a retry recovers
      // The confirmation anchor: the frame the quiet window STARTED on. Confirming against this
      // rather than against the previous tick is the whole point — see _tick().
      this.anchorGray = null;
      this.anchorAt = 0;
      this.confirmAttempts = 0;

      // Sample collection: when on, every capture also encodes the FULL uncropped frame, which
      // is the only thing that lets crop geometry be re-tested offline. The cropped upload alone
      // can never answer "would a different crop have matched", because the pixels are gone.
      this.collectSamples = !!opts.collectSamples;
      this.fullCanvas = document.createElement('canvas');
      this.fullCtx = this.fullCanvas.getContext('2d');

      this.diffCanvas = document.createElement('canvas');
      this.diffCanvas.width = DIFF_W;
      this.diffCanvas.height = DIFF_H;
      this.diffCtx = this.diffCanvas.getContext('2d', { willReadFrequently: true });
      this.captureCanvas = document.createElement('canvas');
      this.captureCtx = this.captureCanvas.getContext('2d');

      this.updateSettings(opts.settings);
    }

    /** Every place settings change (initial load, Calibrate save, raw Settings save) must
     *  recompute the crop through here, so the on-screen guide and the actual capture crop
     *  never drift from what was saved. */
    updateSettings(settings) {
      this.settings = settings;
      this.crop = getCrop(settings);
      if (this.cropGuide) renderCropGuide(this.cropGuide, this.crop);
      this.emptyBaseline = decodeBaseline(settings.emptyPlatformBaseline, this.crop, settings.emptyPlatformCrop);
    }

    /** Samples the CURRENT frame as the "nothing is on the platform" reference. Returns the
     *  base64 payload to save into settings, plus the crop it was taken under — a baseline is
     *  only meaningful for the crop that produced it, so both travel together. */
    captureEmptyBaseline() {
      return { baseline: encodeGray(this._sampleGray()), crop: { ...this.crop } };
    }

    /**
     * How far the current frame is from bare platform. null when no usable baseline is stored.
     *
     * Exposed so Calibrate can show it live: the operator can put a card in and take it out and
     * watch the number move, which is the only honest way to pick a threshold for their rig.
     */
    presenceDiff() {
      if (!this.emptyBaseline || !this.video.videoWidth) return null;
      return meanAbsDiff(this._sampleGray(), this.emptyBaseline);
    }

    _setState(next) {
      this.state = next;
      this.onStateChange(next);
    }

    /** Framing report for THIS rig's live stream — see describeFraming(). */
    framing() {
      return describeFraming(this.video.videoWidth, this.video.videoHeight, this.settings);
    }

    /** Opens the camera and arms the loop. Throws on camera failure so the caller can render a
     *  mode-appropriate error — getUserMedia needs a secure context (HTTPS or localhost). */
    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: false });
      this.video.srcObject = this.stream;
      await this.video.play();
      if (this.cropGuide) renderCropGuide(this.cropGuide, this.crop);

      // Log once per run: the device decides what it actually grants, and a request that was
      // quietly refused looks exactly like one that worked.
      console.log('[capture] framing', JSON.stringify(this.framing()));

      this.lastActivityAt = Date.now();
      this.prevGray = null;
      this._setState(S.ARMED);
      this.loopTimer = setInterval(() => this._tick(), this.settings.captureIntervalMs);
    }

    stop() {
      if (this.loopTimer) { clearInterval(this.loopTimer); this.loopTimer = null; }
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    }

    /**
     * Call after a scan resolves successfully — waits for the decided card to physically clear
     * the frame before arming for the next one.
     *
     * prevGray MUST be dropped here. _tick() returns early for SCANNING before sampling, so
     * prevGray is frozen for the whole scan + tone + settle; comparing against it would produce
     * a large diff from staleness alone and WAIT_CLEAR would pass on its first tick every time,
     * whether or not the card actually left. That made WAIT_CLEAR a no-op, which is half the
     * reason ejection motion was being read as an arriving card.
     */
    rearm() {
      this.prevGray = null;
      this.stallReason = null;
      this._resetStable();
      this.confirmAttempts = 0;
      this._setState(S.WAIT_CLEAR);
    }

    /**
     * Call when a capture can't be trusted. Deliberately does NOT re-arm: the card is still
     * sitting on the machine holding for a tone that was never sent, so nothing is lost by
     * pausing.
     *
     * @param {'scan-failed'|'unsettled'} reason  'scan-failed' means we have a good image the
     *   upload failed on, so retrying means re-posting lastBlob. 'unsettled' means we never got
     *   an image at all — so lastBlob still holds the PREVIOUS card, and re-posting it would
     *   identify the wrong card and route this one under that identity. Clearing it makes the
     *   callers' existing `if (!rig.lastBlob) return` guard fail safe if that branch is ever hit.
     */
    stall(reason) {
      this.stallReason = reason || 'scan-failed';
      if (this.stallReason === 'unsettled') this.lastBlob = null;
      this._setState(S.STALLED);
      this.onStall(this.stallReason);
    }

    /** Recovery from an 'unsettled' stall: go back to watching THIS card settle, rather than
     *  re-posting an image we never took. Returns to CHANGING rather than ARMED because the card
     *  is already in frame — ARMED waits for a change that may never come, and would sit there
     *  until the hopper-empty timeout. */
    resumeCapture() {
      this.stallReason = null;
      this.prevGray = null;
      this._resetStable();
      this.confirmAttempts = 0;
      this._setState(S.CHANGING);
    }

    _resetStable() {
      this.stableCount = 0;
      this.anchorGray = null;
      this.anchorAt = 0;
    }

    markDone() { this._setState(S.DONE); }

    isDone() { return this.state === S.DONE; }

    _sampleGray() {
      // Diff only inside the crop — see plan/calibration finding: motion outside the capture
      // window (bin walls, hands passing by) isn't a card arriving and shouldn't arm a capture.
      return sampleGray(this.video, this.crop, this.diffCtx);
    }

    _tick() {
      if (this.state === S.SCANNING || this.state === S.DONE || this.state === S.STALLED) return;
      if (!this.video.videoWidth) return;

      const gray = this._sampleGray();
      const diff = this.prevGray ? meanAbsDiff(gray, this.prevGray) : 0;
      this.prevGray = gray;
      const changed = diff > this.settings.frameDiffThreshold;

      if (this.state === S.ARMED) {
        if (changed) {
          this._setState(S.CHANGING);
          this.stableCount = 0;
          this.lastActivityAt = Date.now();
        } else if (Date.now() - this.lastActivityAt > this.settings.hopperEmptyTimeoutMs) {
          this.onHopperEmpty();
        }
        return;
      }

      if (this.state === S.CHANGING) {
        this.lastActivityAt = Date.now();
        if (changed) { this._resetStable(); return; }

        // The quiet window starts here. Everything below confirms against THIS frame rather than
        // against the previous tick, and that difference is the whole fix: the per-tick test only
        // asks "did it move in the last 200ms", so a card creeping into position can sit under
        // frameDiffThreshold on every single tick while travelling a long way across the window.
        // Consecutive-frame differencing is blind to slow drift by construction, which is exactly
        // how a scan was firing while the next card was still being placed.
        if (this.stableCount === 0) { this.anchorGray = gray; this.anchorAt = Date.now(); }
        this.stableCount++;
        if (this.stableCount < this.settings.stableFrames) return;

        // Hold until the anchor is far enough back to be worth comparing against. A baseline of
        // one or two ticks would just be stableFrames by another name.
        const spanMs = Date.now() - this.anchorAt;
        if (spanMs < this.settings.confirmMinSpanMs) return;

        const drift = meanAbsDiff(gray, this.anchorGray);
        if (drift <= this.settings.confirmMaxDrift) {
          // Settled — but settled on WHAT? The drift test proves the scene stopped moving, and an
          // empty platform is the stillest thing there is. Measured on CFSortingRun2: 7 of 178
          // scans fired 2.75-2.99s after the previous one against a 4.21s median, all scoring
          // 0.54-0.56. Those were captures of bare platform taken in the gap after one card was
          // ejected and before the next arrived.
          //
          // This is not merely noise in the manifest. The machine holds until it hears a tone, so
          // a phantom capture tones on garbage and the ARRIVING card is then ejected unscanned and
          // routed by a decision that was never about it. Every phantom costs one real card.
          if (this.emptyBaseline) {
            const presence = meanAbsDiff(gray, this.emptyBaseline);
            if (presence <= this.settings.cardPresenceMinDiff) {
              console.log('[capture] no card present: ' + presence.toFixed(2) + ' <= ' +
                this.settings.cardPresenceMinDiff + ' from empty-platform baseline — waiting');
              // Back to ARMED rather than looping in CHANGING: ARMED is the state that waits for
              // a card to arrive, and it is the only one that runs the hopper-empty timeout. A
              // genuinely empty hopper must still be able to end the run.
              this._resetStable();
              this._setState(S.ARMED);
              this.lastActivityAt = Date.now();
              this.onNoCard(presence);
              return;
            }
          }
          this.confirmAttempts = 0;
          this._triggerCapture({ drift, spanMs });
          return;
        }

        // Still creeping. Re-anchor and look again rather than capturing a card in motion.
        this.confirmAttempts++;
        console.log('[capture] not settled: drift ' + drift.toFixed(2) + ' > ' +
          this.settings.confirmMaxDrift + ' over ' + spanMs + 'ms (attempt ' +
          this.confirmAttempts + '/' + this.settings.confirmMaxAttempts + ')');
        if (this.confirmAttempts >= this.settings.confirmMaxAttempts) {
          // Never guess-route: the machine is holding a card we cannot photograph at rest.
          this.stall('unsettled');
          return;
        }
        this._resetStable();
        return;
      }

      if (this.state === S.WAIT_CLEAR) {
        if (changed) { this._setState(S.ARMED); this.lastActivityAt = Date.now(); }
        return;
      }
    }

    async _triggerCapture(meta) {
      this._setState(S.SCANNING);

      const { sx, sy, sw, sh } = cropRectPx(this.video.videoWidth, this.video.videoHeight, this.crop);
      const w = Math.min(sw, 640);
      const h = Math.round(w * (sh / sw));
      this.captureCanvas.width = w;
      this.captureCanvas.height = h;
      this.captureCtx.drawImage(this.video, sx, sy, sw, sh, 0, 0, w, h);
      const blob = await canvasToBlobUnderCap(this.captureCanvas, this.maxUploadBytes);
      this.lastBlob = blob;

      const info = Object.assign({}, meta);
      if (this.collectSamples) {
        // Encoded from the same video frame as the crop above, so the two are genuinely paired —
        // re-cropping this offline reproduces exactly what a different setting would have sent.
        const full = await this._encodeFullFrame();
        if (full) {
          info.fullFrame = full.blob;
          info.fullFrameW = full.width;
          info.fullFrameH = full.height;
        }
        info.framing = this.framing();
        info.crop = this.crop;
      }
      this.onCapture(blob, info);
    }

    /** The whole frame, downscaled only if huge. Capped harder than the scan upload because a
     *  50-card run stores 50 of these. 1280px keeps the crop region well above CLIP's 224 for
     *  every geometry the A/B will try, without storing 12MP stills. */
    async _encodeFullFrame() {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return null;
      const w = Math.min(vw, SAMPLE_MAX_WIDTH);
      const h = Math.round(w * (vh / vw));
      this.fullCanvas.width = w;
      this.fullCanvas.height = h;
      this.fullCtx.drawImage(this.video, 0, 0, vw, vh, 0, 0, w, h);
      const blob = await canvasToBlobUnderCap(this.fullCanvas, SAMPLE_MAX_BYTES);
      // Dimensions of the STORED frame, not the stream — the crop fractions are relative, but an
      // export that re-crops offline needs to know what it is re-cropping.
      return blob ? { blob, width: w, height: h } : null;
    }
  }

  function meanAbsDiff(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  // ═══════════════════ EMPTY-PLATFORM BASELINE ═══════════════════
  // 64x48 grays, base64'd so they fit a settings JSON row (~4KB) instead of a 12KB number array.

  const DIFF_W = 64;
  const DIFF_H = 48;

  /**
   * The one grayscale sampler. Both the rig and Calibrate go through this, deliberately: a
   * baseline captured by even slightly different maths than the frames it is later compared
   * against would produce a constant offset in every diff, which is exactly the kind of bug that
   * shows up as "the threshold needs to be weirdly high on this rig" and never gets diagnosed.
   */
  function sampleGray(video, crop, ctx) {
    const { sx, sy, sw, sh } = cropRectPx(video.videoWidth, video.videoHeight, crop);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, DIFF_W, DIFF_H);
    const data = ctx.getImageData(0, 0, DIFF_W, DIFF_H).data;
    const gray = new Uint8ClampedArray(DIFF_W * DIFF_H);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
    return gray;
  }

  /** Scratch canvas for callers that have a <video> but no CaptureRig — i.e. Calibrate. */
  let standaloneCtx = null;
  function sampleGrayFromVideo(video, crop) {
    if (!video || !video.videoWidth) return null;
    if (!standaloneCtx) {
      const c = document.createElement('canvas');
      c.width = DIFF_W;
      c.height = DIFF_H;
      standaloneCtx = c.getContext('2d', { willReadFrequently: true });
    }
    return sampleGray(video, crop, standaloneCtx);
  }

  function encodeGray(gray) {
    let s = '';
    for (let i = 0; i < gray.length; i++) s += String.fromCharCode(gray[i]);
    return btoa(s);
  }

  /**
   * Decodes a stored baseline, but ONLY if it was taken under the crop now in force.
   *
   * The guard is the important half. A baseline is a picture of one specific region of the frame;
   * move the capture window and it describes somewhere else entirely, so a stale baseline would
   * silently start rejecting real cards as "empty platform". Returning null on mismatch degrades
   * to the old behaviour (no presence check) rather than to a confidently wrong one.
   */
  function decodeBaseline(b64, crop, savedCrop) {
    if (!b64 || !savedCrop) return null;
    // Compare the fields getCrop() actually returns — {left, top, width, height}. There is no
    // `vpos` on a crop object (that is the SETTING, not the geometry), and comparing it would be
    // Math.abs(NaN) < eps, i.e. false forever, silently disabling the presence check.
    const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
    if (!near(crop.width, savedCrop.width) || !near(crop.height, savedCrop.height) || !near(crop.top, savedCrop.top)) {
      console.warn('[capture] empty-platform baseline was taken under a different crop — presence check disabled. Re-capture it in Calibrate.');
      return null;
    }
    try {
      const s = atob(b64);
      // A real browser's atob() throws SyntaxError on malformed base64, but that is not the only
      // way this string could be bad — a hand-edited settings row or a future format change would
      // decode cleanly to the wrong length. meanAbsDiff() has no length check of its own (it just
      // walks a.length), so a mismatched array would silently compare only part of the frame
      // rather than erroring. Length is the one invariant worth asserting explicitly.
      if (s.length !== DIFF_W * DIFF_H) {
        console.warn('[capture] empty-platform baseline has the wrong length (' + s.length +
          ', expected ' + (DIFF_W * DIFF_H) + ') — presence check disabled.');
        return null;
      }
      const gray = new Uint8ClampedArray(s.length);
      for (let i = 0; i < s.length; i++) gray[i] = s.charCodeAt(i);
      return gray;
    } catch (err) {
      console.warn('[capture] could not decode empty-platform baseline:', err && err.message);
      return null;
    }
  }

  return {
    api, getCrop, renderCropGuide, cropRectPx, canvasToBlobUnderCap, ThumbPreview, CaptureRig,
    describeFraming, VIDEO_CONSTRAINTS, CLIP_INPUT_PX, STATE: S, MAX_UPLOAD_BYTES,
    sampleGrayFromVideo, encodeGray, decodeBaseline, meanAbsDiff,
  };
})();
