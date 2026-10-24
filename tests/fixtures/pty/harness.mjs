// Local PTY contract fixture; never a substitute for an authenticated Codex/Antigravity proof.
process.stdin.setRawMode(true);
let body='',wire='',pasting=false,lastBodyAt=0;
const prompt=() => process.stdout.write('\x1b[2J\x1b[H\x1b[32mPTY fixture\x1b[0m\r\n› \x1b[2mAsk Codex to do anything\x1b[0m\r\x1b[2C\x1b[?25h\x1b[?2004h');
prompt();
process.stdout.on('resize',()=>{ prompt(); process.stdout.write(`\r\nSIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`); prompt(); });
process.on('SIGTERM',()=>{ process.stdout.write('\r\nSIGNAL SIGTERM\r\n'); process.exit(41); });
process.on('SIGCONT',()=>{ process.stdout.write('\r\nSIGNAL SIGCONT\r\n'); prompt(); });
process.stdin.on('data',chunk=>{
  wire+=chunk.toString();
  while (wire) {
    if (wire.startsWith('\x1b[200~')) { pasting=true; wire=wire.slice(6); continue; }
    if (wire.startsWith('\x1b[201~')) { pasting=false; wire=wire.slice(6); continue; }
    if (wire[0]==='\x1b' && wire.length<6) break;
    const ch=wire[0]; wire=wire.slice(1);
    if (!pasting && ch==='q') process.exit(23);
    if (!pasting && ch==='\r') {
      if (Date.now()-lastBodyAt<200) { process.stdout.write('\r\nPARKED\r\n'); continue; }
      process.stdout.write(`\x1b[2J\x1b[HBODY_ACCEPTED ${JSON.stringify(body)}\r\n• Working (0s • esc to interrupt)\r\n`);
      body='';
    } else {
      body+=ch; lastBodyAt=Date.now();
      process.stdout.write(`\r\x1b[2K› ${body.replace(/\n/g,'\r\n')}`);
    }
  }
});
