// Reference synthesizer for deterministic decoder tests.
// Produces Float32 sample streams from piecewise-constant frequency segments
// plus linear ramps (mirroring encode.js's setValueCurveAtTime interpolation).

const PREFIX_PULSE_LENGTH = 0.1;
const HEADER_PULSE_LENGTH = 0.3;
const HEADER_BREAK_LENGTH = 0.01;
const VIS_BIT_LENGTH = 0.03;
const SYNC_PULSE_FREQ = 1200;
const BLANKING_PULSE_FREQ = 1500;
const COLOR_FREQ_MULT = 3.1372549;

// A tiny FM synthesizer. Feed it (freqFn, sample) -> continuous phase sine.
class ToneWriter {
	constructor(fs) {
		this.fs = fs;
		this.phase = 0;
		this.samples = [];
	}
	// Append `dur` seconds at constant frequency `f`.
	tone(f, dur) {
		const n = Math.round(dur * this.fs);
		for (let i = 0; i < n; i++) {
			this.samples.push(Math.sin(this.phase));
			this.phase += 2 * Math.PI * f / this.fs;
			if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
		}
	}
	// Append `dur` seconds sweeping through the freq array (piecewise-linear).
	curve(freqs, dur) {
		const n = Math.round(dur * this.fs);
		for (let i = 0; i < n; i++) {
			const t = (i / n) * (freqs.length - 1);
			const k = Math.floor(t);
			const frac = t - k;
			const f = k + 1 < freqs.length
				? freqs[k] * (1 - frac) + freqs[k + 1] * frac
				: freqs[freqs.length - 1];
			this.samples.push(Math.sin(this.phase));
			this.phase += 2 * Math.PI * f / this.fs;
			if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
		}
	}
	silence(dur) {
		const n = Math.round(dur * this.fs);
		for (let i = 0; i < n; i++) this.samples.push(0);
	}
	toFloat32() { return Float32Array.from(this.samples); }
}

// Build the standard prefix (calibration pulses).
function writePrefix(w) {
	const seq = [1900, 1500, 1900, 1500, 2300, 1500, 2300, 1500];
	for (const f of seq) w.tone(f, PREFIX_PULSE_LENGTH);
}

// Build header + VIS from a stored VISCode array (MSB-first booleans).
function writeHeader(w, VISCode) {
	w.tone(1900, HEADER_PULSE_LENGTH);
	w.tone(SYNC_PULSE_FREQ, HEADER_BREAK_LENGTH);
	w.tone(1900, HEADER_PULSE_LENGTH);
	// start bit
	w.tone(SYNC_PULSE_FREQ, VIS_BIT_LENGTH);
	let parity = 0;
	const lsbFirst = [...VISCode].reverse();
	for (const bit of lsbFirst) {
		if (bit) { w.tone(1100, VIS_BIT_LENGTH); parity++; }
		else w.tone(1300, VIS_BIT_LENGTH);
	}
	w.tone(parity % 2 === 0 ? 1300 : 1100, VIS_BIT_LENGTH); // even parity
	w.tone(SYNC_PULSE_FREQ, VIS_BIT_LENGTH); // stop bit
}

function levelToFreq(v) { return 1500 + v * COLOR_FREQ_MULT; }

// Synthesize a full transmission for a given mode descriptor + image.
// mode: {family, lines, width, blank, scan, sync}
// image: function(line, x) -> [r,g,b]  (0-255)
function synthTransmission(fs, mode, VISCode, image, opts = {}) {
	const w = new ToneWriter(fs);
	const clockScale = opts.clockScale || 1.0; // >1 = slower (drift test)
	const S = (t) => t * clockScale;
	if (opts.leadSilence) w.silence(opts.leadSilence);
	writePrefix(w);
	writeHeader(w, VISCode);

	const rowFreqs = (line, ch) => {
		const arr = new Float32Array(mode.width);
		for (let x = 0; x < mode.width; x++) arr[x] = levelToFreq(image(line, x)[ch]);
		return arr;
	};

	const maxLines = opts.lines || mode.lines;

	if (mode.family === 'martin') {
		for (let line = 0; line < maxLines; line++) {
			w.tone(SYNC_PULSE_FREQ, S(mode.sync));
			w.tone(BLANKING_PULSE_FREQ, S(mode.blank));
			for (const ch of [1, 2, 0]) { // G,B,R
				w.curve(rowFreqs(line, ch), S(mode.scan));
				w.tone(BLANKING_PULSE_FREQ, S(mode.blank));
			}
		}
	} else if (mode.family === 'wraase') {
		for (let line = 0; line < maxLines; line++) {
			w.tone(SYNC_PULSE_FREQ, S(mode.sync));
			w.tone(BLANKING_PULSE_FREQ, S(mode.blank));
			for (const ch of [0, 1, 2]) w.curve(rowFreqs(line, ch), S(mode.scan));
		}
	} else if (mode.family === 'scottie') {
		w.tone(SYNC_PULSE_FREQ, S(mode.sync)); // lone leading sync
		for (let line = 0; line < maxLines; line++) {
			w.tone(BLANKING_PULSE_FREQ, S(mode.blank));
			w.curve(rowFreqs(line, 1), S(mode.scan)); // G
			w.tone(BLANKING_PULSE_FREQ, S(mode.blank));
			w.curve(rowFreqs(line, 2), S(mode.scan)); // B
			w.tone(SYNC_PULSE_FREQ, S(mode.sync));     // mid-line sync
			w.tone(BLANKING_PULSE_FREQ, S(mode.blank));
			w.curve(rowFreqs(line, 0), S(mode.scan)); // R
		}
	} else if (mode.family === 'pd') {
		// PD: chroma is shared/averaged across the pair; for tests we build
		// image() to already return consistent RY/BY. Here we synthesize the
		// pixel as Y/RY/BY frequencies. image(line,x) returns [r,g,b]; convert.
		const yuv = (line, x) => {
			const [r, g, b] = image(line, x);
			const Y = 6.0 + (.003906 * ((65.738 * r) + (129.057 * g) + (25.064 * b)));
			const RY = 128.0 + (.003906 * ((112.439 * r) + (-94.154 * g) + (-18.285 * b)));
			const BY = 128.0 + (.003906 * ((-37.945 * r) + (-74.494 * g) + (112.439 * b)));
			return [Y, RY, BY];
		};
		for (let line = 0; line < maxLines; line += 2) {
			w.tone(SYNC_PULSE_FREQ, S(mode.sync));
			w.tone(BLANKING_PULSE_FREQ, S(mode.blank));
			const yEven = new Float32Array(mode.width);
			const ryAvg = new Float32Array(mode.width);
			const byAvg = new Float32Array(mode.width);
			const yOdd = new Float32Array(mode.width);
			for (let x = 0; x < mode.width; x++) {
				const [Ye, RYe, BYe] = yuv(line, x);
				const [Yo, RYo, BYo] = yuv(line + 1, x);
				yEven[x] = levelToFreq(Ye);
				yOdd[x] = levelToFreq(Yo);
				ryAvg[x] = levelToFreq((RYe + RYo) / 2);
				byAvg[x] = levelToFreq((BYe + BYo) / 2);
			}
			w.curve(yEven, S(mode.scan));
			w.curve(ryAvg, S(mode.scan));
			w.curve(byAvg, S(mode.scan));
			w.curve(yOdd, S(mode.scan));
		}
	}

	if (opts.tailSilence !== undefined) w.silence(opts.tailSilence);
	else w.silence(0.5);
	return w.toFloat32();
}

module.exports = { ToneWriter, writePrefix, writeHeader, synthTransmission, levelToFreq };
