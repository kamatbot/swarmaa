// HTML, CSS and the small browser-side WebAuthn client shared by /account and the OAuth approval page.
// No external scripts or fonts; every inline script/style carries the per-response CSP nonce.

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

const STYLE = `:root{color-scheme:dark;--bg:#06060a;--surface:rgba(255,255,255,.04);--line:rgba(255,255,255,.1);--text:#f4f4f7;--muted:#9a9aab;--grad:linear-gradient(90deg,#9be15d 0%,#3fd1a8 30%,#4cc4e8 50%,#7f9cff 72%,#a78bfa 100%)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:16px/1.55 Outfit,system-ui,-apple-system,sans-serif;display:flex;padding:24px 16px}
main{width:100%;max-width:460px;margin:auto}
h1{font-size:1.5rem;font-weight:600;letter-spacing:-.02em;margin:0 0 .5rem}
h2{font-size:1rem;font-weight:600;margin:1.5rem 0 .5rem}
p{color:var(--muted);margin:.5rem 0}
strong{color:var(--text);font-weight:500}
code{font-size:.85em;color:var(--text);word-break:break-all}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin:16px 0}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row small{display:block;color:var(--muted)}
button,select,input{font:inherit}
button{display:block;width:100%;margin-top:12px;padding:13px 18px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}
button:hover{background:var(--surface)}
button.primary{border:0;background:var(--grad);color:#06060a;font-weight:600}
button.primary:hover{filter:brightness(1.08)}
button.quiet{color:var(--muted)}
button.inline{display:inline-block;width:auto;margin:0;padding:6px 14px;font-size:.9rem}
button:disabled{opacity:.55;cursor:default}
select,input{width:100%;margin-top:6px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:#0b0b12;color:var(--text)}
label{display:block;margin-top:12px;color:var(--muted)}
details{margin-top:12px}
summary{cursor:pointer;color:var(--muted);text-align:center;padding:8px}
#pk-msg{min-height:1.4em;color:#ff9b9b;text-align:center}
`;

const CLIENT = `(()=>{
const dec=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(s+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0)).buffer};
const enc=b=>{let s='';for(const x of new Uint8Array(b))s+=String.fromCharCode(x);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
const post=async(p,b)=>{const r=await fetch(p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b)});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error((j.error&&j.error.message)||'Something went wrong. Try again.');return j};
const msg=t=>{const e=document.getElementById('pk-msg');if(e)e.textContent=t||''};
const login=async()=>{const{options:o}=await post('/account/passkeys/login/options',{});const c=await navigator.credentials.get({publicKey:{challenge:dec(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:'required'}});const r=c.response;
await post('/account/passkeys/login/verify',{response:{id:c.id,rawId:enc(c.rawId),type:c.type,authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.authenticatorData),signature:enc(r.signature),userHandle:r.userHandle?enc(r.userHandle):undefined}}})};
const register=async code=>{const{options:o}=await post('/account/passkeys/register/options',{code});const c=await navigator.credentials.create({publicKey:{rp:o.rp,user:{id:dec(o.user.id),name:o.user.name,displayName:o.user.displayName},challenge:dec(o.challenge),pubKeyCredParams:o.pubKeyCredParams,timeout:o.timeout,attestation:'none',excludeCredentials:(o.excludeCredentials||[]).map(x=>({type:'public-key',id:dec(x.id),transports:x.transports})),authenticatorSelection:o.authenticatorSelection}});const r=c.response;
await post('/account/passkeys/register/verify',{code,response:{id:c.id,rawId:enc(c.rawId),type:c.type,authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:enc(r.clientDataJSON),attestationObject:enc(r.attestationObject),transports:r.getTransports?r.getTransports():[]}}})};
const actions={login,register:b=>register(b.dataset.code),add:()=>register(undefined),logout:()=>post('/account/logout',{}),remove:b=>post('/account/passkeys/delete',{id:b.dataset.id})};
document.addEventListener('click',async ev=>{const b=ev.target.closest('[data-pk]');if(!b)return;const k=b.dataset.pk;
if((k==='login'||k==='register'||k==='add')&&!window.PublicKeyCredential){msg('This browser does not support passkeys.');return}
b.disabled=true;msg('');
try{await actions[k](b);if(b.dataset.next==='reload')location.reload();else location.assign('/account')}
catch(e){msg(e&&e.name==='NotAllowedError'?'Cancelled.':(e&&e.message)||'Something went wrong.');b.disabled=false}});
})();`;

/** Wraps page content in the shared document shell. Without a nonce no script is emitted. */
export function shell(title: string, body: string, nonce?: string): string {
  const n = nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style${n}>${STYLE}</style></head><body><main>${body}</main>${nonce ? `<script${n}>${CLIENT}</script>` : ''}</body></html>`;
}

export interface PasskeySummary { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }

export type AccountView =
  | { kind: 'unavailable' }
  | { kind: 'guest'; hasPasskeys: boolean; code?: string; codeInvalid: boolean }
  | { kind: 'owner'; passkeys: PasskeySummary[] };

const date = (value: Date | null): string => value ? value.toISOString().slice(0, 10) : 'never';

export function accountHtml(view: AccountView, nonce: string): string {
  let body: string;
  if (view.kind === 'unavailable') {
    body = '<h1>Swarmaa</h1><p>Passkeys need the public HTTPS address. Open this page from your Swarmaa domain.</p>';
  } else if (view.kind === 'owner') {
    const rows = view.passkeys.map(p => `<div class="row"><div><strong>${escapeHtml(p.name)}</strong><small>Created ${date(p.createdAt)} · last used ${date(p.lastUsedAt)}</small></div>${view.passkeys.length > 1 ? `<button class="inline quiet" data-pk="remove" data-next="reload" data-id="${escapeHtml(p.id)}">Remove</button>` : ''}</div>`).join('');
    body = `<h1>Your passkeys</h1><div class="card">${rows}</div><div id="pk-msg" role="status"></div><button data-pk="add" data-next="reload">Add another passkey</button><button class="quiet" data-pk="logout">Sign out</button>`;
  } else {
    const create = view.code ? `<button class="primary" data-pk="register" data-code="${escapeHtml(view.code)}">Create your Swarmaa passkey</button>` : '';
    const signIn = view.hasPasskeys ? `<button class="${view.code ? '' : 'primary'}" data-pk="login">Sign in with passkey</button>` : '';
    const note = view.codeInvalid ? '<p>This signup link has expired or was already used.</p>' : '';
    const help = !view.hasPasskeys && !view.code
      ? '<p>No passkey exists yet. You need a signup link from setup: run <code>npm run setup</code>, or <code>npm run admin -- passkey-invite</code> on the machine that runs Swarmaa.</p>' : '';
    body = `<h1>Swarmaa</h1><p>${view.code ? 'Create a passkey to approve agent connections.' : 'Sign in to approve agent connections.'}</p>${note}${help}<div id="pk-msg" role="status"></div>${create}${signIn}`;
  }
  return shell('Swarmaa account', body, nonce);
}
