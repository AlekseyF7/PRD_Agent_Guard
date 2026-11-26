// Research-only MCP probe. Never executes commands or changes target files.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const pending = new Map();
const logPath = path.join(process.cwd(),'elicitation-events.jsonl');
const log = event => fs.appendFileSync(logPath,JSON.stringify({time:new Date().toISOString(),...event})+'\n');
const send = obj => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...obj})+'\n');
const result = (id,value,isError=false) => send({id,result:{content:[{type:'text',text:JSON.stringify(value)}],isError}});
const finish = (requestID,outcome) => {
 const p=pending.get(requestID); if(!p)return;
 pending.delete(requestID);clearTimeout(p.timer);
 log({event:'finished',action:p.action,outcome,executed:false});
 result(p.callID,{action:p.action,outcome,executed:false});
};
function receive(m){
 if(Object.hasOwn(m,'id') && !m.method){
  const p=pending.get(m.id);if(!p){log({event:'ignored_response',id:m.id});return;}
  log({event:'client_response',id:m.id,result:m.result,error:m.error});
  const r=m.result;
  const outcome=m.error?'confirmation_error':r?.action==='accept'&&r.content?.decision==='allow_once'?'allowed_simulation':r?.action==='accept'&&r.content?.decision==='deny'?'denied':r?.action==='decline'?'declined':r?.action==='cancel'?'cancelled':'invalid_confirmation';
  finish(m.id,outcome);return;
 }
 if(m.method==='notifications/cancelled'){
  for(const [id,p] of pending)if(p.callID===m.params?.requestId)finish(id,'cancelled');return;
 }
 if(!Object.hasOwn(m,'id'))return;
 if(m.method==='initialize'){
  log({event:'initialize',clientCapabilities:m.params?.capabilities});
  send({id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'pre003-confirmation-probe',version:'0.1.0'}}});return;
 }
 if(m.method==='tools/list'){
  send({id:m.id,result:{tools:[{name:'guard_probe_confirm',description:'Research-only: request a user form for a fixed action. Never executes anything.',inputSchema:{type:'object',properties:{command:{type:'string'},cwd:{type:'string'}},required:['command','cwd'],additionalProperties:false}},{name:'test_echo',description:'Return the test message.',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}}]}});return;
 }
 if(m.method==='tools/call'){
  const a=m.params?.arguments||{}; log({event:'call_context',meta:m.params?._meta});
  if(m.params?.name==='test_echo'){result(m.id,{echo:a.message});return;}
  if(m.params?.name!=='guard_probe_confirm'){send({id:m.id,error:{code:-32601,message:'Unknown tool'}});return;}
  if(typeof a.command!=='string'||typeof a.cwd!=='string'||Object.keys(a).some(k=>!['command','cwd'].includes(k))){result(m.id,{outcome:'invalid_arguments',executed:false},true);return;}
  const action=Object.freeze({actionId:randomUUID(),command:a.command,cwd:a.cwd});
  const requestID='confirm-'+action.actionId;
  const timer=setTimeout(()=>finish(requestID,'no_answer'),10000);
  pending.set(requestID,{callID:m.id,action,timer});
  log({event:'waiting',requestID,action,executed:false});
  send({id:requestID,method:'elicitation/create',params:{_meta:m.params?._meta,mode:'form',message:'TEST ONLY — nothing will execute.\nAction: '+action.actionId+'\nCommand: '+action.command+'\nDirectory: '+action.cwd+'\nExplanation: deleting the synthetic sample file would remove its contents.',requestedSchema:{type:'object',properties:{decision:{type:'string',title:'Decision',enum:['allow_once','deny']}},required:['decision']}}});return;
 }
 send({id:m.id,error:{code:-32601,message:'Method not found'}});
}
let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){let s=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!s.trim())continue;try{receive(JSON.parse(s));}catch(e){process.stderr.write(e.message+'\n');}}});
process.stdin.on('end',()=>{for(const [id]of pending)finish(id,'connection_closed');});
