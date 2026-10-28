import { Capacitor, CapacitorHttp, CapacitorCookies, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Network } from '@capacitor/network';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { apiURL, nativeOptions, safeFilename, API_ORIGIN } from './transport.mjs';

const native = Capacitor.isNativePlatform();
if (native) document.documentElement.classList.add('hw-native');
const AdminPrint = registerPlugin('AdminPrint');
let networkOK = true;
let pendingWrites = 0;
let exportsBusy = false;
const originalFetch = window.fetch.bind(window);

function showConnection(connected, text) {
  networkOK = connected;
  const banner = document.getElementById('mobileConnection');
  if (banner) {
    banner.hidden = connected;
    banner.querySelector('p').textContent = text || 'Reconnect to load current attendance and make changes.';
  }
  document.getElementById('frames')?.toggleAttribute('inert', !connected);
}

function installFetch(target) {
  const fallback = target.fetch.bind(target);
  target.fetch = async (input, init = {}) => {
    const url = apiURL(input, window.location.origin);
    if (!url || !native) return fallback(input, init);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const options = nativeOptions(url, init);
    const writing = !['GET','HEAD','OPTIONS'].includes(options.method);
    if (writing && !networkOK && !url.endsWith('/api/logout')) throw new Error('You are offline. Reconnect before saving.');
    if (writing) pendingWrites++;
    try {
      // Native requests cannot be cancelled mid-write: let the server's result
      // return rather than report failure while it is still saving attendance.
      const result = await CapacitorHttp.request(options);
      if (result.status >= 500) showConnection(false, 'The attendance server is unavailable. Retry in a moment.');
      const headers = new Headers(result.headers);
      headers.delete('set-cookie');
      headers.delete('content-encoding');
      headers.delete('content-length');
      const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
      return new target.Response([204,205,304].includes(result.status) ? null : body, {status:result.status, headers});
    } catch (error) {
      showConnection(false, writing ? 'Connection interrupted. A save may have reached the server. Reconnect and reload before trying again.' : undefined);
      throw error;
    } finally {
      if (url.endsWith('/api/logout')) {
        // Signing out must end this phone's session even if the server is offline.
        await CapacitorCookies.deleteCookie({url:API_ORIGIN+'/',key:'hw.sid'}).catch(()=>{});
      }
      if (writing) pendingWrites--;
    }
  };
}

async function exportBlob(blob, filename) {
  if (!native) return false;
  if (exportsBusy) return true;
  exportsBusy = true;
  try {
    const name = safeFilename(filename);
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject; reader.readAsDataURL(blob);
    });
    const folder = 'admin-exports';
    const result = await Filesystem.writeFile({path:folder+'/'+Date.now()+'-'+name, data, directory:Directory.Cache, recursive:true});
    await Share.share({title:name, files:[result.uri], dialogTitle:'Save or share '+name});
  } catch (error) {
    if (!/cancel/i.test(String(error.message))) window.alert('Could not share this file: '+error.message);
  } finally { exportsBusy = false; }
  return true;
}

async function printDocument(target) {
  if (!native) return target.__browserPrint?.();
  try {
    const copy = target.document.documentElement.cloneNode(true);
    copy.querySelectorAll('script,iframe').forEach(node => node.remove());
    copy.querySelectorAll('*').forEach(node => {
      for (const attr of [...node.attributes]) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    });
    copy.querySelectorAll('link[rel="stylesheet"]').forEach(node=>node.remove());
    const printStyle=target.document.createElement('style');
    printStyle.textContent='@media print { #mobileNav,#mobileMore,.mobile-page-head,.mobile-tools,#mobileAttendance,#mobileConnection{display:none!important} }';
    copy.querySelector('head').appendChild(printStyle);
    await AdminPrint.print({html:'<!doctype html>'+copy.outerHTML, title:'Attendance document'});
  } catch (error) { window.alert('Could not open Android printing: '+error.message); }
}

async function reconnect() {
  if (pendingWrites) { window.alert('Please wait for the current save to finish.'); return; }
  try {
    const r = native ? await CapacitorHttp.get({url:API_ORIGIN+'/api/me',responseType:'json',connectTimeout:30000,readTimeout:30000})
      : await originalFetch('/api/me').then(async res => ({status:res.status,data:await res.json()}));
    if (r.status >= 500) throw new Error('Server unavailable');
    window.location.reload();
  } catch (_) { showConnection(false, 'The server still cannot be reached. Please try again.'); }
}

window.HWMobile = {native, installFetch, exportBlob, printDocument, reconnect};
installFetch(window);
window.addEventListener('DOMContentLoaded', async () => {
  const banner = document.createElement('section');
  banner.id = 'mobileConnection'; banner.hidden = true; banner.setAttribute('role','alertdialog');
  banner.setAttribute('aria-label','Connection interrupted');
  banner.innerHTML = '<div><span class="mobile-offline-icon">↻</span><h2>Connection interrupted</h2><p></p><button type="button">Reconnect & reload</button></div>';
  banner.querySelector('button').onclick = reconnect;
  document.body.appendChild(banner);
  if (!networkOK) showConnection(false);
  document.addEventListener('click', async event => {
    const link = event.target.closest?.('a[download]');
    if (!native || !link) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try { await exportBlob(await originalFetch(link.href).then(r=>r.blob()), link.download); }
    catch(error) { window.alert('Could not prepare this download: '+error.message); }
  },true);
  const title = document.querySelector('.lg-card h1');
  if (title) title.innerHTML = '<span class="mobile-brandmark">HW</span>Attendance Admin';
  const subtitle = document.getElementById('lgTitleSub');
  if (subtitle) subtitle.textContent = 'Sign in with your Super Admin account';
  const logout = document.getElementById('logoutBtn');
  if (logout) { logout.textContent = 'Sign out'; logout.setAttribute('aria-label','Sign out'); }
  if (!native) return;
  await Promise.allSettled([
    StatusBar.setStyle({style:Style.Light}), StatusBar.setOverlaysWebView({overlay:false}), SplashScreen.hide(),
    Network.addListener('networkStatusChange', status => { if (!status.connected) showConnection(false); }),
    App.addListener('appStateChange', async ({isActive}) => {
      if (!isActive || !window.HWAuth?.user || pendingWrites) return;
      try {
        const res = await window.fetch('/api/me'); const body = await res.json();
        const user = body.user || body;
        if (!res.ok || user.role !== 'admin') window.HWAuth.signOut();
      } catch (_) {}
    }),
    App.addListener('backButton', () => {
      const users = document.getElementById('usersModal');
      if (users && getComputedStyle(users).display !== 'none') { document.getElementById('umClose')?.click(); return; }
      const frame = document.querySelector('#frames iframe.active');
      if (frame?.contentWindow?.HWMobileUI?.back()) return;
      if (pendingWrites) return;
      App.minimizeApp();
    })
  ]);
  const status = await Network.getStatus(); if (!status.connected) showConnection(false);
  // Export files are transient; remove the previous session's files after a day.
  try {
    const entries = await Filesystem.readdir({path:'admin-exports',directory:Directory.Cache});
    for (const file of entries.files) if (Date.now()-Number(file.name.split('-')[0])>86400000)
      await Filesystem.deleteFile({path:'admin-exports/'+safeFilename(file.name),directory:Directory.Cache});
  } catch (_) {}
});
