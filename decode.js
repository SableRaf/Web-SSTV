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

//---------- DOM ----------//
const decodeText = document.getElementById('decodeText');
const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');
const micButton = document.getElementById('micButton');
const stopButton = document.getElementById('stopButton');
const audioPicker = document.getElementById('audioPicker');
const saveButton = document.getElementById('saveButton');

//---------- Shared decode state ----------//
let decodeState = {
	sawMode: false,
	complete: false,
	haveImage: false,
};

const STATUS_TEXT = {
	listening: 'Listening for SSTV...',
	leader: 'Leader tone detected...',
	vis: 'Reading VIS header...',
	decoding: 'Decoding image...',
};

function setStatus(text) { decodeText.textContent = text; }

// Handle a message coming back from the worklet (shared by mic + file paths).
function handlePortMessage(data) {
	switch (data.type) {
		case 'status':
			if (!decodeState.complete) setStatus(STATUS_TEXT[data.state] || '');
			break;
		case 'mode':
			decodeState.sawMode = true;
			canvas.width = data.width;
			canvas.height = data.height;
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			setStatus(`Decoding ${data.name} (${data.width}×${data.height})...`);
			break;
		case 'line': {
			const img = new ImageData(new Uint8ClampedArray(data.pixels), canvas.width, data.count);
			ctx.putImageData(img, 0, data.line);
			decodeState.haveImage = true;
			saveButton.disabled = false;
			break;
		}
		case 'complete':
			decodeState.complete = true;
			setStatus('Decode complete.');
			break;
		case 'error':
			// Non-fatal: shown but decoding continues listening.
			console.warn('Decoder:', data.message);
			break;
	}
}

function resetDecodeState() {
	decodeState = { sawMode: false, complete: false, haveImage: false };
}

//---------- Microphone path ----------//
let micCtx = null;
let micStream = null;
let micNode = null;

async function startMic() {
	resetDecodeState();
	try {
		micCtx = new AudioContext();
		await micCtx.audioWorklet.addModule('./sstv-decoder.js');
		micStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			},
		});
		const source = micCtx.createMediaStreamSource(micStream);
		micNode = new AudioWorkletNode(micCtx, 'sstv-decoder', {
			channelCount: 1,
			channelCountMode: 'explicit',
			channelInterpretation: 'speakers',
		});
		micNode.port.onmessage = (e) => handlePortMessage(e.data);
		source.connect(micNode);
		// Keep the graph pulling; route through a muted gain so nothing is heard.
		const mute = micCtx.createGain();
		mute.gain.value = 0;
		micNode.connect(mute).connect(micCtx.destination);

		setStatus(STATUS_TEXT.listening);
		micButton.disabled = true;
		stopButton.disabled = false;
		audioPicker.disabled = true;
	} catch (err) {
		setStatus('Microphone unavailable: ' + err.message);
		await stopMic();
	}
}

async function stopMic() {
	if (micNode) { try { micNode.port.postMessage({ type: 'reset' }); } catch (e) {} micNode.disconnect(); micNode = null; }
	if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
	if (micCtx) { try { await micCtx.close(); } catch (e) {} micCtx = null; }
	micButton.disabled = false;
	stopButton.disabled = true;
	audioPicker.disabled = false;
}

micButton.onclick = () => startMic();
stopButton.onclick = () => stopMic();

//---------- File path ----------//
// decodeAudioData resamples to its context's rate, so pick the rate explicitly.
const FILE_DECODE_RATE = 48000;

async function decodeFile(file) {
	resetDecodeState();
	saveButton.disabled = true;
	setStatus('Loading audio file...');

	const arrayBuffer = await file.arrayBuffer();

	// Stage 1: decode/resample to a known rate via a throwaway context.
	const probeCtx = new OfflineAudioContext(1, 1, FILE_DECODE_RATE);
	let decoded;
	try {
		decoded = await probeCtx.decodeAudioData(arrayBuffer);
	} catch (err) {
		setStatus('Could not decode audio file.');
		return;
	}

	// Stage 2: real offline render through the worklet. Add a tail so the final
	// line boundary is crossed.
	const tailFrames = Math.ceil(0.5 * FILE_DECODE_RATE);
	const renderCtx = new OfflineAudioContext(1, decoded.length + tailFrames, FILE_DECODE_RATE);
	await renderCtx.audioWorklet.addModule('./sstv-decoder.js');

	const src = renderCtx.createBufferSource();
	src.buffer = decoded;
	const node = new AudioWorkletNode(renderCtx, 'sstv-decoder', {
		channelCount: 1,
		channelCountMode: 'explicit',
		channelInterpretation: 'speakers',
	});
	node.port.onmessage = (e) => handlePortMessage(e.data);
	src.connect(node);
	const mute = renderCtx.createGain();
	mute.gain.value = 0;
	node.connect(mute).connect(renderCtx.destination);

	setStatus('Decoding...');
	src.start();
	await renderCtx.startRendering();

	// Let any port messages queued late in the render dispatch before we
	// classify the outcome.
	await drainPortMessages();

	if (!decodeState.sawMode) {
		setStatus('No SSTV transmission detected in file.');
	} else if (!decodeState.complete) {
		setStatus('Transmission incomplete — image may be truncated.');
	} else {
		setStatus('Decode complete.');
	}
}

// Yield a few times so queued MessagePort callbacks run.
function drainPortMessages() {
	return new Promise((resolve) => {
		const ch = new MessageChannel();
		ch.port1.onmessage = () => setTimeout(() => setTimeout(resolve, 0), 0);
		ch.port2.postMessage(0);
	});
}

audioPicker.addEventListener('change', (e) => {
	const file = e.target.files[0];
	if (file) decodeFile(file);
});

//---------- Save image ----------//
saveButton.onclick = () => {
	if (!decodeState.haveImage) return;
	canvas.toBlob((blob) => {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'sstv_decoded.png';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}, 'image/png');
};
