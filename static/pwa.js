const installButton = document.getElementById('install-app');
let installPrompt;
window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
    const prompt = installPrompt;
    installPrompt = undefined;
    installButton.hidden = true;
    if (prompt) await prompt.prompt();
});
window.addEventListener('appinstalled', () => {
    installPrompt = undefined;
    installButton.hidden = true;
});
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/explorer-worker.js',{scope:'/explorer'}).catch(console.warn);
}
