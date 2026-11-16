import {profileKey,encryptProfile,decryptProfile} from './ssh-profile.js';

const $ = (query, host = document) => host.querySelector(query);
const node = (tag, content, cls) => {
    const el = document.createElement(tag);
    if (content !== undefined) el.textContent = content;
    if (cls) el.className = cls;
    return el;
};
const button = (label, run, title) => {
    const el = node('button', label);
    el.type = 'button';
    if (title) el.title = title;
    el.addEventListener('click', run);
    return el;
};
const field = (label, input) => {
    const wrapper = node('label', label, 'field');
    wrapper.append(input);
    return wrapper;
};
const input = (type, value = '') => {
    const el = node('input');
    el.type = type;
    el.value = value;
    return el;
};
const url = params => '/explorer/api?' + new URLSearchParams(params);
const pathName = path => path.split('/').at(-1);
const size = n => {
    const unit = Math.min(4, Math.floor(Math.log(Math.max(1,n))/Math.log(1024)));
    return new Intl.NumberFormat('es-AR',{maximumFractionDigits:1}).format(n/1024**unit)+' '+['B','KiB','MiB','GiB','TiB'][unit];
};
const date = t => new Date(t*1000).toLocaleString('es-AR',{dateStyle:'short',timeStyle:'short'});
const setStatus = text => { $('#status').textContent = text; };
let session, roots = [], active, clipboard, uploadPanel;
const dialog = $('#dialog');
const progress = $('#progress');
const cancel = $('#cancel');
const guarded = handler => async (...args) => {
    try { await handler(...args); } catch (error) { setStatus(error.message); }
};

async function get(op, params = {}) {
    const response = await fetch(url({op,...params}));
    return unpack(response.status, await response.json());
}

function unpack(status, body) {
    if (status >= 400) {
        const error = new Error(body.error || (typeof body.detail==='string' ? body.detail : 'Solicitud rechazada ('+status+')'));
        error.status = status;
        throw error;
    }
    return body.data;
}

async function post(request, file) {
    if (!file) {
        const response = await fetch('/explorer/api',{method:'POST',
            headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(request)});
        return unpack(response.status,await response.json());
    }
    return new Promise((resolve,reject) => {
        const xhr = new XMLHttpRequest();
        const data = new FormData();
        data.append('request',JSON.stringify(request));
        data.append('file',file);
        xhr.open('POST','/explorer/api');
        xhr.responseType = 'json';
        xhr.setRequestHeader('X-CSRF-Token',session.csrf);
        xhr.upload.onprogress = event => {
            if (event.lengthComputable) progress.value = event.loaded/event.total;
        };
        xhr.upload.onload = () => { cancel.hidden = true; progress.removeAttribute('value'); };
        xhr.onload = () => {
            try { resolve(unpack(xhr.status,xhr.response || {})); } catch (error) { reject(error); }
        };
        xhr.onerror = () => reject(new Error('La conexión se interrumpió'));
        xhr.onabort = () => reject(new Error('Subida cancelada'));
        progress.hidden = false;
        cancel.hidden = false;
        cancel.onclick = () => xhr.abort();
        progress.max = 1;
        progress.value = 0;
        xhr.send(data);
    }).finally(() => {
        progress.hidden = true;
        cancel.hidden = true;
        cancel.onclick = null;
    });
}

class Panel {
    constructor(id, initial) {
        this.host = $('#'+id);
        this.id = id;
        this.location = initial;
        this.history = [initial];
        this.index = 0;
        this.page = 0;
        this.sort = 'name';
        this.desc = '0';
        this.memo = new Map();
        this.selected = new Set();
        this.entries = [];
        this.filters = null;
        this.request = 0;
        this.bar = node('div',undefined,'panelbar');
        this.columns = node('div',undefined,'columns');
        this.files = node('div',undefined,'files');
        this.pager = node('div',undefined,'pager');
        this.host.append(this.bar,this.columns,this.files,this.pager);
        this.host.addEventListener('pointerdown', () => this.activate());
        this.host.addEventListener('focusin', () => this.activate());
        this.files.addEventListener('dragover', e => {
            if (e.dataTransfer.types.includes('application/x-360ya-pane')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
                this.files.classList.add('drag-target');
            }
        });
        this.files.addEventListener('dragleave', () => this.files.classList.remove('drag-target'));
        this.files.addEventListener('drop', guarded(async e => {
            this.files.classList.remove('drag-target');
            const id = e.dataTransfer.getData('application/x-360ya-pane');
            if (!id || id === this.id) return;
            e.preventDefault();
            const from = panels.find(p => p.id === id);
            await transfer([...from.selected],this,e.shiftKey?'move':'copy');
        }));
    }
    activate() {
        active = this;
        for (const tab of $('#volumes').children) tab.setAttribute('aria-current',String(tab.dataset.root===this.location.split('/')[0]));
        for (const panel of panels) panel.host.classList.toggle('active',panel===this);
    }
    remember() {
        this.memo.set(this.location,{selected:this.selected,scroll:this.files.scrollTop,page:this.page});
        if (this.memo.size>35) this.memo.delete(this.memo.keys().next().value);
    }
    async navigate(path, index = null) {
        const previous = [this.location,this.page,this.selected,this.filters];
        this.remember();
        this.location = path;
        this.filters = null;
        const memo = this.memo.get(path);
        this.page = memo?.page ?? 0;
        this.selected = memo?.selected ?? new Set();
        try {
            const loaded = await this.load(memo?.scroll ?? 0);
            if (!loaded) return;
        } catch (error) {
            [this.location,this.page,this.selected,this.filters] = previous;
            this.address.value = this.location;
            throw error;
        }
        if (index !== null) this.index = index;
        else if (this.history[this.index] !== path) {
            this.history.splice(this.index+1,Infinity,path);
            this.index++;
        }
        this.renderBar();
        if (active===this) this.activate();
    }
    async load(scroll = this.files.scrollTop) {
        const sequence = ++this.request;
        const result = await protectedRead(this.filters?'search':'list',{
            path:this.location, page:this.page, sort:this.sort, desc:this.desc, ...this.filters
        });
        if (sequence!==this.request) return false;
        this.entries = result.entries;
        this.count = result.count;
        this.available = result.available;
        this.capacity = result.capacity;
        this.render();
        this.files.scrollTop = scroll;
        return true;
    }
    renderBar() {
        const back = button('←',guarded(() => this.navigate(this.history[this.index-1],this.index-1)),'Atrás');
        back.disabled = this.index===0;
        const next = button('→',guarded(() => this.navigate(this.history[this.index+1],this.index+1)),'Adelante');
        next.disabled = this.index===this.history.length-1;
        const up = button('↑',guarded(() => this.navigate(this.location.split('/').slice(0,-1).join('/'))),'Subir');
        up.disabled = !this.location.includes('/');
        const address = this.address = input('text',this.location==='vps'?'/':this.location.startsWith('vps/')?this.location.slice(3):this.location);
        address.setAttribute('aria-label','Ruta');
        address.addEventListener('keydown',guarded(async e => {
            if (e.key==='Enter') await this.navigate(address.value.trim().startsWith('/') ? 'vps'+address.value.trim().replace(/\/$/,'') : address.value.trim());
        }));
        const actions = [back,next,up,address,button(this.host.classList.contains('grid')?'☰':'▦',() => {
            this.host.classList.toggle('grid');
            this.render();
        },'Cambiar vista'),button('↻',guarded(() => this.load()),'Actualizar')];
        if (this.filters) actions.push(button('×',guarded(() => this.navigate(this.location)),'Cerrar búsqueda'));
        this.bar.replaceChildren(...actions);
    }
    render() {
        this.renderBar();
        const check = input('checkbox');
        check.setAttribute('aria-label','Seleccionar página');
        check.checked = !!this.entries.length && this.entries.every(e => this.selected.has(e.path));
        check.addEventListener('change',() => {
            for (const row of this.entries) this.toggle(row.path,check.checked);
            this.renderSelection();
        });
        this.columns.replaceChildren(check);
        for (const [key,label] of [['name','Nombre'],['size','Tamaño'],['type','Tipo'],['mode','Permisos'],['modified','Modificado']]) {
            if (key==='mode') { this.columns.append(node('span',label,'perms')); continue; }
            const sort = button(label+(this.sort===key?(this.desc==='1'?' ↓':' ↑'):''),guarded(async () => {
                this.desc = this.sort===key && this.desc==='0'?'1':'0';
                this.sort = key;
                this.page = 0;
                await this.load(0);
            }));
            if (key==='type') sort.classList.add('type');
            this.columns.append(sort);
        }
        this.files.querySelectorAll('.entry').forEach(el => thumbnailObserver.unobserve(el));
        this.files.replaceChildren();
        if (!this.entries.length) this.files.append(node('p',this.filters?'No se encontraron coincidencias.':'Carpeta vacía.','empty'));
        for (let i=0;i<this.entries.length;i++) this.files.append(this.makeEntry(this.entries[i],i));
        const previous = button('‹',guarded(async () => { this.page--; await this.load(0); }),'Página anterior');
        previous.disabled = this.page===0;
        const next = button('›',guarded(async () => { this.page++; await this.load(0); }),'Página siguiente');
        next.disabled = (this.page+1)*80>=this.count;
        this.stats = node('span');
        this.pager.replaceChildren(previous,this.stats,next);
        this.updateStats();
    }
    updateStats() {
        this.stats.textContent = this.count+' elementos · '+this.selected.size+' seleccionados'+(this.capacity?' · '+size(this.available)+' libres de '+size(this.capacity):'');
    }
    toggle(path,value) {
        if (value) this.selected.add(path);
        else this.selected.delete(path);
    }
    renderSelection() {
        for (const entry of this.files.querySelectorAll('.entry')) {
            const checked = this.selected.has(this.entries[Number(entry.dataset.index)].path);
            entry.setAttribute('aria-selected',String(checked));
            $('input',entry).checked = checked;
        }
        this.updateStats();
    }
    makeEntry(row,index) {
        const el = node('div',undefined,'entry');
        el.dataset.index = index;
        el.tabIndex = 0;
        el.draggable = true;
        el.setAttribute('aria-selected',String(this.selected.has(row.path)));
        const choice = input('checkbox');
        choice.checked = this.selected.has(row.path);
        choice.setAttribute('aria-label','Seleccionar '+row.name);
        choice.addEventListener('click',e => {
            e.stopPropagation();
            this.toggle(row.path,choice.checked);
            this.anchor = index;
            this.renderSelection();
        });
        el.append(choice);
        const icon = row.protected?'🔒':row.kind==='folder'?'📁':row.media?.startsWith('video/')?'▶':'▤';
        if (this.host.classList.contains('grid')) {
            const fallback = node('span',row.kind==='file'&&!row.media?row.type.toUpperCase().slice(0,7):icon,'preview-icon file-tile');
            el.append(fallback);
            if (row.media && !row.requiresUnlock) {
                const still = row.media.startsWith('image/');
                const thumbnail = node(still?'img':'video',undefined,'preview-icon');
                thumbnail.hidden = true;
                thumbnail.setAttribute('aria-hidden','true');
                if (still) thumbnail.alt = '';
                else {
                    thumbnail.preload = 'auto';
                    thumbnail.muted = true;
                    thumbnail.playsInline = true;
                }
                if (still) {
                    thumbnail.addEventListener('load',() => {
                        thumbnail.hidden = false;
                        fallback.hidden = true;
                    },{once:true});
                } else {
                    thumbnail.addEventListener('loadeddata',() => {
                        const frame = document.createElement('canvas');
                        frame.width = 240;
                        frame.height = Math.max(1,Math.round(240*thumbnail.videoHeight/thumbnail.videoWidth));
                        frame.className = 'preview-icon';
                        frame.setAttribute('aria-hidden','true');
                        frame.getContext('2d').drawImage(thumbnail,0,0,frame.width,frame.height);
                        thumbnail.replaceWith(frame);
                        fallback.hidden = true;
                        thumbnail.removeAttribute('src');
                        thumbnail.load();
                    },{once:true});
                }
                el.append(thumbnail);
                thumbnailObserver.observe(el);
                thumbnail.dataset.source = url({op:'media',path:row.path})+(still?'':'#t=0.2');
            }
        }
        const name = node('span',(this.host.classList.contains('grid')?'':icon+'  ')+row.name,'filename');
        name.title = row.name;
        el.append(name,node('span',row.kind==='file'?size(row.size):'—','meta'),
            node('span',row.type,'meta type'),node('span',row.mode,'meta perms'),node('span',date(row.modified),'meta'));
        el.addEventListener('click',e => {
            if (e.shiftKey && Number.isInteger(this.anchor)) {
                if (!e.ctrlKey) this.selected.clear();
                for (const value of this.entries.slice(Math.min(index,this.anchor),Math.max(index,this.anchor)+1)) this.selected.add(value.path);
            } else if (e.ctrlKey || e.metaKey) this.toggle(row.path,!this.selected.has(row.path));
            else { this.selected.clear(); this.selected.add(row.path); }
            this.anchor = index;
            this.renderSelection();
        });
        el.addEventListener('dblclick',guarded(() => openRow(this,row)));
        el.addEventListener('keydown',guarded(async e => {
            if (e.target===el && e.key==='Enter') await openRow(this,row);
            if (e.target===el && e.key===' ') {
                e.preventDefault();
                this.toggle(row.path,!this.selected.has(row.path));
                this.renderSelection();
            }
        }));
        el.addEventListener('contextmenu',e => {
            e.preventDefault();
            this.activate();
            if (!this.selected.has(row.path)) { this.selected.clear(); this.selected.add(row.path); this.renderSelection(); }
            context(e,this,row);
        });
        el.addEventListener('dragstart',e => {
            if (!this.selected.has(row.path)) { this.selected.clear(); this.selected.add(row.path); this.renderSelection(); }
            e.dataTransfer.setData('application/x-360ya-pane',this.id);
            e.dataTransfer.effectAllowed = 'copyMove';
        });
        return el;
    }
}

function modal(title, content, media = false, icon = '▤') {
    dialog.classList.toggle('media-dialog',media);
    const heading = node('div',undefined,'modal-head');
    const identity = node('div',undefined,'modal-identity');
    if (!media) {
        const badge = node('span',icon,'modal-icon');
        badge.setAttribute('aria-hidden','true');
        identity.append(badge);
    }
    const caption = node('h2',title);
    caption.id = 'explorer-dialog-title';
    identity.append(caption);
    dialog.setAttribute('aria-labelledby',caption.id);
    const close = button('×',() => dialog.close());
    close.setAttribute('aria-label','Cerrar');
    close.className = 'modal-close';
    heading.append(identity,close);
    $('#modal').replaceChildren(heading,...content);
    if (!dialog.open) dialog.showModal();
}

function ask(title, fields, label='Continuar', options={}) {
    return new Promise(resolve => {
        const form = node('form',undefined,'dialog-form');
        const submit = node('button',label,options.danger?'danger-button':'primary');
        const notice = node('p',undefined,'dialog-notice');
        notice.hidden = true;
        notice.setAttribute('role','alert');
        const buttons = node('div',undefined,'modal-actions');
        buttons.append(button(options.cancel || 'Cancelar',() => dialog.close()),submit);
        form.append(...fields,notice,buttons);
        modal(title,[form],false,options.icon);
        const close = $('.modal-close',dialog);
        const stopped = () => { if (!dialog.open) resolve(false); };
        dialog.addEventListener('close',stopped);
        const dispose = () => dialog.removeEventListener('close',stopped);
        dialog.addEventListener('close',() => { if (!dialog.open) dispose(); },{once:true});
        form.addEventListener('submit',async e => {
            e.preventDefault();
            if (options.submit) {
                submit.disabled = close.disabled = true;
                buttons.firstElementChild.disabled = true;
                submit.textContent = options.pending || 'Conectando…';
                notice.hidden = true;
                const preventCancel = event => event.preventDefault();
                dialog.addEventListener('cancel',preventCancel);
                try {
                    await options.submit();
                } catch (error) {
                    notice.textContent = error.message;
                    notice.hidden = false;
                    return;
                } finally {
                    dialog.removeEventListener('cancel',preventCancel);
                    submit.disabled = close.disabled = false;
                    buttons.firstElementChild.disabled = false;
                    submit.textContent = label;
                }
            }
            dispose();
            resolve(true);
        });
        $('input:not([type=checkbox]),textarea',form)?.focus();
    });
}

function pathsFor(op) {
    return op.pairs?.map(([from,to]) => from+' → '+to) || op.paths || [op.target];
}

const operationIcons = {create:'＋',copy:'⧉',move:'⇄',delete:'⌫',purge:'!',restore:'↶',edit:'✎',upload:'↑',chmod:'⚿'};
const labels = {
    create:'Crear',copy:'Copiar',move:'Mover o renombrar',delete:'Mover a papelera',
    purge:'Eliminar definitivamente',restore:'Restaurar',edit:'Guardar nueva versión',upload:'Subir archivo',chmod:'Cambiar permisos'
};
async function change(op, file, finish = true, detail) {
    setStatus('Preparando '+labels[op.op].toLowerCase()+'…');
    let token;
    try {
        token = await post({...op,phase:'prepare'},file);
    } catch (error) {
        if (error.status!==409 || !('replace' in op) || op.replace) throw error;
        const confirms = input('checkbox');
        confirms.required = true;
        if (!await ask('Conflicto de nombres',[node('p',error.message),field('Confirmar reemplazo',confirms)],'Ver operación')) {
            dialog.close();
            setStatus('Operación cancelada');
            return false;
        }
        op.replace = true;
        token = await post({...op,phase:'prepare'},file);
    }
    const password = input('password');
    password.autocomplete = 'current-password';
    password.required = true;
    password.maxLength = 256;
    const description = node('div',undefined,'scope operation-scope');
    description.append(node('strong',op.pairs ? 'Origen y destino' : 'Elementos afectados'));
    for (const path of (detail ? [...pathsFor(op),...detail] : pathsFor(op))) description.append(node('div',path));
    if (op.replace) description.append(node('p','Se conservará el archivo anterior en la papelera.','danger'));
    const fields = [description];
    if (op.op==='purge' || pathsFor(op).length>1) {
        const confirm = input('checkbox');
        confirm.required = true;
        fields.push(field('Confirmo todos los elementos',confirm));
    }
    fields.push(field('Contraseña de Explorer',password));
    if (op.op==='purge') description.append(node('p','Los elementos se eliminarán de forma permanente.','danger'));
    if (op.op==='chmod') description.append(node('p','Nuevo modo octal '+op.mode));
    if (!await ask(labels[op.op],fields,'Autorizar y ejecutar',{icon:operationIcons[op.op],danger:op.op==='purge'})) {
        setStatus('Operación cancelada');
        return false;
    }
    const value = password.value;
    password.value = '';
    dialog.close();
    progress.hidden = false;
    progress.removeAttribute('value');
    try {
        const result = await post({...op,phase:'execute',nonce:token.nonce,password:value},file);
        setStatus(labels[op.op]+' · operación '+result.id);
    } finally { progress.hidden = true; }
    if (finish) await Promise.allSettled([...panels.map(p => p.load()), recent()]);
    return true;
}

async function transfer(paths,to,op) {
    if (!paths.length) throw new Error('Seleccioná los elementos de origen');
    return change({op,pairs:paths.map(path=>[path,to.location+'/'+pathName(path)]),replace:false});
}

function download(path) {
    const link = node('a');
    link.href = url({op:'download',path});
    link.download = pathName(path);
    link.click();
}

function media(panel,row) {
    const entries = panel.entries.filter(entry => entry.media);
    const index = entries.findIndex(entry => entry.path===row.path);
    const element = node('iframe',undefined,'media-frame');
    element.title = row.name;
    element.allowFullscreen = true;
    element.allow = 'fullscreen; xr-spatial-tracking';
    element.src = '/explorer/view?'+new URLSearchParams({path:row.path, kind:row.media.startsWith('image/')?'photo':'video'});
    const controls = node('div',undefined,'modal-actions');
    const previous = button('‹ Anterior',() => media(panel,entries[index-1]));
    previous.disabled = index<=0;
    const next = button('Siguiente ›',() => media(panel,entries[index+1]));
    next.disabled = index>=entries.length-1;
    controls.append(previous,next,button('Descargar',() => download(row.path)));
    modal(row.name,[element,controls],true);
}
dialog.addEventListener('close',() => {
    if (!dialog.open) $('#modal').replaceChildren();
});

function highlight(line) {
    const code = node('span');
    const tokens = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/.*|#.*|\b(?:const|function|return|let|var|if|else|class|new|false|true|null|def|import|from|public|private|foreach|echo|SELECT|FROM)\b|\b\d+(?:\.\d+)?\b)/g;
    let offset = 0;
    for (const match of line.matchAll(tokens)) {
        code.append(line.slice(offset,match.index));
        const token = match[0];
        const cls = token.startsWith('//')||token.startsWith('#')?'comment':/^['"]/.test(token)?'string':/^\d/.test(token)?'number':'keyword';
        code.append(node('span',token,cls));
        offset = match.index+token.length;
    }
    code.append(line.slice(offset));
    return code;
}

async function editor(panel,row) {
    const current = $('#editor-dock textarea');
    if (current?.dataset.dirty==='true' && !window.confirm('¿Descartar los cambios pendientes y abrir otro archivo?')) return;
    const response = await protectedRead('text',{path:row.path});
    let original = response.text;
    const content = node('textarea');
    content.value = original;
    content.wrap = 'off';
    content.spellcheck = false;
    content.setAttribute('aria-label','Contenido del archivo');
    const surface = node('div',undefined,'editor');
    const numbers = node('pre',undefined,'lines');
    const colors = node('pre',undefined,'colors');
    const status = node('span');
    const save = button('Guardar',guarded(async () => {
        const text = content.value;
        const op = {op:'edit',target:row.path,version:response.version,text};
        if (!await change(op,undefined,true)) { showEditor(); return; }
        const updated = await get('text',{path:row.path});
        original = updated.text;
        response.version = updated.version;
        showEditor();
        redraw();
    }));
    save.classList.add('primary');
    let pending;
    const scroll = () => {
        numbers.scrollTop = colors.scrollTop = content.scrollTop;
        colors.scrollLeft = content.scrollLeft;
    };
    const redraw = () => {
        const rows = content.value.split('\n');
        numbers.textContent = rows.map((_,i)=>i+1).join('\n')+'\n';
        if (content.value.length<=120000 && rows.length<=6000) {
            const frag = document.createDocumentFragment();
            for (const line of rows) frag.append(highlight(line),'\n');
            colors.replaceChildren(frag);
        } else colors.textContent = content.value+'\n';
        content.dataset.dirty = String(content.value!==original);
        status.textContent = content.value===original?'Sin cambios':'Cambios pendientes';
        save.disabled = content.value===original;
        scroll();
    };
    content.addEventListener('input',() => {
        content.dataset.dirty = String(content.value!==original);
        clearTimeout(pending);
        pending = setTimeout(redraw,65);
    });
    content.addEventListener('scroll',scroll);
    surface.append(numbers,colors,content);
    const query = input('search');
    query.placeholder = 'Buscar';
    query.setAttribute('aria-label','Buscar en el editor');
    const replacement = input('text');
    replacement.placeholder = 'Reemplazar por';
    replacement.setAttribute('aria-label','Reemplazar por');
    const tools = node('div',undefined,'editor-tools');
    const find = () => {
        if (!query.value) return;
        let pos = content.value.indexOf(query.value,content.selectionEnd);
        if (pos<0) pos = content.value.indexOf(query.value);
        if (pos<0) { status.textContent = 'Texto no encontrado'; return; }
        content.focus();
        content.setSelectionRange(pos,pos+query.value.length);
    };
    tools.append(query,button('Buscar siguiente',find),replacement,button('Reemplazar todo',() => {
        if (!query.value) return;
        content.value = content.value.replaceAll(query.value,()=>replacement.value);
        redraw();
    }));
    const actions = node('div',undefined,'modal-actions');
    const writable = roots.find(root=>root.path===row.path.split('/')[0])?.writable;
    if (!writable) content.readOnly = true;
    actions.append(status);
    if (writable) actions.append(save);
    function showEditor() {
        const head = node('div',undefined,'dock-heading');
        head.append(node('strong',row.name),button('Cerrar editor',() => {
            if (content.value!==original && !window.confirm('¿Cerrar el editor y descartar los cambios pendientes?')) return;
            $('#editor-dock').replaceChildren(node('div','Editor','dock-heading'),node('p','Abrí un archivo de texto para editarlo.','empty'));
        }));
        $('#editor-dock').hidden = false;
        $('#editor-tab').setAttribute('aria-pressed','true');
        $('#editor-dock').replaceChildren(head,tools,surface,actions);
    }
    showEditor();
    redraw();
}

async function openRow(panel,row) {
    if (row.protected) return properties(panel,row.path,row);
    if (row.kind==='folder') return panel.navigate(row.openPath || row.path);
    if (row.media) {
        if (row.requiresUnlock) await protectedRead('properties',{path:row.path});
        return media(panel,row);
    }
    if (row.text) return editor(panel,row);
    return properties(panel,row.path);
}

async function properties(panel,path,inventoryRow) {
    const row = inventoryRow ?? await protectedRead('properties',{path});
    const detail = node('div',undefined,'scope');
    for (const line of [row.path,row.type,size(row.size),date(row.modified),'Permisos '+row.mode+' · UID '+row.uid+' · GID '+row.gid]) detail.append(node('div',line));
    const controls = node('div',undefined,'modal-actions');
    if (row.kind==='file' && !row.protected) controls.append(button('Descargar',guarded(() => downloadRow(row))));
    if (roots.find(root=>root.path===path.split('/')[0])?.writable) controls.append(button('Cambiar permisos',guarded(async () => {
        const mode = input('text',row.mode);
        mode.pattern = '0?[0-7]{3}';
        mode.required = true;
        if (await ask('Permisos de '+row.name,[field('Modo octal',mode)])) await change({op:'chmod',target:path,mode:mode.value});
    })));
    modal('Propiedades',[detail,controls]);
}

async function downloadRow(row) {
    if (row.requiresUnlock) await protectedRead('properties',{path:row.path});
    download(row.path);
}

function writable(path) {
    return roots.some(root => root.writable && root.path===path.split('/')[0]);
}

function context(event,panel,row) {
    const menu = $('#context');
    const other = panels.find(p=>p!==panel);
    const selected = [...panel.selected];
    const canWrite = selected.every(writable);
    const options = [
        ['Abrir',() => openRow(panel,row),!row.protected],
        ['Propiedades',() => properties(panel,row.path,row.protected || row.type==='Enlace' ? row : undefined),true],
        ['Descargar',() => downloadRow(row),row.kind==='file' && !row.protected && row.type!=='Enlace'],
        ['Copiar al otro panel',() => transfer(selected,other,'copy'),writable(other.location)],
        ['Mover al otro panel',() => transfer(selected,other,'move'),canWrite && writable(other.location)],
        ['Renombrar',() => action('rename'),canWrite && selected.length===1],
        ['Eliminar',() => action('delete'),canWrite]
    ];
    menu.replaceChildren(...options.map(([label,run,enabled]) => {
        const item = button(label,guarded(async () => {
            menu.hidden = true;
            await run();
        }));
        item.disabled = !enabled;
        if (!enabled) item.title = 'Acción no disponible para esta selección o destino';
        return item;
    }));
    menu.hidden = false;
    menu.style.left = Math.min(event.clientX, innerWidth-menu.offsetWidth-4)+'px';
    menu.style.top = Math.min(event.clientY, innerHeight-menu.offsetHeight-4)+'px';
}

async function trash() {
    const entries = await get('trash');
    const rows = [];
    for (const row of entries) {
        const item = node('div',undefined,'trashrow');
        item.append(node('div',row.original),node('div',date(row.deleted)+' · '+(row.folder?'Carpeta':size(row.size)),'meta'));
        const controls = node('div',undefined,'modal-actions');
        controls.append(button('Restaurar',guarded(async () => {
            if (await change({op:'restore',paths:[row.id],replace:false},undefined,true,[row.original])) await trash();
        })),button('Eliminar definitivamente',guarded(async () => {
            if (await change({op:'purge',paths:[row.id]},undefined,true,[row.original])) await trash();
        })));
        item.append(controls);
        rows.push(item);
    }
    modal('Papelera · '+size(entries.reduce((n,row)=>n+row.size,0)),rows.length?rows:[node('p','La papelera está vacía.')]);
}

async function history(page=0) {
    const entries = await get('history',{page});
    const labels = entries.map(row => {
        const el = node('div',undefined,'logrow');
        el.append(node('strong',row.operation+' · '+row.result),node('div',date(row.time)+' · '+row.ip+' · '+row.user),
            node('div',row.paths+(row.error?' · '+row.error:'')),node('small',row.id));
        return el;
    });
    const controls = node('div',undefined,'modal-actions');
    const previous = button('Anterior',guarded(() => history(page-1)));
    previous.disabled = !page;
    const next = button('Siguiente',guarded(() => history(page+1)));
    next.disabled = entries.length<80;
    controls.append(previous,next);
    modal('Historial',[...labels,controls]);
}

async function search(panel) {
    const fields = [['name','Nombre','search'],['ext','Extensión','text'],['after','Desde (UTC)','date'],
        ['before','Hasta (UTC)','date'],['min','Mínimo en bytes','number'],['max','Máximo en bytes','number']];
    const inputs = fields.map(([key,label,type]) => {
        const el = input(type,panel.filters?.[key] || '');
        if (type==='number') el.min = '0';
        return [key,el,field(label,el)];
    });
    if (!await ask('Buscar en '+panel.location,inputs.map(row=>row[2]),'Buscar')) return;
    dialog.close();
    const old = [panel.filters,panel.page];
    panel.filters = Object.fromEntries(inputs.map(([key,el])=>[key,el.value]));
    panel.page = 0;
    try { await panel.load(0); } catch (error) { [panel.filters,panel.page] = old; throw error; }
}

async function disconnectRemote() {
    const response = await fetch('/api/disconnect',{method:'POST',headers:{'X-CSRF-Token':session.csrf}});
    unpack(response.status,await response.json());
    for (const panel of panels) {
        panel.memo.clear();
        if (panel.location==='remote' || panel.location.startsWith('remote/')) await panel.navigate('trabajo');
        panel.history = [panel.location];
        panel.index = 0;
        panel.renderBar();
    }
    clipboard = null;
    $('#volumes [data-root="remote"]')?.remove();
    roots = roots.filter(root=>root.path!=='remote');
    $('#disconnect').hidden = true;
    setStatus('Sesión SFTP cerrada');
}

async function connectDialog() {
    const host = input('text'); host.placeholder = 'IP o dominio'; host.required = true;
    host.spellcheck = false;
    const port = input('number','22'); port.min = '1'; port.max = '65535'; port.required = true;
    const user = input('text'); user.placeholder = 'Usuario SSH'; user.required = true;
    const pass = input('password'); pass.placeholder = 'Contraseña del servidor';
    const key = input('file');
    const fingerprint = input('text'); fingerprint.placeholder = 'SHA256:…'; fingerprint.spellcheck = false;
    const passphrase = input('password');
    for (const field of [user,pass,passphrase]) field.autocomplete = 'off';
    const endpoint = node('div',undefined,'connection-endpoint');
    endpoint.append(field('IP o dominio',host),field('Puerto',port));
    const advanced = node('details',undefined,'connection-options');
    advanced.append(node('summary','Clave privada y huella SSH'),
        field('Clave privada',key),field('Frase de la clave',passphrase),field('Huella SSH',fingerprint));
    let connection;
    try {
        const accepted = await ask('Conectar a un servidor SFTP',[
            node('p','Ingresá los datos SSH de tu servidor OVHcloud o de otro proveedor.','dialog-description'),
            endpoint,field('Usuario SSH',user),field('Contraseña SSH',pass),advanced
        ],'Conectar SFTP',{
            icon:'⇄',
            submit:async () => {
                const privateKey = key.files[0];
                if (!pass.value && !privateKey) throw new Error('Ingresá la contraseña SSH o elegí una clave privada.');
                if (privateKey?.size>65536) throw new Error('La clave privada supera los 64 KiB.');
                const res = await fetch('/api/connect',{
                    method:'POST',
                    headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
                    body:JSON.stringify({
                        host:host.value.trim(),port:Number(port.value),username:user.value.trim(),
                        password:pass.value || null,private_key:privateKey ? await privateKey.text() : null,
                        passphrase:passphrase.value || null,fingerprint:fingerprint.value.trim() || null
                    })
                });
                connection = await res.json();
                if (!res.ok) {
                    if (res.status===403) advanced.open = true;
                    throw new Error(connection.detail || connection.error || 'Error al conectar');
                }
            }
        });
        if (!accepted) return;
    } finally {
        pass.value = passphrase.value = key.value = '';
    }
    dialog.close();
    const locations = await get('roots');
    showLocations(locations);
    await active.navigate('remote');
    setStatus('Conectado a '+connection.host);
}

function showLocations(locations) {
    roots = locations.volumes;
    $('#disconnect').hidden = !roots.some(root=>root.path==='remote');
    $('#volumes').replaceChildren(...roots.map(root => {
        const tab = button(root.name,guarded(() => active.navigate(root.path)));
        tab.dataset.root = root.path;
        return tab;
    }));
    $('#tree').replaceChildren(...roots.map(root => treeItem(root.path,root.name)));
    active.activate();
}

async function action(name) {
    const panel = active;
    const paths = [...panel.selected];
    if (name==='connect') return connectDialog();
    if (name==='search') return search(panel);
    if (name==='trash') return trash();
    if (name==='history') return history();
    if (name==='upload') { uploadPanel = panel; $('#file').click(); return; }
    if (name==='copy' || name==='cut') {
        if (!paths.length) throw new Error('Seleccioná los elementos de origen');
        clipboard = {op:name==='copy'?'copy':'move',paths};
        setStatus(paths.length+' elementos preparados. Elegí el panel de destino y pulsá Pegar.');
        return;
    }
    if (name==='paste') {
        if (!clipboard) throw new Error('Primero copiá o cortá una selección');
        if (await transfer(clipboard.paths,panel,clipboard.op) && clipboard.op==='move') clipboard = null;
        return;
    }
    if (name==='delete') {
        if (!paths.length) throw new Error('Seleccioná los elementos que querés eliminar');
        return change({op:'delete',paths});
    }
    const rename = name==='rename';
    if (rename && paths.length!==1) throw new Error('Seleccioná un elemento para renombrar');
    const path = rename ? paths[0].split('/').slice(0,-1).join('/') : panel.location;
    const target = input('text',rename?pathName(paths[0]):'');
    target.required = true;
    target.maxLength = 200;
    target.pattern = '[^/]+';
    const kind = name==='new-folder'?'folder':'file';
    if (!await ask(rename?'Renombrar':labels.create+(kind==='folder'?' carpeta':' archivo'),[field('Nombre',target)])) return;
    const destination = path+'/'+target.value;
    return change(rename?{op:'move',pairs:[[paths[0],destination]],replace:false}:{op:'create',target:destination,kind});
}

function treeItem(path,name) {
    const detail = node('details');
    const summary = node('summary');
    const children = node('div');
    summary.append(button(name,guarded(async e => {
        e.preventDefault();
        await active.navigate(path);
        detail.open = true;
    })));
    detail.append(summary,children);
    detail.addEventListener('toggle',guarded(async () => {
        if (!detail.open) return;
        const result = await protectedRead('list',{path});
        children.replaceChildren(...result.entries.filter(row=>row.kind==='folder').map(row=>treeItem(row.openPath || row.path,(row.protected?'🔒 ':'')+row.name)));
    }));
    return detail;
}


const queuedThumbnails = [];
let activeThumbnails = 0;

function loadThumbnails() {
    while (activeThumbnails < 2 && queuedThumbnails.length) {
        const thumbnail = queuedThumbnails.shift();
        if (!thumbnail.isConnected) continue;
        activeThumbnails++;
        const video = thumbnail.tagName==='VIDEO';
        const event = video ? 'loadeddata' : 'load';
        const finish = () => {
            clearTimeout(timeout);
            thumbnail.removeEventListener(event,finish);
            thumbnail.removeEventListener('error',finish);
            activeThumbnails--;
            loadThumbnails();
        };
        const timeout = setTimeout(() => {
            thumbnail.removeAttribute('src');
            if (video) thumbnail.load();
            finish();
        },8000);
        thumbnail.addEventListener(event,finish);
        thumbnail.addEventListener('error',finish);
        thumbnail.src = thumbnail.dataset.source;
    }
}

const thumbnailObserver = new IntersectionObserver(entries => {
    for (const {target,isIntersecting} of entries) {
        if (!isIntersecting || !target.isConnected) continue;
        thumbnailObserver.unobserve(target);
        const thumbnail = target.querySelector('[data-source]');
        if (thumbnail) queuedThumbnails.push(thumbnail);
    }
    loadThumbnails();
});

let unlockPending;
async function protectedRead(op, fields) {
    try {
        return await get(op,fields);
    } catch (error) {
        if (error.status!==428) throw error;
        if (!unlockPending) {
            unlockPending = (async () => {
                const password = input('password');
                password.required = true;
                password.autocomplete = 'current-password';
                if (!await ask('Acceso al sistema protegido',[
                    node('p','Ruta: '+fields.path.replace(/^vps/,'')),
                    node('p','La contraseña de Explorer habilita cinco minutos de lectura.'),
                    field('Contraseña de Explorer',password)
                ],'Desbloquear lectura')) throw new Error('Acceso cancelado');
                const value = password.value;
                password.value = '';
                dialog.close();
                await post({op:'unlockSystem',password:value});
            })().finally(() => { unlockPending = undefined; });
        }
        await unlockPending;
        return get(op,fields);
    }
}

$('#about').addEventListener('click',() => {
    const logo = node('img',undefined,'about-logo');
    logo.src = '/explorer/assets/img/explorer-logo.png';
    logo.alt = '360YA Explorer Community';
    logo.width = 512;
    logo.height = 341;
    const website = node('a','360YA Explorer Community en GitHub');
    website.href = 'https://github.com/EL-CHANGO-v4/360ya-explorer-community';
    website.target = '_blank';
    website.rel = 'noopener noreferrer';
    const content = node('div',undefined,'about-content');
    content.append(logo,node('strong',session.version),
        node('p','Explorador de archivos de dos paneles para trabajar en Debian o conectarte a servidores por SFTP. Incluye editor de texto, papelera e historial de operaciones.'),
        website,node('small','Licencia MIT · 360YA Community'));
    modal('Acerca de 360YA Explorer',[content],false,'ⓘ');
});

$('#change-password').addEventListener('click',guarded(async () => {
    const current = input('password');
    const replacement = input('password');
    const confirmation = input('password');
    for (const field of [current,replacement,confirmation]) {
        field.required = true;
        field.maxLength = 256;
        field.autocomplete = field===current?'current-password':'new-password';
    }
    replacement.minLength = confirmation.minLength = 12;
    let profileNeedsSaving = false;
    const accepted = await ask('Cambiar contraseña',[
        node('p','Usá al menos 12 caracteres. Después del cambio, volvé a iniciar sesión.','dialog-description'),
        field('Contraseña actual',current), field('Nueva contraseña',replacement), field('Repetí la nueva contraseña',confirmation)
    ],'Guardar contraseña',{
        icon:'⚿',pending:'Guardando…',
        submit:async () => {
            const oldPassword = current.value;
            const newPassword = replacement.value;
            if (newPassword!==confirmation.value) throw new Error('Las contraseñas nuevas no coinciden.');
            let encrypted;
            try {
                const saved = localStorage.getItem(profileKey);
                if (saved) encrypted = await encryptProfile(newPassword,await decryptProfile(oldPassword,saved));
            } catch {
                profileNeedsSaving = true;
            }
            const response = await fetch('/api/password',{
                method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
                body:JSON.stringify({current:oldPassword,replacement:newPassword})
            });
            unpack(response.status,await response.json());
            if (encrypted) {
                try { localStorage.setItem(profileKey,encrypted); }
                catch { profileNeedsSaving = true; }
            }
        }
    });
    for (const field of [current,replacement,confirmation]) field.value = '';
    if (accepted) location.replace('/explorer?password='+(profileNeedsSaving?'profile':'changed'));
}));

$('#logout').addEventListener('click',guarded(async () => {
    try { await post({op:'logout'}); }
    catch (error) { if (error.status!==401) throw error; }
    location.replace('/explorer');
}));

const operationNames = {
    create:'Creación', copy:'Copia', move:'Movimiento', edit:'Edición',
    delete:'Papelera', restore:'Restauración', purge:'Eliminación definitiva', upload:'Subida', chmod:'Permisos'
};
async function recent() {
    const rows = (await get('history')).filter(row=>row.operation in operationNames && row.result!=='started').slice(0,10);
    $('#recent').replaceChildren(...(rows.length ? rows.map(row => {
        const entry = node('div',undefined,'activity');
        const title = node('strong',operationNames[row.operation]);
        const state = node('span',row.result==='ok'?'Completada':'Error',row.result==='ok'?'good':'danger');
        entry.append(title,state,node('time',date(row.time)),node('p',Object.values(JSON.parse(row.paths)).flat(2).join(' → ')));
        return entry;
    }) : [node('p','Sin operaciones de archivos recientes.','empty')]));
}

$('#tree-toggle').addEventListener('click', () => {
    const open = $('.workspace').classList.toggle('show-tree');
    $('#tree-toggle').setAttribute('aria-expanded',String(open));
});
for (const [tab,pane] of [['#editor-tab','#editor-dock'],['#history-tab','#history-dock']]) {
    $(tab).addEventListener('click',guarded(async () => {
        $(pane).hidden = !$(pane).hidden;
        $(tab).setAttribute('aria-pressed',String(!$(pane).hidden));
        if (pane==='#history-dock' && !$(pane).hidden) await recent();
    }));
}

const panels = [new Panel('left','trabajo'),new Panel('right','archivo')];
panels[0].activate();

$('#disconnect').addEventListener('click',guarded(disconnectRemote));

$('#actions').addEventListener('click',guarded(e => {
    if (e.target.dataset.action) return action(e.target.dataset.action);
}));
$('#file').addEventListener('change',guarded(async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size>512*1024*1024) throw new Error('El límite de subida es 512 MiB');
    await change({op:'upload',target:uploadPanel.location+'/'+file.name,replace:false},file);
}));
document.addEventListener('pointerdown',e => { if (!e.target.closest('#context')) $('#context').hidden = true; });
document.addEventListener('keydown',guarded(e => {
    if (e.key==='Escape') $('#context').hidden = true;
    if (dialog.open || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const cmd = e.ctrlKey || e.metaKey;
    const actions = {c:'copy',x:'cut',v:'paste',f:'search'};
    const name = cmd ? actions[e.key.toLowerCase()] : {Delete:'delete',F2:'rename'}[e.key];
    if (name) { e.preventDefault(); return action(name); }
}));
(async () => {
    try {
        session = await get('session');
        $('#identity').textContent = session.email;
        $('#version').textContent = 'v'+session.version;
        const locations = await get('roots');
        showLocations(locations);
        $('#protected').replaceChildren(...locations.protected.map(path=>node('div','🔒 '+path,'protected')));
        await Promise.all(panels.map(panel=>panel.load()));
        setStatus('Sesión de Explorer activa');
        await recent();
        if (roots.some(root=>root.path==='remote')) await active.navigate('remote');
    } catch (error) {
        setStatus(error.message);
        if (error.status===401) location.reload();
    }
})();
