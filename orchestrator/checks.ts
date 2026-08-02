import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import type { CommandCheck } from "../planner/plan.ts";
export const CHECK_OUTPUT_TAIL_BYTES=2048;
export const CHECK_KILL_GRACE_MS=250;
export interface CheckResult{id:string;command:string;passed:boolean;exitCode:number|null;timedOut:boolean;durationMs:number;outputTail:string}
export function tailUtf8(s:string,cap=CHECK_OUTPUT_TAIL_BYTES){const b=Buffer.from(s);if(b.length<=cap)return s;let start=b.length-cap+3;while(start<b.length&&(b[start]&0xc0)===0x80)start++;return "…"+b.subarray(start).toString()}
export function resolveCheckCwd(root:string,cwd?:string){if(cwd&&path.isAbsolute(cwd))throw Error("Check cwd must be repository-relative");const base=path.resolve(root),resolved=path.resolve(base,cwd||".");if(resolved!==base&&!resolved.startsWith(base+path.sep))throw Error(`Check cwd escapes repository: ${cwd}`);return resolved}
export async function runCommandCheck(check:CommandCheck,root:string,signal?:AbortSignal):Promise<CheckResult>{
 const started=Date.now();let output="",timedOut=false,exitCode:number|null=null,aborted=!!signal?.aborted;
 if(!aborted)try{const cwd=resolveCheckCwd(root,check.cwd);await new Promise<void>(resolve=>{const child=nodeSpawn(check.command,check.args,{cwd,stdio:["ignore","pipe","pipe"]});let done=false,hard:any;
  const append=(x:any)=>{output=tailUtf8(output+x.toString(),CHECK_OUTPUT_TAIL_BYTES)};child.stdout.on("data",append);child.stderr.on("data",append);
  const settle=(code?:number|null)=>{if(done)return;done=true;if(code!==undefined)exitCode=code;clearTimeout(timer);clearTimeout(hard);signal?.removeEventListener("abort",abort);resolve()};
  const stop=()=>{child.kill("SIGTERM");hard=setTimeout(()=>{child.kill("SIGKILL");settle()},CHECK_KILL_GRACE_MS)};
  const abort=()=>{aborted=true;append("\naborted");stop()};signal?.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;append("\ntimed out");stop()},check.timeoutMs??300000);child.on("error",e=>{append(`\nspawn error: ${e.message}`);settle()});child.on("close",settle);
 })}catch(e:any){output=tailUtf8(`spawn error: ${e?.message??e}`)}
 return{id:check.id,command:check.command,passed:exitCode===0&&!timedOut&&!aborted,exitCode,timedOut,durationMs:Date.now()-started,outputTail:tailUtf8(output)} }
export async function runChecks(checks:readonly CommandCheck[],root:string,signal?:AbortSignal){const out:CheckResult[]=[];for(const c of checks){if(signal?.aborted)break;const r=await runCommandCheck(c,root,signal);out.push(r);if(!r.passed)break}return out}
