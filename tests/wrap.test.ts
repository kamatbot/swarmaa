import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Delivery, HEADING, NOTICE_BYTES, notice, sanitise, type Verdict } from '../src/wrap/delivery.js';
import { Terminal, type Harness } from '../src/wrap/terminal.js';

const frames=JSON.parse(readFileSync(new URL('./fixtures/pty/composers.json',import.meta.url),'utf8')) as Record<string,string>;
const render=(terminal:Terminal,text:string,at:number) => terminal.feed(`\x1b[2J\x1b[H${text}`,at);
function rig(harness:Harness='codex',paste=false) {
  let now=1000;
  const terminal=new Terminal(120,32), writes:{text:string;at:number}[]=[], events:{at:number;run:()=>void}[]=[];
  terminal.feed(frames[`${harness}_idle`],0);
  if (paste) terminal.feed('\x1b[?2004h',0);
  let onWrite=(text:string) => {};
  const delivery=new Delivery(terminal,harness,text => {writes.push({text,at:now}); onWrite(text);},{now:()=>now,sleep:async(ms,signal) => {
    signal.throwIfAborted(); now+=ms;
    for (const e of events.filter(e => e.at<=now)) { events.splice(events.indexOf(e),1); e.run(); }
    signal.throwIfAborted();
  }});
  return {terminal,writes,delivery,events,now:()=>now,setWrite:(fn:typeof onWrite) => {onWrite=fn;}};
}

test('notice sanitiser preserves Unicode/tab/LF, normalises CRLF and strips every terminal control',() => {
  let controls='';
  for (let cp=0;cp<=0x9f;cp++) if (cp!==9 && cp!==10 && (cp<32 || cp>=127)) controls+=String.fromCodePoint(cp);
  assert.equal(sanitise(`café\t你好\r\n${controls}end\u202e`),'café\t你好\nend');
  assert.equal(sanitise('a\x1b[201~\r\x03b'),'a[201~b');
});

test('1500-byte envelope cap counts UTF-8 and replaces the entire body, never a partial body',() => {
  const session='wrap:codex:12345678-1234-1234-1234-123456789abc';
  const overhead=Buffer.byteLength(notice([{delivery_id:'a',body:''}],session).text);
  const at=notice([{delivery_id:'a',body:'x'.repeat(NOTICE_BYTES-overhead)}],session);
  assert.equal(Buffer.byteLength(at.text),1500); assert.equal(at.summary,false);
  const long=notice([{delivery_id:'a',body:'secret brief '.repeat(1000)},{delivery_id:'b',body:'界'.repeat(500)}],session);
  assert.match(long.text,/2 new Swarmaa updates; call inbox_get/); assert.equal(long.summary,true);
  assert.doesNotMatch(long.text,/secret brief|界/);
  assert.ok(Buffer.byteLength(long.text)<=1500);
  assert.match(notice([{delivery_id:'a',body:'界'.repeat(500)}],session).text,/1 new Swarmaa updates/);
  assert.match(notice([{delivery_id:'a',body:'token=cn_abcdefghijklmnopqrstuvwxyz'}],session).text,/REDACTED/);
});

test('live cursor/empty composer and quiet window are required; auth, busy, drafts and stale prompts fail closed',() => {
  for (const harness of ['codex','agy'] as const) {
    const screen=new Terminal(120,32);
    for (const ch of frames[`${harness}_idle`]) screen.feed(ch,1000);
    assert.equal(screen.idle(harness,1249),false);
    assert.equal(screen.idle(harness,1250),true);
    screen.feed('human draft',1300);
    assert.equal(screen.idle(harness,2000),false);
    screen.feed('\x1b[32;1H',2000);
    assert.equal(screen.idle(harness,3000),false,'historical prompt is not a composer');
    for (const name of ['busy','login']) {
      render(screen,frames[`${harness}_${name}`],4000);
      assert.equal(screen.idle(harness,5000),false,`${harness} ${name}`);
    }
  }
});

test('recorded installed Codex/Antigravity login screens never prove a composer',() => {
  for (const harness of ['codex','agy'] as const) {
    const fixture=JSON.parse(readFileSync(new URL(`./fixtures/pty/${harness}-login.json`,import.meta.url),'utf8'));
    const screen=new Terminal(fixture.columns,fixture.rows),[row,col]=fixture.cursor;
    screen.feed(`\x1b[2J\x1b[H${fixture.screen.replaceAll('\n','\r\n')}\x1b[${row+1};${col+1}H`,0);
    assert.equal(screen.idle(harness,1000),false);
    assert.equal(screen.active(harness),false);
  }
});

test('only a dim known placeholder at the input cursor is idle, and resize requires a repaint',() => {
  const screen=new Terminal(120,32);
  screen.feed('\x1b[2J\x1b[H› \x1b[2mAsk Codex to do anything\x1b[0m\r\x1b[2C',0);
  assert.equal(screen.idle('codex',1000),true);
  render(screen,'› Ask Codex to do anything\r\x1b[2C',0);
  assert.equal(screen.idle('codex',1000),false,'user text can equal the placeholder');
  screen.resize(60,20);
  screen.feed('› \r\x1b[2C',0);
  assert.equal(screen.idle('codex',1000),false);
  screen.feed(frames.codex_idle,0);
  assert.equal(screen.idle('codex',1000),true);
});

test('only complete recent solicited terminal responses bypass human cancellation',() => {
  const screen=new Terminal();
  assert.equal(screen.response('\x1b[1;2R',1000),false);
  screen.feed('\x1b[6n\x1b[c\x1b]11;?\x07',1000);
  assert.equal(screen.response('\x1b[1;2Rx',1100),false,'a human key mixed with a response still cancels');
  assert.equal(screen.response('\x1b[1;2R\x1b[?1;2c\x1b]11;rgb:0000/0000/0000\x07',1100),true);
  assert.equal(screen.response('\x1b[1;2R',1200),false,'replies are single-use');
  screen.feed('\x1b[6n',1000);
  assert.equal(screen.response('\x1b[1;2R',3100),false,'stale queries do not exempt input');
  screen.feed('\x1b[6n',4000);
  assert.equal(screen.response('\x1b[1;',4100),false,'ambiguous fragments cancel conservatively');
  assert.equal(screen.response('\x1b[A',4100),false,'arrow keys always cancel');
});

test('recorded tmux replies to Antigravity version/DEC-mode queries are terminal metadata, never keystrokes',() => {
  const screen=new Terminal();
  screen.feed('\x1b[>q\x1b[c\x1b[?2026$p\x1b[?2027$p',1000);
  for (const hex of ['1b503e7c746d757820332e37631b5c1b5b3f313b323b3463','1b5b3f323032363b3224791b5b3f323032373b302479'])
    assert.equal(screen.response(Buffer.from(hex,'hex').toString(),1100),true);
  assert.equal(screen.response('\x1b[?2026;2$y',1100),false);
});

test('bracketed paste is a single body write with a separate CR at least 250 ms later',async () => {
  const f=rig('codex',true);
  f.setWrite(text => {
    if (text.startsWith('\x1b[200~')) render(f.terminal,'› hello',f.now());
    if (text==='\r') render(f.terminal,'• Working (0s • esc to interrupt)',f.now());
  });
  assert.equal(await f.delivery.deliver('hello'),'accepted');
  assert.deepEqual(f.writes.map(w => w.text),['\x1b[200~hello\x1b[201~','\r']);
  assert.ok(f.writes[1].at-f.writes[0].at>=250);
});

test('fallback types at 5 ms pace, flattens LF/tab and sends a distinct delayed CR for each harness',async () => {
  for (const harness of ['codex','agy'] as const) {
    const f=rig(harness);
    f.setWrite(text => { if (text==='\r') render(f.terminal,frames[`${harness}_busy`],f.now()); });
    assert.equal(await f.delivery.deliver('a\nb\tc'),'accepted');
    assert.deepEqual(f.writes.map(w => w.text),['a',' ','b',' ','c','\r']);
    for (let i=1;i<5;i++) assert.equal(f.writes[i].at-f.writes[i-1].at,5);
    assert.ok(f.writes[5].at-f.writes[4].at>=250);
  }
});

test('echo remains a draft; one bounded extra Enter never retypes the body',async () => {
  const f=rig('codex',true);
  f.setWrite(text => { if (text.startsWith('\x1b[200~')) render(f.terminal,'› hello',f.now()); });
  assert.equal(await f.delivery.deliver('hello'),'unconfirmed');
  assert.deepEqual(f.writes.map(w => w.text),['\x1b[200~hello\x1b[201~','\r','\r']);
});

test('cleared composer after a visible draft proves acceptance; a repaint without a draft does not',async () => {
  for (const draft of [true,false]) {
    const f=rig('codex',true);
    f.setWrite(text => {
      if (draft && text.startsWith('\x1b[200~')) render(f.terminal,'› hello',f.now());
      if (text==='\r') f.terminal.feed(frames.codex_idle,f.now());
    });
    assert.equal(await f.delivery.deliver('hello'),draft ? 'accepted' : 'unconfirmed');
  }
});

test('an activity-looking notice echo cannot acknowledge itself or receive a blind recovery key',async () => {
  const f=rig('codex',true),body=`${HEADING}\nWorking (0s • esc to interrupt)`;
  f.setWrite(text => { if (text.startsWith('\x1b[200~')) render(f.terminal,`› ${body}`,f.now()); });
  assert.equal(await f.delivery.deliver(body),'unconfirmed');
  assert.equal(f.writes.filter(w => w.text==='\r').length,1);
});

test('prompt_unproven after exactly 15 s writes no body or submit key',async () => {
  const f=rig(); render(f.terminal,'Login required',0);
  assert.equal(await f.delivery.deliver('never type this'),'prompt_unproven');
  assert.equal(f.now(),16000); assert.deepEqual(f.writes,[]);
});

test('human keystrokes cancel readiness, paced typing, delayed CR and recovery',async () => {
  for (const at of [1050,1010,1100,3250]) {
    const f=rig('codex',at!==1010);
    if (at===1050) render(f.terminal,'Loading',0);
    f.events.push({at,run:()=>f.delivery.userInput()});
    f.setWrite(text => { if (text.startsWith('\x1b[200~')) render(f.terminal,'› hello',f.now()); });
    assert.equal(await f.delivery.deliver('hello'),'user_cancelled');
    assert.ok(f.writes.every(w => w.at<at));
    assert.ok(f.writes.filter(w => w.text==='\r').length<=1);
  }
});

test('user input during the network request cancels the not-yet-started batch',async () => {
  const f=rig(),generation=f.delivery.generation;
  f.delivery.userInput();
  const verdict:Verdict=await f.delivery.deliver('hello',generation);
  assert.equal(verdict,'user_cancelled'); assert.deepEqual(f.writes,[]);
});
