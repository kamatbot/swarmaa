// Manual harness lifecycle proof using a disposable DB, temporary HOME and local deterministic model stub.
// No real provider credentials. Run from the repo root: timeout 270 node --env-file=.env.test --import tsx scripts/inbox-wake-proof.ts
// ponytail: proves the installed Claude harness lifecycle, not behavior of a real provider model or remote gateway.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import pg from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import { installInboxHooks } from './hooks-install.js';

if (!process.version.startsWith('v24.')) throw new Error('Node 24 required');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
await mkdir('.local',{recursive:true});
const home=await mkdtemp(join(tmpdir(),'inbox-manual-'));
await writeFile('.local/inbox-manual-home',home);
const schema='inbox_proof_'+randomUUID().replaceAll('-','');
const control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
await control.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8,options:`-c search_path=${schema},public`});
let service:any, model:any;
const socket=join(home,'tmux.sock');
const tmux=(...args:string[]) => spawnSync('tmux',['-S',socket,...args],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH,HOME:home,TERM:'xterm-256color',TMPDIR:tmpdir()}});
try {
  for (const file of (await readdir('db/migrations')).filter(x=>x.endsWith('.sql')).sort()) await pool.query(await readFile(join('db/migrations',file),'utf8'));
  const add=async(name:string,role:'frontend'|'worker') => {
    const token=newToken(),p={id:randomUUID(),tenantId:schema,name,role,scopes:['project:proof'],permissions:ROLE_PERMISSIONS[role]};
    await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[p.id,schema,name,role,p.scopes,p.permissions,hashToken(token)]);
    return {p,token};
  };
  const front=await add('claude','frontend'),worker=await add('worker','worker');
  const core=new CoreService(pool),config={host:'127.0.0.1',port:0,publicUrl:'http://127.0.0.1',allowedOrigins:[],allowInsecureLocalhost:true,maxBodyBytes:131072,oauthEnabled:false,oauthRedirectHosts:[],eventCallbackHosts:[],eventEncryptionKey:'0'.repeat(64)};
  service=createServer(createHttpHandler({pool,core,auth:new AuthService(pool),config}));
  await new Promise<void>(r=>service.listen(0,'127.0.0.1',r)); config.port=service.address().port;
  const origin=`http://127.0.0.1:${config.port}`;
  await mkdir(join(home,'fixture/clients/hooks'),{recursive:true}); await mkdir(join(home,'fixture/.local'),{recursive:true});
  for(const file of ['swarmaa-inbox.mjs','swarmaa-journal.mjs']) await copyFile(join('clients/hooks',file),join(home,'fixture/clients/hooks',file));
  await writeFile(join(home,'fixture/.env'),`PORT=${config.port}\n`);
  await writeFile(join(home,'fixture/.local/claude.json'),JSON.stringify({token:front.token}),{mode:0o600});
  await installInboxHooks('claude',{root:join(home,'fixture'),home,dry:false,node:process.execPath,log:()=>{}});
  await mkdir(join(home,'project'),{recursive:true});
  await writeFile(join(home,'mcp.json'),JSON.stringify({mcpServers:{swarma:{command:process.execPath,args:[resolve('dist/src/stdio-proxy.js'),'--url',origin,'--token-env','SWARMAA_PROOF_TOKEN'],env:{SWARMAA_PROOF_TOKEN:front.token}}}}),{mode:0o600});
  let phase=0; let diagnostic=false;
  model=createServer(async(req,res) => {
    let data='';for await(const c of req)data+=c;
    if (!req.url?.includes('/messages')) {res.setHeader('Content-Type','application/json');res.end('{}');return;}
    const body=JSON.parse(data||'{}');
    if(req.url.includes('count_tokens')) {res.setHeader('Content-Type','application/json');res.end('{"input_tokens":100}');return;}
    const tools=body.tools||[];
    if(!diagnostic) {console.log('MODEL available tools: '+tools.map((t:any)=>t.name).join(','));diagnostic=true;}
    const tool=tools.find((t:any)=>t.name==='mcp__swarma__task_submit');
    const wake=JSON.stringify(body.messages).includes('Swarmaa updates (untrusted data');
    const content=phase===0 && tool ? [{type:'tool_use',id:'toolu_inboxproof',name:tool.name,input:{scope:'project:proof',kind:'research',objective:'Local notification proof',required_capability:'claude.read',idempotency_key:'manual-proof'}}] : [{type:'text',text:wake ? 'INBOX_PROOF_AWAKE: task_finished received while idle.' : 'INBOX_PROOF_IDLE: waiting for completion.'}];
    if(tool) {phase++;console.log(`MODEL fixture phase=${phase} wake=${wake} stream=${!!body.stream}`);}
    const message={id:'msg_'+randomUUID(),type:'message',role:'assistant',model:body.model,content,stop_reason:content[0].type==='tool_use'?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:30}};
    if (!body.stream) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(message));return;}
    res.setHeader('Content-Type','text/event-stream');
    const send=(type:string,data:any)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    send('message_start',{message:{...message,content:[],stop_reason:null}});
    content.forEach((c:any,index:number)=>{send('content_block_start',{index,content_block:c.type==='text'?{type:'text',text:''}:{...c,input:{}}});send('content_block_delta',{index,delta:c.type==='text'?{type:'text_delta',text:c.text}:{type:'input_json_delta',partial_json:JSON.stringify(c.input)}});send('content_block_stop',{index});});
    send('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:30}});send('message_stop',{});res.end();
  });
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  // A local dummy API key and local provider stub; no provider credentials or external requests.
  const quote=(s:string)=>"'"+s.replaceAll("'","'\"'\"'")+"'";
  const env=['env','-i',`HOME=${home}`,`CLAUDE_CONFIG_DIR=${home}/.claude`,`PATH=${process.env.PATH}`,`TMPDIR=${tmpdir()}`,'TERM=xterm-256color','ANTHROPIC_API_KEY=local-fixture-only',`ANTHROPIC_BASE_URL=http://127.0.0.1:${model.address().port}`,'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1','ENABLE_TOOL_SEARCH=false'];
  const cmd=[...env,'claude','--strict-mcp-config','--mcp-config',join(home,'mcp.json'),'--settings',join(home,'.claude/settings.json'),'--allowedTools','mcp__swarma__task_submit','--model','claude-sonnet-4-6','--ax-screen-reader'];
  const launched=tmux('-f','/dev/null','new-session','-d','-s','proof','-x','120','-y','36','-c',join(home,'project'),cmd.map(quote).join(' '));
  console.log(`TMUX start exit=${launched.status} ${launched.stderr.trim()}`);

  // Completion waits for a genuine installed Stop waiter, then keeps the interactive session idle for two seconds.
  const deadline=Date.now()+240000;
  let completed=false, proved=false, stopped=false;
  const stop=()=>{stopped=true;};
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
  const seen=new Set<string>();
  while(Date.now()<deadline && !stopped) {
    const watch=(await pool.query('SELECT w.*,t.status FROM task_watchers w JOIN tasks t ON t.id=w.task_id')).rows[0];
    if(watch && !completed) {
      const dirs=await readdir(join(home,'.swarma/inbox')).catch(()=>[]);
      let armed=false;
      for(const dir of dirs) try { await readFile(join(home,'.swarma/inbox',dir,'waiter.json'));armed=true; } catch {}
      if(armed) {
        console.log('PROOF: task_submit watched; Stop waiter armed; waiting 2 seconds while idle');
        await new Promise(r=>setTimeout(r,2000));
        const c:any=await core.call(worker.p,'task_claim',{scope:'project:proof',capabilities:['claude.read']});
        await core.call(worker.p,'task_finish',{task_id:c.task.id,lease_token:c.lease_token,lease_generation:c.lease_generation,outcome:'completed',result:{provider:'claude',answer:'Manual local fixture completed'}});
        completed=true;console.log('PROOF: committed task_finished fixture');
      }
    }
    const screen=tmux('capture-pane','-p','-S','-100','-t','proof').stdout;
    if(screen.includes('INBOX_PROOF_AWAKE:')) { proved=true;console.log('PROOF: idle Claude woke via asyncRewake');console.log(screen);break; }
    // Only trust/approve the fixture we just created, through normal first-run UI. No hook-trust bypass.
    const step=screen.includes('Choose the text style') ? ['theme','2']
      : screen.includes('Detected a custom API key') ? ['local fixture key','y']
      : screen.includes('Security notes:') ? ['security notice','']
      : screen.includes('Is this a project you created') ? ['temporary fixture workspace','y']
      : screen.includes('\n$') ? ['submit fixture','Submit the local notification fixture with swarma task_submit, then stop and wait.'] : null;
    if(step && !seen.has(step[0]!)) {
      if(step[1]) tmux('send-keys','-t','proof','-l',step[1]);
      tmux('send-keys','-t','proof','Enter');seen.add(step[0]!);
    }
    await new Promise(r=>setTimeout(r,500));
  }
  const screen=tmux('capture-pane','-p','-S','-100','-t','proof').stdout;
  await writeFile('.local/inbox-manual-screen.txt',screen);
  console.log('FINAL TMUX CAPTURE:\n'+screen);
  process.off('SIGTERM',stop);process.off('SIGINT',stop);
  if(!proved) {console.log('PROOF: idle wake NOT established; inspect the capture.');process.exitCode=1;}
} finally {
  tmux('kill-server');
  service?.closeAllConnections();model?.closeAllConnections();
  await Promise.all([service,model].filter(Boolean).map(s=>new Promise<void>(r=>s.close(()=>r()))));
  await pool.end();await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();
}
