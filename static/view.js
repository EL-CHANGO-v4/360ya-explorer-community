const source = document.querySelector('#ya-player-texture');
const projection = document.querySelector('#ya-demo-mode');
const controls = document.querySelector('.preview-controls');
const status = document.querySelector('#ya-demo-status');
const params = new URLSearchParams(location.search);
const path = params.get('path') || '';
const photo = params.get('kind')==='photo';
const initial = !photo && path.startsWith('panorama/') ? '360' : '2d';
const mediaUrl = '/explorer/api?' + new URLSearchParams({op:'media', path});
window.HOME_DEMO_PANORAMA = {
    format: initial,
    disableDiagnostics: true,
    audioAllowed: false,
    controlsHost: controls
};

new ResizeObserver(() => {
    document.querySelector('#viewer').style.setProperty('--preview-controls-height',controls.offsetHeight+'px');
}).observe(controls);

// The universal player's gesture listeners capture pointers on the viewer.
for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
    controls.addEventListener(event, event => event.stopPropagation());
}

function selectButtons() {
    controls.querySelectorAll('[data-mode]').forEach(button => {
        button.setAttribute('aria-pressed',String(button.dataset.mode===projection.value));
    });
}
new MutationObserver(selectButtons).observe(status,{childList:true,subtree:true});
controls.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click',() => {
    projection.value = button.dataset.mode;
    projection.dispatchEvent(new Event('change'));
    selectButtons();
}));
document.querySelector('#preview-vr').addEventListener('click', () => {
    controls.querySelector('[data-ya-view=vr]')?.click();
});
const fullscreen = document.querySelector('#preview-full');
fullscreen.addEventListener('click',async () => {
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.querySelector('#viewer').requestFullscreen();
    } catch { status.textContent = 'Pantalla completa no disponible.'; }
});
document.addEventListener('fullscreenchange',() => {
    fullscreen.textContent = document.fullscreenElement?'□ Pantalla normal':'⛶ Pantalla completa';
});
const audio = document.querySelector('#preview-audio');
function syncAudio() {
    const enabled = !photo && !source.muted && source.volume>0;
    audio.textContent = enabled?'Audio On':'Audio Off';
    audio.setAttribute('aria-pressed',String(enabled));
}
audio.disabled = photo;
if (photo) audio.title = 'Las fotografías no tienen audio';
audio.addEventListener('click',() => {
    source.muted = !source.muted;
    if (!source.muted && source.volume===0) source.volume = 1;
    syncAudio();
});
source.addEventListener('volumechange',syncAudio);
source.addEventListener('error', () => {
    status.textContent = 'No se pudo reproducir el archivo. Verificá el formato y la sesión.';
});
const play = document.querySelector('#preview-play');
function syncPlayback() {
    const playing = !source.paused && !source.ended;
    play.textContent = playing ? 'Pausar' : 'Reproducir';
    play.setAttribute('aria-pressed', String(playing));
}
for (const event of ['play', 'pause', 'ended']) source.addEventListener(event, syncPlayback);
play.addEventListener('click', async () => {
    if (!source.paused && !source.ended) {
        source.pause();
        return;
    }
    try {
        await source.play();
    } catch {
        status.textContent = 'No se pudo iniciar la reproducción.';
    }
});
play.hidden = photo;

if (photo) {
    source.muted = true;
    const image = new Image();
    image.onload = async () => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d');
            context.drawImage(image,0,0,canvas.width,canvas.height);
            const stream = canvas.captureStream(1);
            const track = stream.getVideoTracks()[0];
            source.srcObject = stream;
            const playing = source.play();
            context.drawImage(image,0,0,canvas.width,canvas.height);
            track.requestFrame?.();
            await playing;
            window.addEventListener('pagehide',() => track.stop(),{once:true});
        } catch {
            status.textContent = 'Este navegador no pudo abrir la fotografía en el reproductor.';
        }
    };
    image.onerror = () => { status.textContent = 'No se pudo abrir la fotografía.'; };
    image.src = mediaUrl;
} else {
    source.src = mediaUrl;
}
projection.value = initial;
selectButtons();
syncAudio();
