const input = document.querySelector('#file');
const drop = document.querySelector('#drop');
const backdrop = document.querySelector('#dialog-backdrop');
const status = document.querySelector('#status');
const bar = document.querySelector('#bar');
const percent = document.querySelector('#percent');
const message = document.querySelector('#message');
const result = document.querySelector('#result');
const openDialog = document.querySelector('#open-dialog');
const closeDialog = document.querySelector('#close-dialog');
const songForm = document.querySelector('#song-form');
const acrHost = document.querySelector('#acr-host');
const acrAccessKey = document.querySelector('#acr-access-key');
const acrAccessSecret = document.querySelector('#acr-access-secret');
const acrPin = document.querySelector('#acr-pin');
const songStatus = document.querySelector('#song-status');
const songResults = document.querySelector('#song-results');
let downloadUrl = '';
let ffmpeg;
const maxFileSize = 500 * 1024 * 1024;
const defaultAcrCloudSettings = {
	host: 'identify-ap-southeast-1.acrcloud.com',
	accessKey: '1b9ab8d5b1ad92a7fcd88b9443a7b36b',
	accessSecret: 'V5GthjHFwQzjljFBorrfaTxWvHStqnLTxP76aWX5'
};

function setDialog(open) {
	backdrop.classList.toggle('open', open);
	document.body.style.overflow = open ? 'hidden' : '';
	if (open) closeDialog.focus();
	else openDialog.focus();
}

openDialog.addEventListener('click', () => setDialog(true));
document.querySelector('#cancel-dialog').addEventListener('click', () => setDialog(false));
closeDialog.addEventListener('click', () => setDialog(false));
backdrop.addEventListener('click', event => {
	if (event.target === backdrop) setDialog(false);
});
document.addEventListener('keydown', event => {
	if (event.key === 'Escape' && backdrop.classList.contains('open')) setDialog(false);
});
document.querySelector('#browse').addEventListener('click', () => input.click());

['dragenter', 'dragover'].forEach(eventName => drop.addEventListener(eventName, event => {
	event.preventDefault();
	drop.classList.add('over');
}));
['dragleave', 'drop'].forEach(eventName => drop.addEventListener(eventName, event => {
	event.preventDefault();
	drop.classList.remove('over');
}));
drop.addEventListener('drop', event => handle(event.dataTransfer.files[0]));
input.addEventListener('change', event => handle(event.target.files[0]));

function updateProgress(value, text) {
	bar.style.width = `${value}%`;
	percent.textContent = `${value}%`;
	message.textContent = text;
}

async function handle(file) {
	if (!file) return;
	if (file.size > maxFileSize) {
		document.querySelector('#dialog-description').textContent = 'That file is larger than 500 MB. Please choose a smaller audio file.';
		return;
	}

	setDialog(false);
	status.classList.add('show');
	document.querySelector('#name').textContent = file.name;
	document.querySelector('#size').textContent = `${(file.size / 1048576).toFixed(1)} MB`;
	result.textContent = '';
	songResults.innerHTML = '';
	songStatus.textContent = '';
	loadAcrCloudSettings();
	if (downloadUrl) URL.revokeObjectURL(downloadUrl);
	updateProgress(8, 'Reading file data…');

	const source = await file.arrayBuffer();
	try {
		updateProgress(25, 'Starting deep audio repair…');
		const recovered = await recoverWithFfmpeg(file);
		if (recovered) {
			showDownload(recovered, file.name);
			updateProgress(100, 'Audio repaired and normalized');
			return;
		}
	} catch (ffmpegError) {
		console.warn('Deep audio repair unavailable', ffmpegError);
	}

	try {
		updateProgress(55, 'Checking audio structure…');
		const audioBuffer = await decodeAudio(source);
		updateProgress(78, 'Rebuilding clean audio stream…');
		const recovered = audioBufferToWav(audioBuffer);
		updateProgress(92, 'Preparing recovered file…');
		showDownload(recovered, file.name);
		updateProgress(100, 'Recovery complete');
	} catch (decodeError) {
		if (isWav(file)) {
			try {
				updateProgress(42, 'Repairing WAV container…');
				const repaired = repairWav(source);
				if (repaired) {
					const audioBuffer = await decodeAudio(repaired);
					const recovered = audioBufferToWav(audioBuffer);
					showDownload(recovered, file.name);
					updateProgress(100, 'WAV repaired and normalized');
					return;
				}
			} catch (repairError) {
				console.warn('WAV container repair failed', repairError);
			}
		}
		updateProgress(100, 'Recovery could not be completed');
		result.textContent = 'This file could not be repaired. Check your internet connection for the repair engine, then try again with another copy.';
	}
}

async function recoverWithFfmpeg(file) {
	if (!window.FFmpegWASM || !window.FFmpegUtil) return null;
	if (!ffmpeg) {
		ffmpeg = new window.FFmpegWASM.FFmpeg();
		ffmpeg.on('progress', ({ progress }) => updateProgress(45 + Math.round(progress * 40), 'Recovering audio frames…'));
		const coreBaseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
		await ffmpeg.load({
			coreURL: await window.FFmpegUtil.toBlobURL(`${coreBaseUrl}/ffmpeg-core.js`, 'text/javascript'),
			wasmURL: await window.FFmpegUtil.toBlobURL(`${coreBaseUrl}/ffmpeg-core.wasm`, 'application/wasm')
		});
	}

	const inputName = `damaged-${Date.now()}${getExtension(file.name)}`;
	const outputName = `recovered-${Date.now()}.wav`;
	try {
		await ffmpeg.writeFile(inputName, await window.FFmpegUtil.fetchFile(file));
		await ffmpeg.exec([
			'-hide_banner', '-nostdin', '-y',
			'-err_detect', 'ignore_err',
			'-fflags', '+discardcorrupt+genpts',
			'-i', inputName,
			'-map', '0:a:0?', '-vn', '-sn', '-dn',
			'-af', 'aresample=async=1000:first_pts=0',
			'-map_metadata', '-1',
			'-avoid_negative_ts', 'make_zero',
			'-c:a', 'pcm_s16le', '-f', 'wav', outputName
		]);
		const data = await ffmpeg.readFile(outputName);
		if (!data || data.length < 44) return null;
		return new Blob([data], { type: 'audio/wav' });
	} finally {
		try { await ffmpeg.deleteFile(inputName); } catch (error) { console.warn('Input cleanup failed', error); }
		try { await ffmpeg.deleteFile(outputName); } catch (error) { console.warn('Output cleanup failed', error); }
	}
}

function getExtension(name) {
	const match = name.match(/\.[^.]+$/);
	return match ? match[0].toLowerCase() : '.bin';
}

async function decodeAudio(source) {
	const AudioContextClass = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextClass) throw new Error('Web Audio is not supported');
	const context = new AudioContextClass();
	try {
		return await context.decodeAudioData(source.slice(0));
	} finally {
		await context.close();
	}
}

function audioBufferToWav(audioBuffer, startFrame = 0, endFrame = audioBuffer.length) {
	const channels = audioBuffer.numberOfChannels;
	const sampleRate = audioBuffer.sampleRate;
	const frameCount = Math.max(0, endFrame - startFrame);
	const bytesPerSample = 2;
	const buffer = new ArrayBuffer(44 + frameCount * channels * bytesPerSample);
	const view = new DataView(buffer);
	writeString(view, 0, 'RIFF');
	view.setUint32(4, 36 + frameCount * channels * bytesPerSample, true);
	writeString(view, 8, 'WAVE');
	writeString(view, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true);
	view.setUint16(32, channels * bytesPerSample, true);
	view.setUint16(34, 16, true);
	writeString(view, 36, 'data');
	view.setUint32(40, frameCount * channels * bytesPerSample, true);

	let offset = 44;
	for (let frame = 0; frame < frameCount; frame += 1) {
		for (let channel = 0; channel < channels; channel += 1) {
			const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[startFrame + frame]));
			view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
			offset += 2;
		}
	}
	return new Blob([buffer], { type: 'audio/wav' });
}

function isWav(file) {
	return file.type === 'audio/wav' || /\.wav$/i.test(file.name);
}

function repairWav(source) {
	const view = new DataView(source);
	if (source.byteLength < 12 || readString(view, 0, 4) !== 'RIFF' || readString(view, 8, 4) !== 'WAVE') return null;
	let offset = 12;
	let dataStart = -1;
	let hasFormat = false;
	while (offset + 8 <= source.byteLength) {
		const chunkSize = view.getUint32(offset + 4, true);
		const chunkId = readString(view, offset, 4);
		if (chunkId === 'fmt ') hasFormat = true;
		if (chunkId === 'data') {
			dataStart = offset + 8;
			break;
		}
		const chunkEnd = offset + 8 + chunkSize + (chunkSize % 2);
		if (chunkEnd > source.byteLength) break;
		offset = chunkEnd;
	}
	if (!hasFormat || dataStart < 0 || dataStart >= source.byteLength) return null;
	const dataSize = source.byteLength - dataStart;
	const repaired = source.slice(0);
	const repairedView = new DataView(repaired);
	repairedView.setUint32(4, source.byteLength - 8, true);
	repairedView.setUint32(dataStart - 4, dataSize, true);
	return repaired;
}

function writeString(view, offset, value) {
	for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function readString(view, offset, length) {
	let value = '';
	for (let index = 0; index < length; index += 1) value += String.fromCharCode(view.getUint8(offset + index));
	return value;
}

function showDownload(blob, originalName) {
	window.repairedAudio = blob;
	downloadUrl = URL.createObjectURL(blob);
	const baseName = originalName.replace(/\.[^/.]+$/, '');
	result.innerHTML = '';
	const link = document.createElement('a');
	link.className = 'primary download';
	link.href = downloadUrl;
	link.download = `${baseName}-recovered.wav`;
	link.textContent = 'Download recovered WAV';
	result.appendChild(link);
}

songForm.addEventListener('submit', event => {
	event.preventDefault();
	saveAcrCloudSettings();
	identifyAuthorizedAudio();
});

async function identifyAuthorizedAudio() {
	const pin = acrPin.value.trim();
	if (!/^\d{4}$/.test(pin)) {
		songStatus.textContent = 'Enter exactly four digits for the authorization PIN.';
		return;
	}
	if (!window.repairedAudio) {
		songStatus.textContent = 'Repair an audio file first.';
		return;
	}
	try {
		const pinHash = await hashPin(pin);
		const savedPinHash = localStorage.getItem('acrcloud-pin-hash');
		if (savedPinHash && savedPinHash !== pinHash) {
			songStatus.textContent = 'Incorrect authorization PIN.';
			return;
		}
		if (!savedPinHash) localStorage.setItem('acrcloud-pin-hash', pinHash);
		identifyAudio(window.repairedAudio);
	} catch (error) {
		songStatus.textContent = error.message;
	}
}

async function hashPin(pin) {
	if (!window.crypto?.subtle) throw new Error('PIN protection requires a secure browser context.');
	const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function identifyAudio(audioBlob) {
	const host = acrHost.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
	const accessKey = acrAccessKey.value.trim();
	const accessSecret = acrAccessSecret.value.trim();
	if (!host || !accessKey || !accessSecret) {
		songStatus.textContent = 'Enter the ACRCloud host, access key, and access secret.';
		return;
	}
	songStatus.textContent = 'Listening for a match…';
	songResults.innerHTML = '';
	try {
		const audioBuffer = await decodeAudio(await audioBlob.arrayBuffer());
		const windowSize = audioBuffer.sampleRate * 20;
		const totalWindows = Math.ceil(audioBuffer.length / windowSize);
		let windowNumber = 0;
		const matches = [];
		const matchKeys = new Set();
		for (let startFrame = 0; startFrame < audioBuffer.length; startFrame += windowSize) {
			windowNumber += 1;
			const endFrame = Math.min(audioBuffer.length, startFrame + windowSize);
			const recognitionSample = audioBufferToWav(audioBuffer, startFrame, endFrame);
			songStatus.textContent = `Listening to clip ${windowNumber} of ${totalWindows} (${Math.floor(startFrame / audioBuffer.sampleRate)}–${Math.ceil(endFrame / audioBuffer.sampleRate)} seconds)…`;
			const payload = await requestAcrCloudSample(host, accessKey, accessSecret, recognitionSample, startFrame);
			if (payload.status?.code === 0 && payload.metadata?.music?.length) {
				payload.metadata.music.forEach(song => {
					const key = `${song.title || ''}|${song.artists?.map(item => item.name).join(',') || ''}`;
					if (!matchKeys.has(key)) {
						matchKeys.add(key);
						matches.push(song);
					}
				});
			}
		}
		if (!matches.length) throw new Error('No song match was found in the uploaded audio.');
		renderSongResults(matches);
	} catch (error) {
		songStatus.textContent = error instanceof TypeError
			? 'The web search is unavailable. Check your internet connection.'
			: error.message;
	}

	async function requestAcrCloudSample(host, accessKey, accessSecret, sample, startFrame) {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const signature = await createAcrCloudSignature(accessSecret, timestamp, accessKey);
		const formData = new FormData();
		formData.append('access_key', accessKey);
		formData.append('sample_bytes', sample.size.toString());
		formData.append('timestamp', timestamp);
		formData.append('signature', signature);
		formData.append('data_type', 'audio');
		formData.append('signature_version', '1');
		formData.append('sample', sample, `repaired-audio-${Math.floor(startFrame)}.wav`);
		const response = await fetch(`https://${host}/v1/identify`, { method: 'POST', body: formData });
		if (!response.ok) throw new Error(`Search failed (${response.status})`);
		return response.json();
	}
}
async function createAcrCloudSignature(accessSecret, timestamp, accessKey) {
	if (!window.crypto?.subtle) throw new Error('Secure browser cryptography is unavailable. Open this page through a local web server.');
	const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`;
	const key = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(accessSecret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const digest = await window.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign));
	return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function loadAcrCloudSettings() {
	try {
		const settings = JSON.parse(localStorage.getItem('acrcloud-settings') || '{}');
		acrHost.value = settings.host || defaultAcrCloudSettings.host;
		acrAccessKey.value = settings.accessKey || defaultAcrCloudSettings.accessKey;
		acrAccessSecret.value = settings.accessSecret || defaultAcrCloudSettings.accessSecret;
	} catch (error) {
		console.warn('ACRCloud settings could not be loaded', error);
	}
}

function saveAcrCloudSettings() {
	localStorage.setItem('acrcloud-settings', JSON.stringify({
		host: acrHost.value.trim(),
		accessKey: acrAccessKey.value.trim(),
		accessSecret: acrAccessSecret.value.trim()
	}));
}

function renderSongResults(songs) {
	songStatus.textContent = `${songs.length} possible song${songs.length === 1 ? '' : 's'} found`;
	songs.forEach(renderSongResult);
}

function renderSongResult(song) {
	const row = document.createElement('div');
	row.className = 'song-result';
	const details = document.createElement('div');
	const title = document.createElement('strong');
	title.textContent = song.title || 'Unknown title';
	const artist = document.createElement('small');
	artist.textContent = song.artists?.map(item => item.name).join(', ') || 'Unknown artist';
	details.append(title, artist);
	if (song.album?.name) {
		const album = document.createElement('small');
		album.textContent = song.album.name;
		details.appendChild(album);
	}
	row.appendChild(details);
	const sourceUrl = song.external_metadata?.spotify?.track?.external_urls?.spotify || song.external_metadata?.applemusic?.url;
	if (sourceUrl) {
		const source = document.createElement('a');
		source.href = sourceUrl;
		source.target = '_blank';
		source.rel = 'noopener noreferrer';
		source.textContent = 'Open source';
		row.appendChild(source);
	}
	songResults.appendChild(row);
}

