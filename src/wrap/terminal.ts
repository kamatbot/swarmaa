// Readiness and wire rules adapted from AgentWorkforce Relay (Apache-2.0); see THIRD_PARTY_NOTICES.md.
export type Harness = 'codex'|'agy';

/** Bounded VT grid: readiness uses the live cursor, never an append-only output transcript. */
export class Terminal {
  private grid:{text:string;ghost:boolean}[][]=[];
  private ghost=false;
  private row=0;
  private col=0;
  private saved=[0,0];
  private escape='';
  private wrapped=false;
  private scrollTop=0;
  private scrollBottom:number;
  private visible=true;
  private reliable=true;
  private queries:{pattern:RegExp;until:number}[]=[];
  bracketedPaste=false;
  alternateScreen=false;
  changedAt=0;
  revision=0;

  constructor(public cols=80,public rows=24) {
    this.cols=Math.max(1,Math.min(500,cols)); this.rows=Math.max(1,Math.min(200,rows));
    this.scrollBottom=this.rows-1;
    this.clear();
  }
  private blank() { return {text:'',ghost:false}; }
  private clear() { this.grid=Array.from({length:this.rows},() => Array.from({length:this.cols},() => this.blank())); this.reliable=true; }
  resize(cols:number,rows:number) {
    this.cols=Math.max(1,Math.min(500,cols)); this.rows=Math.max(1,Math.min(200,rows));
    this.row=Math.min(this.row,this.rows-1); this.col=Math.min(this.col,this.cols-1);
    this.scrollTop=0; this.scrollBottom=this.rows-1; this.wrapped=false;
    // ponytail: a resize needs a full repaint before automated input; add VT reflow if a supported harness cannot repaint.
    this.clear(); this.reliable=false;
  }
  private line(row=this.row) { return this.grid[row].map(c => c.text || ' ').join('').trimEnd(); }
  private down() {
    if (this.row===this.scrollBottom) {
      this.grid.splice(this.scrollTop,1); this.grid.splice(this.scrollBottom,0,Array.from({length:this.cols},() => this.blank()));
    } else this.row=Math.min(this.rows-1,this.row+1);
  }
  feed(data:string,now=Date.now()) {
    this.changedAt=now; this.revision++;
    for (const ch of data) {
      if (this.escape) { this.sequence(ch); continue; }
      if (ch==='\x1b') { this.escape=ch; continue; }
      if (ch==='\r') { this.col=0; this.wrapped=false; }
      else if (ch==='\n') { this.down(); this.wrapped=false; }
      else if (ch==='\b') { this.col=Math.max(0,this.col-1); this.wrapped=false; }
      else if (ch==='\t') { this.col=Math.min(this.cols-1,(Math.floor(this.col/8)+1)*8); this.wrapped=false; }
      else if (!/[\p{Cc}\p{Cf}]/u.test(ch)) {
        const cp=ch.codePointAt(0)!;
        const width=/\p{Mark}/u.test(ch) ? 0 : (cp>=0x1100 && (cp<=0x115f || cp===0x2329 || cp===0x232a ||
          (cp>=0x2e80 && cp<=0xa4cf) || (cp>=0xac00 && cp<=0xd7a3) || (cp>=0xf900 && cp<=0xfaff) ||
          (cp>=0xfe10 && cp<=0xfe6f) || (cp>=0xff00 && cp<=0xff60) || (cp>=0xffe0 && cp<=0xffe6) || cp>=0x1f300) ? 2 : 1);
        if (!width) { if (this.col) this.grid[this.row][this.col-1].text+=ch; continue; }
        if (this.wrapped || this.col+width>this.cols) { this.col=0; this.down(); }
        this.grid[this.row][this.col]={text:ch,ghost:this.ghost};
        if (width===2 && this.col+1<this.cols) this.grid[this.row][this.col+1]=this.blank();
        this.col+=width; this.wrapped=this.col>=this.cols; this.col=Math.min(this.col,this.cols-1);
      }
    }
  }
  private sequence(ch:string) {
    this.escape+=ch;
    if (this.escape.length>4096) { this.escape=''; this.reliable=false; return; }
    const prefix=this.escape[1];
    if (this.escape.length===2) {
      if ('[]P_X^()'.includes(ch)) return;
      if (ch==='7') this.saved=[this.row,this.col];
      else if (ch==='8') [this.row,this.col]=this.saved;
      else if (ch==='D') this.down();
      else if (ch==='E') { this.col=0; this.down(); }
      else if (ch==='c') { this.clear(); this.row=this.col=0; this.bracketedPaste=false; }
      else if (!'=>'.includes(ch)) this.reliable=false;
      this.escape=''; return;
    }
    if (']P_X^'.includes(prefix)) {
      if (ch==='\x07' || this.escape.endsWith('\x1b\\')) {
        if (/^\x1b\](10|11|12);\?/.test(this.escape)) this.query(/^\x1b\](?:10|11|12);(?:rgb:[0-9a-f/]+|#[0-9a-f]+)(?:\x07|\x1b\\)/i);
        this.escape='';
      }
      return;
    }
    if (prefix==='(' || prefix===')') { this.escape=''; return; }
    if (prefix!=='[' || !/[@-~]/.test(ch)) return;
    const parameters=this.escape.slice(2,-1), n=parameters.split(';').map(x => Number(x)||0), count=Math.min(Math.max(1,n[0]||1),Math.max(this.cols,this.rows));
    this.escape='';
    if (ch==='m') {
      for (let i=0;i<n.length;i++) {
        if (n[i]===0 || n[i]===22 || n[i]===39) this.ghost=false;
        if (n[i]===2 || n[i]===90) this.ghost=true;
        if (n[i]===38 && n[i+1]===5) { this.ghost=n[i+2]>=240 && n[i+2]<=250; i+=2; }
        else if (n[i]===38 || n[i]===48) i+=n[i+1]===2 ? 4 : 2;
      }
      return;
    }
    if (ch==='n') { if (parameters==='6') this.query(/^\x1b\[\d+;\d+R/); return; }
    if (ch==='c') { this.query(parameters.startsWith('>') ? /^\x1b\[>\d+(?:;\d+)*c/ : /^\x1b\[\?\d+(?:;\d+)*c/); return; }
    if (ch==='q') { if (parameters==='>' || parameters==='>0') this.query(/^\x1bP>\|[^\x1b\x07]{1,128}\x1b\\/); return; }
    if (ch==='t') return;
    if (ch==='p' && /^\?\d{1,4}\$$/.test(parameters)) {
      this.query(new RegExp(`^\x1b\\[\\?${parameters.slice(1,-1)};[0-4]\\$y`)); return;
    }
    if (ch==='h' || ch==='l') {
      const modes=parameters.replace(/^\?/, '').split(';');
      if (ch==='h' && modes.includes('2004')) this.bracketedPaste=true;
      if (modes.some(x => ['1049','1047','47'].includes(x))) { this.alternateScreen=ch==='h'; this.clear(); this.row=this.col=0; }
      if (modes.includes('25')) this.visible=ch==='h';
      return;
    }
    if (ch==='u' && /^[?<>=]/.test(parameters)) {
      if (parameters==='?') this.query(/^\x1b\[\?\d+u/);
      return;
    }
    if (!/^[0-9;]*$/.test(parameters)) { this.reliable=false; return; }
    this.wrapped=false;
    if (ch==='H' || ch==='f') { this.row=Math.min(this.rows-1,Math.max(0,(n[0]||1)-1)); this.col=Math.min(this.cols-1,Math.max(0,(n[1]||1)-1)); }
    else if (ch==='A') this.row=Math.max(0,this.row-count);
    else if (ch==='B' || ch==='e') this.row=Math.min(this.rows-1,this.row+count);
    else if (ch==='C' || ch==='a') this.col=Math.min(this.cols-1,this.col+count);
    else if (ch==='D') this.col=Math.max(0,this.col-count);
    else if (ch==='E') { this.row=Math.min(this.rows-1,this.row+count); this.col=0; }
    else if (ch==='F') { this.row=Math.max(0,this.row-count); this.col=0; }
    else if (ch==='G' || ch==='`') this.col=Math.min(this.cols-1,Math.max(0,count-1));
    else if (ch==='d') this.row=Math.min(this.rows-1,Math.max(0,count-1));
    else if (ch==='s') this.saved=[this.row,this.col];
    else if (ch==='u') [this.row,this.col]=this.saved;
    else if (ch==='J') {
      if (n[0]===2) this.clear();
      else if (n[0]!==3) for (let r=0;r<this.rows;r++) for (let c=0;c<this.cols;c++)
        if (n[0]===1 ? r<this.row || (r===this.row && c<=this.col) : r>this.row || (r===this.row && c>=this.col)) this.grid[r][c]=this.blank();
    } else if (ch==='K') {
      for (let c=0;c<this.cols;c++) if (n[0]===2 || (n[0]===1 ? c<=this.col : c>=this.col)) this.grid[this.row][c]=this.blank();
    } else if (ch==='X') for (let c=this.col;c<Math.min(this.cols,this.col+count);c++) this.grid[this.row][c]=this.blank();
    else if (ch==='P') { this.grid[this.row].splice(this.col,count); while (this.grid[this.row].length<this.cols) this.grid[this.row].push(this.blank()); }
    else if (ch==='@') { this.grid[this.row].splice(this.col,0,...Array.from({length:Math.min(count,this.cols)},() => this.blank())); this.grid[this.row].length=this.cols; }
    else if (ch==='L' || ch==='M' || ch==='S' || ch==='T') {
      const top=ch==='L' || ch==='M' ? this.row : this.scrollTop;
      for (let i=0;i<Math.min(count,this.scrollBottom-top+1);i++) {
        this.grid.splice(ch==='L' || ch==='T' ? this.scrollBottom : top,1);
        this.grid.splice(ch==='L' || ch==='T' ? top : this.scrollBottom,0,Array.from({length:this.cols},() => this.blank()));
      }
    }
    else if (ch==='r') { this.scrollTop=Math.min(this.rows-1,Math.max(0,(n[0]||1)-1)); this.scrollBottom=Math.min(this.rows-1,Math.max(this.scrollTop,(n[1]||this.rows)-1)); this.row=this.col=0; }
    else this.reliable=false;
  }
  private query(pattern:RegExp) {
    this.queries=this.queries.filter(q => q.until>=this.changedAt).slice(-15);
    this.queries.push({pattern,until:this.changedAt+2000});
  }
  /** Only complete, solicited terminal replies are exempt from human cancellation; all other bytes win. */
  response(data:string,now=Date.now()):boolean {
    this.queries=this.queries.filter(q => q.until>=now);
    const pending=[...this.queries];
    let rest=data;
    while (rest) {
      const index=pending.findIndex(q => q.pattern.test(rest));
      if (index<0) return false;
      const match=rest.match(pending[index].pattern)!;
      rest=rest.slice(match[0].length); pending.splice(index,1);
    }
    this.queries=pending;
    return !!data;
  }
  private blocked(harness:Harness) {
    const lines=this.grid.map((_,r) => this.line(r));
    const text=lines.join('\n');
    const busy=harness==='codex' ? lines.some(l => /\bworking\b.*esc to interrupt/i.test(l)) : lines.some(l => /(?:thinking|generating|running|working).*esc (?:to |to cancel|to interrupt)|esc to (?:cancel|interrupt)/i.test(l));
    return busy || /(?:select login method|not signed in|sign in to|waiting for auth|trust this (?:folder|directory)|do you trust|approve this|allow this|starting mcp|booting mcp|resuming session)/i.test(text);
  }
  composer(harness:Harness):string|null {
    // ponytail: recognize only these cursor/prompt shapes; extend with authenticated fixtures when a harness UI changes.
    if (!this.reliable || this.escape || !this.visible || this.blocked(harness)) return null;
    const line=this.line(), match=line.match(harness==='codex' ? /^(\s*(?:›|codex>) ?)(.*)$/ : /^(\s*(?:│\s*)?> ?)(.*?)(?:\s*│)?$/);
    if (!match) return null;
    const prefix=match[1], body=match[2].trimEnd(), inputColumn=prefix.trimEnd().length+1;
    const placeholder=this.placeholder(harness,body) && this.grid[this.row].slice(prefix.length,prefix.length+body.length).every(c => !c.text.trim() || c.ghost);
    if (this.col<inputColumn || (this.col===inputColumn && body && !placeholder)) return null;
    // ponytail: only single-row composers are proven; add live wrapped/multiline fixtures before widening recovery.
    if (this.wrapped) return null;
    if (!body && this.col!==inputColumn) return null;
    return placeholder && this.col===inputColumn ? '' : body;
  }
  private placeholder(harness:Harness,text:string) {
    return harness==='codex' ? ['Ask Codex to do anything','Implement {feature}','Explain this codebase','Find and fix a bug in @filename','Use /skills to list available skills'].includes(text)
      : text==='Type your message or @path/to/file';
  }
  idle(harness:Harness,now=Date.now()) { return now-this.changedAt>=250 && this.composer(harness)===''; }
  active(harness:Harness,body='') {
    const compact=(s:string) => s.replace(/\s/g,'');
    return this.text().split('\n').some(line => !compact(body).includes(compact(line)) && (harness==='codex'
      ? /^\s*(?:[•●⠋⠙⠹]\s*)?Working \(.*esc to interrupt/i.test(line)
      : /^\s*(?:[•●\u2800-\u28ff]\s*)?(?:Thinking|Generating|Running|Working).*esc to (?:cancel|interrupt)/i.test(line)));
  }
  text() { return this.grid.map((_,r) => this.line(r)).join('\n'); }
}
