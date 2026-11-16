(()=>{'use strict';
// Motor visual único: la autorización y recepción de señal son externas.
const isDemo=!!window.HOME_DEMO_PANORAMA;
const isPublic=!isDemo&&!!window.HOME_PUBLIC_PANORAMA;
const cfg=isDemo?window.HOME_DEMO_PANORAMA:(isPublic?window.HOME_PUBLIC_PANORAMA:window.HOME_LIVE);
const prefix=isDemo?'ya-demo':(isPublic?'public':'home491');
const source=document.getElementById(isDemo?'ya-player-texture':(isPublic?(cfg?.operator?'preview':'video'):'video'));
const stage=document.getElementById(prefix+'-stage');
const select=document.getElementById(prefix+'-mode');
const full=document.getElementById(prefix+'-full');
const vr=document.getElementById(prefix+'-vr');
const status=document.getElementById(isDemo?'ya-demo-status':(isPublic?'public-panorama-status':'home491-status'));
if(!cfg||!source||!stage||!select||!full||!vr)return;
let scene=null,texture=null,sphere=null,mode='2d',loading=null,seq=0,vrAvailable=false;
// WebXR: una sola escala por renderizador, antes de la sesión. Nunca bloquear entrada a VR.
// Quest: compositor XR para video equirectangular, sin otro video ni decodificador.
// Composición XR automática para fuente panorámica 360°; una sola decodificación.
const deviceProfile=(()=>{
 const ua=navigator.userAgent||'';
 const quest=/oculusbrowser|meta quest|quest[ /][23]/i.test(ua);
 const mobile=/android|iphone|ipad|ipod|mobile/i.test(ua)&&!quest;
 return Object.freeze({kind:quest?'quest':mobile?'cel':'pc',quest,mobile});
})();
const xrNativeEnabled=true; // Media Layers sólo si el compositor WebXR expone capas compatibles.

let mediaXRSession=null,mediaXRLayer=null,mediaXRSphereHidden=false;
let mediaXRReportedSession=null,mediaXRReportedStatus='';
let xrPresentationRoute='no activa',xrFramebuffer='no disponible';
let xrTrialGeneration=0;
let xrAttemptSession=null;
function reportXRMedia(status,details=''){
 const session=scene?.renderer?.xr?.getSession?.()||null;
 if(mediaXRReportedSession===session&&mediaXRReportedStatus===status)return;
 xrPresentationRoute=status==='active'?'media-layer':status==='fallback'?'webgl-fallback':status;
 const state=session?.renderState;
 xrFramebuffer=state?.baseLayer?`${state.baseLayer.framebufferWidth||'?'}x${state.baseLayer.framebufferHeight||'?'}`:(state?.layers?.length?'projection-layers':'no disponible');
 console.info('[360ya WebXR Media Layers]',status,details);
 mediaXRReportedSession=session;mediaXRReportedStatus=status;
}
function restoreXRMediaLayer(){
 // On exit WebXR owns the session teardown. Never updateRenderState on a dying session.
 xrTrialGeneration++;
 if(sphere&&mediaXRSphereHidden){sphere.object3D.visible=true;mediaXRSphereHidden=false;}
 mediaXRSession=null;mediaXRLayer=null;xrAttemptSession=null;
}
function afterXRFrames(session,count=3){
 return new Promise(resolve=>{
  let done=false;
  const finish=()=>{if(done)return;done=true;clearTimeout(limit);resolve();};
  const limit=setTimeout(finish,1600);
  const step=()=>{
   if(scene?.renderer?.xr?.getSession?.()!==session||--count<=0)return finish();
   try{session.requestAnimationFrame(step);}catch(_){finish();}
  };
  try{session.requestAnimationFrame(step);}catch(_){finish();}
 });
}
async function tryXRMediaLayer(){
 if(!xrNativeEnabled||mode!=='360')return;
 const renderer=scene?.renderer,session=renderer?.xr?.getSession?.();
 if(!session||!sphere||!source||mediaXRSession===session||xrAttemptSession===session)return;
 if(!source.videoWidth||!source.videoHeight||source.readyState<2)return;
 xrAttemptSession=session; // Una sola tentativa por sesión; sin reintentos costosos.
 const generation=++xrTrialGeneration;
 if(typeof XRMediaBinding==='undefined'){reportXRMedia('unavailable','XRMediaBinding no expuesto');return;}
 if(!session.enabledFeatures?.includes('layers')){reportXRMedia('unavailable','La sesión no habilitó layers');return;}
 const space=renderer.xr.getReferenceSpace?.();
 if(!space){reportXRMedia('fallback','Referencia XR no disponible');return;}
 const layers=session.renderState.layers;
 if(!layers?.length){
  // Three/A-Frame suele usar XRWebGLLayer (baseLayer). No se puede añadir
  // XRMediaLayer sin migrar el renderer a XRProjectionLayer: WebXR prohíbe
  // mezclar baseLayer y layers y hacerlo a ciegas deja el casco negro.
  reportXRMedia('fallback',session.renderState.baseLayer
   ?'Compositor baseLayer de Three.js; requiere renderer compatible con XRProjectionLayer'
   :'El compositor no expone XRProjectionLayer');return;
 }
 let layer=null;
 try{
  layer=new XRMediaBinding(session).createEquirectLayer(source,{
   space,layout:cfg.stereoLayout==='top-bottom'?'stereo-top-bottom':cfg.stereoLayout==='left-right'?'stereo-left-right':'mono',radius:0,
   centralHorizontalAngle:mode==='180'?Math.PI:2*Math.PI,
   upperVerticalAngle:Math.PI/2,lowerVerticalAngle:-Math.PI/2
  });
  // XR composition order: projection behind, video in front.
  session.updateRenderState({layers:[...layers,layer]});
  await afterXRFrames(session);
  if(generation!==xrTrialGeneration||renderer.xr.getSession()!==session)return;
  if(!session.renderState.layers?.includes(layer))throw Error('Media Layer no activa tras fotogramas XR');
  mediaXRSession=session;mediaXRLayer=layer;
  sphere.object3D.visible=false;mediaXRSphereHidden=true;
  reportXRMedia('active',`${source.videoWidth}x${source.videoHeight}; XRProjectionLayer → VIDEO`);
 }catch(error){
  reportXRMedia('fallback',String(error));
  if(sphere){sphere.object3D.visible=true;mediaXRSphereHidden=false;}
  // Do not touch the render state on XR session teardown.
  if(generation===xrTrialGeneration&&renderer.xr.getSession()===session&&layer){
   try{const current=session.renderState.layers;
    if(current?.includes(layer))session.updateRenderState({layers:current.filter(item=>item!==layer)});
   }catch(e){console.warn('[360ya WebXR Media Layers] fallback cleanup',e);}
  }
 }
}
const xrConfigured=new WeakSet();
function configureXRSharpness(){
 const renderer=scene?.renderer;
 const xr=renderer?.xr;
 if(!renderer||!xr||xr.isPresenting||xrConfigured.has(renderer)||typeof xr.setFramebufferScaleFactor!=='function')return;
 try{
  // Solo se ajusta el framebuffer estereoscópico, NO la resolución física
  // del visor. La escala se fija antes de entrar en VR.
  xr.setFramebufferScaleFactor(deviceProfile.quest?1.40:deviceProfile.mobile?1.12:1.0);
  xrConfigured.add(renderer);
 }
 catch(_){/* El navegador puede rechazar supersampling; conservar entrada VR nativa. */}
}

const fixedMode=!isDemo?(cfg.format==='180'?'180':cfg.format==='360'?'360':'2d'):null;
let zoom=1,panX=0,panY=0;
const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));
function applyZoom(){
 const camera=scene?.camera;
 if(camera){
  camera.zoom=mode==='2d'||scene.is('vr-mode')?1:zoom;
  camera.updateProjectionMatrix();
 }
 if(mode==='2d'&&zoom>1){
  const width=source.clientWidth,height=source.clientHeight;
  const fit=Math.min(width/(source.videoWidth||width||1),height/(source.videoHeight||height||1));
  const limitX=Math.max(0,((source.videoWidth||width)*fit*zoom-width)/2);
  const limitY=Math.max(0,((source.videoHeight||height)*fit*zoom-height)/2);
  panX=clamp(panX,-limitX,limitX);panY=clamp(panY,-limitY,limitY);
  source.style.transform='translate('+panX+'px,'+panY+'px) scale('+zoom+')';
 }else source.style.transform='';
 const reset=viewBar?.querySelector('[data-ya-zoom="reset"]');
 if(reset)reset.textContent=Math.round(zoom*100)+' %';
}
function changeZoom(value){
 if(scene?.is('vr-mode'))return;
 zoom=clamp(value,1,4);
 if(zoom===1)panX=panY=0;
 applyZoom();
}
let resizeObserver=null;
let resizeQueued=false;
let lastStageWidth=0,lastStageHeight=0;

// v5.1.81: barra anclada a un contenedor estable; el video y su transporte permanecen intactos.
let viewBar=null;
let controlsHideTimer=0;
let controlsVisible=false;
function showViewControls(temporary=false){
 if(!viewBar||cfg.controlsHost)return;
 clearTimeout(controlsHideTimer);controlsVisible=true;viewBar.style.opacity='1';viewBar.style.visibility='visible';viewBar.style.pointerEvents='auto';
 if(temporary)controlsHideTimer=setTimeout(()=>{if(!viewBar?.matches(':hover')&&!viewBar?.contains(document.activeElement))hideViewControls();},4000);
}
function hideViewControls(){
 clearTimeout(controlsHideTimer);controlsHideTimer=0;controlsVisible=false;
 if(!viewBar||viewBar.contains(document.activeElement)||viewBar.matches(':hover'))return;
 viewBar.style.opacity='0';viewBar.style.visibility='hidden';viewBar.style.pointerEvents='none';
}
function onControlsPointerMove(e){if(e.pointerType==='mouse'||e.pointerType==='pen')showViewControls();}
function onControlsPointerLeave(e){if((e.pointerType==='mouse'||e.pointerType==='pen')&&!viewBar?.contains(e.relatedTarget))hideViewControls();}
function onControlsTouch(e){
 // Un mismo toque burbujea desde stage hacia viewHost: procesarlo una sola vez.
 if(e.currentTarget===viewHost&&stage.contains(e.target))return;
 if(e.pointerType!=='touch'||viewBar?.contains(e.target))return;
 if(controlsVisible)hideViewControls();else showViewControls(true);
}

const demoViewer=isDemo?document.getElementById('viewer'):null;
const demoVideoOriginal=isDemo?{parent:source.parentNode,next:source.nextSibling,style:source.getAttribute('style')}:null;
const sourceOriginalStyle=source.getAttribute('style');
const stageOriginalParent=stage.parentNode;
const stageOriginalNext=stage.nextSibling;
const stageOriginalStyle=stage.getAttribute('style');
// Un solo contenedor para la imagen y la barra, también en pantalla completa.
const viewHost=isDemo?demoViewer:source.parentElement;
if(cfg.audioAllowed&&viewHost){
 viewHost.tabIndex=0;
 viewHost.addEventListener('focus',()=>showViewControls());
}
if(isDemo&&demoViewer)demoViewer.appendChild(source);
// Los eventos se escuchan en ambas superficies porque stage puede entrar en fullscreen.
for(const host of new Set([viewHost,stage])){
 if(!host)continue;
 host.addEventListener('pointermove',onControlsPointerMove);
 host.addEventListener('pointerleave',onControlsPointerLeave);
 host.addEventListener('pointerdown',onControlsTouch);
}
// Los controles antiguos siguen existiendo para compatibilidad, pero no se muestran.
full.style.setProperty('display','none','important');
vr.style.setProperty('display','none','important');
if(viewHost){
 if(getComputedStyle(viewHost).position==='static')viewHost.style.position='relative';
 if(stage.parentNode!==viewHost)viewHost.appendChild(stage);
 if(!isDemo)stage.style.cssText='position:absolute;inset:0;width:100%;height:100%;min-height:0;max-height:none;overflow:hidden;z-index:1';
}
let audioButton, audioStream, audioStreamListeners, audioTrackListeners, audioHint, audioReceived=false;
const audioEvents=new AbortController();
function audioAvailable(){
 if(source.srcObject){
  return source.srcObject.getAudioTracks().some(track=>track.readyState==='live'&&!track.muted&&track.enabled);
 }
 return source.audioTracks?.length
  ? Array.from(source.audioTracks).some(track=>track.enabled)
  : audioHint===true||Boolean(source.webkitAudioDecodedByteCount);
}
function syncAudioButton(){
 if(!audioButton)return;
 const available=audioAvailable();
 audioReceived ||= available;
 const audible=available&&!source.muted&&source.volume>0&&!source.paused;
 const label=!available?'Audio no disponible':audible?'Silenciar audio':'Activar audio';
 // The SDP can accept an audio receiver even when the publisher has only video.
 const liveTracks=source.srcObject?.getAudioTracks().some(track=>track.readyState==='live');
 const videoOnly=source.srcObject&&source.videoWidth>0&&(!liveTracks||!audioReceived);
 audioButton.hidden=!available&&(audioHint===false||videoOnly);
 audioButton.disabled=!available;
 audioButton.title=label;
 audioButton.setAttribute('aria-label',label);
 audioButton.setAttribute('aria-pressed',String(audible));
 audioButton.textContent=audible?'🔊︎':'🔇︎';
}
function watchAudioTracks(){
 audioTrackListeners?.abort();
 audioTrackListeners=new AbortController();
 for(const track of audioStream?.getAudioTracks()??[]){
  for(const event of ['mute','unmute','ended'])track.addEventListener(event,syncAudioButton,{signal:audioTrackListeners.signal});
 }
 syncAudioButton();
}
function updateAudio(available){
 if(!cfg.audioAllowed)return;
 if(available!==undefined)audioHint=available;
 if(audioStream!==source.srcObject){
  audioStreamListeners?.abort();
  audioStream=source.srcObject;
  audioReceived=false;
  audioStreamListeners=new AbortController();
  for(const event of ['addtrack','removetrack'])audioStream?.addEventListener(event,watchAudioTracks,{signal:audioStreamListeners.signal});
 }
 if(audioStream)watchAudioTracks();
 else syncAudioButton();
}
function ensureViewBar(){
 if(viewBar)return;
 viewBar=document.createElement('div');viewBar.className='ya-view-controls';
 viewBar.setAttribute('aria-label','Controles de visualización');
 viewBar.addEventListener('pointerenter',()=>showViewControls());
 viewBar.addEventListener('pointerleave',e=>{if(!viewHost?.contains(e.relatedTarget)&&e.relatedTarget!==stage)hideViewControls();});
 viewBar.addEventListener('focusin',()=>showViewControls());
 viewBar.addEventListener('focusout',()=>setTimeout(()=>{if(!viewBar?.contains(document.activeElement))hideViewControls();},0));
 viewBar.style.cssText='position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;flex-wrap:wrap;justify-content:center;gap:5px;max-width:calc(100% - 20px);padding:6px;background:#06131edb;border-radius:10px;z-index:2147483646;pointer-events:none;opacity:0;visibility:hidden';
 // Evita que el gesto de rotación del visor capture pulsaciones de los botones.
 for(const event of ['pointerdown','pointermove','pointerup','click','touchstart','touchend'])viewBar.addEventListener(event,e=>e.stopPropagation());
 for(const [key,label] of [['2d','2D'],['180','180°'],['360','360°'],['vr','VR']]){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.yaView=key;
  button.style.cssText='margin:0;padding:7px 11px;min-height:36px;border:1px solid #72909e;border-radius:7px;background:#19313f;color:white;font:600 13px system-ui;cursor:pointer';
  button.addEventListener('click',async()=>{
   if(key!=='vr'){await change(key);return;}
   if(mode==='2d'){
    await change(cfg.format==='180'?'180':'360');
    say('Vista panorámica preparada. Pulsá VR para entrar al visor.');
    return;
   }
   if(!scene?.hasLoaded){say('Esperá a que cargue la vista panorámica y pulsá VR.');return;}
   // Se llama directamente desde el gesto del usuario; la disponibilidad depende de WebXR.
   try{if(scene.is('vr-mode'))await scene.exitVR();else{if(!vrAvailable){say('VR requiere un visor y un navegador WebXR compatibles.');return;}configureXRSharpness();await scene.enterVR();}}
   catch(e){say('VR no disponible en este dispositivo: '+e.message);}
  });
  viewBar.appendChild(button);
 }
 const fullscreen=document.createElement('button');fullscreen.type='button';fullscreen.textContent='⛶';fullscreen.title='Maximizar';fullscreen.dataset.yaFullscreen='';fullscreen.setAttribute('aria-label','Maximizar');
 fullscreen.style.cssText='margin:0;padding:7px 11px;min-height:36px;border:1px solid #72909e;border-radius:7px;background:#19313f;color:white;font:600 17px system-ui;cursor:pointer';
 if(cfg.audioAllowed){
  audioButton=document.createElement('button');
  audioButton.type='button';
  audioButton.dataset.yaAudio='';
  audioButton.style.cssText=fullscreen.style.cssText;
  audioButton.addEventListener('click',async()=>{
   if(!audioAvailable())return;
   const audible=!source.muted&&source.volume>0&&!source.paused;
   source.muted=audible;
   if(!audible&&source.volume===0)source.volume=1;
   if(!source.muted){
    try{await source.play();}catch{source.muted=true;}
   }
   syncAudioButton();
  });
  for(const event of ['loadedmetadata','loadeddata','playing','pause','emptied','volumechange'])source.addEventListener(event,syncAudioButton,{signal:audioEvents.signal});
  source.audioTracks?.addEventListener('addtrack',syncAudioButton,{signal:audioEvents.signal});
  source.audioTracks?.addEventListener('removetrack',syncAudioButton,{signal:audioEvents.signal});
  source.audioTracks?.addEventListener('change',syncAudioButton,{signal:audioEvents.signal});
  syncAudioButton();
  viewBar.appendChild(audioButton);
 }
 fullscreen.addEventListener('click',()=>full.click());
 viewBar.appendChild(fullscreen);
 for(const [key,label,title] of [['in','+','Acercar imagen'],['out','−','Alejar imagen'],['reset','100 %','Restablecer zoom']]){
  const button=document.createElement('button');button.type='button';button.textContent=label;
  button.dataset.yaZoom=key;button.title=title;button.setAttribute('aria-label',title);
  button.style.cssText=fullscreen.style.cssText;
  button.addEventListener('click',()=>changeZoom(key==='reset'?1:zoom*(key==='in'?1.25:.8)));
  viewBar.appendChild(button);
 }
 if(isDemo){for(const [id,label] of [['play','▶ / Ⅱ'],['mute','Sonido'],['reset','Centrar']]){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.title=id==='play'?'Reproducir o pausar':id==='mute'?'Activar o silenciar sonido':'Volver al centro';
  button.style.cssText=fullscreen.style.cssText;button.addEventListener('click',()=>document.getElementById(id)?.click());viewBar.insertBefore(button,viewBar.firstChild);
 }}
}
function placeViewBar(){
 ensureViewBar();
 if(isDemo){
  source.style.cssText=mode==='2d'?'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;opacity:1;pointer-events:none;z-index:0':'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;display:none';
 }else{
  // Sólo ocultar la presentación nativa: NO pausar, mover ni reasignar el video.
  source.style.visibility=mode==='2d'?'visible':'hidden';
 }
 applyZoom();
 if(!viewHost)return;
 const controlsHost=(document.fullscreenElement===stage||(stage.classList.contains('ya-client-immersed')&&stage.classList.contains('ya-client-viewport')))?stage:viewHost;
 const destination=cfg.controlsHost||controlsHost;
 if(viewBar.parentElement!==destination)destination.appendChild(viewBar);
 for(const button of viewBar.querySelectorAll('[data-ya-view]')){const active=button.dataset.yaView===mode;button.setAttribute('aria-pressed',String(active));button.style.background=active?'#007d75':'#19313f';}
}
let disposed=false;

let qualityController=null;
// WebXR owns the stereo framebuffer. Never resize it with the 2D adaptive controller.
let xrActive=false;
// Diagnóstico no intrusivo: medir la reproducción REAL sin alterar el bitrate ni la resolución.
let metricsTimer=0, lastSampleTime=0, lastTotal=0, lastDropped=0;
let renderFps=0, renderFrames=0, renderElapsed=0;
let lastVideoClock=0,lastVideoClockAt=0;
let videoStableSamples=0,videoClockPrevious=NaN,videoWallPrevious=0,videoClockRate=NaN;
let statsOriginalParent=null,statsOriginalNext=null;
// Diagnóstico de capacidades compartido para demo y WebRTC. No altera la fuente.
const mediaProbe={key:'',generation:0,codec:'desconocido',support:'sin consultar',power:'desconocida',smooth:'desconocida',fps:0,dropRate:0,origin:'sin identificar',bitrate:0};
 let activePeer=null,peerProbeBusy=false,peerProbeAt=0;
const codecFromMime=m=>{const x=(m||'').toLowerCase();return x.includes('av01')?'AV1':x.includes('avc1')?'H.264':x.includes('hvc1')||x.includes('hev1')?'HEVC':x.includes('vp09')?'VP9':x.includes('vp8')?'VP8':'desconocido';};
function detectCodec(){

  // El códec WebRTC se obtiene de RTCStats, no de la extensión ni del navegador.
  if(source.srcObject && mediaProbe.origin==='WebRTC' && mediaProbe.codec!=='desconocido')return {codec:mediaProbe.codec,mime:''};
 return {codec:'desconocido',mime:''};
}
async function probeMedia(){
 if(disposed||!source.videoWidth||!source.videoHeight)return;
 const w=source.videoWidth,h=source.videoHeight,found=detectCodec();
 const key=[source.currentSrc||'stream',w,h,found.codec].join('|');
 if(mediaProbe.key===key)return;
 mediaProbe.key=key;mediaProbe.codec=found.codec;mediaProbe.origin=source.srcObject?'WebRTC':(found.codec!=='desconocido'?'metadatos de demo':'sin identificar');mediaProbe.support='no evaluable';mediaProbe.power='desconocida';mediaProbe.smooth='desconocida';
 const generation=++mediaProbe.generation;
 if(!found.mime||!navigator.mediaCapabilities?.decodingInfo)return;
 try{
  const info=await navigator.mediaCapabilities.decodingInfo({type:'file',video:{contentType:found.mime,width:w,height:h,bitrate:12000000,framerate:30}});
  if(disposed||generation!==mediaProbe.generation)return;
  mediaProbe.support=info.supported?'compatible declarado':'no compatible declarado';
  mediaProbe.power=info.powerEfficient?'eficiente declarado':'no eficiente declarado';
  mediaProbe.smooth=info.smooth?'fluido estimado':'no fluido estimado';
 }catch(_){if(generation===mediaProbe.generation)mediaProbe.support='consulta no disponible';}
}

// RTCStats: consulta limitada a una vez cada 10 s, únicamente para el peer activo.
 // No renegocia, no modifica bitrate ni introduce procesamiento en la ruta de video.
 async function samplePeerCodec(){
  const peer=activePeer,now=performance.now();
  if(!peer||peerProbeBusy||now-peerProbeAt<10000||peer.connectionState==='closed'||document.hidden)return;
  peerProbeAt=now;peerProbeBusy=true;
  try{
   const stats=await peer.getStats();
   if(disposed||activePeer!==peer)return;
   let inbound=null;
   stats.forEach(s=>{if(s.type==='inbound-rtp' && !s.isRemote && (s.kind==='video'||s.mediaType==='video') && (!inbound||s.bytesReceived>inbound.bytesReceived))inbound=s;});
   if(!inbound)return;
   const codec=inbound.codecId?stats.get(inbound.codecId):null;
   if(codec?.mimeType){
    const next=codecFromMime(codec.mimeType);
    if(next!=='desconocido'){
     mediaProbe.codec=next;mediaProbe.origin='WebRTC';
     mediaProbe.key=''; // Volver a evaluar las dimensiones; no aplicar decodingInfo(file) a WebRTC.
    }
   }
   if(Number.isFinite(inbound.framesPerSecond))mediaProbe.fps=inbound.framesPerSecond;
  }catch(_){/* Stats no disponibles en todos los navegadores. */}
  finally{peerProbeBusy=false;}
 }
 function attachPeerConnection(peer){
  if(peer&&typeof peer.getStats==='function'){activePeer=peer;peerProbeAt=0;samplePeerCodec();}
  else{activePeer=null;mediaProbe.codec='desconocido';mediaProbe.origin='sin identificar';mediaProbe.key='';}
 }
 const statsPanel=isDemo?document.getElementById('ya-demo-stats'):null;
function sourceLabel(){
 if(source.srcObject)return 'WebRTC';
 const url=source.currentSrc||source.src||'';
 if(!url)return 'sin fuente';
 try{return new URL(url,location.href).pathname.split('/').pop().split('.').pop().toUpperCase()||'archivo';}catch(_){return 'archivo';}
}
function moveStatsIntoFullscreen(){
 if(!statsPanel)return;
 if(document.fullscreenElement===stage){
  if(statsPanel.parentNode!==stage){
   statsOriginalParent=statsPanel.parentNode;
   statsOriginalNext=statsPanel.nextSibling;
   stage.appendChild(statsPanel);
  }
  statsPanel.style.cssText='position:absolute;bottom:12px;left:12px;right:auto;width:max-content;max-width:calc(100% - 24px);z-index:2147483647;background:#071422d9;color:#d8f5ee;padding:5px 8px;border-radius:6px;font:12px monospace;line-height:1.4;white-space:normal;pointer-events:none';
 }else if(statsOriginalParent){
  statsOriginalParent.insertBefore(statsPanel,statsOriginalNext?.parentNode===statsOriginalParent?statsOriginalNext:null);
  statsOriginalParent=null;statsOriginalNext=null;
  statsPanel.style.cssText='position:absolute;bottom:42px;left:10px;right:10px;width:max-content;max-width:calc(100% - 20px);z-index:5;background:#071422d9;color:#d8f5ee;padding:4px 8px;border-radius:6px;font:12px monospace;line-height:1.4;white-space:normal;overflow-wrap:anywhere;pointer-events:none';
 }
}
function sampleRender(dt){
 if(document.hidden||!Number.isFinite(dt)||dt<=0||dt>250)return;
 renderFrames++;renderElapsed+=dt;
 if(renderElapsed>=4000){renderFps=renderFrames*1000/renderElapsed;renderFrames=0;renderElapsed=0;}
}
function videoQuality(){
 if(!source)return;
 const q=source.getVideoPlaybackQuality?.();
 const now=performance.now();
 if(!q||!lastSampleTime){lastSampleTime=now;lastTotal=q?.totalVideoFrames||0;lastDropped=q?.droppedVideoFrames||0;return;}
 // Track media clock against wall time, independently of presented frames.
 if(!source.paused&&!source.seeking&&source.readyState>=3){
  if(videoWallPrevious>0){
   const elapsed=(now-videoWallPrevious)/1000,advanced=source.currentTime-videoClockPrevious;
   videoClockRate=elapsed>0?advanced/elapsed:NaN;
   if(elapsed>=1&&advanced>0&&videoClockRate>=.85&&videoClockRate<=1.15)videoStableSamples=Math.min(10,videoStableSamples+1);
   else videoStableSamples=0;
  }
  videoWallPrevious=now;videoClockPrevious=source.currentTime;
 }else{videoStableSamples=0;videoWallPrevious=0;videoClockPrevious=NaN;videoClockRate=NaN;}
 const seconds=(now-lastSampleTime)/1000;
 if(seconds<2)return;
 const fps=Math.max(0,(q.totalVideoFrames-lastTotal)/seconds);
 const dropped=Math.max(0,q.droppedVideoFrames-lastDropped);
 const frames=Math.max(0,q.totalVideoFrames-lastTotal);
 mediaProbe.fps=fps;mediaProbe.dropRate=100*dropped/Math.max(1,frames+dropped);
 const r=scene?.renderer;
 const canvas=r?.domElement;
 const buffer=canvas?`${canvas.width}×${canvas.height}`:'sin canvas';
 const ratio=r?Number(r.getPixelRatio()).toFixed(2):'—';
 const gpu=renderFps?`${renderFps.toFixed(1)} FPS WebGL`:'WebGL calculando';
 const clock=Number.isFinite(videoClockRate)?` · Reloj ${videoClockRate.toFixed(2)}×`:' · Reloj midiendo';
 const state=source.seeking?'buscando':source.readyState<3?'buffer bajo':source.paused?'pausado':'reproduciendo';
 if(statsPanel)statsPanel.textContent=`Video ${source.videoWidth}×${source.videoHeight} · ${sourceLabel()} · ${mediaProbe.codec} · ${fps.toFixed(1)} FPS video · ${dropped} descartados / ${seconds.toFixed(0)} s · ${gpu}${clock} · ${state} · Canvas ${buffer} · DPR ${ratio}`;
 lastSampleTime=now;lastTotal=q.totalVideoFrames;lastDropped=q.droppedVideoFrames;
}
function startVideoMetrics(){
 if(metricsTimer)return;
 // Muestra compartida en galería, públicas y privadas. Un solo temporizador liviano.
 metricsTimer=setInterval(()=>{
  if(disposed||document.hidden||source.paused||source.readyState<2){lastSampleTime=0;return;}
  videoQuality();probeMedia();
  if(!isDemo)samplePeerCodec(); // Limitado internamente a una consulta cada 10 s.
 },2000);
}

// Limitar el coste de rasterización en pantallas HiDPI sin alterar la fuente recibida.
// Configuración única de muestreo para la textura original, válida también en VR.
// No cambiar resolución del video ni crear texturas nuevas.
function tuneVideoTexture(){
 const map=sphere?.getObject3D('mesh')?.material?.map;
 const THREE=window.THREE;
 if(!map||!THREE)return;
 if(map.minFilter!==THREE.LinearFilter||map.magFilter!==THREE.LinearFilter||map.generateMipmaps){
  map.minFilter=THREE.LinearFilter;
  map.magFilter=THREE.LinearFilter;
  map.generateMipmaps=false;
  map.needsUpdate=true;
 }
}
function tuneRenderer(){
 if(disposed||!scene||!scene.renderer)return;
 tuneVideoTexture();
 if(xrActive||scene.is('vr-mode')||scene.renderer.xr?.isPresenting)return;
 const renderer=scene.renderer;
 const dpr=qualityController?.ratio()??window.YaRenderQuality?.pixelRatio(stage)??Math.min(window.devicePixelRatio||1,window.matchMedia?.('(pointer: coarse)').matches?1.5:2);
 if(Math.abs(renderer.getPixelRatio()-dpr)>0.01){renderer.setPixelRatio(dpr);renderer.setSize(stage.clientWidth,stage.clientHeight,false);}
}
// Redimensionar el framebuffer cuando cambia el contenedor, sin reiniciar video ni WebRTC.
function queueRendererResize(){
 if(resizeQueued||disposed)return;
 resizeQueued=true;
 requestAnimationFrame(()=>{
  resizeQueued=false;
  if(disposed||!scene||!scene.renderer||stage.hidden||xrActive||scene.is('vr-mode')||scene.renderer.xr?.isPresenting)return;
  const w=stage.clientWidth,h=stage.clientHeight;
  if(w<1||h<1)return;
  // Reset samples only when the stage dimensions really changed.
  const changed=w!==lastStageWidth||h!==lastStageHeight;
  if(changed){lastStageWidth=w;lastStageHeight=h;qualityController?.onResize();}
  tuneRenderer();
  const r=scene.renderer;
  // Embedded A-Frame can retain the window aspect when only its stage resizes.
  const camera=scene.camera;
  if(camera?.isPerspectiveCamera && Math.abs(camera.aspect-w/h)>0.0001){
   camera.aspect=w/h;
   camera.updateProjectionMatrix();
  }
  const canvas=r.domElement;
  const dpr=r.getPixelRatio();
  const expectedW=Math.round(w*dpr),expectedH=Math.round(h*dpr);
  if(Math.abs(canvas.width-expectedW)>2||Math.abs(canvas.height-expectedH)>2){
   r.setSize(w,h,false);
  }
 });
}
const say=t=>{if(status)status.textContent=t;};
const aframe=()=>window.AFRAME?Promise.resolve():loading||(loading=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/explorer/assets/aframe.min.js';s.onload=resolve;s.onerror=()=>reject(Error('No se pudo cargar A-Frame'));document.head.append(s);}).catch(e=>{loading=null;throw e;}));
async function detectVR(){try{vrAvailable=!!(navigator.xr&&await navigator.xr.isSessionSupported('immersive-vr'));}catch(_){vrAvailable=false;}vr.hidden=!vrAvailable||mode==='2d';}
function configureStereo(){
 const layout=cfg.stereoLayout;
 if(!sphere||!['top-bottom','left-right'].includes(layout))return;
 const mesh=sphere.getObject3D('mesh'),material=mesh?.material;
 if(!material||material.userData.yaStereo)return;
 material.userData.yaStereo=true;
 const eye={scale:new AFRAME.THREE.Vector2(layout==='left-right'?.5:1,layout==='top-bottom'?.5:1),offset:new AFRAME.THREE.Vector2(0,layout==='top-bottom'?.5:0)};
 material.onBeforeCompile=shader=>{
  shader.uniforms.yaEyeScale={value:eye.scale};shader.uniforms.yaEyeOffset={value:eye.offset};
  shader.fragmentShader='uniform vec2 yaEyeScale; uniform vec2 yaEyeOffset;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',AFRAME.THREE.ShaderChunk.map_fragment.replace(/\bvMapUv\b/g,'(vMapUv * yaEyeScale + yaEyeOffset)'));
 };
 material.customProgramCacheKey=()=> '360ya-stereo-v1-'+layout;
 mesh.onBeforeRender=(_renderer,_scene,camera)=>{
  const right=xrActive&&(camera.layers.mask&4)!==0;
  eye.offset.set(layout==='left-right'&&right?.5:0,layout==='top-bottom'?(right?0:.5):0);
  material.uniformsNeedUpdate=true;
 };
 material.needsUpdate=true;
}
function refreshTexture(){
 configureStereo();
 if(!sphere||!texture||texture.readyState<2)return;
 // A-Frame can initialize before a WebRTC MediaStream has its first frame.
 // Explicitly rebind the material when the decoder becomes ready.
 if(!sphere.dataset.videoBound){sphere.setAttribute('material',`shader: flat; side: back; src: #${source.id}`);sphere.dataset.videoBound='1';}
 const mesh=sphere.getObject3D('mesh'),material=mesh?.material;
 // En video mono, conservar exactamente la textura original de HOME. Sólo estéreo usa remapeo.
 if(material&&['top-bottom','left-right'].includes(cfg.stereoLayout)&&!material.userData.yaDecodedSource){const previous=material.map;const next=new AFRAME.THREE.VideoTexture(source);if(previous)next.colorSpace=previous.colorSpace;next.minFilter=AFRAME.THREE.LinearFilter;next.magFilter=AFRAME.THREE.LinearFilter;next.generateMipmaps=false;material.map=next;material.userData.yaDecodedSource=true;material.needsUpdate=true;previous?.dispose();}
 tuneVideoTexture();
 const w=texture.videoWidth,h=texture.videoHeight;const ratio=w&&h?w/h:0;
 say(ratio&&Math.abs(ratio-2)>0.12?'Advertencia: video '+w+'×'+h+' no es panorámico 2:1; revisar salida de cámara.':'Panorama '+(w&&h?w+'×'+h+' · ':'')+'video activo. Arrastrá para mirar alrededor.');
}
// Una sola instancia HTMLVideoElement recibe y decodifica la señal.
// A-Frame usa ese mismo elemento como textura, sin crear otro decoder ni otro play().
function sync(){
 if(disposed||!sphere||!scene)return;
 if(source.readyState>=2)refreshTexture();
 else if(!source.srcObject&&!source.currentSrc&&!source.src)say('Esperando video para el visor panorámico.');
}

// Una superficie maneja el desplazamiento, la orientación y el pellizco.
function attachViewGestures(){
 const pointers=new Map();
 let yaw=0,pitch=0;
 const previousTouchAction=viewHost.style.touchAction;
 viewHost.style.touchAction='none';
 const onDown=e=>{
  if(scene?.is('vr-mode')||e.button>0||viewBar?.contains(e.target))return;
  if(!pointers.size&&mode!=='2d'&&scene?.camera){
   yaw=scene.camera.rotation.y;
   pitch=scene.camera.rotation.x;
  }
  pointers.set(e.pointerId,[e.clientX,e.clientY]);
  viewHost.setPointerCapture(e.pointerId);
 };
 const distance=()=>{const [a,b]=pointers.values();return Math.hypot(a[0]-b[0],a[1]-b[1]);};
 const onMove=e=>{
  const previous=pointers.get(e.pointerId);
  if(!previous||scene?.is('vr-mode'))return;
  const before=pointers.size===2?distance():0;
  pointers.set(e.pointerId,[e.clientX,e.clientY]);
  if(before>0){changeZoom(zoom*distance()/before);return;}
  if(pointers.size!==1)return;
  const dx=e.clientX-previous[0],dy=e.clientY-previous[1];
  if(mode==='2d'){
   if(zoom>1){panX+=dx;panY+=dy;applyZoom();}
  }else{
   const camera=scene?.camera;
   if(!camera)return;
   yaw-=dx*.0035;
   if(mode==='180')yaw=clamp(yaw,-Math.PI/2,Math.PI/2);
   pitch=clamp(pitch-dy*.0035,-Math.PI*.47,Math.PI*.47);
   camera.rotation.set(pitch,yaw,0,'YXZ');
  }
 };
 const onUp=e=>pointers.delete(e.pointerId);
 const onWheel=e=>{
  if(scene?.is('vr-mode')||viewBar?.contains(e.target))return;
  e.preventDefault();changeZoom(zoom*Math.exp(-Math.sign(e.deltaY)*.15));
 };
 const events={pointerdown:onDown,pointermove:onMove,pointerup:onUp,pointercancel:onUp,lostpointercapture:onUp,wheel:onWheel};
 for(const [name,handler] of Object.entries(events))viewHost.addEventListener(name,handler,{passive:name!=='wheel'});
 source.addEventListener('loadedmetadata',applyZoom);
 return ()=>{
  source.removeEventListener('loadedmetadata',applyZoom);
  for(const [name,handler] of Object.entries(events))viewHost.removeEventListener(name,handler);
  viewHost.style.touchAction=previousTouchAction;
 };
}
const detachGestures=viewHost?attachViewGestures():null;

function teardown(){
 restoreXRMediaLayer();
 qualityController?.reset();
 if(scene){try{if(scene.is('vr-mode'))scene.exitVR();scene.pause();}catch(_){}if(scene.parentNode)scene.remove();}
 if(texture){texture.removeEventListener('loadeddata',refreshTexture);texture.removeEventListener('playing',refreshTexture);}
 if(resizeObserver){resizeObserver.disconnect();resizeObserver=null;}
 scene=null;texture=null;sphere=null;xrActive=false;lastStageWidth=0;lastStageHeight=0;stage.replaceChildren();stage.hidden=true;full.hidden=true;vr.hidden=true;
}
async function change(next){if(disposed)return;const token=++seq;const previousMode=mode;mode=next;select.value=next;if(next==='2d'){teardown();placeViewBar();say(isDemo?'Vista plana. Podés cambiar a 180° o 360° sin detener la transmisión.':'');return;}
try{await aframe();if(token!==seq||mode==='2d')return;
if(!qualityController)qualityController=window.YaRenderQuality?.createController?.(stage,queueRendererResize)||null;
if(!scene){stage.hidden=false;scene=document.createElement('a-scene');scene.setAttribute('embedded','');scene.setAttribute('vr-mode-ui','enabled: false');scene.setAttribute('webxr','optionalFeatures: layers');scene.setAttribute('renderer','colorManagement: true; antialias: false');
if(!AFRAME.components['ya-render-adaptive'])AFRAME.registerComponent('ya-render-adaptive',{tick:function(t,dt){if(!source.paused&&source.readyState>=2){sampleRender(dt);if(!xrActive&&(!isDemo||videoStableSamples>=2))qualityController?.sample(t,dt);}}});
scene.setAttribute('ya-render-adaptive','');scene.style.cssText='width:100%;height:100%';
texture=source;texture.addEventListener('loadeddata',refreshTexture);texture.addEventListener('playing',refreshTexture);
sphere=document.createElement('a-videosphere');sphere.setAttribute('src',`#${source.id}`);sphere.setAttribute('rotation','0 -90 0');scene.append(sphere);sphere.addEventListener('object3dset',()=>{refreshTexture();tuneVideoTexture();tuneRenderer();});
const camera=document.createElement('a-entity');camera.setAttribute('camera','');camera.setAttribute('look-controls','enabled: false');camera.setAttribute('position','0 0 0');scene.append(camera);stage.append(scene);
const removeLegacyButtons=()=>{for(const button of document.querySelectorAll('.a-enter-vr-button,.a-enter-ar-button')){if(button.closest('a-scene')===scene||button.parentElement===document.body)button.remove();}};
scene.addEventListener('loaded',()=>{applyZoom();removeLegacyButtons();configureXRSharpness();sync();refreshTexture();tuneRenderer();});scene.addEventListener('renderstart',()=>{removeLegacyButtons();configureXRSharpness();queueRendererResize();});
// XR session lifecycle: measure frame pacing but leave stereo target size to WebXR.
scene.addEventListener('enter-vr',()=>{applyZoom();mediaXRReportedSession=null;mediaXRReportedStatus='';tuneVideoTexture();requestAnimationFrame(tryXRMediaLayer);requestAnimationFrame(()=>requestAnimationFrame(tryXRMediaLayer));xrActive=true;qualityController?.suspend(6000);renderFrames=0;renderElapsed=0;renderFps=0;lastSampleTime=0;});
scene.addEventListener('exit-vr',()=>{applyZoom();xrPresentationRoute='no activa';xrFramebuffer='no disponible';restoreXRMediaLayer();mediaXRReportedSession=null;mediaXRReportedStatus='';xrActive=false;qualityController?.onResize();renderFrames=0;renderElapsed=0;renderFps=0;lastSampleTime=0;queueRendererResize();});
if(window.ResizeObserver){resizeObserver=new ResizeObserver(queueRendererResize);resizeObserver.observe(stage);}
queueRendererResize();onVisibility();}
// The input is a panoramic texture; 180° limits the visible hemisphere, not the source frames.
if(next==='180'&&previousMode!=='180')scene.camera?.rotation.set(0,0,0,'YXZ');
sphere.setAttribute('rotation', next==='180'?'0 180 0':'0 -90 0');
if(next==='180'){sphere.setAttribute('geometry','primitive: sphere; radius: 100; segmentsWidth: 64; segmentsHeight: 40; phiStart: 0; phiLength: 180');}
else{sphere.setAttribute('geometry','primitive: sphere; radius: 100; segmentsWidth: 64; segmentsHeight: 40; phiStart: 0; phiLength: 360');}
full.hidden=true;placeViewBar();sync();await detectVR();say('Vista '+next+'° activa. Arrastrá para mirar alrededor.');
}catch(e){if(token===seq){teardown();mode='2d';select.value='2d';say('No se pudo activar la vista panorámica: '+e.message);}}}
if(!isDemo){select.hidden=true;const label=document.querySelector('label[for="'+select.id+'"]');if(label)label.hidden=true;}
// La fuente define la proyección; no mostrar instrucciones obsoletas ni panel vacío.
if(!isDemo){const panel=select.closest('section');if(panel){const heading=panel.querySelector('h3');if(heading)heading.hidden=true;if(status)status.hidden=true;/* La barra se aloja en el contenedor del video; el panel vacío se conserva sin ocultar la reproducción. */}}
select.addEventListener('change',()=>change(select.value));
// El navegador no necesita pintar la escena 3D si la pestaña está oculta.
// No detener ni pausar el elemento de video: WebRTC/audio deben seguir vivos.
function onVisibility(){
 if(disposed||!scene||scene.is('vr-mode'))return;
 if(document.hidden){scene.pause();qualityController?.reset();lastSampleTime=0;lastVideoClockAt=0;}
 else {scene.play();queueRendererResize();}
}
document.addEventListener('visibilitychange',onVisibility);
const onFullscreen=()=>{
 const fsButton=viewBar?.querySelector('[data-ya-fullscreen]');
 if(fsButton){const active=!!document.fullscreenElement||!!document.querySelector('.ya-client-viewport.ya-client-immersed');fsButton.setAttribute('aria-pressed',String(active));fsButton.title=active?'Minimizar':'Maximizar';fsButton.setAttribute('aria-label',active?'Minimizar':'Maximizar');}
 if(viewBar)placeViewBar();
 moveStatsIntoFullscreen();
 // Descartar ventana de medición atravesada por el cambio de modo.
 lastSampleTime=0;renderFrames=0;renderElapsed=0;renderFps=0;
 lastVideoClockAt=0;qualityController?.suspend(3500);
 if(scene&&!xrActive)queueRendererResize();
};
function onViewportResize(){applyZoom();queueRendererResize();}
window.addEventListener('resize',onViewportResize);
document.addEventListener('fullscreenchange',onFullscreen);
// Un único controlador. En clientes respeta la vista inmersiva que ya usaba la web.
full.addEventListener('click',async()=>{
 try{
  const immersiveHost=!isDemo&&!cfg.operator?document.querySelector('.ya-client-viewport'):null;
  if(immersiveHost){
   if(document.fullscreenElement){await document.exitFullscreen();immersiveHost.classList.remove('ya-client-immersed');}
   else if(immersiveHost.classList.contains('ya-client-immersed'))immersiveHost.classList.remove('ya-client-immersed');
   else {immersiveHost.classList.add('ya-client-immersed');if(immersiveHost.requestFullscreen)await immersiveHost.requestFullscreen({navigationUI:'hide'});}
   placeViewBar();onFullscreen();return;
  }
  if(document.fullscreenElement)await document.exitFullscreen();
  else await (mode==='2d'?viewHost:stage).requestFullscreen();
 }catch(e){say('Pantalla completa no disponible: '+e.message);}
});
document.addEventListener('ya-client-immersive-change',placeViewBar);
vr.addEventListener('click',async()=>{try{if(!scene||!scene.hasLoaded){say('Esperá a que cargue el visor.');return;}if(scene.is('vr-mode'))await scene.exitVR();else{configureXRSharpness();await scene.enterVR();}}catch(e){say('WebXR no disponible: '+e.message);}});
function onVideoDiscontinuity(){videoStableSamples=0;videoWallPrevious=0;videoClockRate=NaN;qualityController?.suspend(3500);}
source.addEventListener('waiting',onVideoDiscontinuity);
source.addEventListener('stalled',onVideoDiscontinuity);
source.addEventListener('seeking',onVideoDiscontinuity);
source.addEventListener('ratechange',onVideoDiscontinuity);
source.addEventListener('loadedmetadata',tryXRMediaLayer);source.addEventListener('playing',tryXRMediaLayer);source.addEventListener('loadeddata',tryXRMediaLayer);source.addEventListener('loadedmetadata',sync);source.addEventListener('loadedmetadata',probeMedia);source.addEventListener('playing',sync);source.addEventListener('emptied',sync);
// WebRTC puede asignar srcObject después de los eventos HTMLVideoElement.
// Una sola comprobación de respaldo, activa únicamente en modo panorámico.
const watcher=setInterval(()=>{if(!disposed&&mode!=='2d'&&!document.hidden)sync();},2000);
function dispose(){
 if(disposed)return;disposed=true;++seq;detachGestures?.();clearInterval(watcher);clearTimeout(controlsHideTimer);
 for(const host of new Set([viewHost,stage])){if(!host)continue;host.removeEventListener('pointermove',onControlsPointerMove);host.removeEventListener('pointerleave',onControlsPointerLeave);host.removeEventListener('pointerdown',onControlsTouch);}if(metricsTimer){clearInterval(metricsTimer);metricsTimer=0;}if(diagTimer){clearInterval(diagTimer);diagTimer=0;}source.removeEventListener('playing',sendAutomaticDiagnostics);
 document.removeEventListener('visibilitychange',onVisibility);
 document.removeEventListener('fullscreenchange',onFullscreen);
 document.removeEventListener('ya-client-immersive-change',placeViewBar);
 window.removeEventListener('resize',onViewportResize);moveStatsIntoFullscreen();
 source.removeEventListener('waiting',onVideoDiscontinuity);source.removeEventListener('stalled',onVideoDiscontinuity);
 source.removeEventListener('seeking',onVideoDiscontinuity);source.removeEventListener('ratechange',onVideoDiscontinuity);
 source.removeEventListener('loadedmetadata',tryXRMediaLayer);source.removeEventListener('playing',tryXRMediaLayer);source.removeEventListener('loadeddata',tryXRMediaLayer);source.removeEventListener('loadedmetadata',sync);source.removeEventListener('loadedmetadata',probeMedia);source.removeEventListener('playing',sync);source.removeEventListener('emptied',sync);
 audioEvents.abort();audioStreamListeners?.abort();audioTrackListeners?.abort();window.removeEventListener('pagehide',dispose);teardown();viewBar?.remove();viewBar=null;source.setAttribute('style',sourceOriginalStyle||'');stage.setAttribute('style',stageOriginalStyle||'');if(stageOriginalParent)stageOriginalParent.insertBefore(stage,stageOriginalNext?.parentNode===stageOriginalParent?stageOriginalNext:null);if(demoVideoOriginal){source.setAttribute('style',demoVideoOriginal.style||'');demoVideoOriginal.parent.insertBefore(source,demoVideoOriginal.next?.parentNode===demoVideoOriginal.parent?demoVideoOriginal.next:null);}
}
window.addEventListener('pagehide',dispose);

window.YaPlayerCapabilities=Object.freeze({updateAudio,snapshot:()=>({...mediaProbe,width:source.videoWidth||0,height:source.videoHeight||0,renderFps:renderFps||0,xrActive,xrRoute:xrActive?xrPresentationRoute:'no activa',xrFramebuffer:xrActive?xrFramebuffer:'no disponible',quality:qualityController?.snapshot?.()||null,canvas:scene?.renderer?.domElement?{width:scene.renderer.domElement.width,height:scene.renderer.domElement.height}:null,stereoLayout:cfg.stereoLayout||'none',videoFrames:source.getVideoPlaybackQuality?.()?.totalVideoFrames??null,droppedVideoFrames:source.getVideoPlaybackQuality?.()?.droppedVideoFrames??null,readyState:source.readyState,paused:source.paused,mode,zoom,devicePixelRatio:window.devicePixelRatio||1,deviceProfile:deviceProfile.kind}),attachPeerConnection});
startVideoMetrics();
// Automatic diagnostics for active playback, without extra video/canvas/decoder.
let diagTimer=0,diagInFlight=false,diagLastFrames=-1;
const sendAutomaticDiagnostics=()=>{
 if(cfg.disableDiagnostics)return;
 if(disposed||document.hidden||diagInFlight||source.paused||source.readyState<2)return;
 const snap=window.YaPlayerCapabilities?.snapshot?.();
 if(!snap)return;
 // Only log active playback. In WebRTC some browsers do not expose total frames.
 const frames=Number(snap.videoFrames);
 if(Number.isFinite(frames)&&frames>0){
  if(frames===diagLastFrames)return;
  diagLastFrames=frames;
 }
 diagInFlight=true;
 fetch('/ya-player-diagnostics.php',{
  method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({scenario:isDemo?'galeria':isPublic?'publica':'privada',data:snap})
 }).catch(()=>{}).finally(()=>{diagInFlight=false;});
};
source.addEventListener('playing',sendAutomaticDiagnostics);
diagTimer=setInterval(sendAutomaticDiagnostics,12000);
if(isDemo){window.YaDemoPlayer=Object.freeze({reset:()=>{const cam=scene?.querySelector('[camera]');if(cam)cam.object3D.rotation.set(0,0,0);},refresh:()=>{refreshTexture();queueRendererResize();}});}
// La proyección inicial pertenece a la sesión; el espectador puede cambiar la vista local.
change(fixedMode||(cfg.format==='180'?'180':cfg.format==='360'?'360':'2d'));
})();
