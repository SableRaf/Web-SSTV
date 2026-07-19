const test = require('node:test');
const assert = require('node:assert');
const { SSTVDecoderCore, MODES, freqToLevel, yuvToRGB } = require('../sstv-decoder.js');
const { ToneWriter, writePrefix, writeHeader, synthTransmission } = require('./synth.js');

// Collect all events emitted by a core when fed `samples`.
function runCore(fs, samples, modesOverride) {
	const events = [];
	const core = new SSTVDecoderCore(fs, (e) => events.push(e), modesOverride);
	// Feed in 128-sample quanta like the real worklet.
	for (let i = 0; i < samples.length; i += 128) {
		core.push(samples.subarray(i, Math.min(i + 128, samples.length)));
	}
	return { events, core };
}

// A high-contrast but continuous test image (triangle waves, no mod-256
// discontinuities, which would otherwise be smoothed by the decoder's binning
// and dominate the error metric without reflecting real decode accuracy).
function tri(v) {
	v %= 512;
	if (v < 0) v += 512;
	return v < 256 ? v : 511 - v;
}
function testImage(line, x) {
	return [tri(x * 2 + line * 4), tri(x + line * 8), tri(x * 3 + line * 2)];
}

//---------- Discriminator accuracy ----------//
test('discriminator estimates pure-tone frequencies', () => {
	const fs = 48000;
	for (const f of [1100, 1300, 1500, 1700, 1900, 2100, 2300]) {
		const w = new ToneWriter(fs);
		w.tone(f, 0.05);
		const core = new SSTVDecoderCore(fs, () => {});
		const samples = w.toFloat32();
		let last = 0;
		// Feed and read internal f after settling.
		core.push(samples);
		last = core.f;
		assert.ok(Math.abs(last - f) < 20, `tone ${f} -> ${last.toFixed(1)}`);
	}
});

//---------- VIS decoding ----------//
function visStream(fs, VISCode, opts = {}) {
	const w = new ToneWriter(fs);
	if (opts.leadSilence) w.silence(opts.leadSilence);
	writePrefix(w);
	writeHeader(w, VISCode);
	w.tone(1500, 0.1); // a little trailer so the stop bit fully lands
	return w.toFloat32();
}

test('decodes Martin M1 VIS header', () => {
	const fs = 48000;
	const samples = visStream(fs, [false, true, false, true, true, false, false]);
	const { events } = runCore(fs, samples);
	const mode = events.find((e) => e.type === 'mode');
	assert.ok(mode, 'mode event emitted');
	assert.strictEqual(mode.vis, 44);
	assert.strictEqual(mode.name, 'Martin M1');
});

test('gate opens after long silence and still decodes VIS', () => {
	const fs = 48000;
	const samples = visStream(fs, [false, true, false, true, true, false, false], { leadSilence: 3.0 });
	const { events } = runCore(fs, samples);
	const mode = events.find((e) => e.type === 'mode');
	assert.ok(mode, 'mode decoded despite 3s lead silence');
	assert.strictEqual(mode.vis, 44);
});

test('legacy VIS 30 aliases to Scottie 1 (60)', () => {
	const fs = 48000;
	// value 30 = 0011110 MSB-first
	const samples = visStream(fs, [false, false, true, true, true, true, false]);
	const { events } = runCore(fs, samples);
	const mode = events.find((e) => e.type === 'mode');
	assert.ok(mode);
	assert.strictEqual(mode.vis, 60);
	assert.strictEqual(mode.name, 'Scottie 1');
});

test('legacy VIS 100 aliases to PD160 (98)', () => {
	const fs = 48000;
	// value 100 = 1100100 MSB-first
	const samples = visStream(fs, [true, true, false, false, true, false, false]);
	const { events } = runCore(fs, samples);
	const mode = events.find((e) => e.type === 'mode');
	assert.ok(mode);
	assert.strictEqual(mode.vis, 98);
});

test('rejects VIS with bad parity', () => {
	const fs = 48000;
	// Manually build a header with deliberately wrong parity bit.
	const w = new ToneWriter(fs);
	writePrefix(w);
	w.tone(1900, 0.3); w.tone(1200, 0.01); w.tone(1900, 0.3);
	w.tone(1200, 0.03); // start
	// data bits for value 44 = 0101100 LSB-first: 0,0,1,1,0,1,0
	const lsb = [0, 0, 1, 1, 0, 1, 0];
	let parity = 0;
	for (const b of lsb) { w.tone(b ? 1100 : 1300, 0.03); parity += b; }
	// wrong parity: invert
	w.tone(parity % 2 === 0 ? 1100 : 1300, 0.03);
	w.tone(1200, 0.03); // stop
	w.tone(1500, 0.1);
	const { events } = runCore(fs, w.toFloat32());
	assert.ok(!events.find((e) => e.type === 'mode'), 'no mode on bad parity');
	assert.ok(events.find((e) => e.type === 'error'), 'error emitted');
});

//---------- Color inversion round-trips ----------//
test('freqToLevel inverts RGB frequency mapping', () => {
	for (const v of [0, 50, 128, 200, 255]) {
		const f = 1500 + v * 3.1372549;
		assert.ok(Math.abs(freqToLevel(f) - v) < 0.01);
	}
});

test('yuvToRGB inverts encoder YUV mapping', () => {
	const enc = (r, g, b) => {
		const Y = 6.0 + (.003906 * ((65.738 * r) + (129.057 * g) + (25.064 * b)));
		const RY = 128.0 + (.003906 * ((112.439 * r) + (-94.154 * g) + (-18.285 * b)));
		const BY = 128.0 + (.003906 * ((-37.945 * r) + (-74.494 * g) + (112.439 * b)));
		return [Y, RY, BY];
	};
	for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [200, 100, 50], [30, 180, 220]]) {
		const [Y, RY, BY] = enc(r, g, b);
		const [R, G, B] = yuvToRGB(Y, RY, BY);
		assert.ok(Math.abs(R - r) < 2 && Math.abs(G - g) < 2 && Math.abs(B - b) < 2,
			`${r},${g},${b} -> ${R.toFixed(1)},${G.toFixed(1)},${B.toFixed(1)}`);
	}
});

//---------- Round-trip decode with reduced-line test modes ----------//
function reducedMode(base, lines) {
	return Object.assign({}, base, { lines });
}

// Measure mean absolute pixel error between decoded lines and source image.
function roundTrip(fs, vis, base, lines, opts = {}) {
	const mode = reducedMode(base, lines);
	const modesOverride = Object.assign({}, MODES, { [vis]: mode });
	// Find VISCode for this vis value (MSB-first 7 bits).
	const VISCode = [];
	for (let i = 6; i >= 0; i--) VISCode.push(((vis >> i) & 1) === 1);
	const samples = synthTransmission(fs, mode, VISCode, testImage, opts);
	const events = [];
	const core = new SSTVDecoderCore(fs, (e) => events.push(e), modesOverride);
	for (let i = 0; i < samples.length; i += 128) {
		core.push(samples.subarray(i, Math.min(i + 128, samples.length)));
	}
	return { events, mode };
}

function pixelError(events, mode, lines) {
	// Reassemble decoded image.
	const img = new Uint8ClampedArray(mode.width * lines * 4);
	for (const e of events) {
		if (e.type === 'line') {
			img.set(e.pixels, e.line * mode.width * 4);
		}
	}
	let sum = 0, cnt = 0;
	for (let line = 0; line < lines; line++) {
		for (let x = 0; x < mode.width; x++) {
			const [r, g, b] = testImage(line, x);
			const o = (line * mode.width + x) * 4;
			sum += Math.abs(img[o] - r) + Math.abs(img[o + 1] - g) + Math.abs(img[o + 2] - b);
			cnt += 3;
		}
	}
	return sum / cnt;
}

// Every mode in the table, at both common sample rates, using reduced-line
// variants so the suite stays fast.
const allVis = Object.keys(MODES).map(Number);

for (const vis of allVis) {
	const base = MODES[vis];
	for (const fs of [44100, 48000]) {
		test(`round-trip ${base.name} @ ${fs}Hz`, () => {
			const lines = 8; // even count works for PD's 2-line passes too
			const { events, mode } = roundTrip(fs, vis, base, lines);
			assert.ok(events.find((e) => e.type === 'mode'), 'mode detected');
			assert.ok(events.find((e) => e.type === 'complete'), 'completed');
			const err = pixelError(events, mode, lines);
			assert.ok(err < 7, `mean abs error ${err.toFixed(2)} too high`);
		});
	}
}

// Slower full-size integration test for one representative mode.
test('full-size Martin M1 round-trip (256 lines)', () => {
	const fs = 48000;
	const { events, mode } = roundTrip(fs, 44, MODES[44], 256);
	assert.ok(events.find((e) => e.type === 'complete'), 'completed');
	const err = pixelError(events, mode, 256);
	assert.ok(err < 6, `mean abs error ${err.toFixed(2)}`);
});

//---------- Truncation: no complete on partial signal ----------//
test('truncated signal yields partial lines and no complete', () => {
	const fs = 48000;
	const mode = reducedMode(MODES[44], 8);
	const modesOverride = Object.assign({}, MODES, { 44: mode });
	const VISCode = [false, true, false, true, true, false, false];
	// Only synthesize 4 of 8 lines.
	const samples = synthTransmission(fs, mode, VISCode, testImage, { lines: 4, tailSilence: 0.2 });
	const events = [];
	const core = new SSTVDecoderCore(fs, (e) => events.push(e), modesOverride);
	for (let i = 0; i < samples.length; i += 128) {
		core.push(samples.subarray(i, Math.min(i + 128, samples.length)));
	}
	assert.ok(events.find((e) => e.type === 'mode'), 'mode detected');
	assert.ok(!events.find((e) => e.type === 'complete'), 'no complete on truncated');
	assert.ok(events.filter((e) => e.type === 'line').length > 0, 'some lines decoded');
});

//---------- Reset between two transmissions ----------//
test('decodes two consecutive transmissions with reset', () => {
	const fs = 48000;
	const mode = reducedMode(MODES[44], 8);
	const modesOverride = Object.assign({}, MODES, { 44: mode });
	const VISCode = [false, true, false, true, true, false, false];
	const one = synthTransmission(fs, mode, VISCode, testImage, { tailSilence: 0.3 });
	const events = [];
	const core = new SSTVDecoderCore(fs, (e) => events.push(e), modesOverride);
	for (let i = 0; i < one.length; i += 128) core.push(one.subarray(i, Math.min(i + 128, one.length)));
	core.reset();
	for (let i = 0; i < one.length; i += 128) core.push(one.subarray(i, Math.min(i + 128, one.length)));
	assert.strictEqual(events.filter((e) => e.type === 'complete').length, 2);
});

//---------- Sync correction: clock offset, no cumulative slant ----------//
test('small clock offset decodes without cumulative slant (Martin)', () => {
	const fs = 48000;
	const lines = 16;
	const { events, mode } = roundTrip(fs, 44, MODES[44], lines, { clockScale: 1.001 });
	assert.ok(events.find((e) => e.type === 'complete') || events.filter((e) => e.type === 'line').length >= lines - 2);
	const err = pixelError(events, mode, lines);
	assert.ok(err < 20, `slanted error ${err.toFixed(2)}`);
});
