/*
MIT License

Copyright (c) 2024 Christian Kegel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
*/

//---------- Timing / frequency constants ----------//
// KEEP IN SYNC with encode.js
const PREFIX_PULSE_LENGTH = 0.1;   // 100 ms
const HEADER_PULSE_LENGTH = 0.3;   // 300 ms
const HEADER_BREAK_LENGTH = 0.01;  // 10 ms
const VIS_BIT_LENGTH = 0.03;       // 30 ms
const SYNC_PULSE_FREQ = 1200;
const BLANKING_PULSE_FREQ = 1500;
const COLOR_FREQ_MULT = 3.1372549; // Hz per 8-bit level
const LEADER_FREQ = 1900;

//---------- Mode table ----------//
// Keyed by decoded VIS value (stored VISCode array read MSB-first).
// Values copied verbatim from the encode.js constructors.
// KEEP IN SYNC with encode.js
//   family: 'martin' | 'scottie' | 'pd' | 'wraase'
//   lines:  number of image scan lines
//   width:  pixels per line
//   blank / scan / sync: seconds (blankingInterval / scanLineLength / syncPulseLength)
const MODES = {
	44:  { name: 'Martin M1',  family: 'martin',  lines: 256, width: 320, blank: 0.000572, scan: 0.146432, sync: 0.004862 },
	40:  { name: 'Martin M2',  family: 'martin',  lines: 256, width: 320, blank: 0.000572, scan: 0.073216, sync: 0.004862 },
	60:  { name: 'Scottie 1',  family: 'scottie', lines: 256, width: 320, blank: 0.0015,   scan: 0.138240, sync: 0.009 },
	56:  { name: 'Scottie 2',  family: 'scottie', lines: 256, width: 320, blank: 0.0015,   scan: 0.088064, sync: 0.009 },
	76:  { name: 'Scottie DX', family: 'scottie', lines: 256, width: 320, blank: 0.0015,   scan: 0.3456,   sync: 0.009 },
	93:  { name: 'PD50',       family: 'pd',      lines: 256, width: 320, blank: 0.00208,  scan: 0.091520, sync: 0.02 },
	99:  { name: 'PD90',       family: 'pd',      lines: 256, width: 320, blank: 0.00208,  scan: 0.170240, sync: 0.02 },
	95:  { name: 'PD120',      family: 'pd',      lines: 496, width: 640, blank: 0.00208,  scan: 0.121600, sync: 0.02 },
	98:  { name: 'PD160',      family: 'pd',      lines: 400, width: 512, blank: 0.00208,  scan: 0.195584, sync: 0.02 },
	96:  { name: 'PD180',      family: 'pd',      lines: 496, width: 640, blank: 0.00208,  scan: 0.18304,  sync: 0.02 },
	97:  { name: 'PD240',      family: 'pd',      lines: 496, width: 640, blank: 0.00208,  scan: 0.24448,  sync: 0.02 },
	94:  { name: 'PD290',      family: 'pd',      lines: 616, width: 800, blank: 0.00208,  scan: 0.2288,   sync: 0.02 },
	55:  { name: 'Wraase SC2-180', family: 'wraase', lines: 256, width: 320, blank: 0.0005, scan: 0.235, sync: 0.0055225 },
};
// Legacy aliases from earlier (non-standard) encoder VIS codes.
const LEGACY_VIS = { 30: 60, 100: 98 };

//---------- Signal → pixel value ----------//
// Exact inverse of getRGBValueAsFreq (encode.js:55-61).
function freqToLevel(f) {
	let v = (f - 1500) / COLOR_FREQ_MULT;
	if (v < 0) v = 0; else if (v > 255) v = 255;
	return v;
}

// Exact inverse of getYRYBYValueAsFreq (encode.js:63-73). Inputs are the
// decoded Y'/R-Y'/B-Y' *levels* (0-255-ish); returns [R,G,B] clamped 0-255.
function yuvToRGB(Yl, RYl, BYl) {
	const y = Yl - 6.0;
	const cr = RYl - 128;
	const cb = BYl - 128;
	const a = 0.003906;
	let R = a * (298.082 * y + 408.583 * cr);
	let G = a * (298.082 * y - 100.291 * cb - 208.120 * cr);
	let B = a * (298.082 * y + 516.412 * cb);
	R = R < 0 ? 0 : R > 255 ? 255 : R;
	G = G < 0 ? 0 : G > 255 ? 255 : G;
	B = B < 0 ? 0 : B > 255 ? 255 : B;
	return [R, G, B];
}

//---------- Biquad low-pass (Butterworth, Q = 1/sqrt(2)) ----------//
class Biquad {
	constructor(cutoff, fs) {
		const w0 = 2 * Math.PI * cutoff / fs;
		const cosw = Math.cos(w0);
		const sinw = Math.sin(w0);
		const alpha = sinw / (2 * Math.SQRT1_2);
		const b0 = (1 - cosw) / 2;
		const b1 = 1 - cosw;
		const b2 = (1 - cosw) / 2;
		const a0 = 1 + alpha;
		const a1 = -2 * cosw;
		const a2 = 1 - alpha;
		this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
		this.a1 = a1 / a0; this.a2 = a2 / a0;
		this.reset();
	}
	reset() { this.z1 = 0; this.z2 = 0; }
	// Transposed direct form II
	process(x) {
		const y = this.b0 * x + this.z1;
		this.z1 = this.b1 * x - this.a1 * y + this.z2;
		this.z2 = this.b2 * x - this.a2 * y;
		return y;
	}
}

//---------- Decoder core ----------//
// Environment-independent. Consumes Float32 mono sample chunks via push()
// and emits events through the callback passed to the constructor.
// Events: {type:'status', state}, {type:'mode', vis, name, width, height},
//         {type:'line', line, count, pixels}, {type:'error', message},
//         {type:'complete'}.
class SSTVDecoderCore {
	constructor(sampleRate, emit, modesOverride) {
		this.fs = sampleRate;
		this.emit = emit || (() => {});
		this.modes = modesOverride || MODES;

		// Discriminator carrier
		this.fc = 1700;
		this.lpI = new Biquad(800, sampleRate);
		this.lpQ = new Biquad(800, sampleRate);

		// Post-filter (moving average ~1 ms) + 3-sample median history
		this.maLen = Math.max(1, Math.round(0.001 * sampleRate));
		this.maBuf = new Float32Array(this.maLen);
		this.medHist = [0, 0, 0];

		// Net timing skew (samples) between the VIS-derived line anchors and the
		// point in the delayed `f` stream where a pixel's frequency actually
		// lands. The discriminator group delay and the anchor's own detection
		// lag nearly cancel; the small residual (~0.4 ms) is removed by nudging
		// the data-sampling windows earlier. Tuned empirically across families.
		this.groupDelay = Math.round(0.0004 * sampleRate);

		// Envelope gate
		this.noiseFloor = 0;          // slow EMA of E while gate closed
		this.envFast = 0;             // fast-attack/slow-release envelope
		this.gateOpen = false;
		this.absFloor = 0.02;         // absolute minimum E to consider signal

		this.reset();
	}

	reset() {
		this.phase = 0;
		this.prevI = 0;
		this.prevQ = 0;
		this.lpI.reset();
		this.lpQ.reset();
		this.maBuf.fill(0);
		this.maIdx = 0;
		this.maSum = 0;
		this.medHist = [0, 0, 0];
		this.f = 1500;

		this.noiseFloor = 0;
		this.envFast = 0;
		this.gateOpen = false;
		this.gateClosedSince = 0;

		this.sampleCount = 0; // absolute sample index since reset

		this.state = 'IDLE';
		this._setStatus('listening');

		// Leader detection
		this.leaderRunStart = -1;

		// VIS low-run tracking (t0 anchor)
		this.lowRunStart = -1;
		this.t0 = 0;

		// Rolling history of recent post-filter f, covering the full 300 ms VIS
		// window (decoded at its end) plus margin.
		this.histLen = Math.max(1, Math.round(0.4 * this.fs));
		this.hist = new Float32Array(this.histLen);
		this.histFilled = 0;

		this.mode = null;
		this._resetDecodeState();
	}

	_setStatus(state) {
		if (this._lastStatus !== state) {
			this._lastStatus = state;
			this.emit({ type: 'status', state });
		}
	}

	_resetDecodeState() {
		this.lineIndex = 0;      // image line (or pass base line for PD)
		this.lineAnchor = 0;     // sample index of current line/pass start (post-sync)
		this.missedSync = 0;
		this.syncWindow = 0.003; // ± seconds, widens on miss
	}

	//---- Per-chunk entry point ----//
	push(samples) {
		for (let i = 0; i < samples.length; i++) {
			this._processSample(samples[i]);
		}
	}

	_processSample(x) {
		// Quadrature mix
		const c = Math.cos(this.phase);
		const s = Math.sin(this.phase);
		this.phase += 2 * Math.PI * this.fc / this.fs;
		if (this.phase > Math.PI) this.phase -= 2 * Math.PI;

		const I = this.lpI.process(x * c);
		const Q = this.lpQ.process(x * -s);

		const E = Math.sqrt(I * I + Q * Q);
		this._updateGate(E);

		// Instantaneous frequency via phase difference
		let fInst = this.f;
		if (E * E > 1e-6) {
			const dphi = Math.atan2(
				Q * this.prevI - I * this.prevQ,
				I * this.prevI + Q * this.prevQ
			);
			fInst = this.fc + dphi * this.fs / (2 * Math.PI);
		}
		this.prevI = I;
		this.prevQ = Q;

		// 3-sample median
		this.medHist[0] = this.medHist[1];
		this.medHist[1] = this.medHist[2];
		this.medHist[2] = fInst;
		const a = this.medHist[0], b = this.medHist[1], d = this.medHist[2];
		let med = Math.max(Math.min(a, b), Math.min(Math.max(a, b), d));

		// Moving average
		this.maSum -= this.maBuf[this.maIdx];
		this.maBuf[this.maIdx] = med;
		this.maSum += med;
		this.maIdx = (this.maIdx + 1) % this.maLen;
		this.f = this.maSum / this.maLen;

		const n = this.sampleCount++;
		// Rolling history for VIS backfill.
		this.hist[n % this.histLen] = this.f;
		if (this.histFilled < this.histLen) this.histFilled++;
		this._runStateMachine(n, this.f, this.gateOpen);
	}

	// Read a historical post-filter f at absolute sample index `s`, or NaN
	// if it has fallen out of the rolling window.
	_histAt(s) {
		if (s < 0 || s > this.sampleCount - 1) return NaN;
		if (s < this.sampleCount - this.histLen) return NaN;
		return this.hist[s % this.histLen];
	}

	_updateGate(E) {
		// Fast attack, slow release envelope
		const attack = Math.exp(-1 / (0.005 * this.fs));
		const release = Math.exp(-1 / (0.050 * this.fs));
		if (E > this.envFast) this.envFast = attack * this.envFast + (1 - attack) * E;
		else this.envFast = release * this.envFast + (1 - release) * E;

		const threshold = Math.max(this.absFloor, 4 * this.noiseFloor);
		const wasOpen = this.gateOpen;
		if (!this.gateOpen && this.envFast > threshold) {
			this.gateOpen = true;
		} else if (this.gateOpen && this.envFast < threshold * 0.5) {
			this.gateOpen = false;
		}

		// Noise floor EMA updates ONLY while gate closed; freezes on attack.
		if (!this.gateOpen) {
			const tc = Math.exp(-1 / (1.0 * this.fs)); // ~1 s time constant
			this.noiseFloor = tc * this.noiseFloor + (1 - tc) * E;
			this.gateClosedSince = this.sampleCount;
		}

		if (!wasOpen && this.gateOpen) {
			// Re-zero discriminator state on gate re-open from silence
			// only if we were closed a while (avoid disturbing mid-decode).
			if (this.state === 'IDLE') {
				this.lpI.reset(); this.lpQ.reset();
				this.prevI = 0; this.prevQ = 0;
			}
		}
	}

	//---- State machine ----//
	_runStateMachine(n, f, gate) {
		switch (this.state) {
			case 'IDLE': return this._sIdle(n, f, gate);
			case 'LEADER': return this._sLeader(n, f, gate);
			case 'VIS': return this._sVis(n, f, gate);
			case 'DECODE': return this._sDecode(n, f, gate);
		}
	}

	_sIdle(n, f, gate) {
		if (gate && Math.abs(f - LEADER_FREQ) < 50) {
			if (this.leaderRunStart < 0) this.leaderRunStart = n;
			if ((n - this.leaderRunStart) / this.fs >= 0.2) {
				this.state = 'LEADER';
				this._setStatus('leader');
				this.lowRunStart = -1;
			}
		} else {
			this.leaderRunStart = -1;
		}
	}

	_sLeader(n, f, gate) {
		// Wait for the VIS start bit: a sustained f < 1250 Hz run of >= 15 ms.
		if (f < 1250) {
			if (this.lowRunStart < 0) this.lowRunStart = n;
			if ((n - this.lowRunStart) / this.fs >= 0.015) {
				this.t0 = this.lowRunStart; // leading edge of start bit
				this.state = 'VIS';
				this._setStatus('vis');
			}
		} else {
			this.lowRunStart = -1;
		}
	}

	_sVis(n, f, gate) {
		// Wait until the full 10-slot VIS window (300 ms) has passed, then
		// decode once from the rolling history (backfilled from t0).
		const endSample = this.t0 + Math.round(10 * VIS_BIT_LENGTH * this.fs);
		if (n < endSample) return;

		// Average the central 20 ms of each 30 ms slot.
		const meanOf = (k) => {
			const start = this.t0 + Math.round((k * VIS_BIT_LENGTH + 0.005) * this.fs);
			const stop = this.t0 + Math.round((k * VIS_BIT_LENGTH + 0.025) * this.fs);
			let sum = 0, cnt = 0;
			for (let i = start; i < stop; i++) {
				const v = this._histAt(i);
				if (!Number.isNaN(v)) { sum += v; cnt++; }
			}
			return cnt ? sum / cnt : 0;
		};

		const startF = meanOf(0);
		const stopF = meanOf(9);
		if (Math.abs(startF - 1200) > 50 || Math.abs(stopF - 1200) > 50) {
			return this._visReject('bad start/stop bit');
		}

		let bits = [];
		let parity = 0;
		for (let k = 1; k <= 7; k++) {
			const m = meanOf(k);
			let bit;
			if (Math.abs(m - 1100) <= 50) bit = 1;
			else if (Math.abs(m - 1300) <= 50) bit = 0;
			else return this._visReject('bit out of window');
			bits.push(bit);
			parity += bit;
		}
		const parityF = meanOf(8);
		let parityBit;
		if (Math.abs(parityF - 1100) <= 50) parityBit = 1;
		else if (Math.abs(parityF - 1300) <= 50) parityBit = 0;
		else return this._visReject('bad parity bit');
		if ((parity % 2) !== parityBit) return this._visReject('parity mismatch');

		// bits are LSB-first on the wire; value = MSB-first of stored array.
		// Wire order is bits[0]=LSB. VIS numeric value:
		let visLSB = 0;
		for (let k = 0; k < 7; k++) visLSB |= bits[k] << k;
		let vis = visLSB;
		if (LEGACY_VIS[vis] !== undefined) vis = LEGACY_VIS[vis];

		const mode = this.modes[vis];
		if (!mode) return this._visReject('unknown VIS ' + visLSB);

		this.mode = mode;
		this.vis = vis;
		this.emit({ type: 'mode', vis, name: mode.name, width: mode.width, height: mode.lines });

		// Anchor A = end of stop bit.
		this.state = 'DECODE';
		this._setStatus('decoding');
		this._resetDecodeState();
		this._startDecode();
	}

	_visReject(msg) {
		this._visBuf = null;
		this.emit({ type: 'error', message: 'VIS decode failed: ' + msg });
		this.state = 'IDLE';
		this._setStatus('listening');
		this.leaderRunStart = -1;
		this.lowRunStart = -1;
	}

	//---- Decode setup ----//
	_startDecode() {
		const A = this.t0 + Math.round(10 * VIS_BIT_LENGTH * this.fs);
		const m = this.mode;
		// Build per-line segment schedule (float sample offsets from lineAnchor).
		// lineAnchor is defined as the sample where the line's leading sync
		// pulse *ends* (Martin/Wraase/PD) or, for Scottie, the start of the
		// first blank of the line.
		this.decodeStart = A;
		this.lineIndex = 0;
		this.missedSync = 0;
		this.syncWindow = 0.003;

		// Every family opens the image data with a sync pulse right at A
		// (Scottie's lone leading sync; Martin/Wraase/PD's first per-line sync).
		// lineAnchor is defined as the sample AFTER that leading sync.
		this.lineAnchor = A + Math.round(m.sync * this.fs);
		this._planLine();
	}

	// Compute float sample boundaries for the current line/pass, plus the
	// predicted position of the next sync (for correction).
	_planLine() {
		const m = this.mode;
		const fs = this.fs;
		const blank = m.blank * fs;
		const scan = m.scan * fs;
		const sync = m.sync * fs;
		const A = this.lineAnchor;
		this.segments = []; // {ch, base, start, end} in absolute samples

		if (m.family === 'martin') {
			// sync already consumed into anchor for line 0? No: Martin sync is
			// per-line and leads the line. We anchor AFTER the sync.
			// line = [blank] G scan [blank] B scan [blank] R scan [blank]
			let t = A + blank;
			for (const ch of [1, 2, 0]) { // G,B,R -> RGBA channel index
				this.segments.push({ ch, start: t, end: t + scan });
				t += scan + blank;
			}
			this.lineCount = 1;
			// Next line's sync begins at t; its trailing edge = t+sync.
			this.nextSyncPredict = t;
			this.nextAnchor = t + sync;
		} else if (m.family === 'wraase') {
			// line = [blank] R scan G scan B scan ; next sync leads next line
			let t = A + blank;
			for (const ch of [0, 1, 2]) {
				this.segments.push({ ch, start: t, end: t + scan });
				t += scan;
			}
			this.lineCount = 1;
			this.nextSyncPredict = t;
			this.nextAnchor = t + sync;
		} else if (m.family === 'scottie') {
			// line = [blank] G scan [blank] B scan  SYNC  [blank] R scan
			// lineAnchor is start of first blank.
			let t = A + blank;
			this.segments.push({ ch: 1, start: t, end: t + scan }); t += scan; // G
			t += blank;
			this.segments.push({ ch: 2, start: t, end: t + scan }); t += scan; // B
			// mid-line sync here
			this.midSyncPredict = t;
			t += sync + blank;
			this.segments.push({ ch: 0, start: t, end: t + scan }); t += scan; // R
			this.lineCount = 1;
			this.nextSyncPredict = t; // Scottie has no per-line leading sync; next line starts here
			this.nextAnchor = t;
		} else if (m.family === 'pd') {
			// pass = [blank] Y(even) (R-Y) (B-Y) Y(odd) ; produces 2 lines
			let t = A + blank;
			this.segments.push({ ch: 'Y0', start: t, end: t + scan }); t += scan;
			this.segments.push({ ch: 'RY', start: t, end: t + scan }); t += scan;
			this.segments.push({ ch: 'BY', start: t, end: t + scan }); t += scan;
			this.segments.push({ ch: 'Y1', start: t, end: t + scan }); t += scan;
			this.lineCount = 2;
			this.nextSyncPredict = t;
			this.nextAnchor = t + sync;
		}

		// Shift data-sampling windows later by the discriminator group delay so
		// pixel frequencies (which appear late in `f`) land in the right bins.
		// Sync predictions are left uncompensated: sync edges are detected in
		// the same delayed `f` domain, so their timing is self-consistent.
		const gd = this.groupDelay;
		for (const seg of this.segments) { seg.start -= gd; seg.end -= gd; }

		// Per-segment bin accumulators
		this.binSum = this.segments.map(() => new Float64Array(m.width));
		this.binCnt = this.segments.map(() => new Uint32Array(m.width));
		this.midSyncDone = false;
		this._seekingSync = false;
		this._syncHit = false;
	}

	_sDecode(n, f, gate) {
		const m = this.mode;
		const fs = this.fs;

		// Scottie mid-line sync correction
		if (m.family === 'scottie' && !this.midSyncDone && this.midSyncPredict !== undefined) {
			if (n >= this.midSyncPredict - this.syncWindow * fs &&
				n <= this.midSyncPredict + this.syncWindow * fs) {
				if (f < 1350) {
					// snap: shift remaining segments by the measured offset
					const shift = n - this.midSyncPredict;
					this.segments[2].start += shift; // R segment
					this.segments[2].end += shift;
					this.nextSyncPredict += shift;
					this.nextAnchor += shift;
					this.midSyncDone = true;
				}
			}
		}

		// Accumulate f into whichever segment n falls in.
		for (let si = 0; si < this.segments.length; si++) {
			const seg = this.segments[si];
			if (n >= seg.start && n < seg.end) {
				const rel = (n - seg.start) / (seg.end - seg.start);
				let bin = Math.floor(rel * m.width);
				if (bin < 0) bin = 0; else if (bin >= m.width) bin = m.width - 1;
				this.binSum[si][bin] += f;
				this.binCnt[si][bin]++;
				break;
			}
		}

		// Once we reach the end of the line's data, look for the next line's
		// leading sync (Martin/Wraase/PD) so we can re-anchor and cancel clock
		// drift. Scottie has no per-line leading sync (its resync is mid-line),
		// so it free-runs from prediction.
		const w = this.syncWindow * fs;
		if (m.family !== 'scottie') {
			// Begin searching a little before the predicted sync edge.
			if (!this._seekingSync && n >= Math.floor(this.nextSyncPredict - w)) {
				this._seekingSync = true;
				this._syncHit = false;
			}
			if (this._seekingSync && !this._syncHit && f < 1350) {
				// Falling edge found: snap the next anchor to the measured edge.
				const shift = n - this.nextSyncPredict;
				this.nextAnchor += shift;
				this._syncHit = true;
				if (this.syncWindow > 0.003) this.syncWindow = 0.003; // narrow on hit
			}
			// Complete the line once we've either seen the sync or run past the
			// search window without one (free-run + widen for next time).
			if (this._seekingSync && (this._syncHit
					|| n >= Math.floor(this.nextSyncPredict + w))) {
				if (!this._syncHit) {
					this.missedSync++;
					this.syncWindow = Math.min(0.010, this.syncWindow + 0.002);
				}
				this._seekingSync = false;
				this._finishLine();
			}
		} else if (n >= Math.floor(this.nextSyncPredict)) {
			this._finishLine();
		}
	}

	_finishLine() {
		this._emitLine();
		if (this._decodeFinished()) {
			this.emit({ type: 'complete' });
			this.state = 'IDLE';
			this._setStatus('listening');
			this.leaderRunStart = -1;
			this.lowRunStart = -1;
			return;
		}
		this.lineAnchor = this.nextAnchor;
		this.lineIndex += this.lineCount;
		this._planLine();
	}

	_emitLine() {
		const m = this.mode;
		const width = m.width;
		// Average each bin (fill gaps with neighbor).
		const avg = this.segments.map((seg, si) => {
			const out = new Float32Array(width);
			let last = BLANKING_PULSE_FREQ;
			for (let x = 0; x < width; x++) {
				if (this.binCnt[si][x] > 0) { out[x] = this.binSum[si][x] / this.binCnt[si][x]; last = out[x]; }
				else out[x] = last;
			}
			return out;
		});

		if (m.family === 'pd') {
			// segments: Y0, RY, BY, Y1 -> two RGBA lines sharing chroma.
			const pixels = new Uint8ClampedArray(width * 2 * 4);
			for (let x = 0; x < width; x++) {
				const RY = freqToLevel(avg[1][x]);
				const BY = freqToLevel(avg[2][x]);
				const y0 = freqToLevel(avg[0][x]);
				const y1 = freqToLevel(avg[3][x]);
				const [r0, g0, b0] = yuvToRGB(y0, RY, BY);
				const [r1, g1, b1] = yuvToRGB(y1, RY, BY);
				let o = x * 4;
				pixels[o] = r0; pixels[o + 1] = g0; pixels[o + 2] = b0; pixels[o + 3] = 255;
				o = (width + x) * 4;
				pixels[o] = r1; pixels[o + 1] = g1; pixels[o + 2] = b1; pixels[o + 3] = 255;
			}
			this.emit({ type: 'line', line: this.lineIndex, count: 2, pixels });
		} else {
			// RGB families: segments carry channel index in seg.ch.
			const chan = { 0: null, 1: null, 2: null };
			this.segments.forEach((seg, si) => { chan[seg.ch] = avg[si]; });
			const pixels = new Uint8ClampedArray(width * 4);
			for (let x = 0; x < width; x++) {
				const o = x * 4;
				pixels[o] = freqToLevel(chan[0][x]);
				pixels[o + 1] = freqToLevel(chan[1][x]);
				pixels[o + 2] = freqToLevel(chan[2][x]);
				pixels[o + 3] = 255;
			}
			this.emit({ type: 'line', line: this.lineIndex, count: 1, pixels });
		}
	}

	_decodeFinished() {
		return (this.lineIndex + this.lineCount) >= this.mode.lines;
	}

	// Mic path: flag long signal loss mid-decode.
	tick() {
		if (this.state === 'DECODE' && !this.gateOpen) {
			if ((this.sampleCount - this.gateClosedSince) / this.fs > 2.0) {
				this.emit({ type: 'error', message: 'Signal lost' });
				this.state = 'IDLE';
				this._setStatus('listening');
			}
		}
	}
}

//---------- AudioWorklet wrapper ----------//
const BaseProcessor = typeof AudioWorkletProcessor !== 'undefined'
	? AudioWorkletProcessor : class {};

class SSTVDecoder extends BaseProcessor {
	constructor() {
		super();
		const fs = (typeof sampleRate !== 'undefined') ? sampleRate : 48000;
		this.core = new SSTVDecoderCore(fs, (evt) => {
			if (evt.type === 'line') {
				this.port.postMessage(evt, [evt.pixels.buffer]);
			} else {
				this.port.postMessage(evt);
			}
		});
		this.port.onmessage = (e) => {
			if (e.data && e.data.type === 'reset') this.core.reset();
		};
	}

	process(inputs) {
		const input = inputs[0];
		if (!input || input.length === 0 || !input[0]) return true;
		const frames = input[0].length;
		if (input.length === 1) {
			this.core.push(input[0]);
		} else {
			// Downmix all channels to mono.
			const mono = new Float32Array(frames);
			for (let ch = 0; ch < input.length; ch++) {
				const data = input[ch];
				for (let i = 0; i < frames; i++) mono[i] += data[i];
			}
			for (let i = 0; i < frames; i++) mono[i] /= input.length;
			this.core.push(mono);
		}
		this.core.tick();
		return true;
	}
}

if (typeof registerProcessor === 'function') {
	registerProcessor('sstv-decoder', SSTVDecoder);
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { SSTVDecoderCore, MODES, LEGACY_VIS, freqToLevel, yuvToRGB, Biquad };
}
